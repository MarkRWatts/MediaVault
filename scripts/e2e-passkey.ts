// End-to-end check of the passkey flows (PASSKEYS_PLAN.md Phase 6) against a
// real browser — the one thing the vitest suite can't cover, since a WebAuthn
// ceremony needs an authenticator. Self-contained: a throwaway SQLite
// database, a `next dev` it starts and stops itself, and Chromium driven by
// Playwright with a CDP *virtual* authenticator (ctap2, resident key, user
// verification, auto-presence) standing in for Face ID / Touch ID.
//
// Usage (from the repo root, once per machine: `npx playwright install chromium`):
//
//   npx tsx scripts/e2e-passkey.ts
//
// Env: E2E_PORT (default 3007) for the throwaway server; E2E_CHROMIUM to
// point at a specific Chromium binary instead of Playwright's own.
//
// Sign-in is seeded straight into the database rather than driven through
// the email code — BetterAuth's session cookie is just the session token
// HMAC-signed with BETTER_AUTH_SECRET (see sessionCookie below), and this
// run picks its own secret. That keeps Resend out of it entirely.
//
// What it proves, in order: register → rename → sign out → sign in with the
// passkey → a member whose household membership is revoked keeps the
// credential but gets no session → remove → the credential no longer signs
// in → anonymous registration is refused → a session older than the
// plugin's fresh-session window can browse but not add a passkey → the
// post-email-code nudge appears, dismisses, persists, and links.
//
// One environment quirk worth knowing when reading the output: Chrome
// auto-resolves conditional-mediation (autofill) requests against a virtual
// authenticator, so passkey sign-ins here usually complete via autofill
// before the button is ever clicked. A real browser waits for a tap.

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

const PORT = Number(process.env.E2E_PORT ?? "3007");
const BASE = `http://localhost:${PORT}`;
const SECRET = randomBytes(32).toString("hex");
const USER_ID = "e2e-user";
const EMAIL = "e2e@example.com";
const HOUSEHOLD_ID = "e2e-household";
const MEMBER_ID = "e2e-member";

let failures = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures++;
}

/** Mirrors better-call's signCookieValue: `${value}.${base64(hmac-sha256)}`,
 *  URL-encoded. Standard base64 with padding, as btoa() produces. */
function sessionCookie(token: string): string {
  const sig = createHmac("sha256", SECRET).update(token).digest("base64");
  return encodeURIComponent(`${token}.${sig}`);
}

function startNextDev(dir: string, dbUrl: string): { child: ChildProcess; logPath: string } {
  const logPath = path.join(dir, "next-dev.log");
  const log = openSync(logPath, "a");
  const child = spawn("npx", ["next", "dev", "-p", String(PORT), "-H", "localhost"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Explicit process env wins over .env files in Next, so a developer's
      // real DATABASE_URL / ALLOWED_EMAILS never leak into this run.
      DATABASE_URL: dbUrl,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: BASE,
      ALLOWED_EMAILS: "",
      RESEND_API_KEY: "",
      MOVIES_PATH: path.join(dir, "movies"),
      TVSHOWS_PATH: "",
      MUSIC_PATH: "",
      ADULT_PATH: "",
      POSTER_CACHE_DIR: path.join(dir, "posters"),
      VIDEO_CACHE_DIR: path.join(dir, "video-cache"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    // Own process group: `next dev` forks a next-server child that would
    // otherwise outlive a plain kill of the parent.
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  return { child, logPath };
}

function stopNextDev(child: ChildProcess): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/signin`, { redirect: "manual" });
      if (res.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`next dev on ${BASE} didn't become ready within 120s`);
}

async function seed(prisma: PrismaClient): Promise<{ freshToken: string; staleToken: string }> {
  const now = new Date();
  await prisma.user.create({
    data: { id: USER_ID, name: "E2E Person", email: EMAIL, emailVerified: true },
  });
  await prisma.household.create({
    data: { id: HOUSEHOLD_ID, name: "E2E household", slug: HOUSEHOLD_ID, createdAt: now },
  });
  await prisma.member.create({
    data: { id: MEMBER_ID, householdId: HOUSEHOLD_ID, userId: USER_ID, role: "owner", createdAt: now },
  });
  async function session(ageDays: number): Promise<string> {
    const token = randomBytes(24).toString("base64url");
    const createdAt = new Date(now.getTime() - ageDays * 24 * 3600 * 1000);
    await prisma.session.create({
      data: {
        id: `sess-${token.slice(0, 8)}`,
        token,
        userId: USER_ID,
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(createdAt.getTime() + 7 * 24 * 3600 * 1000),
      },
    });
    return token;
  }
  // The stale one is older than the plugin's fresh-session window (24h), so
  // it can browse but not register a passkey.
  return { freshToken: await session(0), staleToken: await session(2) };
}

async function contextWithSession(browser: Browser, token: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: BASE });
  await context.addCookies([
    { name: "better-auth.session_token", value: sessionCookie(token), domain: "localhost", path: "/" },
  ]);
  return context;
}

async function addVirtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL(/\/signin/);
}

/** Loads /signin and returns once either the autofill ceremony has signed
 *  in on its own (see the header note) or the button has been clicked. */
async function passkeySignInAttempt(page: Page): Promise<"autofill" | "button"> {
  await page.goto("/signin");
  const button = page.getByRole("button", { name: "Sign in with a passkey" });
  await button.waitFor({ state: "visible", timeout: 15_000 });
  try {
    await page.waitForURL((url) => url.pathname !== "/signin", { timeout: 2_500 });
    return "autofill";
  } catch {
    if (new URL(page.url()).pathname === "/signin") await button.click();
    return "button";
  }
}

async function runChecks(browser: Browser, prisma: PrismaClient, tokens: { freshToken: string; staleToken: string }) {
  const passkeyCount = () => prisma.passkey.count({ where: { userId: USER_ID } });
  const audits = (action: string) => prisma.auditLog.count({ where: { action, userId: USER_ID } });

  const context = await contextWithSession(browser, tokens.freshToken);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const { cdp, authenticatorId } = await addVirtualAuthenticator(context, page);

  // 1. Signed in via the seeded session; Passkeys section present
  await page.goto("/account");
  check("seeded session signs in", (await page.getByText(EMAIL).count()) > 0, page.url());
  check("Passkeys section present", (await page.getByRole("heading", { name: "Passkeys" }).count()) === 1);
  const addButton = page.getByRole("button", { name: "Add a passkey for this device" });
  await addButton.waitFor({ state: "visible", timeout: 15_000 });
  check("add button visible (secure context + WebAuthn detected)", true);

  // 2. Register
  const addsBefore = await audits("passkey.add");
  await addButton.click();
  const suggested = await page.getByLabel("Passkey name").inputValue();
  check("name suggested from user-agent", suggested.length > 0, suggested);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page.getByText(/^Added /).waitFor({ timeout: 20_000 });
  const creds = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  check(
    "virtual authenticator holds one resident credential",
    creds.credentials.length === 1 && creds.credentials[0].isResidentCredential === true,
  );
  check("passkey row persisted", (await passkeyCount()) === 1);
  check("audit row passkey.add", (await audits("passkey.add")) === addsBefore + 1);
  const row = await prisma.passkey.findFirstOrThrow({ where: { userId: USER_ID } });
  check("stored name matches suggestion", row.name === suggested, `${row.name} / backedUp=${row.backedUp} / ${row.deviceType}`);

  // 3. Rename
  const renamesBefore = await audits("passkey.rename");
  await page.getByRole("button", { name: "Rename this passkey" }).click();
  await page.getByLabel("Passkey name").fill("E2E device");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("E2E device", { exact: true }).waitFor({ timeout: 15_000 });
  check("rename persisted", (await prisma.passkey.findFirstOrThrow({ where: { id: row.id } })).name === "E2E device");
  check("audit row passkey.rename", (await audits("passkey.rename")) === renamesBefore + 1);

  // 4. Sign out, sign back in with the passkey
  await signOut(page);
  check("sign-out removed the seeded session", (await prisma.session.count({ where: { token: tokens.freshToken } })) === 0);
  const how = await passkeySignInAttempt(page);
  await page.waitForURL((url) => url.pathname === "/", { timeout: 20_000 });
  await page.goto("/account");
  check("passkey sign-in lands signed in", (await page.getByText(EMAIL).count()) > 0, `via ${how}`);
  check("passkey sign-in created a session row", (await prisma.session.count({ where: { userId: USER_ID } })) >= 1);
  check("counter advanced", (await prisma.passkey.findFirstOrThrow({ where: { id: row.id } })).counter >= 1);

  // 5. Revoked member: credential remains, membership gone -> no session
  await signOut(page);
  await prisma.member.deleteMany({ where: { userId: USER_ID } });
  const sessionsBeforeRevoked = await prisma.session.count();
  await passkeySignInAttempt(page);
  await page.getByText("Couldn't sign you in with that passkey").waitFor({ timeout: 20_000 });
  check("revoked member is refused with the generic message", true);
  check("revoked member got no session row", (await prisma.session.count()) === sessionsBeforeRevoked);
  check("still on /signin", new URL(page.url()).pathname === "/signin");
  await prisma.member.create({
    data: { id: MEMBER_ID, householdId: HOUSEHOLD_ID, userId: USER_ID, role: "owner", createdAt: new Date() },
  });

  // 6. Remove, then the credential no longer signs in
  await passkeySignInAttempt(page);
  await page.waitForURL((url) => url.pathname === "/", { timeout: 20_000 });
  await page.goto("/account");
  const removesBefore = await audits("passkey.remove");
  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByText("Remove E2E device?").waitFor();
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  await page.getByText("E2E device", { exact: true }).waitFor({ state: "detached", timeout: 15_000 });
  check("passkey row removed", (await passkeyCount()) === 0);
  check("audit row passkey.remove", (await audits("passkey.remove")) === removesBefore + 1);
  await signOut(page);
  await passkeySignInAttempt(page);
  await page.getByText("That passkey isn't set up for MediaVault").waitFor({ timeout: 20_000 });
  check("removed passkey gets the not-set-up message", true);

  // 7. Anonymous registration is refused
  const res = await context.request.get("/api/auth/passkey/generate-register-options", { headers: { cookie: "" } });
  check("anonymous generate-register-options is 401", res.status() === 401, String(res.status()));
  await context.close();

  // 8. Stale session: browses, but can't add a passkey
  const stale = await contextWithSession(browser, tokens.staleToken);
  const stalePage = await stale.newPage();
  await addVirtualAuthenticator(stale, stalePage);
  await stalePage.goto("/account");
  check("stale session still signs in (freshness only gates registration)", (await stalePage.getByText(EMAIL).count()) > 0);
  await stalePage.getByRole("button", { name: "Add a passkey for this device" }).click();
  await stalePage.getByRole("button", { name: "Create passkey" }).click();
  await stalePage.getByText("Passkeys can only be added within a day of signing in").waitFor({ timeout: 20_000 });
  check("stale session gets the sign-out-and-back-in explanation", true);
  check("stale session registered nothing", (await passkeyCount()) === 0);
  check("sign-out shortcut offered inline", (await stalePage.getByRole("button", { name: "Sign out" }).count()) >= 2);

  // 9. Post-email-code nudge
  await stalePage.goto("/");
  check("no nudge without the cookie", (await stalePage.getByRole("status").count()) === 0);
  await stale.addCookies([{ name: "mv-passkey-nudge", value: "1", domain: "localhost", path: "/" }]);
  await stalePage.goto("/");
  const nudge = stalePage.getByRole("status");
  await nudge.waitFor({ timeout: 15_000 });
  check("nudge shown with the cookie on a passkey-capable device", (await nudge.getByText("Sign in faster next time").count()) === 1);
  await stalePage.getByRole("button", { name: "Not now" }).click();
  check("Not now hides it", (await stalePage.getByRole("status").count()) === 0);
  await stalePage.reload();
  await stalePage.getByRole("heading", { name: "Movies" }).waitFor();
  check("dismissal survives reload (localStorage)", (await stalePage.getByRole("status").count()) === 0);
  await stalePage.evaluate(() => localStorage.removeItem("mv-passkey-nudge-dismissed"));
  await stalePage.reload();
  await stalePage.getByRole("status").waitFor({ timeout: 15_000 });
  await stalePage.getByRole("link", { name: "Add a passkey" }).click();
  await stalePage.waitForURL(/\/account#passkeys$/);
  check("Add a passkey links to /account#passkeys", true);
  check(
    "following the link also dismisses",
    (await stalePage.evaluate(() => localStorage.getItem("mv-passkey-nudge-dismissed"))) === "1",
  );
  await stale.close();
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "mediavault-e2e-passkey-"));
  for (const sub of ["movies", "posters", "video-cache"]) mkdirSync(path.join(dir, sub));
  const dbUrl = `file:${path.join(dir, "e2e.db")}`;

  // Same forward-only command the app runs at boot (and test-temp-db.ts uses).
  execSync("npx prisma migrate deploy", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
  const tokens = await seed(prisma);

  const { child, logPath } = startNextDev(dir, dbUrl);
  let browser: Browser | null = null;
  try {
    await waitForServer();
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.E2E_CHROMIUM || undefined,
      // Never route localhost through a corporate/agent proxy.
      args: ["--no-proxy-server"],
    });
    await runChecks(browser, prisma, tokens);
  } catch (err) {
    failures++;
    console.error("\nRun aborted:", err instanceof Error ? err.message : err);
    console.error(`\n--- tail of ${logPath} ---`);
    console.error(readFileSync(logPath, "utf8").split("\n").slice(-40).join("\n"));
  } finally {
    await browser?.close();
    stopNextDev(child);
    await prisma.$disconnect();
  }

  if (failures === 0) {
    rmSync(dir, { recursive: true, force: true });
    console.log("\nALL PASSED");
    process.exit(0);
  }
  console.log(`\n${failures} FAILED — scratch dir kept for inspection: ${dir}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

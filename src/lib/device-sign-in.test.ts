// The Apple TV's QR-code sign-in (TVOS_PLAN.md), driven end to end through
// BetterAuth's real HTTP handler against a REAL, isolated SQLite database
// (src/lib/test-temp-db.ts, as passkey.test.ts does). Pins what the design
// rests on:
//
//   1. The session the TV collects is the SIGNED `<token>.<hmac>` form in
//      `set-auth-token`, which the proxy's own check accepts — the plugin
//      alone only returns a bare token, which it would reject. (auth.ts's
//      after-hook is what makes this work.)
//   2. The web of trust still gates it: approving for someone nobody
//      vouches for any more yields no session at all.
//   3. Only our client may start the flow, a code can't be pre-bound to
//      a user, and a code claimed by one member can't be approved by
//      another.
//   4. Approvals and denials land in the audit log.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializeSignedCookie } from "better-call";
import { createTempTestDb } from "@/lib/test-temp-db";
import { verifySessionCookie } from "@/lib/session-cookie";
import type { PrismaClient } from "@/generated/prisma/client";

let testPrisma: PrismaClient;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

const SECRET = "test-secret-not-for-production-0123456789";
const BASE = "http://localhost:3002";
const TV_AGENT = "MediaVault tvOS/1.0";
const CLIENT_ID = "mediavault-tvos";

// Imported after the temp DB exists — see passkey.test.ts.
let auth: typeof import("@/lib/auth").auth;

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
  process.env.BETTER_AUTH_SECRET = SECRET;
  process.env.BETTER_AUTH_URL = BASE;
  ({ auth } = await import("@/lib/auth"));
});

afterAll(async () => {
  await cleanupDb?.();
});

afterEach(async () => {
  await testPrisma.deviceCode.deleteMany({});
  await testPrisma.auditLog.deleteMany({});
  await testPrisma.session.deleteMany({});
  await testPrisma.member.deleteMany({});
  await testPrisma.household.deleteMany({});
  await testPrisma.user.deleteMany({});
});

async function seedMember(id: string) {
  await testPrisma.user.create({ data: { id, name: id, email: `${id}@example.com`, emailVerified: true } });
  const household = await testPrisma.household.create({
    data: { id: `${id}-household`, name: `${id}-household`, slug: `${id}-household`, createdAt: new Date() },
  });
  await testPrisma.member.create({
    data: { id: `${id}-member`, householdId: household.id, userId: id, role: "member", createdAt: new Date() },
  });
}

/** A signed bearer token for a member, as their phone would hold one. */
async function phoneBearer(userId: string): Promise<string> {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId);
  if (!session) throw new Error("seeded member should get a session");
  const setCookie = await serializeSignedCookie("x", session.token, SECRET, {});
  return decodeURIComponent(setCookie.slice(setCookie.indexOf("=") + 1).split(";")[0]);
}

function call(path: string, init: { method?: string; body?: unknown; bearer?: string; agent?: string } = {}) {
  const headers = new Headers({ "user-agent": init.agent ?? "test" });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

/** What the TV does first: ask for a code to put on screen. */
async function requestCode() {
  const res = await call("/device/code", { body: { client_id: CLIENT_ID }, agent: TV_AGENT });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };
}

function poll(deviceCode: string) {
  return call("/device/token", {
    body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: CLIENT_ID },
    agent: TV_AGENT,
  });
}

/** What the phone does: open the link (which claims the code), then approve or deny. */
async function decide(userCode: string, bearer: string, verdict: "approve" | "deny") {
  const opened = await call(`/device?user_code=${encodeURIComponent(userCode)}`, { bearer });
  expect(opened.status).toBe(200);
  return call(`/device/${verdict}`, { body: { userCode }, bearer });
}

/** Lets the next poll through the plugin's slow_down check without waiting. */
async function forgetLastPoll() {
  await testPrisma.deviceCode.updateMany({ data: { lastPolledAt: null } });
}

describe("device sign-in", () => {
  it("issues the TV a signed session once a member approves its code", async () => {
    await seedMember("mark");
    const code = await requestCode();
    expect(code.verification_uri_complete).toBe(`${BASE}/device?user_code=${code.user_code}`);
    expect(code.expires_in).toBe(600);

    const pending = await poll(code.device_code);
    expect(pending.status).toBe(400);
    expect(await pending.json()).toMatchObject({ error: "authorization_pending" });

    const approved = await decide(code.user_code, await phoneBearer("mark"), "approve");
    expect(approved.status).toBe(200);

    await forgetLastPoll();
    const granted = await poll(code.device_code);
    expect(granted.status).toBe(200);
    const token = granted.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    // The proxy's own check, not just BetterAuth's.
    expect(await verifySessionCookie(token, SECRET)).toBe(true);

    const me = await call("/get-session", { bearer: token! });
    expect(await me.json()).toMatchObject({ user: { id: "mark" } });

    const tvSession = await testPrisma.session.findFirst({ where: { userId: "mark", userAgent: TV_AGENT } });
    expect(tvSession).not.toBeNull();
    // The code is spent.
    expect(await testPrisma.deviceCode.count()).toBe(0);
    expect(await testPrisma.auditLog.findMany({ select: { userId: true, action: true } })).toEqual([
      { userId: "mark", action: "device.approve" },
    ]);
  });

  it("refuses the TV a session for someone nobody vouches for any more", async () => {
    await seedMember("removed");
    const code = await requestCode();
    await decide(code.user_code, await phoneBearer("removed"), "approve");
    // Removed from their household between approving and the TV's poll.
    await testPrisma.member.deleteMany({ where: { userId: "removed" } });

    await forgetLastPoll();
    const res = await poll(code.device_code);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("set-auth-token")).toBeNull();
    expect(await testPrisma.session.count({ where: { userAgent: TV_AGENT } })).toBe(0);
  });

  it("tells the TV when its code was denied, and records it", async () => {
    await seedMember("mark");
    const code = await requestCode();
    const denied = await decide(code.user_code, await phoneBearer("mark"), "deny");
    expect(denied.status).toBe(200);

    await forgetLastPoll();
    const res = await poll(code.device_code);
    expect(await res.json()).toMatchObject({ error: "access_denied" });
    expect(await testPrisma.auditLog.findMany({ select: { action: true } })).toEqual([{ action: "device.deny" }]);
  });

  it("won't let one member approve a code another member opened", async () => {
    await seedMember("mark");
    await seedMember("other");
    const code = await requestCode();
    await call(`/device?user_code=${code.user_code}`, { bearer: await phoneBearer("mark") });

    const res = await call("/device/approve", { body: { userCode: code.user_code }, bearer: await phoneBearer("other") });
    expect(res.status).toBe(403);
    expect(await testPrisma.auditLog.count()).toBe(0);
  });

  it("only starts the flow for our own client", async () => {
    const res = await call("/device/code", { body: { client_id: "someone-else" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
    expect(await testPrisma.deviceCode.count()).toBe(0);
  });

  it("won't mint a code pre-bound to a user", async () => {
    await seedMember("mark");
    const res = await call("/device/code", { body: { client_id: CLIENT_ID, user_id: "mark" } });
    expect(res.status).toBe(400);
    expect(await testPrisma.deviceCode.count()).toBe(0);
  });

  it("won't mint a pre-bound code sent form-encoded either", async () => {
    await seedMember("mark");
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `client_id=${CLIENT_ID}&user_id=mark`,
      }),
    );
    expect(res.status).toBe(400);
    expect(await testPrisma.deviceCode.count()).toBe(0);
  });

  it("won't approve without a signed-in session", async () => {
    const code = await requestCode();
    const res = await call("/device/approve", { body: { userCode: code.user_code } });
    expect(res.status).toBe(401);
  });
});

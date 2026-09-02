// Pins the three properties PASSKEYS_PLAN.md's whole design rests on,
// against a REAL, isolated SQLite database (src/lib/test-temp-db.ts, same
// pattern as require-member.test.ts / allowed-email.test.ts):
//
//   1. Passkey rows cascade away with their User — deleteAccount
//      (src/app/actions/account.ts) does a plain prisma.user.delete and
//      relies on schema cascades, so an orphan credential must be
//      impossible.
//   2. The web of trust gates passkey sign-ins with NO passkey-specific
//      code. @better-auth/passkey's verify-authentication endpoint creates
//      its session via ctx.context.internalAdapter.createSession(userId)
//      (read from the plugin's shipped source), which is where
//      src/lib/auth.ts's databaseHooks.session.create.before runs. So this
//      exercises that exact layer: a user who holds a passkey but is no
//      longer vouched for gets no session; vouch for them and they do.
//   3. Registering a passkey requires a session — the plugin's
//      generate-register-options endpoint refuses an anonymous caller.
//
// The WebAuthn ceremony itself (a real authenticator signing a real
// challenge) is deliberately NOT simulated here — that needs a browser and
// a virtual authenticator, which is PASSKEYS_PLAN.md Phase 6's job.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient } from "@/generated/prisma/client";

let testPrisma: PrismaClient;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

// auth.ts hands `prisma` to prismaAdapter() at import time, so the temp DB
// has to exist BEFORE the module is imported — hence the dynamic import in
// beforeAll rather than the top-level `await import()` the other tests use.
let auth: typeof import("@/lib/auth").auth;

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
  process.env.BETTER_AUTH_SECRET = "test-secret-not-for-production-0123456789";
  process.env.BETTER_AUTH_URL = "http://localhost:3002";
  ({ auth } = await import("@/lib/auth"));
});

afterAll(async () => {
  await cleanupDb?.();
});

afterEach(async () => {
  await testPrisma.session.deleteMany({});
  await testPrisma.passkey.deleteMany({});
  await testPrisma.member.deleteMany({});
  await testPrisma.household.deleteMany({});
  await testPrisma.user.deleteMany({});
  delete process.env.ALLOWED_EMAILS;
});

async function seedUser(id: string) {
  return testPrisma.user.create({
    data: { id, name: id, email: `${id}@example.com`, emailVerified: true },
  });
}

async function seedPasskey(userId: string, id = `${userId}-passkey`) {
  return testPrisma.passkey.create({
    data: {
      id,
      userId,
      name: "Test device",
      publicKey: "not-a-real-key",
      credentialID: `${id}-credential`,
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
      transports: "internal",
    },
  });
}

async function seedHouseholdMember(userId: string) {
  const household = await testPrisma.household.create({
    data: { id: `${userId}-household`, name: `${userId}-household`, slug: `${userId}-household`, createdAt: new Date() },
  });
  await testPrisma.member.create({
    data: { id: `${userId}-member`, householdId: household.id, userId, role: "member", createdAt: new Date() },
  });
}

describe("Passkey schema", () => {
  it("cascades passkeys away when their user is deleted", async () => {
    await seedUser("cascade-user");
    await seedPasskey("cascade-user");
    expect(await testPrisma.passkey.count({ where: { userId: "cascade-user" } })).toBe(1);

    await testPrisma.user.delete({ where: { id: "cascade-user" } });

    expect(await testPrisma.passkey.count({ where: { userId: "cascade-user" } })).toBe(0);
  });
});

describe("web-of-trust gate on the session path passkeys use", () => {
  it("refuses a session for a passkey holder nobody vouches for", async () => {
    // A bare User row + a registered passkey, but no membership, no
    // invitation, no access code, not on ALLOWED_EMAILS: exactly a member
    // who was removed from their household after enrolling a passkey.
    await seedUser("revoked-user");
    await seedPasskey("revoked-user");

    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession("revoked-user");

    expect(session).toBeNull();
    expect(await testPrisma.session.count({ where: { userId: "revoked-user" } })).toBe(0);
  });

  it("creates a session for a passkey holder who is a household member", async () => {
    await seedUser("member-user");
    await seedPasskey("member-user");
    await seedHouseholdMember("member-user");

    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession("member-user");

    expect(session).not.toBeNull();
    expect(session?.userId).toBe("member-user");
    expect(await testPrisma.session.count({ where: { userId: "member-user" } })).toBe(1);
  });

  it("creates a session for a passkey holder on the ALLOWED_EMAILS root anchor", async () => {
    process.env.ALLOWED_EMAILS = "root-user@example.com";
    await seedUser("root-user");
    await seedPasskey("root-user");

    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession("root-user");

    expect(session?.userId).toBe("root-user");
  });
});

describe("passkey registration", () => {
  it("refuses to start registration without a session", async () => {
    await expect(
      auth.api.generatePasskeyRegistrationOptions({ headers: new Headers() }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

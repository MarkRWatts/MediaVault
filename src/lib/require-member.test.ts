// Exercises requireOwnerOrResponse() (Phase 5 of HOUSEHOLDS_PLAN.md's
// "Auth & gating", re-pointed at User.isAppOwner per the /account+/admin
// rebuild — see prisma/schema.prisma's User.isAppOwner comment) against a
// REAL, isolated SQLite database — same pattern as
// access.test.ts/allowed-email.test.ts — so the isAppOwner lookup runs
// against actual SQL, not a mock. auth.api.getSession() is mocked
// directly: exercising real BetterAuth sign-in here would mean standing up
// its whole email-OTP flow, which is out of scope for what this test is
// actually verifying (the owner-gating logic downstream of a resolved
// session).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client";

let testPrisma: PrismaClientType;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
}));

const { requireOwnerOrResponse } = await import("@/lib/require-member");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});

afterEach(() => {
  getSession.mockReset();
});

afterAll(async () => {
  await cleanupDb?.();
});

async function seedUser(id: string, isAppOwner = false) {
  await testPrisma.user.create({
    data: { id, name: id, email: `${id}@example.com`, emailVerified: true, isAppOwner },
  });
}

// A household "owner" Member row — kept in these tests specifically to
// prove that Member.role no longer influences requireOwnerOrResponse() at
// all: the whole point of the isAppOwner switch (HOUSEHOLDS_PLAN.md part 1)
// is that being a household's own owner must NOT grant scan/enrich/report/
// admin access.
async function seedHouseholdMember(userId: string, role: "owner" | "member") {
  const household = await testPrisma.household.create({
    data: { id: `${userId}-household`, name: `${userId}-household`, slug: `${userId}-household`, createdAt: new Date() },
  });
  await testPrisma.member.create({
    data: { id: `${userId}-member`, householdId: household.id, userId, role, createdAt: new Date() },
  });
  return household;
}

describe("requireOwnerOrResponse", () => {
  it("returns 401 when there is no session", async () => {
    getSession.mockResolvedValue(null);
    const result = await requireOwnerOrResponse();
    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in" });
  });

  it("returns 403 for a signed-in user who isn't the app owner and has no household", async () => {
    await seedUser("orphan-user");
    getSession.mockResolvedValue({ user: { id: "orphan-user" } });
    const result = await requireOwnerOrResponse();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns 403 for a household OWNER member who is not the app owner", async () => {
    // The regression case this switch exists to close: household-role
    // "owner" must not, by itself, unlock scan/enrich/report/admin.
    await seedUser("household-owner-user");
    await seedHouseholdMember("household-owner-user", "owner");
    getSession.mockResolvedValue({ user: { id: "household-owner-user" } });
    const result = await requireOwnerOrResponse();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns 403 for a signed-in plain member who is not the app owner", async () => {
    await seedUser("member-user");
    await seedHouseholdMember("member-user", "member");
    getSession.mockResolvedValue({ user: { id: "member-user" } });
    const result = await requireOwnerOrResponse();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns the Owner for a signed-in app owner, even with no household at all", async () => {
    await seedUser("app-owner-user", true);
    getSession.mockResolvedValue({ user: { id: "app-owner-user" } });
    const result = await requireOwnerOrResponse();
    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual({ userId: "app-owner-user", email: "app-owner-user@example.com" });
  });

  it("returns the Owner for an app owner who is only a plain household member", async () => {
    // isAppOwner is completely independent of Member.role — a plain
    // "member" who happens to also be the app owner still gets in.
    await seedUser("app-owner-plain-member", true);
    await seedHouseholdMember("app-owner-plain-member", "member");
    getSession.mockResolvedValue({ user: { id: "app-owner-plain-member" } });
    const result = await requireOwnerOrResponse();
    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual({
      userId: "app-owner-plain-member",
      email: "app-owner-plain-member@example.com",
    });
  });
});

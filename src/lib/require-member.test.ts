// Exercises requireOwnerOrResponse() (Phase 5 of HOUSEHOLDS_PLAN.md's
// "Auth & gating") against a REAL, isolated SQLite database — same pattern
// as access.test.ts/allowed-email.test.ts — so the household-membership
// query runs against actual SQL, not a mock. auth.api.getSession() is
// mocked directly: exercising real BetterAuth sign-in here would mean
// standing up its whole email-OTP flow, which is out of scope for what
// this test is actually verifying (the role-gating logic downstream of a
// resolved session).
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

async function seedUser(id: string) {
  await testPrisma.user.create({
    data: { id, name: id, email: `${id}@example.com`, emailVerified: true },
  });
}

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

  it("returns 403 when signed in but not part of any household", async () => {
    await seedUser("orphan-user");
    getSession.mockResolvedValue({ user: { id: "orphan-user" } });
    const result = await requireOwnerOrResponse();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns 403 for a signed-in member who is not the owner", async () => {
    await seedUser("member-user");
    await seedHouseholdMember("member-user", "member");
    getSession.mockResolvedValue({ user: { id: "member-user" } });
    const result = await requireOwnerOrResponse();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns the Member for a signed-in owner", async () => {
    await seedUser("owner-user");
    const household = await seedHouseholdMember("owner-user", "owner");
    getSession.mockResolvedValue({ user: { id: "owner-user" } });
    const result = await requireOwnerOrResponse();
    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual({ userId: "owner-user", householdId: household.id, role: "owner" });
  });
});

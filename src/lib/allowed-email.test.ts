// Exercises src/lib/allowed-email.ts's web-of-trust logic against a real,
// isolated SQLite database (see src/lib/test-temp-db.ts): the ALLOWED_EMAILS
// root anchor, an existing Member row, a pending unexpired Invitation, and a
// live unredeemed AccessCode each independently vouch for an email, and a
// bare User row with none of those must NOT vouch for itself (the whole
// point of not querying the User table directly — see the header comment in
// allowed-email.ts).
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

const { isAllowedEmail } = await import("@/lib/allowed-email");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});

afterAll(async () => {
  await cleanupDb?.();
});

afterEach(async () => {
  await testPrisma.invitation.deleteMany({});
  await testPrisma.member.deleteMany({});
  await testPrisma.household.deleteMany({});
  await testPrisma.accessCode.deleteMany({});
  await testPrisma.user.deleteMany({});
  delete process.env.ALLOWED_EMAILS;
});

describe("isAllowedEmail", () => {
  it("rejects null/undefined/empty email", async () => {
    expect(await isAllowedEmail(null)).toBe(false);
    expect(await isAllowedEmail(undefined)).toBe(false);
    expect(await isAllowedEmail("   ")).toBe(false);
  });

  it("allows an email on the ALLOWED_EMAILS root anchor, case-insensitively", async () => {
    process.env.ALLOWED_EMAILS = "mark@example.com, emma@example.com";
    expect(await isAllowedEmail("mark@example.com")).toBe(true);
    expect(await isAllowedEmail("MARK@EXAMPLE.COM")).toBe(true);
    expect(await isAllowedEmail("stranger@example.com")).toBe(false);
  });

  it("does NOT allow a bare User row with no membership", async () => {
    await testPrisma.user.create({
      data: { id: "u1", name: "Orphan", email: "orphan@example.com", emailVerified: false },
    });
    expect(await isAllowedEmail("orphan@example.com")).toBe(false);
  });

  it("allows an email that belongs to a household Member", async () => {
    const user = await testPrisma.user.create({
      data: { id: "u2", name: "Member", email: "member@example.com", emailVerified: true },
    });
    const household = await testPrisma.household.create({
      data: { id: "h1", name: "Test House", slug: "test-house", createdAt: new Date() },
    });
    await testPrisma.member.create({
      data: { id: "m1", householdId: household.id, userId: user.id, role: "owner", createdAt: new Date() },
    });
    expect(await isAllowedEmail("member@example.com")).toBe(true);
    expect(await isAllowedEmail("MEMBER@example.com")).toBe(true);
  });

  it("allows an email with a pending, unexpired Invitation", async () => {
    const user = await testPrisma.user.create({
      data: { id: "u3", name: "Owner", email: "owner@example.com", emailVerified: true },
    });
    const household = await testPrisma.household.create({
      data: { id: "h2", name: "Test House 2", slug: "test-house-2", createdAt: new Date() },
    });
    await testPrisma.invitation.create({
      data: {
        id: "inv1",
        householdId: household.id,
        email: "invitee@example.com",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: user.id,
      },
    });
    expect(await isAllowedEmail("invitee@example.com")).toBe(true);
  });

  it("does not allow an expired Invitation", async () => {
    const user = await testPrisma.user.create({
      data: { id: "u4", name: "Owner", email: "owner2@example.com", emailVerified: true },
    });
    const household = await testPrisma.household.create({
      data: { id: "h3", name: "Test House 3", slug: "test-house-3", createdAt: new Date() },
    });
    await testPrisma.invitation.create({
      data: {
        id: "inv2",
        householdId: household.id,
        email: "late@example.com",
        status: "pending",
        expiresAt: new Date(Date.now() - 86_400_000),
        inviterId: user.id,
      },
    });
    expect(await isAllowedEmail("late@example.com")).toBe(false);
  });

  it("does not allow a cancelled/accepted Invitation", async () => {
    const user = await testPrisma.user.create({
      data: { id: "u5", name: "Owner", email: "owner3@example.com", emailVerified: true },
    });
    const household = await testPrisma.household.create({
      data: { id: "h4", name: "Test House 4", slug: "test-house-4", createdAt: new Date() },
    });
    await testPrisma.invitation.create({
      data: {
        id: "inv3",
        householdId: household.id,
        email: "cancelled@example.com",
        status: "cancelled",
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: user.id,
      },
    });
    expect(await isAllowedEmail("cancelled@example.com")).toBe(false);
  });

  it("allows an email with a live, unredeemed AccessCode", async () => {
    await testPrisma.accessCode.create({
      data: { code: "MVCODE0001", email: "coded@example.com", maxRedemptions: 1, redeemedCount: 0 },
    });
    expect(await isAllowedEmail("coded@example.com")).toBe(true);
    expect(await isAllowedEmail("CODED@example.com")).toBe(true);
  });

  it("does not allow a fully-redeemed AccessCode", async () => {
    await testPrisma.accessCode.create({
      data: { code: "MVCODE0002", email: "used@example.com", maxRedemptions: 1, redeemedCount: 1 },
    });
    expect(await isAllowedEmail("used@example.com")).toBe(false);
  });

  it("does not allow an expired AccessCode", async () => {
    await testPrisma.accessCode.create({
      data: {
        code: "MVCODE0003",
        email: "expired@example.com",
        maxRedemptions: 5,
        redeemedCount: 0,
        redeemableUntil: new Date(Date.now() - 86_400_000),
      },
    });
    expect(await isAllowedEmail("expired@example.com")).toBe(false);
  });

  it("a generic (email-null) AccessCode does not vouch for anyone", async () => {
    await testPrisma.accessCode.create({
      data: { code: "MVCODE0004", email: null, maxRedemptions: 1, redeemedCount: 0 },
    });
    expect(await isAllowedEmail("anyone@example.com")).toBe(false);
  });
});

// Exercises setMemberDateOfBirth — the owner-facing half of the age-rating
// gate — against a REAL, isolated SQLite database, same pattern as
// household.test.ts. What's pinned here is the authorization shape (only an
// owner, and never on another owner) and the date parsing, since both are
// load-bearing: the first is what stops a restricted member lifting their
// own restriction, the second is what makes a birthday land on the right day.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

vi.mock("@/lib/email", () => ({ sendAccessCodeEmail: vi.fn() }));

const { setMemberDateOfBirth } = await import("@/app/actions/household");

const HOUSEHOLD = "house";
const OWNER = { userId: "owner", memberId: "owner-member" };
const CO_OWNER = { userId: "co-owner", memberId: "co-owner-member" };
const KID = { userId: "kid", memberId: "kid-member" };

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});

beforeEach(async () => {
  await testPrisma.household.create({
    data: { id: HOUSEHOLD, name: "House", slug: "house", createdAt: new Date() },
  });
  for (const [who, role] of [
    [OWNER, "owner"],
    [CO_OWNER, "owner"],
    [KID, "member"],
  ] as const) {
    await testPrisma.user.create({
      data: { id: who.userId, name: who.userId, email: `${who.userId}@example.com`, emailVerified: true },
    });
    await testPrisma.member.create({
      data: { id: who.memberId, householdId: HOUSEHOLD, userId: who.userId, role, createdAt: new Date() },
    });
  }
});

afterEach(async () => {
  getSession.mockReset();
  revalidatePath.mockReset();
  await testPrisma.auditLog.deleteMany();
  await testPrisma.member.deleteMany();
  await testPrisma.user.deleteMany();
  await testPrisma.household.deleteMany();
});

afterAll(async () => {
  await cleanupDb?.();
});

function form(memberId: string, dateOfBirth: string): FormData {
  const fd = new FormData();
  fd.set("memberId", memberId);
  fd.set("dateOfBirth", dateOfBirth);
  return fd;
}

async function dobOf(memberId: string): Promise<Date | null> {
  const row = await testPrisma.member.findUniqueOrThrow({ where: { id: memberId } });
  return row.dateOfBirth;
}

describe("setMemberDateOfBirth", () => {
  it("stores the date at UTC midnight", async () => {
    getSession.mockResolvedValue({ user: { id: OWNER.userId } });
    expect(await setMemberDateOfBirth(null, form(KID.memberId, "2014-03-02"))).toBeNull();
    expect((await dobOf(KID.memberId))?.toISOString()).toBe("2014-03-02T00:00:00.000Z");
  });

  it("clears the restriction on an empty date", async () => {
    getSession.mockResolvedValue({ user: { id: OWNER.userId } });
    await setMemberDateOfBirth(null, form(KID.memberId, "2014-03-02"));
    expect(await setMemberDateOfBirth(null, form(KID.memberId, ""))).toBeNull();
    expect(await dobOf(KID.memberId)).toBeNull();
  });

  it("refuses a plain member trying to restrict anyone — including themselves", async () => {
    getSession.mockResolvedValue({ user: { id: KID.userId } });
    expect(await setMemberDateOfBirth(null, form(KID.memberId, "2014-03-02"))).toEqual({
      error: "Only a household owner can set that.",
    });
    expect(await dobOf(KID.memberId)).toBeNull();
  });

  it("refuses a restricted member trying to clear their own restriction", async () => {
    getSession.mockResolvedValue({ user: { id: OWNER.userId } });
    await setMemberDateOfBirth(null, form(KID.memberId, "2014-03-02"));

    getSession.mockResolvedValue({ user: { id: KID.userId } });
    expect(await setMemberDateOfBirth(null, form(KID.memberId, ""))).toEqual({
      error: "Only a household owner can set that.",
    });
    expect(await dobOf(KID.memberId)).not.toBeNull();
  });

  it("refuses to restrict an owner — demote them first", async () => {
    getSession.mockResolvedValue({ user: { id: OWNER.userId } });
    expect(await setMemberDateOfBirth(null, form(CO_OWNER.memberId, "1990-01-01"))).toEqual({
      error: "Owners can't be age-restricted — demote them to a member first.",
    });
    expect(await dobOf(CO_OWNER.memberId)).toBeNull();
  });

  it("refuses a member of another household", async () => {
    await testPrisma.household.create({
      data: { id: "other", name: "Other", slug: "other", createdAt: new Date() },
    });
    await testPrisma.user.create({
      data: { id: "stranger", name: "stranger", email: "stranger@example.com", emailVerified: true },
    });
    await testPrisma.member.create({
      data: { id: "stranger-member", householdId: "other", userId: "stranger", role: "member", createdAt: new Date() },
    });

    getSession.mockResolvedValue({ user: { id: OWNER.userId } });
    expect(await setMemberDateOfBirth(null, form("stranger-member", "2014-03-02"))).toEqual({
      error: "That member wasn't found.",
    });
    expect(await dobOf("stranger-member")).toBeNull();
  });

  it("rejects a malformed, impossible or future date without touching the row", async () => {
    getSession.mockResolvedValue({ user: { id: OWNER.userId } });
    for (const bad of ["02/03/2014", "2014-3-2", "not-a-date"]) {
      expect(await setMemberDateOfBirth(null, form(KID.memberId, bad))).toEqual({
        error: "Enter a date of birth as YYYY-MM-DD.",
      });
    }
    expect(await setMemberDateOfBirth(null, form(KID.memberId, "2014-02-31"))).toEqual({
      error: "That isn't a real date.",
    });
    expect(await setMemberDateOfBirth(null, form(KID.memberId, "2999-01-01"))).toEqual({
      error: "That date is in the future.",
    });
    expect(await setMemberDateOfBirth(null, form(KID.memberId, "0202-01-01"))).toEqual({
      error: "That date is too long ago — check the year.",
    });
    expect(await dobOf(KID.memberId)).toBeNull();
  });

  it("revalidates the whole tree, since every listing is derived from the limit", async () => {
    getSession.mockResolvedValue({ user: { id: OWNER.userId } });
    await setMemberDateOfBirth(null, form(KID.memberId, "2014-03-02"));
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("audits the change without recording the date itself", async () => {
    getSession.mockResolvedValue({ user: { id: OWNER.userId } });
    await setMemberDateOfBirth(null, form(KID.memberId, "2014-03-02"));
    await setMemberDateOfBirth(null, form(KID.memberId, ""));
    const rows = await testPrisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.action)).toEqual(["member.age-restrict", "member.age-unrestrict"]);
    expect(rows.every((r) => r.entityId === KID.memberId)).toBe(true);
  });
});

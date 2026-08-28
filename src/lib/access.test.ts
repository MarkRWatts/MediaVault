// Verifies src/lib/access.ts's claim logic against a REAL, isolated SQLite
// database (not the dev DB, not a mock) — this is the check HOUSEHOLDS_PLAN.md
// asked for explicitly: jinglejotter.com's original claimAccessCode runs
// against Postgres and compares one column to another
// (`redeemedCount` vs `maxRedemptions`) inside a `where` clause via Prisma's
// field-to-field filter (`prisma.accessCode.fields.maxRedemptions`), and the
// plan flagged that as unverified on the SQLite/better-sqlite3 provider this
// app actually uses. Manually confirmed compiles to plain SQL
// (`WHERE ... AND "redeemedCount" < "maxRedemptions"`, no Postgres-specific
// syntax) and executes correctly via better-sqlite3 — see the comment on
// claimAccessCode. These tests pin that behaviour so a future Prisma/adapter
// upgrade can't silently regress it.
//
// A temp on-disk SQLite file is pushed with the real schema and wired in via
// vi.mock("@/lib/db", ...) so src/lib/access.ts's own `import { prisma } from
// "@/lib/db"` resolves to this test's isolated instance instead of the dev
// database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client";

let testPrisma: PrismaClientType;
let cleanupDb: () => Promise<void>;

// vi.mock factories are hoisted above imports, so `testPrisma` isn't
// assigned yet when this factory itself runs — the getter defers the read
// until a test actually calls into @/lib/access, by which point beforeAll
// below has run.
vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

const { claimAccessCode, releaseClaim, normalizeCode, formatCode, generateCode } = await import(
  "@/lib/access"
);

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});

afterAll(async () => {
  await cleanupDb?.();
});

describe("normalizeCode / formatCode / generateCode", () => {
  it("normalizes separators, whitespace, and case", () => {
    expect(normalizeCode("mv-abcd 2345")).toBe("MVABCD2345");
    expect(normalizeCode("MVABCD2345")).toBe("MVABCD2345");
  });

  it("formats as MV-XXXX-XXXX", () => {
    expect(formatCode("MVABCD2345")).toBe("MV-ABCD-2345");
  });

  it("generates codes with the MV prefix, correct length, and a safe alphabet", () => {
    for (let i = 0; i < 25; i++) {
      const code = generateCode();
      expect(code).toMatch(/^MV[A-Z0-9]{8}$/);
      expect(code).not.toMatch(/[0O1IL]/); // ambiguous chars excluded
    }
  });
});

describe("claimAccessCode — SQLite field-to-field comparison", () => {
  it("succeeds on a not-yet-redeemed code", async () => {
    await testPrisma.accessCode.create({
      data: { code: "FRESH0001", maxRedemptions: 1, redeemedCount: 0 },
    });
    const result = await claimAccessCode("FRESH0001", null);
    expect(result.ok).toBe(true);
    const row = await testPrisma.accessCode.findUnique({ where: { code: "FRESH0001" } });
    expect(row?.redeemedCount).toBe(1);
  });

  it("fails once maxRedemptions is reached", async () => {
    await testPrisma.accessCode.create({
      data: { code: "MAXEDOUT1", maxRedemptions: 1, redeemedCount: 1 },
    });
    const result = await claimAccessCode("MAXEDOUT1", null);
    expect(result.ok).toBe(false);
  });

  it("allows exactly maxRedemptions claims, then refuses the next one", async () => {
    await testPrisma.accessCode.create({
      data: { code: "MULTIUSE1", maxRedemptions: 2, redeemedCount: 0 },
    });
    expect((await claimAccessCode("MULTIUSE1", null)).ok).toBe(true);
    expect((await claimAccessCode("MULTIUSE1", null)).ok).toBe(true);
    expect((await claimAccessCode("MULTIUSE1", null)).ok).toBe(false);
    const row = await testPrisma.accessCode.findUnique({ where: { code: "MULTIUSE1" } });
    expect(row?.redeemedCount).toBe(2);
  });

  it("fails on an expired code even with redemptions remaining", async () => {
    await testPrisma.accessCode.create({
      data: {
        code: "EXPIRED001",
        maxRedemptions: 5,
        redeemedCount: 0,
        redeemableUntil: new Date(Date.now() - 86_400_000),
      },
    });
    const result = await claimAccessCode("EXPIRED001", null);
    expect(result.ok).toBe(false);
  });

  it("succeeds on a code with a future redeemableUntil", async () => {
    await testPrisma.accessCode.create({
      data: {
        code: "FUTURE0001",
        maxRedemptions: 1,
        redeemedCount: 0,
        redeemableUntil: new Date(Date.now() + 86_400_000),
      },
    });
    const result = await claimAccessCode("FUTURE0001", null);
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown code", async () => {
    const result = await claimAccessCode("NOSUCHCODE", null);
    expect(result.ok).toBe(false);
  });

  it("only lets the bound email claim an email-bound code", async () => {
    await testPrisma.accessCode.create({
      data: { code: "BOUND00001", email: "alice@example.com", maxRedemptions: 1, redeemedCount: 0 },
    });
    const wrongEmail = await claimAccessCode("BOUND00001", "bob@example.com");
    expect(wrongEmail.ok).toBe(false);
    const rightEmail = await claimAccessCode("BOUND00001", "ALICE@example.com");
    expect(rightEmail.ok).toBe(true);
  });

  it("is normalization-tolerant on input (dashes/spaces/case)", async () => {
    await testPrisma.accessCode.create({
      data: { code: "MESSYCODE1", maxRedemptions: 1, redeemedCount: 0 },
    });
    const result = await claimAccessCode("messy-code 1", null);
    expect(result.ok).toBe(true);
  });

  it("never lets two racing claims both win the last slot", async () => {
    await testPrisma.accessCode.create({
      data: { code: "RACECODE01", maxRedemptions: 1, redeemedCount: 0 },
    });
    const [a, b] = await Promise.all([
      claimAccessCode("RACECODE01", null),
      claimAccessCode("RACECODE01", null),
    ]);
    const successes = [a, b].filter((r) => r.ok).length;
    expect(successes).toBe(1);
    const row = await testPrisma.accessCode.findUnique({ where: { code: "RACECODE01" } });
    expect(row?.redeemedCount).toBe(1); // never 2 — the concurrency property under test
  });

  it("releaseClaim hands a redemption slot back", async () => {
    await testPrisma.accessCode.create({
      data: { code: "RELEASE001", maxRedemptions: 1, redeemedCount: 0 },
    });
    const claim = await claimAccessCode("RELEASE001", null);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    await releaseClaim(claim.codeId);
    const row = await testPrisma.accessCode.findUnique({ where: { code: "RELEASE001" } });
    expect(row?.redeemedCount).toBe(0);
    // And the slot is claimable again.
    const reclaim = await claimAccessCode("RELEASE001", null);
    expect(reclaim.ok).toBe(true);
  });

  it("releaseClaim never sends redeemedCount negative", async () => {
    await testPrisma.accessCode.create({
      data: { code: "NORELEASE1", maxRedemptions: 1, redeemedCount: 0 },
    });
    const row = await testPrisma.accessCode.findUniqueOrThrow({ where: { code: "NORELEASE1" } });
    await releaseClaim(row.id);
    const after = await testPrisma.accessCode.findUnique({ where: { code: "NORELEASE1" } });
    expect(after?.redeemedCount).toBe(0);
  });
});

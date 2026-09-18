// Exercises createInvitation's app-only branch (the "invite to MediaVault
// only" tickbox on /account) against a REAL, isolated SQLite database —
// same pattern as music-state.test.ts. The household-invite branch is
// BetterAuth's own endpoint and isn't covered here; what this file pins is
// the part this app adds: the branch is app-owner-only, mints an
// email-bound access code, mails it, and stamps sentAt.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

const sendAccessCodeEmail = vi.fn();
vi.mock("@/lib/email", () => ({
  sendAccessCodeEmail: (...args: unknown[]) => sendAccessCodeEmail(...args),
}));

const { createInvitation } = await import("@/app/actions/household");

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
});

afterEach(async () => {
  getSession.mockReset();
  revalidatePath.mockReset();
  sendAccessCodeEmail.mockReset();
  await testPrisma.accessCode.deleteMany();
  await testPrisma.auditLog.deleteMany();
});

afterAll(async () => {
  await cleanupDb?.();
});

async function seedHouseholdOwner(userId: string, opts: { isAppOwner: boolean }) {
  await testPrisma.user.create({
    data: { id: userId, name: userId, email: `${userId}@example.com`, emailVerified: true, isAppOwner: opts.isAppOwner },
  });
  const household = await testPrisma.household.create({
    data: { id: `${userId}-household`, name: `${userId}-household`, slug: `${userId}-household`, createdAt: new Date() },
  });
  await testPrisma.member.create({
    data: { id: `${userId}-member`, householdId: household.id, userId, role: "owner", createdAt: new Date() },
  });
  getSession.mockResolvedValue({ user: { id: userId } });
}

function appOnlyForm(email: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("appOnly", "on");
  return fd;
}

describe("createInvitation (app-only)", () => {
  it("app owner: mints an email-bound code, mails it, stamps sentAt and reports the address", async () => {
    await seedHouseholdOwner("mark", { isAppOwner: true });
    sendAccessCodeEmail.mockResolvedValue(undefined);

    const result = await createInvitation(null, appOnlyForm("  Sam@Example.com "));
    expect(result).toEqual({ sent: "sam@example.com" });

    const codes = await testPrisma.accessCode.findMany();
    expect(codes).toHaveLength(1);
    expect(codes[0]!.email).toBe("sam@example.com");
    expect(codes[0]!.code).toMatch(/^MV[A-Z2-9]{8}$/);
    expect(codes[0]!.sentAt).not.toBeNull();

    expect(sendAccessCodeEmail).toHaveBeenCalledTimes(1);
    const [args] = sendAccessCodeEmail.mock.calls[0]!;
    expect(args).toMatchObject({ to: "sam@example.com", inviterName: "mark" });
    expect((args as { code: string }).code.replace(/-/g, "")).toBe(codes[0]!.code);

    // No household Invitation row — this is not a household invite.
    expect(await testPrisma.invitation.count()).toBe(0);
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
    const audit = await testPrisma.auditLog.findMany();
    expect(audit.map((a) => a.action)).toEqual(["invite.send-app-only"]);
  });

  it("household owner who is not the app owner: refused, nothing minted or sent", async () => {
    await seedHouseholdOwner("sam", { isAppOwner: false });

    const result = await createInvitation(null, appOnlyForm("pat@example.com"));
    expect(result).toEqual({ error: "Only the app owner can invite someone to MediaVault." });
    expect(await testPrisma.accessCode.count()).toBe(0);
    expect(sendAccessCodeEmail).not.toHaveBeenCalled();
  });

  it("rejects an address that isn't one before minting anything", async () => {
    await seedHouseholdOwner("mark2", { isAppOwner: true });

    const result = await createInvitation(null, appOnlyForm("not-an-email"));
    expect(result).toEqual({ error: "That doesn't look like an email address." });
    expect(await testPrisma.accessCode.count()).toBe(0);
  });

  it("keeps the minted code when the email fails, and says so", async () => {
    await seedHouseholdOwner("mark3", { isAppOwner: true });
    sendAccessCodeEmail.mockRejectedValue(new Error("SMTP down"));

    const result = await createInvitation(null, appOnlyForm("pat@example.com"));
    expect(result?.error).toMatch(/was minted, but the email failed/);
    const codes = await testPrisma.accessCode.findMany();
    expect(codes).toHaveLength(1);
    expect(codes[0]!.sentAt).toBeNull();
  });
});

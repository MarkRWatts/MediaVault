// Content-free usage audit (see AuditLog in prisma/schema.prisma): every
// server action that mutates domain data records WHO did WHAT KIND of
// thing, never the thing itself — no titles, names, or amounts, so the
// admin page can show how households use the app without showing what
// anyone actually stored in it. Ported from the template app's
// lib/audit.ts as-is.

import { prisma } from "@/lib/db";

// Retention: rows older than a year are swept opportunistically, once every
// SWEEP_EVERY writes (no scheduler in this app). Content-free rows, so this
// is about the table not growing forever, not about disclosure.
const RETENTION_MS = 365 * 24 * 60 * 60_000;
const SWEEP_EVERY = 200;
let writesSinceSweep = 0;

/** Awaitable but never-throwing: an audit failure must not fail (or roll
 *  back) the action being audited, so call sites `await logAudit(...)`
 *  AFTER their own mutation has committed, outside any transaction. */
export async function logAudit(entry: {
  userId?: string;
  householdId?: string;
  /** "<entity>.<verb>", e.g. "household.create" — a closed vocabulary of
   *  action names, never interpolated user content. */
  action: string;
  entityId?: string;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        householdId: entry.householdId ?? null,
        action: entry.action,
        entityId: entry.entityId ?? null,
      },
    });
    if (++writesSinceSweep >= SWEEP_EVERY) {
      writesSinceSweep = 0;
      await prisma.auditLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - RETENTION_MS) } } });
    }
  } catch {
    // Swallowed deliberately — see above.
  }
}

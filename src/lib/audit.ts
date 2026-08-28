// Content-free usage audit (see AuditLog in prisma/schema.prisma): every
// server action that mutates domain data records WHO did WHAT KIND of
// thing, never the thing itself — no titles, names, or amounts, so the
// admin page can show how households use the app without showing what
// anyone actually stored in it. Ported from the template app's
// lib/audit.ts as-is.

import { prisma } from "@/lib/db";

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
  } catch {
    // Swallowed deliberately — see above.
  }
}

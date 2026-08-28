import { requireMemberOrRedirect } from "@/lib/require-member";
import { prisma } from "@/lib/db";
import { InviteForm } from "@/components/household/InviteForm";
import { PendingInviteRow } from "@/components/household/PendingInviteRow";

// Minimal invite-a-member surface (HOUSEHOLDS_PLAN.md Phase 4): there's no
// dedicated household-settings phase in the plan yet, but the feature isn't
// usable by more than one person without *some* way to invite. Deliberately
// small — just who's in, invite by email, and cancel a pending invite. No
// rename/currency/promote/demote/remove (those are explicitly out of scope
// for this phase).
export default async function HouseholdPage() {
  const { householdId, role } = await requireMemberOrRedirect();

  const household = await prisma.household.findUniqueOrThrow({
    where: { id: householdId },
    select: {
      name: true,
      members: {
        select: { id: true, role: true, user: { select: { name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      },
      invitations: {
        where: { status: "pending" },
        select: { id: true, email: true, expiresAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  const isOwner = role === "owner";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 sm:px-6">
      <div>
        <h1 className="font-display text-3xl tracking-wide text-text">{household.name}</h1>
        <p className="mt-1 text-sm text-text-muted">
          {household.members.length} member{household.members.length === 1 ? "" : "s"}
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg tracking-wide text-text">Members</h2>
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated p-4">
          {household.members.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 py-1">
              <div className="flex flex-col">
                <span className="text-sm text-text">{m.user.name || m.user.email}</span>
                {m.user.name && <span className="text-xs text-text-faint">{m.user.email}</span>}
              </div>
              <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-muted">
                {m.role}
              </span>
            </div>
          ))}
        </div>
      </section>

      {isOwner && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-lg tracking-wide text-text">Invite someone</h2>
          <InviteForm />

          {household.invitations.length > 0 && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4">
              {household.invitations.map((inv) => (
                <PendingInviteRow
                  key={inv.id}
                  id={inv.id}
                  email={inv.email}
                  expiresAt={inv.expiresAt.toISOString()}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

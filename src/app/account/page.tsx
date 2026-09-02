import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireMemberOrRedirect } from "@/lib/require-member";
import SignOutButton from "@/components/SignOutButton";
import { InviteForm } from "@/components/household/InviteForm";
import { PendingInviteRow } from "@/components/household/PendingInviteRow";
import { PromoteButton } from "@/components/household/PromoteButton";
import { DemoteButton } from "@/components/household/DemoteButton";
import { RemoveMemberButton } from "@/components/household/RemoveMemberButton";
import { RenameHouseholdForm } from "@/components/household/RenameHouseholdForm";
import { getAuthenticatorName } from "@better-auth/passkey";
import { DeleteAccountButton } from "@/components/account/DeleteAccountButton";
import { EditNameForm } from "@/components/account/EditNameForm";
import { AdultAccessToggle } from "@/components/account/AdultAccessToggle";
import { PasskeyManager } from "@/components/account/PasskeyManager";

// DB-backed, per-user page — must render per-request, not be frozen at
// build time (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

// Unified account/household settings page (formerly /household — see
// HOUSEHOLDS_PLAN.md's "Rebuild /household into a unified /account page").
// Ported from the template app's app/account/page.tsx: identity (name/
// email/sign-out) at top, an inline Admin link for the app owner, household
// name + member list with owner-only rename/promote/demote/remove, an
// owner-only invite form + pending-invites list, and delete-account at the
// bottom. Restyled to MediaVault's own dark palette (see src/app/report/page.tsx
// for the tokens this app already uses) rather than the template's light/
// cream one. MediaVault's Household model carries no accessKind/lifetime-
// access concept (no monetization here), so that badge from the template
// isn't ported.
export default async function AccountPage() {
  const { userId, householdId, role } = await requireMemberOrRedirect();
  const isOwner = role === "owner";

  const [user, passkeys, household] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, email: true, isAppOwner: true, adultLibraryAccess: true, jellyfinUserId: true },
    }),
    // Read directly rather than via the plugin's list endpoint — same as
    // every other read on this page. The plugin's own list is what the
    // client would use; here the server component already has the user.
    prisma.passkey.findMany({
      where: { userId },
      select: { id: true, name: true, createdAt: true, backedUp: true, aaguid: true },
      orderBy: { createdAt: "asc" },
    }),
    // The household name and member list are visible to every member, not
    // just owners — only the pending-invitations query (and the invite/
    // manage UI below) is owner-only.
    prisma.household.findUniqueOrThrow({
      where: { id: householdId },
      select: {
        name: true,
        members: {
          select: { id: true, role: true, userId: true, user: { select: { name: true, email: true } } },
          orderBy: { createdAt: "asc" },
        },
        invitations: isOwner
          ? { where: { status: "pending" }, select: { id: true, email: true, expiresAt: true }, orderBy: { createdAt: "desc" } }
          : false,
      },
    }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="font-display text-3xl tracking-wide text-text">Account</h1>
        <SignOutButton />
      </header>

      <section className="flex items-center gap-4 rounded-lg border border-border bg-bg-elevated p-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <EditNameForm name={user.name} />
          {user.email && <span className="text-sm text-text-muted">{user.email}</span>}
        </div>
        {/* Only rendered for the app owner; /admin re-checks server-side
            (src/lib/require-member.ts's requireOwnerOrRedirect), this is
            just the way in. */}
        {user.isAppOwner && (
          <Link
            href="/admin"
            className="ml-auto inline-flex shrink-0 min-h-10 items-center justify-center gap-1.5 rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10 sm:min-h-0"
          >
            Admin
          </Link>
        )}
      </section>

      {/* PASSKEYS_PLAN.md Phase 2. Date and authenticator label resolved
          here so the client component renders nothing locale- or
          server-only-dependent. en-GB is fixed on purpose: a server/client
          locale disagreement would be a hydration mismatch. */}
      <section id="passkeys" className="flex flex-col gap-4">
        <h2 className="font-display text-xl tracking-wide text-text">Passkeys</h2>
        <PasskeyManager
          passkeys={passkeys.map((p) => ({
            id: p.id,
            name: p.name,
            added: p.createdAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
            backedUp: p.backedUp,
            authenticator: getAuthenticatorName(p.aaguid) ?? null,
          }))}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl tracking-wide text-text">Preferences</h2>
        <AdultAccessToggle initialEnabled={user.adultLibraryAccess} initiallyLinked={user.jellyfinUserId !== null} />
      </section>

      <section className="flex flex-col gap-4">
        {isOwner ? (
          <RenameHouseholdForm name={household.name} />
        ) : (
          <h2 className="font-display text-xl tracking-wide text-text">{household.name}</h2>
        )}
        <h3 className="font-display text-lg tracking-wide text-text">
          Members
          <span className="ml-2 font-mono text-xs font-normal text-text-faint">
            {household.members.length}
          </span>
        </h3>
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4">
          {household.members.map((member) => {
            const name = member.user.name || member.user.email || "This member";
            const canManage = isOwner && member.userId !== userId;
            return (
              <div key={member.id} className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-text">
                    {name}
                    {member.userId === userId && (
                      <span className="ml-1.5 text-xs font-normal text-text-faint">(you)</span>
                    )}
                  </span>
                  {member.user.email && (
                    <span className="text-xs text-text-faint">{member.user.email}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-muted">
                    {member.role}
                  </span>
                  {canManage &&
                    (member.role === "owner" ? (
                      <DemoteButton memberId={member.id} name={name} />
                    ) : (
                      <>
                        <PromoteButton memberId={member.id} name={name} />
                        <RemoveMemberButton memberId={member.id} name={name} />
                      </>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {isOwner && (
        <section className="flex flex-col gap-4">
          <h2 className="font-display text-xl tracking-wide text-text">Invite someone</h2>
          <InviteForm />

          {household.invitations.length > 0 && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4">
              {household.invitations.map((invitation) => (
                <PendingInviteRow
                  key={invitation.id}
                  id={invitation.id}
                  email={invitation.email}
                  expiresAt={invitation.expiresAt.toISOString()}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <div className="flex justify-center border-t border-border pt-6">
        <DeleteAccountButton
          householdName={household.name}
          soleOwner={
            isOwner && !household.members.some((m) => m.userId !== userId && m.role === "owner")
          }
          otherMemberCount={household.members.filter((m) => m.userId !== userId).length}
        />
      </div>
    </div>
  );
}

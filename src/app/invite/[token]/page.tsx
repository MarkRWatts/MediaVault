import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { acceptInvitation } from "@/app/actions/household";
import { SubmitButton } from "@/app/signin/submit-button";

// Public-ish landing page for an invite link (see proxy.ts's /invite/
// prefix exemption). Not gated by ALLOWED_EMAILS or household membership —
// anyone holding the (unguessable) token URL can see the preview; only a
// signed-in user can actually accept. Ported from jinglejotter.com's
// app/invite/[token]/page.tsx, restyled to MediaVault's dark palette.
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;

  const invitation = await prisma.invitation.findUnique({
    where: { id: token },
    include: {
      household: { select: { name: true } },
      user: { select: { name: true, email: true } },
    },
  });

  const invalid =
    !invitation || invitation.status !== "pending" || invitation.expiresAt < new Date();

  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-lg border border-border bg-bg-elevated p-8 text-center shadow-lg shadow-black/30">
        {invalid ? (
          <>
            <h1 className="font-display text-3xl tracking-wide text-text">
              This invite isn&apos;t valid
            </h1>
            <p className="text-sm text-text-muted">
              It may have expired, already been used, or been cancelled — ask whoever invited you
              for a fresh link.
            </p>
            <Link
              href="/"
              className="inline-flex min-h-10 items-center justify-center rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10 sm:min-h-0"
            >
              Go to MediaVault
            </Link>
          </>
        ) : (
          <>
            <h1 className="font-display text-3xl tracking-wide text-text">
              Join {invitation.household.name}
            </h1>
            <p className="text-sm text-text-muted">
              {invitation.user.name || invitation.user.email} invited you to share their
              MediaVault library.
            </p>

            {error === "already-in-household" ? (
              <p className="w-full rounded-md border border-missing-border bg-missing-bg px-4 py-3 text-sm text-missing">
                You&apos;re already part of a different household — leave it first before joining
                this one.
              </p>
            ) : error === "already-member" ? (
              <p className="w-full rounded-md border border-missing-border bg-missing-bg px-4 py-3 text-sm text-missing">
                You&apos;re already part of this household.
              </p>
            ) : null}

            {session?.user ? (
              <form action={acceptInvitation} className="w-full">
                <input type="hidden" name="token" value={token} />
                <SubmitButton pendingText="Joining…">Join {invitation.household.name}</SubmitButton>
              </form>
            ) : (
              <Link
                href={`/signin?callbackURL=${encodeURIComponent(`/invite/${token}`)}`}
                className="inline-flex min-h-10 w-full items-center justify-center rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10 sm:min-h-0"
              >
                Sign in to accept
              </Link>
            )}
          </>
        )}
      </div>
    </main>
  );
}

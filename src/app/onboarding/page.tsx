import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { SIGNUP_CODE_COOKIE } from "@/lib/flow-cookies";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createHousehold, goToInvite } from "@/app/actions/household";
import { CreateHouseholdForm } from "@/components/household/CreateHouseholdForm";

// A starting suggestion, not a silent default — the field stays fully
// editable.
function suggestedHouseholdName(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const base = (name || email || "").trim().split(/[\s@]/)[0];
  if (!base) return "";
  return `${base[0].toUpperCase()}${base.slice(1)}'s household`;
}

// First-run screen for a signed-in user with no household: create one, or
// jump to an invite link they were sent. Reached via requireMemberOrRedirect()
// from every protected page, so a user with a household is never routed here
// in normal use — the redirect below only guards a direct visit. Ported from
// jinglejotter.com's app/onboarding/page.tsx, restyled to MediaVault's dark
// palette and copy with no Christmas branding.
export default async function OnboardingPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) redirect("/signin?callbackURL=/onboarding");

  const member = await prisma.member.findFirst({ where: { userId: session.user.id } });
  if (member) redirect("/");

  // Someone arriving from /signup already typed their access code there —
  // carry it into the form so it isn't asked for twice. createHousehold
  // clears the cookie once the code is actually claimed.
  const signupCode = (await cookies()).get(SIGNUP_CODE_COOKIE)?.value ?? "";

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="font-display text-3xl tracking-wide text-text">Welcome to MediaVault</h1>
          <p className="text-sm text-text-muted">
            Set up your own household, or join one you&apos;ve been invited to.
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-6">
          <h2 className="font-display text-lg tracking-wide text-text">Start a new household</h2>
          <p className="text-sm text-text-muted">
            You&apos;ll be its owner, and can invite the rest of your household once it&apos;s set
            up. You&apos;ll need the access code you were given — MediaVault is invite-only for
            now.
          </p>
          <CreateHouseholdForm
            action={createHousehold}
            defaultName={suggestedHouseholdName(session.user.name, session.user.email)}
            defaultCode={signupCode}
          />
        </div>

        <div className="flex items-center gap-3 text-xs text-text-faint">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-6">
          <h2 className="font-display text-lg tracking-wide text-text">Have an invite?</h2>
          <form action={goToInvite} className="flex flex-col gap-3">
            <input
              type="text"
              name="invite"
              required
              placeholder="Paste the invite link"
              className="w-full rounded-md border border-border bg-bg-elevated-2 px-4 py-2.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
            />
            <button
              type="submit"
              className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text sm:min-h-0"
            >
              Continue
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

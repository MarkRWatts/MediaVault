import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { decideConsent } from "@/app/actions/consent";
import { SubmitButton } from "@/app/signin/submit-button";

// BetterAuth's oauthProvider `consentPage` (see auth.ts). Reached only for
// an OAuth client that isn't skip_consent — Jellyfin's registered client
// (scripts/register-jellyfin-client.ts) has skip_consent: true, so this page
// is a fallback the plugin requires rather than something household members
// will normally see. See HOUSEHOLDS_PLAN.md "Jellyfin SSO".

const SCOPE_LABELS: Record<string, string> = {
  openid: "confirm who you are",
  profile: "your name and picture",
  email: "your email address",
  offline_access: "stay signed in without you",
};

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rawParams = await searchParams;
  const clientId = firstValue(rawParams.client_id);
  const scope = firstValue(rawParams.scope) ?? "";
  const oauthQuery = new URLSearchParams(
    Object.entries(rawParams).flatMap(([key, value]) =>
      value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v) => [key, v]),
    ),
  ).toString();

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    redirect(`/signin?callbackURL=${encodeURIComponent(`/consent?${oauthQuery}`)}`);
  }
  if (!clientId) redirect("/");

  const client = await auth.api
    .getOAuthClientPublic({ query: { client_id: clientId }, headers: await headers() })
    .catch(() => null);
  const scopes = scope.split(" ").filter(Boolean);

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-lg border border-border bg-bg-elevated p-8 text-center shadow-lg shadow-black/30">
        <h1 className="font-display text-3xl tracking-wide text-text">Allow access</h1>
        <p className="text-sm text-text-muted">
          <span className="font-semibold text-text">{client?.client_name ?? clientId}</span>{" "}
          wants to sign you in as{" "}
          <span className="font-semibold text-text">{session.user.email}</span>.
        </p>
        {scopes.length > 0 && (
          <ul className="w-full list-disc space-y-1 pl-5 text-left text-sm text-text-muted">
            {scopes.map((s) => (
              <li key={s}>{SCOPE_LABELS[s] ?? s}</li>
            ))}
          </ul>
        )}
        <div className="flex w-full flex-col gap-3">
          <form action={decideConsent} className="w-full">
            <input type="hidden" name="accept" value="true" />
            <input type="hidden" name="oauthQuery" value={oauthQuery} />
            <SubmitButton>Allow</SubmitButton>
          </form>
          <form action={decideConsent} className="w-full">
            <input type="hidden" name="accept" value="false" />
            <input type="hidden" name="oauthQuery" value={oauthQuery} />
            <button
              type="submit"
              className="inline-flex min-h-10 w-full items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-bg-elevated-2 sm:min-h-0"
            >
              Deny
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

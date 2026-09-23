import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AuthLogo from "@/components/AuthLogo";
import { auth } from "@/lib/auth";
import { requireMemberOrRedirect } from "@/lib/require-member";
import { deviceClientName, formatUserCode } from "@/lib/device-sign-in";
import { decideDevice } from "@/app/actions/device";
import { SubmitButton } from "@/app/signin/submit-button";

// Where the Apple TV's QR code lands (TVOS_PLAN.md "Sign-in: scan a QR
// code with your phone"): `/device?user_code=ABCDEFGH`. Opening it signed
// in claims the code for this member (BetterAuth's GET /device does that
// as a side effect), and only they can then approve or deny it. Signed
// out, the proxy sends the phone to /signin and back here afterwards.
// Without a code it asks for one, for anyone reading it off the TV.

type Verification = { status: "pending" | "approved" | "denied"; client_id?: string };

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rawParams = await searchParams;
  const userCode = firstValue(rawParams.user_code)?.trim() ?? "";
  const here = `/device${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ""}`;

  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) redirect(`/signin?callbackURL=${encodeURIComponent(here)}`);
  await requireMemberOrRedirect();

  if (!userCode) return <EnterCode />;

  const verification = (await auth.api
    .deviceVerify({ query: { user_code: userCode }, headers: requestHeaders })
    .catch(() => null)) as Verification | null;
  const shownCode = formatUserCode(userCode);

  if (!verification) {
    return (
      <Card title="Code not found">
        <p className="text-sm text-text-muted">
          <Code>{shownCode}</Code> isn&apos;t a sign-in code, or it has expired. Codes last ten minutes, and the
          TV puts up a new one when a code runs out.
        </p>
        <EnterCodeForm />
      </Card>
    );
  }

  // Someone else opened this code first; only they can decide it.
  if (!verification.client_id) {
    return (
      <Card title="Already in use">
        <p className="text-sm text-text-muted">
          Someone else has already opened <Code>{shownCode}</Code>. If that wasn&apos;t you, ask for a new code on
          the TV.
        </p>
      </Card>
    );
  }

  const deviceName = deviceClientName(verification.client_id);

  if (verification.status === "approved") {
    return (
      <Card title="Signed in">
        <p className="text-sm text-text-muted">{deviceName} is signing in as you. You can put your phone down.</p>
      </Card>
    );
  }
  if (verification.status === "denied") {
    return (
      <Card title="Not signed in">
        <p className="text-sm text-text-muted">You turned down {deviceName}. It won&apos;t be signed in.</p>
      </Card>
    );
  }

  return (
    <Card title="Sign in a TV?">
      <p className="text-sm text-text-muted">
        <span className="font-semibold text-text">{deviceName}</span> wants to sign in as{" "}
        <span className="font-semibold text-text">{session.user.email}</span>.
      </p>
      <p className="font-mono text-3xl tracking-[0.2em] text-text">{shownCode}</p>
      <p className="text-sm text-text-muted">
        Check this matches the code on your TV. Only approve a TV you&apos;re in front of.
      </p>
      <div className="flex w-full flex-col gap-3">
        <form action={decideDevice} className="w-full">
          <input type="hidden" name="userCode" value={userCode} />
          <input type="hidden" name="verdict" value="approve" />
          <SubmitButton pendingText="Signing in…">Approve</SubmitButton>
        </form>
        <form action={decideDevice} className="w-full">
          <input type="hidden" name="userCode" value={userCode} />
          <input type="hidden" name="verdict" value="deny" />
          <button
            type="submit"
            className="inline-flex min-h-10 w-full items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-bg-elevated-2 sm:min-h-0"
          >
            Deny
          </button>
        </form>
      </div>
    </Card>
  );
}

function EnterCode() {
  return (
    <Card title="Sign in a TV">
      <p className="text-sm text-text-muted">Enter the code shown on your TV.</p>
      <EnterCodeForm />
    </Card>
  );
}

/** A plain GET back to this page, which then treats it like a scanned link. */
function EnterCodeForm() {
  return (
    <form method="get" action="/device" className="flex w-full flex-col gap-3">
      <input
        name="user_code"
        required
        autoComplete="one-time-code"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="ABCD-EFGH"
        aria-label="Code from your TV"
        className="w-full rounded-md border border-border bg-bg px-3 py-2 text-center font-mono text-lg tracking-[0.2em] text-text"
      />
      <SubmitButton>Continue</SubmitButton>
    </form>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-lg border border-border bg-bg-elevated p-8 text-center shadow-lg shadow-black/30">
        <AuthLogo />
        <h1 className="font-display text-3xl tracking-wide text-text">{title}</h1>
        {children}
      </div>
    </main>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <span className="font-mono font-semibold text-text">{children}</span>;
}

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Home — the front page: rows to browse (Top Picks, Favourites, Collections,
// a row per genre, New Shows, New Music) rather than the whole library, the
// same rows in the same order as the iPhone and Apple TV apps show
// (src/lib/home-rows.ts decides them; components/home draws them). The
// whole library, filterable, is Movies (/films). DB-backed: must render
// per-request, not be frozen at build time (the Docker image is built with
// no database present).
export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import HomeRows from "@/components/home/HomeRows";
import { PasskeyNudge } from "@/components/auth/PasskeyNudge";
import { requireMemberOrRedirect } from "@/lib/require-member";
import { PASSKEY_NUDGE_COOKIE } from "@/lib/flow-cookies";
import { getHomeRows, serverFeatures } from "@/lib/home-rows";

export default async function HomePage() {
  // A real session check, not proxy.ts's cookie gate (which only proves the
  // cookie was signed by this server, not that the session is live or the
  // person still a member); a signed-in non-member is sent to /onboarding,
  // same as every other library page.
  const { userId, ageLimit } = await requireMemberOrRedirect();
  // Set by an email-code sign-in (see verifyOTP), which lands here; the
  // strip itself decides whether this device can make a passkey and
  // whether it's been dismissed.
  const nudgePasskey = (await cookies()).has(PASSKEY_NUDGE_COOKIE);

  const data = await getHomeRows(userId, ageLimit, serverFeatures());

  return (
    <div className="flex flex-1 flex-col">
      {nudgePasskey && <PasskeyNudge />}
      <div className="px-4 pt-6 sm:px-6">
        <h1 className="font-display text-3xl tracking-wide">Home</h1>
      </div>
      <HomeRows data={data} />
    </div>
  );
}

// GET /api/films — minimal read-only JSON listing for native clients (the
// MediaVaultTV tvOS app) that can't embed the web UI itself: tvOS has no
// WebKit/WKWebView available to third-party apps at all (confirmed directly
// against the tvOS SDK — no WebKit.framework ships for tvOS), so a native
// shell needs its own catalog UI, not a wrapped webpage. This wraps the same
// getLibraryFilms() the "/" page already uses, trimmed to what a simple list
// screen needs.

import { NextResponse } from "next/server";
import { getLibraryFilms } from "@/lib/queries";
import { requireMemberOrResponse } from "@/lib/require-member";

// Household-member gated like every other library read (a real session,
// not just src/proxy.ts's cookie check). A native client must therefore
// carry a genuine session cookie — obtained via the same email-OTP sign-in
// — on these requests.
export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { films } = await getLibraryFilms();
  return NextResponse.json({
    films: films.map((f) => ({
      id: f.id,
      title: f.title,
      year: f.year,
      posterPath: f.posterPath,
      formats: f.formats,
    })),
  });
}

// GET /api/history?before=<cursor>&kind=film|episode|track — the pages of
// the /history timeline after the first, which the page renders itself.
//
// The scope is the session and nothing else: userId comes from
// requireMemberOrResponse, never from the query string, so there is no
// request this route will answer with somebody else's history. `before` and
// `kind` only ever narrow what that one person sees.

import { NextResponse, type NextRequest } from "next/server";
import { getHistoryPage, isHistoryKind } from "@/lib/history";
import { requireMemberOrResponse } from "@/lib/require-member";

export async function GET(req: NextRequest) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const kind = req.nextUrl.searchParams.get("kind");
  const page = await getHistoryPage(gate.userId, {
    // An unrecognised kind reads as "no filter" rather than an error — the
    // pills are the only thing that sets it, and a stale one shouldn't
    // break the page.
    kind: isHistoryKind(kind) ? kind : null,
    before: req.nextUrl.searchParams.get("before"),
  });

  return NextResponse.json(page);
}

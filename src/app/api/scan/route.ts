import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/lib/scanner";
import { requireOwnerOrResponse } from "@/lib/require-member";

// force=true/1 (query string ?force=1 or JSON body {"force":true}) ignores
// the size+mtime probe cache and re-probes every file — e.g. after adding a
// new ffprobe-derived field so existing rows pick it up. Plain POST with no
// body keeps working exactly as before (force defaults to false).
async function readForce(req: NextRequest): Promise<boolean> {
  const queryForce = req.nextUrl.searchParams.get("force");
  if (queryForce === "1" || queryForce === "true") return true;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = await req.json();
      if (body && typeof body === "object" && "force" in body) {
        return Boolean((body as { force?: unknown }).force);
      }
    } catch {
      // no/invalid JSON body — treat as force=false
    }
  }
  return false;
}

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  try {
    const force = await readForce(req);
    const { runId, started } = await runScan({ force });
    if (!started) {
      return NextResponse.json({ runId }, { status: 409 });
    }
    return NextResponse.json({ runId, force });
  } catch (err) {
    console.error("[api/scan] failed to start scan:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

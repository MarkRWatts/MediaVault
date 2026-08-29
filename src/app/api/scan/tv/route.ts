import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/lib/scanner";
import { requireOwnerOrResponse } from "@/lib/require-member";
import { readForceFlag } from "@/lib/scan-request";

export async function POST(req: NextRequest) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  try {
    const force = await readForceFlag(req);
    const { runId, started } = await runScan("TV", { force });
    if (!started) {
      return NextResponse.json({ runId }, { status: 409 });
    }
    return NextResponse.json({ runId, force });
  } catch (err) {
    console.error("[api/scan/tv] failed to start scan:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

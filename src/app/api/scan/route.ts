import { NextResponse } from "next/server";
import { runScan } from "@/lib/scanner";

export async function POST() {
  try {
    const { runId, started } = await runScan();
    if (!started) {
      return NextResponse.json({ runId }, { status: 409 });
    }
    return NextResponse.json({ runId });
  } catch (err) {
    console.error("[api/scan] failed to start scan:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

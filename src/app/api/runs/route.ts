import { NextResponse } from "next/server";
import { getLatestRuns } from "@/lib/runs";
import { getNextSyncAt } from "@/lib/scheduler";
import { requireOwnerOrResponse } from "@/lib/require-member";

export async function GET() {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const summary = await getLatestRuns();
  const nextSyncAt = getNextSyncAt();
  return NextResponse.json({ ...summary, nextSyncAt: nextSyncAt ? nextSyncAt.toISOString() : null });
}

import { NextResponse } from "next/server";
import { getLatestRuns } from "@/lib/runs";
import { requireOwnerOrResponse } from "@/lib/require-member";

export async function GET() {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const summary = await getLatestRuns();
  return NextResponse.json(summary);
}

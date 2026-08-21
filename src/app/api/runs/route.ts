import { NextResponse } from "next/server";
import { getLatestRuns } from "@/lib/runs";

export async function GET() {
  const summary = await getLatestRuns();
  return NextResponse.json(summary);
}

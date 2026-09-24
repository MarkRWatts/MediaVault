// GET /api/v1/home — the apps' Home: the rows the web's "/" shows, decided
// once in src/lib/home-rows.ts so the iPhone, the Apple TV and the web all
// show the same ones in the same order.

import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { getHomeRows, serverFeatures } from "@/lib/home-rows";
import type { HomeResponse } from "@/lib/api-v1-types";

export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const body: HomeResponse = await getHomeRows(gate.userId, gate.ageLimit, serverFeatures());
  return NextResponse.json(body);
}

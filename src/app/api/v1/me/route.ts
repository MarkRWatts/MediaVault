// GET /api/v1/me — the native app's one call on every launch (IOS_PLAN.md
// "A versioned native API"): who's signed in, which household they're a
// member of, which network they arrived on (for the video-quality default
// request-network.ts already gives the web), which shelves are worth
// showing at all (a household with no MUSIC_PATH has no music tab), and
// which server build it's talking to. `minAppBuild` lets a future server
// refuse a stale client with a message instead of a confusing 401/404.

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { requireMemberOrResponse } from "@/lib/require-member";
import { prisma } from "@/lib/db";
import { networkKind } from "@/lib/request-network";
import { jellyfinConfigured } from "@/lib/jellyfin";
import { version as APP_VERSION } from "@/../package.json";
import type { MeResponse } from "@/lib/api-v1-types";

// The app's own build-gate floor. Bump this only alongside a server change
// that an older app build genuinely can't cope with — it is not the same
// number as package.json's version.
const MIN_APP_BUILD = 1;

export async function GET() {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const [user, requestHeaders] = await Promise.all([
    prisma.user.findUnique({ where: { id: gate.userId }, select: { name: true, email: true } }),
    headers(),
  ]);
  const network = networkKind(requestHeaders);
  // gate.userId came from a session the DB just vouched for, so a missing
  // User row here would mean the session outlived the account — treat it
  // the same as "not signed in" rather than crashing.
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body: MeResponse = {
    user: { id: gate.userId, name: user.name, email: user.email },
    household: { id: gate.householdId, role: gate.role },
    network,
    features: {
      tv: Boolean(process.env.TVSHOWS_PATH),
      music: Boolean(process.env.MUSIC_PATH),
      jellyfin: jellyfinConfigured(),
    },
    server: { version: APP_VERSION, minAppBuild: MIN_APP_BUILD },
  };
  return NextResponse.json(body);
}

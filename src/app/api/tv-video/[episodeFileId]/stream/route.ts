// GET /api/tv-video/:episodeFileId/stream — the episode twin of
// /api/video/:versionId/stream: the original bytes of a direct-playable file
// (MP4 / H.264-or-HEVC / compatible default audio), with byte ranges so
// seeking works. The session route hands this URL out when a client asked
// for direct play and the file qualifies (engine-routes.ts, canDirectPlay);
// anything else is served by the engine instead, and a request here for it
// gets a 409.
//
// Resolved through the engine's own resolveSource rather than video-cache's
// resolveVideoStream, which predates episodes and only knows films and
// scenes -- so this route and the session route judge "playable as-is"
// with the same probe and the same planner.

import { NextResponse } from "next/server";
import { serveFile } from "@/lib/serve-file";
import { DIRECT_PLAY_MAX_RANGE_BYTES } from "@/lib/constants";
import { requireMemberOrResponse } from "@/lib/require-member";
import { ageGate } from "@/lib/age-gate";
import { PlaybackError, resolveSource } from "@/lib/playback/source";
import { mapPlaybackError } from "@/lib/playback/engine-routes";

export async function GET(req: Request, ctx: { params: Promise<{ episodeFileId: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { episodeFileId: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid episode file id" }, { status: 400 });
  }

  const blocked = await ageGate(gate.ageLimit, "episode", id);
  if (blocked) return blocked;

  try {
    const source = await resolveSource("episode", id, "original");
    if (!source) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (source.plan.tier !== "direct") {
      return NextResponse.json({ error: "this file is served by the playback engine; start a session instead" }, { status: 409 });
    }
    return serveFile(req, source.absPath, "video/mp4", "no-store", { maxRangeBytes: DIRECT_PLAY_MAX_RANGE_BYTES });
  } catch (err) {
    if (err instanceof PlaybackError) {
      const { status, message } = mapPlaybackError(err);
      return NextResponse.json({ error: message }, { status });
    }
    throw err;
  }
}

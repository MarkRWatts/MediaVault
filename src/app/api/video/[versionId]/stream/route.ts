// GET /api/video/:versionId/stream — the original bytes of a direct-playable
// file (already MP4 / H.264-or-HEVC / compatible audio), with normal
// byte-range support so seeking works. Anything that needs preparing is
// served as HLS instead — see ../hls/[variant]/[file]/route.ts and
// PLAYBACK_PLAN.md — and a request here for such a file gets a 409 pointing
// there; the player never sends one, since /status tells it which to use.
//
// On the local engine this judges "playable as-is" with the engine's own
// resolveSource — a live probe of the file, the same one the session route
// used to hand this URL out — as the episode twin does. The library rows
// resolveVideoStream reads can lag a remux: the UHD films were re-muxed to
// AAC on 23 Sep while their rows still listed TrueHD + AC-3, so the session
// said "direct" and this route answered 409, which AVPlayer reports as
// CoreMediaErrorDomain -12939.

import { NextResponse } from "next/server";
import { resolveVideoStream } from "@/lib/video-cache";
import { serveFile } from "@/lib/serve-file";
import { DIRECT_PLAY_MAX_RANGE_BYTES } from "@/lib/constants";
import { requireMemberOrResponse } from "@/lib/require-member";
import { ageGate } from "@/lib/age-gate";
import { playbackEngine } from "@/lib/playback/engine-flag";
import { PlaybackError, resolveSource } from "@/lib/playback/source";
import { mapPlaybackError } from "@/lib/playback/engine-routes";

export async function GET(req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { versionId: versionIdParam } = await ctx.params;
  const versionId = Number(versionIdParam);
  if (!Number.isInteger(versionId)) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }


  // Age gate (src/lib/age-gate.ts): free for an unrestricted viewer, one
  // lookup otherwise. Hiding the film from the listings isn't enough — this
  // route is reachable by id alone.
  const blocked = await ageGate(gate.ageLimit, "film", versionId);
  if (blocked) return blocked;

  // No UHD gate: this is the file itself, untouched — the one way a UHD
  // Version plays (uhdPlaybackBlocked, src/lib/constants.ts).

  if (playbackEngine() === "local") {
    try {
      const source = await resolveSource("film", versionId, "original");
      if (!source) {
        logRefusal(versionId, 404, req, "no source");
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      if (source.plan.tier !== "direct") {
        logRefusal(versionId, 409, req, `tier ${source.plan.tier}: ${source.plan.reason}`);
        return NextResponse.json({ error: "this file is served by the playback engine; start a session instead" }, { status: 409 });
      }
      const res = await serveFile(req, source.absPath, "video/mp4", "no-store", { maxRangeBytes: DIRECT_PLAY_MAX_RANGE_BYTES });
      if (res.status >= 400) logRefusal(versionId, res.status, req, "serveFile");
      return res;
    } catch (err) {
      if (err instanceof PlaybackError) {
        const { status, message } = mapPlaybackError(err);
        logRefusal(versionId, status, req, message);
        return NextResponse.json({ error: message }, { status });
      }
      throw err;
    }
  }

  const resolved = await resolveVideoStream("film", versionId);
  if (resolved.kind === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (resolved.kind === "needs-prepare") {
    return NextResponse.json({ error: "this file is served as HLS; use hls/<variant>/index.m3u8" }, { status: 409 });
  }
  return serveFile(req, resolved.absPath, resolved.contentType, "no-store", { maxRangeBytes: DIRECT_PLAY_MAX_RANGE_BYTES });
}

/** One line per refused request: AVPlayer reports any HTTP error as a bare
 *  CoreMediaErrorDomain code, so this is the only place the reason shows. */
function logRefusal(versionId: number, status: number, req: Request, reason: string): void {
  console.warn(`[film-stream] ${versionId} → ${status} (range ${req.headers.get("range") ?? "none"}): ${reason}`);
}

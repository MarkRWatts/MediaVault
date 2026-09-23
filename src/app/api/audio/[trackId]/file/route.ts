// GET /api/audio/:trackId/file — a track's own bytes, byte-range aware, for
// a native client's AVFoundation player. Unlike /api/audio/:trackId (the
// in-browser player's raw PCM stream — see src/lib/audio-stream.ts), this
// serves the file exactly as it sits on disk: AVFoundation decodes AAC,
// ALAC, MP3 and FLAC natively and can start playing from a progressive
// HTTP source given range support, so there's no ffmpeg here and no
// audioSemaphore slot held — a phone listening costs this server a file
// read, nothing more (see IOS_PLAN.md "Audio: the original file, with
// ranges"). Cached hard: the response is immutable for a given track
// (mtimeMs would change if the file were re-ripped), so the client keys its
// own cache on that rather than re-fetching.

import { NextResponse } from "next/server";
import { TRANSCODE_BUSY, parseAudioQuality, resolveTrackFileForQuality } from "@/lib/audio-transcode";
import { serveFile } from "@/lib/serve-file";
import { requireMemberOrResponse } from "@/lib/require-member";

export async function GET(req: Request, ctx: { params: Promise<{ trackId: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { trackId: trackIdParam } = await ctx.params;
  const trackId = Number(trackIdParam);
  if (!Number.isInteger(trackId)) {
    return NextResponse.json({ error: "invalid track id" }, { status: 400 });
  }

  // ?quality=gapless — an MP3 decoded to ALAC, its encoder priming and
  // padding trimmed, so native players join tracks without a blip (see
  // audio-transcode.ts). Any other source goes out as the original.
  // ?quality=aac — a smaller copy of a lossless track for mobile data,
  // converted once and cached (src/lib/audio-transcode.ts). Anything
  // already lossy comes back as the original either way.
  const params = new URL(req.url).searchParams;
  const quality = parseAudioQuality(params.get("quality"));
  if (!quality) {
    return NextResponse.json({ error: "invalid quality" }, { status: 400 });
  }

  // &probe=1 — "is the smaller copy ready?", asked by a client about to
  // PLAY a track (not prefetch it). Answers at once with { ready } and, if
  // it isn't, starts the conversion in the background; the client then
  // streams quality=aac when ready and the original when not, so nobody
  // waits on ffmpeg to hear music. A probe rather than "serve whichever
  // exists": a player fetches one track in several range requests, and
  // they must all be answered from the same file.
  if (params.get("probe") === "1") {
    const probed = await resolveTrackFileForQuality(trackId, quality, { wait: false });
    if (probed === TRANSCODE_BUSY || !probed) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // Ready also when no conversion applies (an AAC or MP3 source).
    return NextResponse.json({ ready: quality === "original" || probed.transcoded || !probed.needsTranscode });
  }

  const file = await resolveTrackFileForQuality(trackId, quality);
  if (file === TRANSCODE_BUSY) {
    return NextResponse.json(
      { error: "too many tracks are being converted right now — try again shortly" },
      { status: 503, headers: { "Retry-After": "2" } },
    );
  }
  if (!file) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return serveFile(req, file.absPath, file.contentType, "private, max-age=31536000, immutable");
}

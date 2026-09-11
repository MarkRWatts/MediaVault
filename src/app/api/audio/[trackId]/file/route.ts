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
import { resolveTrackFile } from "@/lib/audio-stream";
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

  const file = await resolveTrackFile(trackId);
  if (!file) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return serveFile(req, file.absPath, file.contentType, "private, max-age=31536000, immutable");
}

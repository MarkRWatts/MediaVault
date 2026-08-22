// Serves track audio for the in-browser gapless album player, e.g.
// /api/audio/123. See src/lib/audio-stream.ts for the format decision
// (original bytes for mp3/aac, lossless FLAC remux for alac/flac) and the
// local-ffmpeg-vs-docker fallback. Unlike /api/cover, these responses are
// large and each one is only ever fetched once per playback session (the
// player never re-requests a track it already decoded) — so no caching:
// `Cache-Control: no-store`.

import { NextRequest, NextResponse } from "next/server";
import { getTrackAudio } from "@/lib/audio-stream";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ trackId: string }> }) {
  const { trackId: trackIdParam } = await ctx.params;
  const trackId = Number(trackIdParam);
  if (!Number.isInteger(trackId)) {
    return NextResponse.json({ error: "invalid track id" }, { status: 400 });
  }

  // ?fmt=wav — lossless PCM fallback for engines whose decodeAudioData
  // rejects FLAC (Safari); the player retries with this after a decode error.
  const wav = _req.nextUrl.searchParams.get("fmt") === "wav";
  const audio = await getTrackAudio(trackId, { wav });
  if (!audio) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return new NextResponse(audio.stream, {
    headers: {
      "Content-Type": audio.contentType,
      "Cache-Control": "no-store",
    },
  });
}

// Serves track audio for the in-browser gapless album player, e.g.
// /api/audio/123. See src/lib/audio-stream.ts for the format decision
// (original bytes for mp3/aac, lossless FLAC remux for alac/flac) and the
// local-ffmpeg-vs-docker fallback. Unlike /api/cover, these responses are
// large and each one is only ever fetched once per playback session (the
// player never re-requests a track it already decoded) — so no caching:
// `Cache-Control: no-store`.

import { NextRequest, NextResponse } from "next/server";
import { AUDIO_BUSY, getTrackAudio } from "@/lib/audio-stream";
import { requireMemberOrResponse } from "@/lib/require-member";
import { networkKind } from "@/lib/request-network";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ trackId: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { trackId: trackIdParam } = await ctx.params;
  const trackId = Number(trackIdParam);
  if (!Number.isInteger(trackId)) {
    return NextResponse.json({ error: "invalid track id" }, { status: 400 });
  }

  // ?fmt=wav — lossless PCM fallback for engines whose decodeAudioData
  // rejects FLAC (Safari); the player retries with this after a decode error.
  const wav = _req.nextUrl.searchParams.get("fmt") === "wav";
  // This request itself carries cf-connecting-ip/cf-ray when it arrived
  // through the tunnel (it's a real HTTP request through the same proxy
  // path as any other, not something the client has to hint at) — see
  // src/lib/audio-stream.ts's header comment for why off-LAN prefers a
  // small lossy remux over the full lossless one.
  const preferLossyRemote = networkKind(_req.headers) === "remote";
  const audio = await getTrackAudio(trackId, { wav, preferLossyRemote });
  if (audio === AUDIO_BUSY) {
    return NextResponse.json(
      { error: "too many tracks are being converted right now — try again shortly" },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
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

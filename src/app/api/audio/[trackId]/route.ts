// Serves track audio for the in-browser gapless player as a raw PCM stream,
// e.g. /api/audio/123?rate=48000. See src/lib/audio-stream.ts for the
// format (interleaved little-endian 16/24-bit samples straight from
// ffmpeg's stdout, no container) and why it's PCM rather than a smaller
// codec (playable from the first byte; nothing else the browser can decode
// progressively). The format travels in X-Audio-* response headers
// (src/lib/pcm-chunks.ts) since a raw stream can't describe itself. These
// responses are large and each one is only ever fetched once per playback
// session — so no caching: `Cache-Control: no-store`.

import { NextRequest, NextResponse } from "next/server";
import { AUDIO_BUSY, getTrackAudio } from "@/lib/audio-stream";
import { PCM_HEADERS } from "@/lib/pcm-chunks";
import { requireMemberOrResponse } from "@/lib/require-member";

export async function GET(req: NextRequest, ctx: { params: Promise<{ trackId: string }> }) {
  const gate = await requireMemberOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { trackId: trackIdParam } = await ctx.params;
  const trackId = Number(trackIdParam);
  if (!Number.isInteger(trackId)) {
    return NextResponse.json({ error: "invalid track id" }, { status: 400 });
  }

  // ?rate= — the client's AudioContext sample rate, so ffmpeg resamples
  // once (if at all) and the browser never has to. Validated against the
  // real device rates in audio-stream.ts; anything else means "file's own".
  const rateParam = req.nextUrl.searchParams.get("rate");
  const sampleRate = rateParam == null ? null : Number(rateParam);

  const audio = await getTrackAudio(trackId, { sampleRate });
  if (audio === AUDIO_BUSY) {
    return NextResponse.json(
      { error: "too many tracks are being decoded right now — try again shortly" },
      { status: 503, headers: { "Retry-After": "2" } },
    );
  }
  if (!audio) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    [PCM_HEADERS.sampleRate]: String(audio.format.sampleRate),
    [PCM_HEADERS.channels]: String(audio.format.channels),
    [PCM_HEADERS.bits]: String(audio.format.bits),
  };
  if (audio.estimatedBytes != null) headers[PCM_HEADERS.estimatedBytes] = String(audio.estimatedBytes);

  return new NextResponse(audio.stream, { headers });
}

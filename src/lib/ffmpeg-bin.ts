// Single place that resolves which ffmpeg/ffprobe binary every spawn/execFile
// call in this app runs — the scanner, the cover-art/PCM/AAC audio paths and
// the video cache all import from here rather than hard-coding "ffmpeg" or
// "ffprobe" themselves, so there's exactly one thing to repoint. Local dev
// (nothing set) keeps resolving both from $PATH, same as before this module
// existed. The Docker runner image sets FFMPEG_PATH/FFPROBE_PATH to the
// pinned jellyfin-ffmpeg binaries under /usr/lib/jellyfin-ffmpeg (see the
// Dockerfile and V4_PLAN.md "ffmpeg: jellyfin-ffmpeg, pinned") — everything
// downstream (the local-vs-Docker-fallback detection in ffprobe.ts,
// cover-art.ts, audio-stream.ts, audio-transcode.ts, video-cache.ts) just
// execs whatever these return, so it never needs to know which binary it got.

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

export function ffprobePath(): string {
  return process.env.FFPROBE_PATH || "ffprobe";
}

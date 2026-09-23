// Next calls register() once per server instance, before the first request
// is served (node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/instrumentation.md). The one thing this app needs
// from it is the periodic library sync, which is Node-only — it reaches
// Prisma, ffprobe and the filesystem, none of which exist in the Edge
// runtime — and which only arms a timer, so nothing here delays boot.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();

  // Gapless copies for any MP3 that lacks one — a couple of minutes in, so
  // a deploy's restart isn't also when ffmpeg starts working. Cheap once
  // they all exist: a stat per MP3.
  if (process.env.NODE_ENV === "production") {
    setTimeout(() => {
      void import("@/lib/gapless-copies")
        .then(({ ensureGaplessCopies }) => ensureGaplessCopies())
        .catch((err) => console.error("[gapless-copies] failed:", err));
    }, 2 * 60 * 1000);
  }
}

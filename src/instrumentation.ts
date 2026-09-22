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
}

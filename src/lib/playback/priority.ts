// Child-process niceness shared by everything the engine spawns that isn't
// latency-critical: transcoding heads (head.ts) and the interlace probe
// (interlace.ts) alike. Both run on the same box as the web app -- a request
// for a page must never queue behind either kind of ffmpeg child.

import os from "node:os";

/** Nice value for a spawned ffmpeg. Settled by head.ts's own measurement: a
 *  copy-tier head briefly takes both of a 2-vCPU VM's cores, and nothing
 *  about a background ffmpeg is worth contending with the app for a
 *  scheduling slot. */
export const CHILD_NICE = 10;

/** Lowering one's own child's priority needs no privilege; failing to (an
 *  exotic platform, a pid already gone) is not worth failing a play for. */
export function lowerPriority(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    os.setPriority(pid, CHILD_NICE);
  } catch {
    /* best effort */
  }
}

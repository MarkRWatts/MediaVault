// Every MP3 in the library gets its gapless ALAC copy ahead of time (see
// the header of src/lib/audio-transcode.ts). Made on demand only, a copy
// doesn't exist the first time a track is heard, so the apps stream the
// MP3 that once — and that first listen is exactly the one with the blip.
//
// Runs after each periodic sync (new albums) and shortly after boot (a
// first deploy, or copies made before they had a folder of their own).
// One ffmpeg at a time, through the same semaphore as on-demand work, so a
// listener asking for a copy is never queued behind the whole library.

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import {
  audioCacheDir,
  gaplessDir,
  resolveTrackFileForQuality,
  transcodeFileName,
  TRANSCODE_BUSY,
} from "@/lib/audio-transcode";
import { resolveTrackPath } from "@/lib/audio-stream";

const BUSY_RETRY_MS = 5_000;

let running: Promise<void> | null = null;

/** Make any missing gapless copies; drop copies whose track is gone. */
export function ensureGaplessCopies(): Promise<void> {
  running ??= run().finally(() => {
    running = null;
  });
  return running;
}

async function run(): Promise<void> {
  const started = Date.now();
  const tracks = await prisma.track.findMany({
    where: { codec: { in: ["mp3", "MP3"] } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const dir = gaplessDir();
  await fs.mkdir(dir, { recursive: true });
  const present = new Set(await fs.readdir(dir));
  let made = 0;
  let moved = 0;
  let failed = 0;

  for (const { id } of tracks) {
    const resolved = await resolveTrackPath(id);
    if (!resolved) continue;
    const stat = await fs.stat(resolved.absPath).catch(() => null);
    if (!stat) continue;
    const name = transcodeFileName(id, stat.mtimeMs, "gapless");
    if (present.has(name)) continue;

    // Made before gapless copies had a folder of their own.
    const inCache = path.join(audioCacheDir(), name);
    if (await fs.rename(inCache, path.join(dir, name)).then(() => true, () => false)) {
      moved++;
      continue;
    }

    for (;;) {
      const result = await resolveTrackFileForQuality(id, "gapless", { wait: true });
      if (result === TRANSCODE_BUSY) {
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
        continue;
      }
      if (result?.transcoded) made++;
      else failed++;
      break;
    }
  }

  // Tracks no longer in the library. Decided by the database, never by
  // whether a file could be read just now: an unmounted share must not
  // cost every copy. (A re-rip's old copy goes when its new one is made.)
  const trackIds = new Set(tracks.map((t) => String(t.id)));
  let removed = 0;
  for (const n of await fs.readdir(dir)) {
    if (n.endsWith("-alac.m4a") && !trackIds.has(n.split("-")[0])) {
      await fs.rm(path.join(dir, n), { force: true });
      removed++;
    }
  }

  if (made || moved || failed || removed) {
    console.log(
      `[gapless-copies] ${tracks.length} MP3s: ${made} made, ${moved} moved from the cache, ${removed} removed, ${failed} failed, in ${Math.round((Date.now() - started) / 1000)}s`,
    );
  }
}

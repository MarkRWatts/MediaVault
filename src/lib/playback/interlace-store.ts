// Cache for InterlaceCheck (V4_PLAN.md, "Session-time probe" -- measured
// interlace detection): the same shape as keyframe-store.ts, because the
// question it answers is cached exactly the same way -- a per-file fact,
// keyed by (kind, fileId) and invalidated by mtime/size, that cost a real
// ffmpeg run to produce and must never be recomputed for an unchanged file.
// Unlike a keyframe list there is nothing to pack: the row is two small
// integers, so a plain Int column each is simpler than inventing a binary
// shape for two numbers.

import { prisma } from "@/lib/db";
import type { MediaKind } from "./types";

export interface InterlaceCacheKey {
  mtimeMs: number;
  sizeBytes: bigint;
}

/** What one measurement (interlace.ts's measureInterlace) produced:
 *  sampledFrames = tff + bff + progressive across every window (undetermined
 *  frames are excluded, not evidence either way); interlacedFrames = tff +
 *  bff. */
export interface InterlaceCheckData {
  sampledFrames: number;
  interlacedFrames: number;
}

/**
 * Load a cached measurement, or null when there is none or it's stale (the
 * source file's mtime/size have moved on since it was measured -- the same
 * cache-key shape keyframe-store.ts and the scanner's probe cache already
 * use).
 */
export async function loadInterlaceCheck(
  kind: MediaKind,
  fileId: number,
  current: InterlaceCacheKey,
): Promise<InterlaceCheckData | null> {
  const row = await prisma.interlaceCheck.findUnique({ where: { kind_fileId: { kind, fileId } } });
  if (!row) return null;
  if (row.mtimeMs !== current.mtimeMs || row.sizeBytes !== current.sizeBytes) return null;
  return { sampledFrames: row.sampledFrames, interlacedFrames: row.interlacedFrames };
}

/** Upsert the cached measurement for (kind, fileId). */
export async function saveInterlaceCheck(
  kind: MediaKind,
  fileId: number,
  current: InterlaceCacheKey,
  data: InterlaceCheckData,
): Promise<void> {
  await prisma.interlaceCheck.upsert({
    where: { kind_fileId: { kind, fileId } },
    create: {
      kind,
      fileId,
      mtimeMs: current.mtimeMs,
      sizeBytes: current.sizeBytes,
      sampledFrames: data.sampledFrames,
      interlacedFrames: data.interlacedFrames,
    },
    update: {
      mtimeMs: current.mtimeMs,
      sizeBytes: current.sizeBytes,
      sampledFrames: data.sampledFrames,
      interlacedFrames: data.interlacedFrames,
    },
  });
}

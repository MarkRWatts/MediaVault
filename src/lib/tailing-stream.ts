// A Readable that follows a growing file instead of stopping at whatever
// EOF happens to be there when it's opened -- the read half of the
// stream-while-caching fix (see video-cache.ts): ffmpeg is still writing the
// file when playback starts, so hitting "no more bytes yet" has to mean
// "wait for more", not "end of stream", until the caller says the write is
// actually done (or has failed).
//
// Only works because the ffmpeg output is fragmented MP4 (frag_keyframe+
// empty_moov, see video-playback.ts) -- a plain +faststart file's index
// isn't written until the whole thing is, so a partial read of one is never
// valid to hand to a player. Fragmented output is a minimal moov followed by
// self-contained moof+mdat fragments, so whatever prefix of the file exists
// at any moment is already something a player can start decoding.

import { Readable } from "node:stream";
import { open, type FileHandle } from "node:fs/promises";

export interface TailOptions {
  /** Byte offset to start reading from (0 for a fresh play). */
  start?: number;
  /** True once the source is finished and this read position is a real EOF. */
  isDone: () => Promise<boolean> | boolean;
  /** Non-null once the write has failed -- ends the stream with that error. */
  hasErrored: () => string | null;
  /** How long to wait before checking for more bytes after hitting EOF. */
  pollIntervalMs?: number;
  chunkSize?: number;
}

export function createTailingStream(path: string, opts: TailOptions): Readable {
  let position = opts.start ?? 0;
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const chunkSize = opts.chunkSize ?? 64 * 1024;

  let fileHandle: FileHandle | null = null;
  let destroyed = false;
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  const stream = new Readable({
    read() {
      pump(this);
    },
    async destroy(err, callback) {
      destroyed = true;
      if (pendingTimeout) clearTimeout(pendingTimeout);
      if (fileHandle) await fileHandle.close().catch(() => {});
      callback(err);
    },
  });

  async function pump(self: Readable): Promise<void> {
    if (destroyed) return;
    try {
      if (!fileHandle) fileHandle = await open(path, "r");

      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, position);
      if (destroyed) return;

      if (bytesRead > 0) {
        position += bytesRead;
        self.push(buffer.subarray(0, bytesRead));
        return;
      }

      // No bytes available right now -- figure out why before deciding
      // whether that's "done" or "not yet".
      const error = opts.hasErrored();
      if (error) {
        self.destroy(new Error(error));
        return;
      }
      if (await opts.isDone()) {
        self.push(null);
        return;
      }
      pendingTimeout = setTimeout(() => pump(self), pollIntervalMs);
    } catch (err) {
      if (!destroyed) self.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return stream;
}

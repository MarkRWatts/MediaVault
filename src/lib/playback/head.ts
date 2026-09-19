// A *head*: one ffmpeg process writing consecutive segments into a stream
// key's directory from segment N onward (V4_PLAN.md, "Heads"). This module
// owns the process -- spawning it, reading its completion stream, promoting
// finished segments, pausing and killing it -- and nothing else. What to
// start, when to stop and who is waiting is engine.ts's business; the
// argument list is head-args.ts's.
//
// ## Why a staging directory
//
// The segment muxer cannot rename a file on close, so a head writes into
// `<key>/.part-<headId>/` and the completed file is renamed into `<key>/`
// only once ffmpeg says it is done (head-args.ts's "segment-completion
// contract": one CSV line on stdout per closed segment). A reader therefore
// never sees a partially written segment, and two heads on the same key --
// one from a viewer who seeked, one from a viewer who didn't -- can't
// scribble over each other, because each owns its own staging directory and
// a rename onto an existing target is dropped rather than performed.
//
// Dropping rather than overwriting matters: segments are deterministic per
// key (same source, same table, same arguments), so the existing file and
// the staged one are the same bytes. Overwriting would briefly unlink a file
// an HTTP response may already be streaming.
//
// ## The last segment
//
// Verified against ffmpeg 9.0.2 (Homebrew, 19 Sep 2026): a head that reaches
// EOF *does* print the final segment's CSV line, newline-terminated, before
// exiting -- the list is flushed when each file closes, and the last file
// closes as the trailer is written. The clean-exit sweep below is therefore
// a backstop rather than the mechanism; it costs one readdir and means a
// build that buffers that last line differently cannot silently lose the
// final segment of every film. It runs only on a clean exit: after a kill
// the staging directory's newest file is the segment ffmpeg was midway
// through, which is exactly what must not be promoted.

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, rmSync } from "node:fs";
import path from "node:path";
import { ffmpegPath } from "@/lib/ffmpeg-bin";
import { PlaybackError } from "./source";
import { parseSegmentFileName, segmentFileName } from "./stream-key";
import { PART_DIR_PREFIX } from "./stream";
import type { StreamTier } from "./decisions";
import type { HwAccel } from "./types";

/** How long a killed head is given to write its trailer and exit before
 *  SIGKILL. ffmpeg's SIGTERM handler closes the current output and returns
 *  in milliseconds; a second and a half is only for a process wedged on a
 *  stalled share read, which no amount of waiting will rescue. */
export const HEAD_KILL_GRACE_MS = 1_500;

/** How much of ffmpeg's stderr is kept for an error report. With `-loglevel
 *  error` (head-args.ts) this is real diagnostics, not progress noise. */
const STDERR_TAIL_BYTES = 4_000;

export interface SegmentListLine {
  name: string;
  startSecs: number;
  endSecs: number;
}

/**
 * One line of `-segment_list_type csv -segment_list_flags live` output:
 * `seg_00042.ts,252.000000,258.000000`. The first field is taken as a
 * *basename* -- ffmpeg writes the entry relative to wherever the list itself
 * lives, which for `pipe:1` is nowhere in particular, so a build that
 * printed the full output path instead must not be read as a path to follow.
 * Anything that isn't a well-formed segment name is rejected rather than
 * repaired: this name goes on to address a file.
 */
export function parseSegmentListLine(line: string): SegmentListLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const fields = trimmed.split(",");
  if (fields.length < 3) return null;
  const name = path.basename(fields[0]);
  if (parseSegmentFileName(name) === null) return null;
  const startSecs = Number(fields[1]);
  const endSecs = Number(fields[2]);
  if (!Number.isFinite(startSecs) || !Number.isFinite(endSecs)) return null;
  return { name, startSecs, endSecs };
}

export type HeadStopReason = "caught-up" | "finished" | "stopped" | "idle" | "replaced" | "shutdown" | "failed";

export interface HeadOptions {
  key: string;
  /** The stream key's real directory; segments are renamed into it. */
  dir: string;
  sessionId: string;
  startIndex: number;
  tier: StreamTier;
  hwaccel: HwAccel;
  /** Built once the staging directory is known (head-args.ts's `outDir`). */
  buildArgs: (stagingDir: string) => string[];
  /** Called after a segment has been renamed into `dir`, before any waiter
   *  for it is resolved -- the engine's chance to record it and write the
   *  `.complete` marker. */
  onSegment: (index: number) => Promise<void>;
  /** Consulted with the index the head is about to write: true stops it
   *  (decisions.ts's isHeadCaughtUp). */
  shouldStop: (nextIndex: number) => boolean;
}

let headCounter = 0;

/**
 * One live ffmpeg process. Construct with `startHead` -- the constructor
 * spawns, so a Head object always corresponds to a real child (or one that
 * has since exited).
 */
export class Head {
  readonly headId: string;
  readonly sessionId: string;
  readonly startIndex: number;
  readonly key: string;
  /** The segment index the head is about to write: its start index until it
   *  has finished anything, then one past the last promoted segment. This is
   *  the `nextIndex` decisions.ts reasons about. */
  nextIndex: number;
  paused = false;
  segmentsWritten = 0;

  private readonly opts: HeadOptions;
  private readonly stagingDir: string;
  private readonly child: ChildProcess;
  private readonly startedAt = Date.now();
  private readonly waiters: { index: number; resolve: () => void; reject: (err: Error) => void }[] = [];
  private stdoutBuffer = "";
  private stderrTail = "";
  /** Set before a deliberate kill so the non-zero exit that follows reads as
   *  a stop rather than a failure -- the same trick video-cache.ts plays
   *  with `cancelledJobs`. */
  private stopping: HeadStopReason | null = null;
  private renameChain: Promise<void> = Promise.resolve();
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private exitResolve!: () => void;
  readonly exited: Promise<void>;
  private failure: Error | null = null;

  constructor(opts: HeadOptions, stagingDir: string) {
    this.opts = opts;
    this.key = opts.key;
    this.sessionId = opts.sessionId;
    this.startIndex = opts.startIndex;
    this.nextIndex = opts.startIndex;
    this.headId = `h${(++headCounter).toString(36)}${Date.now().toString(36).slice(-4)}`;
    this.stagingDir = stagingDir;
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve;
    });

    const args = opts.buildArgs(stagingDir);
    this.child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.child.on("error", (err) => this.onExit(null, err));
    this.child.on("close", (code) => this.onExit(code, null));

    console.log(
      `[playback] head start ${opts.key} at ${opts.startIndex} (${opts.tier}, hw=${opts.hwaccel}, ${this.headId})`,
    );
  }

  get running(): boolean {
    return this.stopping === null && this.child.exitCode === null && !this.child.killed;
  }

  /** The staging directory, so a shutdown can remove it synchronously. */
  get staging(): string {
    return this.stagingDir;
  }

  // -- stdout: the completion stream ---------------------------------------

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    // Only whole lines are acted on: a half-received line names a file that
    // may not be closed yet.
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      const parsed = parseSegmentListLine(line);
      if (parsed) this.queuePromotion(parsed.name);
    }
  }

  /** Renames are chained rather than run concurrently so `nextIndex`, the
   *  `.complete` marker and the waiter wake-ups stay in segment order. */
  private queuePromotion(name: string): void {
    this.renameChain = this.renameChain.then(() => this.promote(name)).catch(() => {});
  }

  private async promote(name: string): Promise<void> {
    const index = parseSegmentFileName(name);
    if (index === null) return;
    const staged = path.join(this.stagingDir, name);
    const target = path.join(this.opts.dir, segmentFileName(index));
    try {
      await fs.rename(staged, target);
    } catch (err) {
      // EEXIST can't happen on POSIX rename (it replaces), so a failure here
      // is a vanished staging file or a full disk. Either way this segment
      // is not available; leave it for a later head rather than pretending.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[playback] ${this.key}: could not promote ${name}:`, err);
      }
      return;
    }
    this.segmentsWritten++;
    this.nextIndex = index + 1;
    await this.opts.onSegment(index);
    this.wake(index);

    if (this.opts.shouldStop(this.nextIndex)) {
      void this.stop(this.nextIndex >= 0 ? "caught-up" : "finished");
    }
  }

  /** A head that overwrote nothing still has to answer the request that
   *  started it: resolve every waiter at or below the promoted index. */
  private wake(index: number): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].index <= index) {
        this.waiters.splice(i, 1)[0].resolve();
      }
    }
  }

  // -- waiting --------------------------------------------------------------

  /**
   * Resolves when this head has promoted `index`, or when it exits without
   * having done so -- the caller then re-checks the disk and, if the segment
   * still isn't there, makes a fresh decision. Rejects when the head failed
   * (with ffmpeg's own words), when `deadline` passes, or when the request
   * is aborted.
   */
  waitFor(index: number, deadlineMs: number, signal?: AbortSignal): Promise<void> {
    if (this.nextIndex > index) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    if (!this.running && this.stopping === null) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const entry = { index, resolve: () => finish(resolve), reject: (err: Error) => finish(() => reject(err)) };
      const timer = setTimeout(
        () => entry.reject(new PlaybackError("timeout", `timed out waiting for segment ${index} of ${this.key}`)),
        Math.max(0, deadlineMs - Date.now()),
      );
      const onAbort = () => entry.reject(new PlaybackError("timeout", "the request was aborted"));
      const finish = (done: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const at = this.waiters.indexOf(entry);
        if (at >= 0) this.waiters.splice(at, 1);
        done();
      };
      if (signal?.aborted) {
        entry.reject(new PlaybackError("timeout", "the request was aborted"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(entry);
    });
  }

  // -- throttle -------------------------------------------------------------

  /** SIGSTOP. The head keeps its file handles, its position in the source
   *  and its staging directory; it simply stops consuming CPU and share
   *  bandwidth until the viewer catches up (V4_PLAN.md, "Housekeeping"). */
  pause(): void {
    if (this.paused || !this.running) return;
    this.paused = true;
    this.signal("SIGSTOP");
    console.log(`[playback] head throttle ${this.key} paused at ${this.nextIndex} (${this.headId})`);
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.signal("SIGCONT");
    console.log(`[playback] head throttle ${this.key} resumed at ${this.nextIndex} (${this.headId})`);
  }

  private signal(sig: NodeJS.Signals): void {
    try {
      this.child.kill(sig);
    } catch {
      // Already gone.
    }
  }

  // -- stopping -------------------------------------------------------------

  /**
   * Kill the head and wait for it to go. SIGCONT first, unconditionally: a
   * throttled head is SIGSTOPped, and a stopped process never runs its
   * SIGTERM handler -- it would sit in the process table until the SIGKILL
   * below, turning every "stop now" into a grace-period wait.
   */
  async stop(reason: HeadStopReason): Promise<void> {
    if (this.stopping === null && this.child.exitCode === null) {
      this.stopping = reason;
      this.signal("SIGCONT");
      this.signal("SIGTERM");
      this.killTimer = setTimeout(() => this.signal("SIGKILL"), HEAD_KILL_GRACE_MS);
    } else if (this.stopping === null) {
      this.stopping = reason;
    }
    await this.exited;
  }

  /** Shutdown path: no awaiting, no promises -- the process is about to
   *  die and anything asynchronous simply won't happen (shutdown.ts). */
  killNow(): void {
    this.stopping = "shutdown";
    this.signal("SIGCONT");
    this.signal("SIGKILL");
    try {
      rmSync(this.stagingDir, { recursive: true, force: true });
    } catch {
      // Best effort; the next process's startup sweep catches it.
    }
  }

  private onExit(code: number | null, spawnError: Error | null): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    const reason: HeadStopReason = this.stopping ?? (spawnError || (code !== 0 && code !== null) ? "failed" : "finished");
    const deliberate = this.stopping !== null;

    // Everything after the exit is asynchronous (the last renames may still
    // be in flight), so the bookkeeping is chained behind them.
    this.renameChain = this.renameChain
      .then(async () => {
        if (!deliberate && code === 0) await this.sweepStaging();
        await fs.rm(this.stagingDir, { recursive: true, force: true }).catch(() => {});

        const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
        console.log(
          `[playback] head stop ${this.key} (${reason}): ${this.segmentsWritten} segments in ${secs}s (${this.headId})`,
        );

        if (!deliberate && reason === "failed") {
          const detail = (spawnError?.message ?? this.stderrTail).trim().split("\n").filter(Boolean).slice(-3).join(" ");
          console.error(`[playback] head ${this.key} failed (exit ${code}): ${detail || "no output"}`);
          this.failure = new PlaybackError("head-failed", detail || `ffmpeg exited ${code}`);
          for (const w of this.waiters.splice(0)) w.reject(this.failure);
          return;
        }
        // A clean stop is not an error: whoever was waiting re-checks the
        // disk and decides again.
        for (const w of this.waiters.splice(0)) w.resolve();
      })
      .catch(() => {})
      .finally(() => this.exitResolve());
  }

  /**
   * Backstop for a clean exit (see the file header): promote anything left
   * in the staging directory that never produced a CSV line. Safe only here
   * -- after a kill the newest staged file is a half-written segment.
   */
  private async sweepStaging(): Promise<void> {
    const names = await fs.readdir(this.stagingDir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (parseSegmentFileName(name) === null) continue;
      await this.promote(name);
    }
  }
}

/** Create the staging directory and spawn the head. */
export async function startHead(opts: HeadOptions): Promise<Head> {
  const stagingDir = path.join(opts.dir, `${PART_DIR_PREFIX}${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(stagingDir, { recursive: true });
  return new Head(opts, stagingDir);
}

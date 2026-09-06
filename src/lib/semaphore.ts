// A counting semaphore for the ffmpeg work an authenticated member can start
// on demand (src/lib/video-cache.ts prepares, src/lib/audio-stream.ts
// remuxes). Without one, every Play/album-track click spawned another
// encoder — N members (or one member with a script) could pin the VM's CPU
// and fill its disk. Process-local, like the job maps it protects.

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    public readonly limit: number,
    /** How many callers may wait for a slot before acquire() refuses. */
    public readonly maxQueue: number = Number.POSITIVE_INFINITY,
  ) {}

  /** Take a slot now if one is free; null if not (no waiting). */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active++;
    return this.releaser();
  }

  /** Wait for a slot. Rejects immediately if the queue is already full. */
  acquire(): Promise<() => void> {
    const now = this.tryAcquire();
    if (now) return Promise.resolve(now);
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new SemaphoreFullError());
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve(this.releaser());
      });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent — a stream can fire close AND error
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  get inUse(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }
}

export class SemaphoreFullError extends Error {
  constructor() {
    super("Too many jobs of this kind are already running — try again in a minute.");
    this.name = "SemaphoreFullError";
  }
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Module-level singletons, parked on globalThis so a dev hot-reload doesn't
// mint a second, unaware set.
const g = globalThis as unknown as { __mvSemaphores?: Record<string, Semaphore> };
const registry = (g.__mvSemaphores ??= {});

/** Concurrent HLS prepare jobs (each is a whole-file ffmpeg run); more than
 *  this many pending requests are refused outright rather than queued
 *  forever. PREPARE_CONCURRENCY / PREPARE_QUEUE override. */
export function prepareSemaphore(): Semaphore {
  return (registry.prepare ??= new Semaphore(envInt("PREPARE_CONCURRENCY", 2), envInt("PREPARE_QUEUE", 6)));
}

/** Concurrent on-the-fly audio remuxes (FLAC/WAV for the album player).
 *  Never queued: the route answers 503 and the player retries. */
export function audioSemaphore(): Semaphore {
  return (registry.audio ??= new Semaphore(envInt("AUDIO_CONCURRENCY", 4), 0));
}

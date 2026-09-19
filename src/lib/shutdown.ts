// One place that owns this process's SIGTERM/SIGINT listeners, so the two
// things that spawn long-running ffmpeg children -- the old event-playlist
// pipeline (video-cache.ts) and the v4 playback engine
// (playback/engine.ts) -- each get their own "stop everything you started"
// callback without either registering a second pair of process listeners.
//
// Prepended (process.prependListener) for the same reason video-cache.ts
// always did it: Next's own handler may call process.exit in the same tick,
// so anything that has to run synchronously before the process dies has to
// be ahead of it in the listener list. Registration is lazy and one-shot --
// the first onShutdown() call installs the pair, every later one just adds
// to the callback list.
//
// Callbacks must be SYNCHRONOUS. There is no time for a promise to settle
// between the signal and exit; anything async here silently doesn't happen.

type ShutdownCallback = () => void;

const callbacks = new Set<ShutdownCallback>();
let installed = false;

function runAll(): void {
  for (const cb of callbacks) {
    try {
      cb();
    } catch {
      // One module's cleanup failing must not stop another's.
    }
  }
}

/** Register a synchronous cleanup callback for SIGTERM/SIGINT. Returns an
 *  unregister function (tests; nothing in the app needs it). */
export function onShutdown(cb: ShutdownCallback): () => void {
  callbacks.add(cb);
  if (!installed) {
    installed = true;
    process.prependListener("SIGTERM", runAll);
    process.prependListener("SIGINT", runAll);
  }
  return () => callbacks.delete(cb);
}

/** Tests only: run every registered callback as a signal would. */
export function runShutdownCallbacksForTest(): void {
  runAll();
}

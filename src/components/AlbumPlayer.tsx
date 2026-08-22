"use client";

// Gapless album player for /music/album/[id]. Web Audio API, not
// <audio>/MSE — a plain <audio> element re-buffers and re-decodes at every
// track boundary (an audible gap even for back-to-back files), where
// scheduling pre-decoded AudioBufferSourceNodes at exact sample-accurate
// AudioContext times gives a true gapless join. See PLAN.md "Future:
// playback" for why this exists and src/lib/audio-stream.ts for what
// /api/audio/<id> actually serves (original bytes for mp3/aac, a lossless
// FLAC remux for alac/flac).
//
// Scheduling model: every track's playback is described by an anchor
// { startAt, duration } in scheduleRef, keyed by track index — startAt is
// an absolute AudioContext.currentTime coordinate, duration is the
// *decoded* buffer's real duration (not the DB's durationSecs estimate,
// which is what makes the join sample-accurate). prefetch(), once its
// fetch+decode resolves, chains itself onto whatever anchor its immediate
// predecessor left behind in scheduleRef (predecessor.startAt +
// predecessor.duration) — that chaining is the gapless engine. A track that
// fails to load leaves a zero-duration passthrough anchor instead of a real
// one, so the chain still advances past it (console.warn'd) rather than
// stalling.
//
// Prefetch pacing is driven by PLAYBACK, not by decode completion:
// scheduleAt(idx) only kicks off prefetch(idx + 1) when idx is the track
// playing right now, and handleTrackEnded triggers the next prefetch as
// playback advances. Without that gate the schedule→decode→schedule cascade
// races through the whole album in seconds (observed: a 6-track EP fully
// fetched immediately), holding every decoded AudioBuffer at once — ~1.5 GB
// of PCM for a 20-track album. With it, at most two decoded buffers are
// alive (current + next; each track's multi-minute runtime is ample decode
// headroom for the following join), and buffersRef is pruned down to the
// current index as soon as the UI advances past a track.

import { useEffect, useMemo, useRef, useState } from "react";

export interface AlbumPlayerTrack {
  id: number;
  title: string;
  codec: string | null;
  durationSecs: number | null;
  disc: number;
  trackNumber: number | null;
}

type Status = "idle" | "loading" | "playing" | "paused";

interface ScheduleInfo {
  startAt: number;
  duration: number;
}

// Lead-in for the very first scheduled start of a session — starting
// exactly at ctx.currentTime can race the audio hardware clock on some
// browsers and clip the first few samples.
const START_EPSILON = 0.05;

// Plain glyphs (⏮ ⏸ ▶ ⏭) render inconsistently across platforms — mobile
// browsers pull them from the system emoji font (colorful, differently
// shaped) while desktop renders the plain text-symbol form. SVGs sidestep
// that entirely, matching the pattern used elsewhere (see VersionCard).
function PreviousIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5z" />
    </svg>
  );
}

function formatTime(secs: number): string {
  const clamped = Number.isFinite(secs) && secs > 0 ? secs : 0;
  const total = Math.floor(clamped);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// decodeAudioData has a promise-returning form (every current browser
// engine) and an older callback form (pre-2021 Safari); support both.
function decodeAudioData(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(data, resolve, reject) as unknown;
    if (maybePromise && typeof (maybePromise as Promise<AudioBuffer>).then === "function") {
      (maybePromise as Promise<AudioBuffer>).then(resolve, reject);
    }
  });
}

export default function AlbumPlayer({
  albumTitle,
  artistName,
  tracks: rawTracks,
}: {
  albumTitle: string;
  artistName: string;
  tracks: AlbumPlayerTrack[];
}) {
  // Defensive filter — the call site is expected to already exclude DRM
  // tracks, but a player that can be handed a "drm" track shouldn't try.
  const tracks = useMemo(() => rawTracks.filter((t) => t.codec !== "drm"), [rawTracks]);

  const [status, setStatus] = useState<Status>("idle");
  const [index, setIndex] = useState(0);
  const [duration, setDuration] = useState<number | null>(tracks[0]?.durationSecs ?? null);

  const ctxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef(new Map<number, AudioBuffer>());
  const sourcesRef = useRef(new Map<number, AudioBufferSourceNode>());
  const scheduleRef = useRef(new Map<number, ScheduleInfo>());
  const pendingRef = useRef(new Set<number>());
  const sessionRef = useRef(0);
  const currentIndexRef = useRef(0);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const elapsedTextRef = useRef<HTMLSpanElement | null>(null);

  function ensureAudioContext(): AudioContext {
    if (!ctxRef.current) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    return ctxRef.current;
  }

  function stopAllSources() {
    for (const source of sourcesRef.current.values()) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped/never started — fine to ignore.
      }
      try {
        source.disconnect();
      } catch {
        // Ignore.
      }
    }
    sourcesRef.current.clear();
  }

  function releaseBuffersBefore(keepFromIndex: number) {
    for (const idx of buffersRef.current.keys()) {
      if (idx < keepFromIndex) buffersRef.current.delete(idx);
    }
  }

  function scheduleAt(idx: number, startAt: number, session: number) {
    const ctx = ctxRef.current;
    const buffer = buffersRef.current.get(idx);
    if (!ctx || !buffer || session !== sessionRef.current) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    // A `when` in the past is clamped to "now" by the Web Audio spec — the
    // relevant case here is a slow prefetch chaining onto an anchor that
    // has already elapsed, which just starts immediately instead of erroring.
    source.start(Math.max(startAt, ctx.currentTime));
    sourcesRef.current.set(idx, source);
    scheduleRef.current.set(idx, { startAt, duration: buffer.duration });

    source.onended = () => handleTrackEnded(idx, session);

    if (idx === currentIndexRef.current) {
      setDuration(buffer.duration);
      setStatus("playing");
    }

    // Only the currently-playing track pulls in its successor — a track
    // scheduled for the future must NOT (see the pacing note in the header
    // comment; handleTrackEnded advances the chain when playback reaches it).
    if (idx <= currentIndexRef.current) prefetch(idx + 1, session);
  }

  function prefetch(idx: number, session: number) {
    if (idx < 0 || idx >= tracks.length) return;
    if (buffersRef.current.has(idx) || pendingRef.current.has(idx)) return;
    const ctx = ctxRef.current;
    if (!ctx) return;

    pendingRef.current.add(idx);
    // FLAC first (smaller over the wire); if THIS engine can't decode FLAC
    // (Safari's decodeAudioData rejects it, with a null error no less),
    // retry once as lossless WAV before giving up on the track.
    const loadAndDecode = (url: string) =>
      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((data) => decodeAudioData(ctx, data));
    loadAndDecode(`/api/audio/${tracks[idx].id}`)
      .catch(() => loadAndDecode(`/api/audio/${tracks[idx].id}?fmt=wav`))
      .then((buffer) => {
        pendingRef.current.delete(idx);
        if (session !== sessionRef.current) return;
        buffersRef.current.set(idx, buffer);
        maybeChain(idx, session);
      })
      .catch((err) => {
        pendingRef.current.delete(idx);
        console.warn(`[AlbumPlayer] skipping "${tracks[idx]?.title}" — failed to load:`, err);
        if (session !== sessionRef.current) return;
        // Leave a zero-duration passthrough anchor so the chain can still
        // advance past this broken track instead of stalling forever.
        const prev = scheduleRef.current.get(idx - 1) ?? {
          startAt: ctx.currentTime + START_EPSILON,
          duration: 0,
        };
        scheduleRef.current.set(idx, prev);
        prefetch(idx + 1, session);
      });
  }

  // Chain a freshly-decoded buffer onto its predecessor's anchor, if the
  // predecessor has already been (or was just) scheduled and this index
  // hasn't been claimed yet. By construction (every scheduleAt/seed writes
  // scheduleRef[idx] before calling prefetch(idx + 1)), the predecessor
  // entry is always present by the time this runs.
  function maybeChain(idx: number, session: number) {
    if (scheduleRef.current.has(idx)) return;
    const prev = scheduleRef.current.get(idx - 1);
    if (!prev) return;
    scheduleAt(idx, prev.startAt + prev.duration, session);
  }

  function handleTrackEnded(idx: number, session: number) {
    if (session !== sessionRef.current) return;
    sourcesRef.current.delete(idx);

    const nextIdx = idx + 1;
    if (nextIdx >= tracks.length) {
      onAlbumEnded();
      return;
    }

    currentIndexRef.current = nextIdx;
    setIndex(nextIdx);
    releaseBuffersBefore(nextIdx);
    // Playback reached nextIdx (already scheduled & decoded) — now, and only
    // now, pull in the track after it.
    prefetch(nextIdx + 1, session);

    const info = scheduleRef.current.get(nextIdx);
    if (info) {
      setDuration(info.duration);
      setStatus("playing");
    } else {
      // Prefetch for nextIdx hasn't resolved yet — scheduleAt will flip this
      // back to "playing" (and set the real duration) once it does.
      setDuration(tracks[nextIdx]?.durationSecs ?? null);
      setStatus("loading");
    }
  }

  function onAlbumEnded() {
    sessionRef.current++; // invalidate any straggling prefetches
    stopAllSources();
    scheduleRef.current.clear();
    buffersRef.current.clear();
    pendingRef.current.clear();
    currentIndexRef.current = 0;
    setIndex(0);
    setStatus("idle");
    setDuration(tracks[0]?.durationSecs ?? null);
    if (fillRef.current) fillRef.current.style.width = "0%";
    if (elapsedTextRef.current) elapsedTextRef.current.textContent = formatTime(0);
  }

  // Reset the engine and begin playback at `idx` — used for the initial
  // Play, and for Next/Previous. Seeds a zero-duration anchor at
  // scheduleRef[idx - 1] so prefetch/maybeChain's normal chaining logic can
  // bootstrap a fresh start exactly like it recovers from a failed track.
  function startFrom(idx: number) {
    const ctx = ensureAudioContext();
    if (ctx.state === "suspended") ctx.resume();

    const session = ++sessionRef.current;
    stopAllSources();
    scheduleRef.current.clear();
    buffersRef.current.clear();
    pendingRef.current.clear();

    currentIndexRef.current = idx;
    setIndex(idx);
    setStatus("loading");
    setDuration(tracks[idx]?.durationSecs ?? null);
    if (fillRef.current) fillRef.current.style.width = "0%";
    if (elapsedTextRef.current) elapsedTextRef.current.textContent = formatTime(0);

    scheduleRef.current.set(idx - 1, { startAt: ctx.currentTime + START_EPSILON, duration: 0 });
    prefetch(idx, session);
  }

  function handlePlayPause() {
    const ctx = ctxRef.current;
    if (!ctx || status === "idle") {
      startFrom(0);
      return;
    }
    if (status === "playing" || status === "loading") {
      ctx.suspend();
      setStatus("paused");
    } else if (status === "paused") {
      ctx.resume();
      setStatus("playing");
    }
  }

  function handleNext() {
    if (status === "idle") return;
    const target = currentIndexRef.current + 1;
    if (target >= tracks.length) return;
    startFrom(target);
  }

  function handlePrevious() {
    if (status === "idle") return;
    const target = Math.max(0, currentIndexRef.current - 1);
    startFrom(target);
  }

  // Progress bar + elapsed-time text, driven imperatively via rAF so a
  // ~60fps update doesn't re-render the component every frame. No CSS
  // transition on the fill width — it's already updated continuously, and
  // this keeps things quiet under prefers-reduced-motion without needing a
  // media query (there's no decorative animation to gate in the first place).
  useEffect(() => {
    if (status !== "playing") return;
    let raf: number;
    const tick = () => {
      const ctx = ctxRef.current;
      const info = scheduleRef.current.get(currentIndexRef.current);
      if (ctx && info && info.duration > 0) {
        const elapsed = Math.min(Math.max(ctx.currentTime - info.startAt, 0), info.duration);
        const pct = (elapsed / info.duration) * 100;
        if (fillRef.current) fillRef.current.style.width = `${pct}%`;
        if (elapsedTextRef.current) elapsedTextRef.current.textContent = formatTime(elapsed);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  // Unmount cleanup: stop playback and release the AudioContext (an
  // AudioContext keeps a hardware audio stream open until closed).
  useEffect(
    () => () => {
      stopAllSources();
      ctxRef.current?.close().catch(() => {});
    },
    [],
  );

  if (tracks.length === 0) return null;

  const currentTrack = tracks[index] ?? tracks[0];
  const isPlaying = status === "playing";
  const isLoading = status === "loading";

  return (
    <div className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-bg-elevated px-4 py-3 sm:-mx-6 sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handlePrevious}
            disabled={status === "idle"}
            aria-label="Previous track"
            className="shrink-0 rounded px-2 py-1 text-text-muted hover:text-text disabled:opacity-30"
          >
            <PreviousIcon />
          </button>
          <button
            type="button"
            onClick={handlePlayPause}
            aria-label={isPlaying ? "Pause" : "Play album"}
            className="shrink-0 rounded border border-border-strong bg-bg-elevated-2 px-3 py-1.5 text-sm font-medium text-text hover:border-accent-border hover:text-accent-bright"
          >
            {status === "idle" ? (
              "Play album"
            ) : isPlaying ? (
              <PauseIcon />
            ) : isLoading ? (
              "…"
            ) : (
              <PlayIcon />
            )}
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={status === "idle"}
            aria-label="Next track"
            className="shrink-0 rounded px-2 py-1 text-text-muted hover:text-text disabled:opacity-30"
          >
            <NextIcon />
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-text">
              {status === "idle" ? (
                <span className="text-text-muted">
                  {albumTitle} — {artistName}
                </span>
              ) : (
                currentTrack.title
              )}
            </p>
            <p className="font-mono text-[11px] text-text-faint">
              Track {index + 1} of {tracks.length}
            </p>
          </div>

          <span className="shrink-0 font-mono text-[11px] text-text-faint">
            <span ref={elapsedTextRef}>0:00</span> / {formatTime(duration ?? 0)}
          </span>
        </div>

        <div className="h-1 w-full overflow-hidden rounded-full bg-bg-hover">
          <div ref={fillRef} className="h-full bg-accent" style={{ width: "0%" }} />
        </div>
      </div>
    </div>
  );
}

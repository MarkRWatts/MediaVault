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
// { startAt, duration } in scheduleRef, keyed by the track's real index in
// `tracks` (NOT its position in the play order — see playOrderRef below).
// startAt is an absolute AudioContext.currentTime coordinate, duration is
// the *decoded* buffer's real duration (not the DB's durationSecs estimate,
// which is what makes the join sample-accurate). prefetch(), once its
// fetch+decode resolves, chains itself onto whatever anchor its immediate
// predecessor (per play order) left behind in scheduleRef — that chaining is
// the gapless engine. A track that fails to load leaves a zero-duration
// passthrough anchor instead of a real one, so the chain still advances past
// it (console.warn'd) rather than stalling.
//
// Prefetch pacing is driven by PLAYBACK, not by decode completion:
// scheduleAt(idx) only kicks off prefetch of idx's successor when idx is the
// track playing right now (by play-order position), and handleTrackEnded
// triggers the next prefetch as playback advances. Without that gate the
// schedule→decode→schedule cascade races through the whole album in seconds
// (observed: a 6-track EP fully fetched immediately), holding every decoded
// AudioBuffer at once — ~1.5 GB of PCM for a 20-track album. With it, at
// most two decoded buffers are alive (current + next; each track's
// multi-minute runtime is ample decode headroom for the following join),
// and buffersRef is pruned down to just the current index as soon as the UI
// advances past a track.
//
// Play order: playOrderRef holds a permutation of track indices (natural
// [0..n-1] normally, a shuffled permutation when shuffle is on). Every
// "what's next/previous" decision goes through nextTrackIndex/
// prevTrackIndex, which look a real index up in playOrderRef and step by one
// position — the buffers/schedule/sources maps themselves stay keyed by raw
// track index throughout, since those describe decoded audio for a specific
// track regardless of when it plays. Toggling shuffle mid-album reshuffles
// everything AFTER the currently-playing track, leaving playback undisturbed
// (a track already mid-flight or pre-buffered under the old order may still
// finish its scheduled chain before the new order fully takes effect — a
// minor, expected transition, not a bug).

import { useEffect, useMemo, useRef, useState } from "react";
import CoverImage from "./CoverImage";

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

// Sentinel key for "no predecessor" anchors in scheduleRef — real track
// indices are always >= 0, so -1 never collides with one.
const NO_PREDECESSOR = -1;

const DEFAULT_VOLUME = 0.85;

// Plain glyphs (⏮ ⏸ ▶ ⏭ 🔀 🔁 🔊) render inconsistently across platforms —
// mobile browsers pull them from the system emoji font (colorful,
// differently shaped) while desktop renders the plain text-symbol form.
// SVGs sidestep that entirely, matching the pattern used elsewhere (see
// VersionCard).
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
    <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6 fill-current">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6 fill-current">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5z" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04z" />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M3 10v4h4l5 5V5L7 10zm13.5 2A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
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
  albumId,
  albumTitle,
  albumHasCover,
  coverVersion,
  artistName,
  tracks: rawTracks,
}: {
  albumId: number;
  albumTitle: string;
  albumHasCover: boolean;
  coverVersion: number | null;
  artistName: string;
  tracks: AlbumPlayerTrack[];
}) {
  // Defensive filter — the call site is expected to already exclude DRM
  // tracks, but a player that can be handed a "drm" track shouldn't try.
  const tracks = useMemo(() => rawTracks.filter((t) => t.codec !== "drm"), [rawTracks]);

  const [status, setStatus] = useState<Status>("idle");
  const [index, setIndex] = useState(0);
  const [duration, setDuration] = useState<number | null>(tracks[0]?.durationSecs ?? null);
  const [shuffled, setShuffled] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [volume, setVolume] = useState(DEFAULT_VOLUME);

  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const buffersRef = useRef(new Map<number, AudioBuffer>());
  const sourcesRef = useRef(new Map<number, AudioBufferSourceNode>());
  const scheduleRef = useRef(new Map<number, ScheduleInfo>());
  const pendingRef = useRef(new Set<number>());
  const sessionRef = useRef(0);
  const currentIndexRef = useRef(0);
  const playOrderRef = useRef<number[]>(tracks.map((_, i) => i));
  const repeatRef = useRef(false);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const elapsedTextRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);

  function positionOf(idx: number): number {
    return playOrderRef.current.indexOf(idx);
  }

  function nextTrackIndex(idx: number): number | null {
    const pos = positionOf(idx);
    if (pos === -1 || pos + 1 >= playOrderRef.current.length) return null;
    return playOrderRef.current[pos + 1];
  }

  function prevTrackIndex(idx: number): number | null {
    const pos = positionOf(idx);
    if (pos <= 0) return null;
    return playOrderRef.current[pos - 1];
  }

  function ensureAudioContext(): AudioContext {
    if (!ctxRef.current) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      const gain = ctx.createGain();
      gain.gain.value = volume;
      gain.connect(ctx.destination);
      ctxRef.current = ctx;
      gainRef.current = gain;
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

  function releaseBuffersExcept(keepIdx: number) {
    for (const idx of buffersRef.current.keys()) {
      if (idx !== keepIdx) buffersRef.current.delete(idx);
    }
  }

  function scheduleAt(idx: number, startAt: number, session: number) {
    const ctx = ctxRef.current;
    const buffer = buffersRef.current.get(idx);
    if (!ctx || !buffer || !gainRef.current || session !== sessionRef.current) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainRef.current);
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

    // Only the currently-playing track (by play-order position) pulls in
    // its successor — a track scheduled for the future must NOT (see the
    // pacing note in the header comment; handleTrackEnded advances the
    // chain when playback reaches it).
    if (positionOf(idx) <= positionOf(currentIndexRef.current)) {
      const next = nextTrackIndex(idx);
      if (next != null) prefetch(next, session);
    }
  }

  function prefetch(idx: number | null, session: number) {
    if (idx == null || idx < 0 || idx >= tracks.length) return;
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
        const prevKey = prevTrackIndex(idx) ?? NO_PREDECESSOR;
        const prev = scheduleRef.current.get(prevKey) ?? {
          startAt: ctx.currentTime + START_EPSILON,
          duration: 0,
        };
        scheduleRef.current.set(idx, prev);
        prefetch(nextTrackIndex(idx), session);
      });
  }

  // Chain a freshly-decoded buffer onto its predecessor's anchor (per play
  // order), if the predecessor has already been (or was just) scheduled and
  // this index hasn't been claimed yet. By construction (every
  // scheduleAt/seed writes scheduleRef[idx] before calling
  // prefetch(next)), the predecessor entry is always present by the time
  // this runs.
  function maybeChain(idx: number, session: number) {
    if (scheduleRef.current.has(idx)) return;
    const prevKey = prevTrackIndex(idx) ?? NO_PREDECESSOR;
    const prev = scheduleRef.current.get(prevKey);
    if (!prev) return;
    scheduleAt(idx, prev.startAt + prev.duration, session);
  }

  function handleTrackEnded(idx: number, session: number) {
    if (session !== sessionRef.current) return;
    sourcesRef.current.delete(idx);

    const nextIdx = nextTrackIndex(idx);
    if (nextIdx == null) {
      if (repeatRef.current && playOrderRef.current.length > 0) {
        startFrom(playOrderRef.current[0]);
        return;
      }
      onAlbumEnded();
      return;
    }

    currentIndexRef.current = nextIdx;
    setIndex(nextIdx);
    releaseBuffersExcept(nextIdx);
    // Playback reached nextIdx (already scheduled & decoded) — now, and only
    // now, pull in the track after it.
    prefetch(nextTrackIndex(nextIdx), session);

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
    const restartIdx = playOrderRef.current[0] ?? 0;
    currentIndexRef.current = restartIdx;
    setIndex(restartIdx);
    setStatus("idle");
    setDuration(tracks[restartIdx]?.durationSecs ?? null);
    if (fillRef.current) fillRef.current.style.width = "0%";
    if (elapsedTextRef.current) elapsedTextRef.current.textContent = formatTime(0);
  }

  // Reset the engine and begin playback at `idx` — used for the initial
  // Play, for Next/Previous, and for looping back to the top on repeat.
  // Seeds a zero-duration anchor at idx's predecessor (per play order) so
  // prefetch/maybeChain's normal chaining logic can bootstrap a fresh start
  // exactly like it recovers from a failed track.
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

    const seedKey = prevTrackIndex(idx) ?? NO_PREDECESSOR;
    scheduleRef.current.set(seedKey, { startAt: ctx.currentTime + START_EPSILON, duration: 0 });
    prefetch(idx, session);
  }

  function handlePlayPause() {
    const ctx = ctxRef.current;
    if (!ctx || status === "idle") {
      startFrom(currentIndexRef.current);
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
    const target = nextTrackIndex(currentIndexRef.current);
    if (target == null) return;
    startFrom(target);
  }

  function handlePrevious() {
    if (status === "idle") return;
    const target = prevTrackIndex(currentIndexRef.current);
    startFrom(target ?? currentIndexRef.current);
  }

  // Reshuffles everything AFTER the currently-playing (or queued) track,
  // leaving it in place — turning shuffle on/off never interrupts what's
  // already playing. Turning it off restores natural track order.
  function handleToggleShuffle() {
    setShuffled((prev) => {
      const next = !prev;
      if (next) {
        const current = currentIndexRef.current;
        const rest = tracks.map((_, i) => i).filter((i) => i !== current);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        playOrderRef.current = [current, ...rest];
      } else {
        playOrderRef.current = tracks.map((_, i) => i);
      }
      return next;
    });
  }

  function handleVolumeChange(v: number) {
    setVolume(v);
    if (gainRef.current) gainRef.current.gain.value = v;
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
  const isIdle = status === "idle";

  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-4">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <div className="flex min-w-0 items-center gap-3">
            <CoverImage
              albumId={albumHasCover ? albumId : null}
              version={coverVersion}
              title={albumTitle}
              sizes="56px"
              className="h-14 w-14 shrink-0 rounded"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text">{currentTrack.title}</p>
              <p className="truncate text-xs text-format-digital">
                {artistName} · {albumTitle}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-center gap-4">
            <button
              type="button"
              onClick={handleToggleShuffle}
              aria-label="Shuffle"
              aria-pressed={shuffled}
              className={shuffled ? "text-format-digital" : "text-text-muted hover:text-text"}
            >
              <ShuffleIcon />
            </button>
            <button
              type="button"
              onClick={handlePrevious}
              disabled={isIdle}
              aria-label="Previous track"
              className="text-text-muted hover:text-text disabled:opacity-30"
            >
              <PreviousIcon />
            </button>
            <button
              type="button"
              onClick={handlePlayPause}
              aria-label={isPlaying ? "Pause" : "Play"}
              className="text-text hover:text-format-digital"
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={isIdle}
              aria-label="Next track"
              className="text-text-muted hover:text-text disabled:opacity-30"
            >
              <NextIcon />
            </button>
            <button
              type="button"
              onClick={() => setRepeat((r) => !r)}
              aria-label="Repeat album"
              aria-pressed={repeat}
              className={repeat ? "text-format-digital" : "text-text-muted hover:text-text"}
            >
              <RepeatIcon />
            </button>
          </div>

          <div className="group/vol flex shrink-0 items-center justify-end gap-2">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              aria-label="Volume"
              className="h-1 w-0 shrink-0 cursor-pointer appearance-none rounded-full bg-bg-hover opacity-0 accent-format-digital transition-all duration-150 group-hover/vol:w-20 group-hover/vol:opacity-100 group-focus-within/vol:w-20 group-focus-within/vol:opacity-100"
            />
            <span className="text-text-muted">
              <VolumeIcon />
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-text-faint">
            <span ref={elapsedTextRef}>0:00</span>
          </span>
          <div className="h-1 w-full overflow-hidden rounded-full bg-bg-hover">
            <div ref={fillRef} className="h-full bg-format-digital" style={{ width: "0%" }} />
          </div>
          <span className="shrink-0 font-mono text-[11px] text-text-faint">{formatTime(duration ?? 0)}</span>
        </div>
      </div>
    </div>
  );
}

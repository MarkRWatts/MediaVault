"use client";

// The persistent Now Playing UI — the desktop rail's expanded content
// (rail.tsx) and the mobile full-screen sheet (mobile-player-bar.tsx) both
// render this. Ported from the old per-page AlbumPlayer.tsx's transport
// row and rAF-driven progress bar (that component is gone now — one
// engine instance for the whole app instead of one per album page) against
// the shared engine (src/lib/player-engine.ts, via usePlayer()) instead of
// page-local refs/state. One addition the old player never had: the
// progress bar is now seekable (engine.seek()), not just decorative.
//
// The progress bar stays imperative, exactly like the old component: a
// rAF loop reads engine.getPosition() ~60 times a second and writes
// width/elapsed text straight into refs rather than through React state,
// so playback doesn't re-render the rest of the app every frame.

import Link from "next/link";
import { useEffect, useRef, type KeyboardEvent } from "react";
import CoverImage from "@/components/CoverImage";
import { usePlayer } from "@/components/player/usePlayer";
import {
  PreviousIcon,
  NextIcon,
  PlayIcon,
  PauseIcon,
  ShuffleIcon,
  RepeatIcon,
  VolumeIcon,
} from "@/components/player/icons";
import { formatTime } from "@/lib/format-time";
import type { PlaybackContext } from "@/lib/player-types";

function contextLabel(context: PlaybackContext | null): string | null {
  if (!context) return null;
  switch (context.kind) {
    case "album":
      return context.title;
    case "playlist":
      return context.title;
    case "favourites":
      return "Favourite tracks";
    default:
      return null;
  }
}

export function NowPlayingCard() {
  const { snapshot, engine } = usePlayer();
  const { current } = snapshot;
  const duration = snapshot.duration ?? 0;

  const trackRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const elapsedTextRef = useRef<HTMLSpanElement | null>(null);

  // Whenever the current entry or status changes outside the rAF loop
  // below (a fresh track, a seek while paused, a pause itself), write the
  // position once so the bar doesn't show a stale frame until playback
  // resumes.
  useEffect(() => {
    const pos = engine.getPosition();
    const elapsed = pos?.elapsed ?? 0;
    const dur = pos?.duration ?? duration;
    if (elapsedTextRef.current) elapsedTextRef.current.textContent = formatTime(elapsed);
    if (fillRef.current) fillRef.current.style.width = dur > 0 ? `${(elapsed / dur) * 100}%` : "0%";
    if (trackRef.current) trackRef.current.setAttribute("aria-valuenow", String(Math.round(elapsed)));
  }, [snapshot.currentKey, snapshot.status, engine, duration]);

  // Progress bar + elapsed-time text, driven imperatively via rAF so a
  // ~60fps update doesn't re-render the component every frame. No CSS
  // transition on the fill width — it's already updated continuously, and
  // this keeps things quiet under prefers-reduced-motion without a media
  // query (there's no decorative animation to gate).
  useEffect(() => {
    if (snapshot.status !== "playing") return;
    let raf: number;
    const tick = () => {
      const pos = engine.getPosition();
      if (pos && pos.duration > 0) {
        const pct = (pos.elapsed / pos.duration) * 100;
        if (fillRef.current) fillRef.current.style.width = `${pct}%`;
        if (elapsedTextRef.current) elapsedTextRef.current.textContent = formatTime(pos.elapsed);
        if (trackRef.current) trackRef.current.setAttribute("aria-valuenow", String(Math.round(pos.elapsed)));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [snapshot.status, engine]);

  if (!current) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-bg/40 px-4 py-8 text-center">
        <p className="text-sm text-text-muted">Nothing playing — pick an album</p>
        <Link href="/music" className="text-sm text-format-digital hover:underline">
          Browse music
        </Link>
      </div>
    );
  }

  const isPlaying = snapshot.status === "playing" || snapshot.status === "loading";
  const isIdle = snapshot.status === "idle";
  const label = contextLabel(snapshot.context);

  function seekToClientX(clientX: number) {
    const el = trackRef.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    engine.seek(fraction * duration);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const pos = engine.getPosition();
    const elapsed = pos?.elapsed ?? 0;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      engine.seek(elapsed - 5);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      engine.seek(elapsed + 5);
    } else if (e.key === "Home") {
      e.preventDefault();
      engine.seek(0);
    } else if (e.key === "End") {
      e.preventDefault();
      engine.seek(duration);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <CoverImage
        albumId={current.hasCover ? current.albumId : null}
        version={current.coverVersion}
        title={current.albumTitle}
        priority
        className="w-full rounded-lg"
      />

      <div className="min-w-0">
        <Link
          href={`/music/album/${current.albumId}`}
          className="block truncate text-sm font-medium text-text hover:underline"
        >
          {current.title}
        </Link>
        <p className="truncate text-xs">
          <span className="text-format-digital">{current.artist}</span>
          <span className="text-text-muted"> · {current.albumTitle}</span>
        </p>
        {label && <p className="mt-0.5 truncate text-[11px] text-text-faint">Playing from {label}</p>}
      </div>

      <div className="flex shrink-0 items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => engine.setShuffle(!snapshot.shuffle)}
          aria-label="Shuffle"
          aria-pressed={snapshot.shuffle}
          className={snapshot.shuffle ? "text-format-digital" : "text-text-muted hover:text-text"}
        >
          <ShuffleIcon />
        </button>
        <button
          type="button"
          onClick={() => engine.previous()}
          disabled={isIdle}
          aria-label="Previous track"
          className="text-text-muted hover:text-text disabled:opacity-30"
        >
          <PreviousIcon />
        </button>
        <button
          type="button"
          onClick={() => engine.toggle()}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="text-text hover:text-format-digital"
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          onClick={() => engine.next()}
          disabled={isIdle}
          aria-label="Next track"
          className="text-text-muted hover:text-text disabled:opacity-30"
        >
          <NextIcon />
        </button>
        <button
          type="button"
          onClick={() => engine.setRepeat(!snapshot.repeat)}
          aria-label="Repeat album"
          aria-pressed={snapshot.repeat}
          className={snapshot.repeat ? "text-format-digital" : "text-text-muted hover:text-text"}
        >
          <RepeatIcon />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-[11px] text-text-faint">
          <span ref={elapsedTextRef}>0:00</span>
        </span>
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekToClientX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1) seekToClientX(e.clientX);
          }}
          onKeyDown={handleKeyDown}
          className="h-1 w-full cursor-pointer overflow-hidden rounded-full bg-bg-hover"
        >
          <div ref={fillRef} className="h-full bg-format-digital" style={{ width: "0%" }} />
        </div>
        <span className="shrink-0 font-mono text-[11px] text-text-faint">{formatTime(duration)}</span>
      </div>

      <div className="group/vol flex shrink-0 items-center justify-center gap-2">
        <span className="text-text-muted">
          <VolumeIcon />
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={snapshot.volume}
          onChange={(e) => engine.setVolume(Number(e.target.value))}
          aria-label="Volume"
          className="h-1 w-0 shrink-0 cursor-pointer appearance-none rounded-full bg-bg-hover opacity-0 accent-format-digital transition-all duration-150 group-hover/vol:w-24 group-hover/vol:opacity-100 group-focus-within/vol:w-24 group-focus-within/vol:opacity-100"
        />
      </div>
    </div>
  );
}

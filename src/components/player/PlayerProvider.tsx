"use client";

// Owns the one PlayerEngine (src/lib/player-engine.ts) for the life of the
// page and exposes its snapshot to any client component via usePlayer().
// Mounted once by AppShell's chrome branch (components/shell/app-shell.tsx),
// so it lives in the root layout: App Router layouts keep their client
// state across navigations and across router.refresh(), which is exactly
// what keeps music playing while you move around the app.
//
// The engine itself is a globalThis singleton (getPlayerEngine), not
// component state — a Fast Refresh remount of this provider, or of the
// shell, must never create a second AudioContext or stop playback.
// useSyncExternalStore ties React renders to the engine's own snapshot;
// EMPTY_SNAPSHOT is the server snapshot, and since nothing can have been
// queued before hydration the server and first client render always agree.

import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { getPlayerEngine, type PlayerEngine } from "@/lib/player-engine";
import { EMPTY_SNAPSHOT, type PlayerSnapshot } from "@/lib/player-types";

export interface PlayerContextValue {
  snapshot: PlayerSnapshot;
  engine: PlayerEngine;
}

export const PlayerContext = createContext<PlayerContextValue | null>(null);

// Resolved lazily so importing this module on the server (AppShell is a
// Server Component that renders it) never touches globalThis/window.
let engineRef: PlayerEngine | null = null;
function engine(): PlayerEngine {
  if (!engineRef) engineRef = getPlayerEngine();
  return engineRef;
}

const subscribe = (listener: () => void) => engine().subscribe(listener);
const getSnapshot = () => engine().getSnapshot();
const getServerSnapshot = () => EMPTY_SNAPSHOT;

export function PlayerProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const current = snapshot.current;

  // Media Session: lock-screen / hardware-key transport and the OS "now
  // playing" card. Best-effort — absent on some engines, and metadata
  // artwork is a plain URL the OS fetches itself.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    if (!current) {
      ms.metadata = null;
      return;
    }
    const artwork = current.hasCover
      ? [{ src: `/api/cover/${current.albumId}${current.coverVersion != null ? `?v=${current.coverVersion}` : ""}` }]
      : [];
    ms.metadata = new MediaMetadata({ title: current.title, artist: current.artist, album: current.albumTitle, artwork });
    const e = engine();
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => e.play()],
      ["pause", () => e.pause()],
      ["previoustrack", () => e.previous()],
      ["nexttrack", () => e.next()],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Unsupported action on this engine — ignore.
      }
    }
  }, [current]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState =
      snapshot.status === "playing" || snapshot.status === "loading" ? "playing" : snapshot.status === "paused" ? "paused" : "none";
  }, [snapshot.status]);

  return <PlayerContext.Provider value={{ snapshot, engine: engine() }}>{children}</PlayerContext.Provider>;
}

/** The engine and its live snapshot. Throws outside PlayerProvider, which
 *  only happens on chromeless pages (/signin, /consent…) — nothing there
 *  should be rendering player controls. */
export function usePlayer(): PlayerContextValue {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer() must be used inside <PlayerProvider>");
  return value;
}

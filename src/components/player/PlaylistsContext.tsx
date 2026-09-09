"use client";

// The signed-in person's playlist list, made available to any client
// component that offers "Add to playlist" (TrackMenu's submenu,
// AlbumActions) without each of them fetching it. AppShell reads the list
// server-side once per request (getUserPlaylists) and mounts this provider
// inside PlayerProvider; after a mutation the caller's router.refresh()
// re-renders AppShell, so the value here is always the server's latest.

import { createContext, useContext, type ReactNode } from "react";
import type { PlaylistSummary } from "@/lib/queries-playlists";

export interface PlaylistsContextValue {
  playlists: PlaylistSummary[];
  favouriteTrackCount: number;
}

const PlaylistsContext = createContext<PlaylistsContextValue | null>(null);

export function PlaylistsProvider({
  playlists,
  favouriteTrackCount,
  children,
}: PlaylistsContextValue & { children: ReactNode }) {
  return <PlaylistsContext.Provider value={{ playlists, favouriteTrackCount }}>{children}</PlaylistsContext.Provider>;
}

/** Throws outside the provider — like usePlayer(), only chromeless pages
 *  are outside it, and nothing there offers playlist actions. */
export function usePlaylists(): PlaylistsContextValue {
  const value = useContext(PlaylistsContext);
  if (!value) throw new Error("usePlaylists() must be used inside <PlaylistsProvider>");
  return value;
}

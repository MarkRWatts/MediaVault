"use client";

// In-app playback modal: polls /api/video/:versionId/status, kicks off
// /prepare when needed, and swaps in a plain <video> against /stream once
// the file is direct-playable or the cached remux/transcode is ready. See
// src/lib/video-cache.ts for what each status actually means.
//
// Bridge to the MediaVaultTV tvOS shell (separate repo): that app is mostly
// just this same web app inside a WKWebView, with one native escape hatch —
// it registers a `mediaVaultPlayer` message handler so a real
// AVPlayerViewController (hardware decode, AC-3/E-AC-3 passthrough) can take
// over instead of a WebView-hosted <video> tag, which tvOS's Siri Remote
// focus engine doesn't drive reliably anyway. When that handler exists, hand
// off the resolved stream URL and skip rendering our own <video> — see
// WebViewController.swift in MediaVaultTV for the receiving end.

import { useEffect, useRef, useState } from "react";

type UiState = "loading" | "preparing" | "playable" | "handed-off" | "error";

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        mediaVaultPlayer?: { postMessage: (message: unknown) => void };
      };
    };
  }
}

function hasNativePlayerBridge(): boolean {
  return typeof window !== "undefined" && Boolean(window.webkit?.messageHandlers?.mediaVaultPlayer);
}

async function fetchStatus(versionId: number): Promise<{ state: string; message?: string } | null> {
  const res = await fetch(`/api/video/${versionId}/status`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

export default function VideoPlayer({ versionId, title, onClose }: { versionId: number; title: string; onClose: () => void }) {
  const [uiState, setUiState] = useState<UiState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    async function tick() {
      const status = await fetchStatus(versionId);
      if (cancelledRef.current) return;

      if (!status) {
        setUiState("error");
        setMessage("Could not reach the server.");
        return;
      }

      if (status.state === "direct" || status.state === "ready") {
        if (hasNativePlayerBridge()) {
          const streamURL = new URL(`/api/video/${versionId}/stream`, window.location.origin).toString();
          window.webkit!.messageHandlers!.mediaVaultPlayer!.postMessage({ streamURL, title });
          setUiState("handed-off");
          // The native side takes over full-screen — close this modal so the
          // page underneath isn't left showing a dead "playable" state.
          window.setTimeout(onClose, 300);
          return;
        }
        setUiState("playable");
        return;
      }

      if (status.state === "error") {
        setUiState("error");
        setMessage(status.message ?? "Preparation failed.");
        return;
      }

      if (status.state === "idle") {
        await fetch(`/api/video/${versionId}/prepare`, { method: "POST" });
      }

      setUiState("preparing");
      if (!cancelledRef.current) {
        timeoutRef.current = window.setTimeout(tick, 2000);
      }
    }

    tick();
    return () => {
      cancelledRef.current = true;
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, [versionId, title, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${title}`}
    >
      <div className="flex w-full max-w-5xl flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="truncate text-sm font-medium text-white">{title}</p>
          <button
            onClick={onClose}
            className="rounded-full border border-white/20 px-3 py-1 text-xs font-medium text-white transition-colors hover:border-white/40"
          >
            Close
          </button>
        </div>

        <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-black">
          {uiState === "playable" && (
            <video
              controls
              autoPlay
              playsInline
              src={`/api/video/${versionId}/stream`}
              className="h-full w-full"
              onError={() => {
                setUiState("error");
                setMessage("Playback failed — see the browser console for details.");
              }}
            />
          )}
          {uiState === "loading" && <p className="text-sm text-white/70">Checking…</p>}
          {uiState === "handed-off" && <p className="text-sm text-white/70">Handing off to the native player…</p>}
          {uiState === "preparing" && (
            <p className="text-sm text-white/70">Preparing stream — this only happens once per file…</p>
          )}
          {uiState === "error" && (
            <p className="max-w-md text-center text-sm text-red-300">{message ?? "Playback failed."}</p>
          )}
        </div>
      </div>
    </div>
  );
}

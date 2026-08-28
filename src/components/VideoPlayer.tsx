"use client";

// In-app playback modal. GET /api/video/:id/stream is self-starting — it
// serves direct-playable files immediately, and for anything that needs
// remuxing/transcoding it kicks off ffmpeg itself and streams the output
// *as it's being written* (see video-cache.ts's resolveVideoStream +
// tailing-stream.ts), rather than making the viewer wait for the whole file.
// So this component just points <video> at that URL and lets the browser's
// own buffering handle the rest — no polling loop, no blocking "preparing"
// screen.
//
// The one thing still worth a single status check up front: whether this
// version already failed to prepare on a previous attempt (show that error
// immediately, don't let <video> spend time trying and failing on its own),
// and the native-player handoff below.
//
// Bridge to the MediaVaultTV tvOS shell (separate repo): that app is mostly
// just this same web app inside a WKWebView, with one native escape hatch —
// it registers a `mediaVaultPlayer` message handler so a real
// AVPlayerViewController (hardware decode, AC-3/E-AC-3 passthrough) can take
// over instead of a WebView-hosted <video> tag, which tvOS's Siri Remote
// focus engine doesn't drive reliably anyway. When that handler exists, hand
// off the stream URL and skip rendering our own <video> — see
// WebViewController.swift in MediaVaultTV for the receiving end.

import { useEffect, useState } from "react";

type UiState = "checking" | "playing" | "handed-off" | "error";

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

export default function VideoPlayer({ versionId, title, onClose }: { versionId: number; title: string; onClose: () => void }) {
  const [uiState, setUiState] = useState<UiState>("checking");
  const [message, setMessage] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(true);
  const streamUrl = `/api/video/${versionId}/stream`;

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const res = await fetch(`/api/video/${versionId}/status`, { cache: "no-store" });
      if (cancelled) return;

      if (!res.ok) {
        setUiState("error");
        setMessage("Could not reach the server.");
        return;
      }

      const status = await res.json();
      if (cancelled) return;

      if (status.state === "not-found") {
        setUiState("error");
        setMessage("This version isn't playable.");
        return;
      }
      if (status.state === "error") {
        setUiState("error");
        setMessage(status.message ?? "Preparation failed.");
        return;
      }

      if (hasNativePlayerBridge()) {
        const absoluteStreamUrl = new URL(streamUrl, window.location.origin).toString();
        window.webkit!.messageHandlers!.mediaVaultPlayer!.postMessage({ streamURL: absoluteStreamUrl, title });
        setUiState("handed-off");
        // The native side takes over full-screen — close this modal so the
        // page underneath isn't left showing a dead state.
        window.setTimeout(onClose, 300);
        return;
      }

      setUiState("playing");
    }

    check();
    return () => {
      cancelled = true;
    };
  }, [versionId, title, onClose, streamUrl]);

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

        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-black">
          {uiState === "playing" && (
            <>
              <video
                controls
                autoPlay
                playsInline
                src={streamUrl}
                className="h-full w-full"
                onLoadStart={() => setBuffering(true)}
                onWaiting={() => setBuffering(true)}
                onPlaying={() => setBuffering(false)}
                onCanPlay={() => setBuffering(false)}
                onError={(e) => {
                  const mediaError = e.currentTarget.error;
                  // The element's own error event doesn't show up in the console
                  // on its own -- log it ourselves so there's something to see.
                  console.error("Video playback failed", mediaError?.code, mediaError?.message);
                  setUiState("error");
                  setMessage(
                    mediaError
                      ? `Playback failed (code ${mediaError.code}): ${mediaError.message || "no further detail from the browser"}`
                      : "Playback failed — no error detail available.",
                  );
                }}
              />
              {buffering && (
                <p className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-black/60 px-3 py-1 text-xs text-white/80">
                  Buffering…
                </p>
              )}
            </>
          )}
          {uiState === "checking" && <p className="text-sm text-white/70">Checking…</p>}
          {uiState === "handed-off" && <p className="text-sm text-white/70">Handing off to the native player…</p>}
          {uiState === "error" && (
            <p className="max-w-2xl text-center text-sm text-red-300">{message ?? "Playback failed."}</p>
          )}
        </div>
      </div>
    </div>
  );
}

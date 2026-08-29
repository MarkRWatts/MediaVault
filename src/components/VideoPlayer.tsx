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

import { useCallback, useEffect, useRef, useState } from "react";
import { WATCH_PROGRESS_MIN_SECS, WATCH_PROGRESS_REPORT_INTERVAL_SECS } from "@/lib/constants";

type UiState = "checking" | "playing" | "handed-off" | "error";

interface SavedProgress {
  positionSecs: number;
  completed: boolean;
}

// Fire-and-forget progress report. Best-effort: a dropped tick just means
// the resume position is up to WATCH_PROGRESS_REPORT_INTERVAL_SECS staler
// than it could be, not worth surfacing to the viewer. `keepalive` gives the
// pause/close flush a chance to actually land even as the tab is navigating
// away or the player is unmounting.
function reportProgress(basePath: string, id: number, positionSecs: number, durationSecs: number, isNewPlay: boolean) {
  if (!Number.isFinite(durationSecs) || durationSecs <= 0) return;
  fetch(`${basePath}/${id}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionSecs, durationSecs, ...(isNewPlay ? { isNewPlay: true } : {}) }),
    keepalive: true,
  }).catch(() => {});
}

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

export default function VideoPlayer({
  versionId,
  title,
  onClose,
  basePath = "/api/video",
  trackProgress = true,
}: {
  versionId: number;
  title: string;
  onClose: () => void;
  /** Which streaming API to hit — defaults to films' /api/video. Scenes use
   *  /api/adult-video (see video-cache.ts's kind-namespacing). */
  basePath?: string;
  /** Films resume/report watch position; scenes deliberately don't (no
   *  SceneProgress model — out of scope, see ADULT_PLAN.md). Skips the
   *  progress GET/POST calls entirely rather than letting them 404. */
  trackProgress?: boolean;
}) {
  const [uiState, setUiState] = useState<UiState>("checking");
  const [message, setMessage] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(true);
  const [savedProgress, setSavedProgress] = useState<SavedProgress | null>(null);
  const streamUrl = `${basePath}/${versionId}/stream`;

  const videoRef = useRef<HTMLVideoElement>(null);
  // Position (secs) as of the last progress report this session, so the
  // throttled timeupdate handler only reports once real time has passed
  // rather than on every tick.
  const lastReportedPosRef = useRef(0);
  // Guards the one-time "a new play started" report — set on the first
  // `playing` event of this player instance, never again, so re-buffering
  // (which re-fires `playing`) doesn't inflate playCount.
  const hasReportedStartRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const [statusRes, progressRes] = await Promise.all([
        fetch(`${basePath}/${versionId}/status`, { cache: "no-store" }),
        // Best-effort: if this fails for any reason we just don't resume —
        // not worth blocking playback over. Skipped entirely when this
        // media type doesn't track progress (see trackProgress's doc
        // comment) — no /progress route exists to call.
        trackProgress
          ? fetch(`${basePath}/${versionId}/progress`, { cache: "no-store" }).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (cancelled) return;

      if (!statusRes.ok) {
        setUiState("error");
        setMessage("Could not reach the server.");
        return;
      }

      const status = await statusRes.json();
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

      if (progressRes?.ok) {
        const progress = await progressRes.json().catch(() => null);
        if (!cancelled && progress && typeof progress.positionSecs === "number") {
          setSavedProgress({ positionSecs: progress.positionSecs, completed: Boolean(progress.completed) });
        }
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
  }, [versionId, title, onClose, streamUrl, basePath, trackProgress]);

  // Flush whatever position the <video> element is currently at. Called on
  // pause, on the modal's own Close button, and on unmount (covers a parent
  // unmounting this component some other way, e.g. route navigation) — so a
  // viewer who stops early doesn't lose more than the last throttled tick's
  // worth of progress.
  const flushProgress = useCallback(() => {
    if (!trackProgress) return;
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    lastReportedPosRef.current = v.currentTime;
    reportProgress(basePath, versionId, v.currentTime, v.duration, false);
  }, [basePath, versionId, trackProgress]);

  useEffect(() => {
    return () => flushProgress();
  }, [flushProgress]);

  function handleClose() {
    flushProgress();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${title}`}
    >
      <div className="flex w-full max-w-5xl flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="truncate text-sm font-medium text-white">{title}</p>
          <button
            onClick={handleClose}
            className="rounded-full border border-white/20 px-3 py-1 text-xs font-medium text-white transition-colors hover:border-white/40"
          >
            Close
          </button>
        </div>

        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-black">
          {uiState === "playing" && (
            <>
              <video
                ref={videoRef}
                controls
                autoPlay
                playsInline
                src={streamUrl}
                className="h-full w-full"
                onLoadStart={() => setBuffering(true)}
                onWaiting={() => setBuffering(true)}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  // Only resume a position that's a real "in progress"
                  // point, not a completed title or a trivial preview
                  // (see WATCH_PROGRESS_MIN_SECS) — and never past the
                  // very end, in case durationSecs was probed slightly
                  // differently than what the browser reports here.
                  if (
                    savedProgress &&
                    !savedProgress.completed &&
                    savedProgress.positionSecs >= WATCH_PROGRESS_MIN_SECS &&
                    savedProgress.positionSecs < v.duration
                  ) {
                    v.currentTime = savedProgress.positionSecs;
                    lastReportedPosRef.current = savedProgress.positionSecs;
                  }
                }}
                onPlaying={() => {
                  setBuffering(false);
                  if (trackProgress && !hasReportedStartRef.current) {
                    hasReportedStartRef.current = true;
                    const v = videoRef.current;
                    if (v && Number.isFinite(v.duration) && v.duration > 0) {
                      lastReportedPosRef.current = v.currentTime;
                      reportProgress(basePath, versionId, v.currentTime, v.duration, true);
                    }
                  }
                }}
                onCanPlay={() => setBuffering(false)}
                onTimeUpdate={(e) => {
                  if (!trackProgress) return;
                  const v = e.currentTarget;
                  if (!Number.isFinite(v.duration) || v.duration <= 0) return;
                  // Throttle: only report once real playback time has
                  // advanced past the interval, not on every `timeupdate`
                  // tick (which fires several times a second). A backward
                  // seek also clears enough distance to report immediately,
                  // which is fine — it's still at most one extra request.
                  if (Math.abs(v.currentTime - lastReportedPosRef.current) >= WATCH_PROGRESS_REPORT_INTERVAL_SECS) {
                    lastReportedPosRef.current = v.currentTime;
                    reportProgress(basePath, versionId, v.currentTime, v.duration, false);
                  }
                }}
                onPause={flushProgress}
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

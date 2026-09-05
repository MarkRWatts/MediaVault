"use client";

// In-app playback modal (PLAYBACK_PLAN.md). One status call decides the
// source: a direct-playable file plays straight from /stream with byte
// ranges, exactly as before; anything that needs preparing plays as HLS
// from hls/<variant>/index.m3u8, which self-starts the ffmpeg job and hands
// back an event playlist that grows as segments land -- so the viewer can
// start within seconds, seek anywhere already written, and ride out a
// dropped connection by re-fetching a segment. Safari, iOS and the tvOS
// WKWebView play HLS natively; every other browser gets hls.js, loaded on
// demand so it never ships to the browsers that don't need it.
//
// Quality: "Original" keeps the source's video and best compatible audio;
// "Remote" is a 720p ~3 Mbps encode for links that can't carry a Blu-ray
// bitrate. It is always the viewer's choice (over a VPN the server can't
// tell a hotel from the sofa), remembered per device, and nudged -- never
// switched -- after repeated stalls.
//
// Bridge to the MediaVaultTV tvOS shell (separate repo): that app is mostly
// just this same web app inside a WKWebView, with one native escape hatch —
// it registers a `mediaVaultPlayer` message handler so a real
// AVPlayerViewController (hardware decode, AC-3/E-AC-3 passthrough) can take
// over instead of a WebView-hosted <video> tag. When that handler exists,
// hand off the URL (the HLS playlist for a prepared file -- AVPlayer's
// preferred input -- or /stream for a direct one) and skip rendering our
// own <video>; see WebViewController.swift in MediaVaultTV.

import { useCallback, useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import { WATCH_PROGRESS_MIN_SECS, WATCH_PROGRESS_REPORT_INTERVAL_SECS } from "@/lib/constants";

type UiState = "checking" | "playing" | "handed-off" | "error";
type Tier = "direct" | "prepare";
type Variant = "original" | "remote";

interface SavedProgress {
  positionSecs: number;
  completed: boolean;
}

const QUALITY_KEY = "mv-video-quality";
// Stalls within this window before the Remote nudge appears.
const STALL_WINDOW_MS = 60_000;
const STALL_NUDGE_COUNT = 3;

function readQuality(): Variant {
  try {
    return localStorage.getItem(QUALITY_KEY) === "remote" ? "remote" : "original";
  } catch {
    return "original";
  }
}

function rememberQuality(variant: Variant): void {
  try {
    localStorage.setItem(QUALITY_KEY, variant);
  } catch {
    // Per-device convenience only; nothing depends on it persisting.
  }
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

// Native HLS is the right choice only on Apple's WebKit (Safari, iOS, the
// tvOS WKWebView bridge): it's the platform player, with AirPlay and
// hardware decode. Chromium-based browsers have started answering "maybe"
// to the HLS MIME type too, but their built-in support is partial and does
// not honour an event playlist the way this app needs, so everything that
// isn't Apple WebKit goes through hls.js's MediaSource path even when it
// claims native support.
function canPlayHlsNatively(video: HTMLVideoElement): boolean {
  if (video.canPlayType("application/vnd.apple.mpegurl") === "") return false;
  const ua = navigator.userAgent;
  const appleWebKit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(ua);
  return appleWebKit || typeof MediaSource === "undefined";
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
  const [tier, setTier] = useState<Tier | null>(null);
  // This component only ever mounts client-side (on Play), so reading
  // storage in the initializer is safe -- there's no server render to
  // disagree with.
  const [variant, setVariant] = useState<Variant>(() => (typeof window === "undefined" ? "original" : readQuality()));
  const [showRemoteNudge, setShowRemoteNudge] = useState(false);

  const streamUrl = `${basePath}/${versionId}/stream`;
  const playlistUrl = (v: Variant) => `${basePath}/${versionId}/hls/${v}/index.m3u8`;
  /** What this player is (or would be) playing: /stream for direct-play
   *  originals, the HLS playlist otherwise -- a remote rendition of a
   *  direct-play file is still HLS. */
  const sourceUrl = tier === "direct" && variant === "original" ? streamUrl : playlistUrl(variant);

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  // Position (secs) as of the last progress report this session, so the
  // throttled timeupdate handler only reports once real time has passed
  // rather than on every tick.
  const lastReportedPosRef = useRef(0);
  // Guards the one-time "a new play started" report — set on the first
  // `playing` event of this player instance, never again, so re-buffering
  // (which re-fires `playing`) doesn't inflate playCount.
  const hasReportedStartRef = useRef(false);
  // Where to seek once the next source has metadata: the saved resume
  // position on first load, or the position we were at when the viewer
  // switched quality.
  const seekOnLoadRef = useRef<number | null>(null);
  const stallTimesRef = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const [statusRes, progressRes] = await Promise.all([
        fetch(`${basePath}/${versionId}/status?variant=${variant}`, { cache: "no-store" }),
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
      const resolvedTier: Tier = status.state === "direct" ? "direct" : "prepare";
      setTier(resolvedTier);

      if (progressRes?.ok) {
        const progress = await progressRes.json().catch(() => null);
        if (!cancelled && progress && typeof progress.positionSecs === "number") {
          const saved: SavedProgress = { positionSecs: progress.positionSecs, completed: Boolean(progress.completed) };
          // Only resume a position that's a real "in progress" point, not a
          // completed title or a trivial preview (see WATCH_PROGRESS_MIN_SECS).
          if (!saved.completed && saved.positionSecs >= WATCH_PROGRESS_MIN_SECS) {
            seekOnLoadRef.current = saved.positionSecs;
          }
        }
      }

      if (hasNativePlayerBridge()) {
        const url = resolvedTier === "direct" && variant === "original" ? streamUrl : playlistUrl(variant);
        const absoluteUrl = new URL(url, window.location.origin).toString();
        window.webkit!.messageHandlers!.mediaVaultPlayer!.postMessage({ streamURL: absoluteUrl, title });
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
    // The initial check runs once per player; a quality change re-attaches
    // the source below rather than re-checking status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, title, onClose, streamUrl, basePath, trackProgress]);

  // Attach the source to the <video> whenever what we should be playing
  // changes. Direct-play: plain src. HLS: native where the browser can, else
  // hls.js. hls.js is torn down and rebuilt on a quality switch.
  useEffect(() => {
    if (uiState !== "playing" || tier === null) return;
    const video = videoRef.current;
    if (!video) return;

    let disposed = false;
    const useHls = sourceUrl !== streamUrl;

    async function attach() {
      if (!video) return;
      if (!useHls || canPlayHlsNatively(video)) {
        video.src = sourceUrl;
        return;
      }
      const { default: HlsCtor } = await import("hls.js");
      if (disposed) return;
      if (!HlsCtor.isSupported()) {
        setUiState("error");
        setMessage("This browser can't play HLS streams and has no Media Source support.");
        return;
      }
      const hls = new HlsCtor({
        // The playlist is "live" until ffmpeg appends ENDLIST, but it's an
        // event playlist we want to play from the start (or the resume
        // point), never from the live edge like a broadcast.
        lowLatencyMode: false,
        startPosition: seekOnLoadRef.current ?? 0,
        liveDurationInfinity: false,
        maxBufferLength: 60,
        // Keep asking for a playlist/segment that isn't there yet -- while
        // preparing, "not yet" is the normal case at the edge.
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingMaxRetry: 6,
      });
      hlsRef.current = hls;
      hls.on(HlsCtor.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          setUiState("error");
          setMessage(`Playback failed: ${data.details}`);
        }
      });
      hls.loadSource(sourceUrl);
      hls.attachMedia(video);
    }

    attach();
    return () => {
      disposed = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [uiState, tier, sourceUrl, streamUrl]);

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

  function changeQuality(next: Variant) {
    if (next === variant) return;
    const v = videoRef.current;
    // Carry the current position across the switch; the new source seeks
    // there once it has metadata (or as soon as that point is written).
    seekOnLoadRef.current = v && v.currentTime > 0 ? v.currentTime : null;
    stallTimesRef.current = [];
    setShowRemoteNudge(false);
    rememberQuality(next);
    setVariant(next);
  }

  function applyPendingSeek(v: HTMLVideoElement) {
    const target = seekOnLoadRef.current;
    if (target === null) return;
    // Never past the very end, in case the duration was probed slightly
    // differently than what the browser reports here. While a file is still
    // being prepared the duration grows; keep the target until it fits.
    if (Number.isFinite(v.duration) && target < v.duration) {
      v.currentTime = target;
      lastReportedPosRef.current = target;
      seekOnLoadRef.current = null;
    }
  }

  function noteStall() {
    setBuffering(true);
    const now = Date.now();
    const recent = stallTimesRef.current.filter((t) => now - t < STALL_WINDOW_MS);
    recent.push(now);
    stallTimesRef.current = recent;
    if (variant === "original" && recent.length >= STALL_NUDGE_COUNT) setShowRemoteNudge(true);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${title}`}
    >
      <div className="flex w-full max-w-5xl flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-medium text-white">{title}</p>
          <div className="flex shrink-0 items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-white/70">
              Quality
              <select
                value={variant}
                onChange={(e) => changeQuality(e.target.value as Variant)}
                disabled={uiState !== "playing"}
                aria-label="Playback quality"
                className="rounded-md border border-white/20 bg-black/60 px-2 py-1 text-xs text-white focus-visible:outline-none disabled:opacity-40"
              >
                <option value="original">Original</option>
                <option value="remote">Remote (720p)</option>
              </select>
            </label>
            <button
              onClick={handleClose}
              className="rounded-full border border-white/20 px-3 py-1 text-xs font-medium text-white transition-colors hover:border-white/40"
            >
              Close
            </button>
          </div>
        </div>

        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-black">
          {uiState === "playing" && (
            <>
              {/* src is set by the attach effect: a plain URL for direct play
                  and native HLS, or via hls.js's MediaSource otherwise. */}
              <video
                ref={videoRef}
                controls
                autoPlay
                playsInline
                className="h-full w-full"
                onLoadStart={() => setBuffering(true)}
                onWaiting={noteStall}
                onLoadedMetadata={(e) => applyPendingSeek(e.currentTarget)}
                onDurationChange={(e) => applyPendingSeek(e.currentTarget)}
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
                  // hls.js drives its own error path (see the attach effect);
                  // this is the <video> element's, for direct play and
                  // native HLS.
                  if (hlsRef.current) return;
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

        {showRemoteNudge && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-md border border-white/15 bg-black/60 px-3 py-2 text-xs text-white/80"
          >
            <span>Buffering a lot? Remote quality (720p, ~3 Mbps) is made for slower connections.</span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => changeQuality("remote")}
                className="rounded-md border border-white/30 px-2.5 py-1 font-medium text-white transition-colors hover:border-white/60"
              >
                Switch to Remote
              </button>
              <button
                type="button"
                onClick={() => setShowRemoteNudge(false)}
                className="px-1.5 py-1 text-white/60 transition-colors hover:text-white"
              >
                Not now
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

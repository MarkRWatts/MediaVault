"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatLabel } from "@/lib/constants";
import NoPoster from "@/components/NoPoster";

// --- API response shapes (mirror src/app/api/barcode/*) ---

interface OwnedFilm {
  status: "owned";
  type: "film";
  film: { id: number; title: string; year: number | null; posterPath: string | null };
}
interface OwnedAlbum {
  status: "owned";
  type: "album";
  album: { id: number; title: string; artistName: string; year: number | null; coverPath: string | null };
}
interface FilmCandidate {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}
interface AlbumCandidate {
  mbid: string;
  title: string;
  artistName: string;
  year: number | null;
  format: string | null;
  coverArtUrl: string;
}
interface NotOwnedFilm {
  status: "not_owned";
  type: "film";
  candidate: FilmCandidate;
}
interface NotOwnedAlbum {
  status: "not_owned";
  type: "album";
  candidate: AlbumCandidate;
}
interface Unknown {
  status: "unknown";
}
type LookupResult = OwnedFilm | OwnedAlbum | NotOwnedFilm | NotOwnedAlbum | Unknown;
type SearchCandidate = { kind: "film"; candidate: FilmCandidate } | { kind: "album"; candidate: AlbumCandidate };

const FILM_MEDIA = ["BLURAY", "DVD", "UHD"] as const;
const ALBUM_MEDIA = ["CD", "VINYL"] as const;
const QUEUE_STORAGE_KEY = "mediavault-scan-queue";

function guessAlbumMedium(format: string | null): "CD" | "VINYL" {
  return format?.toLowerCase().includes("vinyl") ? "VINYL" : "CD";
}

// --- Batch queue ---

interface QueueItem {
  barcode: string;
  status: "pending" | "looking_up" | "resolved" | "error";
  result?: LookupResult;
  error?: string;
  added?: { href: string; label: string };
}

function loadQueue(): QueueItem[] {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueueItem[];
    // A "looking_up" item from a previous session has no fetch actually in
    // flight anymore — put it back in line rather than stalling forever.
    return parsed.map((q) => (q.status === "looking_up" ? { ...q, status: "pending" } : q));
  } catch {
    return [];
  }
}

function saveQueue(queue: QueueItem[]) {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Storage full/unavailable (private browsing) — batch mode still works
    // for the current tab session, it just won't survive a reload.
  }
}

// Small cover/poster thumbnail so the user can visually confirm a lookup
// result is the right release before adding it — falls back to the same
// typeset placeholder card the rest of the app uses (NoPoster) if there's
// no image, or the image 404s (e.g. Cover Art Archive has no art for a
// given release-group).
function Thumb({
  src,
  title,
  year,
  aspect = "poster",
}: {
  src: string | null;
  title: string;
  year?: number | null;
  aspect?: "poster" | "square";
}) {
  const [errored, setErrored] = useState(false);
  return (
    <div
      className={`relative w-14 shrink-0 overflow-hidden rounded border border-border bg-bg-elevated ${
        aspect === "poster" ? "aspect-2/3" : "aspect-square"
      }`}
    >
      {!src || errored ? (
        <NoPoster title={title} year={year} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={`${title} cover`}
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}

function thumbFor(result: LookupResult): { src: string | null; title: string; year: number | null; aspect: "poster" | "square" } {
  if (result.status === "owned" && result.type === "film") {
    return { src: result.film.posterPath ? `/api/poster/w154${result.film.posterPath}` : null, title: result.film.title, year: result.film.year, aspect: "poster" };
  }
  if (result.status === "owned" && result.type === "album") {
    return { src: result.album.coverPath ? `/api/cover/${result.album.id}` : null, title: result.album.title, year: null, aspect: "square" };
  }
  if (result.status === "not_owned" && result.type === "film") {
    return { src: result.candidate.posterPath ? `/api/poster/w154${result.candidate.posterPath}` : null, title: result.candidate.title, year: result.candidate.year, aspect: "poster" };
  }
  if (result.status === "not_owned" && result.type === "album") {
    return { src: result.candidate.coverArtUrl, title: result.candidate.title, year: result.candidate.year, aspect: "square" };
  }
  return { src: null, title: "?", year: null, aspect: "poster" };
}

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null);
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [flash, setFlash] = useState(false);
  const [barcode, setBarcode] = useState<string | null>(null);
  const [manualBarcode, setManualBarcode] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [filmMedium, setFilmMedium] = useState<(typeof FILM_MEDIA)[number]>("BLURAY");
  const [albumMedium, setAlbumMedium] = useState<(typeof ALBUM_MEDIA)[number]>("CD");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ href: string; label: string } | null>(null);

  // "Search by title" — a first-class alternative to scanning, not just a
  // fallback shown after a failed barcode (see runTitleSearch).
  const [searchType, setSearchType] = useState<"film" | "album">("film");
  const [searchTitle, setSearchTitle] = useState("");
  const [searchArtist, setSearchArtist] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchCandidate[] | null>(null);
  const [searchAdded, setSearchAdded] = useState<Record<string, { href: string; label: string }>>({});
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueLoaded, setQueueLoaded] = useState(false);
  const processingRef = useRef(false);

  // Load the queue once on mount (client-only — localStorage isn't
  // available during SSR) and persist it on every change after that, so a
  // scanning session (a shelf of discs) survives a reload or closed tab.
  // queueLoaded gates the save effect: both effects fire on the same
  // initial mount, in order, and without this guard the save effect's
  // first run would still close over the pre-load `queue` ([]) and
  // immediately overwrite whatever was in storage before the load ever
  // gets applied — a ref flag doesn't fix this (its mutation doesn't force
  // a fresh closure the way a state dependency does).
  useEffect(() => {
    setQueue(loadQueue());
    setQueueLoaded(true);
  }, []);
  useEffect(() => {
    if (!queueLoaded) return;
    saveQueue(queue);
  }, [queue, queueLoaded]);

  const lookup = useCallback(async (code: string) => {
    setBarcode(code);
    setResult(null);
    setLookupError(null);
    setAdded(null);
    setLookingUp(true);
    try {
      const res = await fetch("/api/barcode/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data as LookupResult);
      if (data.status === "not_owned" && data.type === "album") {
        setAlbumMedium(guessAlbumMedium(data.candidate.format));
      }
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLookingUp(false);
    }
  }, []);

  const queueScan = useCallback((code: string) => {
    setQueue((prev) => (prev.some((q) => q.barcode === code) ? prev : [...prev, { barcode: code, status: "pending" }]));
    setFlash(true);
    setTimeout(() => setFlash(false), 400);
  }, []);

  // Camera scan loop. Single mode: stops on a decode and hands off to
  // lookup() (paused while a result is showing, re-armed by resetScan()).
  // Batch mode: keeps running continuously — each decode just queues the
  // barcode (deduped) so the user can scan a stack of discs back-to-back
  // without waiting on a lookup between each one.
  useEffect(() => {
    if (mode === "single" && barcode !== null) return; // showing a lookup result — camera stays off

    let cancelled = false;

    (async () => {
      try {
        const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
          import("@zxing/browser"),
          import("@zxing/library"),
        ]);
        if (cancelled) return;

        // Restricting to retail barcode formats (rather than zxing's full
        // default set, which also tries QR/PDF417/Aztec/etc. every frame)
        // and TRY_HARDER meaningfully improved real-world hit rate — the
        // default config frequently failed to decode a UPC/EAN held at a
        // normal scanning distance.
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.UPC_A,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_E,
        ]);
        hints.set(DecodeHintType.TRY_HARDER, true);

        const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 200 });
        setScanning(true);
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } } },
          videoRef.current!,
          (res) => {
            if (!res) return;
            const code = res.getText();
            if (mode === "batch") {
              queueScan(code);
            } else {
              controlsRef.current?.stop();
              setScanning(false);
              lookup(code);
            }
          },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
      } catch (err) {
        if (!cancelled) {
          setCameraError(
            err instanceof Error ? err.message : "Couldn't access the camera — check browser permissions.",
          );
          setScanning(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, barcode === null]);

  // Batch queue processor — one lookup in flight at a time (polite to the
  // free MusicBrainz/UPCitemdb tiers), picks up the next "pending" item
  // whenever the queue changes. Runs regardless of which mode is active, so
  // a backlog keeps draining even after switching back to single-scan mode.
  //
  // processingRef (not state) guards re-entrancy: marking an item
  // "looking_up" via setQueue is itself a `queue` change, which re-fires
  // this effect before the fetch resolves. A `cancelled` flag tied to the
  // effect's own cleanup looked like the obvious guard, but the re-fire
  // triggers that very cleanup on the in-flight closure and cancels the
  // fetch that's still running — the item then sits at "looking_up"
  // forever, no new fetch ever starts. A ref sidesteps this: setting it
  // doesn't schedule a re-render, so the fetch already in flight is never
  // implicitly cancelled by its own start.
  useEffect(() => {
    if (processingRef.current) return;
    const next = queue.find((q) => q.status === "pending");
    if (!next) return;

    processingRef.current = true;
    setQueue((prev) => prev.map((q) => (q.barcode === next.barcode ? { ...q, status: "looking_up" } : q)));

    (async () => {
      try {
        const res = await fetch("/api/barcode/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode: next.barcode }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setQueue((prev) =>
          prev.map((q) => (q.barcode === next.barcode ? { ...q, status: "resolved", result: data as LookupResult } : q)),
        );
      } catch (err) {
        setQueue((prev) =>
          prev.map((q) =>
            q.barcode === next.barcode
              ? { ...q, status: "error", error: err instanceof Error ? err.message : "Lookup failed" }
              : q,
          ),
        );
      } finally {
        processingRef.current = false;
      }
    })();
  }, [queue]);

  const resetScan = () => {
    setBarcode(null);
    setResult(null);
    setLookupError(null);
    setAdded(null);
  };

  const addFilm = async (candidate: FilmCandidate) => {
    setAdding(true);
    try {
      const res = await fetch("/api/barcode/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "film", tmdbId: candidate.tmdbId, medium: filmMedium, barcode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAdded({ href: `/film/${data.film.id}`, label: candidate.title });
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setAdding(false);
    }
  };

  const addAlbum = async (candidate: AlbumCandidate) => {
    setAdding(true);
    try {
      const res = await fetch("/api/barcode/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "album", mbid: candidate.mbid, medium: albumMedium, barcode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAdded({ href: `/music/album/${data.album.id}`, label: candidate.title });
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setAdding(false);
    }
  };

  const addQueueItemFilm = async (item: QueueItem, candidate: FilmCandidate, medium: string) => {
    try {
      const res = await fetch("/api/barcode/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "film", tmdbId: candidate.tmdbId, medium, barcode: item.barcode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setQueue((prev) =>
        prev.map((q) => (q.barcode === item.barcode ? { ...q, added: { href: `/film/${data.film.id}`, label: candidate.title } } : q)),
      );
    } catch (err) {
      setQueue((prev) =>
        prev.map((q) => (q.barcode === item.barcode ? { ...q, error: err instanceof Error ? err.message : "Add failed" } : q)),
      );
    }
  };

  const addQueueItemAlbum = async (item: QueueItem, candidate: AlbumCandidate, medium: string) => {
    try {
      const res = await fetch("/api/barcode/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "album", mbid: candidate.mbid, medium, barcode: item.barcode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setQueue((prev) =>
        prev.map((q) =>
          q.barcode === item.barcode ? { ...q, added: { href: `/music/album/${data.album.id}`, label: candidate.title } } : q,
        ),
      );
    } catch (err) {
      setQueue((prev) =>
        prev.map((q) => (q.barcode === item.barcode ? { ...q, error: err instanceof Error ? err.message : "Add failed" } : q)),
      );
    }
  };

  const removeQueueItem = (code: string) => setQueue((prev) => prev.filter((q) => q.barcode !== code));
  const retryQueueItem = (code: string) =>
    setQueue((prev) => prev.map((q) => (q.barcode === code ? { barcode: code, status: "pending" } : q)));
  const clearResolvedQueueItems = () =>
    setQueue((prev) => prev.filter((q) => q.status === "pending" || q.status === "looking_up"));

  const runTitleSearch = async () => {
    if (!searchTitle.trim()) return;
    setSearching(true);
    setSearchError(null);
    setSearchResults(null);
    try {
      if (searchType === "film") {
        const res = await fetch("/api/barcode/search-movie", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: searchTitle.trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setSearchResults((data.results as FilmCandidate[]).map((c) => ({ kind: "film" as const, candidate: c })));
      } else {
        const res = await fetch("/api/barcode/search-album", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: searchTitle.trim(), artist: searchArtist.trim() || undefined }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setSearchResults((data.results as AlbumCandidate[]).map((c) => ({ kind: "album" as const, candidate: c })));
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const addSearchFilm = async (c: FilmCandidate) => {
    setAddingKey(String(c.tmdbId));
    try {
      const res = await fetch("/api/barcode/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "film", tmdbId: c.tmdbId, medium: filmMedium }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSearchAdded((prev) => ({ ...prev, [String(c.tmdbId)]: { href: `/film/${data.film.id}`, label: c.title } }));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setAddingKey(null);
    }
  };

  const addSearchAlbum = async (c: AlbumCandidate) => {
    setAddingKey(c.mbid);
    try {
      const res = await fetch("/api/barcode/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "album", mbid: c.mbid, medium: albumMedium }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSearchAdded((prev) => ({ ...prev, [c.mbid]: { href: `/music/album/${data.album.id}`, label: c.title } }));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setAddingKey(null);
    }
  };

  const pendingCount = queue.filter((q) => q.status === "pending" || q.status === "looking_up").length;
  const doneCount = queue.length - pendingCount;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-8 sm:px-6">
      <h1 className="font-display text-2xl tracking-wide">Scan a barcode</h1>
      <p className="text-sm text-text-muted">
        Point your camera at a DVD, Blu-ray, CD or vinyl barcode to check whether it&rsquo;s already in your
        collection, or add it.
      </p>

      <div className="flex items-center gap-1.5" role="group" aria-label="Scan mode">
        {(
          [
            { key: "single", label: "Single scan" },
            { key: "batch", label: "Batch scan" },
          ] as const
        ).map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMode(m.key)}
            aria-pressed={mode === m.key}
            className={`inline-flex min-h-10 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium tracking-wide transition-colors sm:min-h-0 ${
              mode === m.key
                ? "border-accent-border bg-accent-dim text-accent"
                : "border-border text-text-muted hover:border-border-strong hover:text-text"
            }`}
          >
            {m.label}
          </button>
        ))}
        {mode === "batch" && (
          <span className="ml-1 text-xs text-text-faint">Scanning queues discs — lookups run in the background.</span>
        )}
      </div>

      {mode === "single" && !barcode && (
        <div className="flex flex-col gap-3">
          <div className="relative aspect-square w-full overflow-hidden rounded-lg border border-border bg-black">
            <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
            {!scanning && !cameraError && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-text-faint">
                Starting camera…
              </div>
            )}
          </div>

          {cameraError && (
            <div className="rounded-md border border-missing-border bg-missing-bg p-3 text-xs text-missing">
              {cameraError} You can still type a barcode manually below.
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (manualBarcode.trim()) lookup(manualBarcode.trim());
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              inputMode="numeric"
              value={manualBarcode}
              onChange={(e) => setManualBarcode(e.target.value)}
              placeholder="Or type a barcode"
              className="flex-1 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
            />
            <button
              type="submit"
              disabled={!manualBarcode.trim()}
              className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-3 py-1 text-sm font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
            >
              Look up
            </button>
          </form>
        </div>
      )}

      {mode === "batch" && (
        <div className="flex flex-col gap-3">
          <div className="relative aspect-square w-full overflow-hidden rounded-lg border border-border bg-black">
            <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
            {!scanning && !cameraError && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-text-faint">
                Starting camera…
              </div>
            )}
            {flash && <div className="absolute inset-0 animate-pulse bg-accent/25" />}
          </div>

          {cameraError && (
            <div className="rounded-md border border-missing-border bg-missing-bg p-3 text-xs text-missing">
              {cameraError} Switch to Single scan to type barcodes manually instead.
            </div>
          )}

          {queue.length === 0 ? (
            <p className="text-sm text-text-faint">
              Scan discs one after another — each one is added to the queue below and looked up in the
              background.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-text-faint">
                  {queue.length} scanned · {pendingCount} pending{doneCount > 0 ? ` · ${doneCount} done` : ""}
                </p>
                {doneCount > 0 && (
                  <button
                    type="button"
                    onClick={clearResolvedQueueItems}
                    className="text-xs font-medium text-text-muted hover:text-text"
                  >
                    Clear finished
                  </button>
                )}
              </div>

              {queue
                .slice()
                .reverse()
                .map((item) => (
                  <QueueRow
                    key={item.barcode}
                    item={item}
                    filmMedium={filmMedium}
                    setFilmMedium={setFilmMedium}
                    albumMedium={albumMedium}
                    setAlbumMedium={setAlbumMedium}
                    onAddFilm={(c) => addQueueItemFilm(item, c, filmMedium)}
                    onAddAlbum={(c) => addQueueItemAlbum(item, c, albumMedium)}
                    onRemove={() => removeQueueItem(item.barcode)}
                    onRetry={() => retryQueueItem(item.barcode)}
                  />
                ))}
            </div>
          )}
        </div>
      )}

      {mode === "single" && barcode && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-text-faint">{barcode}</span>
            <button
              type="button"
              onClick={resetScan}
              className="text-xs font-medium text-text-muted hover:text-text"
            >
              Scan another
            </button>
          </div>

          {lookingUp && (
            <p className="text-sm text-text-muted">
              Looking up… movie matches can take up to a minute on the free lookup tier.
            </p>
          )}
          {lookupError && <p className="text-sm text-missing">{lookupError}</p>}

          {result?.status === "owned" && result.type === "film" && (
            <div className="flex items-center gap-3">
              <Thumb
                src={result.film.posterPath ? `/api/poster/w154${result.film.posterPath}` : null}
                title={result.film.title}
                year={result.film.year}
              />
              <div className="flex-1">
                <p className="text-sm font-semibold text-text">Already in your collection</p>
                <Link href={`/film/${result.film.id}`} className="text-sm text-accent hover:underline">
                  {result.film.title} {result.film.year ? `(${result.film.year})` : ""}
                </Link>
              </div>
            </div>
          )}

          {result?.status === "owned" && result.type === "album" && (
            <div className="flex items-center gap-3">
              <Thumb
                src={result.album.coverPath ? `/api/cover/${result.album.id}` : null}
                title={result.album.title}
                aspect="square"
              />
              <div className="flex-1">
                <p className="text-sm font-semibold text-text">Already in your collection</p>
                <Link href={`/music/album/${result.album.id}`} className="text-sm text-accent hover:underline">
                  {result.album.artistName} — {result.album.title}
                </Link>
              </div>
            </div>
          )}

          {result?.status === "not_owned" && result.type === "film" && !added && (
            <div className="flex items-start gap-3">
              <Thumb
                src={result.candidate.posterPath ? `/api/poster/w154${result.candidate.posterPath}` : null}
                title={result.candidate.title}
                year={result.candidate.year}
              />
              <div className="flex flex-1 flex-col gap-2">
                <p className="text-sm text-text">
                  Not owned yet: <span className="font-semibold">{result.candidate.title}</span>{" "}
                  {result.candidate.year ? `(${result.candidate.year})` : ""}
                </p>
                <div className="flex items-center gap-2">
                  <select
                    value={filmMedium}
                    onChange={(e) => setFilmMedium(e.target.value as (typeof FILM_MEDIA)[number])}
                    className="rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-sm text-text"
                  >
                    {FILM_MEDIA.map((m) => (
                      <option key={m} value={m}>
                        {formatLabel(m)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={adding}
                    onClick={() => addFilm(result.candidate)}
                    className="inline-flex min-h-10 flex-1 items-center justify-center rounded-md border border-accent px-3 py-1 text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                  >
                    {adding ? "Adding…" : "Add to collection"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {result?.status === "not_owned" && result.type === "album" && !added && (
            <div className="flex items-start gap-3">
              <Thumb src={result.candidate.coverArtUrl} title={result.candidate.title} aspect="square" />
              <div className="flex flex-1 flex-col gap-2">
                <p className="text-sm text-text">
                  Not owned yet:{" "}
                  <span className="font-semibold">
                    {result.candidate.artistName} — {result.candidate.title}
                  </span>{" "}
                  {result.candidate.year ? `(${result.candidate.year})` : ""}
                </p>
                <div className="flex items-center gap-2">
                  <select
                    value={albumMedium}
                    onChange={(e) => setAlbumMedium(e.target.value as (typeof ALBUM_MEDIA)[number])}
                    className="rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-sm text-text"
                  >
                    {ALBUM_MEDIA.map((m) => (
                      <option key={m} value={m}>
                        {m === "VINYL" ? "Vinyl" : "CD"}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={adding}
                    onClick={() => addAlbum(result.candidate)}
                    className="inline-flex min-h-10 flex-1 items-center justify-center rounded-md border border-accent px-3 py-1 text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                  >
                    {adding ? "Adding…" : "Add to collection"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {added && (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-semibold text-text">Added to your collection</p>
              <Link href={added.href} className="text-sm text-accent hover:underline">
                View {added.label}
              </Link>
            </div>
          )}

          {result?.status === "unknown" && (
            <p className="text-sm text-text-muted">
              Couldn&rsquo;t identify that barcode — try &ldquo;Search by title&rdquo; below.
            </p>
          )}
        </div>
      )}

      {mode === "single" && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-elevated p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text">Search by title</h2>
            <div className="flex items-center gap-1.5" role="group" aria-label="Search type">
              {(
                [
                  { key: "film", label: "Movie" },
                  { key: "album", label: "Album" },
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => {
                    setSearchType(t.key);
                    setSearchResults(null);
                    setSearchError(null);
                  }}
                  aria-pressed={searchType === t.key}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium tracking-wide transition-colors ${
                    searchType === t.key
                      ? "border-accent-border bg-accent-dim text-accent"
                      : "border-border text-text-muted hover:border-border-strong hover:text-text"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              runTitleSearch();
            }}
            className="flex flex-col gap-2 sm:flex-row"
          >
            <input
              type="text"
              value={searchTitle}
              onChange={(e) => setSearchTitle(e.target.value)}
              placeholder={searchType === "film" ? "Movie title" : "Album title"}
              className="flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
            />
            {searchType === "album" && (
              <input
                type="text"
                value={searchArtist}
                onChange={(e) => setSearchArtist(e.target.value)}
                placeholder="Artist (optional)"
                className="flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
              />
            )}
            <button
              type="submit"
              disabled={searching || !searchTitle.trim()}
              className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-3 py-1 text-sm font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </form>

          {searchError && <p className="text-xs text-missing">{searchError}</p>}

          {searchResults && (
            <div className="flex flex-col gap-2">
              {searchResults.length === 0 && <p className="text-xs text-text-faint">No matches found.</p>}
              {searchResults.map((r) => {
                const key = r.kind === "film" ? String(r.candidate.tmdbId) : r.candidate.mbid;
                const rowAdded = searchAdded[key];
                const thumbSrc =
                  r.kind === "film"
                    ? r.candidate.posterPath
                      ? `/api/poster/w154${r.candidate.posterPath}`
                      : null
                    : r.candidate.coverArtUrl;

                return (
                  <div key={key} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Thumb src={thumbSrc} title={r.candidate.title} year={r.candidate.year} aspect={r.kind === "film" ? "poster" : "square"} />
                      <span className="text-sm text-text">
                        {r.kind === "album" ? `${r.candidate.artistName} — ` : ""}
                        {r.candidate.title} {r.candidate.year ? `(${r.candidate.year})` : ""}
                      </span>
                    </div>

                    {rowAdded ? (
                      <Link href={rowAdded.href} className="text-xs text-accent hover:underline">
                        Added — view
                      </Link>
                    ) : (
                      <div className="flex items-center gap-2">
                        {r.kind === "film" ? (
                          <select
                            value={filmMedium}
                            onChange={(e) => setFilmMedium(e.target.value as (typeof FILM_MEDIA)[number])}
                            className="rounded-md border border-border bg-bg-elevated px-1.5 py-1 text-xs text-text"
                          >
                            {FILM_MEDIA.map((m) => (
                              <option key={m} value={m}>
                                {formatLabel(m)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <select
                            value={albumMedium}
                            onChange={(e) => setAlbumMedium(e.target.value as (typeof ALBUM_MEDIA)[number])}
                            className="rounded-md border border-border bg-bg-elevated px-1.5 py-1 text-xs text-text"
                          >
                            {ALBUM_MEDIA.map((m) => (
                              <option key={m} value={m}>
                                {m === "VINYL" ? "Vinyl" : "CD"}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          disabled={addingKey === key}
                          onClick={() => (r.kind === "film" ? addSearchFilm(r.candidate) : addSearchAlbum(r.candidate))}
                          className="rounded-md border border-accent px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {addingKey === key ? "Adding…" : "Add"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One row in the batch queue — barcode, thumbnail once resolved, and
// whatever action its current status calls for. Kept deliberately simpler
// than the single-scan result panel: an unresolved ("unknown") barcode here
// just points the user at Single scan's fuller manual-search flow rather
// than duplicating it per row.
function QueueRow({
  item,
  filmMedium,
  setFilmMedium,
  albumMedium,
  setAlbumMedium,
  onAddFilm,
  onAddAlbum,
  onRemove,
  onRetry,
}: {
  item: QueueItem;
  filmMedium: (typeof FILM_MEDIA)[number];
  setFilmMedium: (m: (typeof FILM_MEDIA)[number]) => void;
  albumMedium: (typeof ALBUM_MEDIA)[number];
  setAlbumMedium: (m: (typeof ALBUM_MEDIA)[number]) => void;
  onAddFilm: (candidate: FilmCandidate) => void;
  onAddAlbum: (candidate: AlbumCandidate) => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const [adding, setAdding] = useState(false);

  const handleAddFilm = async (c: FilmCandidate) => {
    setAdding(true);
    await onAddFilm(c);
    setAdding(false);
  };
  const handleAddAlbum = async (c: AlbumCandidate) => {
    setAdding(true);
    await onAddAlbum(c);
    setAdding(false);
  };

  const thumb = item.result && item.status === "resolved" ? thumbFor(item.result) : null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-bg-elevated p-3">
      {thumb ? (
        <Thumb src={thumb.src} title={thumb.title} year={thumb.year} aspect={thumb.aspect} />
      ) : (
        <div className="flex aspect-2/3 w-14 shrink-0 items-center justify-center rounded border border-border bg-bg text-text-faint">
          <span className="text-[10px]">···</span>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-[11px] text-text-faint">{item.barcode}</span>

        {item.status === "pending" && <p className="text-xs text-text-muted">Queued…</p>}
        {item.status === "looking_up" && <p className="text-xs text-text-muted">Looking up…</p>}

        {item.status === "error" && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-missing">{item.error ?? "Lookup failed"}</p>
            <button type="button" onClick={onRetry} className="text-xs font-medium text-accent hover:underline">
              Retry
            </button>
          </div>
        )}

        {item.status === "resolved" && item.result?.status === "owned" && item.result.type === "film" && (
          <Link href={`/film/${item.result.film.id}`} className="text-sm text-accent hover:underline">
            Already owned — {item.result.film.title}
          </Link>
        )}
        {item.status === "resolved" && item.result?.status === "owned" && item.result.type === "album" && (
          <Link href={`/music/album/${item.result.album.id}`} className="text-sm text-accent hover:underline">
            Already owned — {item.result.album.artistName} — {item.result.album.title}
          </Link>
        )}

        {item.status === "resolved" && item.result?.status === "unknown" && (
          <p className="text-xs text-text-faint">Couldn&rsquo;t identify — try Single scan to search by title.</p>
        )}

        {item.added && (
          <Link href={item.added.href} className="text-sm text-accent hover:underline">
            Added — {item.added.label}
          </Link>
        )}

        {!item.added && item.status === "resolved" && item.result?.status === "not_owned" && item.result.type === "film" && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-text">{item.result.candidate.title} {item.result.candidate.year ? `(${item.result.candidate.year})` : ""}</span>
            <div className="flex items-center gap-1.5">
              <select
                value={filmMedium}
                onChange={(e) => setFilmMedium(e.target.value as (typeof FILM_MEDIA)[number])}
                className="rounded border border-border bg-bg px-1.5 py-1 text-xs text-text"
              >
                {FILM_MEDIA.map((m) => (
                  <option key={m} value={m}>
                    {formatLabel(m)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={adding}
                onClick={() => item.result?.status === "not_owned" && item.result.type === "film" && handleAddFilm(item.result.candidate)}
                className="rounded border border-accent px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {adding ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        )}

        {!item.added && item.status === "resolved" && item.result?.status === "not_owned" && item.result.type === "album" && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-text">
              {item.result.candidate.artistName} — {item.result.candidate.title}
            </span>
            <div className="flex items-center gap-1.5">
              <select
                value={albumMedium}
                onChange={(e) => setAlbumMedium(e.target.value as (typeof ALBUM_MEDIA)[number])}
                className="rounded border border-border bg-bg px-1.5 py-1 text-xs text-text"
              >
                {ALBUM_MEDIA.map((m) => (
                  <option key={m} value={m}>
                    {m === "VINYL" ? "Vinyl" : "CD"}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={adding}
                onClick={() => item.result?.status === "not_owned" && item.result.type === "album" && handleAddAlbum(item.result.candidate)}
                className="rounded border border-accent px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {adding ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.barcode} from queue`}
        className="shrink-0 text-text-faint hover:text-text"
      >
        ×
      </button>
    </div>
  );
}

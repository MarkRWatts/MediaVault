"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatLabel } from "@/lib/constants";
import NoPoster from "@/components/NoPoster";

// --- API response shapes (mirror src/app/api/barcode/*, src/app/api/scan-queue/*) ---

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
type AddedRef = { href: string; label: string };

const FILM_MEDIA = ["BLURAY", "DVD", "UHD"] as const;
const ALBUM_MEDIA = ["CD", "VINYL"] as const;
const QUEUE_POLL_MS = 2500;

function guessAlbumMedium(format: string | null): "CD" | "VINYL" {
  return format?.toLowerCase().includes("vinyl") ? "VINYL" : "CD";
}

type MediaType = "auto" | "film" | "album";

// A row from ScanQueueItem (prisma/schema.prisma) — the persistent,
// cross-device worklist. Unlike the old localStorage-backed queue, adding a
// barcode to the collection deletes its row server-side (see
// /api/scan-queue/[id]) rather than tagging it "added" locally, so there's
// no separate `added` field here — a resolved item just disappears once
// it's actually in the collection.
interface QueueItem {
  id: number;
  barcode: string;
  mediaType: MediaType;
  status: "pending" | "looking_up" | "resolved" | "error";
  result?: LookupResult;
  error?: string;
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

// Add one candidate (from a title search) to the collection. Shared by the
// top-level "Search by title" panel and each queue row's correction widget
// — `barcode` is only set for the latter, so the barcode gets attached to
// the FilmPhysicalCopy/PhysicalCopy row same as an auto-resolved match.
async function addCandidate(
  candidate: SearchCandidate,
  medium: string,
  barcode?: string,
): Promise<AddedRef> {
  const body =
    candidate.kind === "film"
      ? { type: "film", tmdbId: candidate.candidate.tmdbId, medium, barcode }
      : { type: "album", mbid: candidate.candidate.mbid, medium, barcode };
  const res = await fetch("/api/barcode/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return candidate.kind === "film"
    ? { href: `/film/${data.film.id}`, label: candidate.candidate.title }
    : { href: `/music/album/${data.album.id}`, label: candidate.candidate.title };
}

// "Search by title" — a first-class alternative to scanning (top-level
// panel), and a per-row correction tool for a wrong or unresolved batch
// scan (an auto barcode-derived title guess is inherently less trustworthy
// than one the user typed themselves — see searchMovieByTitleYear's
// comment in src/lib/tmdb.ts). onAdd resolves once the pick is actually
// saved; the caller decides what happens next (top-level: just show
// "Added"; a queue row: remove itself from the queue).
function TitleSearchWidget({
  defaultType,
  barcode,
  onAdded,
}: {
  defaultType: "film" | "album";
  barcode?: string;
  onAdded?: (added: AddedRef) => void;
}) {
  const [searchType, setSearchType] = useState<"film" | "album">(defaultType);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchCandidate[] | null>(null);
  const [filmMedium, setFilmMedium] = useState<(typeof FILM_MEDIA)[number]>("BLURAY");
  const [albumMedium, setAlbumMedium] = useState<(typeof ALBUM_MEDIA)[number]>("CD");
  const [addedMap, setAddedMap] = useState<Record<string, AddedRef>>({});
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const runSearch = async () => {
    if (!title.trim()) return;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      if (searchType === "film") {
        const res = await fetch("/api/barcode/search-movie", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setResults((data.results as FilmCandidate[]).map((c) => ({ kind: "film" as const, candidate: c })));
      } else {
        const res = await fetch("/api/barcode/search-album", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), artist: artist.trim() || undefined }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setResults((data.results as AlbumCandidate[]).map((c) => ({ kind: "album" as const, candidate: c })));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const handleAdd = async (r: SearchCandidate) => {
    const key = r.kind === "film" ? String(r.candidate.tmdbId) : r.candidate.mbid;
    setAddingKey(key);
    setError(null);
    try {
      const added = await addCandidate(r, r.kind === "film" ? filmMedium : albumMedium, barcode);
      setAddedMap((prev) => ({ ...prev, [key]: added }));
      onAdded?.(added);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setAddingKey(null);
    }
  };

  return (
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
                setResults(null);
                setError(null);
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
          runSearch();
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={searchType === "film" ? "Movie title" : "Album title"}
          className="flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
        />
        {searchType === "album" && (
          <input
            type="text"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder="Artist (optional)"
            className="flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
          />
        )}
        <button
          type="submit"
          disabled={searching || !title.trim()}
          className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-3 py-1 text-sm font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p className="text-xs text-missing">{error}</p>}

      {results && (
        <div className="flex flex-col gap-2">
          {results.length === 0 && <p className="text-xs text-text-faint">No matches found.</p>}
          {results.map((r) => {
            const key = r.kind === "film" ? String(r.candidate.tmdbId) : r.candidate.mbid;
            const rowAdded = addedMap[key];
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
                      onClick={() => handleAdd(r)}
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
  );
}

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null);
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [mediaType, setMediaType] = useState<MediaType>("auto");
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
  const [added, setAdded] = useState<AddedRef | null>(null);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const processingRef = useRef(false);

  // The camera-decode callback closes over lookup/queueScan once when the
  // scan loop starts (see the effect below) and doesn't re-capture them on
  // every mediaType change — a ref keeps the type it reads current without
  // needing to restart the camera just to pick up a mid-session switch.
  const mediaTypeRef = useRef<MediaType>("auto");
  useEffect(() => {
    mediaTypeRef.current = mediaType;
  }, [mediaType]);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/scan-queue");
      const data = await res.json();
      setQueue(data.items ?? []);
    } catch {
      // transient network hiccup — the next poll (or manual action) retries
    }
  }, []);

  // The scan queue is server-side (ScanQueueItem), not per-browser
  // localStorage — a phone mid-scan and a desktop reviewing results see the
  // same list. Fetch once on mount (inline here, rather than delegating to
  // fetchQueue, so the setState call is visibly scoped to this effect's own
  // cleanup — mirrors AdminStrip's mount fetch), then poll while Batch mode
  // is open so this device picks up items/results another device is adding.
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch("/api/scan-queue");
        const data = await res.json();
        if (!ignore) setQueue(data.items ?? []);
      } catch {
        // transient network hiccup — the poll effect below retries
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);
  useEffect(() => {
    if (mode !== "batch") return;
    const id = setInterval(fetchQueue, QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [mode, fetchQueue]);

  const lookup = useCallback(async (code: string) => {
    setBarcode(code);
    setResult(null);
    setLookupError(null);
    setAdded(null);
    setLookingUp(true);
    try {
      const type = mediaTypeRef.current === "auto" ? undefined : mediaTypeRef.current;
      const res = await fetch("/api/barcode/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode: code, type }),
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
    setFlash(true);
    setTimeout(() => setFlash(false), 400);
    (async () => {
      try {
        const res = await fetch("/api/scan-queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode: code, mediaType: mediaTypeRef.current }),
        });
        const item = await res.json();
        setQueue((prev) => (prev.some((q) => q.barcode === item.barcode) ? prev : [...prev, item]));
      } catch {
        // Best-effort — the row may still have been created server-side even
        // if this response was lost; the next poll picks it up either way.
      }
    })();
  }, []);

  // Camera scan loop. Single mode: stops on a decode and hands off to
  // lookup() (paused while a result is showing, re-armed by resetScan()).
  // Batch mode: keeps running continuously — each decode just queues the
  // barcode (deduped server-side) so the user can scan a stack of discs
  // back-to-back without waiting on a lookup between each one.
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

  // Batch queue processor — ticks /api/scan-queue/process, which does the
  // actual work server-side (and atomically claims the row, so two devices
  // ticking at once can't double-process it — see that route). This effect
  // just decides WHEN to tick: whenever this device sees a pending item.
  // processingRef avoids piling up redundant ticks from this client while
  // one is in flight; it's an efficiency guard, not a correctness one — the
  // server-side claim is what actually makes concurrent ticks safe.
  useEffect(() => {
    if (processingRef.current) return;
    if (!queue.some((q) => q.status === "pending")) return;

    processingRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/scan-queue/process", { method: "POST" });
        const data = await res.json();
        if (data.item) {
          setQueue((prev) => prev.map((q) => (q.id === data.item.id ? data.item : q)));
        }
      } catch {
        // next poll (or the next pending item triggering this effect again)
        // will retry
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
      const added = await addCandidate({ kind: "film", candidate }, filmMedium, barcode ?? undefined);
      setAdded(added);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setAdding(false);
    }
  };

  const addAlbum = async (candidate: AlbumCandidate) => {
    setAdding(true);
    try {
      const added = await addCandidate({ kind: "album", candidate }, albumMedium, barcode ?? undefined);
      setAdded(added);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setAdding(false);
    }
  };

  // A queue item is fully handled once its barcode is actually in the
  // collection — delete the server row (so it doesn't come back on the next
  // poll/device) and drop it locally.
  const removeQueueItem = async (id: number) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
    try {
      await fetch(`/api/scan-queue/${id}`, { method: "DELETE" });
    } catch {
      fetchQueue(); // reconcile — the row may still exist server-side
    }
  };

  const addQueueItem = async (item: QueueItem, candidate: SearchCandidate, medium: string) => {
    const added = await addCandidate(candidate, medium, item.barcode);
    await removeQueueItem(item.id);
    return added;
  };

  const retryQueueItem = async (id: number) => {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, status: "pending", result: undefined, error: undefined } : q)));
    try {
      const res = await fetch(`/api/scan-queue/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry" }),
      });
      const item = await res.json();
      setQueue((prev) => prev.map((q) => (q.id === id ? item : q)));
    } catch {
      fetchQueue();
    }
  };

  // Only sweeps items with nothing left to decide — an already-owned match
  // needs no further action, so it's safe to clear. Not-owned/unknown/error
  // items stay (that's the whole point of a persistent worklist: they need
  // an Add or a correction, not to quietly vanish).
  const clearResolvedQueueItems = async () => {
    const clearable = queue.filter((q) => q.status === "resolved" && q.result?.status === "owned");
    setQueue((prev) => prev.filter((q) => !clearable.some((c) => c.id === q.id)));
    await Promise.all(clearable.map((q) => fetch(`/api/scan-queue/${q.id}`, { method: "DELETE" }).catch(() => {})));
  };

  const pendingCount = queue.filter((q) => q.status === "pending" || q.status === "looking_up").length;
  const clearableCount = queue.filter((q) => q.status === "resolved" && q.result?.status === "owned").length;

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

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="What are you adding?">
        <span className="text-xs text-text-faint">Adding:</span>
        {(
          [
            { key: "auto", label: "Either" },
            { key: "film", label: "Films" },
            { key: "album", label: "Music" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setMediaType(t.key)}
            aria-pressed={mediaType === t.key}
            className={`inline-flex min-h-10 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium tracking-wide transition-colors sm:min-h-0 ${
              mediaType === t.key
                ? "border-accent-border bg-accent-dim text-accent"
                : "border-border text-text-muted hover:border-border-strong hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
        {mediaType !== "auto" && (
          <span className="text-xs text-text-faint">
            Skips the {mediaType === "film" ? "music" : "movie"} lookup — faster for a stack of the same type.
          </span>
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
              background. The queue is shared across devices, so it&rsquo;s still here if you check back from
              another browser.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-text-faint">
                  {queue.length} scanned · {pendingCount} pending
                </p>
                {clearableCount > 0 && (
                  <button
                    type="button"
                    onClick={clearResolvedQueueItems}
                    className="text-xs font-medium text-text-muted hover:text-text"
                  >
                    Clear already-owned
                  </button>
                )}
              </div>

              {queue
                .slice()
                .reverse()
                .map((item) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    onAdd={(candidate, medium) => addQueueItem(item, candidate, medium)}
                    onRemove={() => removeQueueItem(item.id)}
                    onRetry={() => retryQueueItem(item.id)}
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

      {mode === "single" && <TitleSearchWidget defaultType="film" />}
    </div>
  );
}

// One row in the batch queue — barcode, thumbnail once resolved, and
// whatever action its current status calls for, plus a "Not right? Search
// by title" toggle available on every non-in-flight status (an auto match
// can be wrong, not just missing — see the misidentification note in
// searchMovieByTitleYear).
function QueueRow({
  item,
  onAdd,
  onRemove,
  onRetry,
}: {
  item: QueueItem;
  onAdd: (candidate: SearchCandidate, medium: string) => Promise<AddedRef>;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const [filmMedium, setFilmMedium] = useState<(typeof FILM_MEDIA)[number]>("BLURAY");
  const [albumMedium, setAlbumMedium] = useState<(typeof ALBUM_MEDIA)[number]>("CD");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);

  const handleAdd = async (candidate: SearchCandidate, medium: string) => {
    setAdding(true);
    setAddError(null);
    try {
      await onAdd(candidate, medium);
      // Row disappears once the parent removes it from the queue — nothing
      // else to do here.
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setAdding(false);
    }
  };

  const thumb = item.result && item.status === "resolved" ? thumbFor(item.result) : null;
  const inFlight = item.status === "pending" || item.status === "looking_up";
  const defaultCorrectionType = item.mediaType === "album" ? "album" : "film";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated p-3">
      <div className="flex items-start gap-3">
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
            <p className="text-xs text-text-faint">Couldn&rsquo;t identify this barcode.</p>
          )}

          {item.status === "resolved" && item.result?.status === "not_owned" && item.result.type === "film" && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-text">
                {item.result.candidate.title} {item.result.candidate.year ? `(${item.result.candidate.year})` : ""}
              </span>
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
                  onClick={() =>
                    item.result?.status === "not_owned" &&
                    item.result.type === "film" &&
                    handleAdd({ kind: "film", candidate: item.result.candidate }, filmMedium)
                  }
                  className="rounded border border-accent px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {adding ? "Adding…" : "Add"}
                </button>
              </div>
            </div>
          )}

          {item.status === "resolved" && item.result?.status === "not_owned" && item.result.type === "album" && (
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
                  onClick={() =>
                    item.result?.status === "not_owned" &&
                    item.result.type === "album" &&
                    handleAdd({ kind: "album", candidate: item.result.candidate }, albumMedium)
                  }
                  className="rounded border border-accent px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {adding ? "Adding…" : "Add"}
                </button>
              </div>
            </div>
          )}

          {addError && <p className="text-xs text-missing">{addError}</p>}

          {!inFlight && (
            <button
              type="button"
              onClick={() => setCorrecting((v) => !v)}
              className="w-fit text-xs font-medium text-text-muted hover:text-text"
            >
              {correcting ? "Cancel correction" : "Not right? Search by title"}
            </button>
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

      {correcting && (
        <TitleSearchWidget
          defaultType={defaultCorrectionType}
          barcode={item.barcode}
          onAdded={() => {
            setCorrecting(false);
            onRemove(); // this row's barcode is now correctly attached elsewhere
          }}
        />
      )}
    </div>
  );
}

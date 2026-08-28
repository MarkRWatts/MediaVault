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

const FILM_MEDIA = ["BLURAY", "DVD", "UHD"] as const;
const ALBUM_MEDIA = ["CD", "VINYL"] as const;

function guessAlbumMedium(format: string | null): "CD" | "VINYL" {
  return format?.toLowerCase().includes("vinyl") ? "VINYL" : "CD";
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

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [barcode, setBarcode] = useState<string | null>(null);
  const [manualBarcode, setManualBarcode] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [filmMedium, setFilmMedium] = useState<(typeof FILM_MEDIA)[number]>("BLURAY");
  const [albumMedium, setAlbumMedium] = useState<(typeof ALBUM_MEDIA)[number]>("CD");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ href: string; label: string } | null>(null);

  const [manualTitle, setManualTitle] = useState("");
  const [manualSearching, setManualSearching] = useState(false);
  const [manualResults, setManualResults] = useState<FilmCandidate[] | null>(null);

  const lookup = useCallback(async (code: string) => {
    setBarcode(code);
    setResult(null);
    setLookupError(null);
    setAdded(null);
    setManualResults(null);
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

  // Camera scan loop — starts once on mount, stopped on unmount. Re-armed
  // by resetScan() after a result is handled.
  useEffect(() => {
    if (barcode !== null) return; // showing a lookup result — camera stays off

    let cancelled = false;

    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (cancelled) return;
        const reader = new BrowserMultiFormatReader();
        setScanning(true);
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: "environment" } },
          videoRef.current!,
          (res) => {
            if (res) {
              controlsRef.current?.stop();
              setScanning(false);
              lookup(res.getText());
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
  }, [barcode === null]);

  const resetScan = () => {
    setBarcode(null);
    setResult(null);
    setLookupError(null);
    setAdded(null);
    setManualResults(null);
    setManualTitle("");
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

  const searchManualTitle = async () => {
    if (!manualTitle.trim()) return;
    setManualSearching(true);
    setLookupError(null);
    try {
      const res = await fetch("/api/barcode/search-movie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: manualTitle.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setManualResults(data.results as FilmCandidate[]);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setManualSearching(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-8 sm:px-6">
      <h1 className="font-display text-2xl tracking-wide">Scan a barcode</h1>
      <p className="text-sm text-text-muted">
        Point your camera at a DVD, Blu-ray, CD or vinyl barcode to check whether it&rsquo;s already in your
        collection, or add it.
      </p>

      {!barcode && (
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

      {barcode && (
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
            <div className="flex flex-col gap-2">
              <p className="text-sm text-text-muted">Couldn&rsquo;t identify that barcode.</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  placeholder="Search by movie title instead"
                  className="flex-1 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus-visible:outline-none"
                />
                <button
                  type="button"
                  disabled={manualSearching || !manualTitle.trim()}
                  onClick={searchManualTitle}
                  className="inline-flex min-h-10 items-center justify-center rounded-md border border-border px-3 py-1 text-sm font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                >
                  {manualSearching ? "Searching…" : "Search"}
                </button>
              </div>

              {manualResults && !added && (
                <div className="flex flex-col gap-2">
                  {manualResults.length === 0 && (
                    <p className="text-xs text-text-faint">No matches found.</p>
                  )}
                  {manualResults.map((c) => (
                    <div
                      key={c.tmdbId}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <Thumb src={c.posterPath ? `/api/poster/w154${c.posterPath}` : null} title={c.title} year={c.year} />
                        <span className="text-sm text-text">
                          {c.title} {c.year ? `(${c.year})` : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
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
                        <button
                          type="button"
                          disabled={adding}
                          onClick={() => addFilm(c)}
                          className="rounded-md border border-accent px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

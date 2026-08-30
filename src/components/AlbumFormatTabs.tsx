"use client";

import { useState, type ReactNode } from "react";
import type { AlbumDiscView, PhysicalCopyView } from "@/lib/queries-music";
import AudioCodecBadge from "./AudioCodecBadge";
import AlbumPlayer, { type AlbumPlayerTrack } from "./AlbumPlayer";
import CoverImage from "./CoverImage";
import PhysicalCopyForm from "./PhysicalCopyForm";
import FixAlbumMatchForm from "./FixAlbumMatchForm";
import DigitalSourceForm from "./DigitalSourceForm";
import { qualityLabel } from "@/lib/audio-quality";

function formatDuration(secs: number | null): string {
  if (secs == null) return "—";
  const total = Math.round(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Per-format accent identity — reuses the app's existing distinct-hue chip
// tokens (already turquoise/purple/amber) rather than introducing new ones.
// Digital gets the audio-dts (turquoise) family, vinyl the audio-dolby
// (purple) family, CD the app's own amber accent (reads as orange here),
// and anything else falls back to the neutral dvd tokens.
function colorFor(kind: "digital" | string): { text: string; border: string } {
  if (kind === "digital") return { text: "text-audio-dts", border: "border-audio-dts" };
  if (kind === "VINYL") return { text: "text-audio-dolby", border: "border-audio-dolby" };
  if (kind === "CD") return { text: "text-accent", border: "border-accent" };
  return { text: "text-dvd", border: "border-dvd-border" };
}

function Tile({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-elevated p-3">{children}</div>;
}

function StatTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Tile>
      <span className={`text-[10px] font-semibold uppercase tracking-widest ${color}`}>{label}</span>
      <span className="text-sm text-text">{value || "—"}</span>
    </Tile>
  );
}

function DigitalSummary({
  albumId,
  albumTitle,
  artistName,
  digitalSource,
  discogsUrl,
  trackCount,
  totalSecs,
  dominantCodec,
  dominantQuality,
  playableTracks,
  canPlay,
  drmOnly,
}: {
  albumId: number;
  albumTitle: string;
  artistName: string;
  digitalSource: string | null;
  discogsUrl: string | null;
  trackCount: number;
  totalSecs: number;
  dominantCodec: string | null;
  dominantQuality: string | null;
  playableTracks: AlbumPlayerTrack[];
  canPlay: boolean;
  drmOnly: boolean;
}) {
  const color = colorFor("digital");

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          label="Quality"
          color={color.text}
          value={[dominantCodec?.toUpperCase(), dominantQuality].filter(Boolean).join(" · ")}
        />
        <StatTile
          label="Tracklist"
          color={color.text}
          value={trackCount > 0 ? `${trackCount} track${trackCount === 1 ? "" : "s"} · ${formatDuration(totalSecs)}` : "No tracks"}
        />
        <Tile>
          <DigitalSourceForm albumId={albumId} initial={digitalSource} />
        </Tile>
      </div>

      {canPlay ? (
        <AlbumPlayer albumTitle={albumTitle} artistName={artistName} tracks={playableTracks} />
      ) : drmOnly ? (
        <p className="text-xs text-text-faint">Playback unavailable — FairPlay-protected files.</p>
      ) : null}

      <FixAlbumMatchForm albumId={albumId} currentDiscogsUrl={discogsUrl} />
    </div>
  );
}

function DigitalTracklist({
  discs,
  dominantCodec,
  dominantQuality,
}: {
  discs: AlbumDiscView[];
  dominantCodec: string | null;
  dominantQuality: string | null;
}) {
  const multiDisc = discs.length > 1;

  if (discs.length === 0) {
    return <p className="py-4 text-sm text-text-faint">No track data for this album yet.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {discs.map((disc) => (
        <div key={disc.disc} className="flex flex-col gap-2">
          {multiDisc && (
            <h3 className="font-mono text-xs uppercase tracking-widest text-text-faint">Disc {disc.disc}</h3>
          )}
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated">
            {disc.tracks.map((t) => {
              const trackQuality = qualityLabel(t);
              const differsFromDominant = t.codec !== dominantCodec || trackQuality !== dominantQuality;
              return (
                <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-6 shrink-0 text-right font-mono text-xs text-text-faint">
                    {t.trackNumber != null ? t.trackNumber.toString().padStart(2, "0") : "—"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{t.title}</span>
                  {differsFromDominant && <AudioCodecBadge codec={t.codec} quality={trackQuality} />}
                  <span className="shrink-0 font-mono text-xs text-text-faint">{formatDuration(t.durationSecs)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CopySummary({ albumId, copy }: { albumId: number; copy: PhysicalCopyView }) {
  const color = colorFor(copy.medium);
  const pressingInfo = [copy.catalogNo && `Cat# ${copy.catalogNo}`, copy.label, copy.pressYear]
    .filter(Boolean)
    .join(" · ");
  const noteLine = [copy.condition, copy.inferred && "inferred from rip", copy.notes, copy.barcode && `Barcode ${copy.barcode}`]
    .filter(Boolean)
    .join(" · ");
  const trackCount = copy.tracks.length;
  const totalSecs = copy.tracks.reduce((n, t) => n + (t.durationSecs ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          label="Format"
          color={color.text}
          value={[copy.format, copy.discs && copy.discs > 1 && `${copy.discs} discs`].filter(Boolean).join(" · ")}
        />
        <StatTile label="Pressing" color={color.text} value={pressingInfo} />
        <StatTile
          label="Tracklist"
          color={color.text}
          value={trackCount > 0 ? `${trackCount} track${trackCount === 1 ? "" : "s"} · ${formatDuration(totalSecs)}` : "Not linked yet"}
        />
      </div>

      {(noteLine || copy.discogsUrl) && (
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-text-faint">
          {noteLine && <span>{noteLine}</span>}
          {copy.discogsUrl && (
            <a href={copy.discogsUrl} target="_blank" rel="noreferrer" className={`hover:underline ${color.text}`}>
              View on Discogs ↗
            </a>
          )}
        </div>
      )}

      <PhysicalCopyForm albumId={albumId} medium={copy.medium as "VINYL" | "CD"} initial={copy} />
    </div>
  );
}

function CopyTracklist({ copy }: { copy: PhysicalCopyView }) {
  const trackCount = copy.tracks.length;
  const copyMultiDisc = new Set(copy.tracks.map((t) => t.disc)).size > 1;
  const byDisc = new Map<number, typeof copy.tracks>();
  for (const t of copy.tracks) {
    const arr = byDisc.get(t.disc);
    if (arr) arr.push(t);
    else byDisc.set(t.disc, [t]);
  }

  if (trackCount === 0) {
    return <p className="text-xs text-text-faint">No track data for this pressing — link it above to pull one in.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {Array.from(byDisc.entries())
        .sort(([a], [b]) => a - b)
        .map(([disc, tracks]) => (
          <div key={disc} className="flex flex-col gap-2">
            {copyMultiDisc && (
              <h3 className="font-mono text-xs uppercase tracking-widest text-text-faint">Side/Disc {disc}</h3>
            )}
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated">
              {tracks.map((t, i) => (
                <li key={i} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-6 shrink-0 text-right font-mono text-xs text-text-faint">
                    {t.trackNumber != null ? t.trackNumber.toString().padStart(2, "0") : "—"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{t.title}</span>
                  <span className="shrink-0 font-mono text-xs text-text-faint">{formatDuration(t.durationSecs)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

type Tab =
  | { kind: "digital"; key: string; label: string }
  | { kind: "copy"; key: string; label: string; copy: PhysicalCopyView };

// The format switcher: one tab per owned pressing plus (when the digital
// files themselves are owned) a "Digital" tab, replacing what used to be a
// vertical stack of always-visible per-copy blocks. Each physical tab embeds
// the existing PhysicalCopyForm unchanged — that's already the screen for
// correcting which Discogs release a pressing is linked to (edit fields,
// "Re-check via barcode", "Link a specific pressing") — this component just
// gives each format its own home for it, plus its barcode/Discogs URL and
// track data up front instead of behind an extra click.
//
// Layout mirrors the design mockup: cover art on the left, the album's
// title/tags + this switcher (tab bar, stat tiles, play/correction controls)
// stacked beside it on the right, and the active format's tracklist breaking
// out to the full page width below both — hence taking the title JSX as a
// prop (`meta`) rather than rendering it itself, so the page can lay all
// three regions out in one grid. The cover art itself IS rendered here
// (rather than passed down) because it's part of the switcher: selecting a
// pressing's tab swaps in that pressing's own cover art when it has one
// (falling back to the album's cover otherwise), matching the mockup's
// image switcher.
export default function AlbumFormatTabs({
  meta,
  albumId,
  albumTitle,
  albumHasCover,
  coverVersion,
  artistName,
  owned,
  copies,
  digitalSource,
  discogsUrl,
  discs,
  dominantCodec,
  dominantQuality,
  playableTracks,
  canPlay,
  drmOnly,
}: {
  meta: ReactNode;
  albumId: number;
  albumTitle: string;
  albumHasCover: boolean;
  coverVersion: number | null;
  artistName: string;
  owned: boolean;
  copies: PhysicalCopyView[];
  digitalSource: string | null;
  discogsUrl: string | null;
  discs: AlbumDiscView[];
  dominantCodec: string | null;
  dominantQuality: string | null;
  playableTracks: AlbumPlayerTrack[];
  canPlay: boolean;
  drmOnly: boolean;
}) {
  const formatCounts = new Map<string, number>();
  for (const c of copies) formatCounts.set(c.format, (formatCounts.get(c.format) ?? 0) + 1);
  const formatSeen = new Map<string, number>();

  const tabs: Tab[] = [];
  if (owned) {
    tabs.push({ kind: "digital", key: "digital", label: dominantCodec ? dominantCodec.toUpperCase() : "Digital" });
  }
  for (const copy of copies) {
    const isDup = (formatCounts.get(copy.format) ?? 0) > 1;
    let label = copy.format;
    if (isDup) {
      const seen = (formatSeen.get(copy.format) ?? 0) + 1;
      formatSeen.set(copy.format, seen);
      label = copy.pressYear ? `${copy.format} '${String(copy.pressYear).slice(-2)}` : `${copy.format} #${seen}`;
    }
    tabs.push({ kind: "copy", key: String(copy.id), label, copy });
  }

  const [selected, setSelected] = useState(tabs[0]?.key ?? "");
  const active = tabs.find((t) => t.key === selected) ?? tabs[0];

  const allTracks = discs.flatMap((d) => d.tracks);

  const copyCoverSrc =
    active?.kind === "copy" && active.copy.hasCover ? `/api/physical-cover/${active.copy.id}` : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[16rem_1fr] sm:gap-6">
        <CoverImage
          key={active?.key ?? "cover"}
          albumId={albumHasCover ? albumId : null}
          version={coverVersion}
          title={albumTitle}
          priority
          sizes="(min-width: 640px) 256px, 60vw"
          className="w-40 shrink-0 rounded-lg border border-border-strong shadow-lg shadow-black/40 sm:w-64"
          src={copyCoverSrc}
        />
        <div className="flex flex-col gap-4">
          {meta}

          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border">
            <div className="flex flex-wrap gap-4">
              {tabs.map((tab) => {
                const color = colorFor(tab.kind === "digital" ? "digital" : tab.copy.medium);
                const isActive = tab.key === selected;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setSelected(tab.key)}
                    className={`border-b-2 pb-2 text-sm font-medium transition-colors ${
                      isActive ? `${color.border} ${color.text}` : "border-transparent text-text-muted hover:text-text"
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2 pb-2">
              <PhysicalCopyForm albumId={albumId} medium="VINYL" initial={null} />
              <PhysicalCopyForm albumId={albumId} medium="CD" initial={null} />
            </div>
          </div>

          {active?.kind === "digital" && (
            <DigitalSummary
              albumId={albumId}
              albumTitle={albumTitle}
              artistName={artistName}
              digitalSource={digitalSource}
              discogsUrl={discogsUrl}
              trackCount={allTracks.length}
              totalSecs={allTracks.reduce((n, t) => n + (t.durationSecs ?? 0), 0)}
              dominantCodec={dominantCodec}
              dominantQuality={dominantQuality}
              playableTracks={playableTracks}
              canPlay={canPlay}
              drmOnly={drmOnly}
            />
          )}
          {active?.kind === "copy" && <CopySummary albumId={albumId} copy={active.copy} />}
          {!active && <p className="text-sm text-text-faint">No formats tracked yet — add one above.</p>}
        </div>
      </div>

      {active?.kind === "digital" && (
        <DigitalTracklist discs={discs} dominantCodec={dominantCodec} dominantQuality={dominantQuality} />
      )}
      {active?.kind === "copy" && <CopyTracklist copy={active.copy} />}
    </div>
  );
}

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

const CODEC_DESCRIPTIONS: Record<string, string> = {
  alac: "Apple Lossless (ALAC)",
  flac: "Lossless (FLAC)",
  mp3: "Lossy Compressed (MP3)",
  aac: "Lossy Compressed (AAC)",
  drm: "Protected (FairPlay)",
};

function codecDescription(codec: string | null): string | null {
  if (!codec) return null;
  return CODEC_DESCRIPTIONS[codec.toLowerCase()] ?? codec.toUpperCase();
}

// Resolved disc count for a vinyl copy: the explicit field when set, else
// parsed off a leading "2x"/"2×" in the free-text format ("2xLP"), else 1.
function resolveVinylDiscs(copy: PhysicalCopyView): number {
  if (copy.discs != null) return copy.discs;
  const m = /^(\d+)\s*[x×]/i.exec(copy.format);
  return m ? Number(m[1]) : 1;
}

// Fallback only used when the pressing has no Discogs-sourced speedRpm —
// Discogs itself only states speed for non-default/special-case pressings,
// so this is a coarse guess from the format string, not a real lookup.
function inferSpeedFromFormat(format: string): string | null {
  const f = format.toLowerCase();
  if (f.includes('7"') || f.includes("7-inch") || f.includes("7 inch")) return "45 RPM";
  if (f.includes("lp") || f.includes('12"')) return "33⅓ RPM";
  return null;
}

// Per-format accent identity. Digital and CD get their own dedicated tokens
// (NOT the audio-dts/audio-dolby ones VersionCard uses for real film DTS/
// Dolby badges — reusing those would mean retheming one silently retheme
// the other). Vinyl reuses --accent directly, the app's one shared accent.
function colorFor(kind: "digital" | string): { text: string; border: string } {
  if (kind === "digital") return { text: "text-format-digital", border: "border-format-digital" };
  if (kind === "CD") return { text: "text-format-cd", border: "border-format-cd" };
  if (kind === "VINYL") return { text: "text-accent", border: "border-accent" };
  return { text: "text-dvd", border: "border-dvd-border" };
}

function Tile({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-elevated p-3">{children}</div>;
}

// Pressing tile shared by Digital/CD/LP — content varies (a form vs. static
// text) but all three anchor their Discogs link to the tile's own bottom
// edge, in the tile's per-format color.
function PressingTile({
  color,
  discogsUrl,
  children,
}: {
  color: string;
  discogsUrl: string | null;
  children: ReactNode;
}) {
  return (
    <Tile>
      <span className={`text-[10px] font-semibold uppercase tracking-widest ${color}`}>Pressing</span>
      <div className="flex min-h-16 flex-col justify-between gap-1">
        <div className="flex flex-col">{children}</div>
        {discogsUrl && (
          <a
            href={discogsUrl}
            target="_blank"
            rel="noreferrer"
            className={`w-fit text-xs hover:underline ${color}`}
          >
            View on Discogs ↗
          </a>
        )}
      </div>
    </Tile>
  );
}

function StatTile({
  label,
  lines,
  color,
}: {
  label: string;
  lines: (string | null | undefined | false)[];
  color: string;
}) {
  const visible = lines.filter((l): l is string => Boolean(l));
  return (
    <Tile>
      <span className={`text-[10px] font-semibold uppercase tracking-widest ${color}`}>{label}</span>
      <div className="flex min-h-16 flex-col">
        {visible.length > 0 ? (
          visible.map((line, i) => (
            <span key={i} className="text-sm text-text">
              {line}
            </span>
          ))
        ) : (
          <span className="text-sm text-text">—</span>
        )}
      </div>
    </Tile>
  );
}

function DigitalSummary({
  albumId,
  digitalSource,
  discogsUrl,
  trackCount,
  totalSecs,
  dominantCodec,
  dominantQuality,
  dominantQualityVerbose,
  drmOnly,
}: {
  albumId: number;
  digitalSource: string | null;
  discogsUrl: string | null;
  trackCount: number;
  totalSecs: number;
  dominantCodec: string | null;
  dominantQuality: string | null;
  dominantQualityVerbose: string | null;
  drmOnly: boolean;
}) {
  const color = colorFor("digital");

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          label="Format"
          color={color.text}
          lines={[codecDescription(dominantCodec), dominantQualityVerbose ?? dominantQuality]}
        />
        <StatTile
          label="Track List"
          color={color.text}
          lines={[trackCount > 0 ? `${trackCount} track${trackCount === 1 ? "" : "s"} · ${formatDuration(totalSecs)}` : "No tracks"]}
        />
        <PressingTile color={color.text} discogsUrl={discogsUrl}>
          <DigitalSourceForm albumId={albumId} initial={digitalSource} />
        </PressingTile>
      </div>

      {drmOnly && <p className="text-xs text-text-faint">Playback unavailable — FairPlay-protected files.</p>}

      <FixAlbumMatchForm albumId={albumId} />
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
  // Two explicit lines (not one long joined-and-wrapped string) so the
  // Pressing tile's line count/spacing matches every other tile's, however
  // long the catalog number or label happens to be.
  const pressingLines = [
    [copy.catalogNo && `Cat# ${copy.catalogNo}`, copy.pressYear].filter(Boolean).join(" · "),
    copy.label,
  ].filter((l): l is string => Boolean(l));
  const noteLine = [copy.condition, copy.inferred && "inferred from rip", copy.notes, copy.barcode && `Barcode ${copy.barcode}`]
    .filter(Boolean)
    .join(" · ");
  const trackCount = copy.tracks.length;
  const totalSecs = copy.tracks.reduce((n, t) => n + (t.durationSecs ?? 0), 0);

  let formatLines: (string | null)[];
  if (copy.medium === "CD") {
    formatLines = ["16-bit · 44.1 kHz"];
  } else if (copy.medium === "VINYL") {
    const discsCount = resolveVinylDiscs(copy);
    const speed = copy.speedRpm ?? inferSpeedFromFormat(copy.format);
    formatLines = [[`${discsCount} disc${discsCount === 1 ? "" : "s"}`, speed].filter(Boolean).join(" · ")];
  } else {
    formatLines = [[copy.format, copy.discs && copy.discs > 1 && `${copy.discs} discs`].filter(Boolean).join(" · ")];
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Format" color={color.text} lines={formatLines} />
        <StatTile
          label="Track List"
          color={color.text}
          lines={[trackCount > 0 ? `${trackCount} track${trackCount === 1 ? "" : "s"} · ${formatDuration(totalSecs)}` : "Not linked yet"]}
        />
        <PressingTile color={color.text} discogsUrl={copy.discogsUrl}>
          {pressingLines.length > 0 ? (
            pressingLines.map((line, i) => (
              <span key={i} className="text-sm text-text">
                {line}
              </span>
            ))
          ) : (
            <span className="text-sm text-text">—</span>
          )}
        </PressingTile>
      </div>

      {noteLine && <p className="text-xs text-text-faint">{noteLine}</p>}

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
  dominantQualityVerbose,
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
  dominantQualityVerbose: string | null;
  playableTracks: AlbumPlayerTrack[];
  canPlay: boolean;
  drmOnly: boolean;
}) {
  const formatCounts = new Map<string, number>();
  for (const c of copies) formatCounts.set(c.format, (formatCounts.get(c.format) ?? 0) + 1);
  const formatSeen = new Map<string, number>();

  const tabs: Tab[] = [];
  if (owned) {
    tabs.push({ kind: "digital", key: "digital", label: "Digital" });
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[20rem_1fr] sm:gap-6">
        <CoverImage
          key={active?.key ?? "cover"}
          albumId={albumHasCover ? albumId : null}
          version={coverVersion}
          title={albumTitle}
          priority
          sizes="(min-width: 640px) 320px, 60vw"
          className="w-40 shrink-0 rounded-lg border border-border-strong shadow-lg shadow-black/40 sm:w-80"
          src={copyCoverSrc}
        />
        <div className="flex flex-col gap-3">
          {meta}

          <div className="mt-14 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border">
            <div className="flex flex-wrap gap-4">
              {tabs.map((tab) => {
                const color = colorFor(tab.kind === "digital" ? "digital" : tab.copy.medium);
                const isActive = tab.key === selected;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setSelected(tab.key)}
                    className={`border-b-2 pb-1.5 text-sm font-medium transition-colors ${
                      isActive ? `${color.border} ${color.text}` : "border-transparent text-text-muted hover:text-text"
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2 pb-1.5">
              <PhysicalCopyForm albumId={albumId} medium="VINYL" initial={null} />
              <PhysicalCopyForm albumId={albumId} medium="CD" initial={null} />
            </div>
          </div>

          {active?.kind === "digital" && (
            <DigitalSummary
              albumId={albumId}
              digitalSource={digitalSource}
              discogsUrl={discogsUrl}
              trackCount={allTracks.length}
              totalSecs={allTracks.reduce((n, t) => n + (t.durationSecs ?? 0), 0)}
              dominantCodec={dominantCodec}
              dominantQuality={dominantQuality}
              dominantQualityVerbose={dominantQualityVerbose}
              drmOnly={drmOnly}
            />
          )}
          {active?.kind === "copy" && <CopySummary key={active.copy.id} albumId={albumId} copy={active.copy} />}
          {!active && <p className="text-sm text-text-faint">No formats tracked yet — add one above.</p>}
        </div>
      </div>

      {active?.kind === "digital" && canPlay && (
        <AlbumPlayer
          albumId={albumId}
          albumTitle={albumTitle}
          albumHasCover={albumHasCover}
          coverVersion={coverVersion}
          artistName={artistName}
          tracks={playableTracks}
        />
      )}
      {active?.kind === "digital" && (
        <DigitalTracklist discs={discs} dominantCodec={dominantCodec} dominantQuality={dominantQuality} />
      )}
      {active?.kind === "copy" && <CopyTracklist copy={active.copy} />}
    </div>
  );
}

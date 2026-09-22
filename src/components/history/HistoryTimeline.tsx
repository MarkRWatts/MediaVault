"use client";

// The /history timeline: everything this person has played, newest first,
// under a heading per day. The first page arrives server-rendered with the
// page itself; the pills and "Show more" ask /api/history for the rest.
//
// A pill keeps its own pages rather than filtering the loaded ones, because
// filtering client-side would quietly lie about depth — the first fifty
// mixed events might hold three tracks, and "Music" would then look like a
// three-row history with no way to go further.

import { useState } from "react";
import Link from "next/link";
import { Disc3, Film, Tv } from "lucide-react";
import CoverImage from "@/components/CoverImage";
import PosterImage from "@/components/PosterImage";
import type { HistoryEvent, HistoryKind, HistoryPage } from "@/lib/history";

const FILTERS = [
  { key: "all", label: "All", kind: null },
  { key: "film", label: "Movies", kind: "film" },
  { key: "episode", label: "TV", kind: "episode" },
  { key: "track", label: "Music", kind: "track" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

const KIND_ICON: Record<HistoryKind, typeof Film> = {
  film: Film,
  episode: Tv,
  track: Disc3,
};

const EMPTY_TEXT: Record<FilterKey, string> = {
  all: "Nothing played yet — watch or listen to something and it will show up here.",
  film: "No films played yet.",
  episode: "No episodes played yet.",
  track: "Nothing listened to yet.",
};

/** Consecutive events sharing a day heading. The events already arrive in
 *  order, so one pass is enough — no sorting, no date maths in the browser. */
function groupByDay(events: HistoryEvent[]): { day: string; events: HistoryEvent[] }[] {
  const groups: { day: string; events: HistoryEvent[] }[] = [];
  for (const event of events) {
    const current = groups.at(-1);
    if (current && current.day === event.day) current.events.push(event);
    else groups.push({ day: event.day, events: [event] });
  }
  return groups;
}

function Artwork({ artwork }: { artwork: HistoryEvent["artwork"] }) {
  if (artwork.kind === "cover") {
    return (
      <CoverImage
        albumId={artwork.albumId}
        version={artwork.version}
        title={artwork.title}
        fallback="glyph"
        className="w-12 rounded"
      />
    );
  }
  if (artwork.kind === "still") {
    return (
      <img
        src={`/api/poster/w300${artwork.path}`}
        alt=""
        loading="lazy"
        decoding="async"
        className="w-12 rounded bg-bg-elevated-2"
      />
    );
  }
  return (
    <PosterImage
      posterPath={artwork.path}
      title={artwork.title}
      year={artwork.year}
      className="aspect-2/3 h-12 rounded"
    />
  );
}

function EventRow({ event }: { event: HistoryEvent }) {
  const Icon = KIND_ICON[event.kind];
  return (
    <li className="flex items-center gap-3 p-3">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center">
        <Artwork artwork={event.artwork} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-faint" />
          <Link href={event.href} className="truncate text-sm text-text hover:text-accent">
            {event.title}
          </Link>
        </span>
        {event.detail && (
          <span className="truncate pl-5 font-mono text-[11px] text-text-faint">{event.detail}</span>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        <span className="font-mono text-xs text-text-faint">{event.state}</span>
        <span className="font-mono text-[10px] text-text-faint">{event.time}</span>
      </div>
    </li>
  );
}

export default function HistoryTimeline({ initial }: { initial: HistoryPage }) {
  const [active, setActive] = useState<FilterKey>("all");
  const [pages, setPages] = useState<Partial<Record<FilterKey, HistoryPage>>>({ all: initial });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const page = pages[active];

  async function fetchPage(key: FilterKey, before: string | null) {
    const params = new URLSearchParams();
    const kind = FILTERS.find((f) => f.key === key)!.kind;
    if (kind) params.set("kind", kind);
    if (before) params.set("before", before);

    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/history?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as HistoryPage;
      setPages((prev) => {
        const existing = before ? prev[key] : undefined;
        return {
          ...prev,
          [key]: {
            events: [...(existing?.events ?? []), ...next.events],
            nextCursor: next.nextCursor,
          },
        };
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function selectFilter(key: FilterKey) {
    setActive(key);
    setFailed(false);
    if (!pages[key]) void fetchPage(key, null);
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter history">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => selectFilter(f.key)}
            aria-pressed={active === f.key}
            className={`inline-flex min-h-10 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium tracking-wide transition-colors sm:min-h-0 ${
              active === f.key
                ? "border-accent-border bg-accent-dim text-accent"
                : "border-border text-text-muted hover:border-border-strong hover:text-text"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {page === undefined ? (
        <p className="py-8 text-center text-sm text-text-faint">Loading…</p>
      ) : page.events.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-faint">{EMPTY_TEXT[active]}</p>
      ) : (
        <div className="flex flex-col gap-5">
          {groupByDay(page.events).map((group, i) => (
            <div key={`${group.day}-${i}`} className="flex flex-col gap-2">
              <h2 className="font-display text-lg tracking-wide">{group.day}</h2>
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elevated">
                {group.events.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {failed && (
        <p className="text-center text-xs text-missing">Couldn&rsquo;t load any more — try again.</p>
      )}

      {page?.nextCursor && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={busy}
            onClick={() => void fetchPage(active, page.nextCursor)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-xs font-medium tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:opacity-50"
          >
            {busy ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </section>
  );
}

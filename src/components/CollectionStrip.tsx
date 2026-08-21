import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import FormatBadge from "@/components/FormatBadge";
import type { CollectionMemberView } from "@/lib/queries";

export default function CollectionStrip({
  collectionId,
  name,
  members,
  currentFilmId,
}: {
  collectionId: number;
  name: string;
  members: CollectionMemberView[];
  currentFilmId: number;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-xl tracking-wide">Part of {name}</h2>
        <Link
          href={`/collections/${collectionId}`}
          className="text-xs font-medium text-accent hover:text-accent-bright"
        >
          View timeline →
        </Link>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {members.map((m) => {
          const isCurrent = m.id === currentFilmId;
          const card = (
            <div
              className={`flex w-28 shrink-0 flex-col gap-1.5 rounded-lg border p-1.5 ${
                isCurrent
                  ? "border-accent-border bg-accent-dim"
                  : "border-transparent hover:border-border"
              }`}
            >
              <PosterImage
                posterPath={m.posterPath}
                title={m.title}
                year={m.year}
                sizes="112px"
                className={`aspect-2/3 w-full rounded ${
                  m.owned ? "" : "grayscale opacity-45"
                }`}
              />
              <span className="line-clamp-2 text-xs leading-snug text-text">{m.title}</span>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-text-faint">{m.year ?? "—"}</span>
                {!m.owned && <FormatBadge kind="MISSING" />}
              </div>
            </div>
          );

          return m.owned ? (
            <Link key={m.id} href={`/film/${m.id}`}>
              {card}
            </Link>
          ) : (
            <div key={m.id} aria-label={`${m.title} — not in library`}>
              {card}
            </div>
          );
        })}
      </div>
    </section>
  );
}

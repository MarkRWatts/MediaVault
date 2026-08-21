import Link from "next/link";
import { notFound } from "next/navigation";
import TimelineFilmRow from "@/components/TimelineFilmRow";
import { getCollectionDetail } from "@/lib/queries";

export default async function CollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const collectionId = Number(id);
  if (!Number.isInteger(collectionId)) notFound();

  const collection = await getCollectionDetail(collectionId);
  if (!collection) notFound();

  const pct =
    collection.totalCount > 0
      ? Math.round((collection.ownedCount / collection.totalCount) * 100)
      : 0;
  const complete = collection.ownedCount === collection.totalCount;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-3">
        <Link
          href="/collections"
          className="w-fit text-xs font-medium text-text-muted hover:text-text"
        >
          ← Collections
        </Link>
        <h1 className="font-display text-3xl tracking-wide text-balance">
          {collection.name}
        </h1>

        <div className="flex items-center gap-3">
          <span className={`font-mono text-sm ${complete ? "text-text-muted" : "text-accent"}`}>
            {collection.ownedCount} of {collection.totalCount} owned
          </span>
          {!complete && (
            <span className="text-[10px] font-semibold uppercase tracking-widest text-accent">
              Incomplete
            </span>
          )}
        </div>
        <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-bg-elevated-2">
          <div
            className={`h-full rounded-full ${complete ? "bg-good" : "bg-accent"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {collection.films.length === 0 ? (
        <p className="py-16 text-center text-sm text-text-faint">
          This collection has no known films.
        </p>
      ) : (
        <ol className="flex flex-col">
          {collection.films.map((film) => (
            <li key={film.id} className="relative flex gap-4">
              <div className="flex w-14 shrink-0 justify-end pt-3 sm:w-16">
                <span className="font-mono text-xs text-text-faint">
                  {film.year ?? "—"}
                </span>
              </div>
              <div className="relative flex w-6 shrink-0 justify-center">
                <div className="absolute -bottom-4 top-0 w-px bg-border" />
                <span
                  className={`relative z-10 mt-3.5 h-2.5 w-2.5 rounded-full border-2 ${
                    film.owned
                      ? "border-accent bg-accent"
                      : "border-border-strong bg-bg-elevated-2"
                  }`}
                />
              </div>
              <div className="min-w-0 flex-1 pb-4">
                <TimelineFilmRow film={film} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

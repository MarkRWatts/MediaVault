"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import PosterImage from "@/components/PosterImage";
import type { CollectionSummary } from "@/lib/queries";

function CollageCell({ posterPath }: { posterPath: string | null }) {
  const [errored, setErrored] = useState(false);
  if (!posterPath || errored) {
    return <div className="h-full w-full bg-bg-elevated-2" />;
  }
  return (
    <div className="relative h-full w-full">
      <Image
        src={`/api/poster/w342${posterPath}`}
        alt=""
        fill
        sizes="90px"
        className="object-cover"
        onError={() => setErrored(true)}
      />
    </div>
  );
}

export default function CollectionCard({ collection }: { collection: CollectionSummary }) {
  const { id, name, posterPath, collagePosters, ownedCount, totalCount, complete } = collection;
  const pct = totalCount > 0 ? Math.round((ownedCount / totalCount) * 100) : 0;

  return (
    <Link
      href={`/collections/${id}`}
      className="hover-lift group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
    >
      <div className="relative aspect-2/3 w-full border-b border-border">
        {posterPath ? (
          <PosterImage posterPath={posterPath} title={name} className="h-full w-full" />
        ) : (
          <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-px bg-border">
            {[0, 1, 2, 3].map((i) => (
              <CollageCell key={i} posterPath={collagePosters[i] ?? null} />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text">{name}</h3>
        <div className="mt-auto flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span
              className={`font-mono text-xs ${complete ? "text-text-muted" : "text-accent"}`}
            >
              {ownedCount} of {totalCount}
            </span>
            {!complete && (
              <span className="text-[10px] font-semibold uppercase tracking-widest text-accent">
                Incomplete
              </span>
            )}
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-bg-elevated-2">
            <div
              className={`h-full rounded-full ${complete ? "bg-good" : "bg-accent"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </Link>
  );
}

// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

import CollectionCard from "@/components/CollectionCard";
import { getCollections } from "@/lib/queries";

export default async function CollectionsPage() {
  const collections = await getCollections();

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <h1 className="font-display text-3xl tracking-wide">Collections</h1>
        {collections.length > 0 && (
          <p className="mt-1 pb-6 font-mono text-xs text-text-faint">
            {collections.length} collection{collections.length === 1 ? "" : "s"}
          </p>
        )}
        {collections.length === 0 && <div className="pb-6" />}
      </div>

      {collections.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
          <p className="font-display text-2xl tracking-wide text-text-muted">
            No collections yet
          </p>
          <p className="max-w-sm text-sm text-text-faint">
            Collections appear once metadata has been fetched for films that belong to
            a franchise or series.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 px-4 py-6 sm:grid-cols-3 sm:px-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {collections.map((c) => (
            <CollectionCard key={c.id} collection={c} />
          ))}
        </div>
      )}
    </div>
  );
}

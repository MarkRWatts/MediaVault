"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";

const BLUR_STORAGE_KEY = "adult-blur-posters";
const BLUR_CHANGE_EVENT = "adult-blur-posters-change";

function subscribe(callback: () => void) {
  window.addEventListener(BLUR_CHANGE_EVENT, callback);
  return () => window.removeEventListener(BLUR_CHANGE_EVENT, callback);
}

function getSnapshot() {
  return localStorage.getItem(BLUR_STORAGE_KEY) !== "false";
}

function getServerSnapshot() {
  return true;
}

type Scene = {
  id: number;
  title: string;
  posterPath: string | null;
  studio: { name: string } | null;
};

export function AdultScenes({ scenes }: { scenes: Scene[] }) {
  const blurred = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggleBlur(next: boolean) {
    localStorage.setItem(BLUR_STORAGE_KEY, String(next));
    window.dispatchEvent(new Event(BLUR_CHANGE_EVENT));
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-4 pt-6 sm:px-6">
        <div className="flex items-center justify-between gap-2">
          <h1 className="font-display text-3xl tracking-wide">Adult</h1>
          <label className="flex items-center gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={blurred}
              onChange={(e) => toggleBlur(e.target.checked)}
              className="size-4 accent-accent"
            />
            Blur posters
          </label>
        </div>
        <p className="mt-1 pb-6 font-mono text-xs text-text-faint">
          {scenes.length} scene{scenes.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6">
        {scenes.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
            <p className="font-display text-2xl tracking-wide text-text-muted">No scenes yet — run a scan</p>
            <p className="max-w-sm text-sm text-text-faint">
              Scenes appear here once ADULT_PATH has been scanned and matched.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
            {scenes.map((s) => (
              <Link
                key={s.id}
                href={`/adult/${s.id}`}
                className="hover-lift group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated"
              >
                {s.posterPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/adult-image/${s.posterPath}`}
                    alt={s.title}
                    className={`aspect-[2/3] w-full border-b border-border object-cover transition-[filter] ${
                      blurred ? "blur-lg" : ""
                    }`}
                  />
                ) : (
                  <div className="flex aspect-[2/3] w-full items-center justify-center border-b border-border bg-bg-elevated-2 text-xs text-text-faint">
                    No poster
                  </div>
                )}
                <div className="flex flex-1 flex-col gap-1.5 p-3">
                  <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text">{s.title}</h3>
                  {s.studio && <span className="mt-auto font-mono text-xs text-text-faint">{s.studio.name}</span>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

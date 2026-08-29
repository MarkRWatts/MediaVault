"use client";

// Scene-flavoured twin of PlayButton.tsx — same rationale (a small client
// island so the detail page's async server component doesn't need to
// become "use client" wholesale). Points VideoPlayer at /api/adult-video
// instead of /api/video, and turns off progress tracking (no SceneProgress
// model — see ADULT_PLAN.md).

import { useState } from "react";
import VideoPlayer from "@/components/VideoPlayer";

export default function AdultPlayButton({ sceneId, title }: { sceneId: number; title: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent-bright/10 px-2.5 py-1 text-[11px] font-medium tracking-wide text-accent-bright transition-colors hover:bg-accent-bright/20"
      >
        <svg aria-hidden viewBox="0 0 12 12" className="h-2.5 w-2.5 fill-current">
          <path d="M2.5 1.2c0-.55.6-.9 1.08-.62l6.2 3.8c.46.28.46.94 0 1.22l-6.2 3.8c-.48.28-1.08-.07-1.08-.62V1.2z" />
        </svg>
        Play
      </button>
      {open && (
        <VideoPlayer
          versionId={sceneId}
          title={title}
          onClose={() => setOpen(false)}
          basePath="/api/adult-video"
          trackProgress={false}
        />
      )}
    </>
  );
}

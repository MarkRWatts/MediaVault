"use client";

// The film page's synopsis (FILM_PAGE_PLAN.md): up to six lines, then
// "More" to read the rest. The show page clips it at three (SHOW_PAGE_PLAN.md
// "Synopsis"), so its episodes start on the first screen. The button only appears when the text really is
// cut off — measured after layout, since how many lines it takes depends
// on the screen it lands on.

import { useLayoutEffect, useRef, useState } from "react";

// Whole class names, so Tailwind sees them.
const CLAMP = { 3: "line-clamp-3", 6: "line-clamp-6" } as const;

export default function Synopsis({ text, lines = 6 }: { text: string; lines?: keyof typeof CLAMP }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className="flex flex-col items-start gap-1">
      <p ref={ref} className={`text-[15px] leading-relaxed text-text ${expanded ? "" : CLAMP[lines]}`}>
        {text}
      </p>
      {(clipped || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-sm font-semibold text-accent transition-colors hover:text-accent-bright"
        >
          {expanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

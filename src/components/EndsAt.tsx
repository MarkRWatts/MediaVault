"use client";

// "Ends at 19:16" — what the clock will say if you start this episode now.
//
// It has to be a client island: the answer depends on the reader's current
// time and locale, and a server-rendered one would both mismatch on
// hydration and be stale by the time anyone read it. Nothing renders until
// after mount, so the server and the first client pass agree on "nothing".
// The minute tick keeps it honest on a page left open.

import { useEffect, useState } from "react";

export default function EndsAt({ mins }: { mins: number }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const tick = () =>
      setLabel(
        new Date(Date.now() + mins * 60_000).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [mins]);

  if (!label) return null;
  return <span>Ends at {label}</span>;
}

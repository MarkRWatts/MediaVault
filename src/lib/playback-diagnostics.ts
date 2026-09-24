// What a native app's player says about one viewing, sent while it plays so
// a stall can be read from the server's log (`docker logs mediavault-app-1 |
// grep playback-diag`) rather than guessed at. Added for the Apple TV's Ultra
// HD direct play, which stops asking for bytes 3–4½ minutes in: AVPlayer's
// own account (buffer, stalls, error and access logs) says why.
//
// Untrusted input, so it's shaped here: known fields only, bounded counts
// and lengths, one line per event.

export const MAX_EVENTS = 200;
const MAX_TEXT = 300;

export interface PlaybackDiagnosticEvent {
  /** Client wall clock, ms since the epoch. */
  at: number;
  /** Playhead, seconds. */
  position: number | null;
  type: string;
  detail: string;
}

export interface PlaybackDiagnosticReport {
  kind: "film" | "episode";
  itemId: number;
  mode: string;
  events: PlaybackDiagnosticEvent[];
}

const text = (v: unknown, max = MAX_TEXT): string =>
  typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").slice(0, max) : "";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Null when it isn't a report at all. */
export function parsePlaybackReport(body: unknown): PlaybackDiagnosticReport | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const kind = b.kind === "film" || b.kind === "episode" ? b.kind : null;
  const itemId = num(b.itemId);
  if (!kind || itemId === null || !Number.isInteger(itemId) || !Array.isArray(b.events)) return null;
  const events = b.events.slice(0, MAX_EVENTS).flatMap((e): PlaybackDiagnosticEvent[] => {
    if (!e || typeof e !== "object") return [];
    const r = e as Record<string, unknown>;
    const type = text(r.type, 40);
    if (!type) return [];
    return [{ at: num(r.at) ?? 0, position: num(r.position), type, detail: text(r.detail) }];
  });
  return { kind, itemId, mode: text(b.mode, 20), events };
}

/** One log line per event: `[playback-diag] 17:53:02.114 film/511 direct u=… @212.4s stall …`. */
export function formatPlaybackReport(report: PlaybackDiagnosticReport, userId: string): string[] {
  return report.events.map((e) => {
    const time = e.at ? new Date(e.at).toISOString().slice(11, 23) : "?";
    const pos = e.position === null ? "-" : `${e.position.toFixed(1)}s`;
    return `[playback-diag] ${time} ${report.kind}/${report.itemId} ${report.mode} u=${userId} @${pos} ${e.type} ${e.detail}`.trimEnd();
  });
}

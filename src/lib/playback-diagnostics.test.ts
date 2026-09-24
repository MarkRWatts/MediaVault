import { describe, expect, it } from "vitest";
import { MAX_EVENTS, formatPlaybackReport, parsePlaybackReport } from "@/lib/playback-diagnostics";

describe("parsePlaybackReport", () => {
  it("keeps known fields, one line each", () => {
    const report = parsePlaybackReport({
      kind: "film",
      itemId: 511,
      mode: "direct",
      extra: "ignored",
      events: [
        { at: Date.UTC(2026, 8, 24, 17, 53, 2, 114), position: 212.44, type: "stall", detail: "buffer 0.0s\nahead" },
        { type: "" },
        "junk",
      ],
    });
    expect(report).toEqual({
      kind: "film",
      itemId: 511,
      mode: "direct",
      events: [{ at: Date.UTC(2026, 8, 24, 17, 53, 2, 114), position: 212.44, type: "stall", detail: "buffer 0.0s ahead" }],
    });
    expect(formatPlaybackReport(report!, "u1")).toEqual([
      "[playback-diag] 17:53:02.114 film/511 direct u=u1 @212.4s stall buffer 0.0s ahead",
    ]);
  });

  it("refuses what isn't a report and bounds what is", () => {
    expect(parsePlaybackReport(null)).toBeNull();
    expect(parsePlaybackReport({ kind: "song", itemId: 1, events: [] })).toBeNull();
    expect(parsePlaybackReport({ kind: "film", itemId: 1.5, events: [] })).toBeNull();
    const many = parsePlaybackReport({
      kind: "episode",
      itemId: 3,
      events: Array.from({ length: MAX_EVENTS + 50 }, () => ({ type: "tick", detail: "x".repeat(1000) })),
    });
    expect(many!.events).toHaveLength(MAX_EVENTS);
    expect(many!.events[0].detail).toHaveLength(300);
  });
});

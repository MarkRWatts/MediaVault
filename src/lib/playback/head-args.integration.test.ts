// An ffmpeg-gated smoke test for buildHeadArgs' SOFTWARE argument lines.
// buildHeadArgs itself is pure (no process spawning -- see head-args.ts's
// file header for the full segment-completion contract), but wrong option
// names, wrong ordering, or a wrong assumption about how -copyts survives
// the mpegts muxer only show up by actually running the arguments through
// a real ffmpeg. This is exactly how the `-segment_format_options
// mpegts_copyts=1` requirement documented in head-args.ts was found: the
// unit tests alone couldn't have caught it.
//
// Confirms the two things V4_PLAN.md's "Heads" section stakes the whole
// design on:
//   - a head restarted at N > 0 produces the *same* video content, frame
//     for frame, as the run that started at 0 (the "Copy-tier segment
//     boundaries" risk in V4_PLAN.md);
//   - a transcoded head's forced keyframes land exactly on the table's
//     absolute boundary times.
//
// Software only (no vaapi/qsv on this Mac); skipped where ffmpeg isn't on
// PATH, same gating as video-cache.integration.test.ts.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { planVideoPlayback } from "../video-playback";
import { buildHeadArgs } from "./head-args";
import type { SegmentEntry } from "./types";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

interface SegmentListRow {
  file: string;
  start: number;
  end: number;
}

function parseSegmentList(csv: string): SegmentListRow[] {
  return csv
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [file, start, end] = line.split(",");
      return { file, start: Number(start), end: Number(end) };
    });
}

function probeVideoFrames(file: string): string {
  return execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=key_frame,pts_time,pkt_size", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
}

describe.skipIf(!hasFfmpeg)("buildHeadArgs (real ffmpeg, software path)", () => {
  it("restarts a copy-tier head onto the same video content, frame for frame", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mv-head-args-copy-"));
    const input = path.join(root, "source.mkv");

    // A copyable H.264 source with a closed 25-frame GOP at 25fps: a real
    // keyframe exactly once a second, so a 2-second segment table lands
    // every cut precisely on a real keyframe -- the case "Segment table"
    // describes for copied video.
    execFileSync(
      "ffmpeg",
      [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=25",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=6",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-g", "25", "-keyint_min", "25", "-sc_threshold", "0",
        "-c:a", "aac", "-shortest",
        input,
      ],
      { stdio: "pipe" },
    );

    const keyframes = [0, 1, 2, 3, 4, 5];
    const segments: SegmentEntry[] = [0, 1, 2].map((i) => ({
      index: i,
      start: keyframes[i * 2],
      duration: (i < 2 ? keyframes[(i + 1) * 2] : 6) - keyframes[i * 2],
    }));

    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "aac", profile: null, channels: 2 }],
    })!;
    expect(plan.videoAction).toBe("copy");

    const source = { fps: 25, pixFmt: "yuv420p", interlaced: false, width: 320, height: 240 };

    function runHead(startIndex: number, outDir: string): SegmentListRow[] {
      const args = buildHeadArgs({
        input,
        plan,
        variant: "original",
        audio: { streamIndex: plan.audioStreamIndex, action: "copy", sourceChannels: 2 },
        segments,
        startIndex,
        outDir,
        hwaccel: "none",
        source,
        keyframes,
      });
      const csv = execFileSync("ffmpeg", args, { encoding: "utf8" });
      return parseSegmentList(csv);
    }

    const dirA = path.join(root, "headA");
    const dirB = path.join(root, "headB");
    await mkdir(dirA);
    await mkdir(dirB);

    const rowsA = runHead(0, dirA);
    const rowsB = runHead(1, dirB);

    expect(rowsA.map((r) => r.file)).toEqual(["seg_00000.ts", "seg_00001.ts", "seg_00002.ts"]);
    // segment_start_number offsets the naming, so a head restarted at
    // index 1 names its own first file seg_00001.ts -- the same name the
    // continuous run gave the segment it corresponds to.
    expect(rowsB.map((r) => r.file)).toEqual(["seg_00001.ts", "seg_00002.ts"]);

    // The actual video content -- every frame's presentation timestamp and
    // size -- must match exactly between the two runs for the segments
    // they share, regardless of where each head itself started.
    const framesA1 = probeVideoFrames(path.join(dirA, "seg_00001.ts"));
    const framesB1 = probeVideoFrames(path.join(dirB, "seg_00001.ts"));
    expect(framesB1).toBe(framesA1);

    const framesA2 = probeVideoFrames(path.join(dirA, "seg_00002.ts"));
    const framesB2 = probeVideoFrames(path.join(dirB, "seg_00002.ts"));
    expect(framesB2).toBe(framesA2);

    // And each segment's first video frame is a real keyframe landing
    // exactly on the table's absolute start time -- the point of dictating
    // the cut list rather than predicting it.
    expect(framesA1.split("\n")[0]).toMatch(/^1,2\.000000,\d+,?$/);
    expect(framesA2.split("\n")[0]).toMatch(/^1,4\.000000,\d+,?$/);
  }, 30_000);

  it("forces a transcoded head's keyframes exactly onto the table's absolute boundaries, restart included", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mv-head-args-transcode-"));
    const input = path.join(root, "source.mkv");

    // MPEG-2 needs a real re-encode (planVideoPlayback's videoAction is
    // "transcode" for it) -- exercises the libx264 branch of buildHeadArgs
    // rather than the copy branch above.
    execFileSync(
      "ffmpeg",
      [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=25",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=6",
        "-c:v", "mpeg2video", "-qscale:v", "5",
        "-c:a", "ac3", "-shortest",
        input,
      ],
      { stdio: "pipe" },
    );

    const segments: SegmentEntry[] = [
      { index: 0, start: 0, duration: 2 },
      { index: 1, start: 2, duration: 2 },
      { index: 2, start: 4, duration: 2 },
    ];

    const plan = planVideoPlayback({
      videoCodec: "mpeg2video",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 2 }],
    })!;
    expect(plan.videoAction).toBe("transcode");

    const source = { fps: 25, pixFmt: "yuv420p", interlaced: false, width: 320, height: 240 };

    function runHead(startIndex: number, outDir: string): SegmentListRow[] {
      const args = buildHeadArgs({
        input,
        plan,
        variant: "original",
        audio: { streamIndex: plan.audioStreamIndex, action: "copy", sourceChannels: 2 },
        segments,
        startIndex,
        outDir,
        hwaccel: "none",
        source,
      });
      const csv = execFileSync("ffmpeg", args, { encoding: "utf8" });
      return parseSegmentList(csv);
    }

    const dirA = path.join(root, "headA");
    const dirB = path.join(root, "headB");
    await mkdir(dirA);
    await mkdir(dirB);

    runHead(0, dirA);
    runHead(1, dirB);

    // Head A, run straight through: the forced keyframe at the segment-2
    // boundary lands exactly at absolute t=4, whether this head started at
    // 0 or (head B) was restarted with an accurate seek to t=2.
    const firstFrameA2 = probeVideoFrames(path.join(dirA, "seg_00002.ts")).split("\n")[0];
    const firstFrameB2 = probeVideoFrames(path.join(dirB, "seg_00002.ts")).split("\n")[0];
    expect(firstFrameA2).toMatch(/^1,4\.000000,\d+,?$/);
    expect(firstFrameB2).toMatch(/^1,4\.000000,\d+,?$/);

    // And the restarted head's own first frame is exactly at the boundary
    // it was asked to seek to -- an accurate seek, not a keyframe-snapped
    // one, is what makes this exact for transcoded video.
    const firstFrameB1 = probeVideoFrames(path.join(dirB, "seg_00001.ts")).split("\n")[0];
    expect(firstFrameB1).toMatch(/^1,2\.000000,\d+,?$/);
  }, 30_000);
});

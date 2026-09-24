// Copied HEVC through the engine as fragmented MP4 (decisions.ts's
// segmentContainerFor, fmp4.ts), against a real ffmpeg with libx265: the
// playlist names an init segment and .m4s media, the init is ftyp+moov and
// nothing else, each media segment is moof/mdat and nothing else, and a
// segment's fragments carry the film's own absolute times -- whichever
// head wrote it. Skipped where ffmpeg has no libx265 to make the fixture.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient } from "@/generated/prisma/client";
import { ffmpegPath, ffprobePath } from "@/lib/ffmpeg-bin";
import { topLevelBoxes, trackFragments, trackInfo } from "./fmp4";

const hasX265 = (() => {
  const r = spawnSync(ffmpegPath(), ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes("libx265");
})();

let testPrisma: PrismaClient;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

let engine: typeof import("./engine");
let root: string;
let versionId: number;
let sourceFile: string;

const DEVICE = "mediavault-test-device";
const DURATION_SECS = 40;

/** Tiny HEVC with a keyframe every second and AAC audio, in MP4: the
 *  Original rendition copies both, which is the fMP4 case. */
function buildHevcSource(file: string): void {
  execFileSync(
    ffmpegPath(),
    [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=duration=${DURATION_SECS}:size=320x240:rate=10`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION_SECS}`,
      "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-x265-params", "keyint=10:min-keyint=10:scenecut=0:log-level=error",
      "-tag:v", "hvc1", "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      file,
    ],
    { stdio: "pipe" },
  );
}

const types = (bytes: Buffer) => topLevelBoxes(bytes).map((b) => b.type);

function packetTimes(file: string, stream: string): number[] {
  const out = execFileSync(
    ffprobePath(),
    ["-v", "error", "-select_streams", stream, "-show_entries", "packet=pts_time", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  return out
    .trim()
    .split("\n")
    .map((l) => Number(l.replace(/,$/, "")))
    .sort((a, b) => a - b);
}

/**
 * How far out of step picture and sound are in one media segment, in
 * seconds, reading the timestamps a player uses (each fragment's decode time
 * plus its first sample's composition offset; the init has no edit list).
 * The first frame should show at `keyframeStart`; however late it actually
 * shows, the audio must start exactly as late against one of the source's
 * own audio packet times.
 */
function avDrift(init: Buffer, media: Buffer, keyframeStart: number): number {
  const tracks = trackInfo(init);
  const fragments = trackFragments(media);
  const at = (handler: string) => {
    const f = fragments.find((x) => tracks.get(x.trackId)?.handler === handler)!;
    return (Number(f.decodeTime) + f.firstCto) / tracks.get(f.trackId)!.timescale;
  };
  const videoLag = at("vide") - keyframeStart;
  const audioAsSource = at("soun") - videoLag;
  const sourceAudio = packetTimes(sourceFile, "a:0");
  return Math.min(...sourceAudio.map((t) => Math.abs(t - audioAsSource)));
}

describe.skipIf(!hasX265)("copied HEVC as fMP4 (real ffmpeg)", () => {
  beforeAll(async () => {
    const db = await createTempTestDb();
    testPrisma = db.prisma;
    cleanupDb = db.cleanup;

    root = await realpath(await mkdtemp(path.join(tmpdir(), "mv-playback-fmp4-")));
    const movies = path.join(root, "movies");
    await mkdir(movies);
    process.env.MOVIES_PATH = movies;
    process.env.VIDEO_CACHE_DIR = path.join(root, "cache");
    delete process.env.VIDEO_CACHE_MAX_BYTES;
    delete process.env.PLAYBACK_HWACCEL;
    delete process.env.PLAYBACK_MAX_SESSIONS;

    sourceFile = path.join(movies, "HEVC Film (2021).mp4");
    buildHevcSource(sourceFile);
    const film = await testPrisma.film.create({ data: { title: "HEVC Film", sortTitle: "hevc film", year: 2021, owned: true } });
    const version = await testPrisma.version.create({
      data: {
        filmId: film.id,
        filePath: "HEVC Film (2021).mp4",
        fileName: "HEVC Film (2021).mp4",
        format: "UHD",
        videoCodec: "hevc",
        container: "mp4",
        durationSecs: DURATION_SECS,
        audioTracks: { create: [{ streamIdx: 1, codec: "aac", channels: 1, isDefault: true }] },
      },
    });
    versionId = version.id;
    engine = await import("./engine");
  }, 120_000);

  afterAll(async () => {
    await engine?.resetEngineForTest();
    await cleanupDb?.();
    await rm(root, { recursive: true, force: true });
  });

  it("serves an init segment and moof/mdat media segments on the film's own timeline", async () => {
    const session = await engine.startSession({ kind: "film", id: versionId, variant: "original", deviceId: DEVICE });
    expect(session.container).toBe("fmp4");

    const main = await engine.getMainPlaylist(session.key);
    expect(main).toContain("#EXT-X-VERSION:7");
    expect(main).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(main).toContain("seg_00003.m4s");
    expect(main).not.toContain(".ts");

    const init = await readFile(await engine.getInitSegment(session.key, session.playSessionId));
    // The master names the video exactly, from that init, with its frame
    // rate; an SDR source says nothing about range.
    const master = await engine.getMasterPlaylist(session.key, "main.m3u8", session.playSessionId);
    expect(master).toMatch(/CODECS="hvc1\.1\.6\.L\d+(\.[0-9A-F]+)*,mp4a\.40\.2"/);
    expect(master).toContain("FRAME-RATE=10.000");
    expect(master).not.toContain("VIDEO-RANGE");
    expect(types(init)).toEqual(["ftyp", "moov"]);

    const table = await engine.getSegmentTable(session.key);
    const seg3 = await readFile(await engine.getSegment(session.key, 3, session.playSessionId));
    expect(types(seg3)).not.toContain("moov");
    expect(types(seg3)).toContain("moof");
    // Picture and sound in step: the video's lag behind the table (the
    // B-frame reorder delay the MP4 writer adds) is matched by the audio's
    // lag behind the source's own audio clock.
    for (const index of [0, 3]) {
      const seg = await readFile(await engine.getSegment(session.key, index, session.playSessionId));
      expect(avDrift(init, seg, table[index].start)).toBeLessThan(0.002);
    }

    // A head started cold at segment 5 writes it on the same timeline, and
    // the one init still describes it.
    await engine.resetEngineForTest();
    const dir = path.join(root, "cache", session.key);
    await rm(path.join(dir, "seg_00005.ts"), { force: true });
    const again = await engine.startSession({ kind: "film", id: versionId, variant: "original", deviceId: DEVICE });
    const seg5 = await readFile(await engine.getSegment(again.key, 5, again.playSessionId));
    expect(avDrift(init, seg5, table[5].start)).toBeLessThan(0.002);
    expect(await readFile(path.join(dir, "init.mp4"))).toEqual(init);
  }, 120_000);
});

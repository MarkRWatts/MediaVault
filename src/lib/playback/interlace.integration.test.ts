// Proves the two claims the whole feature rests on, against real ffmpeg
// (V4_PLAN.md, "Session-time probe"): idet actually tells a genuinely
// interlaced source from a progressive one the container flags interlaced,
// and that verdict is what ends up deciding head-args.ts's deinterlace
// filter for a transcode-tier play -- not the header. No unit test can
// reach either claim, because both are about what a real ffmpeg encode and
// decode actually produce.
//
// Skipped where ffmpeg isn't on PATH, same gating as
// engine.integration.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient } from "@/generated/prisma/client";
import { ffmpegPath, ffprobePath } from "@/lib/ffmpeg-bin";
import { buildHeadArgs } from "./head-args";
import { isMeasuredInterlaced, measureInterlace } from "./interlace";
import type { ResolvedSource } from "./source";

const hasFfmpeg = spawnSync(ffmpegPath(), ["-version"], { stdio: "ignore" }).status === 0;

let testPrisma: PrismaClient;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

let source: typeof import("./source");
let root: string;
let interlacedFile: string;
let progressiveFlaggedFile: string;
let interlacedVersionId: number;
let progressiveVersionId: number;

/** Short on purpose: durationSecs < 60 means measureInterlace samples a
 *  single window from 0 rather than three, which is plenty for a fixture
 *  this small and keeps the suite well under 30s. */
const DURATION_SECS = 8;

/** A truly interlaced source: `tinterlace` weaves motion into separate
 *  fields (real combing, not just a header claim), `fieldorder=tff` and
 *  `+ilme+ildct` make the mpeg2video encoder write it as actual interlaced
 *  pictures. This is the concert-video case from V4_PLAN.md's problem
 *  statement. */
function buildInterlacedFixture(file: string): void {
  execFileSync(
    ffmpegPath(),
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=50",
      "-t",
      String(DURATION_SECS),
      "-vf",
      "tinterlace=interleave_top,fieldorder=tff",
      "-flags",
      "+ilme+ildct",
      "-c:v",
      "mpeg2video",
      file,
    ],
    { stdio: "pipe" },
  );
}

/** The PAL-DVD case this feature exists for: genuinely progressive pictures
 *  (no `tinterlace` -- nothing about the content is interlaced) encoded with
 *  the interlaced DCT/motion-estimation flags on and every frame tagged
 *  top-field-first (`setfield=tff`), so the container header claims "tt"
 *  throughout exactly like the real Finding Nemo / Four Weddings / Jonah Hex
 *  / The Italian Job streams this was measured against. */
function buildProgressiveFlaggedFixture(file: string): void {
  execFileSync(
    ffmpegPath(),
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=25",
      "-t",
      String(DURATION_SECS),
      "-vf",
      "setfield=tff",
      "-flags",
      "+ilme+ildct",
      "-c:v",
      "mpeg2video",
      file,
    ],
    { stdio: "pipe" },
  );
}

function fieldOrderOf(file: string): string {
  // ffprobe against an mpegts file prints the field twice (once per PMT
  // pass); the first line is the real stream answer either way.
  const out = execFileSync(
    ffprobePath(),
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=field_order", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  return out.trim().split("\n")[0].trim();
}

/** The head-args.ts filter chain a transcode-tier, software (hwaccel none)
 *  head would build for this source -- yadif shows up if and only if
 *  `facts.interlaced` is true. Segments/audio are the minimum buildHeadArgs
 *  will accept; this test only cares about the `-vf` line. */
function softwareArgsFor(resolved: ResolvedSource): string[] {
  return buildHeadArgs({
    input: resolved.absPath,
    plan: resolved.plan,
    variant: "original",
    audio: { streamIndex: null, action: "none", sourceChannels: null },
    segments: [{ index: 0, start: 0, duration: DURATION_SECS }],
    startIndex: 0,
    outDir: "/tmp/interlace-integration-test-unused",
    hwaccel: "none",
    source: resolved.facts,
  });
}

describe.skipIf(!hasFfmpeg)("measured interlace detection (real ffmpeg)", () => {
  beforeAll(async () => {
    const db = await createTempTestDb();
    testPrisma = db.prisma;
    cleanupDb = db.cleanup;

    root = await realpath(await mkdtemp(path.join(tmpdir(), "mv-interlace-")));
    const movies = path.join(root, "movies");
    await mkdir(movies);
    process.env.MOVIES_PATH = movies;

    interlacedFile = path.join(movies, "Concert (2020).ts");
    progressiveFlaggedFile = path.join(movies, "Nature Documentary (2020).ts");
    buildInterlacedFixture(interlacedFile);
    buildProgressiveFlaggedFixture(progressiveFlaggedFile);

    // The fixtures must actually have the header property the whole feature
    // is about -- both flagged interlaced -- or the rest of this suite would
    // be proving nothing.
    expect(fieldOrderOf(interlacedFile)).toMatch(/^t[tb]$/);
    expect(fieldOrderOf(progressiveFlaggedFile)).toMatch(/^t[tb]$/);

    const film = await testPrisma.film.create({
      data: { title: "Interlace Test", sortTitle: "interlace test", year: 2020, owned: true },
    });
    const interlacedVersion = await testPrisma.version.create({
      data: {
        filmId: film.id,
        filePath: "Concert (2020).ts",
        fileName: "Concert (2020).ts",
        format: "DVD",
        videoCodec: "mpeg2video",
        container: "mpegts",
        durationSecs: DURATION_SECS,
      },
    });
    interlacedVersionId = interlacedVersion.id;
    const progressiveVersion = await testPrisma.version.create({
      data: {
        filmId: film.id,
        filePath: "Nature Documentary (2020).ts",
        fileName: "Nature Documentary (2020).ts",
        format: "DVD",
        videoCodec: "mpeg2video",
        container: "mpegts",
        durationSecs: DURATION_SECS,
      },
    });
    progressiveVersionId = progressiveVersion.id;

    source = await import("./source");
  }, 60_000);

  afterAll(async () => {
    await cleanupDb?.();
    await rm(root, { recursive: true, force: true });
  });

  it("measures the truly interlaced fixture as interlaced", async () => {
    const measured = await measureInterlace(interlacedFile, DURATION_SECS);
    expect(measured).not.toBeNull();
    expect(isMeasuredInterlaced(measured!)).toBe(true);
  }, 30_000);

  it("measures the progressive-but-flagged fixture as progressive", async () => {
    const measured = await measureInterlace(progressiveFlaggedFile, DURATION_SECS);
    expect(measured).not.toBeNull();
    expect(isMeasuredInterlaced(measured!)).toBe(false);
  }, 30_000);

  it("resolveSource believes the measurement over the identical header, both ways", async () => {
    // mpeg2video isn't in SUPPORTED_VIDEO_CODECS, so the Original variant is
    // already a transcode-tier play for both -- the case that pays for a
    // measurement.
    const interlacedSource = await source.resolveSource("film", interlacedVersionId, "original");
    const progressiveSource = await source.resolveSource("film", progressiveVersionId, "original");

    expect(interlacedSource?.facts.interlaced).toBe(true);
    expect(progressiveSource?.facts.interlaced).toBe(false);
  }, 30_000);

  it("head-args.ts's software filter chain gets yadif only for the genuinely interlaced source", async () => {
    const interlacedSource = await source.resolveSource("film", interlacedVersionId, "original");
    const progressiveSource = await source.resolveSource("film", progressiveVersionId, "original");
    expect(interlacedSource).not.toBeNull();
    expect(progressiveSource).not.toBeNull();

    expect(softwareArgsFor(interlacedSource!)).toContain("yadif");
    expect(softwareArgsFor(progressiveSource!)).not.toContain("yadif");
  }, 30_000);
});

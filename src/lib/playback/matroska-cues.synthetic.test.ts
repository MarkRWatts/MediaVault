// Hand-built minimal EBML files exercising structural cases real
// ffmpeg-muxed fixtures (matroska-cues.test.ts) don't reach on their own —
// ffmpeg always writes a SeekHead pointing straight at Cues, so none of
// those fixtures ever take the "no SeekHead, skip past every Cluster
// header" fallback path, or an unknown-size Segment, or a non-minimal vint
// length. Every element id/value below is a standard EBML/Matroska
// constant (see matroska-cues.ts's own ID table).
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMatroskaCues } from "./matroska-cues";

const ID = {
  Ebml: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  Cluster: 0x1f43b675,
  Void: 0xec,
};

function bigEndianBytes(value: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    buf[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return buf;
}

/** Raw id bytes — an EBML id constant already has its length-marker bits
 *  baked in (e.g. Segment 0x18538067's leading nibble IS the 4-byte
 *  marker), so this is just its big-endian encoding, unlike a size vint. */
function idBytes(id: number, length: number): Buffer {
  return bigEndianBytes(id, length);
}

/** A size vint of exactly `length` bytes (never the EBML "unknown size"
 *  reserved all-ones pattern, for any value this helper is asked to fit). */
function sizeVint(value: number, length: number): Buffer {
  const buf = bigEndianBytes(value, length);
  buf[0] |= 0x80 >> (length - 1);
  return buf;
}

/** The reserved "unknown size" vint of `length` bytes. */
function unknownSize(length: number): Buffer {
  const buf = Buffer.alloc(length, 0xff);
  const marker = 0x80 >> (length - 1);
  buf[0] = marker | (marker - 1);
  return buf;
}

function sizeVintAuto(value: number): Buffer {
  for (let length = 1; length <= 8; length++) {
    if (value < 2 ** (7 * length) - 1) return sizeVint(value, length);
  }
  throw new Error("value too large for this test helper");
}

function el(id: number, idLen: number, content: Buffer, sizeLen?: number): Buffer {
  const size = sizeLen ? sizeVint(content.length, sizeLen) : sizeVintAuto(content.length);
  return Buffer.concat([idBytes(id, idLen), size, content]);
}

function uintEl(id: number, idLen: number, value: number, contentLen: number): Buffer {
  return el(id, idLen, bigEndianBytes(value, contentLen));
}

const EBML_HEADER = el(ID.Ebml, 4, Buffer.alloc(0));

function infoEl(timestampScaleNs = 1_000_000): Buffer {
  return el(ID.Info, 4, uintEl(ID.TimestampScale, 3, timestampScaleNs, 3));
}

function tracksEl(videoTrackNumber = 1): Buffer {
  const trackEntry = el(
    ID.TrackEntry,
    1,
    Buffer.concat([uintEl(ID.TrackNumber, 1, videoTrackNumber, 1), uintEl(ID.TrackType, 1, 1 /* video */, 1)]),
  );
  return el(ID.Tracks, 4, trackEntry);
}

function cuesEl(cueTimeTicks: number, trackNumber = 1): Buffer {
  const cuePoint = el(
    ID.CuePoint,
    1,
    Buffer.concat([uintEl(ID.CueTime, 1, cueTimeTicks, 2), el(ID.CueTrackPositions, 1, uintEl(ID.CueTrack, 1, trackNumber, 1))]),
  );
  return el(ID.Cues, 4, cuePoint);
}

function clusterEl(payloadBytes: number): Buffer {
  return el(ID.Cluster, 4, Buffer.alloc(payloadBytes, 0xaa), 4);
}

function seekHeadEl(cuesSegmentPosition: number): Buffer {
  const seek = el(
    ID.Seek,
    2,
    Buffer.concat([el(ID.SeekID, 2, idBytes(ID.Cues, 4)), uintEl(ID.SeekPosition, 2, cuesSegmentPosition, 4)]),
  );
  return el(ID.SeekHead, 4, seek);
}

const tmpDirs: string[] = [];

async function writeFixture(segmentContent: Buffer, opts: { unknownSegmentSize?: boolean } = {}): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "mv-ebml-synthetic-"));
  tmpDirs.push(dir);
  const segmentSize = opts.unknownSegmentSize ? unknownSize(4) : sizeVint(segmentContent.length, 4);
  const file = Buffer.concat([EBML_HEADER, idBytes(ID.Segment, 4), segmentSize, segmentContent]);
  const filePath = path.join(dir, "synthetic.mkv");
  await writeFile(filePath, file);
  return filePath;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readMatroskaCues (synthetic EBML)", () => {
  it("falls back to skip-scanning top-level children when there's no SeekHead, without reading the Cluster payload", async () => {
    const cluster = clusterEl(5000); // deliberately large — must never be read
    const segment = Buffer.concat([infoEl(), tracksEl(), cluster, cuesEl(5000)]);
    const filePath = await writeFixture(segment);

    const result = await readMatroskaCues(filePath);
    expect(result.keyframeSecs).toEqual([5]); // 5000 ticks * 1ms scale
    expect(result.bytesRead).toBeLessThan(500); // headers + tiny leaves only, not the 5000-byte cluster
  });

  it("skips a Void element among Segment's top-level children", async () => {
    const voidEl = el(ID.Void, 1, Buffer.alloc(64, 0));
    const segment = Buffer.concat([voidEl, infoEl(), tracksEl(), cuesEl(2000)]);
    const filePath = await writeFixture(segment);

    const result = await readMatroskaCues(filePath);
    expect(result.keyframeSecs).toEqual([2]);
  });

  it("jumps straight to Cues via SeekHead without walking a large Cluster in between", async () => {
    const seekHead = seekHeadEl(0); // placeholder — patched below once offsets are known
    const info = infoEl();
    const tracks = tracksEl();
    const cluster = clusterEl(1_000_000); // 1MB — must never be read
    const cues = cuesEl(9000);

    // SeekPosition is relative to the start of Segment's own payload.
    const cuesPosition = seekHead.length + info.length + tracks.length + cluster.length;
    const patchedSeekHead = seekHeadEl(cuesPosition);
    expect(patchedSeekHead.length).toBe(seekHead.length); // fixed-width encoding above — offsets don't shift

    const segment = Buffer.concat([patchedSeekHead, info, tracks, cluster, cues]);
    const filePath = await writeFixture(segment);

    const result = await readMatroskaCues(filePath);
    expect(result.keyframeSecs).toEqual([9]);
    expect(result.bytesRead).toBeLessThan(2000); // nowhere near the 1MB cluster
  });

  it("treats an unknown-size Segment as running to EOF and still finds Cues", async () => {
    const segment = Buffer.concat([infoEl(), tracksEl(), cuesEl(1500)]);
    const filePath = await writeFixture(segment, { unknownSegmentSize: true });

    const result = await readMatroskaCues(filePath);
    expect(result.keyframeSecs).toEqual([1.5]);
  });

  it("returns null when an unknown-size Cluster can't be skipped past and no Cues was found first", async () => {
    const unknownCluster = Buffer.concat([idBytes(ID.Cluster, 4), unknownSize(4), Buffer.alloc(100)]);
    const segment = Buffer.concat([infoEl(), tracksEl(), unknownCluster]);
    const filePath = await writeFixture(segment);

    const result = await readMatroskaCues(filePath);
    expect(result.keyframeSecs).toBeNull();
  });

  it("returns null for a file with a Cues element but no CuePoint for the video track", async () => {
    const segment = Buffer.concat([infoEl(), tracksEl(1), cuesEl(1000, 99 /* different track */)]);
    const filePath = await writeFixture(segment);

    const result = await readMatroskaCues(filePath);
    expect(result.keyframeSecs).toBeNull();
  });

  it("decodes a non-minimal (8-byte) size vint", async () => {
    const cluster = clusterEl(200);
    const cues = el(ID.Cues, 4, el(ID.CuePoint, 1, Buffer.concat([uintEl(ID.CueTime, 1, 4000, 2), el(ID.CueTrackPositions, 1, uintEl(ID.CueTrack, 1, 1, 1))])), 8);
    const segment = Buffer.concat([infoEl(), tracksEl(), cluster, cues]);
    const filePath = await writeFixture(segment);

    const result = await readMatroskaCues(filePath);
    expect(result.keyframeSecs).toEqual([4]);
  });

  it("honours a non-default TimestampScale", async () => {
    // 100ns ticks (a common "nanosecond-precision" scale): CueTime=50,000,000
    // ticks -> 5s. That value needs a 4-byte CueTime, so build the CuePoint
    // directly rather than via cuesEl()'s 2-byte-CueTime shorthand.
    const cuePoint = el(
      ID.CuePoint,
      1,
      Buffer.concat([uintEl(ID.CueTime, 1, 50_000_000, 4), el(ID.CueTrackPositions, 1, uintEl(ID.CueTrack, 1, 1, 1))]),
    );
    const cues = el(ID.Cues, 4, cuePoint);
    const segment = Buffer.concat([infoEl(100), tracksEl(), cues]);
    const filePath = await writeFixture(segment);

    const result = await readMatroskaCues(filePath);
    expect(result.keyframeSecs).toEqual([5]);
  });

  it("returns null for a file with no Segment at all", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mv-ebml-synthetic-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, "junk.mkv");
    await writeFile(filePath, Buffer.concat([EBML_HEADER, Buffer.from("not a segment")]));

    const result = await readMatroskaCues(filePath);
    expect(result.keyframeSecs).toBeNull();
  });
});

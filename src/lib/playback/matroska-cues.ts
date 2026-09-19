// A minimal, dependency-free EBML reader that extracts video keyframe
// timestamps from a Matroska (.mkv/.webm) file's Cues element, without
// reading the file itself: SeekHead → Cues position when the muxer wrote
// one (MakeMKV, mkvmerge — the common case, Cues written after every
// Cluster), otherwise a fallback scan of Segment's top-level children that
// only ever reads element headers, never Cluster payloads. See V4_PLAN.md
// "The engine" → "Keyframe index".
//
// A Cues list is a *subset* of a file's real keyframes — a muxer is free to
// cue only some of them — but every entry in it genuinely is a keyframe, so
// it is always a valid (if occasionally coarser) input to
// segmentTableFromKeyframes() in keyframes.ts. ffmpeg's own HLS/Matroska
// muxer cues every video keyframe, which is what the fixtures under
// __fixtures__/ were generated with.
//
// Every read is a positional pread (FileHandle.read with an explicit
// position) so a handful of small requests suffice even over a slow share;
// `bytesRead` on the result lets tests assert this stays true. File offsets
// and element sizes are BigInt throughout — real rips exceed 4 GiB and a
// plain `number` starts losing precision well before that.

import { promises as fs } from "node:fs";

// -- Well-known Matroska/EBML element IDs (with their vint marker bits, as
// stored on disk — see readVint's `stripMarker: false` mode) --------------
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
} as const;

const TRACK_TYPE_VIDEO = 1;

// Matroska default when Info has no TimestampScale of its own: 1ms ticks.
// BigInt(...) rather than a `1000000n` literal — this repo's tsconfig
// targets ES2017, which TypeScript refuses BigInt literal syntax under.
const DEFAULT_TIMESTAMP_SCALE_NS = BigInt(1_000_000);

// Big enough for the worst case (an 8-byte id vint + an 8-byte size vint);
// real files only ever use 1-4 byte ids, but the format allows up to 8.
const HEADER_WINDOW = 16;

// Defensive bound on how many top-level Segment children we'll walk before
// giving up — real files have at most a handful (SeekHead, Info, Tracks,
// Chapters/Attachments/Tags, then Clusters, then maybe Cues); this only
// guards against a corrupt file whose sizes loop back on themselves.
const MAX_TOP_LEVEL_ELEMENTS = 200_000;

interface ByteTracker {
  bytesRead: number;
}

// @types/node's FileHandle.read only accepts a `number` position (Node
// itself accepts bigint at runtime, but the types don't say so) — this is
// the one place a BigInt file offset is narrowed back down, with an actual
// safety check rather than a silent truncation.
function toReadPosition(pos: bigint): number {
  if (pos > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Matroska file offset ${pos} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(pos);
}

interface ElementHeader {
  id: number;
  /** Payload length, or null for EBML's "unknown size" (valid only for the
   *  last element in a Master — the live-streaming case). */
  size: bigint | null;
  dataStart: bigint;
}

interface Vint {
  value: bigint;
  length: number;
}

/**
 * Parse one EBML vint (1-8 bytes) starting at `offset` in `buf`.
 * `stripMarker`: false for element IDs (kept intact, exactly as the ID
 * constants above are written), true for sizes (the length-marker bit is
 * not part of the value).
 */
function readVint(buf: Buffer, offset: number, stripMarker: boolean): Vint | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null; // reserved / corrupt: no marker bit set in 8 bytes

  let length = 1;
  let marker = 0x80;
  while (length <= 8 && (first & marker) === 0) {
    marker >>= 1;
    length++;
  }
  if (length > 8 || offset + length > buf.length) return null;

  let value = BigInt(stripMarker ? first & (marker - 1) : first);
  const byteShift = BigInt(8);
  for (let i = 1; i < length; i++) {
    value = (value << byteShift) | BigInt(buf[offset + i]);
  }
  return { value, length };
}

/** Read one element's id + size at an absolute file position. Returns null
 *  at EOF or on a structurally invalid vint (treated as "nothing more to
 *  read here" rather than thrown, since a truncated/odd trailing byte is
 *  not worth failing the whole lookup over). */
async function readElementHeader(
  fh: fs.FileHandle,
  pos: bigint,
  tracker: ByteTracker,
): Promise<ElementHeader | null> {
  const buf = Buffer.alloc(HEADER_WINDOW);
  const { bytesRead } = await fh.read(buf, 0, HEADER_WINDOW, toReadPosition(pos));
  tracker.bytesRead += bytesRead;
  if (bytesRead === 0) return null;

  const window = buf.subarray(0, bytesRead);
  const idVint = readVint(window, 0, false);
  if (!idVint || idVint.value > BigInt(0xffffffff)) return null;
  const sizeVint = readVint(window, idVint.length, true);
  if (!sizeVint) return null;

  const unknownAllOnes = (BigInt(1) << BigInt(7 * sizeVint.length)) - BigInt(1);
  const size = sizeVint.value === unknownAllOnes ? null : sizeVint.value;
  const dataStart = pos + BigInt(idVint.length + sizeVint.length);
  return { id: Number(idVint.value), size, dataStart };
}

/** Iterate the direct children of a Master element in [start, end). Stops
 *  (without error) at EOF, at a corrupt header, or at a child with unknown
 *  size (which can't be skipped past without fully parsing it). */
async function* children(
  fh: fs.FileHandle,
  start: bigint,
  end: bigint,
  tracker: ByteTracker,
): AsyncGenerator<ElementHeader> {
  let pos = start;
  let guard = 0;
  while (pos < end) {
    if (++guard > MAX_TOP_LEVEL_ELEMENTS) return;
    const header = await readElementHeader(fh, pos, tracker);
    if (!header) return;
    yield header;
    if (header.size === null) return;
    pos = header.dataStart + header.size;
  }
}

/** Read a scalar unsigned-integer element's value (also used for the
 *  4-byte binary SeekID, which is just the target element's id encoded the
 *  same way). Capped at 8 bytes — no real EBML uint is wider. */
async function readUintElement(fh: fs.FileHandle, header: ElementHeader, tracker: ByteTracker): Promise<bigint> {
  if (header.size === null || header.size === BigInt(0)) return BigInt(0);
  const len = Math.min(Number(header.size), 8);
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, toReadPosition(header.dataStart));
  tracker.bytesRead += bytesRead;
  const byteShift = BigInt(8);
  let value = BigInt(0);
  for (let i = 0; i < bytesRead; i++) value = (value << byteShift) | BigInt(buf[i]);
  return value;
}

/** SeekHead → Cues absolute file position, if the muxer wrote one. */
async function findCuesPositionViaSeekHead(
  fh: fs.FileHandle,
  seekHead: ElementHeader,
  segmentDataStart: bigint,
  tracker: ByteTracker,
): Promise<bigint | null> {
  if (seekHead.size === null) return null;
  for await (const seek of children(fh, seekHead.dataStart, seekHead.dataStart + seekHead.size, tracker)) {
    if (seek.id !== ID.Seek || seek.size === null) continue;
    let seekId: number | null = null;
    let seekPosition: bigint | null = null;
    for await (const child of children(fh, seek.dataStart, seek.dataStart + seek.size, tracker)) {
      if (child.id === ID.SeekID) seekId = Number(await readUintElement(fh, child, tracker));
      else if (child.id === ID.SeekPosition) seekPosition = await readUintElement(fh, child, tracker);
    }
    if (seekId === ID.Cues && seekPosition !== null) return segmentDataStart + seekPosition;
  }
  return null;
}

async function findTimestampScale(fh: fs.FileHandle, info: ElementHeader, tracker: ByteTracker): Promise<bigint | null> {
  if (info.size === null) return null;
  for await (const child of children(fh, info.dataStart, info.dataStart + info.size, tracker)) {
    if (child.id === ID.TimestampScale) return readUintElement(fh, child, tracker);
  }
  return null;
}

/** First video track's TrackNumber (the id CueTrackPositions.CueTrack
 *  refers to — not the same number space as the stream index ffprobe
 *  reports). */
async function findVideoTrackNumber(fh: fs.FileHandle, tracks: ElementHeader, tracker: ByteTracker): Promise<number | null> {
  if (tracks.size === null) return null;
  for await (const entry of children(fh, tracks.dataStart, tracks.dataStart + tracks.size, tracker)) {
    if (entry.id !== ID.TrackEntry || entry.size === null) continue;
    let trackNumber: number | null = null;
    let trackType: number | null = null;
    for await (const child of children(fh, entry.dataStart, entry.dataStart + entry.size, tracker)) {
      if (child.id === ID.TrackNumber) trackNumber = Number(await readUintElement(fh, child, tracker));
      else if (child.id === ID.TrackType) trackType = Number(await readUintElement(fh, child, tracker));
    }
    if (trackType === TRACK_TYPE_VIDEO && trackNumber !== null) return trackNumber;
  }
  return null;
}

/** CueTime (in TimestampScale ticks) for every CuePoint that has a
 *  CueTrackPositions entry for `videoTrackNumber`. */
async function collectCueTimes(
  fh: fs.FileHandle,
  cues: ElementHeader,
  videoTrackNumber: number,
  tracker: ByteTracker,
): Promise<bigint[]> {
  if (cues.size === null) return [];
  const times: bigint[] = [];
  for await (const point of children(fh, cues.dataStart, cues.dataStart + cues.size, tracker)) {
    if (point.id !== ID.CuePoint || point.size === null) continue;
    let cueTime: bigint | null = null;
    let matchesTrack = false;
    for await (const child of children(fh, point.dataStart, point.dataStart + point.size, tracker)) {
      if (child.id === ID.CueTime) {
        cueTime = await readUintElement(fh, child, tracker);
      } else if (child.id === ID.CueTrackPositions && child.size !== null) {
        for await (const ctp of children(fh, child.dataStart, child.dataStart + child.size, tracker)) {
          if (ctp.id === ID.CueTrack && Number(await readUintElement(fh, ctp, tracker)) === videoTrackNumber) {
            matchesTrack = true;
          }
        }
      }
    }
    if (matchesTrack && cueTime !== null) times.push(cueTime);
  }
  return times;
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

export interface MatroskaCuesResult {
  /** Sorted, de-duplicated keyframe timestamps in seconds, or null when the
   *  file has no Cues usable for its video track (no Cues element at all,
   *  an unknown-size Segment/Cluster that can't be skipped past to reach
   *  one, or a Cues with no entry for the video track). Callers should fall
   *  back to ffprobe on null. */
  keyframeSecs: number[] | null;
  /** Bytes actually fetched from disk via positional reads — never the
   *  whole file. */
  bytesRead: number;
}

/**
 * Read the Cues element of a Matroska file and return video keyframe
 * timestamps for its first video track. Never reads Cluster payloads (only
 * their ~16-byte headers, while skipping past them in the no-SeekHead
 * fallback path) and never loads the file as a whole.
 */
export async function readMatroskaCues(absPath: string): Promise<MatroskaCuesResult> {
  const tracker: ByteTracker = { bytesRead: 0 };
  const fh = await fs.open(absPath, "r");
  try {
    const fileSize = (await fh.stat({ bigint: true })).size;

    // EBML header, then skip forward (tolerating stray Void/CRC-32 before
    // Segment, though every real muxer puts Segment right after it) to find
    // Segment itself.
    const ebml = await readElementHeader(fh, BigInt(0), tracker);
    if (!ebml || ebml.id !== ID.Ebml) return { keyframeSecs: null, bytesRead: tracker.bytesRead };

    let pos = ebml.size !== null ? ebml.dataStart + ebml.size : ebml.dataStart;
    let segment: ElementHeader | null = null;
    while (pos < fileSize) {
      const header = await readElementHeader(fh, pos, tracker);
      if (!header) break;
      if (header.id === ID.Segment) {
        segment = header;
        break;
      }
      if (header.size === null) break;
      pos = header.dataStart + header.size;
    }
    if (!segment) return { keyframeSecs: null, bytesRead: tracker.bytesRead };

    const segmentDataStart = segment.dataStart;
    // Unknown-size Segment (live/streamed output): treat EOF as its end.
    const segmentDataEnd = segment.size !== null ? segmentDataStart + segment.size : fileSize;

    let timestampScale = DEFAULT_TIMESTAMP_SCALE_NS;
    let videoTrackNumber: number | null = null;
    let seekHeadCuesPos: bigint | null = null;
    let cues: ElementHeader | null = null;

    for await (const header of children(fh, segmentDataStart, segmentDataEnd, tracker)) {
      if (header.id === ID.SeekHead) {
        seekHeadCuesPos = (await findCuesPositionViaSeekHead(fh, header, segmentDataStart, tracker)) ?? seekHeadCuesPos;
      } else if (header.id === ID.Info) {
        timestampScale = (await findTimestampScale(fh, header, tracker)) ?? timestampScale;
      } else if (header.id === ID.Tracks) {
        videoTrackNumber = (await findVideoTrackNumber(fh, header, tracker)) ?? videoTrackNumber;
      } else if (header.id === ID.Cues) {
        cues = header; // found directly (e.g. -reserve_index_space puts it up front)
      }

      if (cues) break;
      // A SeekHead already told us where Cues lives — no need to keep
      // walking past every remaining Cluster header to find it ourselves.
      if (header.id === ID.Cluster && seekHeadCuesPos !== null) break;
    }

    if (!cues && seekHeadCuesPos !== null && seekHeadCuesPos >= segmentDataStart && seekHeadCuesPos < segmentDataEnd) {
      const jumped = await readElementHeader(fh, seekHeadCuesPos, tracker);
      if (jumped && jumped.id === ID.Cues) cues = jumped;
    }

    if (!cues || videoTrackNumber === null) return { keyframeSecs: null, bytesRead: tracker.bytesRead };

    const cueTimes = await collectCueTimes(fh, cues, videoTrackNumber, tracker);
    if (cueTimes.length === 0) return { keyframeSecs: null, bytesRead: tracker.bytesRead };

    // seconds = ticks * TimestampScale(ns) / 1e9. Real durations keep both
    // operands (and their product) far inside Number.MAX_SAFE_INTEGER.
    const scale = Number(timestampScale);
    const secs = sortedUnique(cueTimes.map((t) => (Number(t) * scale) / 1e9));
    return { keyframeSecs: secs, bytesRead: tracker.bytesRead };
  } finally {
    await fh.close();
  }
}

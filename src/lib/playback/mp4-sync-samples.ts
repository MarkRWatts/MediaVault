// A minimal, dependency-free ISO BMFF (.mp4/.m4v/.mov) reader that extracts
// video keyframe timestamps from a file's own sample tables -- the MP4
// counterpart of matroska-cues.ts. It walks box headers only, never mdat,
// and reads the payloads of just the handful of small boxes it needs from
// the first video track: mdhd (timescale), hdlr (is this the video track?),
// elst (edit list), and stbl's stts / ctts / stss. Every other track's
// tables are skipped, which matters for real remuxes: a Blu-ray film with a
// TrueHD track has a 70 MB moov, 60 MB of it the audio's sample tables,
// against ~3 MB for the video's timing and sync tables. See V4_PLAN.md
// "The engine" -> "Keyframe index".
//
// A keyframe's presentation time, in the video track's own timescale, is
//
//     dts(sample) + ctts(sample) - media_time + empty_edits
//
// where dts is the running sum of stts deltas, ctts the composition offset
// (0 without a ctts box), media_time the start of the track's one media
// edit (elst), and empty_edits any leading empty edits rescaled from the
// movie timescale. That is the arithmetic ffmpeg's mov demuxer applies, so
// the result matches `ffprobe -show_entries packet=pts_time,flags` --
// keyframes.ts's whole-file fallback -- to the microsecond (see the
// ground truth under __fixtures__). Keyframes are the samples listed in
// stss; a video track with no stss at all is all keyframes (ISO/IEC
// 14496-12 8.6.2), which is also how ffmpeg reads it.
//
// Anything this doesn't model returns null so the caller falls back to
// ffprobe rather than guessing: a fragmented file (samples live in moof,
// not moov), an edit list more elaborate than [empty edits..., one
// normal-rate edit], a compressed moov, or a malformed box.
//
// Every read is a positional pread, as in matroska-cues.ts, and file
// offsets are BigInt throughout -- mdat in a real remux is far past 4 GiB
// and uses a 64-bit box size.

import { promises as fs } from "node:fs";

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

// Boxes whose children we walk to reach the video track's tables.
const TRAK = "trak";
const MDIA = "mdia";
const MINF = "minf";
const STBL = "stbl";
const EDTS = "edts";

// Big enough for a box header with a 64-bit size (4 size + 4 type + 8).
const HEADER_WINDOW = 16;

// Defensive bound on how many sibling boxes we'll walk at any one level --
// real files have a handful per level; this only stops a corrupt file whose
// sizes loop back on themselves.
const MAX_SIBLINGS = 100_000;

// Upper bound on a single table payload we'll read. The largest real case
// is a long film's ctts (8 bytes per run, ~2 MB for three hours at 24 fps);
// anything far beyond that is corruption, not a table.
const MAX_TABLE_BYTES = 64 * 1024 * 1024;

interface ByteTracker {
  bytesRead: number;
}

interface BoxHeader {
  type: string;
  dataStart: bigint;
  end: bigint;
}

export interface Mp4SyncSamplesResult {
  /** Keyframe times in seconds, sorted and de-duplicated -- or null when the
   *  file has no usable index (see the top comment). */
  keyframeSecs: number[] | null;
  bytesRead: number;
}

// @types/node's FileHandle.read takes a `number` position; this narrows the
// BigInt offset with an actual check rather than a silent truncation (same
// as matroska-cues.ts).
function toReadPosition(pos: bigint): number {
  if (pos > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`MP4 file offset ${pos} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(pos);
}

async function readBoxHeader(fh: FileHandle, pos: bigint, end: bigint, tracker: ByteTracker): Promise<BoxHeader | null> {
  if (pos + BigInt(8) > end) return null;
  const want = end - pos < BigInt(HEADER_WINDOW) ? Number(end - pos) : HEADER_WINDOW;
  const buf = Buffer.alloc(HEADER_WINDOW);
  const { bytesRead } = await fh.read(buf, 0, want, toReadPosition(pos));
  tracker.bytesRead += bytesRead;
  if (bytesRead < 8) return null;

  const size32 = buf.readUInt32BE(0);
  const type = buf.toString("latin1", 4, 8);
  let headerSize = 8;
  let size: bigint;
  if (size32 === 1) {
    if (bytesRead < 16) return null;
    size = buf.readBigUInt64BE(8);
    headerSize = 16;
  } else if (size32 === 0) {
    size = end - pos; // "extends to the end of the enclosing box/file"
  } else {
    size = BigInt(size32);
  }
  if (size < BigInt(headerSize) || pos + size > end) return null;
  return { type, dataStart: pos + BigInt(headerSize), end: pos + size };
}

/** The direct children of the box spanning [start, end), headers only. */
async function childBoxes(fh: FileHandle, start: bigint, end: bigint, tracker: ByteTracker): Promise<BoxHeader[]> {
  const boxes: BoxHeader[] = [];
  let pos = start;
  while (pos < end && boxes.length < MAX_SIBLINGS) {
    const header = await readBoxHeader(fh, pos, end, tracker);
    if (!header) break;
    boxes.push(header);
    pos = header.end;
  }
  return boxes;
}

async function readPayload(fh: FileHandle, box: BoxHeader, tracker: ByteTracker): Promise<Buffer | null> {
  const length = box.end - box.dataStart;
  if (length > BigInt(MAX_TABLE_BYTES)) return null;
  const buf = Buffer.alloc(Number(length));
  const { bytesRead } = await fh.read(buf, 0, buf.length, toReadPosition(box.dataStart));
  tracker.bytesRead += bytesRead;
  return bytesRead === buf.length ? buf : null;
}

function find(boxes: BoxHeader[], type: string): BoxHeader | undefined {
  return boxes.find((b) => b.type === type);
}

/** mvhd and mdhd share a layout up to the timescale: version/flags, then
 *  32-bit (v0) or 64-bit (v1) creation and modification times. */
function parseTimescale(payload: Buffer): number | null {
  const version = payload[0];
  const offset = version === 1 ? 20 : 12;
  if (payload.length < offset + 4) return null;
  const timescale = payload.readUInt32BE(offset);
  return timescale > 0 ? timescale : null;
}

interface EditList {
  /** Leading empty edits, in the movie (mvhd) timescale. */
  emptyMovieTicks: number;
  /** Where presentation starts in the media, in the track timescale. */
  mediaTime: number;
}

/** Only [empty edits..., one normal-rate media edit] is modelled -- what
 *  ffmpeg, MakeMKV and HandBrake write. Anything else is null. */
function parseEditList(payload: Buffer): EditList | null {
  const version = payload[0];
  if (payload.length < 8) return null;
  const count = payload.readUInt32BE(4);
  const entrySize = version === 1 ? 20 : 12;
  if (payload.length < 8 + count * entrySize) return null;

  let emptyMovieTicks = 0;
  let mediaTime: number | null = null;
  for (let i = 0; i < count; i++) {
    const at = 8 + i * entrySize;
    const segmentDuration = version === 1 ? Number(payload.readBigUInt64BE(at)) : payload.readUInt32BE(at);
    const time = version === 1 ? Number(payload.readBigInt64BE(at + 8)) : payload.readInt32BE(at + 4);
    const rateInteger = payload.readInt16BE(at + entrySize - 4);
    const rateFraction = payload.readInt16BE(at + entrySize - 2);
    if (time === -1) {
      if (mediaTime !== null) return null; // an empty edit after the media: a gap mid-presentation
      emptyMovieTicks += segmentDuration;
      continue;
    }
    if (mediaTime !== null || rateInteger !== 1 || rateFraction !== 0) return null;
    mediaTime = time;
  }
  return { emptyMovieTicks, mediaTime: mediaTime ?? 0 };
}

interface Run {
  count: number;
  value: number;
}

/** stts (count, delta) or ctts (count, offset) runs. ctts offsets are read
 *  as signed whatever the box version -- version-0 files in the wild carry
 *  "negative" offsets as large unsigned values, and ffmpeg reads them signed
 *  too. */
function parseRuns(payload: Buffer, signedValues: boolean): Run[] | null {
  if (payload.length < 8) return null;
  const count = payload.readUInt32BE(4);
  if (payload.length < 8 + count * 8) return null;
  const runs: Run[] = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 8;
    runs.push({ count: payload.readUInt32BE(at), value: signedValues ? payload.readInt32BE(at + 4) : payload.readUInt32BE(at + 4) });
  }
  return runs;
}

function parseSyncSamples(payload: Buffer): number[] | null {
  if (payload.length < 8) return null;
  const count = payload.readUInt32BE(4);
  if (payload.length < 8 + count * 4) return null;
  const samples: number[] = [];
  for (let i = 0; i < count; i++) samples.push(payload.readUInt32BE(8 + i * 4));
  return samples.sort((a, b) => a - b);
}

interface VideoTrackTables {
  timescale: number;
  editList: EditList;
  stts: Run[];
  ctts: Run[] | null;
  /** 1-based sample numbers; null when the track has no stss (all sync). */
  stss: number[] | null;
}

/** The first video trak's tables, or null if it isn't one we can model. */
async function readFirstVideoTrack(fh: FileHandle, traks: BoxHeader[], tracker: ByteTracker): Promise<VideoTrackTables | null> {
  for (const trak of traks) {
    const trakChildren = await childBoxes(fh, trak.dataStart, trak.end, tracker);
    const mdia = find(trakChildren, MDIA);
    if (!mdia) continue;
    const mdiaChildren = await childBoxes(fh, mdia.dataStart, mdia.end, tracker);
    const hdlr = find(mdiaChildren, "hdlr");
    const hdlrPayload = hdlr ? await readPayload(fh, hdlr, tracker) : null;
    if (!hdlrPayload || hdlrPayload.length < 12 || hdlrPayload.toString("latin1", 8, 12) !== "vide") continue;

    // The first video track is the one ffprobe's `-select_streams v:0` means,
    // so whatever it turns out to be, it's the answer -- no looking further.
    const mdhd = find(mdiaChildren, "mdhd");
    const mdhdPayload = mdhd ? await readPayload(fh, mdhd, tracker) : null;
    const timescale = mdhdPayload ? parseTimescale(mdhdPayload) : null;
    if (timescale === null) return null;

    let editList: EditList = { emptyMovieTicks: 0, mediaTime: 0 };
    const edts = find(trakChildren, EDTS);
    if (edts) {
      const elst = find(await childBoxes(fh, edts.dataStart, edts.end, tracker), "elst");
      const elstPayload = elst ? await readPayload(fh, elst, tracker) : null;
      if (elst) {
        const parsed = elstPayload ? parseEditList(elstPayload) : null;
        if (!parsed) return null;
        editList = parsed;
      }
    }

    const minf = find(mdiaChildren, MINF);
    const stbl = minf ? find(await childBoxes(fh, minf.dataStart, minf.end, tracker), STBL) : undefined;
    if (!stbl) return null;
    const stblChildren = await childBoxes(fh, stbl.dataStart, stbl.end, tracker);

    const sttsBox = find(stblChildren, "stts");
    const sttsPayload = sttsBox ? await readPayload(fh, sttsBox, tracker) : null;
    const stts = sttsPayload ? parseRuns(sttsPayload, false) : null;
    if (!stts) return null;

    const cttsBox = find(stblChildren, "ctts");
    let ctts: Run[] | null = null;
    if (cttsBox) {
      const payload = await readPayload(fh, cttsBox, tracker);
      ctts = payload ? parseRuns(payload, true) : null;
      if (!ctts) return null;
    }

    const stssBox = find(stblChildren, "stss");
    let stss: number[] | null = null;
    if (stssBox) {
      const payload = await readPayload(fh, stssBox, tracker);
      stss = payload ? parseSyncSamples(payload) : null;
      if (!stss) return null;
    }

    return { timescale, editList, stts, ctts, stss };
  }
  return null;
}

function keyframeSecsFromTables(tables: VideoTrackTables, movieTimescale: number | null): number[] | null {
  const { timescale, editList, stts, ctts, stss } = tables;
  if (editList.emptyMovieTicks > 0 && movieTimescale === null) return null;
  // ffmpeg rescales the empty edits into the track timescale, rounding to
  // nearest, before it offsets anything -- mirror that so the times agree.
  const emptyTicks = editList.emptyMovieTicks > 0 ? Math.round((editList.emptyMovieTicks * timescale) / movieTimescale!) : 0;
  const shift = emptyTicks - editList.mediaTime;

  const keyTicks: number[] = [];
  let sample = 1; // stss numbers samples from 1
  let dts = 0;
  let stssIdx = 0;
  let cttsRun = 0;
  let cttsLeft = ctts && ctts.length > 0 ? ctts[0].count : 0;

  for (const run of stts) {
    for (let i = 0; i < run.count; i++, sample++) {
      let offset = 0;
      if (ctts && cttsRun < ctts.length) {
        while (cttsLeft === 0 && cttsRun < ctts.length - 1) cttsLeft = ctts[++cttsRun].count;
        if (cttsLeft > 0) {
          offset = ctts[cttsRun].value;
          cttsLeft--;
        }
      }

      let isKey: boolean;
      if (stss === null) {
        isKey = true;
      } else {
        while (stssIdx < stss.length && stss[stssIdx] < sample) stssIdx++;
        isKey = stssIdx < stss.length && stss[stssIdx] === sample;
      }
      if (isKey) keyTicks.push(dts + offset + shift);
      dts += run.value;
    }
  }
  if (sample === 1) return null; // no samples in moov: a fragmented file
  if (keyTicks.length === 0) return null;
  return [...new Set(keyTicks.map((t) => t / timescale))].sort((a, b) => a - b);
}

export async function readMp4SyncSamples(absPath: string): Promise<Mp4SyncSamplesResult> {
  const tracker: ByteTracker = { bytesRead: 0 };
  const fh = await fs.open(absPath, "r");
  try {
    const fileSize = (await fh.stat({ bigint: true })).size;

    // moov is usually right after ftyp (faststart) but may follow mdat;
    // either way only headers are read on the way to it.
    const moov = find(await topLevelUntilMoov(fh, fileSize, tracker), "moov");
    if (!moov) return { keyframeSecs: null, bytesRead: tracker.bytesRead };

    const moovChildren = await childBoxes(fh, moov.dataStart, moov.end, tracker);
    // Samples in moof (fragmented MP4) aren't modelled -- ffprobe handles it.
    if (find(moovChildren, "mvex") || find(moovChildren, "cmov")) return { keyframeSecs: null, bytesRead: tracker.bytesRead };

    const mvhd = find(moovChildren, "mvhd");
    const mvhdPayload = mvhd ? await readPayload(fh, mvhd, tracker) : null;
    const movieTimescale = mvhdPayload ? parseTimescale(mvhdPayload) : null;

    const tables = await readFirstVideoTrack(
      fh,
      moovChildren.filter((b) => b.type === TRAK),
      tracker,
    );
    const keyframeSecs = tables ? keyframeSecsFromTables(tables, movieTimescale) : null;
    return { keyframeSecs, bytesRead: tracker.bytesRead };
  } finally {
    await fh.close();
  }
}

/** Top-level boxes up to and including moov -- stops there so a moov-first
 *  file never touches anything after it. */
async function topLevelUntilMoov(fh: FileHandle, fileSize: bigint, tracker: ByteTracker): Promise<BoxHeader[]> {
  const boxes: BoxHeader[] = [];
  let pos = BigInt(0);
  while (pos < fileSize && boxes.length < MAX_SIBLINGS) {
    const header = await readBoxHeader(fh, pos, fileSize, tracker);
    if (!header) break;
    boxes.push(header);
    if (header.type === "moov") break;
    pos = header.end;
  }
  return boxes;
}

// The `?size=` parameter on /api/cover/:albumId, and where the resized
// copies live.
//
// Covers are stored at whatever resolution they arrived at — embedded art
// from the owner's own files is frequently 1400px or larger, and the
// biggest in this library is a 3.9 MB JPEG. Every client then downloads
// all of it to draw a 180pt grid tile. The iOS app's artwork cache made
// the cost legible: 133 album covers came to 38 MB, against 31 MB for
// every film poster, show poster and artist image put together.
//
// So the server offers smaller copies instead of each client inventing
// its own downscale. Sizes are an allowlist rather than a free number:
// an open parameter is an unbounded derivative directory and a cheap way
// to make the box do arbitrary image work.

/// The longest edge, in pixels. 128 is a list row's thumbnail, 512 a
/// phone grid tile at @3x, and 1024 a full-screen Now Playing card on a
/// phone or a tile on a TV. 256 sits between for anything in the middle.
export const COVER_SIZES = [128, 256, 512, 1024] as const;

export type CoverSize = (typeof COVER_SIZES)[number];

/// The requested size, or null for "as stored" — which is what an absent,
/// malformed or unsupported value gets, since a cover at the wrong size
/// is better than an error where an image should be.
export function parseCoverSize(raw: string | null | undefined): CoverSize | null {
  if (!raw) return null;
  const value = Number(raw);
  return (COVER_SIZES as readonly number[]).includes(value) ? (value as CoverSize) : null;
}

/// Where the resized copy of `coverPath` lives, relative to the covers
/// directory. Keeps the original's stem so the two are recognisably a
/// pair when looking at the directory by hand.
export function resizedCoverPath(coverPath: string, size: CoverSize): string {
  const stem = coverPath.replace(/\.[^./]+$/, "").replace(/\//g, "-");
  return `resized/${stem}-${size}.jpg`;
}

/// ffmpeg's scale filter for "fit inside a `size` box, and never enlarge".
/// `force_original_aspect_ratio=decrease` alone would upscale a cover
/// smaller than the box — several in this library are 250px — so the box
/// itself is capped at the source's own dimensions.
export function scaleFilter(size: CoverSize): string {
  return `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`;
}

/// The whole ffmpeg invocation, as an argument list, so the thing that
/// actually runs in production is the thing a test can assert on.
///
/// `-f image2 -c:v mjpeg` is not decoration. The route writes to a
/// uniquely-named temporary before renaming it into place, and that name
/// ends in `.tmp` — from which ffmpeg cannot infer an output format, so
/// it exits with "Error initializing the muxer" and the route falls back
/// to the stored cover. Which is exactly what it did the first time this
/// shipped: resized/ filled with nothing at all and every client kept
/// getting the full-size file, silently.
export function resizeArgs(source: string, size: CoverSize, dest: string): string[] {
  return [
    "-y",
    "-i",
    source,
    "-vf",
    scaleFilter(size),
    "-frames:v",
    "1",
    "-q:v",
    "3",
    "-f",
    "image2",
    "-c:v",
    "mjpeg",
    dest,
  ];
}

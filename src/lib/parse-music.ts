// Music path parser for the iTunes-managed layout on MUSIC_PATH:
//   Artist/Album/NN Title.m4a          (single disc)
//   Artist/Album/D-NN Title.m4a        (multi-disc, "D-NN" prefix)
//   Artist/Album/NN-Title_With_Underscores.mp3   (Bandcamp downloads)
// Track titles legitimately end in digits ("Optigan 1", "We Come 1") — the
// leading track-number match is anchored, never a trailing strip, so this
// falls out for free. Album folders may carry a trailing "[EP]"-style tag;
// everything else about the folder name (including " - DVD" suffixes with
// no brackets) is left alone and read naturally as part of the title.

export interface ParsedTrack {
  /** Path relative to MUSIC_PATH, POSIX separators: "Artist/Album/file.ext". */
  relPath: string;
  fileName: string;
  artistFolder: string;
  artistName: string;
  albumFolder: string;
  albumTitle: string;
  /** Trailing "[...]" tag on the album folder, e.g. "EP". Null when absent. */
  albumEditionTag: string | null;
  disc: number;
  trackNumber: number | null;
  title: string;
  ext: string;
  /** Non-null only for extensions with a fixed codec implication (m4p -> drm). */
  codecHint: string | null;
}

// Disc-track prefix: "D-NN " — digits, dash, digits, then whitespace before
// the title. The whitespace is what tells this apart from the Bandcamp form
// below, where the dash is glued straight to the title with no space.
const DISC_TRACK_RE = /^(\d{1,2})-(\d{1,3})\s+(.+)$/;
// Bandcamp: "NN-Title_With_Underscores" — dash glued directly to the title.
const BANDCAMP_RE = /^(\d{1,3})-(\S.*)$/;
// Plain: "NN Title".
const PLAIN_RE = /^(\d{1,3})\s+(.+)$/;

const EXT_CODEC_HINTS: Record<string, string> = {
  m4p: "drm", // FairPlay DRM — index it, badge it, can't be played elsewhere.
};

/** Split "name.ext" into [stem, lowercased ext] (ext is "" when there's no dot). */
function splitExt(fileName: string): [string, string] {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx < 0) return [fileName, ""];
  return [fileName.slice(0, dotIdx), fileName.slice(dotIdx + 1).toLowerCase()];
}

export interface ParsedTrackFileName {
  disc: number;
  trackNumber: number | null;
  title: string;
  ext: string;
  codecHint: string | null;
}

/** Parse just the file name (no directory context) into disc/track/title/ext. */
export function parseTrackFileName(fileName: string): ParsedTrackFileName {
  const [stem, ext] = splitExt(fileName);
  const codecHint = EXT_CODEC_HINTS[ext] ?? null;

  let m = stem.match(DISC_TRACK_RE);
  if (m) {
    return { disc: Number(m[1]), trackNumber: Number(m[2]), title: m[3].trim(), ext, codecHint };
  }

  m = stem.match(BANDCAMP_RE);
  if (m) {
    const title = m[2].replace(/_/g, " ").replace(/\s+/g, " ").trim();
    return { disc: 1, trackNumber: Number(m[1]), title, ext, codecHint };
  }

  m = stem.match(PLAIN_RE);
  if (m) {
    return { disc: 1, trackNumber: Number(m[1]), title: m[2].trim(), ext, codecHint };
  }

  // No leading track number — title is the basename as-is.
  return { disc: 1, trackNumber: null, title: stem.trim(), ext, codecHint };
}

export interface ParsedAlbumFolder {
  title: string;
  editionTag: string | null;
}

const ALBUM_TAG_RE = /\s*\[([^[\]]+)\]\s*$/;

/**
 * Parse an album folder name. Only a trailing bracket tag ("[EP]") is pulled
 * out; other suffixes (" - DVD") are left in the title untouched — there's no
 * reliable way to tell a real edition suffix from a title that just happens
 * to end that way, and the spec's own DVD example wants it kept as-is.
 */
export function parseAlbumFolder(folder: string): ParsedAlbumFolder {
  const m = folder.match(ALBUM_TAG_RE);
  if (m) {
    return { title: folder.slice(0, m.index).trim(), editionTag: m[1].trim() };
  }
  return { title: folder.trim(), editionTag: null };
}

/**
 * Parse an artist folder name into a display name. iTunes-sanitised folders
 * can carry ";" or "_" standing in for characters ("/", ":") that aren't
 * legal in a file name; there's no reliable way to tell those apart from
 * genuine punctuation in the artist's real name, so this is intentionally a
 * no-op beyond trimming — the folder name is treated as the name.
 */
export function parseArtistFolder(folder: string): { name: string } {
  return { name: folder.trim() };
}

/**
 * Parse one track file's path, relative to MUSIC_PATH:
 * "Artist/Album/NN Title.ext". Any extra nesting between artist and file
 * (unexpected, but tolerated) is folded into the album folder segment.
 */
export function parseTrackPath(relPath: string): ParsedTrack | null {
  const parts = relPath.split("/");
  if (parts.length < 3) return null; // not Artist/Album/file — not a track

  const artistFolder = parts[0];
  const albumFolder = parts.slice(1, -1).join("/");
  const fileName = parts[parts.length - 1];

  const { name: artistName } = parseArtistFolder(artistFolder);
  const { title: albumTitle, editionTag: albumEditionTag } = parseAlbumFolder(albumFolder);
  const { disc, trackNumber, title, ext, codecHint } = parseTrackFileName(fileName);

  return {
    relPath,
    fileName,
    artistFolder,
    artistName,
    albumFolder,
    albumTitle,
    albumEditionTag,
    disc,
    trackNumber,
    title,
    ext,
    codecHint,
  };
}

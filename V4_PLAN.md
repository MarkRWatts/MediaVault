# MediaVault — v4.0.0 Plan (playback without Jellyfin)

v4.0.0 makes MediaVault play films and episodes on its own. Today every
in-app play is brokered through a Jellyfin server (PLAYBACK_PLAN.md,
"Status"): MediaVault asks Jellyfin for a playback session and proxies its
HLS playlist and segments. After v4.0.0 the only thing MediaVault needs
beside the media share is an ffmpeg binary and, optionally, the host's
Intel iGPU.

This is a reimplementation, not an extraction. Jellyfin's transcoding code
is C#/.NET, GPL-2 and wired into its own item database and session model;
none of it can be lifted into a Next.js app. What is worth taking is the
*design* — a complete VOD playlist computed up front, segments produced on
demand, ffmpeg restarted wherever the viewer seeks — and the ffmpeg build
that design was tuned against.

## Why the first local pipeline was parked, and what changes

The pipeline behind `IN_APP_PLAYBACK=1` (`src/lib/video-cache.ts`,
`buildHlsFfmpegArgs`) let ffmpeg's HLS muxer write an *event* playlist that
grew as the encode progressed. Three consequences sent playback to Jellyfin
on 5 Sep 2026:

| Problem then | v4 answer |
|---|---|
| No seeking past what ffmpeg had written; resume waited for the encoder | The playlist is synthesised by the app and complete from the first request. A request for a segment that doesn't exist restarts ffmpeg at that segment (`-ss`, `-start_number`). |
| Apple's native player treated the growing playlist as a live broadcast (no timeline, clamped seeks, `duration = Infinity`) | The playlist is `#EXT-X-PLAYLIST-TYPE:VOD` with `#EXT-X-ENDLIST` from the start. `src/lib/pending-seek.ts` and the Safari-on-Mac hls.js workaround become unnecessary. |
| A 4-core VM transcoding with libx264 on two threads | The i5-6600K's iGPU (HD Graphics 530) is passed through to the MediaVault VM; video decode, scale and H.264 encode run on Quick Sync. |

## Hardware: what HD Graphics 530 covers

| | Hardware | Notes |
|---|---|---|
| Decode H.264, HEVC 8-bit, MPEG-2, VC-1 | yes | Every source in the library today: Blu-ray and DVD rips. VC-1 and MPEG-2 "Original" plays stop being a two-thread libx264 encode. |
| Encode H.264 | yes | Remote (720p) variant and the Original of non-copyable video. |
| Decode HEVC 10-bit, HDR tone-mapping | no (Kaby Lake and later) | **Out of scope for 4.0.0** — there is no 4K/HDR content in the library. The engine detects a 10-bit source from the probe and decodes it in software so such a file still plays; tone-mapping is future work (see "Later"). |

### Measured on the VM (19 Sep 2026)

jellyfin-ffmpeg 8.1.2-5 in an unprivileged container (uid 1000, render
gid added, `/dev/dri/renderD128`), iHD driver 26.2.4, 60 s from the middle
of each file, reading from the share. The VM has 2 vCPUs.

| Source → output | libx264, 2 threads | QSV | VAAPI |
|---|---|---|---|
| H.264 1080p remux → 720p 3 Mbit/s (Remote) | 2.4× realtime | 13.5× | 13.7× |
| VC-1 1080p → 720p 3 Mbit/s (Remote) | 2.5× | 15.7× | 15.5× |
| VC-1 / H.264 1080p → 1080p high quality (Original of non-copyable video) | — | 8× | — |
| MPEG-2 576i DVD → deinterlaced H.264 (Original) | 7.5× | 26× | 38× |

Quality at 720p / 3 Mbit/s on a 30 s action clip (SSIM against the scaled
source): libx264 `veryfast` crf 23 0.972 (at 2.2 Mbit/s), **VAAPI 0.969**.
The QSV runs scored 0.88 regardless of preset or bitrate, which points at
a frame-alignment or scaling difference in that pipeline rather than
encoder quality; not investigated further because VAAPI matches it on
speed with one less layer.

**Decision: `PLAYBACK_HWACCEL=vaapi` in production.** The Remote ceiling
stays at 3 Mbit/s.

The library today is 241 H.264, 14 VC-1 and 8 MPEG-2 film files and 77
H.264 episode files — no HEVC. Almost every Original play is a video
copy; the hardware encoder serves Remote and the 22 non-copyable titles.

## Design

### ffmpeg: jellyfin-ffmpeg, pinned

The runner image moves from `node:22-alpine` + `apk add ffmpeg` to
`node:22-bookworm-slim` + the `jellyfin-ffmpeg8` `.deb` from
github.com/jellyfin/jellyfin-ffmpeg (8.1.2-5 at the time of writing; ships
`-bookworm_amd64.deb` and `-trixie_amd64.deb`, no musl build — hence the
base change). Reasons:

- The package bundles its own matched libva + Intel iHD driver under
  `/usr/lib/jellyfin-ffmpeg/`, including `vainfo`. No driver assembly.
- It carries the fMP4/HLS muxer and QSV/VAAPI filter patches the
  segment-on-demand design was developed against.
- It is the build Jellyfin itself runs: any Jellyfin server's transcode
  log shows a known-good command line for the same binary.

It is a standalone binary invoked as a subprocess (as Alpine's ffmpeg is
today): no server, no API, no licence effect on the app.

Details:

- Both Docker stages move to bookworm (`better-sqlite3` is compiled in the
  builder and must match the runner's libc). `tini`, the non-root `node`
  user, read-only root and the SIGTERM handling carry over.
- The binaries live outside `$PATH`: new `FFMPEG_PATH` / `FFPROBE_PATH`
  env (defaulting to `ffmpeg` / `ffprobe` for local dev), read in one place
  and used by the scanner, audio pipeline and video engine alike.
- The exact version is pinned in the Dockerfile with its SHA-256 and
  upgraded deliberately.
- Local dev: the docker ffmpeg shim points at an image with the same
  jellyfin-ffmpeg, so dev and prod run one binary. CI and the Mac have no
  iGPU, so the software path (below) stays first-class and is what the
  test suite exercises.

### Hardware switch

`PLAYBACK_HWACCEL = qsv | vaapi | none` (default `none`). The argument
builder has one software pipeline (libx264, as today) and one hardware
pipeline; nothing else in the engine knows which is in use.

- Hardware: `-hwaccel … -hwaccel_output_format …` → hardware scale →
  `h264_qsv`/`h264_vaapi`, with a fixed GOP (`-g` = fps × segment length,
  matching `-keyint_min`, plus `-force_key_frames`) so encoded segment
  boundaries land exactly where the playlist says.
- 10-bit source (from the probe's `pix_fmt`): software decode →
  `format=nv12,hwupload` → hardware encode.
- At startup the app runs one tiny hardware encode (`testsrc` → null). If
  it fails, the engine logs why, falls back to `none` and says so on the
  admin page — a missing render node or wrong group id degrades playback,
  it doesn't break it.
- Production runs `vaapi` (see "Measured on the VM"); `qsv` stays
  selectable.

### The engine (`src/lib/playback/`)

Replaces `jellyfin-playback.ts` and the event-playlist half of
`video-cache.ts`. It keeps that module's cache accounting (budget, LRU
eviction, orphan sweep, free-disk check, SIGTERM) and
`video-playback.ts`'s planning (`planVideoPlayback`, `pickAudioTrack`,
variants).

**Stream key.** `<kind>-<id>-<variant>-a<audioStreamIdx>` names one
deterministic rendition of one file. Its directory under `VIDEO_CACHE_DIR`
holds `seg_NNNNN.ts` and a `plan.json` (segment table + source mtime/size,
so a changed file invalidates the directory).

**Segment table.** Computed once per key, before any ffmpeg runs, and
*dictated to* ffmpeg rather than predicted from it:

- *Transcoded video*: fixed `HLS_SEGMENT_SECS` (6 s) boundaries; the last
  segment takes the remainder of the probed duration.
- *Copied video*: boundaries can only fall on source keyframes. A new
  segment starts at the first indexed keyframe ≥ 6 s after the previous
  cut.

**Keyframe index.** New `KeyframeIndex` table (kind, file id, mtime/size
cache key, packed keyframe timestamps).

- MKV (nearly the whole library): read the Matroska `Cues` element — a
  small EBML reader that seeks to `SeekHead` → `Cues` and reads a few
  hundred KB, not the file. Fast even over the CIFS share. A Cues list may
  be a subset of the file's keyframes; that is fine, because every cue *is*
  a keyframe and the cut list only ever names cues.
- Anything else, or an MKV without cues: `ffprobe -show_entries
  packet=pts_time,flags` restricted to the video stream. This reads the
  whole file, so it runs at scan time in the background, never in a
  request.
- Filled by the scanner for new/changed files, with a one-off backfill
  script. A copy-tier play of a file with no index yet builds it on demand
  behind a "preparing" state; it is never guessed.

**Playlists.** `master.m3u8` (one variant, with `CODECS`, `RESOLUTION`,
`BANDWIDTH` — AVPlayer is happier with a master) and `main.m3u8` rendered
from the segment table: `VOD`, `EXT-X-INDEPENDENT-SEGMENTS`, `ENDLIST`.

**Heads.** A *head* is one ffmpeg process writing consecutive segments
into a key's directory, from segment N onward, written to temp names and
renamed into place on completion, so a half-written segment is never
served and two heads can never corrupt each other.

The shape of a head was settled by experiment on the VM (19 Sep 2026,
stream-copying a Blu-ray remux whose keyframes are ~1 s apart) — the first
design, ffmpeg's `hls` muxer with `-hls_time 6` and a playlist predicted
from the keyframe index, does not survive a restart:

- The `hls` muxer cuts at the first keyframe ≥ 6·k seconds *from the start
  of the run*. A head restarted at segment N has a different grid from the
  run that started at 0, so its later boundaries drift off the playlist
  (segment 7 differed in the test). `-hls_init_time` doesn't realign it.
- **So ffmpeg is told where to cut:** `-f segment -segment_times
  <cuts relative to this head's first packet> -segment_time_delta 0.02
  -segment_start_number N -break_non_keyframes 0`. A head started at 0 and
  a head restarted at segment 6 then produce the same video segments,
  packet for packet.
- **Segments are MPEG-TS** (`-segment_format mpegts`, `h264_mp4toannexb`).
  The segment muxer starts a fresh container per file: MP4 segments come
  out with timestamps reset to zero, TS segments keep the absolute
  `-copyts` timeline and need no init segment. Native HLS and hls.js
  (1.6, including AC-3 in TS) both take it. The cost is HEVC, which Apple
  only plays from fMP4 — no HEVC in the library today; see "Later".
- **Seeking to a keyframe:** `-noaccurate_seek -ss <keyframe + 0.135 s>`.
  ffmpeg subtracts 3/23 s from the seek target when the video has B-frames,
  so `-ss <keyframe>` itself lands one keyframe early (seen in the test);
  the offset is clamped below the following keyframe.
- **Audio seam:** a restarted head's audio begins ~80 ms after its first
  video frame. That is the point a player has just seeked to, so it is
  inaudible there; a viewer playing *across* a boundary between segments
  written by different heads gets a single ~0.25 s audio dropout.
  Accepted for 4.0.0; a second, accurately seeked audio input is the fix
  if it is ever noticed.

Segment request for N:

1. On disk → serve it (immutable, long `Cache-Control`).
2. A live head for this key is at most a few segments behind N → wait for
   it (bounded).
3. Otherwise stop this session's head and start a new one at N.

Because segments are deterministic per key, the directory *is* the cache:
a second viewer, a resume tomorrow or a replay reuses whatever exists, and
a fully populated directory (`.complete`) needs no ffmpeg at all. This is
the one place v4 deliberately improves on Jellyfin, which transcodes per
session and throws the output away.

**Housekeeping.**

- Run-ahead throttle: a head more than ~3 min (transcode) / ~10 min
  (remux) ahead of the newest request is paused (`SIGSTOP`) and resumed
  (`SIGCONT`) as the viewer catches up. A remux no longer drags a whole
  40 GB file across the share for someone who watches five minutes.
- Idle: no request for a session in `IDLE_CANCEL_MS` stops its head;
  `stop` stops it now (the existing `noteViewerLeft` behaviour).
- Concurrency: `PLAYBACK_MAX_SESSIONS` (default 2, reads
  `JELLYFIN_MAX_SESSIONS` as a fallback for one release) caps live heads;
  the 503 + `Retry-After` message clients already handle is unchanged.
- Budget: partial directories are ordinary cache entries; a directory with
  a live head is pinned. `VIDEO_CACHE_MAX_BYTES` and eviction as today.
- ffmpeg only ever receives validated integers and enum values plus a path
  resolved from the database; `-protocol_whitelist file,pipe`; segment
  names are matched against a strict pattern before touching the disk.

**Session-time probe.** `session` runs `ffprobe` on the file (container
header only; cached by mtime/size). It supplies what the database doesn't
hold for every kind of file — audio streams for episodes (`EpisodeFile`
has only `audioSummary`), `pix_fmt`, frame rate — so the audio menu and
the hardware decisions are ground truth for films and episodes alike.

### HTTP contract

The clients (web `VideoPlayer`, iOS `VideoSession`, the tvOS shell) already
speak a small, engine-agnostic protocol: `POST session` → play the returned
`playlistUrl` → `POST progress` → `POST stop`. v4 keeps it and renames it:

| Route (under `/api/video/:versionId` and `/api/tv-video/:episodeFileId`) | |
|---|---|
| `POST play/session?variant=&audio=` | `{ playlistUrl, playSessionId, durationSecs, transcodeReasons, audioTracks }` — same shape as today. |
| `GET play/<key>/master.m3u8`, `main.m3u8`, `seg_NNNNN.ts` | Session cookie or bearer on every request, as now. |
| `POST play/stop?playSessionId=` | |
| `progress` | Unchanged. |

- `/jf/session` and `/jf/stop` remain as aliases of the new handlers for
  one release, so installed iOS and tvOS builds keep playing. Clients never
  construct playlist URLs — they follow `playlistUrl` — so nothing else
  needs aliasing. `server.minAppBuild` retires the aliases in 4.1.
- `/api/v1`: a version or episode file is `playable` when it has been
  probed and `planVideoPlayback` returns a plan — no longer "has a
  `jellyfinId`". `me.features` gains `playback: true`; `features.jellyfin`
  stays in the payload (the iOS DTO decodes it) and mirrors `playback`
  until the aliases go.
- `/stream` (byte-range direct play), `/status`, `/prepare`, `/leave` and
  `hls/[variant]/[file]` are removed with the event-playlist pipeline.
  Every play is HLS in 4.0.0; a direct-play fast path for files that are
  already MP4/H.264 is a possible later optimisation (a remux of such a
  file is nearly free and caches).

### Player

`VideoPlayer.tsx` loses `PlaybackSource` and the whole `local` branch
(status polling, tiers, pending-seek for event playlists, the "preparing up
to" note). One mode remains: session → playlist → hls.js or native HLS.
With a true VOD playlist, Safari on the Mac can go back to native HLS and
regain AirPlay — verified in phase 4 before the hls.js gate is removed.

## Removing Jellyfin

Deleted once the engine is the default:

- `src/lib/jellyfin-playback.ts`, `jf-routes.ts` and `jf-viewer.ts`
  (handlers and viewer lookup move into the engine's routes).
- Library sync: `runJellyfinSync` and the path matching in
  `src/lib/jellyfin.ts`, `/api/jellyfin-sync`, the scanner's post-scan
  trigger, the "Relink Jellyfin" control and status line in
  `ScanControls`, the Jellyfin row on the admin page. `JELLYFIN` stays a
  readable `RunKind` so historical run rows still render.
- Schema: drop `jellyfinId` from every model that carries it (one
  migration); the queries and DTO fields that select it.
- Config: `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_*_PREFIX`,
  `JELLYFIN_MAX_SESSIONS`, `IN_APP_PLAYBACK` leave the compose files and
  env templates; `PLAYBACK_HWACCEL`, `PLAYBACK_MAX_SESSIONS`,
  `FFMPEG_PATH`, `FFPROBE_PATH` arrive.

**Kept in 4.0.0: MediaVault as an OIDC provider** (HOUSEHOLDS_PLAN.md,
"Jellyfin SSO" — `/consent`, the trusted-client registration form, the
`jellyfinUserId` link). That is Jellyfin depending on MediaVault, not the
reverse, and the household's main Jellyfin instance keeps working with it.
It can be retired in a later release if that instance ever is; the
`jellyfin.markrwatts.com` edge proxy on the VM follows the same decision.

## Infrastructure (`ansible-homelab`)

1. **Move the iGPU.** In `roles/vm_provision/defaults/main.yml`, take
   `machine: q35` and `hostpci0: mapping=igpu,pcie=1,rombar=0` off
   `jellyfin-vm` and put them on `mediavault-vm` (653). The `igpu` PCI
   mapping on the host already exists. Consequences to plan for:
   - Switching an existing VM to q35 can rename its NIC (`ens18` →
     `enp6s18`); check how the guest's network config matches the
     interface (by MAC is safe) *before* the change, with console access
     to hand, and take a Proxmox backup first.
   - A VM with a passed-through device has all its memory pinned — 4 GiB
     today; consider 6 GiB now that ffmpeg heads run next to Next.js.
   - `jellyfin-vm` falls back to software transcoding. It is a trial
     instance; production playback until cut-over goes through the main
     Jellyfin server, which this move doesn't touch.
2. **Render node in the container.** Reuse the pattern in
   `roles/jellyfin/tasks/main.yml`: assert `/dev/dri/renderD128` exists,
   look up the VM's `render` gid, template it into `.env.docker`
   (`RENDER_GID`). `docker-compose.prod.yml` gains
   `devices: [/dev/dri/renderD128]` and `group_add: ["${RENDER_GID}"]`.
   The hardening stays as is: `user: 1000:1000`, `read_only`,
   `cap_drop: [ALL]`, `no-new-privileges` — a render node needs none of
   them relaxed. The base compose file (Mac dev) gets no device.
3. **Deploy-time proof.** The playbook runs
   `/usr/lib/jellyfin-ffmpeg/vainfo --display drm --device
   /dev/dri/renderD128` inside the app container and fails the deploy if
   `VAEntrypointEncSlice` for H.264 is missing (the same check the
   Jellyfin role does today). `intel-gpu-tools` on the VM for
   `intel_gpu_top`.

## Phases

| # | Work | Est. |
|---|---|---|
| 0 | **Hardware and binary proof.** Move the iGPU; bookworm image with pinned jellyfin-ffmpeg; `FFMPEG_PATH`/`FFPROBE_PATH`; compose + Ansible device/group wiring; `vainfo` gate. By hand on the VM: one 1080p H.264 → 720p hardware transcode, one VC-1 and one MPEG-2 source, measured speed and `intel_gpu_top`; pick `qsv` or `vaapi`. Ships to production on its own — the scanner and audio pipeline run on the new binary while playback still goes through Jellyfin. | 2 days |
| 1 | **Keyframe index.** EBML `Cues` reader + ffprobe fallback, `KeyframeIndex` table, scanner hook, backfill script. Tests against real MKVs: cue times vs an ffprobe ground truth. | 3 days |
| 2 | **Engine.** Segment table (both kinds), playlist rendering, head lifecycle (start/seek-restart/throttle/idle/stop), temp-and-rename writes, cache accounting on the new layout, session-time probe, software argument builder. Unit tests for tables, playlists and head decisions; a real-ffmpeg integration test that requests segment 0, then a far segment, then one in between, and checks each against ffprobe for start time and duration. | 6 days |
| 3 | **Hardware pipeline.** QSV/VAAPI argument builder, GOP alignment, 10-bit software-decode fallback, startup self-test with fallback to software, admin-page status. Verify hardware-encoded segment boundaries against the table on the VM. | 3 days |
| 4 | **Routes, clients, cut-over flag.** `play/*` routes with `/jf/*` aliases, `/api/v1` `playable`/`features` change, `PLAYBACK_ENGINE = jellyfin \| local` (default `jellyfin`) replacing `IN_APP_PLAYBACK`, `VideoPlayer` single-mode with the engine selected server-side; `scripts/e2e-playback.ts` rewritten for seek-anywhere (play, seek far ahead cold, seek back, switch quality and audio keeping position, resume). | 3 days |
| 5 | **Verification on real hardware** with `PLAYBACK_ENGINE=local` in production and Jellyfin one env var away. Matrix below; fix what it finds. | 5 days |
| 6 | **Remove Jellyfin and release.** Flip the default, soak for a week, then the deletion PR ("Removing Jellyfin"), schema migration, env and compose cleanup, docs (README, DEPLOYMENT, PLAYBACK_PLAN "Status", IOS_PLAN's video section), `package.json` → 4.0.0, tag `v4.0.0`. | 3 days |

**Total ≈ 25 working days.** Phases 0 and 1 are independent of each other
and of everything user-visible; 2 and 3 can overlap once the argument
builder's interface is fixed. Nothing before the phase 6 deletion is
irreversible: until then a bad evening is fixed by setting
`PLAYBACK_ENGINE=jellyfin`.

### Phase 5 matrix

Players: Safari (Mac, native HLS and hls.js), Chrome (hls.js), iPhone and
iPad app (AVPlayer), tvOS shell, each on the LAN and over Tailscale from
outside.

Sources: H.264 Blu-ray remux with DTS-HD/TrueHD (video copy + audio
transcode); HEVC 8-bit; VC-1 (Bourne Identity); MPEG-2 DVD, including an
interlaced one (hardware deinterlace); a long-GOP encode (segments well
over 6 s); a variable-frame-rate file; a multi-audio title with a
descriptive track (Captain Marvel); an MP4 that would previously have
direct-played.

Per combination: cold start time, seek far ahead cold, seek back into
cached segments, resume from `WatchProgress`, quality switch and audio
switch keeping position, A/V sync after each seek, two simultaneous
viewers of the same file at different positions, the 503 at the session
cap, idle stop, and a container restart mid-play.

## Risks

- **Copy-tier segment boundaries.** Settled by experiment (see "Heads"):
  ffmpeg is given the cut list, and the integration test compares every
  produced segment's first timestamp and duration with the table, from a
  cold start and after a restart. Last resort for a pathological file is
  to transcode its video (hardware makes that affordable).
- **MPEG-TS on every client.** The clients are verified today on fMP4 from
  Jellyfin. TS is HLS's original container and the safer bet for splicing,
  but phase 5 is where AVPlayer, Safari and hls.js confirm it.
- **Share throughput — measured, not a constraint.** With the Proxmox
  host and the NAS both on 2.5 GbE (19 Sep 2026), reads from the share
  inside the app container run at ~260 MiB/s single-stream (≈2.2 Gbit/s,
  line rate) and ~140 MiB/s each for two parallel streams; a cold 2 MiB
  read at a random offset in a 40 GB file takes ~40 ms. The ~90 Mbit/s
  ceiling seen in early September is gone. A 40 Mbit/s remux uses about
  2% of the link, and a seek's read cost is negligible next to ffmpeg's
  start-up time.
- **q35 conversion of a production VM** (above): backup, console access,
  NIC naming.

## Later (not 4.0.0)

- **Subtitles.** Owning the playlist makes text subtitles cheap: WebVTT
  renditions in a `SUBTITLES` group on the master playlist, extracted per
  segment window. Image subtitles (PGS) still mean burn-in and a video
  encode — affordable now on the iGPU.
- **HEVC sources.** Apple plays HEVC only from fMP4, so an HEVC copy tier
  needs fMP4 segments with absolute `tfdt` (rewritten per segment, or a
  patched muxer). Until then an HEVC source would be transcoded to H.264.
- **HDR and 10-bit.** When 4K content arrives: HD Graphics 530 can't
  decode HEVC Main10, so either software decode + `tonemap_opencl` (needs
  Intel's legacy OpenCL runtime for Gen9) or a newer iGPU; and prefer an
  SDR Version of the same film as the Remote source when one exists.
- **Adaptive bitrate.** Both variants in one master playlist; each rung is
  its own head, so it waits until concurrency on the iGPU is understood.
- **Direct-play fast path** for files that need no remux.
- Retire the `/jf/*` aliases, `features.jellyfin`, and — if the household's
  Jellyfin server is ever retired — the OIDC provider.

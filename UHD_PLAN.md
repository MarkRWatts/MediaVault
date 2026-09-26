# MediaVault — playing everything, everywhere, without Jellyfin

The goal this plan serves: **delete Jellyfin entirely** and have MediaVault
play every file in the library, on every client in the household, at the
highest quality that client can actually take.

[V4_PLAN.md](V4_PLAN.md) got playback off Jellyfin's transcoder and onto our
own engine. This plan covers what is still missing before the Jellyfin
instance can be switched off: HEVC for Apple's native players, picking the
right Version per client, and the cache behaviour that 4K sources demand.

Triggered by three films being ripped from 4K UHD Blu-ray on 20 Sep 2026.
All three already exist as 1080p Blu-ray rips, so nothing is unplayable
today — but they are the first files the engine cannot serve to an Apple
client at full quality, and they expose the general problem.

## Status (23 Sep 2026)

Phase B under way (below). **Revised 23 Sep** after the library was converted to
MP4 (22–23 Sep): every film and episode is now MP4 with H.264 video (HEVC for
the three UHD films), a default AAC track, faststart, no subtitles. The three
UHD films were remuxed on 23 Sep — HEVC Main10 copied untouched (tagged
`hvc1`), AAC 5.1 made from the TrueHD Atmos as the default track, the TrueHD
Atmos kept beside it; the DD 5.1 core, audio description and PGS dropped.

That conversion changes the shape of this plan: **direct play replaces
phases A and C for HEVC-capable clients** (see the first decision below), and
phase B becomes the one load-bearing piece. The 20 Sep analysis below is kept
where it still holds and marked where it doesn't.

## The household

| Client | Link | Notes |
|---|---|---|
| Apple TV 4K | wired 1 Gbit | 4K HDR TV; 5.1 AVR (DD/DTS/Atmos-capable) in the HDMI path |
| iPad Mini | Wi-Fi | iOS app |
| iPhone 16 Pro ×2 | Wi-Fi | iOS app |
| MacBook Pro | — | Safari, native HLS |
| Windows 11 | — | Chrome, hls.js. ~5% of use |

Roughly 95% Apple, 5% Chrome. The web UI and the iOS apps are in good shape
today (music especially; video less exercised). The tvOS app exists only as
a stub and will be built — phase D.

## Measured, so it need not be re-derived

Production VM (192.168.6.53), 20 Sep 2026:

| | |
|---|---|
| Engine | `PLAYBACK_ENGINE=local`, `PLAYBACK_HWACCEL=vaapi` |
| Cache budget | `VIDEO_CACHE_MAX_BYTES=42949672960` (40 GiB) |
| Disk | `/dev/sda1` 79 G total, 26 G used, **50 G free**; video-cache 11 G of that |
| 1080p remux anchor | `film-504-original-a1`: 301 segments / 7549 MB = **25.1 MB per 6 s segment**, ≈33 Mbit/s |

Library audio (263 Versions, `AudioTrack` table):

| Codec | Count |
|---|---|
| ac3 | 222 |
| dts | 96 plain, **60 DTS-HD MA**, 4 DTS-ES, 2 DTS-HD MA + DTS:X |
| truehd | 9 plain, **6 TrueHD + Atmos** |
| pcm_s16le | 1 |
| eac3 | **none** |

- 75 of 263 Versions have a default audio track that is not copyable.
- Of those 75, only **6** have an equal-or-better AC-3 track to copy
  instead. See "Decisions" — this kills an obvious-looking optimisation.

> **Caveat on both figures (20 Sep 2026).** `isDefault` and `isDescriptive`
> are false on every AudioTrack row — the columns postdate every probe in the
> table, exactly as the schema comment anticipates. So "default audio track"
> above cannot have come from `isDefault`; it must be first-by-stream-index.
> The codec and channel columns those counts rest on *are* populated, so the
> figures stand, but anything reasoning about defaults or descriptive tracks
> needs a forced re-scan first. The flags are present in the files — ffprobe
> across 11 titles found `default=1` on the first track of every one.

Client and tooling facts:

- **The AVR reports "Multi-Ch In"** when Infuse plays a TrueHD Atmos disc
  from Jellyfin. So Infuse decodes in-app and the Apple TV sends
  multichannel LPCM; nothing is bitstreamed and no Atmos reaches the
  receiver today. tvOS does not let a third-party app bitstream TrueHD.
- **Disney+ and Netflix do deliver Atmos** on the same Apple TV. They ship
  E-AC-3 with JOC, which tvOS passes through. The platform and HLS both
  support this; our source tracks don't feed it.
- **hls.js 1.6.15** (the version in `package.json`) demuxes HEVC from
  MPEG-TS — stream type `0x24`. So Chrome on capable hardware would play a
  4K copy-tier stream today. Apple's native HLS will not, at any bit depth.
- **The Mac** (dev machine) is an M5 Max, 18 cores, 128 GB. Homebrew ffmpeg
  9.0.2 has VideoToolbox, libx264/libx265 and libvmaf but **no libzimg or
  libplacebo**, so no `zscale` and no usable HDR tone-mapping. The
  already-pulled `mwader/static-ffmpeg:latest` (9.0.1, linux/arm64 native)
  does have libzimg, but no VideoToolbox — Docker can't reach it.

Projected for a UHD remux at 55–85 Mbit/s:

| | 1080p remux (measured) | UHD remux (projected) |
|---|---|---|
| Per 6 s segment | 25 MB | 50–60 MB |
| Whole 2 h film | ~30 GB | 60–75 GB |
| Live stream steady state | ~3 GB | ~6.6 GB |
| Reaches `.complete` under the budget | yes, barely | **never** |

## The four constraints that decide the design

**1. HD Graphics 530 cannot decode HEVC Main10.** A 4K HDR source can
therefore only ever be *copied* — the VM cannot produce a transcoded
rendition of it at any resolution, and there is no tone-mapping filter
anywhere in the engine ([head-args.ts:237](src/lib/playback/head-args.ts:237)
falls back to software decode and `format=nv12`, which is a naive
10-bit→8-bit downconvert reading PQ/BT.2020 as SDR). This is silicon, not
code. **The fallback for a client that can't take HEVC Main10 is the 1080p
H.264 Version, not a transcode** — which is what makes phase B load-bearing
rather than a nicety.

**2. Apple's native HLS requires fMP4 for HEVC.** `SUPPORTED_VIDEO_CODECS`
([video-playback.ts:64](src/lib/video-playback.ts:64)) includes `hevc`, so a
UHD source takes the copy tier and
[head-args.ts:144](src/lib/playback/head-args.ts:144) writes TS segments
with `hevc_mp4toannexb`. AVPlayer and Safari refuse that. Phase A.

**3. HLS carries AAC, AC-3 and E-AC-3 — nothing else.** No lossless in any
form, and no DTS at all. For the ~75 films with DTS-HD MA or TrueHD
soundtracks, Infuse currently delivers lossless decoded to PCM and
MediaVault will deliver AAC 5.1 at 384k
([head-args.ts:346](src/lib/playback/head-args.ts:346)). **This is the one
genuine quality concession in retiring Jellyfin.** It applies to the 1080p
library, not the UHD films, and whether it is audible is a listening
judgement, not an engineering one.

**The concession is one client wide, not library wide.** The Apple TV 4K is
the only device in the household with a 5.1 path; iPad, iPhone, MacBook and
the Windows PC are stereo at most. On every one of those the lossless
original and the 384k AAC 5.1 both arrive as stereo after the client's own
downmix, so the step is inaudible by construction. Open question 5 is
therefore an AVR listening test and nothing else — which is also why
"Later → direct play" is correctly scoped to the Apple TV alone.

The inverse of that observation is a live inefficiency, not a concession:
`audioTranscodeChannels` ([video-playback.ts:228](src/lib/video-playback.ts:228))
keys off the *source* channel count and knows nothing about the client, so a
phone on Wi-Fi is sent 384k of 5.1 it will fold to stereo — roughly double a
purpose-made stereo AAC, with the downmix left to whatever the client does.
See phase B.

**4. Atmos over HLS needs an E-AC-3 JOC track to copy.** The library has no
E-AC-3 at all, and ffmpeg cannot create JOC — that needs Dolby's licensed
encoder. So Atmos is unreachable from these discs by any home-built route,
including direct play. Note this costs nothing relative to today: the AVR
isn't receiving Atmos from Infuse either.

## Decisions

**Direct play, not fMP4 HLS, for the UHD Versions (23 Sep 2026).** Phase A
existed because the UHD films were MKV: Apple's players can't open MKV, so
the only route to them was HLS, and Apple's HLS won't take HEVC in TS
segments. Now the files are MP4 — HEVC Main10 HDR10 in a faststart MP4 is
exactly what AVFoundation (Safari, iOS, tvOS) plays natively from a URL with
byte ranges, and `/api/video/:versionId/stream` already serves that (auth,
range support; it only ever refused non-MP4 containers). Consequences:

- **Phase A is dropped** (3–5 days, and this document's least certain
  estimate). Revive it only if 4K must ever stream *as HLS* — to hls.js, say.
- **Phase C loses its 4K motivation.** A direct-played file never touches the
  segment cache, so a 60–75 Mbit/s film can't thrash it. C remains worth its
  day for the 1080p remuxes on the engine.
- **Phase B carries the weight** and grows one decision: for a client that
  can take a Version as-is, hand it the file; otherwise the engine. See B.
- **Audio is unchanged by this.** AVFoundation lists the kept TrueHD track
  but won't decode it (checked 22 Sep: `mlpa`, not playable, disabled) and
  doesn't list DTS at all, so an Apple client plays the default AAC 5.1 —
  the same AAC the engine would send. Constraints 3 and 4 stand. The same
  check showed the extra lossless tracks don't stop the file playing on
  AVFoundation or Chromium: both play the AAC and ignore the rest.
- **It applies to the whole library, not only UHD.** Every converted 1080p
  film is H.264 + AAC in faststart MP4 — direct-playable on every client in
  the household. Today the session route sends all of them through the
  engine's HLS copy tier anyway (the web player has a `direct` tier; the
  session path never selects it). Direct play at home would skip segments,
  cache and keyframe index for everything; the engine would remain for the
  Remote variant and for anything that isn't already playable as-is.

**Keep 4K and HDR; do not tone-map.** All three films exist as 1080p Blu-ray
rips. The studio's own SDR grade beats any automatic tone-map, so a Mac-side
HDR→SDR transcode buys nothing that isn't already on the shelf. `Version`
already carries `videoRange` (`SDR|HDR10|HLG|DOLBY_VISION`), `width`/`height`
and `format`, and `classifyFormat` tags width ≥ 3000 as `UHD`
([constants.ts:46](src/lib/constants.ts:46)) — the schema needs nothing new.

**Do not transcode to 4K H.264.** It would preserve the TS copy path, but
Apple TV and iPhone only claim hardware H.264 decode to 1080p, and 4K H.264
at disc quality is a bitrate *increase* over the HEVC source.

**Do not re-encode the remuxes initially.** Three titles, a 40 GiB budget
and 50 GB free make the cache behaviour annoying rather than dangerous. A
`hevc_videotoolbox` re-encode on the Mac is held as a documented fallback —
see "If the cache thrash grates".

**The tvOS app uses AVPlayer, not VLCKit** — with the 23 Sep amendment that
the UHD Versions reach it by direct play (a plain MP4 URL) rather than fMP4
HLS. The original reasoning: A VLCKit app would
direct-play the MKV and preserve lossless audio and PGS subtitles, but the
Atmos argument for it collapsed when the AVR reported "Multi-Ch In" — Infuse
isn't bitstreaming either. What remains is a lossless-versus-lossy step, and
that doesn't justify a second playback path plus a much heavier client
build. AVPlayer + fMP4 speaks the contract the iOS app and web player
already use. Direct play stays in "Later" as an escape hatch.

**Leave the audio path alone — for the 1080p library.** Two tempting
changes, both rejected:
- *Prefer a copyable AC-3 track over transcoding the default.* Worth 6 films
  out of 75. The other 69 have only an AC-3 commentary or a lower-channel
  track to fall back to — precisely the trap `pickAudioTrack` was designed
  around (see its comments on The Lego Movie). Existing behaviour is right.
- *Transcode to E-AC-3 640k instead of AAC 384k.* Comparable quality; the
  AVR decodes PCM just as happily as a Dolby bitstream. Close to cosmetic.

**Revisit the first of those as the UHD shelf grows (20 Sep 2026).** The
rejection is sound measured against a 1080p library and gets steadily less
sound with every UHD rip. Three findings, in increasing order of weight:

1. *The qualifying test is stricter than the code's own behaviour.* "Equal
   or better" was measured against the source channel count, but
   `audioTranscodeChannels` caps output at 6. A TrueHD 7.1 default is
   reduced to 5.1 by the transcode regardless, so a 5.1 AC-3 beside it loses
   nothing. Re-counted on the dev DB (243 Versions): 55 Versions have a
   non-copyable first track, 4 qualify against source channels, **5** against
   output channels. The one difference is John Wick (`truehd/8 + ac3/6`).
2. *Every UHD disc is that shape.* All three films ripped on 20 Sep are
   TrueHD Atmos 7.1 + DD 5.1 640k + a DD 2.0 audio description — the
   standard UHD Blu-ray layout. So the qualifying population grows by one
   per UHD rip, on exactly the films this plan exists to serve. For them a
   copied AC-3 5.1 at 640k is the same channel count as the transcode would
   produce, at a higher bitrate, with no encode at all.
3. *The safety objection is a data gap, not a fact.* The Lego Movie trap is
   undetectable only because `isDescriptive` is false on all 329 AudioTrack
   rows — the columns postdate every probe. The flags exist in the files
   already (verified with ffprobe across 11 titles: every one carries
   `default=1` on its first track). Once a forced re-scan populates them,
   "prefer a copyable *non-descriptive* track" is implementable rather than
   a guess. That does not change the value for the 1080p library; it removes
   the reason the change could not be made safely.

Not scheduled. Reconsider when the UHD count reaches roughly a dozen, or
alongside phase B if the client-capability plumbing lands first.

**Capability negotiation picks the Version first, then the variant.** See
phase B.

## Phases

| # | Work | Est. |
|---|---|---|
| A | ~~fMP4 segments for HEVC~~ — **dropped 23 Sep**, superseded by direct play | — |
| B | Version-first capability negotiation, **plus direct-play routing** | 3–4 days |
| C | Byte-aware cache limits — no longer driven by 4K | 1 day |
| D | tvOS app | separate effort — see [IOS_PLAN.md](IOS_PLAN.md) |
| E | Verification | 2 days |

B and C are independent. C is worth doing on its own merits: it improves
the 1080p remuxes that still go through the engine. Section A is kept below
for the record, in case 4K ever has to stream as HLS.

### A. fMP4 segments

The notes in [V4_PLAN.md](V4_PLAN.md) under "Heads" explain the problem:
`-segment_format mp4` starts a fresh container per file, so each segment's
timestamps reset to zero — which is why TS was chosen. HLS fMP4 needs an
init segment referenced by `#EXT-X-MAP` plus media segments carrying
absolute `baseMediaDecodeTime`.

The hook is already there: the engine opens every finished segment to check
its reported start and duration against the segment table *before* renaming
it into place. Patching `tfdt` at that point preserves the
deterministic-cache property — a segment stays a pure function of (stream
key, index). **This estimate is the least certain in the document**: the
hook looks clean by inspection, but that is not a spike, and the range moves
if the segment muxer fights back.

Decisions this phase must settle:

- Per-codec, not globally. H.264 has no reason to leave TS — it works on
  every client today and AC-3-in-TS is proven. So the segment container
  becomes a property of the stream context rather than a constant.
- The stream key and `plan.json` must invalidate existing directories when
  the container changes: segment names go `.ts` → `.m4s`, and the
  `seg_NNNNN` pattern matching in the routes follows.
- Where the init segment lives in the key's directory, and how it is
  budgeted — trivially small, but it must never be trimmed while the
  directory holds segments.
- Playlist metadata, which fMP4 forces anyway: derive the RFC 6381 CODECS
  string from the probe (profile, level, bit depth) instead of the
  `MSE_VIDEO_CODEC` constant lookup
  ([video-playback.ts:204](src/lib/video-playback.ts:204)), which hardcodes
  `hvc1.1.6.L120.B0` — Main, level 4.0, 8-bit, where a UHD source is Main10
  level 5.1 and wants `hvc1.2.4.L153.B0`. Add `VIDEO-RANGE` (`PQ` for HDR10,
  else `SDR`) from `Version.videoRange`. `RESOLUTION` is already emitted.
  The same map feeds the web player's `isTypeSupported` probe, so one change
  serves both.

### B. Version-first capability negotiation

Today the film page renders a play button per Version and the viewer picks;
nothing prefers one. With a 4K HDR Version present that is a way to
accidentally stream 75 Mbit/s to a phone, or to hand HEVC Main10 to a client
that can't decode it — and because of constraint 1 there is no transcode to
fall back to.

So the session route should choose, from the Versions of a film, the best
one *this client can take*, and only then pick the variant:

- Client declares what it can decode (HEVC Main10, HDR) — the iOS and tvOS
  apps know this natively; the web player can use `isTypeSupported`.
- Prefer the highest-quality Version whose codec and range the client
  supports; fall back to the 1080p H.264 Version otherwise.
- Keep the manual per-Version play buttons as an override. The automatic
  choice is a default, not a cage.
- **Negotiate audio channels on the same declaration.** The Apple TV 4K is
  the only 5.1 endpoint in the household; every other client is stereo at
  most. Today `audioTranscodeChannels` preserves the source's channels
  (capped at 6) for every Original-variant client, so stereo-only devices
  are sent 384k of 5.1 they immediately fold down. Have the client declare
  its output channels alongside its codec support, and transcode to stereo
  at 192k for the ones that cannot use more. This costs nothing in quality —
  the downmix happens either way — and halves audio bitrate on precisely the
  Wi-Fi clients, while leaving the wired Apple TV at 5.1. It also puts the
  downmix under our control rather than the client's.

**Progress, 23 Sep — slice 1, direct-play routing, done.** A client asks for
direct play on the session request, `?direct=1&vcodecs=h264,hevc` (it
declares the video families it can play from a plain MP4 URL). When the file
qualifies (`canDirectPlay`, engine-routes.ts: the planner's `direct` tier, a
declared video family, the Original variant, and the default audio track or
none named), the session answers `mode: "direct"` with the file's own
`/stream` URL as `playlistUrl` and a null `playSessionId`; otherwise
`mode: "hls"` and the engine as before. Opt-in, so a client that doesn't ask
(today's iOS app) is untouched. The web player asks via `canPlayType`
(`directPlayQuery`, VideoPlayer.tsx), except inside the iOS app's web view,
whose native hand-off keeps HLS until /stream is verified from AVPlayer. New:
`/api/tv-video/<episodeFileId>/stream`, resolved through the engine's
`resolveSource` so the route and the session judge "playable as-is"
identically. Covered end to end against real MP4s and the real handlers in
`engine-routes.integration.test.ts`.

Still to do in phase B, in order:

1. **Version choice** — pick the best Version this client can take (4K HEVC
   HDR only for a client that declared `hevc`; the 1080p otherwise), then
   switch `UHD_PLAYBACK_ENABLED` on.
2. ~~**Native apps opt in**~~ — **done 23 Sep.** The iOS and tvOS apps send
   `direct=1` and play /stream as a plain AVURLAsset with the session cookie
   (MediaVault-Player#38), verified on the Apple TV 4K (No Time to Die from
   /stream, no ffmpeg on the VM). Direct play there first lost its sound ~10 s
   in and after every seek: AVFoundation leaves open-ended ranges half-read,
   and they held the HTTP/3 connection's flow-control window. So /stream now
   caps each 206 at 4 MiB (`DIRECT_PLAY_MAX_RANGE_BYTES`, #114). The web
   player's exclusion for the app web view's hand-off is gone too. Also found
   the same day: WebKit refuses an MP4 whose TrueHD track passes ~8.4M
   samples, so TrueHD is no longer kept in the library (#111, and
   `canDirectPlay` still refuses TrueHD as a safety net).
3. **Stereo negotiation** — lower priority now: a direct-played file carries
   its own 5.1 AAC, and 384k is noise beside the video's bitrate.

**Direct-play routing (added 23 Sep).** Having chosen the Version, the
session route decides how to deliver it:

- If the Version is already playable by this client as-is — MP4-like
  container, a video codec/range the client declared, and a default audio
  track it can decode (AAC, now true of every converted file) — return the
  `/api/video/:versionId/stream` URL. That is the only route for a UHD
  Version (constraint 1: nothing can transcode it).
- Otherwise, or for the Remote variant, the engine as today.
- `planVideoPlayback` already computes `tier: "direct"` for exactly these
  files; the work is making the session path honour it (today it always
  opens an engine stream) and teaching the native apps the same contract the
  web player's `direct` tier already speaks. Progress/resume uses the
  existing `/progress` route either way.

Open design question: whether link quality should feed into this (4K HDR on
the sofa, 1080p over Tailscale) or whether the existing Original/Remote
variant choice already covers it. [V4_PLAN.md](V4_PLAN.md) anticipates the
Version part under "Later → HDR and 10-bit".

### C. Byte-aware cache limits

The run-ahead throttle and the disk floors are counted in *segments*, not
bytes. `THROTTLE_AHEAD_COPY` is 100
([decisions.ts:277](src/lib/playback/decisions.ts:277)) — 2.5 GB at 1080p,
~5.5 GB at UHD, written in a ~20 s burst at the share's measured 260 MiB/s.
That is larger than the whole gap between `TRIM_FREE_DISK_LOW_WATER_BYTES`
(3 GiB, [decisions.ts:465](src/lib/playback/decisions.ts:465)) and
`MIN_FREE_DISK_BYTES` (1 GiB,
[video-cache.ts:122](src/lib/video-cache.ts:122)), at which point the engine
refuses to start heads at all. Budget pressure fires first at 40 GiB, so
this is a margin problem rather than a live bug.

- Cap the copy tier's run-ahead at a byte figure (~2.5 GB) rather than 100
  segments.
- Raise both disk floors so the gap between them exceeds one head's burst.
- Optional: cap any single stream at a fraction of the budget, so one 4K
  play can't evict the entire library. Eviction is whole-directory LRU with
  the live stream pinned, so today it will. Do this only if phase E shows it
  actually biting.

### D. tvOS app

Built on AVPlayer against the same session → playlist → progress → stop
contract the iOS app uses. Not in this plan's estimates; see
[IOS_PLAN.md](IOS_PLAN.md). It depends on phase B to pick the right Version
and to hand the UHD titles over as direct play (phase A is no longer
needed for them).

### E. Verification

Narrowed from the phase 5 matrix in [V4_PLAN.md](V4_PLAN.md) to what fMP4
and 4K actually change:

- Safari (Mac, native HLS), iPhone, iPad, tvOS, Chrome on Windows — cold
  start, seek far ahead cold, seek back, resume from `WatchProgress`, audio
  switch keeping position.
- HDR reaching the TV on the Apple TV, and what a non-HDR client does with
  the same Version.
- An H.264 title still playing from TS, unchanged, after the container
  becomes conditional.
- Cache behaviour across a full 4K play: what is evicted, whether the trim
  pass keeps up, free disk at the low-water mark.
- Chrome on Windows 11 with HEVC in fMP4 — the least certain client. It has
  a clean fallback (the 1080p Version) and is ~5% of use, so it is not worth
  spending a day on.

## Open questions — resolve against the first rip

1. **Answered 23 Sep: none.** None of the three carries Dolby Vision — no
   DOVI configuration record on any of them; they are HDR10 (BT.2020, PQ).
   The original question, kept for the next UHD disc: most UHD discs carry
   DV profile 7. A copy tier preserves the RPU (it lives in the bitstream), but Apple's HLS signals
   only profiles 5 and 8.1, so a P7 disc falls back to its HDR10 base layer
   on Apple clients. Check with `ffprobe` before designing DV signalling.
2. **HDR10 static metadata** (mastering display, MaxCLL/MaxFALL) surviving
   into segments — `ffprobe -show_frames -select_streams v -read_intervals %+#1`.
   **Answered 23 Sep:** the static metadata is carried in-band
   (HEVC SEI), not by the container, so it survives any copy of the video.
   On all three MP4 remuxes the first frame's mastering display and
   MaxCLL/MaxFALL are identical to the source's — Maleficent 0.005–4000 nits,
   823/312; Mistress of Evil 0.0001–1000 nits, 0/0 (as on the disc); Man of
   Steel 0.005–4000 nits, 7770/1468 — and the MP4s carry BT.2020/PQ colour
   tags. Segments are moot for direct play.
3. **Actual bitrate and segment size**, replacing the 55–85 Mbit/s
   projection with a measurement. **Measured 23 Sep:** Maleficent 48.5 GB /
   97 min = 71.3 Mbit/s; Mistress of Evil 49.0 GB / 119 min = 59.0 Mbit/s;
   Man of Steel 60.0 GB / 143 min = 60.1 Mbit/s (whole file, audio
   included). Segment size is moot for direct play.
4. **Keyframe cadence** in the rip. **Measured 23 Sep:** a fixed ~1 s —
   0.88 s (Maleficent), 1.00 s (Mistress of Evil), 0.92 s (Man of Steel),
   with no variation, read from the MP4s' own sync-sample tables in 1.4–2.2
   MB each. The original note: UHD remuxes are typically ~1 s, which the
   copy-tier segment table handles, but a long-GOP re-encode would push
   `TARGETDURATION` out.
5. **Whether the lossless-to-AAC step is audible** on the AVR for a DTS-HD
   MA or TrueHD title. If it is, "Later → direct play" moves up. *(23 Sep:
   direct play has moved up for the video, but it doesn't settle this — the
   files keep their lossless track, yet AVPlayer can't decode TrueHD or DTS,
   so an Apple client plays the AAC either way. The speakers on that AVR are
   5.1, so a 7.1 or Atmos source is folded to 5.1 regardless.)*

## If the cache thrash grates

Held in reserve, not scheduled. Re-encode the remux at a lower bitrate while
keeping 4K and HDR. No tone-mapping means no libzimg, so the *native*
Homebrew build is the right tool and `hevc_videotoolbox` gives hardware
Main10 encoding — many times realtime, where x265 at 2160p would manage
roughly 0.2×. This is the one job the M5 Max is genuinely good for.

```
ffmpeg -hide_banner -i input-uhd.mkv -map 0:v:0 -map 0:a -map "0:s?" \
  -c:v hevc_videotoolbox -profile:v main10 -pix_fmt p010le \
  -b:v 32M -maxrate 40M -bufsize 64M -g 48 \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -c:a copy -c:s copy output-uhd-32m.mkv
```

~75 Mbit/s down to ~32 halves every cache figure to roughly where the 1080p
remuxes sit today; `-g 48` gives clean 2 s keyframes for segment alignment.
Costs: VideoToolbox is less efficient per bit than x265, and re-encoding
discards the Dolby Vision RPU. Verify the HDR10 side data survives first.

## Not in scope

- **Tone-mapping on the VM.** Needs Intel's legacy Gen9 OpenCL runtime or a
  newer iGPU. The 1080p Versions make it unnecessary for these three films.
- **A 4K Remote variant.** Would require the Main10 software decode the VM
  cannot afford. Away-from-home playback uses the 1080p Version.
- **Converting TrueHD Atmos to E-AC-3 JOC.** Needs Dolby's licensed encoder.
- **The two audio changes rejected under "Decisions".**

## Later

- ~~**Direct play as a max-quality escape hatch.**~~ **Promoted 23 Sep** —
  see the first decision; the MP4 conversion removed the container gate. The
  lossless-audio half of the original idea still doesn't happen on Apple
  clients (AVPlayer can't decode TrueHD/DTS), so it's direct play for the
  *video*, with the AAC. The original note: For the ~75 films with
  lossless soundtracks, a client that can decode MKV (VLCKit, or the iOS
  app's native hand-off) could fetch the original bytes and keep lossless
  audio and PGS subtitles. `/api/video/:versionId/stream` already exists on
  `main` with byte-range support and auth — it only gates on an MP4-like
  container, returning 409 otherwise. The trade-off to weigh: a second
  playback path to maintain, against lossless audio on the one client
  (Apple TV, wired 1 Gbit) where it would be heard.
- **Atmos, if E-AC-3 JOC content ever enters the library.** The copy tier
  already passes `eac3` through untouched
  ([video-playback.ts:67](src/lib/video-playback.ts:67)), so this mostly
  works already — but the playlist would need an audio rendition group
  carrying `CHANNELS="16/JOC"` for Apple's players to signal Atmos properly.
- **Subtitles.** Owning the playlist makes text subtitles cheap: WebVTT
  renditions in a `SUBTITLES` group, extracted per segment window. Image
  subtitles (PGS) still mean burn-in and a video encode — affordable on the
  iGPU for H.264 sources, impossible for 4K HDR ones (constraint 1).
- **Adaptive bitrate** across the two Versions, once iGPU concurrency is
  understood.

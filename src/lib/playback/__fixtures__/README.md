# Matroska test fixtures

Small `.mkv` files for `matroska-cues.test.ts`, plus a `<name>.ground-truth.json`
per fixture (`{ durationSecs, keyframeSecs }`) produced by the same
`ffprobe -show_entries packet=pts_time,flags` command `keyframes.ts`'s
fallback uses, filtered to rows whose flags contain `K`. Tests read the
committed fixtures and ground truth directly — no ffmpeg/ffprobe needed at
run time.

Regenerate with a local `ffmpeg`/`ffprobe` on PATH, or the Docker shim
(`docker run --rm -v "$PWD:/out" --entrypoint /ffmpeg mwader/static-ffmpeg:latest ...`,
substituting `/out/<name>.mkv` for the output path and `--entrypoint /ffprobe`
for the ground-truth pass):

```sh
# normal.mkv — the ordinary case: Cues written after the Clusters, found via
# SeekHead. 30s, 160x120, keyframe every 48 frames (3.2s at 15fps).
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc=duration=30:size=160x120:rate=15" \
  -f lavfi -i "sine=frequency=440:duration=30" \
  -c:v libx264 -preset ultrafast -tune zerolatency -crf 35 -pix_fmt yuv420p \
  -g 48 -keyint_min 48 -sc_threshold 0 \
  -c:a aac -b:a 32k -shortest \
  normal.mkv

# cues-front.mkv — same content, but with space reserved for Cues up front
# (-reserve_index_space) so the muxer writes them before any Cluster.
ffmpeg … -reserve_index_space 4096 cues-front.mkv

# no-cues.mkv — live-stream mode: no SeekHead/Cues at all, unknown-size
# Segment/Clusters (ffprobe reports the duration as N/A).
ffmpeg … -live 1 no-cues.mkv

# large.mkv — same encode settings, 300s instead of 30s, purely to exercise
# the "bytesRead stays a small fraction of the file" assertion on something
# a few MB rather than a few hundred KB.
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc=duration=300:size=160x120:rate=15" \
  -f lavfi -i "sine=frequency=440:duration=300" \
  -c:v libx264 -preset ultrafast -tune zerolatency -crf 35 -pix_fmt yuv420p \
  -g 48 -keyint_min 48 -sc_threshold 0 \
  -c:a aac -b:a 32k -shortest \
  large.mkv

# Ground truth for <name>.mkv:
ffprobe -v error -select_streams v:0 \
  -show_entries packet=pts_time,flags -of csv=p=0 \
  <name>.mkv
# -> keep rows whose flags contain "K", write { durationSecs, keyframeSecs }
#    to <name>.ground-truth.json (durationSecs from
#    `ffprobe -show_entries format=duration -of csv=p=0` — no-cues.mkv
#    reports N/A there since its Segment size is unknown; its
#    ground-truth.json uses the encode's real 30.023s).
```

matroska-cues.synthetic.test.ts covers what these ffmpeg-muxed files can't:
ffmpeg always writes a SeekHead pointing straight at Cues, so none of the
above ever exercises the no-SeekHead "skip past every Cluster header"
fallback, an unknown-size *Segment* (as opposed to Cluster), or a
non-minimal vint length. Those are hand-built EBML byte strings instead.

# MP4 test fixtures

`mp4-*.mp4` for `mp4-sync-samples.test.ts`, with the same
`<name>.ground-truth.json` shape and the same ffprobe ground-truth command as
above. Unlike the Matroska fixtures these use B-frames (`-bf 2`, and not
`-tune zerolatency`/`ultrafast`, which turn them off), because B-frames are
what give an MP4 its `ctts` box and edit list — the parts of the arithmetic
worth testing. 30s, 160x120, keyframe every 48 frames (3.2s at 15fps).

```sh
SRC=(-f lavfi -i "testsrc=duration=30:size=160x120:rate=15" -f lavfi -i "sine=frequency=440:duration=30")
ENC=(-c:v libx264 -preset veryfast -bf 2 -crf 35 -pix_fmt yuv420p -g 48 -keyint_min 48 -sc_threshold 0 -c:a aac -b:a 32k -shortest)

# mp4-normal.mp4 — the ordinary case: moov up front (faststart), ctts, one
# edit list entry whose media_time is the B-frame delay.
ffmpeg -y -loglevel error "${SRC[@]}" "${ENC[@]}" -movflags +faststart mp4-normal.mp4

# mp4-moov-end.mp4 — same, without faststart: moov after mdat.
ffmpeg -y -loglevel error "${SRC[@]}" "${ENC[@]}" mp4-moov-end.mp4

# mp4-delayed.mp4 — video starts 1.5s late: a leading empty edit.
ffmpeg -y -loglevel error -itsoffset 1.5 -f lavfi -i "testsrc=duration=30:size=160x120:rate=15" \
  -f lavfi -i "sine=frequency=440:duration=32" -map 0:v -map 1:a "${ENC[@]}" -movflags +faststart mp4-delayed.mp4

# mp4-negative-cts.mp4 — version-1 ctts with negative offsets, media_time 0.
ffmpeg -y -loglevel error "${SRC[@]}" "${ENC[@]}" -movflags +faststart+negative_cts_offsets mp4-negative-cts.mp4

# mp4-all-intra.mp4 — every frame a keyframe, so the muxer omits stss.
ffmpeg -y -loglevel error -f lavfi -i "testsrc=duration=10:size=160x120:rate=15" \
  -c:v libx264 -preset veryfast -crf 35 -pix_fmt yuv420p -g 1 -movflags +faststart mp4-all-intra.mp4

# mp4-fragmented.mp4 — samples in moof, none in moov: the reader returns null.
ffmpeg -y -loglevel error "${SRC[@]}" "${ENC[@]}" -movflags frag_keyframe+empty_moov mp4-fragmented.mp4

# mp4-copied.mp4 — H.264 stream-copied out of Matroska, which leaves
# variable stts deltas (Matroska's millisecond timestamps): how the real
# library was converted (Sep 2026).
ffmpeg -y -loglevel error "${SRC[@]}" "${ENC[@]}" copied-src.mkv
ffmpeg -y -loglevel error -i copied-src.mkv -map 0 -c copy -movflags +faststart mp4-copied.mp4
```

# MediaVault — Manual test plan, September 2026

Covers everything merged or opened since **31 August 2026**:

| # | Change | PR | Status |
|---|---|---|---|
| A | Video stream crash fix (`ERR_INVALID_STATE` on seek/disconnect) | #33 | merged 31 Aug |
| B | Passkeys: manage on `/account`, sign in on `/signin`, post-code nudge | #34 | merged 2 Sep |
| C | Passkey end-to-end harness checked in | #35 | merged 4 Sep |
| D | PLAN.md roadmap refresh | #36 | merged 4 Sep |
| E | Video cache housekeeping (orphans, budget, free-disk check, SIGTERM, backup) | #37 | open |
| F | HLS playback + Remote (720p) quality | #38 | open, stacked on E |

Automated coverage already run before this plan: 221 vitest tests
(including the real-ffmpeg HLS integration test), `scripts/e2e-passkey.ts`
(25 + 6 checks) and `scripts/e2e-playback.ts` (17 checks in real Chrome).
What's left is what only real devices, a real library and a real network
can tell us. Tick each row; where something fails, note the device, what
you saw, and grab `docker compose … logs app` from around that time.

## 0. Before you start

1. **Merge order.** Merge #37 first, then #38 (it contains #37's commit and
   will show as a clean diff once #37 is in).
2. **Deploy** on the VM as usual:

   ```bash
   ssh deploy@192.168.1.77
   cd ~/MediaVault && git pull
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml logs app | tail -20
   ```

   If you haven't deployed since 2 Sep this run applies the passkey
   migration (`Passkey` table) before starting; otherwise it logs
   `No pending migrations to apply`. Either way the app comes up.
3. **Fix the backup job now** (E). Replace the nightly tar with the
   version in `DEPLOYMENT.md` › Data persistence — it excludes
   `video-cache/` and deletes archives older than 14 days. Check
   `df -h /` on the VM before you begin so you have a baseline.
4. **Empty the old cache once** (F changes the layout; the app also sweeps
   it on first play, but starting clean makes the disk numbers below
   readable):

   ```bash
   docker run --rm -v mediavault_data:/data alpine sh -c 'rm -rf /data/video-cache/*'
   ```

5. Devices to have to hand: Mac (Safari **and** Chrome), iPhone (Safari),
   Apple TV (the MediaVault handoff app), and one Windows or Android
   device if you have one. A Tailscale exit from *outside* the LAN
   (phone on cellular with Wi-Fi off is enough).

Passing rows in each section are independent; a failure in one section
doesn't block the others.

---

## A. Stream crash fix (#33) — DVD direct-play seeking

The bug: every seek cancels the in-flight range request, and the race
between that cancel and the stream closing threw an uncaught exception
that killed the container (and every other viewer's playback with it).

| | Step | Expect |
|---|---|---|
| A1 | Pick a film whose version is **direct-playable** (MP4/H.264 with AAC or AC-3 — the film page's version row shows the container/codec). Press Play on the Mac in Safari. | Plays immediately; the Network tab shows `/api/video/<id>/stream` with **206** responses. |
| A2 | Scrub aggressively: drag the scrubber back and forth 15–20 times in ten seconds, including jumps to near the end. | Playback follows every seek. No error card. |
| A3 | While A2 is going, in another tab watch `docker compose … logs -f app` on the VM. | No `uncaughtException`, no `ERR_INVALID_STATE`, no container restart (`docker ps` shows the same "Up … minutes" count). |
| A4 | Close the tab mid-play. Reopen and play again. | Resumes from the saved position (progress reporting unaffected). |

DVD-era MPEG-2 sources are *not* direct-playable and go through F below;
A only needs one MP4.

---

## B. Passkeys (#34)

The e2e harness covers the ceremonies against a virtual authenticator.
What it can't tell us: iCloud Keychain sync, Face ID/Touch ID prompts,
Safari's autofill UI, cross-device (QR) sign-in, and behaviour on a
non-Apple device.

### B1. Add a passkey (Phase 2)

| | Step | Expect |
|---|---|---|
| B1.1 | On the Mac in Safari, sign in with an email code as normal. Go to `/account` › Passkeys. | Section shows "Add a passkey for this device" (button). If this browser lacks WebAuthn or the site isn't HTTPS, it says "This browser doesn't support passkeys." instead — that's also correct on plain `http://192.168…`. |
| B1.2 | Click it. | Touch ID / password prompt from macOS; then a "Name this device" field pre-filled with something sensible; Create passkey. |
| B1.3 | After creating: the row appears with the name and "Added <date>". | Rename via the pencil icon; the new name persists on reload. |
| B1.4 | Click Add again on the same Mac. | "This device already has a passkey for MediaVault." (no second row). |
| B1.5 | On the iPhone (same iCloud account), open `/account`. | The Mac's passkey is *not* listed as belonging to this phone — but iCloud Keychain will offer it at sign-in (B2.3). Add a passkey here too; it should succeed with Face ID. |
| B1.6 | **Fresh-session rule.** Tomorrow (or on a session older than 24h, e.g. the Apple TV's browser if you keep one signed in): open `/account` › Passkeys › Add. | "Passkeys can only be added within a day of signing in — sign out and back in first, …". Sign out, sign in by email code, retry: works. |

### B2. Sign in with a passkey (Phase 3)

| | Step | Expect |
|---|---|---|
| B2.1 | Sign out on the Mac. On `/signin`, look under the email form. | "Sign in with a passkey" button is present (only on HTTPS + WebAuthn-capable browsers). |
| B2.2 | Click it. | Touch ID prompt → lands in the library, signed in. Sign out again. |
| B2.3 | Tap into the **email field** without typing. | Safari's autofill shows the MediaVault passkey (conditional UI). Choosing it signs you in with no button press. |
| B2.4 | On the iPhone, sign out and sign in via Face ID the same two ways (button, then autofill from the QuickType bar). | Both work. |
| B2.5 | **Cross-device.** On a device with **no** passkey (Windows/Android, or a private Safari window on a Mac not on your iCloud): click "Sign in with a passkey", pick "iPhone, iPad or Android device" / scan the QR with the phone. | Face ID on the phone signs the other device in. |
| B2.6 | **Web-of-trust gate.** As an admin, on `/account` remove a *second* member who has a passkey (or invite a throwaway, have them add one, then remove them). Have them sign in with the passkey. | "Couldn't sign you in with that passkey — use the email code instead." and they are **not** signed in. (Server log: one `UNABLE_TO_CREATE_SESSION` 500 — expected.) |
| B2.7 | Remove a passkey on `/account` (trash icon → "Remove <name>?" → Remove), then try to sign in with the same passkey from the device. | "That passkey isn't set up for MediaVault — use the email code instead." — and macOS/iOS still offers the stale credential until you delete it in Passwords; that's Apple's behaviour, not ours. |
| B2.8 | Cancel the Touch ID prompt half-way. | Button returns to normal, no error shown (the cancel is silent). |

### B3. Post-code nudge (Phase 4)

| | Step | Expect |
|---|---|---|
| B3.1 | Sign out; sign in with an **email code** on a device that supports passkeys. | The library page shows a strip: "**Sign in faster next time** — add a passkey …" with "Add a passkey" and "Not now". |
| B3.2 | Reload the page. | Still there (it lives on a 24h cookie). |
| B3.3 | Click "Not now". Reload. | Gone, and stays gone on this browser even after signing out and back in (per-device `localStorage`). |
| B3.4 | In a different browser on the same machine, sign in by code and click "Add a passkey". | Lands on `/account#passkeys`, scrolled to the section; the strip is gone when you go back. |
| B3.5 | Sign in with a **passkey** (not a code). | No strip. |
| B3.6 | On the Apple TV app or any device without WebAuthn, sign in by code. | No strip. |

### B4. Jellyfin SSO (Phase 5 — the one flow never exercised)

| | Step | Expect |
|---|---|---|
| B4.1 | Start a sign-in from Jellyfin (the SSO button there). On MediaVault's `/signin` page: | The **passkey button is absent** and the email field has no passkey autofill — SSO is deliberately OTP-only. |
| B4.2 | Complete with the email code. | Redirected back to Jellyfin, signed in there as before. |
| B4.3 | (Optional, if you want passkeys on this path) — note here whether B4.1 ever showed a passkey option; that would be a bug. | |

---

## C. Passkey harness (#35) — on the Mac

| | Step | Expect |
|---|---|---|
| C1 | `npx playwright install chromium` (once), then `npx tsx scripts/e2e-passkey.ts`. | `ALL PASSED` in about a minute; nothing in your real `.env`, DB or mailbox touched. |

## D. Roadmap (#36)

| | Step | Expect |
|---|---|---|
| D1 | Skim `PLAN.md` "Roadmap" and the shareable page. | Priorities still match what you want next; edit freely — nothing depends on it. |

---

## E. Cache housekeeping (#37)

What changed: in-flight output is counted against the budget and pinned;
orphaned output is swept on start and on each status check; a prepare
that would leave under 1 GiB free is refused with a message; SIGTERM
(deploy/restart) kills ffmpeg and deletes its partial output; a viewer who
leaves gets a two-minute grace before cancel (ten minutes under F).

| | Step | Expect |
|---|---|---|
| E1 | **Deploy mid-prepare leaves nothing behind.** Play a large remux (Blu-ray MKV) so a prepare starts. While it's running, redeploy (`docker compose … up -d --build`, or just `docker compose … restart app`). Then on the VM: `docker run --rm -v mediavault_data:/data alpine ls -la /data/video-cache`. | No half-written entry for that film (under F: no `film-<id>/` without a `.complete`). `df -h /` back to baseline. |
| E2 | **Orphan sweep.** Force one anyway: `docker kill -s KILL mediavault-app-1` (SIGKILL skips the hook) while a prepare runs; wait for `restart: unless-stopped` to bring it back; open the film page and press Play. | Play works — a fresh prepare starts rather than "preparing" forever — and the stale entry is gone from the cache dir. |
| E3 | **Budget.** With `VIDEO_CACHE_MAX_BYTES` at its default (10 GiB), play three or four big films in sequence so the total prepared output exceeds it. `ls -la` the cache dir. | Oldest-played entries have been evicted; the one you're watching is never evicted; total stays under the cap (plus the in-flight one). |
| E4 | **Disk-full refusal.** Only if you can fake it cheaply: fill the VM disk to <1 GiB free (`fallocate -l …G ~/junk`), press Play on something needing a prepare. | The player shows "Not enough disk space to prepare this file: it needs about N GB and the cache volume has M GB free." Remove the junk; Play works. |
| E5 | **Backup exclusion.** Run the new backup command from `DEPLOYMENT.md` once. | Archive is MBs, not GBs; `tar tzf` of it lists no `video-cache/` entries; archives older than 14 days are gone. |
| E6 | **Failure message.** Point a version at a deliberately broken file (rename the source on the share temporarily) and press Play. | A clear "Preparation failed." / `ffmpeg failed: …` message with the last stderr lines, not a spinner. |

---

## F. HLS playback + Remote quality (#38)

What changed: anything that needs preparing is now served as an HLS
event playlist (`/api/video/<id>/hls/<variant>/index.m3u8`) — Safari, iOS
and tvOS play it natively, everything else via hls.js. Direct-playable
files still use `/stream` with byte ranges. A "Quality" control in the
player offers Original / Remote (720p, ~3 Mbps). Nothing switches on its
own; after three stalls in a minute a hint appears.

### F1. On the LAN

| | Step | Expect |
|---|---|---|
| F1.1 | **Safari, Mac** — Play a Blu-ray remux (MKV, H.264 + AC-3/DTS). | Starts within a few seconds; Network tab shows `hls/original/index.m3u8` then `init.mp4` and `seg_00001.m4s…`; **never** `/stream`. Quality shows "Original". |
| F1.2 | While it's still preparing (log shows ffmpeg running; the scrubber's end keeps growing), **seek backwards** to the start, then forwards to near the current edge. | Both seeks play from the new point. Seeking *past* the edge is clamped — that's expected. |
| F1.3 | Pause for 5 minutes, then resume. | Resumes; the prepare kept going (10-minute idle allowance). Pause for 12+ minutes: the prepare is cancelled (no `ffmpeg` in `docker top <app container>`, and the entry has no `.complete`); pressing Play restarts it and it catches up quickly (remux is fast). |
| F1.4 | Let the prepare finish. Reload the page and play again. | Instant; playlist ends in `#EXT-X-ENDLIST`; full seeking. Cache dir has `film-<id>/` with `.complete`. |
| F1.5 | **Quality → Remote (720p)** at, say, 20 minutes in. | Playback continues from about 20:00 (it waits for the encoder to reach that point: for a transcode from cold this can be a minute or two — watch the log for `film-<id>-remote`). Picture is 720p; audio stereo. Cache gains `film-<id>-remote/`. |
| F1.6 | Close the player, reopen the film. | Quality is still "Remote" on this device; "Original" on another. |
| F1.7 | **Chrome, Mac** — same film on Original. | If the film's audio is **AC-3**, expect it to fail or play silently: Chrome can't decode AC-3 (known limitation, PLAYBACK_PLAN.md). Switch to Remote → plays (AAC). A film with AAC audio plays on Original in Chrome via hls.js. Note which you saw. |
| F1.8 | **Direct-play file** (MP4) in Safari and Chrome. | Uses `/stream` with 206s, no `/hls/`. Quality → Remote on it still works (it prepares a 720p rendition). |
| F1.9 | **DVD source (MPEG-2)**. | Prepares with a video transcode; expect ~1–2× realtime on the VM, so a 90-minute DVD is watchable from the start but seeking far ahead waits. Plays on Original. |
| F1.10 | **TrueHD / DTS-HD source**. | Audio is transcoded to AAC in Original; check lip-sync and that surround → stereo/5.1 downmix sounds right. |
| F1.11 | **Adult scene** playback (same routes under `/api/adult-video/`). | Works exactly as films; signed out of adult access → the HLS routes 403, not a blank player. |

### F2. Remote, over Tailscale (the case that started this)

Phone on cellular, Wi-Fi off; Mac tethered to the phone if you want to
test Safari-on-Mac remotely too.

| | Step | Expect |
|---|---|---|
| F2.1 | iPhone Safari: play a remux on **Original**. | It starts (HLS makes it start), but a 25–40 Mbps remux will stall on cellular. After three stalls within a minute the hint "Buffering a lot? Remote quality …" appears with "Switch to Remote". |
| F2.2 | Tap Switch to Remote. | Continues from about the same position; stalls stop (3 Mbps cap). |
| F2.3 | Lock the phone for two minutes, unlock, resume. | Resumes without a reload (segment fetches don't care about the dropped connection). |
| F2.4 | Walk out of cellular coverage briefly (lift, basement) and back. | Buffering indicator, then continues. No error card. |
| F2.5 | Start a **second** film on Remote from cold. | Watch the VM's CPU (`top`): one x264 job at 2 threads, ≈ realtime or better at 720p. If it's much slower than realtime, note the source resolution/bitrate. |
| F2.6 | Next day: the same film on Remote. | Instant — the remote entry is cached. |

### F3. Apple TV handoff

| | Step | Expect |
|---|---|---|
| F3.1 | From the tvOS app, open a film that needs preparing and press Play. | The handoff gets the **playlist URL**; AVPlayer plays it, including while it's still preparing (scrubber grows). |
| F3.2 | Seek backwards/forwards on the Siri Remote. | Works within what's written. |
| F3.3 | A direct-play MP4 from the TV. | Still the `/stream` URL, ranges, instant. |
| F3.4 | The TV over Tailscale (if the TV is ever off-LAN — probably skip). | — |

### F4. Playback e2e on the Mac (optional)

| | Step | Expect |
|---|---|---|
| F4.1 | `E2E_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx tsx scripts/e2e-playback.ts` | `ALL PASSED`, 17 checks, 2–3 minutes. |

---

## What to record when something fails

- Device + browser (and whether native HLS or hls.js: Safari/iOS/tvOS are
  native; everything else hls.js).
- The film's version row (container / video / audio codec) from the film page.
- The player's message verbatim, and the browser console's last lines.
- `docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.prod.yml logs --since 10m app`.
- `ls -la` of the cache dir and `df -h /` if it's E or F.

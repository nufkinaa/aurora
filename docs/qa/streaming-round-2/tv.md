# Streaming round 2 — the TV app (Mi TV)

*2026-11-28 · branch `stream-tv-2` from master `6ef9d4db` (server 1.15.48, TV 5.9.10). Every number is from the Mi TV
(adb 192.168.50.31). The builds are QA builds made with `docs/agent-briefs/app-build.sh` (baseline vc279 = master plus
log lines, after = vc280/281), playing against a private server on this PC. Nothing here is released. Each table says
which source carried the film.*

## In plain words

- **On a fast source the TV is already in the big services' class for starting a film.** From the press to the picture
  takes 1.1–1.4 s (warm), with no stalls. A resume lands to the second.
- **What was slow was landing anywhere that is not a keyframe.** ExoPlayer seeks *exactly*. It decodes every frame from
  the keyframe before the target without showing them. The household's films have keyframes up to ~10 s apart.
  - The same seek measured both ways: a point 10.3 s past a keyframe took **1.24 s** after the seek was made. The
    keyframe itself took **0.11 s**.
  - A resume paid this on every start: up to 0.8 s more black than a start from 0:00.
- **Built.** All of it is invisible, adds no encoding, and needs the new APK plus a pulled server:
  1. a resume lands on a keyframe inside the resume's own leeway;
  2. a title opened from the Google TV row starts a little sooner;
  3. the next episode is warmed while its card is up, and starts without asking the server for the profile again;
  4. a seek from the phone remote no longer waits 0.45 s.
- **Not built, for elia:**
  - the same keyframe landing for seeks (a server setting, off by default);
  - four native changes that `app-build.sh` refuses: seek parameters, the real buffer level, a shorter read timeout,
    and preparing the next episode inside the player;
  - a faster D-pad tap seek (that one changes what a tap does).
- **Thin lines are still the line.** The TV has one version of each film and no automatic step-down (elia's rule: no
  more encoding). A line below a film's rate stalls in a steady rhythm: stall, then 5 s of play.

## Where it stands against the big services

Targets: Conviva's State of Streaming (industry video start ~2.5–5 s, the best regions ~2.6 s, rebuffering ~0.8–0.95 %
of watch time), what Netflix and YouTube publish about their players (Netflix: buffer-based ABR, a deep TV buffer, the
next episode prefetched during the credits; YouTube: ~80–120 s ahead), and Media3's own defaults (start at 1 s of
buffer, 2 s after a stall). "Fast source" = the film off the TV's own storage (~128 Mbit/s); lines = that source paced.

| | Netflix-class target | Aurora TV before | Aurora TV after | Source |
|---|---|--:|--:|---|
| First frame, warm (press → picture) | ≤ 2 s | 1.21–1.39 s | 1.15–1.39 s | fast |
| First frame, cold (launcher row → picture) | ~3–5 s for a TV app | 4.42–4.68 s | 4.08–4.56 s | fast |
| **Resume (warm), by how far the point is past a keyframe** | ≈ a start from 0:00 | 1.31 s (1.3 s past) · 1.60 (2.9) · 1.66 (3.8) · **2.02 (7.1)** | 1.40 · 1.30 · 1.19 · **1.22** | fast |
| Resume (cold) at the same points | — | 6.13 · 5.55 · 5.16 s | 5.24 · 5.17 · 4.54 s | fast |
| Seek, near (+10 s, in the buffer), from the press | < 1 s | 0.74–0.86 s | **0.32–0.43 s** (phone) | fast |
| Seek to 10.3 s past a keyframe, after the seek is made | — | 1.24 s | 1.30 s (exact; see "for elia" 1) | fast |
| Seek to a keyframe, after the seek is made | — | 0.11 s | 0.11 s | fast |
| Next episode, player mount → picture | ~instant (prefetched) | 1.35–1.44 s | **1.27–1.35 s** (its item + state wait 0.37 → 0.05 s) | fast |
| Rebuffering, fast / 8 / 5 Mbit/s | < 0.5 % | 0 % / 0 % / 0 % | (unchanged code) | lines |
| Rebuffering, 3 / 1.5 Mbit/s, HEVC 4.4 Mbit/s | (ABR steps down) | 13.7 % / 42 % | (unchanged code) | lines |
| A 10 → 2 → 10 Mbit/s drop for 45 s | no stall | 0 stalls | (unchanged code) | lines |
| Server restart (connections cut, 12 s down), 6 Mbit/s line | no stall | 0 stalls, 3 of 3 | — | line |
| Wi-Fi freeze (connection silent 25 s), 6 Mbit/s line | no stall | **7.6–8.2 s stalled**, picture back 21 s after the freeze, 3 of 3 | (native: "for elia" 4) | line |
| Busy server start | — | not measured (see "what could not be done") | — | — |

The first-frame figures are medians of 3 plays per title (thevc / tmp4 / tjit). The resume rows use 3 plays per point
(warm) and 1 per point (cold). Resume accuracy is exact: the player lands where it was sent (warm), or 4 s before the
saved position by design (cold, through the profile's progress).

## What was built

All of it is invisible: nothing new on screen and no behaviour a viewer would call different. None of it adds
encoding. **It needs a new APK.** Item 1 also needs the server pulled, because it adds a small route. Commits are on
`stream-tv-2`.

### 1. A resume lands on a keyframe inside its own leeway (`0b6a73d3`)

A resume was already "4 s before where you stopped" (`episodeRules.ts`). It now lands on the keyframe closest to that
point, within 4 s before it and 3.5 s after it. It never lands later than half a second before the saved position, and
never more than 8 s before it. When no keyframe is in that window (about 1 resume in 4 on this clip), or the list does
not arrive within 400 ms, the resume is exactly as before.

- **Server: a small change outside tvtuning, so WEB should know.** A new `GET /api/tv/keyframes/:id`
  (`src/lib/tvkeys.js`, next to `/api/tv/tuning` in `routes/api.js`; "keyframes" is added to SEGMENTS).
  - It returns the video keyframe times from the file's own index, read by the same readers jit uses (Matroska Cues,
    MP4 sync samples).
  - The index is read once per file and kept by path, size and mtime.
  - Anything the readers cannot read answers `keys: null`.
- **tvtuning.** `resumeOnKey` (default true) is the off switch. `seekSnapMs` (default 0) controls seeks; see "for elia"
  item 1.
- **TV.**
  - `playback/keyframes.ts` holds the rule (pure, with tests).
  - The player asks for the list next to the item.
  - The title page warms the list when it shows Resume, and so does the launcher row.
- **Numbers.** Warm resumes from the profile's progress on the HEVC clip, 3 plays per point, fast source:
  - 2.9 s past a keyframe: **1.60 → 1.30 s**;
  - 3.8 s past: **1.66 → 1.19 s**;
  - 7.1 s past: **2.02 → 1.22 s**;
  - 1.3 s past: 1.31 → 1.40 s (noise);
  - cold, at the same three points: 6.13 / 5.55 / 5.16 → 5.24 / 5.17 / 4.54 s.
- **Why it is larger than the decode model predicts.** Landing exactly on the keyframe saves more than ~0.1 s per
  second skipped. The start-at-position path also reads the index first. On the keyframe, a resume costs what a start
  from 0:00 costs.

### 2. A title from the launcher's Aurora row (`adb4e003`)

Cold start from the Google TV row used to be: the launcher press, Home mounts, a fixed 600 ms "breath", then the player,
which only then asked for the item.

- Now the title is pushed one frame after Home has drawn.
- The item (with this box's play decision) and the keyframes are asked for as soon as the link is read.
- **Measured:** launcher → picture went 4.68 → 4.31 s (thevc), 4.42 → 4.08 (tmp4) and 4.46 → 4.56 (tjit, noise).
  The app's own boot share went 2.65 → 2.41 s.
- Honestly, that is ~0.3 s, not the full 0.6. Most of the cold start is the process and the JavaScript bundle (~2.4 s),
  which is native territory.

### 3. The next episode starts warm (`80108193`, `0e88a7d0`)

- When the Up next card shows, the next episode's item and the first 256 KB of its file are asked for. A drive that slept
  through a long episode wakes then, not when the viewer is waiting.
- Measured, the item alone was not what the next player waited on. It also waited for the profile's state, because
  every saved position made the app forget the whole kept state.
- A saved position is now written into the kept state instead (`api.noteProgress`: only the row it changed). The card
  also refreshes the state, so the next player (15 s countdown) starts from it.
- A film opened again a moment later still resumes where it was just left (tested).
- **Measured on vc280 (item warm only):** the next player's start was unchanged, 1.35–1.44 s, waiting ~370 ms for the
  state over the rig's line. **vc281 adds the state:** the next player's wait for its item and state went 365–402 → 31–95 ms (the `meta` step),
its source was handed to ExoPlayer at 147–227 ms instead of 378–426, and mount → picture went 1.35–1.44 →
**1.27–1.35 s** (3 plays). Only ~80 ms of the 330 ms reached the picture on this TV: the hardware decoder handed over
from the episode that just ended takes the rest. Over nufurora's round trips (72 ms each, two of them) the saving is
larger than here.

### 4. A seek from the phone remote is made at once (`5624127e`)

- A phone's scrub sends one absolute target when it is let go. The player held it 450 ms (the debounce that gathers a
  burst of D-pad presses) before seeking.
- `seek` now goes straight through. `skip` (the phone's ±10 s buttons, which come in bursts) keeps the debounce.
- **Measured** (3 plays, fast source): the command's wait before the player seeks went 480 → 20 ms. Press → picture for
  +10 s went 0.74–0.86 → **0.32–0.43 s**, and for a far seek back 1.22 → 0.75 s.

### Measurement tools (`3f9b27a7`, `512ba4dc`, `c3ff6716`)

- logcat lines for every buffering wait, seek and ready (logs only).
- `tools/stream-net-rig/tv-rig2.js` and `tv-rig2-report.js`.
- `tv-local.sh rate <kbit/s>`, a paced line for films served from the TV.

### Measured and left alone

- **The start buffer on a fast line.**
  - On a fast source, 1000 ms against today's 2500 ms changed nothing: thevc 1.31 vs 1.39 s, tmp4 1.10 vs 1.21 s.
    6 plays each way.
  - The ~1.2 s is ExoPlayer, the decoder and the audio setup, not the buffer.
  - On paced lines the buffer matters (8 Mbit/s: 3.0 s for HEVC), and round 1 chose 2500 for the thin-line stalls.
  - Left as it is.
- **The decode watchdog and the stall nudge.** Neither fired falsely in any play here. The nudge, a seek to where the
  film stands, does not restart a frozen connection: that recovery came from OkHttp's 20 s read timeout ("for elia"
  item 4).

## Thin lines (baseline; the code that decides this is unchanged)

The film is played from the TV's storage, paced. 1 play per cell, watched 90 s, from 0:00. thevc is HEVC 4.4 Mbit/s
(the film's busiest 4 minutes); tmp4 is H.264 ~2.5 Mbit/s.

| line | film | first frame | stalls | stalled | rebuffer ratio |
|---|---|--:|--:|--:|--:|
| 8 Mbit/s | thevc | 3.0 s | 0 | 0 s | 0 % |
| 8 Mbit/s | tmp4 | 2.0 s | 0 | 0 s | 0 % |
| 5 Mbit/s | thevc | 3.9 s | 0 | 0 s | 0 % |
| 5 Mbit/s | tmp4 | 2.4 s | 0 | 0 s | 0 % |
| 3 Mbit/s | thevc | 5.7 s | 2 | 12.6 s | 13.7 % |
| 3 Mbit/s | tmp4 | 3.5 s | 0 | 0 s | 0 % |
| 1.5 Mbit/s | thevc | 10.1 s | 5 | 38.7 s | 42 % |
| 1.5 Mbit/s | tmp4 | 5.7 s | 5 | 29.5 s | 32 % |
| 10 → 2 (45 s) → 10 | thevc | 3.1 s | 0 | 0 s | 0 % |

**Reading it:** below a film's rate the TV stalls in a fixed rhythm. It waits ~7.6 s for 5 s of film (the rebuffer
threshold), plays those 5 s, and stalls again. The big services avoid this with a lower rung, which here means an
encode, so it is off the table by elia's rule. Round 1's BBR on nufurora is what keeps real lossy lines above the
film's rate.

## Research: what the big services do, and what applies to one server and a household

| They do | Applies here? |
|---|---|
| **Buffer-based ABR** (Netflix BBA; BOLA in dash.js; ExoPlayer's AdaptiveTrackSelection) | Only with renditions, and the TV plays one. A TV ladder means encodes, so not under elia's rule. ExoPlayer can't adapt within one file. |
| **A deep buffer** (Netflix TV: minutes; YouTube ~80–120 s) | Already there: 50–120 s (`BUFFER_CONFIG`). A blip of 12 s, and a 45 s drop to 2 Mbit/s, passed with no stall. |
| **Fast start: low first rung, small start buffer** (Media3 default 1 s) | No low rung exists. On a fast line the start buffer is not the cost (measured above). |
| **Prepare on the title page** (manifest, licence, first segments) | The item is memoised from the title page; the keyframes are now warmed there too. A hidden second player would hold a second hardware decoder on a 2 GB TV. Not done. |
| **Prefetch the next episode during the credits** | Built at the server/API level (item, state, file head). Preparing it inside the player needs Media3's PreloadManager or a second ExoPlayer: native ("for elia" 5). |
| **Seek to sync points / short GOPs** (2 s IDR in HLS/DASH ladders; players' CLOSEST_SYNC) | The files' keyframes are whatever the release has (1–10 s here). Landing on them is the cheap equivalent: built for resumes, offered for seeks. |
| **Short network timeouts, fast reconnects** | ExoPlayer retries a cut connection at once (server restart: 0 stall). A silent connection waits OkHttp's 20 s read timeout, set in the native patch ("for elia" 4). |
| **Keep-alive, connection reuse, preconnect** | The player's OkHttp client shares React Native's connection pool and cookies (patch). Nothing more to win from JS. |
| **CDN, per-title encodes, AV1** | Set aside in round 1, for the same reasons. |

## For elia (ranked by gain to viewers)

1. **Seeks land on a keyframe near the target.**
   - The gain: a seek into the middle of a long GOP shows its picture ~1.1 s sooner (1.24 → ~0.11 s after the seek is
     made).
   - What a viewer would see: a seek lands up to ±1.5 s from the exact second.
   - Cost: none. It is built and off. Turn it on in config.json with `"tvPlayer": {"seekSnapMs": 1500}`, no new APK
     once this release is out. Risk: low. No encoding.
2. **Native: seek parameters in react-native-video** (`player.setSeekParameters(...)`, one line in the patch). The same
   as item 1, decided inside ExoPlayer, which knows the keyframes of any file, including copies and encodes. It needs a
   patch change, which `app-build.sh` refuses.
3. **A faster D-pad tap seek.**
   - Today a single +10 s tap waits 0.7 s (the scrub session's commit pause) after the key comes up, then seeks.
   - The proposal: on the first tap, seek at once when the target is in the buffer, and move again at the end of the
     session if more taps came.
   - Gain: ~0.7 s on every single tap. What a viewer would see: during a burst of taps the picture follows each tap
     instead of waiting for the last.
4. **Native: OkHttp read timeout 20 → 8 s** (`DataSourceUtil.kt` in the patch). A Wi-Fi freeze of 25 s on a 6 Mbit/s
   line cost 7.6–8.2 s of stall, 3 of 3, picture back 21 s after the freeze. With 8 s it would come back ~12 s sooner.
   A working server never keeps a player waiting 8 s for a byte, and while the buffer is full no read is running. Risk:
   low. A device check is needed.
5. **Native: prepare the next episode inside the player** (Media3 PreloadManager or a second ExoPlayer during the
   credits). The next episode would start in well under a second instead of ~1.4 s. Costs a second decoder or extra
   memory on a 2 GB TV. Medium cost, medium risk.
6. **Native: the real buffer level (`playableDuration`).** react-native-video sends `getBufferedPercentage() ×
   duration`: whole-percent steps, 89 s on a 2.5-hour film. The case for fixing it (one line,
   `player.getBufferedPosition()`):
   - The scrubber's buffered bar jumps in those steps.
   - The decode watchdog can't see a true buffer, so it misses real decode stalls on long films. It is a false
     negative, never a false positive: the steps round down.
   - Nothing buffer-aware can be built on top (an adaptive start buffer, a smarter nudge).
   Low risk; it is not urgent on its own.
7. **Thin lines.** The TV stalls in a 5 s rhythm on lines below the film's rate. The only real fix is a lighter version,
   which is encoding and elia's no. The middle ground would be a "Lower quality" offer after repeated mid-film stalls,
   not only before the first frame. That is visible, and it encodes only when pressed.

## What could not be done here, and why

- **A real LAN or nufurora's path.**
  - The PC reaches the TV at ~2 Mbit/s (measured again: 3 MB in 13.5 s). Every fast number comes from the TV's own
    storage.
  - API calls (item, state) crossed that slow Wi-Fi, so the "meta" step (~400 ms) is larger than on a real LAN and
    smaller than nufurora's 72 ms round trips. The gains from items 2 and 3 grow with the round trip, so nufurora should
    gain more than measured here.
- **Lossy lines on the TV.** Real TCP loss needs the netem rig, whose path to the TV is the 2 Mbit/s Wi-Fi. Round 1's
  BBR results cover it.
- **A busy server.** Not measured: the private server ran on this PC, and loading it would have loaded the rig.
- **Real Wi-Fi off and on.** Switching the TV's Wi-Fi off would also cut adb on this Wi-Fi-only TV. It was simulated on
  the TV's relay instead: a silent connection (SIGSTOP) and a server cut (relay stopped, connections killed).
- **Cold-start numbers** carry the JavaScript bundle's own variance (±0.3 s). 3 plays per cell are at the edge of
  what can be resolved there.

## How it was measured

- **The rig.** `tools/stream-net-rig/tv-rig2.js` runs against a private server of this branch (`tv-instance.js --direct`:
  throwaway data, the test clips, profile "Claude QA").
  - The TV reaches the server through `tv-local.sh`: the TV's own `127.0.0.1:4000` is a relay on the TV.
  - The relay answers `/stream/video/<id>` for films pushed to the TV's storage: **the fast source**, ~128 Mbit/s.
  - Everything else goes to the PC.
  - **Lines** are the relay paced (`tv-local.sh rate`, calibrated: 4000 → 3.9 Mbit/s, 1500 → 1.5 Mbit/s). That models a
    line's rate only, with no latency or loss.
- **Warm.** The app is on Home and the title is sent with the phone-remote protocol (`play_item`, as Play on TV does).
  The time is the player's own mount → first frame (on the TV the press is the player's mount).
  - "Resume (warm)" is a resume from the profile's saved position; the old player is stopped first.
- **Cold.** The app is force-stopped and the title opened with the launcher's deep link. The time is the launcher's
  `START` line → first frame, both on the TV's logcat clock.
- **Seeks.** Remote `seek` commands. "Press" means the command reaching the TV. "After the seek is made" means the
  player's own seek to the picture.
- **Stalls.** Every buffering on/off after the first frame, short ones included.
- **Blips.** The relay's film loop is paused (a freeze), or the relay is stopped with its connections killed (a server
  restart).
- **Films**, pushed to the TV:
  - `thevc`: HEVC 10-bit 1080p + E-AC-3 5.1, 4.4 Mbit/s, keyframes 1–10.4 s apart;
  - `tmp4`: H.264 MP4 + AAC, ~2.5 Mbit/s;
  - `tjit`: H.264 MKV + AC-3, 1.9 Mbit/s;
  - `Tvs Show` S01E01/E02: 40 s stream copies of `thevc`.
- **Raw rows** are in `tools/stream-net-rig/.runs/{base,after,base-sb1000}.jsonl`. They are not in git; the summary
  comes from `node tools/stream-net-rig/tv-rig2-report.js base after`.

## Tests

- Root `npm test` in the worktree: 3,035 tests, 3,034 pass. The one failure, `drives-mover.test.js` ("Stop using this drive…"), passed 9/9 run alone twice: a load flake, nothing this branch touches.
- TV `npx jest -c jest.logic.config.js`: all 130 suites, 1,501 tests green. New suites: `keyframes`,
  `launch-link-open`, `state-note`, and the remote-handler seekNow case. `npx tsc --noEmit -p .` is clean.
- Device: every number above is from the Mi TV.

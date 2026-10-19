# Picture and sound — refresh-rate matching, passthrough, direct play by device capability

TV round 2026-10-19 · branch `tv-av-quality` (from master 9ecf96f = server 1.8.2) · worktree `C:\elia\aurora-tv-av` · commits `5d7bcab`, `5cd4c6f`. Built and tested offline; the Mi TV pass is still to do (§6).

## 1. What was built

**One decision table, two clients (parity).** The device sends `POST /api/caps {report}` and gets `{id}`. `GET /api/item/:id?caps=<id>` then carries `play {mode, video, audio, form, decodes, container, fps, why[], tracks[]}`.

### Server
- **Report** (`src/media/avcaps.js`): video codecs with profiles, max size, max fps, H.264 level; HDR types the screen shows; Dolby Vision profiles; audio decoded; audio passed through; containers; screen modes. Closed vocabulary (unknown words dropped, numbers clamped). The id is a hash of the report, stable across launches and server restarts. Kept in `CACHE_DIR/device-caps.json`, 300 at most. A forgotten id means no `play`, and the client falls back to its old rules.
- **Decision** (`src/media/playpath.js`, pure):
  - **direct** — picture decodes on the device (codec, profile for its bit depth, size, frame rate, HDR the screen shows; a browser tone-maps HDR itself). Dolby Vision profile 5 needs Dolby Vision; 7 and 8 fall back to their HDR10 layer. Container must open the codec; audio must be passed through (ac3, eac3, eac3-joc, dts, dts-hd as DTS core, truehd) or decoded on the device.
  - **remux** — picture decodes but container or sound doesn't; the server's copy keeps the picture and makes the sound AAC stereo.
  - **transcode** — picture must be re-encoded. VP9 and AV1 always land here when they can't play directly.
  - "Surround sound: Stereo only" turns passthrough off. Every answer carries `why` lines; the server logs `[play] <title> → <mode> (<form>)` once per title per device per 10 minutes. `GET /api/caps/:id/play/:itemId` returns the facts and decision for device checks.
- **Torrent sources:** `/api/torrents/sources?caps=` adds `play` per source, guessed from the release name; the player's fallback ladder still stands behind it.
- **Probe:** new probes record video profile/level and Dolby Vision profile + fallback layer. No `PROBE_VERSION` bump (no whole-library re-probe); older records decide from bit depth.
- **Person settings:** `prefs.matchFrameRate` (auto / off), `prefs.surround` (auto / stereo).

### TV
- **`AvModule.kt` ("AuroraAv")** plus pure `av/ModePick.kt`, `av/AvVocab.kt` with JVM tests: hardware video decoders only (secure ones skipped), every audio decoder, passthrough from media3's `AudioCapabilities.isPassthroughPlaybackSupported` (exactly what ExoPlayer's sink acts on; `media3-exoplayer` added at react-native-video's version, one copy in the APK), HDR from `Display.HdrCapabilities`, the screen's modes.
- **Refresh rate:** the window's preferred mode is set before the film reaches the player; the start waits for the display to report it plus 1.2 s settle (capped 5 s native + 2 s bridge guard). ExoPlayer's own request is "only if seamless" and never switches on HDMI; "always switch" switches after the picture is up. Mode choice: exact multiple beats near (24 Hz for 23.976, 60 for 59.94), lowest multiple wins, resolution never changes, nothing under 23 Hz, no switch when already exact or already near with nothing exact. Leaving restores the screen's own mode after 1.5 s; a new match meanwhile (next episode) cancels the restore. Torrent streams get no matching.
- **Stereo only:** the react-native-video patch overrides `buildAudioSink`; with `aurora.audio.passthrough` = "0" the sink gets stereo-only capabilities.
- **Code:** `src/avCaps.ts` (pure report, decision reading, false-claim detection, frame-rate rule), `src/av.ts` (native glue, one report per launch per server, false claims kept 30 days and the report re-sent), `SessionWiring.tsx`, `api.ts` (`?caps=`), `Player.tsx` (marked blocks; a direct start passes through or decodes on the TV instead of the stereo copy), `playBest.ts`, Settings → "Picture and sound".
- **False claims** (only for server-decided direct starts):
  - **Silent start:** ExoPlayer leaves an unplayable sound track unselected and plays silent. The player sees no selected audio at load, keeps the false claim, continues on the copy from the same point.
  - **Device error before the first frame** (sink refuses, decoder won't start / exceeds capabilities / format unsupported): claim kept, existing ladder runs (copy, then H.264). Plain decoding failures aren't counted (damaged files cause them too).
  - A kept claim removes that passthrough form or decoder, or that profile and every profile above it.

### Website (parity)
- `public/js/avcaps.js` builds the browser's report from the same `canPlayType` questions the player asks, HDR10/HLG via `mediaCapabilities.decodingInfo`, Dolby Vision 5/8 on Safari; iPhone HEVC follows the player's rule. Sent once per page load from `main.js`; the id lives in `api.js` and goes on item reads.
- `screens/player.js`: audio-remux and video-transcode rules follow `item.play` when present; quality ladder, HEVC-in-MKV through the copy and native HLS unchanged.
- Settings → More settings → "On the TV": the same two settings, same wording, stored on the profile; says plainly a browser can't switch refresh rate or send Dolby/DTS to a receiver.

## 2. Numbers

`node tools/playpath-count.js --meta <copy of metadata-cache.json> --streams <copy of torrent-streams.json>` — 64 files, 86.3 h. Video: H.264 8-bit 30, HEVC 10-bit 26, HEVC 8-bit 8. Container: MKV 32, MP4 32. First audio: AAC 34, AC-3 15, E-AC-3 15. Frame rate: 23.976 54, 24 7, 50 2, 60 1.

| device | before (direct · remux · transcode) | after | server CPU to watch everything once |
|---|---|---|---|
| Mi TV (assumed Amlogic profile) | 34 · 30 · 0 | 64 · 0 · 0 | 65 → 0 thread-min |
| Chrome desktop (hardware HEVC) | 19 · 45 · 0 | 19 · 45 · 0 | unchanged |
| iPhone Safari | 32 · 32 · 0 | 32 · 32 · 0 | unchanged |
| Mi TV torrent sources (88 cached) | 82 · 2 · 4 | 88 · 0 · 0 | 4 full H.264 encodes gone |

- On the Mi TV the 30 AC-3/E-AC-3 files used to go through the copy (always AAC stereo); now 29 keep their 5.1.
- Copy cost 0.034 thread-s per film-second (ffmpeg -benchmark); a 1080p H.264 encode from 10-bit HEVC 1.54 measured (model 1.23). The real CPU win is torrents.
- Mi TV numbers come from an assumed profile. Recount with the real dump: `curl <server>/api/caps/<id> > mitv.json`, then `node tools/playpath-count.js --meta … --caps mitv.json`.

## 3. Tests

| suite | result |
|---|---|
| `test/playpath.test.js` | 13/13 |
| `test/avcaps-server.test.js` (private instance) | 1/1 |
| `test/ui/avcaps.test.js` (real Chrome, desktop + phone) | 4/4, three consecutive runs |
| root `npm test` | 1848 / 1856 / 1860 of 1862; every failing file passes alone (EBUSY / load) |
| whole `npm run test:ui` under ui-lock | 300/300 (1 skipped); then 299/300 (sign-in timeout, passes alone twice) |
| TV jest logic | 542/542 |
| TV tsc | clean |
| Kotlin `com.auroratv.av.*` | 10/10 |
| assembleRelease | successful |

## 4. Not verified
- On the Mi TV: real decoder list, passthrough answer, screen modes, whether 24p modes exist, blackout length, passthrough to speakers or a receiver.
- Safari / iPhone / Edge aren't on this PC; the Safari branches are unit-tested only.

## 5. Limits / follow-ups
- Torrent streams: no refresh-rate matching; `play` is a name guess.
- The server's copy is always AAC stereo (`remux.js`, `jit.js` use `-ac 2`); an iPhone that decodes E-AC-3 still gets stereo for an MKV.
- A second dub on the TV still goes through the copy.
- Android reports AV1 Main for 8- and 10-bit alike; the false-claim path catches a decoder that can't do 10-bit.
- Old probe records have no Dolby Vision profile; assumed 7/8 (HDR10 layer).

## 6. Mi TV device checks

**Setup**
1. QA variant per the usual recipe (local server first marked `QA VARIANT`, versionCode above the installed one for the build only, `assembleRelease`, `timeout 60 adb install -r …`, `adb shell svc power stayon true`; afterwards revert and check 0 `QA VARIANT` markers).
2. Test clips: `node tools/av-test-clips.js <dir> --seconds 60` — a white bar crossing every 4 s at 23.976 / 24 / 25 / 29.97 / 50 / 59.94 fps; E-AC-3 5.1, AC-3 5.1, DTS, TrueHD, AAC; one HEVC Main10, one HDR10, one AV1. Serve from a private instance: `node -e "require('./scripts/ui-test-server').start({config:{libraries:{movies:['<dir>'],shows:[]}}}).then(s=>console.log(s.url))"`. Expected with the assumed profile: AV1 → transcode; DTS → remux (direct if the report lists dts); TrueHD → remux; the rest direct.
3. Sign in as Claude QA. `adb logcat -s ReactNativeJS:V | grep -E "\[av\]|\[player\]"`.

**A. The report** — launch shows `[av] capabilities reported: <id>`. Keep `curl <server>/api/caps/<id>` as the device dump. `hevc.profiles` has main10; av1 absent unless hardware AV1; passthrough list matches the TV's Sound settings; note the display modes. Cross-check `dumpsys media.player` / `dumpsys display`; recount (§2).

**B. Refresh rate** (Auto; `adb shell dumpsys display | grep -iE "mActiveModeId|activeMode"` before and during)
- 23.976 → 23.976 or 24 Hz (`[av] frame rate 23.976: 60 → … Hz, settled in N ms`); if "not switched (no mode …)", record that judder stays. Pass: blank ≤3 s on the loading screen, starts at 0:00 with the bar at the left, glides evenly, dumpsys shows the new mode.
- 24 → 24 Hz. 25 → 50 or 25 Hz. 29.97 → 59.94 if offered, else not switched with no blink. 50 → 50 Hz. 59.94 → 59.94 if offered.
- Note N ms each; target total ≤3 s.
- Back out: about 1.5 s later one blink back to the screen's own mode. Back then replay within 1.5 s: no back-and-forth blink.
- Off: no `[av] frame rate` line, no blink.
- Website (same profile) shows Off under On the TV; setting Auto there shows Auto on the TV.

**C. Passthrough** (Surround: Auto)
- E-AC-3 clip: server log `→ direct (eac3)`; `dumpsys media.audio_flinger | grep -iE "format|AUDIO_FORMAT"` shows `AUDIO_FORMAT_E_AC3`; tone audible; a receiver shows Dolby Digital Plus.
- AC-3 → `AUDIO_FORMAT_AC3`. HEVC10 → direct (eac3), hardware decoder. HDR10 → direct (ac3), HDR badge. DTS → remux or direct (dts), audible. TrueHD → remux, audible as AAC. AV1 → `transcode · video: no av1 decoder`, plays as H.264.
- Stereo only: E-AC-3 replay shows `audio: eac3 decoded here (surround: stereo only)`, PCM output only; DTS and TrueHD go remux. Set back to Auto.

**D. Direct-play counts** — real counts from the device dump; H.264+AAC MP4, H.264+AC-3 and HEVC10+E-AC-3 each go direct with no `/stream/transcode` in the server log.

**E. False claims**
1. Silent start: QA variant only, add `'truehd'` to passthrough in `avCaps.ts buildReport` (marked QA VARIANT), play TrueHD. Expect `→ direct (truehd)`, then `[av] the sound did not play here: {"passthrough":["truehd"]}`, the film continues with sound from the same point, a new report without truehd, replay goes straight to remux. Remove the line, 0 markers.
2. Turn the TV's digital output / passthrough off: E-AC-3 still plays decoded; after relaunch the report follows the setting. Restore.
3. Regression: 25 fps AAC clip plays direct; a second dub still goes through the copy.

**F. Parity** — TV and website "On the TV" values match both ways with the same wording.

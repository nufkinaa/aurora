# Aurora for Android phones — plan

Owner: elia. Branch `android-phone` (worktree `C:\elia\aurora-phone`), from master c61afb7 (server 1.14.1 / TV 5.7.1).

elia: *"We already made all for TV, let's have another release for Android phone … organise the UI and UX for Android, make it better to use on a phone and make improvements for the Android mobile platform so it works smooth."*

## 1. The decision: one codebase, a second app inside `tv-native`

| Option | What it costs | What it gives | Verdict |
|---|---|---|---|
| **A. A phone build of `tv-native`** — same RN 0.86 (react-native-tvos runs on phones), same Kotlin modules, a second JS root with touch screens, its own applicationId | New phone screens + a phone chrome for the player; a gradle switch | Every hard-won piece is shared as it is: api.ts (sign-in modes, kids header, 401/reset hooks, image headers patch), boot/session rules (App.tsx), personPrefs/personSync, partySync, householdRecs, recovery.ts (1.13.7/5.7.1 rule), avCaps (direct play by what the phone decodes), the whole Player (sources, offsets, jit, subtitles in JS, skip intro/credits/Up next, stall recovery), realtime socket, telemetry | **Chosen** |
| B. A separate RN app reusing modules | A second package.json / node_modules / patches / RN upgrade path; shared code by copy or a workspace | Nothing A doesn't, and two RN trees to keep patched (the Image-headers patch alone has bitten twice) | No |
| C. Wrap the website (TWA / WebView) | Small | No ExoPlayer (hls.js in a WebView, no hardware HEVC/AC-3), offline limited to the Cache API, no real PiP/media session/background audio, no downloads service | No — it would be the website with an icon |

**How A is built so the TV can never be hurt:**

- **One gradle switch, default TV.** `gradlew assembleRelease` builds the TV app exactly as today (same applicationId `com.auroratv`, same output path, same manifest — every TV recipe and `build-apk.bat` unchanged). `gradlew assembleRelease -Paurora=phone` builds the phone app:
  - applicationId **`com.aurora.phone`** — installs beside the TV app, never replaces it; own versionCode/versionName line (phone 1.0.0, vc 1…).
  - its own manifest (`android/app/src/phone/AndroidManifest.xml`): launcher (not leanback), portrait + landscape, no TV providers/channels/search provider/boot job, deep links, PiP on the activity.
  - its own activity source (`android/app/src/phone/java/…/PhoneActivity.kt`): edge-to-edge, predictive back, PiP, no D-pad gates.
  - its own JS entry (`index.phone.js` → `src/phone/PhoneApp.tsx`) via the RN gradle plugin's `entryFile`, so **the TV bundle contains no phone screens and the phone bundle no TV screens**.
  - its own APK name (`aurora-phone-release.apk`), ABIs arm64-v8a + armeabi-v7a (+ x86_64 for the emulator QA build only).
- **Shared JS is shared, not forked.** The boot/session flow moves from `App.tsx` into `src/AppRoot.tsx` with the screens passed in; `App.tsx` (TV) keeps its exact behaviour. Shared modules that must differ ask `isPhone()` (`src/formFactor.ts`, set by the phone entry before anything else runs) — the TV path of every such branch is the old code, unchanged.
- **The player is shared.** `playback/Player.tsx` keeps all its logic; on a phone it draws a touch chrome (`src/phone/player/`) instead of the D-pad one. TV chrome untouched.
- TV jest + tsc + `assembleRelease` (TV) are run after every step; they must stay green.

## 2. The phone app — what it is

The website's phone design, as a native Android app (parity rule: same features, same words, per-person settings on the server):

- **Boot**: nufurora.com first, then the house server (the TV's `SERVER_CANDIDATES`/serverPick, unchanged); QA builds put `http://127.0.0.1:4000` first (adb reverse to a private instance). Sign-in exactly as the TV: closed mode → sign-in screen (username + password, Google is web-only → "Sign in with a code" from the website's Pair page), open/transition → "Who's watching?" wall with password / household PIN; forced new password; kicked/banned/signed-out handling — all from the shared AppRoot.
- **Look**: glass — dark ground with the aurora sky (a baked gradient image, no per-frame canvas), glass top bar (logo · settings · avatar), floating glass bottom tab bar **Home · Movies · Shows · My List · Search** (the website's), cards with the hairline edge, white pill primary button, round glass action buttons with labels underneath. Android touches: ripple feedback, edge-to-edge under the status/navigation bars, predictive back, haptics on long-press, 48 dp touch targets.
- **Home**: billboard carousel (swipe, dots, Stream/Play + Details), greeting line, Continue Watching (landscape frame cards with progress + ✕), every server row (Recommended for you, **Recommended by your household** under it, Trending, New, genres, My List…), "Show all" pages; pull to refresh; snapshot of last Home drawn at once (homeSnapshot.ts).
- **Title pages** (film / show / discover): backdrop header with kicker (FILM / SERIES), title, rating · year · runtime, primary button (Play / Continue S1 E1 · 0:15 / Save & watch), action row (Stream instead · My List · Recommend · X-Ray · Mark watched · Play on TV · Follow · Trailer), synopsis with More, cast/director, your rating, season pills + glass episode cards (still, kicker, title, synopsis, progress bead, ✓, download state), Sources sheet, Similar titles.
- **Search**: field with the mic (Android SpeechRecognizer via VoiceModule / RecognizerIntent), the shared spoken-query normaliser, recent searches, results grid; library + catalogue.
- **My List**, **Movies / Shows** grids with genre chips and paging.
- **Player** (ExoPlayer, hardware decoding): tap shows/hides the chrome; double-tap left/right ±10 s (chained); horizontal drag seeks with a preview time; vertical drag on the left = brightness, right = volume; pinch = fill/fit; draggable scrubber with intro band + ticks; lock; subtitles (style from personPrefs), audio tracks (original first), speed, X-Ray, Watch together, skip intro / recap / credits, Up next, resume, the bounded recovery rule (same spot ×2 → card + Try again, never 0:00); landscape-first with rotation allowed; keeps the screen on.
- **Downloads**: the server's downloads (My downloads, cancel/dismiss, progress) and **On this phone** (offline copies, below).
- **Settings**: profile (name/avatar shown, switch profile, sign out), playback (subtitle look S–XL/colours/outline/box/opacity/weight/position, audio language, autoplay next, night mode/dialogue boost), downloads (offline quality, Wi-Fi only, storage used, delete all), notifications, voice language, usage stats, about (version, server).

### What the Android phone adds over the website

| Area | Phone app | Why it is better than the site |
|---|---|---|
| Offline | **Real files on the phone**: the server's `/api/offline/options|prepare|status` flow (same as the site), then Android **DownloadManager** into app storage — runs in the background and with the app closed, resumes after a dropped line, system progress notification, Wi-Fi-only option, storage check before starting; plays from the file with the queued progress sent when back online | The site's copy lives in the browser cache (quota, eviction, tab must stay open) |
| Playback | ExoPlayer with **hardware decoding** (HEVC/AC-3/E-AC-3 where the phone has them → direct play reported by avCaps, fewer server encodes), **picture-in-picture** (Home button / swipe up while playing, auto-enter on Android 12+), **media session** (lock screen + notification controls, headset buttons, Bluetooth), background audio only while PiP | Browsers can't PiP reliably on Android, no system media controls for MSE |
| Gestures | swipe seek / brightness / volume, double-tap skip, pinch zoom, lock | — |
| Chromecast | **not in v1**: needs Google Cast SDK (Play services) + a receiver; the "Play on TV" remote covers the household's TVs today. Listed for elia's decision. | |
| Share | Android share sheet: a title's nufurora.com link | — |
| Deep links | `https://nufurora.com/#/movie/…`, `#/show/…`, `#/discover/…`, `#/remote`, `#/party/<code>` open the app (App Links need `assetlinks.json` served by nufurora — a server file, listed for the release); `aurora-phone://` always works | — |
| Notifications | Android 13+ POST_NOTIFICATIONS asked once, when first needed (a download / "ready to play") | — |
| System | edge-to-edge, predictive back (Android 14+), dark theme always (Aurora is dark), dynamic font scale honoured, tablets/foldables: two-column title page, wider grids, landscape Home | — |
| Battery | no living canvas sky (baked image), pictures sized `?w=` to the card, socket paused in the background (reconnect on return), no polling while hidden, screen-on only while playing | the site's sky canvas costs ~40% main thread while visible |
| Phone remote | Your TVs: D-pad + OK/Back/Home, volume, play/pause/seek, subtitles/audio, "Play on TV" from any title (the server's devices channel, as the site's #/remote) | native haptics, stays connected |
| Watch party | create / join by code, the shared partySync rules (1.10.4: sync on join, follow each play/pause/jump, 20-min alignment, no rate nudges) | — |

## 3. Phases

**Phase 1 — a working, polished v1** (this branch):
1. Build switch + phone manifest/activity + `index.phone.js` + `AppRoot` split (TV unchanged) + phone QA build on the emulator.
2. Phone design kit: theme (phone sizes), glass surfaces, sky, buttons, cards, top bar, bottom tab bar, sheets, toasts.
3. Sign-in, wall, new password; Home; title pages; Sources; Search (+ voice); My List; Movies/Shows; Downloads (server); Settings.
4. Player with the phone chrome and gestures; rotation; keep-awake.
5. Measure on the emulator: cold start to Home, Home scroll jank %, title-page open, player first frame (`dumpsys gfxinfo` framestats, logcat timeline).

**Phase 2 — as time allows**: offline to the phone (DownloadManager module + offline playback + progress queue), PiP, media session notification, watch party UI, phone remote, household recommend sheet, share, deep links, tablet layouts.

**Not in this branch** (orchestrator / elia): version numbers, CHANGELOG, publishing an APK (`public/aurora-phone.apk` + a `phone-version.json` for an in-app update check — the TV updater module works for any applicationId), `assetlinks.json` on nufurora, Chromecast.

## 4. Verification

- Emulator: AVD Pixel_9_API_37 (1080×2424, 420 dpi, x86_64, Android 17 preview), every adb call `-s emulator-5554` inside `timeout`; the Mi TV (192.168.50.31) is never touched.
- QA build: `-Paurora=phone -PreactNativeArchitectures=x86_64` with `http://127.0.0.1:4000` first in SERVER_CANDIDATES (QA-variant marker line, removed after; `grep` asserts 0 markers), `adb -s emulator-5554 reverse tcp:4000 tcp:<private port>`; the private instance is tools/mobile-perf's (400 made-up titles, posters, profiles Glass/Legacy) — never nufurora, never the house server.
- Screenshots in `docs/android-phone/shots/`, looked at; numbers in `docs/android-phone/REPORT.md`; real-phone checks in `docs/android-phone/DEVICE-CHECKS.md`.
- Tests: TV `npx jest -c jest.logic.config.js` + `npx tsc --noEmit -p .` + TV `assembleRelease` green after each step; new pure phone logic (gestures, offline queue, layout maths) gets jest tests.

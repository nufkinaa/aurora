# release-next: the one Mi TV pass

Branch `release-next` (master 1.6.100 / TV 5.2.0 + fix-subs, fix-person-layout, fix-airplay, tv-next,
tv-native-port, feat-taste-swipe, feat-credits-cv, fix-web-batch). Nothing in this list has run on a
device. It merges three device lists, deduplicated and put in the order that needs the fewest rebuilds,
restarts and mode switches:

- `docs/qa/tv-next/DEVICE-CHECKLIST.md` (items 1-6, "tv-next N")
- `docs/qa/native-port/DEVICE-PLAN.md` (sections 2-5, "port N")
- `docs/qa/taste-swipe/tv-device-checks.md` (items 1-14, "taste N")

It also adds the TV checks from `docs/qa/subtitles/REPORT.md` ("subs N") and the person-sheet note from
fix-person-layout. The source documents keep the code pointers and the reasons. This file is the running
order and the evidence to collect.

AirPlay, credits-from-the-picture and the web batch have no TV part. The credits picture changes only the
time the server reports. Check once that "Up next" on a library episode still appears near the credits
(P-7), and nothing more.

---

## 0. Setup (once)

- **Server.** A private/QA instance running `release-next`. It must not be the live :4000 and must not be
  nufurora.com. This branch's server is needed for: the goodbye routes, X-Aurora-Viewer, `/taste/deck`
  `/taste/answer`, X-Aurora-Base, the subtitle names, and `/api/tv/tuning` `tvRender`. Start it in sign-in
  mode **open**; phase D switches it to **closed**.
  - Before the pass, let the server's background subtitle-language pass run once over the QA library, so
    the names in subs 5 are there. This is one low-priority ffmpeg read per untagged file.
- **Build.** One QA variant of `release-next` for the whole pass:
  - local server first in the candidates, marked QA VARIANT;
  - versionCode above the installed 97 (local edit, never committed);
  - built with the port's QA receiver:
    ```bash
    cd tv-native/android && ./gradlew.bat assembleRelease -PqaReceiver=true -PqaToken=aurora-port-qa
    timeout 120 adb -s 192.168.50.31:5555 install -r app/build/outputs/apk/release/app-release.apk
    timeout 20 adb -s 192.168.50.31:5555 shell svc power stayon true      # never "false"
    ```
  - Afterwards, revert the QA edits and assert `grep -rn "QA VARIANT" tv-native/src` gives 0 lines. The
    recipe is in memory `aurora-tv-qa-mitv-2026-10-06.md`. The `Q()` helper is in port §1.
  - Check `Q ping` gives `impl=-` (every render switch off: this is today's JS app).
- **Profile.** Use "Claude QA" (claudeqa) only. Cancel, then dismiss, every download the pass starts:
  `POST /api/downloads/:id/cancel`, then `/dismiss` with `{"profile":"242da3b05797"}`.
- **Logs.** Run `timeout … adb logcat -s ReactNativeJS:V AuroraQA:I AuroraRender:V` for the whole pass,
  and keep the server log open. Wrap every adb call in `timeout`.
- **Test titles.** Have these ready on the QA server:
  - **F1:** a library film with EAC-3/AC-3 audio, ≥3 audio tracks, an embedded and a sidecar subtitle, and
    an intro mark. This is the remux/offset-copy path.
  - **F2:** an HEVC or 10-bit film (h264 encode at the start).
  - **F3:** a film not on disk with seeded sources.
  - **S1:** a show whose next episode is not on disk.
  - **S2:** a show with untagged embedded tracks (Silo S03-like).
  - **T1:** a DTS/HEVC torrent release (`needsTranscode`).
- **Second viewer.** A desktop Chrome on the same QA server (website), for the busy server, "Started by"
  and the second viewer.

## A. Today's app (switches off), server open — Home, Settings, taste

| # | from | do | expected / evidence |
|---|---|---|---|
| A-1 | tv-next 4a | Home: on a long poster shelf, go RIGHT to card ~15 and rest. Hold LEFT to 0 ×3, then hold RIGHT to the end ×3. | `logcat \| grep "\[row\] behind"` prints nothing. No card shows up late at the left edge. **Evidence:** the empty grep, and a screenrecord of one held LEFT. |
| A-2 | tv-next 2f/2g/2h | Home hero: (f) "Stream" on a stream film; (g) Play on a film on disk; (h) Play on a SHOW. | (f) The title page opens and plays by itself within ~3 s. `[play] pressed for you…` appears. BACK goes to the title page, BACK again goes Home. (g) The player opens directly. (h) The episode its Play names plays: the copy, or save + stream. |
| A-3 | tv-next 2i | Continue Watching, library film card. | One press resumes at the saved spot, with no title page. |
| A-4 | tv-next 4b | Open Settings from the rail. | The first genre chip is focused with its ring visible ("What's new" if the genres are slow). Focus never jumps later. **Screencap.** |
| A-5 | taste 1-10 | Settings → "Swipe your taste". Walk taste 1 to 10 in order: focus on the card, RIGHT/OK = Love, LEFT = Not for me with **no rail**, DOWN = Haven't seen, 10 quick taps = exactly 10, hold RIGHT 2 s with no backlog, UP to toolbar and DOWN back does not answer, Undo ×2 (check `#/taste/list` on the website), round end at 24 and Keep going, Done/BACK lands on the row. | As in the taste list. **Screencaps** of taste 1, 2, 7 and 9 into `docs/qa/taste-swipe/tv-*.png`. |
| A-6 | taste 12 | Android Accessibility → Remove animations, then open the picker again. | A fade instead of the flight. Switch the setting back afterwards. |

## B. Title page, Downloads, one press on Play

| # | from | do | expected / evidence |
|---|---|---|---|
| B-1 | tv-next 2a + subs 4 | F3's title page → Play once. | Toast "Saving <quality> · <size> — playing it while it downloads". The player is on the torrent stream with no chooser. logcat has `[play] one press: streaming the film while it downloads`, and `GET /api/downloads` lists the job by Claude QA. The person's default subtitle language comes on by itself (write down which); a late-arriving track says "…switched on" (Dor's case). |
| B-2 | tv-next 2b/2c | BACK, then Play again. | The title page shows the download's progress. The second Play streams the SAME `stream.infoHash`: no "already on its way". |
| B-3 | tv-next 2d | S1's title page → Play. | Same as B-1 with the S/E in the heading. A `torrentSubtitles` request for that episode, now with `release=` in the server log (fix-subs ranking). |
| B-4 | tv-next 2e | Press an episode CARD you don't hold. | It only downloads, and shows the "Sources · S1 E5" pill. Focus stays and no player opens. **Screencap.** |
| B-5 | tv-next 3 | Start a download from the website as another test profile. Then TV Settings → Downloads. | Its row under "Also on the server" ends with "· Started by <name>". Your own rows don't. **Screencap.** Cancel and dismiss both downloads. |
| B-6 | tv-next 2j/2k | Only if the orchestrator wants it: a `torrents:false` server and a kids profile. | See tv-next 2j/2k. |

## C. The player (F1, F2, T1), server open

| # | from | do | expected / evidence |
|---|---|---|---|
| C-1 | tv-next 1a/1b | F1: open the gear menu. DOWN through every row to "Report a problem" and UP back. Test the edges (DOWN on the last row, UP on the first, LEFT/RIGHT). Tick dub 3 and reopen. | The panel is inside the screen, top below the title (~81 dp). The focused row is always fully visible. The edges do nothing. On reopen, the ticked dub shows and is focused. The audio names are language names (subs 5: no "Stereo", no release strings). **Screencaps** at the top, middle and bottom. |
| C-2 | tv-next 1c | Subtitles, Speed and Watch together menus. | Contained, and they scroll. **Screencaps.** |
| C-3 | subs 1 | F1: resume at about 10:00. Do the same on the website at the same point. | The scrubber and a chosen cue agree within ~0.3 s. logcat shows `copy job at N: its clock starts at …` a few seconds below N. Repeat after a far seek and with a second dub. The saved resume point is not ahead. *Merge note:* on a busy server the claim now answers BEFORE ExoPlayer gets the source, so this line comes before the first frame. |
| C-4 | subs 2 | Subtitle delay ±0.5 / ±5, playing and paused. Reopen the title. Then Reset. | The cue moves at once, backwards too. On reopen the delay is back for that track only, with an "as you left it" note. After Reset it is 0. |
| C-5 | subs 3 | With the chrome up, a two-line cue at S, M and L. Then hide the chrome. | The cue sits above the scrubber. With the chrome hidden it goes back to the old position. **Screencap** at M. |
| C-6 | subs 4 | Hebrew-default profile, after another profile pressed Off on this TV. A broken track. An untagged embedded track (S2). | Subtitles come on. "…trying another track". "Preparing subtitles…". S2's tracks show language names. |
| C-7 | tv-next 5a | F1 through the remux: play 20 s, then BACK. | Within 1 s the server log has `[remux] its viewer left: <id>-<mtime>-<v>-<ss>`. No `idle-killed` for that dir 2.5 min later. |
| C-8 | tv-next 5b | The same film open in Chrome, then the TV leaves. | The browser keeps playing (its job is not stopped). |
| C-9 | tv-next 5c | T1: play, then BACK. | `[torrent-transcode] its viewer left: <hash>-<idx>-<ss>`. |
| C-10 | tv-next 6a/6b/6c | Set admin `maxEncodes` = 1. Start a 720p data-saver encode in Chrome and keep it playing. (a) F2 on the TV. (b) Repeat (a), stopping Chrome's encode during the 1/3 or 2/3 wait. (c) A copy start on F1. | (a) `the server is busy: asking again in 5000 ms (1/3)…(3/3)`, then `giving up`. ONE "server is busy" screen with Try again / Back, and no codec-ladder messages. The server log has NO playlist read without `&seek=1` during the wait. (b) It starts by itself after the next ask. (c) It starts at once. Set `maxEncodes` back to "auto". **Evidence:** logcat and a screencap. |
| C-11 | subs + tv-next | During C-10 (a) on a film with subtitles: | No subtitle toast or "Preparing subtitles…" over the busy screen. After (b), the cues are on the job's clock from the first frame. |
| C-12 | (credits-cv) | A library episode with no credits mark from the audio: play its last minutes. | "Up next" shows at the picture's credits time (server log: the source that won). |

## D. Popups, X-Ray, person sheet, kids — then 1280×720 dp

| # | from | do | expected / evidence |
|---|---|---|---|
| D-1 | tv-next 1e + person-layout | X-Ray on a title with guests, regulars and filmmakers → a person sheet. Also: an episode's long-press sheet, the peek sheet (long-press a Continue Watching card), the report sheet, the update popup (if a newer tv-version.json is at hand), and a 30-row Sources list. | Nothing past the screen edges. Every button is reachable with the D-pad. Person sheet: the shelves shrink rather than run past the panel's foot; the IN LIBRARY / WATCHED / DOWNLOADING flag sits on the poster's foot. **Screencaps.** |
| D-2 | person-layout | Android Settings → font size Largest, then the same person sheet. | The head grows and the shelves give up height. Nothing overlaps or leaves the panel. Set the font size back. |
| D-3 | tv-next 4c + taste 13 | A kids profile, created on the QA server only and removed afterwards, whose age shows no films on "All". Movies page, then with a genre set, then Swipe your taste. | "No films for this age here yet." / "Nothing in <genre> for this age here. Try another genre?" The deck holds only rated titles for its age, or shows "That's every title we had for you". **Screencaps.** |
| D-4 | tv-next 1d | `adb shell wm density 240`, then the gear menu on F1 again, and one person sheet. | The panel is taller (max 446 dp) and still inside the screen. **Screencap.** Then `wm density reset`. |

## E. Render switches ON (port §2), server open

`Q render recommended`, force-stop, then launch. `Q ping` should give
`impl=FCRHN exp=cardlayer+cull+shadowcache+unstuff+pool src=qa`. logcat must have no `AndroidRuntime` or
`ReactNativeJS` errors, and no `[row] behind` or `[home] behind`. Walk port §2 rows 1-9 and 11-13. Merge-specific
checks within it:

| # | from | do | expected / evidence |
|---|---|---|---|
| E-1 | port 2.3 + tv-next 4a | Hold RIGHT along the 4th shelf (24 cards) to the end, then hold LEFT back. Then repeat A-1 exactly. | The shelf stays full. No title on the wrong card. `[row] behind` stays empty: the held-key lead is the window's rule and must hold with the native track and the pool (row-native.test.tsx proves it offline). **Evidence:** the grep, and a screenrecord of one held LEFT. |
| E-2 | port 2.1 + hero look | Cold start. | The 5.2.0 hero look in native art: gold ★, silver score, text shadow. The rail is shut. |
| E-3 | tv-next + port | A-2 (hero Stream/Play) and A-4 (Settings first focus) once more. | Same as in A, with the native Focusable. |
| E-4 | port 2.11 | Settings → hold OK on "Aurora TV x.y.z". | "Rendering (developer)" appears. The "Swipe your taste" row and the first-focus chip are unaffected. |
| E-5 | taste 2-4 | Three answers in Swipe your taste. | The same as in A-5 (the picker uses the native Focusable). |

## F. Closed mode (once per release — memory `aurora-tv-image-headers.md`)

Switch the QA server to sign-in mode **closed** and restart it. Sign the TV in as Claude QA.

| # | from | do | expected / evidence |
|---|---|---|---|
| F-1 | port 2.10 | Switches still ON: Home, every shelf, the billboard, Movies grid, a person sheet. | Every card and the billboard draw (the native views send `headersJson`): no grey tiles, and no 401 in logcat or the server log. **Screencap** of Home. |
| F-2 | taste 11 | Swipe your taste. | The posters draw at once: no blank cards, no 401. |
| F-3 | | `Q render clear`, restart the app, Home again. | The JS cards draw too. **Screencap.** |
| F-4 | tv-next 5d | C-7 once in closed mode. | The `[remux] its viewer left` line appears. (In open mode, C-7's line came from the X-Aurora-Viewer tag.) |
| F-5 | subs 4 | A film with a sidecar subtitle in a language the profile prefers. | It comes on (the wall also reads X-Session for subtitle files). |
| F-6 | B-1 | One press on Play for F3 (or a cached source). | It plays. Cancel and dismiss. |

Switch the server back to **open**.

## G. Pixels (port §3) — switches as each run sets them, server open

Run port §3 3a, 3b, 3c and 3d exactly as written: `tools/tv-bench/tv-pixel-diff/run.py`, then `strict.py`.
The pass rules are in port §3: 0 px on the deterministic states, the known lab retakes, `strict.py` ≤ 7/255,
and `pool-wrap-shadow` at 0 px. Then run `Q render clear`.

## H. Frames (port §4) — last, on an idle TV

Close every other app. Turn trailers OFF in Claude QA's Settings. Leave the TV idle for 5 minutes. Check that
`ps -ef | grep -E "tv-bench|run.py"` is empty. Run port §4:

- 4a: js, nat, ccsu and rec, over 4 rounds;
- 4b: L1, S1 and G1, pool against ccsu against js, over 4 rounds;
- 4c: under load, 3 rounds.

Then build the three `table.md` files. The gates are in port §4:

- `rec` and `ccsu` are not worse than `js` anywhere (janky ≤ +0.3 pt, p90 ≤ +1 ms);
- S1, S2 and L1 are better in ≥ 3 of 4 rounds;
- frames > 64 ms are not up;
- PSS is at most +20 MB;
- `pool` earns its place only through L1. If it does not, the device agent drops it from `RECOMMENDED`
  in renderRules.ts and AuroraRender.kt, in one commit, with the data.

Finish with `Q render clear`. Turning anything on for real is port §5: config.json `tvRender.models`,
edited by elia or the orchestrator.

## After the pass

- Cancel and dismiss every download. Remove the kids profile if one was made. Undo any Android settings
  changed (font size, animations, density).
- Run `svc power stayon true` (never `false`).
- Revert the QA-variant edits and confirm 0 "QA VARIANT" markers.
- File each failure with its logcat lines and screencaps, under the letter-number above.

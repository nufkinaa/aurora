# tv-next: what the Mi TV pass must show

Branch `tv-next` (from master 1.6.100 / TV 5.2.0). Six items, each with the evidence the pass must produce. Nothing here has run on a device yet: the TV parts are done only once this list is ticked.

## Setup

- **The server.** Run this branch's server on the QA server the TV is pointed at. Items 5 and 6 are partly server-side: the goodbye routes, `lib/viewer.js` and the `X-Aurora-Viewer` tag. Item 3 needs `by` on download jobs, which master has had since 1.6.99.
- **The TV build.** Build a QA variant of this branch: local server first, versionCode above the installed 97. The recipe is in memory `aurora-tv-qa-mitv-2026-10-06.md`. Run `adb shell svc power stayon true` after the install.
- **The profile.** Use the test profile "Claude QA" (claudeqa). Cancel and dismiss every download the pass starts: `POST /api/downloads/:id/cancel`, then `/dismiss` with body `{"profile":"242da3b05797"}`.
- **Logs.** Keep `adb logcat -s ReactNativeJS:V` running for the whole pass. Wrap every adb call in `timeout`.
- **Panel size.** The Mi TV lays out at 960×540 dp. For the 1280×720 dp checks, use `adb shell wm density 240`, and `wm density reset` after.

## 1. Popups are contained (player settings first)

Code:
- `tv-native/src/popupFit.ts` sets the ceilings.
- `Player.tsx`: `menuH` at about 722; the gear menu gets its own `ScrollView` at about 3831; the party menu scrolls too; all four menus are capped at `maxHeight: menuH`.
- `Sheet.tsx`: the body scrolls under the heading.
- X-Ray (`Overlays.tsx`) and the person sheet (`PersonSheet.tsx`) are capped at the top safe area.

Checks:
- **a. Gear menu on a heavy film.** Use a film with ≥3 audio tracks and an intro to mark. If that is not available, use an episode, which adds PLAYBACK.
  - Open the gear menu. Screencap: the whole panel is inside the screen and its top edge is below the title line, at ~81 dp from the top at 540.
  - Press DOWN through every row to "Report a problem". After each press, screencap or watch: the focused row is fully visible and the list scrolls under it.
  - Press UP back to the top: the AUDIO heading shows again.
  - DOWN on the last row and UP on the first do nothing: focus never lands on the transport bar behind.
  - LEFT and RIGHT do nothing.
  - **Evidence:** screencaps at top / middle / bottom of the list.
- **b. Audio list opens on the ticked dub.** On a multi-dub film with dub 3+ ticked, opening the gear menu shows the ticked row with focus on it, not an unmarked list. **Evidence:** screencap.
- **c. Subtitles, Speed, Watch together.** Same containment: open each one and screencap it. Subtitle menu contents are the subtitles agent's; check only the frame and the scrolling.
- **d. 1280×720 dp.** Repeat (a) once. The panel is taller (max 446 dp) and still inside the screen. **Evidence:** screencap.
- **e. Other popups.** Open each one and screencap it:
  - X-Ray on a title with guests + regulars + filmmakers.
  - A person sheet from X-Ray.
  - The update popup: `openUpdate` via Settings → "Check for updates" on a server with a newer `tv-version.json`, or skip if none.
  - An episode's long-press actions sheet.
  - The peek sheet (long-press a Continue Watching card).
  - The report sheet.

  For each one: nothing past the screen edges, and every button reachable with the D-pad. The Sources panel and the episode rail are FlatLists and were not changed: confirm that a 30-row source list scrolls with focus.

## 2. One press on Play

Code:
- `tv-native/src/playBest.ts` holds the pick, the play-item builder and `autoPlayStep`.
- `Detail.tsx`:
  - `streamNow` at about 1993 and `streamRunning` at about 2013.
  - The film's Play calls `downloadBestMovie(true)`; the show's Play calls `downloadBest(…, true)`.
  - The `play` route param drives `pressPlay` and the auto-press, at about 2297.
- `Home.tsx`: `heroPlay` at about 398 and `playContinue` at about 421.

The player picks the subtitle exactly as before (`autoTrack`). This path does not touch subtitles.

Checks:
- **a. Film not on disk, from its title page.** Press Play once.
  - The toast reads "Saving <quality> · <size> — playing it while it downloads".
  - The player opens on the torrent stream with no chooser.
  - First frame comes after the swarm wait.
  - logcat has `[play] one press: streaming the film while it downloads`.
  - `GET /api/downloads` lists the job, requested by Claude QA.
  - **Evidence:**
    - The logcat lines.
    - A screencap of the player.
    - The person's default subtitle showing, if the title has one in that language. Write down which subtitle was selected.
- **b. Back to the title page.** Back from the player lands on the title page. The Play button / status line shows the download's progress.
- **c. Press Play again.** The download is now running. Pressing Play again plays the stream of the SAME source; check `stream.infoHash` in logcat or the player's mark. It must not answer "already on its way". logcat has `[play] one press: streaming …`.
- **d. Show, next episode not on disk.** Use the title page's Play button. Same as (a), with the episode's S/E in the player's heading. Subtitles are fetched for that episode (`torrentSubtitles` request in logcat or the server log).
- **e. Episode card (owner's rule, unchanged).** Pressing an episode CARD you don't hold still only downloads it and shows the "Sources · S1 E5" pill. Focus stays on the card and no player opens. **Evidence:** screencap.
- **f. Home hero, stream FILM.** Press "Stream" once.
  - The title page opens and, within ~1–3 s, the player starts by itself.
  - logcat has `[play] pressed for you: the best source, streamed while it downloads`.
  - Back goes to the title page; Back again goes Home.
- **g. Home hero, film on disk.** This covers a library film, and a stream card the server matched (`inLibrary`). The player opens directly, with no title page.
- **h. Home hero, SHOW.**
  - The title page opens and plays the episode its Play button names.
  - If you hold that episode, it plays the copy.
  - If not: save + stream.
  - logcat has `[play] pressed for you`.
- **i. Continue Watching, library film card.** One press resumes in the player at the saved position, with no title page. Episodes and torrent entries behave as before.
- **j. Torrents switched off.** Only if a server with `"torrents": false` is at hand: the hero's Stream and Play say "downloads are switched off here" and nothing plays.
- **k. Kids profile.** Skip unless the orchestrator wants it.

Clean up every download this item started: cancel + dismiss.

## 3. "Started by <name>" on others' downloads

Code:
- `downloadsLogic.ts` `startedBy`.
- `Downloads.tsx` at about 275.

Checks:
- With a download requested by another profile on the QA server (e.g. one started from the website as another test profile), open TV Settings → Downloads.
- The row under "Also on the server" ends with "· Started by <name>".
- The person's own rows say nothing of the kind.
- **Evidence:** screencap.

## 4. Minor items

- **a. Held LEFT on a Home shelf** (`rowWindow.ts` `runMargins`, `Row.tsx` at about 212).
  - On a long poster shelf, go RIGHT to card ~15 and rest. Then hold LEFT to card 0, three times; then hold RIGHT to the end, three times.
  - `adb logcat | grep "\[row\] behind"` must print nothing.
  - No card appears late at the left edge.
  - **Evidence:** the empty grep, and a short screenrecord of one held LEFT.
- **b. Settings opens with focus.** Open Settings from the rail.
  - The first genre chip is focused and its ring is visible. If the genres are slow, "What's new" is focused instead.
  - Focus never jumps later.
  - **Evidence:** screencap right after opening.
- **c. Kids profile, empty Movies page.** Use a kids profile whose age shows no films on "All". Create it only on the QA server and remove it after.
  - The page says "No films for this age here yet." with "Try another category".
  - With a genre set, it says "Nothing in <genre> for this age here. Try another genre?".
  - **Evidence:** screencap.

## 5. Goodbye stops the TV's offset transcode

Server:
- `src/media/goodbye.js`.
- `remux.release`, `torrent-transcode.release`.
- `routes/stream.js` bye at about 540.
- `routes/torrent.js` `POST /stream/torrent/hls/:infoHash/:fileIdx/bye`.
- `lib/viewer.js`.

TV:
- `api.ts` `mediaHeaders` carries `X-Aurora-Viewer`.
- `api.torrentBye`.
- `Player.tsx` at about 1743.

Checks:
- **a. Library film through the remux.** Pick a film the TV plays through the remux (an AC-3/DTS file, or an audio track other than the first). Play it 20 s, then press Back.
  - The server log has `[remux] its viewer left: <id>-<mtime>-<v>-<ss>` within a second of Back.
  - No `[remux] idle-killed` for that dir 2.5 min later.
  - **Evidence:** both server log lines (or the absence of the second).
- **b. A second viewer on the same film.** A browser on the same film is not affected by the TV's goodbye. The jit producers have their own rule, already tested. Optional.
- **c. Torrent with `needsTranscode`** (a DTS/HEVC release). Play it, then press Back. The server log has `[torrent-transcode] its viewer left: <hash>-<idx>-<ss>`.
- **d. Open server and closed server.** Do (a) once with the QA server in sign-in mode open and once closed. In open mode the TV's `X-Aurora-Viewer` tag is what matches ExoPlayer's reads with the goodbye. **Evidence:** the log line in both modes.

## 6. Busy server, deterministic

Code:
- `serverManners.ts` `claimFirst` / `afterClaim`.
- `Player.tsx` `startTranscode` at about 1214 and `claimStream` `handOver` at about 1162.

Make the server busy: on the QA server set the admin setting `maxEncodes` to 1. Then start one re-encode elsewhere (a browser on a film at "720p data saver", or a TV on an HEVC file) and keep it playing.

Checks:
- **a. Start a second re-encode on the TV** (a film whose start is an h264 transcode: HEVC/10-bit picture, or "lower quality").
  - logcat shows `[player] the server is busy: asking again in 5000 ms (1/3)`, then (2/3), then (3/3), then `giving up on this start`.
  - The TV shows the one "The server is busy with other streams right now…" screen with Try again / Back.
  - No codec-ladder messages and no "can't be played on this device".
  - The server log has NO playlist request without `&seek=1` for that offset during the wait: ExoPlayer was never handed the source.
  - **Evidence:** logcat + a screencap of the message.
- **b. Room comes back during the wait.** Repeat (a), but stop the other encode during the 1/3 or 2/3 wait. The TV starts playing by itself after the next ask, with no error.
- **c. Copy start on a busy server.** A copy (remux) start on the busy server still starts at once: copies are never refused.

Afterwards, reset `maxEncodes` to "auto".

## Tests run on this branch (no device)

- **TV:** `cd tv-native && npx jest -c jest.logic.config.js` and `npx tsc --noEmit -p .`. New suites: popup-fit, play-best, browse-copy, plus additions to row-window, row-mounts, server-manners, downloads-actions and profile-scope.
- **Server:** root `npm test`, adding `test/goodbye.test.js`.
- **test:ui:** the whole suite, adding `test/ui/tv-goodbye.test.js`. That test uses a real ffmpeg on the private instance: a TV-shaped goodbye (different user agents, same tag) stops its own h264 offset job, and another TV's does not.

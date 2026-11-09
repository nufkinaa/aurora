# TV 5.9.0 / phone 1.1.0 — the device checklist (one pass)

Build under test: `aurora-tv-qa-211.apk` (QA variant: SERVER_CANDIDATES = only
`http://127.0.0.1:4000`, versionCode 211, above the Mi TV's QA 201) against a PRIVATE server
through `adb reverse tcp:4000 tcp:<port>`. Never nufurora.com.

TV rules: `adb -s 192.168.50.31:5555` only, wrap every call in `timeout`; after every install
`adb shell svc power stayon true` (never `stayon false`); never KEYCODE_SLEEP / POWER keys; leave
a working QA build installed. Photos: `adb exec-out screencap -p` → docs/qa/app-release-5.9/tv-*.png
(the video plane is black in screencaps: read the position off the remote / logcat).
Profiles: private-server QA profiles only (QA Alpha — no password, QA Beta — password; a kids one
when the kids checks need it). Senders: real Chrome on the PC, the emulator (emulator-5554) with
`aurora-phone-qa-64.apk`, both on the same private server.

## 0. Install
- [ ] `adb install -r aurora-tv-qa-211.apk` → Success; `svc power stayon true`; reverse 4000.
- [ ] Launch: Home within ~5 s, the version in Settings → About says 5.9.0.
- [ ] New screen: the ribbon is on this round's cards (Play on TV first, then Hebrew subtitles,
      Search in Hebrew, overnight episodes, Save & watch, Say what's wrong, language check,
      Tell me when it's ready, Pick together).

## 1. Play on TV / Continue on phone (this branch)
- [ ] TV in profile QA Alpha on Home. Chrome (QA Alpha) title page of the 10-min film → "Play on
      Living room TV" → the sheet "Play “Test Film Long” on Living room TV?" → the row: TV leaves
      Home and plays; Chrome says "Playing on Living room TV" and opens the remote.
- [ ] From Chrome's player at a known second (e.g. 2:05) → Play on TV → TV starts within ±3 s of
      it (burnt-in clock on the film; screencap of the TV's own scrubber); Chrome pauses.
- [ ] Remote (Chrome and the emulator): play/pause, ±10, scrub, D-pad, Back, Home, volume reach
      the TV.
- [ ] Remote → "Continue on this phone" (emulator) / "…this computer" (Chrome): the TV pauses,
      the sender plays from the TV's second.
- [ ] Emulator player → cast button → TV plays at the phone's second; the phone pauses and shows
      the remote; Back returns to the paused phone player.
- [ ] Wall: switch the TV to "Who's watching?". Send from QA Alpha (no password) → the TV enters
      QA Alpha by itself and plays. Send from QA Beta → the TV shows "Enter your password to play
      Test Film Long" (photo), the sender says "Enter your password on Living room TV to play …";
      type it (adb input text) → plays at the sent second. Back on the prompt drops the title.
- [ ] Household PIN / kids lock: with a kids profile + PIN, the wall shows "Enter your PIN to play
      …" — never enters a protected profile without it.
- [ ] Screensaver: `adb shell am start -n com.android.systemui/.Somnambulator` (or wait for the
      Google TV ambient mode) → send Play on TV → the screensaver ends and the film plays.
- [ ] Another app in front (e.g. Settings): Play on TV → either Aurora comes forward (with the
      "display over other apps" permission) or the sender reads "Aurora is in the background on
      the TV — open it there"; nothing starts later by itself.
- [ ] TV off the network (Wi-Fi off on the TV for 20 s): the sender reads "Living room TV
      didn't answer" within ~6 s; nothing plays when it comes back.
- [ ] Two senders at once (Chrome + emulator within a second): the later title plays; the earlier
      sender reads "Something else was just started on Living room TV".

## 2. Downloads v2 / tell me when it's ready / language checks (master 1.15.12–1.15.17)
- [ ] A download's status line on the title page and My downloads reads like the website's
      (waiting / downloading n % / ready).
- [ ] Settings → "Tell me when it's ready" switch: off on the TV → off on the phone and the
      website (person setting); a landed download shows the toast + TV notification when on.
- [ ] Wrong language → the new copy is checked: a wrong-language copy is not swapped in (notice),
      an unlabelled one is swapped in with the notice.
- [ ] Hung drive: with the library drive unplugged/hung, the message (not an endless spinner).

## 3. Save & watch, Problem with this copy → Other (tv-reports-nov)
- [ ] A title not on the server: "Save & watch" (no ⚠ Stream as the main action); pressing it
      saves and the page shows the progress; Play plays once it is in. Nothing requests
      /stream/torrent by itself (server log), the Home billboard never starts a download.
- [ ] Player ⚙ → Problem with this copy? → Other → the words first (keyboard), then "get another
      version" or "just send it"; the copy stays when only sent.

## 4. Subtitles (1.15.17)
- [ ] A film with only English subs, profile language Hebrew: "עברית (AI)" appears and switches
      on by itself (private server with the AI mock only).
- [ ] Subtitles menu: "Fix timing" lines a shifted track up; "the file's own timing" goes back.

## 5. Overnight prepared playback
- [ ] A show being watched: the next episode is downloaded and prepared overnight (force the job
      on the private server) → it starts on the TV without the "preparing" wait.

## 6. Pick together (group-pick, 1.15.18)
- [ ] TV: AI → Pick together → Start: big code and QR on the TV.
- [ ] Two phones (emulator + Chrome on the phone size, or the phone app) join with the code;
      swipe; the result shows on the TV.
- [ ] Play from the phone starts the result on the TV.
- [ ] Back on the TV during a round asks first.
- [ ] A kids profile limits the deck (no title above its age).

## 7. Scrubbing, as it is today
- [ ] Player: LEFT/RIGHT on the scrubber seek ±10 s per press, a burst lands once (no stutter of
      seeks), the thumbnail/clock follow; hold-to-scan speeds up; OK resumes at the new spot.
- [ ] Far seek (end of the film) on a repackaged (jit) title: plays within a few seconds, no
      macroblocks that stay.

## 8. Before leaving the TV
- [ ] Leave QA 211 installed, signed in to a QA profile, `svc power stayon true`.

---

# Phone 1.1.0 — what the emulator pass did and what is left

Done on emulator-5554 (screenshots in this folder): sign-in with a password; Home, the tab bar,
More (every line, in the website's order and words), the TV button, Play on TV from the title page
and from the player, Continue on this phone, the AI page, What's new, Saved / My downloads, Your
TVs, household, Wrapped, Swipe your taste, Sign in a TV, Join a watch party, Report a problem,
Settings, the profile menu, Get the apps (opens the browser), Pick together (lobby), the
subtitles menu with "Fix timing" and "עברית (AI)" (mock AI on the private server), Problem with
this copy → Other asks the words first, Save & watch on a title not on the server (POST
/api/downloads, nothing asked of /stream/torrent), offline save with the space limit, the
"Tell me when it's ready" switch (reaches the server and back).

Left for a phone pass (group-pick's own list):
- [ ] The TV's QR opens the phone app at its group screen — nufurora.com links only (a QA
      build on 127.0.0.1 cannot show it).
- [ ] The group screens at 360 dp wide (a small-phone AVD or `wm size 720x1520` on the emulator).
- [ ] Airplane mode during a swipe round: the swipe waits and goes on when the line is back.
- [ ] Save & watch on a real missing title: the page's progress line while it downloads (the QA
      stub answers the POST but has no real download to show).

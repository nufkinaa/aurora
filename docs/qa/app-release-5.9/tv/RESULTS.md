# Mi TV pass — TV 5.9.0 (QA 211, then 212 with the fix), 2026-11-09

Mi TV (Xiaomi TV Box, Android 14), private server only (127.0.0.1:4000 through `adb reverse`),
QA profiles QA Alpha (no password), QA Beta (password), QA Kid (kids, household PIN set on the
private server). Senders: real Chrome (CDP, its own profile) and a node sender speaking the
website's protocol (`remote_subscribe` / `play_item`) for the profile switches. Photos are in this
folder (`tv-*` the TV's screencaps, `chrome-*` the sender). Stay-awake stayed on throughout;
no sleep/power keys were sent; QA 212 is left installed.

| # | Check | Result | Photos |
|---|---|---|---|
| 0 | Install QA 211 (then 212), stayon true, reverse; boots, Settings shows Aurora TV 5.9.0 | PASS | tv-00-launch, tv-30b-settings-version |
| 0 | New screen: ribbon on this round's cards, Play on TV first, then Pick together, Hebrew subtitles, Search in Hebrew … | PASS | tv-31-whats-new |
| 1 | TV on the wall, Chrome (QA Alpha, no password) title page → one-TV sheet "Play “Test Film Long” on Xiaomi TV Box?" → the TV enters QA Alpha by itself and plays | PASS | chrome-01, chrome-02-confirm-wall-tv, tv-02-wall-entered-alpha-playing |
| 1 | From Chrome's player at 2:07 → Play on TV → TV plays at the same second (burnt-in clock 2:07–2:19 on the TV, remote 2:19 a few s later); Chrome leaves its player for the remote | PASS | chrome-04-player-confirm, tv-04-handoff-at-second, chrome-05 |
| 1 | Remote: pause, +30, volume (the TV's own volume UI), Home key, D-pad | PASS | tv-05, tv-06, tv-07-volume-ui, tv-13, tv-14 |
| 1 | Continue on this computer: the TV pauses, Chrome plays from the TV's second (183 s) | PASS | chrome-08-continued-here, tv-08-paused-after-continue |
| 1 | Wall + QA Beta (password): the TV shows "Enter your password to play Test Film Long — QA Beta · sent from QA Beta's phone"; sender hears status needs-password in 154 ms; password typed → plays at the sent second (1:30 → 1:38 at the photo) | PASS | tv-41-wall-asks-password, tv-42-after-password-plays |
| 1 | Household PIN (kids profile exists): wall + QA Alpha → "Enter your PIN to play Test Film Long" (needs-pin); never enters without it; PIN → plays at 2:30 | PASS | tv-45-wall-asks-pin, tv-46-after-pin-plays |
| 1 | Back on the PIN prompt keeps the prompt (the keyboard closes first) — a second Back leaves | PASS (as designed) | — |
| 1 | **Another app in front (TV Settings)** → Play on TV | **FAIL on 211, FIXED in 212**: 211 answered nothing, the sender read "Xiaomi TV Box didn't answer" after 6 s (the wake waited on a JS timer, which stands still in the background). 212: "Aurora is in the background on the TV — open it there" at once. Both: nothing started later when Aurora was reopened (the expiry rule) | chrome-10-send-while-other-app, tv-10-from-other-app, tv-11-reopened-nothing-started |
| 1 | Screensaver (a dream) → Play on TV wakes it | NOT RUN: a dream can't be started from adb without root (`cmd dreams` needs root, no Somnambulator on this box), and with stay-awake on (which must stay on) the TV never dreams by itself. The wake path itself is covered by the jest test; needs a hand: let the TV dream, then send. |
| 1 | TV off (force-stopped) → the sender's list is empty, nothing is sent; relaunched → nothing plays by itself | PASS | tv-44-relaunched-after-offline |
| 1 | Two senders at once: the later wins (plays at 6:40), the earlier gets "Something else was just started on Xiaomi TV Box" in 45 ms | PASS | tv-43-two-senders-later-wins |
| 2 | Downloads status on the title page ("Getting it… / Finishing Nowhere Film…") | PASS (shape) — the job was the proxy's stub, so the progress itself is not real | tv-61 |
| 2 | Tell me when it's ready: the TV's switch turns the person's setting off and on on the server | PASS | tv-62-ready-off |
| 2 | Wrong-language check on a new copy; the hung-drive message | NOT RUN (needs a real download / an unplugged drive on the server) |
| 3 | A title not on the server: "Save & watch" ("Press Play to save the best source · hold for the list"); pressing it POSTs /api/downloads, nothing asks for /stream/torrent | PASS | tv-60-not-on-server-save-and-watch, tv-61-save-and-watch-pressed |
| 3 | Player ⚙ → Problem with this copy? → Other → the words first (keyboard), then "Yes — pick another version / No — just send it / Back"; "No" sent the report "Problem with this copy: Other — QA test only. No other version asked for — the copy stays." | PASS | tv-54, tv-55-other-asks-words, tv-56, tv-57-other-then-choose |
| 4 | Profile language Hebrew, film with English subs only → "עברית (AI)" appears and switches on by itself (mock AI, private server) | PASS | tv-51-scrub-landed (Hebrew cue on screen), tv-52-subtitles-menu |
| 4 | Fix timing in the subtitles menu runs (resync) and says so; the file's own timing | PASS (runs; the made-up film has no speech, so "Couldn't match — kept as it was") | tv-53-fix-timing |
| 5 | Overnight prepared playback | NOT RUN (a night job on a real show) |
| 6 | Pick together on the TV: AI → Pick together → Start: big code (XB6K) and QR | PASS | tv-20, tv-21, tv-22, tv-23-pick-together-code-qr |
| 6 | A phone joins with the code (Chrome on #/group/XB6K), swipes; result on the TV; "Play on the TV" from the phone starts it on the TV | PASS (one joiner) | chrome-23, tv-24, tv-25, chrome-25, tv-26-result, tv-27-group-play-from-phone |
| 6 | Back on the TV during a round asks first | PASS | tv-28-group-back-asks |
| 6 | Two phones; a kids profile limits the deck | phone — later (emulator held by elia); the private library has no age ratings to limit |
| 7 | Scrubbing: a burst of three RIGHT presses on the scrubber lands once (+30 s, 1:33 → 2:03), the picture resumes there | PASS | tv-50-scrub-burst, tv-51-scrub-landed |
| 7 | Far seek on a repackaged (jit) title | NOT RUN (the QA films play directly) |
| 8 | Left installed: QA 212 (5.9.0), QA Alpha, stay-awake on | DONE | — |

## The bug the pass found, and the fix (commit 96f2ca8a on play-on-tv)

With another app in front of Aurora, Play on TV never answered (the sender read "<TV> didn't
answer" after the server's 6 s). Cause: 5.9.0's screensaver wake waited for Aurora to come
forward with a JS `setTimeout`, and React Native's JS timers stand still while the app is in
the background — the promise never settled, and the handler's own 4.5 s timeout is a JS timer
too. Fix:
- `tv-native/android/app/src/main/java/com/auroratv/RemoteModule.kt` — `wake()` now waits
  natively (main looper, polling the window focus every 100 ms for up to 1.5 s) and answers
  whether Aurora is in front.
- `tv-native/src/remote/open.ts` — `bringAuroraForward()` uses that answer (no JS wait for the
  wake); the bring-to-front path is unchanged.
- `tv-native/src/remote/native.ts` (doc line), `tv-native/__tests__/logic/play-on-tv.test.ts`
  (the mock answers like the native side).
Verified on the Mi TV with QA 212: the sender reads "Aurora is in the background on the TV — open
it there" at once; reopening Aurora later starts nothing. The phone app does not run this code
(the phone is never a target): no phone rebuild needed.

# TV 5.9.0 / phone 1.1.0: the device checks the release pass left (2026-11-09)

Devices: Mi TV with QA TV 5.9.0 build 212 (`192.168.50.31:5555`), emulator-5554 (Pixel 9, Android 17)
with QA phone 1.1.0 builds 64 (= the published 1.1.0 code), then 65/66 (this branch's fixes). Both pointed only
at a private server (scripts/ui-test-server.js, master 1.15.22) through `adb reverse tcp:4000`.
Second phone: real Chrome at 390x844 / 360x740 on the same private server. Profiles: QA Alpha (TV), QA Beta
(emulator), QA Gamma (Chrome), QA Kid (kids, 12+). Library titles were given seeded age ratings:
ALL: Test Film One, Family Trip · 7+: Space Kids, Test Show · 12+: Teen Quest · 16+: Dark Alley ·
18+: Test Film Two, Night Terror, Brutal City.

| # | Check | Result | Shots |
|---|-------|--------|-------|
| 1 | Pick together, TV + 2 phones | PASS | tv-01…08, ph-01…06, web-01…06, c1-tv-back-asks |
| 2 | Kids limit in Pick together | PASS | k-* |
| 3 | Phone app at 360 dp | PASS after 2 fixes (cut settings notes; lobby opened mid-page) | s-* |
| 4 | Airplane mode during a swipe | PASS (the line has to be cut at the adb tunnel too, see below) | a-* |
| 5 | Save & watch with a real download | PASS after 1 fix (a page opened from a link stayed on Save & watch) | d-* |
| 6 | TV screensaver wake for Play on TV | SKIPPED: can't be forced from adb without changing stay-awake; for elia by hand | — |

## 1. Pick together with two phones and the TV — PASS
- TV (QA Alpha): AI → Pick together → tutorial → Films · Anything · Any length · 3 min → Start: code JGZP and a QR.
- Emulator (QA Beta, phone app): profile menu → Pick together → typed JGZP → joined (tutorial after). Chrome
  (QA Gamma) opened #/group/JGZP → joined. The TV lobby listed both.
- TV "Start swiping": 8 cards. Emulator swiped with real finger drags (yes/no in turn); Chrome used drags
  and the Yes button. The TV counted "1 of 2 done" → result "Brutal City · Both of you said yes" on the TV,
  the phone app and Chrome.
- Phone app "Play on the TV" → the TV left the result and played Brutal City (first frame ~1.1 s); the phone
  read "Enjoy the film · QA Beta pressed Play · Starting on the TV".
- Back on the TV during a round → "Leave this session? · Stay / Leave / End for everyone". Stay kept the round.

## 2. Kids limit — PASS
TV started Films and series; QA Beta (phone app) and QA Kid (Chrome) joined. Both decks: Family Trip, Teen
Quest, Space Kids, Test Show, Test Film One — nothing above 12+ (the four 16+/18+ titles never showed).
Result "Space Kids · 1 of 5". Through the API with a third member: searching "night" in the room found
nothing; adding Night Terror (18+) → 403 "Not for everyone's age in this group".

## 3. Phone app at 360 dp (`wm density 480` → sw360dp; reset after) — PASS after fixes
- Fine: Home + tab bar, More sheet (all rows), profile menu, Pick together entry / start form / card,
  title page with "Play on Xiaomi TV Box" and its sheet.
- FIXED: Settings → "Tidy up after watching" and "Space limit" notes were cut with "…" (ListRow clamped
  notes to 3 lines). s-18/s-19 before, s-21 after.
- FIXED: pressing Start at the foot of the Pick together form opened the lobby still scrolled down, the room
  code off-screen (s-08). Now each new step opens at its top (s-23), as the website already does.

## 4. Airplane mode during a swipe — PASS
- Airplane mode alone does NOT cut the app off from a QA server: `adb reverse` runs over adb, not the
  network, and kept answering (a-01). To cut the line I also stopped a TCP pipe the reverse went through.
- Line cut: the swiped card came back on top, "Couldn't reach Aurora — try again." under it, Undo stayed
  off (a-07). Line back + airplane off: the next swipe went through, the message cleared (a-08).
- Seen once: the very first swipe after the cut showed the card back but no message for ~4 s (a-03); later
  swipes showed it at once. Likely the first request's connect wait.

## 5. Save & watch with a real download — PASS after fix
Private server with tools/dl-rig/swarm.js: one self-seeded local torrent (random bytes behind a 25-min
black MKV header, 260 MB, 1.3 MB/s), a seeded catalogue entry "Rig Harbor" (tt9700001) whose only source
is that torrent. Real aria2 download each time.
- Title page (opened with the link https://nufurora.com/#/discover/movie/tt9700001): Save & watch → button
  "Saving N%" and the line "Downloading · best source · N%" (d-02, d-03). Website at the same moment:
  "Downloading · 32%" (d-web-01).
- Landed: the toast "“Rig Harbor” is ready to watch" (d-04).
- FIXED: at the same moment the page went BACK to "Save & watch · Not on disk yet" and stayed there, and a
  fresh open of the same link also said Save & watch for a film on the server (d-04, d-06). A page opened
  from a link has no title, and the library match was by title only. Now it matches the IMDb id first and
  re-reads the library after a landing: second real download → the page turned to Play / "On disk" with
  the toast (d-10, d-11); the link opens on Play (d-07).

## For elia
- Wording differs on a download in progress: website button "Downloading · N%", phone button "Saving N%"
  plus a line "Downloading · best source · N%" (the TV uses the same shared dlText "SAVING n%"). Pick one?
- The phone's Pick together lobby says "Scan the code with your phone…" but shows no QR (the website and the
  TV do).
- Pick together has an entry on the AI page of the TV and of the website (pickforme.js), but the phone
  app's AI page has none: on the phone it is only in the profile menu.
- Long TV names get "…" under the round button on a title page ("Play on Xiaomi TV B…", d-10).
- The emulator has an orphan Android DownloadManager entry "Test Film One — Saving to this phone" stuck at
  2 % from the earlier QA pass (a save made against the previous private server); the app no longer lists
  it. Harmless; clear it by hand if it bothers you.
- Check 6 (screensaver → Play on TV wakes the TV) by hand on the Mi TV.

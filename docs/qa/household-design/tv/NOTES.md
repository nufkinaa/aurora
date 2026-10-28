# Household recommendations — TV design pass (Mi TV, 2026-10-28)

All photos are `adb exec-out screencap` from the Mi TV (1920×1080, 960 dp canvas) on a QA build
against a private instance: 14 profiles (photo, emoji and letter avatars; "Maximiliana
Rosenthal"; the Hebrew "נועם בן-דוד"; a kids profile; one with recommendations off), 19
recommended titles (one from 11 people, one from 3, one from a long + a Hebrew name, a 140-character
note, a Hebrew note, a Hebrew-titled film, a long title, white / black / yellow posters).
`before/` = the shipped 5.7.1 code (vc178), the rest = this branch (last build vc187).

| # | State | Before | After |
|---|---|---|---|
| 00 | Placement | under Recommended for You (default order) | the same, and now also for a person whose Home order was saved before 1.13.0 (it went to the foot) |
| 01–02 | Row cards | "From" wrapped anywhere ("From" / "Maximiliana R…", a Hebrew name split over two lines), titles at three heights, grey words unreadable on white/yellow posters, Hebrew title hung at the right | title + "From Dana" / "and 10 others", one line each, every title at one height, household violet, frame shade under the words, everything left to right |
| 03 | Show all tile | grey failed-poster tile | card-sized violet tile, arrow in a ring, same focus and lift |
| 04–06 | Show all page | person filter wrapped to 2–3 lines (one grid row left) | one scrolling line with fading edges; a pressed chip keeps focus; UP from the grid returns to it |
| 07 | You sent | 116 dp rows, one grey line of statuses, no note | compact rows, the note in italics, per-person status pills in the state's colour |
| 08–09 | Hold-OK sheet | Hebrew note laid out right to left ("name — ”note“") | reads “note” — name |
| 10, 14 | Title page | "Recommended by Maximiliana Rosent…" cut, notes in a third of the width | who + Not for me on one line, notes under it with a violet rule (two at most) |
| 11–13 | Picker | with 14 people Send / Cancel were below the sheet's edge; a greyed face's ring dimmed; ✓ cut by the circle; note field had no focus edge | note + Send / Cancel fixed under the scrolling faces, six faces a line, full ring on greyed faces, ✓ badge, white focus edge on the note |
| 15 | Settings | DOWN from the switch landed mid second line; "Mute · נועם" | DOWN lands on the first chip; "נועם · Mute"; mute chips only while On (as the website) |
| 16 | Arrival toast | "recommended Dune נועם" | "נועם recommended Dune" |
| 17 | Kids | household row first (no Recommended row) | unchanged — correct |
| 18–19 | 4K-dp (`wm density 160`) and 16:10 (`wm size 1728x1080`) | — | same layout, nothing clipped (reset after) |
| 20–21 | Closed sign-in mode | — | posters and avatar photos load |

## Perf (Mi TV, Home, the household row: hold RIGHT 3 s to the end, hold LEFT 3 s back; 5 cold runs each)

| Build | janky % (mean) | frames > 32 ms (of ~270) | p90 | p99 |
|---|---|---|---|---|
| master TV code, QA vc183/185 | 2.83 | 18.8 | 28–32 | 46–61 |
| first design build (shadowed From lines), vc184/186 | 3.36 | 22.4–23.6 | 30–34 | 48–65 |
| final (no text shadow on the From lines, light Show all tile), vc187 | **1.39** | **12.4** | 26–30 | 40–46 |

The text shadow on the two violet lines was what cost (a blurred shadow is drawn again every frame
a shelf moves); the lines sit on the frame shade's dark foot and read without it.

## 1.14.0 skip intro / Up next — Mi TV checks (merged master, QA vc187, private instance with copies of the house's Avatar files)

| # | Check | Result |
|---|---|---|
| 1 | Seven Havens E6: Skip intro at 2:13, OK lands ≈2:43 | PASS — server 133.25→163.07; button on screen at 2:13, OK → 2:43–2:44 |
| 2 | Just-landed episode: button at the intro start, `/api/intro/auto` asked ≤ 15 times | PASS — 5–6 asks (stopped once `pending` went), button from 0:02. Finding: a byte-identical copy of a file got intro end 57.47 instead of 47.36 (button stays ~10 s into the episode) |
| 3 | ATLA E4: no Skip recap at 0:58; Skip intro 0:02→0:47 | PASS — button 0:02 to 0:46/47, no recap in the first 62 s |
| 4 | ATLA E4: Up next at 22:19 (Written by card), not in the last scene | PASS — card shows 22:19 (server 1339.0), the last scene had none |
| 5 | Post-credits scene: Up next with no countdown, next episode at the file's end | PASS — test file = E5 + 45 s of scene after the end theme (`scene: true`); "Play now · Dismiss" with no number, E8 started at the end |
| 6 | Button within ~0.1 s of the intro | PASS — screen recording at 30 fps: the button is on the intro's first frame (≤ 33 ms) |
| 7 | Sign-in-required mode: button appears | PASS — closed mode, TV paired by code: Skip intro from 0:02 |

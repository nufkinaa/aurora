# My List only adds; cinema copies are never the pick (branch fix-mylist-cam: 2fd0345, c58a602)

## My List auto-download removed (server, website, TV)
Watchlist route starts nothing; src/media/mylistdl.js cut to leftovers handling; dlslots.js: people first, then automatic, 3 per account kept; downloads.js: on-hold/startNow/stalledRestarts/auto/held removed (leftover holds cleared on start); "Start now" route removed; toasts are just "Added to My List"; Downloads screens drop MY LIST / On hold; admin card is "Left from My List downloads" until nothing is left.
Copies it already fetched keep their 14-day stale / 21-day delete tidy-up; never deletes a hand-downloaded, watched or admin-kept file; queued jobs run as ordinary automatic downloads.

## Ranking and release status
src/media/releasekind.js markers — pre-release: CAM, HDCAM, HQCAM, CAMRip, TS, HDTS, TELESYNC, PreDVD, TC, HDTC, TELECINE, SCR, DVDSCR, BDSCR, SCREENER, HC; burned-in: HC, HARDSUB(S), hardsubbed, hardcoded, KORSUB(S), Hard Sub, KOR SUB. Short markers only in capitals after the year (no false hits on "Cam (2018)", "TS Eliot", Camille, Scream, DTS, .ts, TCM, Hardcore).
torrent.js: clean → burned-in → pre-release; STREAMS_V 5→6; ★ Best never pre-release or dub; cinema-only lists have no ★. smartdl, follows, dlrace, web Save & watch, episode press and TV pickBest never take a pre-release copy; pressing one asks "This is not the real release / Download it anyway / Play it anyway".
src/media/releasestatus.js (+ TMDB dates from availability.js): "Not out in good quality yet — only cinema recordings so far" / "…only early copies so far" / "Not out to watch at home yet", plus a dates line. Web: replaces Save & watch. TV: under the button, which reads "≡ Sources".

Tests: root npm test 1922 ×2; whole test:ui 367 ×2; touched UI files 3×; new releasekind (11) + release UI (9); TV jest 685 + release-words; tsc clean. Screenshots in this folder.
Not verified: Mi TV; real Torrentio names (synthetic); real TMDB dates; live data/mylistdl.json leftovers.

## Mi TV checks (QA variant)
1. Add to My List from the title page, X-Ray person sheet and long-press sheet: toast "Added to My List" (person sheet "<Title>: Added to My List"); nothing in Downloads.
2. Film with only CAM/TS: yellow "Not out in good quality yet — only cinema recordings so far" + dates line; button "≡ Sources"; OK opens the list, no download.
3. Rows show CAM/TS badge + yellow warning; OK on a row and on Stream open "This is not the real release"; Cancel returns focus to the row; Download/Play anyway proceed; focus stays in the sheet.
4. Good copies + a CAM: Play takes ★ Best; CAM last; KORSUB row shows "BURNED-IN SUBS" / "Subtitles burned into the picture".
5. Episode with only early copies: toast "No good copy of this episode yet — pick one from its sources"; nothing downloads.
6. Downloads: no "From My List" / "On hold".
7. All of it once in closed mode.

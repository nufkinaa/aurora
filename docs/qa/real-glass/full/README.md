# Real glass, everywhere: the nav's own glass (2026-11-20, second pass)

elia, on the calm sweep (1.15.39): "don't let it keep the old look, it should look like the nav and the rest of the btns". So every glass surface now takes the nav's FULL values, not the calm ones, on the website and in the phone app. The TV app is not touched.

## What changed, per surface (website)

| surface | today (1.15.39, calm) | now |
|---|---|---|
| top bar, tab bar, round top buttons, logo/profile pills, hero and title glass buttons, the player's chrome | full real glass | unchanged |
| episode cards, source rows, Downloads rows, taste tiles, party strip | calm split + calm rim, calm body | the nav's split (`--rg-split`), rim (`--rg-rim`), body (`--rg-body`), the Fresnel ring with its glint, a tight contact shadow (rows keep no drop shadow) |
| the Calendar's list rows (`.cal-entry`) | a faint white box (not glass) | a glass row, as above |
| the Calendar's month: days with a release / today / plain days | calm split, calm foot | the nav's split and rim / split + lit foot / a lit foot |
| the Calendar's day pane, Next up, arrows | calm | the nav's split, rim, body and ring (arrows: the round button's split and glint) |
| the search field | calm, 72 % body | the nav's glass, 75 % body (see Words); a live lens from tablet width up |
| suggestions, menus, drop-downs, sheets, dialogs, peek, toasts, the sign-in card, the party panel | calm | the nav's split, rim, body, ring and glint, the contact shadow with violet light below |
| chips, category pills, filters, pickers, the hero's tag, the trailing season pills | calm thin edge | the nav's split, rim and ring |
| an episode's side buttons (desktop, tablet), the Calendar's arrows, round icon buttons in the page | calm thin edge | the round button's stronger split (`--rg-split-s`), its glint (`--rg-arc-s`) |
| Settings panes, pair cards, callouts, the rating pane, What's new cards, the trailer box, hero picks, glass buttons in the page | calm | the nav's glass, with the ring |
| the phone's side menu (More) | its own opaque TV panel with a feather | the nav's glass, drawn over its own solid body (TV hues kept, the nav's body over them), rounded far corners, the split/rim/glint/contact shadow down its open side; the chosen place and your profile are small glass pills; no backdrop filter (see Speed) |
| the Remote screen | a white sheen from the top, the thick pane's edge | the nav's body (no light from the top), the full edge, the ring and glint on every pane (round ones: the round glint) |
| a season's segments inside its island, genres written as plain outlined words, a quiet toast, on a phone "your rating" and the action tiles under a title | not glass panes | unchanged (no ring) |

The ring is the nav's `::before` (`::after` on a Downloads row and the Remote's touchpad, whose `::before` is taken). A pane that was not placed gets `position: relative` at zero weight (`:where`), so a pane that is fixed, absolute or sticky stays so; the Calendar's day pane below 1100 px is placed with `top: auto` (it is static there and carried a sticky offset).

## The live lens

| surface | lens | measured (processor time in 8 s, median; today / new without the lens / new with it) |
|---|---|---|
| the search field, desktop and tablet | **yes** | search page, field focused, suggestions up: 1426 / 1451 / 1437 ms (8 runs each; ranges 1343–1453 / 1340–1478 / 1403–1536: inside run-to-run noise) |
| the search field, phone | no | 386 / 393 / 406 ms (6 runs; 378–396 against 404–406: the runs do not overlap, +3.3 %) |
| the phone's side menu (More), open | no | at rest: 773 / 780 / 1170 ms (+50 %) |
| a sheet (confirm sheet), open | no | desktop: 1718 / 1695 / 1810 ms (+6.8 %, the runs do not overlap) — and under its 79 % body the bend hardly shows |
| the profile menu | no | its wrapper blurs the page and is its backdrop root, so its own backdrop is a flat colour: a lens there would bend nothing |
| episode cards, rows, Calendar days, chips | never | (by rule) |

## Speed

Desktop 1440 × 900, processor time of the page's processes in 8 s (`tools/real-glass/player-cost.js`, sides taking turns, a browser of its own each run; `perf/` in the scratch). x = this branch without the second pass's lenses.

| | today | new | |
|---|---:|---:|---|
| Home at rest, hero in view (8 runs) | 1631 (1580–1678) | 1583 (1551–1675); x 1636 | as today |
| Home at rest, scrolled (8 runs) | 1552 (1526–1621) | 1589 (1551–1663); x 1636 | +2.4 % (x, the same CSS on Home: +5.4 %): inside the runs' spread |
| Search, field focused (8 runs) | 1426 | 1437 | as today |
| A sheet open (6 runs) | 1718 | 1695 (no lens) | as today |

Phone 390 × 844, CPU × 4 (`tools/glass-options/perf.js`, 6 runs): scroll mean / p95 / p99 17.7 / 18.1 / 18.5 ms on both sides, no late frame on either, at rest the same. Opening the More menu (`tools/real-glass/more-open.js`, its first 700 ms, 16 runs): median worst frame and late frames the same as today in both batches (36 ms and 1; 53 ms and 1 in a busier batch). Measured on the way: with a backdrop filter on the panel (any frost, with or without the lens) a late frame came in 5 of 16 openings against 1 of 16 today; drawn over its own body with no masked ring, in 0 of 16 — which is what it now is.

Phone app (Pixel 9 emulator, software GPU): see `app-timings.txt` — no regression against the branch it started from.

## Words

`tools/glass-options/contrast.js` (the dimmest 1 % behind each word over a white poster, a bright poster, mid grey, white text, the bright sky band, black) and `tools/glass-apple/remote-contrast.js`. Lowest per surface, today → new:

| surface | today | new |
|---|---:|---:|
| Settings panes, desktop / phone | 7.0 / 5.1 | 10.5 / 5.5 |
| Episodes, desktop / phone | 9.6 / 4.0 | 9.8 / 4.1 |
| Downloads rows, desktop / phone | 5.2 / 2.9 | 5.6 / 3.0 |
| Search suggestions, desktop | 4.8 (3.9 in a second run) | 4.5 (4.1 in a second run) |
| Search field and suggestions, phone | 3.0 | 3.0 |
| Chips, desktop / phone | 7.8 / 4.0 | 5.9 / 4.0 |
| Profile menu, desktop and phone | 10.3 | 9.7 |
| Confirm sheet, peek, toast | 9.9, 9.5, 6.0 | 9.9, 9.5, 6.0 |
| the side menu (More), lowest word that shows | 10.1 | 8.3 ("Glass" on its profile pill) |
| the Remote's panes | 6.08 | 6.26 (0 of 46 under 4.5 on both) |
| the bars, tab bar, title buttons | as before | as before |

Tuned for words: a phone's in-page panes 72 % full for 70 % (episode words over the bright band went 4.0 → 3.9 at 70 %; 4.1 now), and the search field's body 75 % for 72 % (its mic went 4.0 → 3.9; 4.1 now). Every cell under 4.5:1 is under it today too, by as much or more: the quiet grey labels and the violet "Finished" on a phone over a sky painted as one bright band, the Calendar's grey and chosen words (2.4–3.3 on both). The More menu's table row reads 3.9 for "Children mode": that row is below the list's fold, hidden; the cell is what lies behind its box (the profile pill), not a word anyone sees.

## Nothing moved

`tools/real-glass/layout-same.js`, now on 15 screens (Home, a film, a show, a discovered film, Downloads, the player, Settings, Movies, the Calendar's month and list, What's new, search with suggestions, the profile menu, a sheet, and on phones the side menu) at six widths: 86 cases, 0 elements moved, every ring its own pane's size.

## Sheets

Today on the left or above, at real size first, then enlarged. 01–21 are the private test server (`tools/real-glass/full/sheets.py`; the Calendar and Downloads on the QA server of `tools/real-glass-app/qa-server.js`, reached through `GA_INSTANCE`), 22–23 the Remote with a simulated TV, `app-*` the phone app on the Pixel 9 emulator (`tools/real-glass-app/full-sheets.py`).

## The phone app

The same in `tv-native/src/phone`: full `RG_*` values in place of `RG_CALM_*` on every glass component, the Remote, text fields, sheets, rows, cards, chips and the Calendar included. Rows keep the border-colour technique of 500104c7 (no shadows on rows), at full strength (`RG_LINES`: a dim top 0.05, the split at 0.36, the foot in the Fresnel's foot colour at 0.45). Single panes (the search field, the profile menu, toasts, sheets, Settings panes, the Remote's buttons) wear `RG_RINGED` + `GlassRim`. Android's TextInput paints one border colour on all four sides, so text fields draw the split and the foot as inset lines over one even border (`RG_FIELD`). A sheet stands on the screen's foot, so it has no lit foot. Contrast on device photos: 11.1–17.1:1, equal to or above today. 824 nodes on 18 screens: nothing moved. The tab bar stays dark.

# Native Row, hero art + column, rail panel vs their JS twins — 2026-10-10 (P3 + P4 + P5)

Mi TV MiTV-AFMU0 (Android 14, 1920x1080 @ 320 dpi, 59.94 Hz), `com.auroratv.lab` v9000, local server, profile Claude QA, `freeze on`.
A = everything JS. B = `focusable, card, row, hero, rail = native` (`--impl FCRHN`), grid JS.
Rule (diff.py, unchanged): pixelmatch YIQ 0.1; any differing px off an edge fails; on-edge <= 0.05 %. Trace rule (trace.py, unchanged): curves in time +-25 ms, same rest value, settle within 50 ms.

## Result in one paragraph

Every state that both implementations reach deterministically is **0 differing px**: Row 18/18, hero + column 12/12 (a 13th is the known JS burst quirk), rail 20/20 pictures, Focusable 14/14, Card 11/11, whole-app paths 12/15 (the other three are not deterministic js-against-js either, or are a race inside a screen — shown below). The blended frames nobody could capture before — the hero's cross-fade and scroll fade, and the rail's slide, each held half way with the new `freeze on,mid` — are 0 px too. What fails is listed under "What still fails"; none of it is a picture or a rest value of a native component.

## Bug found on the device and fixed

| component | what was wrong | fix |
|---|---|---|
| column (H) | **The page did not slide at all** (not only for the second row): `AuroraSlideColumn` held no `targets`. `NativeColumn` registered its `setTargets` api in a passive effect; on the box the first `onLayout` events of the column and its rows reached JS before that effect ran, found `api.current == null`, and nothing asked again. Targets only arrived when a later layout happened (a shelf mounting after the 2nd DOWN) — after focus had already landed. Logged on the device: `rcf marker=0 to=NaN targets=` three times, then `setTargets -329, -521.5, ...`. | `Home.tsx` `NativeColumn`: the api is registered in `useLayoutEffect` and followed by one `onReady()` (= Home's `syncTargets`), so the targets measured so far are committed as soon as the column exists. No native change. |

Nothing else in R, H or N needed a code change: the authors' device-check lists (the nativeID / collapsable markers are real host views; `requestChildFocus` reaches the row and the column; the Fresco pictures, the 8-bit alpha truncation, the SVG / CSS gradients, the glow matrices; the slide-end event; the instant close) all hold — see the 0 px rows.

## Per state

`focus` = the [focus] gain tables agree (only where the state asks for it). Folders: `FCRHN/` is the main run (it has no `summary.md` of its own: adb hung at state 59 and killed the runner — every `result.json` up to there is filed; the rest was run as `FCRHN-part2/`), `-part3` = `row/offset-9` again after an adb "error: closed", `-part4` = two states re-run x3.

| component | state | run | differing px | off-edge px | max Δ | trace | focus | result |
|---|---|---|---|---|---|---|---|---|
| row | offset-0 | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| row | offset-1 | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| row | lead | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| row | offset-5 | FCRHN | 0 | 0 | 1 | ok | ok | PASS |
| row | offset-9 | FCRHN | -1 | -1 | -1 | - | - | FAIL |
| row | offset-9 | FCRHN-part3 | 0 | 0 | 1 | - | ok | PASS |
| row | offset-10 | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| row | back-left | FCRHN | 0 | 0 | 1 | ok | ok | PASS |
| row | hold-right-12 | FCRHN | 0 | 0 | 0 | ok (rest only) | ok | PASS |
| row | hold-right-end | FCRHN | 0 | 0 | 0 | ok (rest only) | ok | PASS |
| row | hold-right-left | FCRHN | 0 | 0 | 0 | ok (rest only) | ok | PASS |
| row | reentry-down | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| row | reentry-up | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| row | left-at-0 | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| row | left-at-0-return | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| row | poster-row1-step | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| row | continue-rest | FCRHN | 0 | 0 | 1 | ok | ok | PASS |
| row | continue-step | FCRHN | 0 | 0 | 1 | ok | ok | PASS |
| row | continue-step-2 | FCRHN | 0 | 0 | 1 | ok | ok | PASS |
| hero | rest | FCRHN | 0 | 0 | 0 | - | - | PASS |
| hero | scrolled | FCRHN | 0 | 0 | 1 | ok | ok | PASS |
| hero | scrolled-back | FCRHN | 0 | 0 | 0 | ok | - | PASS |
| hero | first-slide | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| hero | details-lit | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| hero | scrolled-row1 | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| hero | scrolled-row3 | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| hero | down-burst-4 | FCRHN | 434553 | 258503 | 255 | FAIL (rest only) | ok | FAIL |
| hero | back-from-row1 | FCRHN | 0 | 0 | 0 | ok | ok | PASS |
| hero | slide-then-scrolled | FCRHN | 0 | 0 | 0 | ok | - | PASS |
| hero | slide-scrolled-back | FCRHN | 0 | 0 | 0 | ok | - | PASS |
| hero | mid-fade-row0 | FCRHN | 0 | 0 | 1 | ok | - | PASS |
| hero | mid-fade-row1 | FCRHN | 0 | 0 | 0 | ok | - | PASS |
| hero | mute-pill | - | - | - | - | - | - | SKIP |
| navrail | closed | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | open | FCRHN | 0 | 0 | 0 | FAIL | ok | FAIL |
| navrail | item-search | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | item-home | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | item-movies | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | item-shows | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | item-list | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | item-ai | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | item-settings | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | item-profile | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | item-profile-wrap | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | closed-again | FCRHN | 0 | 0 | 0 | FAIL | ok | FAIL |
| navrail | mid-open | FCRHN | 0 | 0 | 0 | FAIL | - | FAIL |
| navrail | closed-back | FCRHN | 0 | 0 | 0 | FAIL | ok | FAIL |
| navrail | open-from-row | FCRHN | 0 | 0 | 0 | FAIL | ok | FAIL |
| navrail | row-closed-again | FCRHN | 0 | 0 | 1 | FAIL | ok | FAIL |
| navrail | row-closed-back | FCRHN | 0 | 0 | 1 | FAIL | ok | FAIL |
| navrail | ok-movies | FCRHN | 0 | 0 | 0 | - | - | PASS |
| navrail | ok-home | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| navrail | reopen | FCRHN | 0 | 0 | 0 | FAIL | ok | FAIL |
| app | home-down-6 | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| app | home-down-4-up-2 | FCRHN | 0 | 0 | 1 | - | ok | PASS |
| app | home-down-hold-8 | FCRHN | 809748 | 593162 | 255 | - | FAIL | FAIL |
| app | home-row-hold | FCRHN | 0 | 0 | 1 | - | ok | PASS |
| app | home-row-then-down | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| app | home-open-title | FCRHN | 0 | 0 | 0 | - | ok | PASS |
| app | home-title-back | FCRHN | 0 | 0 | 1 | - | ok | PASS |
| app | rail-to-shows | FCRHN-part2 | 0 | 0 | 0 | - | ok | PASS |
| app | rail-to-settings | FCRHN-part2 | 33027 | 7380 | 230 | - | FAIL | FAIL |
| app | movies-grid-walk | FCRHN-part2 | 0 | 0 | 0 | - | ok | PASS |
| app | movies-grid-hold | FCRHN-part2 | 71179 | 2824 | 215 | - | ok | FAIL |
| app | movies-open-title | FCRHN-part2 | -1 | -1 | -1 | - | - | FAIL |
| app | movies-open-title | FCRHN-part4/run1 | 0 | 0 | 0 | - | ok | PASS |
| app | movies-open-title | FCRHN-part4/run2 | 0 | 0 | 0 | - | ok | PASS |
| app | movies-open-title | FCRHN-part4/run3 | 0 | 0 | 0 | - | ok | PASS |
| app | movies-title-back | FCRHN-part2 | 0 | 0 | 0 | - | ok | PASS |
| app | movies-rail-open | FCRHN-part2 | 0 | 0 | 0 | - | ok | PASS |
| app | movies-rail-home | FCRHN-part2 | 0 | 0 | 0 | - | ok | PASS |
| focusable | card-rest | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| focusable | card-lit | FCRHN-part2 | 0 | 0 | 1 | ok | - | PASS |
| focusable | btn-primary-lit | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| focusable | btn-primary-rest | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| focusable | btn-secondary-lit | FCRHN-part2 | 0 | 0 | 0 | ok | - | PASS |
| focusable | btn-secondary-rest | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| focusable | chip-on-lit | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| focusable | chip-lit | FCRHN-part2 | 0 | 0 | 0 | ok | - | PASS |
| focusable | chip-rest | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| focusable | chip-surface-lit | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| focusable | navitem-lit | FCRHN-part2 | 0 | 0 | 0 | ok | - | PASS |
| focusable | navitem-lit-2 | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| focusable | sources-row-lit | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| focusable | sources-row-lit-2 | FCRHN-part2 | 0 | 0 | 0 | ok | - | PASS |
| card | rest-home | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| card | size-frame | FCRHN-part2 | 0 | 0 | 1 | FAIL | - | FAIL |
| card | size-frame | FCRHN-part4/run1 | 0 | 0 | 1 | ok | - | PASS |
| card | size-frame | FCRHN-part4/run2 | 0 | 0 | 1 | ok | - | PASS |
| card | size-frame | FCRHN-part4/run3 | 0 | 0 | 1 | ok | - | PASS |
| card | progress-bar | FCRHN-part2 | 0 | 0 | 1 | - | - | PASS |
| card | size-frame-episode | FCRHN-part2 | 0 | 0 | 1 | - | - | PASS |
| card | size-poster | FCRHN-part2 | 0 | 0 | 0 | ok | - | PASS |
| card | kind-tag | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| card | size-poster-row2 | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| card | grid-rest | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| card | grid-lit | FCRHN-part2 | 0 | 0 | 0 | ok | - | PASS |
| card | new-tag | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| card | new-tag-rest | FCRHN-part2 | 0 | 0 | 0 | - | - | PASS |
| card | size-wide | - | - | - | - | - | - | SKIP |
| card | size-compact | - | - | - | - | - | - | SKIP |
| card | blur-up | - | - | - | - | - | - | SKIP |
| card | broken-tile | - | - | - | - | - | - | SKIP |

max Δ 1 = the lift-shadow halo of a lit Continue Watching card, 1/255, both variants produced by both implementations (P1P2 summary, "Below the threshold").

## What still fails, and why

1. **`navrail/*` traces (8 states, all 0 px)** — `open`, `mid-open`, `open-from-row`, `reopen`, `closed-again`, `closed-back`, `row-closed-again`, `row-closed-back`. The curve rule fails on the JS run's TIME STAMPS. The JS `[anim]` lines are stamped when they arrive at the native module; opening mounts the panel and closing re-renders it (`closing` makes the items unfocusable), so the JS run's lines arrive in a clump (e.g. `closed-again` A: 1.0 at +45 ms, then 0.788, 0.582, 0.415, 0.296, 0.214 all between +184 and +189 ms) while the native run's are frame-stamped (+28, +44, +61, +78 ...). Not loosened, not masked. What can be checked without those stamps (`tools/tv-pixel-diff/frame_table_check.py` — a report, not a pass rule): every value both sides log is a frame of RN's own table for this timing, walked in order between the same ends, and the slide ends at the same time after the key when closing; when opening, the native slide ends 45-65 ms sooner after the key (it starts sooner — input latency, which the rule does not judge).

| state | A from->to | B from->to | all values on RN's frame table (A / B) | key -> last step ms (A / B) |
|---|---|---|---|---|
| closed-again | 1->0 | 1->0 | yes / yes | 310.0 / 319.7 |
| closed-back | 1->0 | 1->0 | yes / yes | 305.0 / 313.6 |
| mid-open | 0->0.5 | 0->0.5 | yes / yes | 372.0 / 328.3 |
| open-from-row | 0->1 | 0->1 | yes / yes | 401.0 / 334.1 |
| open | 0->1 | 0->1 | yes / yes | 376.0 / 332.7 |
| reopen | 0->1 | 0->1 | yes / yes | 366.0 / 309.6 |
| row-closed-again | 1->0 | 1->0 | yes / yes | 296.0 / 315.0 |
| row-closed-back | 1->0 | 1->0 | yes / yes | 312.0 / 308.9 |

2. **`hero/down-burst-4`, `app/home-down-hold-8`** — the known JS quirk, not fixed in the reference: after a DOWN burst the JS column clamps to the column height it knew AT the press (`Home.tsx toRow`), the native one to the targets committed at the press; and how many shelves are mounted when the next press lands decides whether that press moves focus at all. Seen both ways round: A -751 / B -989.5 in one run, A -989.5 / B -998.5 (the 9 dp) in the main run; in `home-down-hold-8` A made 7 moves and B 8. js against js fails the same state 1 of 2 (`js-vs-js-bursts/`). Stepped one press at a time the two are identical: `hero/scrolled-row3`, `app/home-down-6`, `app/home-down-4-up-2` = 0 px.
3. **`app/movies-grid-hold`** — a DOWN x10 / UP x4 burst in the Movies grid (the grid is JS on both sides): js against js fails it 2 of 2 (`js-vs-js-bursts/`); the FlatList rests a few px apart depending on the press gaps. Not a native difference; `movies-grid-walk` (single presses) = 0 px.
4. **`app/rail-to-settings`** — B landed on the "Action" genre chip in 3 of 5 takes, A on "What's new" in 5 of 5 (`FCRHN-rail-to-settings-x3/`; with only focusable and/or rail native, 4 of 4 manual takes landed on "What's new"). Settings has no preferred focus: Android gives focus to the first focusable that exists when the screen comes in, and the genre chips appear when the genres request answers. With everything native the screen and that answer meet in a different order more often. A race in the Settings screen itself; nothing in R/H/N decides where focus goes. Listed as a behaviour difference.
5. **`card/size-frame` trace (1 of 4 takes)**, 0 px: the same arrival-stamp artefact on the first DOWN from the hero (the JS run mounts the scrolled layer and more shelves on that press). 3/3 on the re-run.
6. **Harness errors** (not app results): `row/offset-9` ("adb: error: closed") -> 0 px on the re-run; `app/movies-open-title` (`nav` timeout) -> 0 px x3. `adb.py` now reconnects and retries a dropped call once.

## Not checked

- **The trailer layer order** (`hero/mute-pill`): home trailers are off in this profile's Settings and the fixture HLS is not served by the local server; neither was changed, so it was not checked.
- `card/size-wide`, `size-compact`, `blur-up`, `broken-tile`: need the fixture instance / server flags, as in P1P2.

## By eye (unfrozen, screenrecord frames, JS and native)

- Rotation: the new picture fades in over the same span in both (first to last changed frame 361 ms JS / 362 ms native: the picture's fade plus the lockup's 280 ms swap); no pop, no black frame.
- Rail hues: both glows drift in the open panel in both; the change over time is the same size (mean abs difference from the first frame 1.43 / 2.53 JS, 1.45 / 2.52 native at +1 s / +2 s).

## Behaviour by remote, everything native vs all JS (`states/app.json`, `row.json`, `navrail.json`, `hero.json`)

Same picture and same focus path: Home rows down/up one press at a time (6 shelves), row out-and-back bursts (12 / 24 / 12+8 / 15+6 presses), the row's far end, re-entry into a row from above and below (last-focused card, no slide), LEFT at card 0 -> rail (also after returning to card 0), the hero buttons and the slide turn, the rail open / every item / closed by RIGHT and by BACK from the hero and from a card (focus back on the element that had it), OK on the current section, OK on Movies / Shows (instant close, the grid shown), a Movies grid walk, a title opened from Home and from the grid and BACK (focus on the same card, the page where it was), rail -> Home from Movies.

Differences found:
1. DOWN bursts on Home: rest offset / number of moves differ run to run (item 2 above) — the JS quirk; either side can be the short one.
2. Settings' first focus (item 4) — a race in the screen, tipped by timing.
3. Focus LOG order only: the native Focusable logs "gain, then loss 30 ms later" when the gaining element is still being mounted (the rail item on open), the JS one "loss, gain". The same with the JS rail; what is on screen is the same.
4. Input latency: the native row / column / rail start sooner after the key (rail open ends 45-65 ms sooner). By design.
5. Found while testing, in BOTH implementations (not a native difference): UP from the first shelf onto the hero sometimes opens the nav rail. Under `adb input keyevent` only the key-UP reaches Home's key handler, and it races the hero button's focus event; when the focus event wins, the handler sees "UP on a hero button". js against js: 2 of 4 (`js-vs-js-up-race/`). States that go up to the hero carry `expectGains`, so the takes compared are the ones where the rail stayed shut. Whether a real remote (key-up ~100 ms after key-down) does it every time could not be tested over adb — worth one press on the real remote.

## Harness changes (rules 1-7 untouched; README section 8)

`traceRule: "rest"` for bursts, focus tables compared on gains with tags renamed by first focus, `expectGains` retakes, `freeze on,mid`, `states/app.json`, adb reconnect-and-retry, `frame_table_check.py`.

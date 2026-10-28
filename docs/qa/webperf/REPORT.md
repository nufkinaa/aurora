# Aurora website — invisible performance pass

Branch `perf-web-invisible`, from master `190bf9d` (1.13.7). The owner's rule: nothing may change how the site looks or what it does — only work the page no longer does. Every change below is pixel-identical (proof under "Pixels") and keeps the same features, flows, player choices and timings, except that some things now happen sooner. Ideas that would have changed a pixel or a behaviour are at the end, for elia to decide.

Harness: `tools/webperf/` (new), on top of `tools/mobile-perf/`'s private instance (400 made-up titles, made-up pictures). Every table: [`TABLES.md`](TABLES.md). How to re-run: at the end.

## In one page

**Before → after, measured side by side at the same moment** (`ab.sh`: master and this branch each on its own private instance, 5 sizes × 2 looks, CPU ×4, 3 runs a cell, medians over the 10–20 cells):

| | before | after |
|---|---:|---:|
| Scrolling Home: time blocked by long tasks | 57.5 ms | **1 ms** |
| Scrolling Home: frames later than 50 ms / worst frame | 3 / 114 ms | **1 / 52 ms** |
| Scrolling Home: script on the main thread | 815 ms | **522 ms** (−36 %) |
| Back to Home: until the shelves are painted | 716 ms | **561 ms** (−22 %) |
| Opening a title: until it is painted | 904 ms | **777 ms** (−14 %) |
| The Movies tab: until the grid is painted / blocked | 746 / 207 ms | **661 / 147 ms** |
| Scrolling the Movies grid: main-thread time | 1743 ms | **1333 ms** (−24 %) |
| Typing in Search: slowest input → paint (INP) | 84 ms | **72 ms** |
| Home, idle, scrolled into the shelves, phone, legacy look (6 s, interleaved) | 2743 ms of main thread | **48 ms** |
| Home, idle, scrolled into the shelves, phone, glass look (6 s, interleaved) | 3196 ms | **2154 ms** |
| Home load (FCP / LCP / TBT, cold) | 820 / 2362 / 541 ms | 828 / 2474 / 498 ms — the same within noise |
| Player: tap → picture moving (10 interleaved runs) | phone 2185, iPad 1672 ms | phone 1926, iPad 1580 ms — the same within noise |
| JS heap after ten navigations / growth over ten more | 7.36 MB / none | 7.38 MB / none |

**Pixels:** 230 screenshots a side (5 sizes × 2 looks × every route and state), each side twice: **219 identical, 11 differing by at most 7/255 in a few dozen pixels on desktop poster corners, none above the anti-aliasing threshold** — the same kind and size as two runs of master against each other (217 identical, 13 differ).

**Tests:** whole `npm run test:ui` twice under `ui-lock` (run 1: 438 pass + 2 load flakes that pass alone 2/2; run 2: 440 pass, 0 fail), root `npm test` twice (run 1: 5 load flakes that pass alone; run 2: 2050 pass, 0 fail), WSL Node 22 `npm test` (run 2: 1990 pass, 0 fail), the new `test/ui/webperf.test.js` 3× green, and the UI files covering what was touched (leaks, home-fresh, title, navigation) 3× each.

**The biggest finding** is one this pass could not change: **Home's greeting shine** (the gradient moving across the person's name) is a main-thread animation that never stops — about 40 % of a ×4-slowed phone's main thread while the top of Home is on screen. While the greeting is scrolled away it now rests (the 2743 → 48 ms above); while it is visible it costs what it costs, and only a visible change could fix that (proposal 1).

## How it was measured

- **Private instances only** (`scripts/ui-test-server.js` via `tools/mobile-perf/instance.js`): never the live server; every host but this machine unresolvable.
- **Real Chrome** (playwright-core, channel `chrome`), headless.
- **Sizes**: desktop 1440×900; iPad 1024×1366 and 820×1180 (touch, ×2); phones 390×844 and 360×800 (touch, ×3). **Both looks.**
- **CPU** ×4 and ×6 (Chrome's throttle). **Lines** (Chrome's emulation): none, fast 3G (3 Mbit/s · 150 ms), slow 3G (400 kbit/s · 400 ms).
- **Data mode pinned to "Full quality"**, so the connection meter's verdict (1× or 2× pictures) cannot differ between runs for reasons of its own.
- `tools/webperf/run.js`, per cell (device × look × CPU × line), 3 runs, medians:
  - **load-cold / load-warm** — Home opened with no HTTP cache and no service worker (the profile remembered), then reloaded warm: FCP, LCP (as it stands before the billboard first turns, 9 s after Home paints — the next slide is a later "largest paint" that says nothing about the load), TBT (long tasks' time over 50 ms from FCP to the end of a window of at least 10 s), long tasks, `rows` (Home's own mark: the first shelves are on the page), bytes.
  - on the cells without a line limit, **gestures**, each with a requestAnimationFrame frame-time sampler (frames over 50 ms, the worst), long tasks, INP (Event Timing) and Chrome's main-thread counters: scroll Home (touch / wheel), **hold** a card until its peek sheet is up, **open a title**, **Back**, the **Movies** and **Shows** tabs and scrolling their grids, **typing** "harbor" in Search, the **player** (TTFF = the press → the picture moving, in the page's own clock), a **seek** (→: key → first frame after `seeked`), and the **heap** after ten navigations and its growth over ten more.
- **The machine was busy throughout** (other agents' suites; at times 3 GB of 32 GB free). Absolute numbers are pessimistic and noisy; before and after were always measured at the same moment (`ab.sh`), and the small experiments were A/B **interleaved run by run**. Trust the pairs.
- **Baseline committed**: `tools/webperf/baseline/master-190bf9d.json` — 60 cells (5 sizes × 2 looks × CPU ×4/×6 × none / fast 3G / slow 3G), 3 runs each, every raw run kept. The before/after pair: `tools/webperf/baseline/ab-2026-10-28-{before-190bf9d,after-1daa674}.json`.

## Where the main thread's time goes (CPU profiles and traces, ×4)

1. **Home's greeting shine** (`screens.css` `greet-shine`: `background-position` animated on gradient-clipped text) — a style recalc, a paint and a commit every frame for as long as Home is up, also while the greeting is scrolled far away. A trace of idle Home (legacy, phone): Paint 1.1 s, Style 0.5 s, Commit 0.5 s and the browser's IntersectionObserver upkeep (lazy pictures, `content-visibility`) 0.3 s per 3 s. Its top sits at 507–1065 px: on screen at the top of Home on every size.
2. **The glass page sky** (`aurora-sky.js`) asked for every frame (60 a second) to find out when its next paint (every 33–83 ms) was due, and searched the whole page for an open player on each.
3. **The nav's picture tint** (`glassTone.js toneNavFromImage`) drew every billboard and title backdrop onto a canvas — a full decode on the main thread at every billboard turn — to compute a brightness that has not been used since 2026-10-06 (`applyNav` only clears the layer).
4. **Forced layouts while building**: on a phone, reading `innerWidth` makes Chrome lay the page out first; Home read it once per shelf while appending shelves.
5. **What is left is mostly the look itself**: the desktop sky's curtains (≈ 28 % of the main thread at ×4 on desktop: ~2 400 `drawImage` calls per paint), the nav aurora in the legacy look once scrolled (≈ 38 % at ×4 on desktop), the phone sky's twinkling stars, the nav-tone measurer (every 1.2 s and on scrolls and picture arrivals; 25–45 ms a measure at ×4), and building ~1 100 elements for Home. All under "For the owner to decide".

## What was changed — each its own commit

| commit | what | measured |
|---|---|---|
| `0e7e616` | **The glass sky stops asking for every frame between its paints** (`aurora-sky.js`). Where the wait is long (83 ms, a paint that is dear) it sleeps on a timer and wakes three frames before the paint is due, so the paint lands on the same frame as before; the per-frame "is a player open?" is a live list instead of a whole-page search. | Paint cadence before/after at ×1 and ×4, phone and desktop: the same gaps (phone ×4: 159–165 paints in 6 s both, median gap 34.7–35.3 ms). A 30 ms margin, tried first, slipped a frame under load (fewer paints at ×4) and was widened to 50 ms before committing. |
| `ed4ce8c` | **Home's greeting shine rests while it is a screen away** (`ui.js holdWhileOffscreen`, `home.js`): paused while the greeting is more than a screen out of view; before it can come back it is given back the start time it had, so it is exactly where it would have been, frame for frame. | Idle Home scrolled into the shelves, phone, ×4, 6 s, interleaved: legacy 2743 → 48 ms, glass 3196 → 2154 ms of main thread. `test/ui/webperf.test.js` checks the start time and the phase. |
| `897542e` | **The nav's picture tint no longer decodes and samples a picture nobody uses** (`glassTone.js`): the picture is still requested exactly as before; only the canvas drawing and readback are gone. | One full-picture decode + draw + readback fewer per billboard turn and per title page (30–38 ms at ×4 on a phone, in the profiles of a load and of Back). |
| `b371234` | **Building Home no longer lays the half-built page out after every shelf** (`components.js` `HEAD_COUNT` via `ui.js viewWidth`: innerWidth, read once and again after each resize). | Back to Home, phone ×4, 8 interleaved runs: layouts 30 → 21, blocked 516 → 367 ms, painted 722 → 517 ms (with the commits before). |
| `f052a06` | Revert of the cast-line half of `b371234` (below). | |

Tooling: `dacccb0` (the webperf harness), `54b45a8` (the baseline), `1daa674` (both versions' screenshots see the same picture bytes; by-hand instances really stopped), and the report commit.

**Tried and dropped** — because they moved pixels or did not pay:

- The cast line on a title page placed by `matchMedia("(max-width: 720px)")` instead of `innerWidth` (part of `b371234`): the pixel comparison found the 1024-wide tablet's glass panels on title pages differing; bisected to that one line and reverted (`f052a06`) — that early forced layout is part of how the page settles.
- The same frame-wake for the nav aurora: its 33 ms cadence leaves no frame to skip with a safe margin.
- The card's FILM/SERIES tag from a parsed template instead of `innerHTML`: 4.6 → 2.5 ms for 300 cards at ×4 — not worth a diff.
- `contain` / `isolation` on the greeting to make its repaint cheaper: no measurable gain.
- A per-address cache for the nav-tone thumbnails: small, and a revalidated picture could in principle differ from its cached copy.
- Already in place from earlier passes (checked; nothing to add): `content-visibility` on shelves and grids, `decoding="async"` and `?w=`-sized pictures, `fetchpriority="high"` on the billboard's first picture, lazy pictures below the first screenful, passive scroll/touch listeners (window-level ones are passive by default), rAF-coalesced scroll handlers, screens let go on leave (`router.js untilLeave`), Home painted from its last answer on Back, prefetch on hover/focus/touch for the nav and cards, the player module warmed on Play's hover.

## Before → after (all cells: [`TABLES.md`](TABLES.md))

Master and this branch at the same moment, CPU ×4, lines none and fast 3G, 3 runs a cell; medians over the cells (each cell's own median first). ms unless named; lower is better.

#### load-cold — median over 20 cells

| fcp | lcp | rows | tbt | longTasks | worstTask |
|---:|---:|---:|---:|---:|---:|
| 820 → 828 (+1%) | 2362 → 2474 (+5%) | 2010 → 2093 (+4%) | 541 → 498 (-8%) | 7 → 6.50 (-7%) | 348 → 349 (+0%) |

#### load-warm — median over 20 cells

| fcp | lcp | rows | tbt | longTasks | worstTask |
|---:|---:|---:|---:|---:|---:|
| 346 → 324 (-6%) | 806 → 808 (+0%) | 581 → 561 (-4%) | 164 → 190 (+16%) | 6 → 4.50 (-25%) | 138 → 147 (+7%) |

#### scroll-home — median over 10 cells

| lateFrames | worstFrame | longTasks | blocked | task | script | style |
|---:|---:|---:|---:|---:|---:|---:|
| 3 → 1 (-67%) | 114 → 52.50 (-54%) | 2.50 → 0.50 (-80%) | 57.50 → 1 (-98%) | 3615 → 3218 (-11%) | 815 → 522 (-36%) | 432 → 389 (-10%) |

#### hold — median over 10 cells

| holdToSheet | inp | lateFrames | worstFrame | blocked | task |
|---:|---:|---:|---:|---:|---:|
| 526 → 521 (-1%) | 96 → 96 (0%) | 1.50 → 1 (-33%) | 99.50 → 97 (-3%) | 36.50 → 37.50 (+3%) | 1024 → 1006 (-2%) |

#### open-title — median over 10 cells

| toPaint | inp | lateFrames | worstFrame | blocked | task |
|---:|---:|---:|---:|---:|---:|
| 904 → 777 (-14%) | 88 → 88 (0%) | 4 → 3.50 (-12%) | 317 → 336 (+6%) | 243 → 226 (-7%) | 1159 → 1246 (+7%) |

#### back — median over 10 cells

| toPaint | lateFrames | worstFrame | blocked | task | script |
|---:|---:|---:|---:|---:|---:|
| 716 → 561 (-22%) | 7.50 → 8 (+7%) | 188 → 228 (+21%) | 221 → 267 (+21%) | 1551 → 1570 (+1%) | 418 → 399 (-5%) |

#### tab-movies — median over 10 cells

| toPaint | inp | lateFrames | worstFrame | blocked | task |
|---:|---:|---:|---:|---:|---:|
| 746 → 661 (-11%) | 100 → 96 (-4%) | 3.50 → 4 (+14%) | 248 → 232 (-6%) | 207 → 147 (-29%) | 1222 → 1166 (-5%) |

#### scroll-movies — median over 10 cells

| lateFrames | worstFrame | blocked | task | script | style |
|---:|---:|---:|---:|---:|---:|
| 0.50 → 0 (-100%) | 35.50 → 19 (-46%) | 0 → 0 | 1743 → 1333 (-24%) | 324 → 306 (-5%) | 151 → 121 (-20%) |

#### tab-shows — median over 10 cells

| toPaint | inp | lateFrames | worstFrame | blocked | task |
|---:|---:|---:|---:|---:|---:|
| 416 → 452 (+9%) | 56 → 60 (+7%) | 3.50 → 3 (-14%) | 107 → 115 (+7%) | 4 → 7.50 (+88%) | 889 → 866 (-3%) |

#### scroll-shows — median over 10 cells

| lateFrames | worstFrame | blocked | task | script | style |
|---:|---:|---:|---:|---:|---:|
| 0 → 0 | 22.75 → 27.50 (+21%) | 0 → 0 | 1420 → 1727 (+22%) | 324 → 354 (+9%) | 133 → 150 (+13%) |

#### search-type — median over 10 cells

| inp | lateFrames | worstFrame | blocked | task | script |
|---:|---:|---:|---:|---:|---:|
| 84 → 72 (-14%) | 1.25 → 1.50 (+20%) | 78 → 53.50 (-31%) | 0.25 → 0 (-100%) | 1611 → 1669 (+4%) | 250 → 224 (-11%) |

#### player — median over 10 cells

| ttff | toPlaying | inp | lateFrames | blocked | task |
|---:|---:|---:|---:|---:|---:|
| 1051 → 1238 (+18%) | 521 → 508 (-3%) | 64 → 64 (0%) | 2.25 → 4 (+78%) | 162 → 159 (-2%) | 1503 → 1604 (+7%) |

#### seek — median over 10 cells

| seekToFrame | seeked | lateFrames | blocked | task |
|---:|---:|---:|---:|---:|
| 534 → 536 (+0%) | 269 → 273 (+2%) | 0 → 0 | 0 → 0 | 500 → 602 (+21%) |

#### heap — median over 10 cells

| heapMB | nodes | listeners | growHeapMB | growNodes | growListeners |
|---:|---:|---:|---:|---:|---:|
| 7.36 → 7.38 (+0%) | 8516 → 8532 (+0%) | 7454 → 7589 (+2%) | -0.02 → -0.01 (+25%) | 3046 → 3046 (0%) | 94 → 94 (0%) |

Errors:
- ipad-820 · legacy · ×4 · none: elementHandle.tap: Element is not attached to the DOM

How to read it: the gains are where the changes act — scrolling Home (the greeting resting, the sky not asking for frames), Back and the grids (fewer layouts, no dead picture decode), and less main-thread work under every tap. Load times (FCP / LCP) did not move: none of the changes is on the load's critical path. The Shows tab and its scroll came out a little worse and the Movies ones better — the same screen code, so that pair is the run-to-run spread on this machine. The player's start is bimodal here on both sides (about 1 s, or 2–4 s when the server's segment is late); 10 interleaved runs per size show no difference (phone 2185 → 1926 ms, iPad 1672 → 1580 ms). The one error is master's side: a card was replaced under the harness's finger (a Home refresh merging in), not a failure of the site.

## Pixels

`bash tools/webperf/shots.sh 190bf9d WORKTREE final --devices desktop-1440,tablet-1024,tablet-820,phone-390,phone-360x800 --looks glass,legacy --extra-wait 4000` — `tools/mobile-perf/shots.js` photographs every screen at rest with everything that moves by itself held still (its README says how), every route and state (top, one and three screens down, a shelf swiped, Search typed): **230 screenshots a side**, each side photographed twice; `diff.py` counts a pair identical when any run of one side equals any run of the other.

- **Threshold**: a pixel "differs visibly" above 8/255 in a channel (anti-aliasing and compositor rounding sit below it).
- **Noise floor** (master against master): 217 of 230 identical; 12 desktop pairs with a few to a few hundred pixels off by 1–7 levels (poster corners) and one phone series page with 2750 pixels up to 25 levels (an episode still's edge).
- **Master against this branch: 219 of 230 identical; 11 differ, all on desktop, 4–128 pixels each, at most 7/255 — none above the threshold**, the same pixels the noise floor shows (the edge of a poster's rounded corner).
- Two harness fixes were needed before that was true (`1daa674`): the two instances cut their pictures each on their own — and on a machine short of memory one sends an original instead of a cut: the same picture, other bytes — so the photographed pass now serves both sides the same bytes (`--img-cache`, with the browser cache cleared and the offline worker bypassed); and `--extra-wait` lets what arrives a moment later be in the picture on both sides (the New tab's dot appears at the first idle moment — sooner now that the page is idle sooner).
- Not covered by screenshots and checked another way: the greeting shine's motion (its start time is kept and given back — asserted in `test/ui/webperf.test.js`), the sky's motion (paint cadence measured, above; its pixels come from untouched code).

## Tests

- `npm run test:ui` (whole, under `ui-lock`), twice: 441 tests — run 1: 438 pass, 1 skipped, 2 fail (`offline` "the iPhone report… while the server is busy", `start-walls` "sign-in required: a start from the title page…"; each file then passed alone twice, 7/7 and 10/10); run 2: **440 pass, 1 skipped, 0 fail**.
- Root `npm test`, twice: run 1: 2045 pass, 5 fail (`encoder-paused`, three `imgvariant`, `spawner-lower` — the server refusing encoder and picture work at "little memory left"; those files pass alone, 14/14); run 2: **2050 pass, 33 skipped, 0 fail**.
- WSL Ubuntu, Node 22, `npm ci && npm test` from a bundle of this branch: run 1: 1 fail (its name lost in a truncated log); run 2: **1990 pass, 0 fail**.
- `test/ui/webperf.test.js` (new): the shine rests while a screen away and is back at its own start time before it comes into view — desktop and phone, both looks; the glass sky paints at its cadence, none early, no stall. 5/5, three times in a row.
- Files covering what was touched, 3× each: `leaks` 2/2, 1/2, 2/2; `home-fresh` 8/8 ×3; `title` 15/15 ×3; `navigation` 8/8 ×3. The `leaks` failure is its player case, and **master fails it too on this machine** (3 of 3 runs with master's `public/` checked out); it passed in both whole-suite runs.
- Note: `test/ui/admin-upload.test.js` writes its screenshots into `docs/qa/admin-upload/`; they were restored after each run, not committed.

## For the owner to decide — would help, but a person could see it (or a behaviour changes)

Ordered by what they would buy.

1. **The greeting shine while it is on screen.** The largest standing cost of the website on a phone: at the top of Home about 40 % of a ×4-slowed phone's main thread (legacy, idle: ~2.5 s of 6 s; ~50 ms without it). Every remedy is visible: run it a few times and stop; run it only after a pause in input; slow it; or draw the moving light as a compositor-moved layer over the text (the closest to the same look, not pixel-identical — needs elia's eye).
2. **The desktop sky's curtains off the main thread** (an OffscreenCanvas in a worker): the same drawing code and the same pixels, but each paint can land a frame later, and the cost-adaptive cadence would measure the worker — the sky's pace could change. About 28 % of the desktop main thread at ×4 (≈ 7 % on a real desktop).
3. **The nav aurora (legacy look, scrolled)** — the same idea: about 38 % of the main thread at ×4 on desktop while it shows.
4. **Nav tone: measure only when something under the nav could have changed** (DOM, scroll, pictures, transitions) instead of every 1.2 s, and on a picture's arrival only when it lies under the nav: 25–45 ms a measure at ×4. Risk: a change nothing announces would flip a tab's text colour up to 1.2 s later.
5. **Keep Home's page on Back instead of rebuilding it** — Back to Home is the slowest navigation (0.7–3 s at ×4/×6). Visible: the billboard would stay on its slide instead of starting again at the first, and its animations would not restart.
6. **`content-visibility` per card in the Movies/Shows grids**: paint containment clips each card's focus ring and hover lift.
7. **The wash animations behind every page (glass)** tick the main thread whenever the sky paints (a style recalc each frame); making them compositor-only changes the CSS.
8. **One listener per shelf instead of eleven per card** (~3 000 on Home): a structural change for a small gain.
9. **`innerWidth` → the cached width everywhere** (`heroArtWidth`, the hero's picture sizes): in the frame around a rotation a different picture size could be asked for — and the title page's cast line showed that even a "same value" read can change how a page settles.
10. **Drop the billboard picture request that only fed the nav's tint** (`toneNavFromImage`): its brightness is no longer used (`897542e`), but the request warms the browser cache with the landscape picture, which then shows at once after a rotation — a visible-timing change. Saves 26–69 KB per billboard turn on portrait phones.
11. Still open from the earlier mobile report (`docs/qa/mobile-perf/REPORT.md`): episode stills at drawn size; Continue Watching stills at drawn size; placeholders only for the first shelves; the connection meter; fewer pictures at once on Home; the stylesheet split by screen.

## Not verifiable here

Chromium on a busy desktop with a CPU throttle is not a phone: no Safari, no real low-end SoC, no real radio. For what changed: `Animation.startTime` / `getAnimations` (Safari 13.1+), IntersectionObserver (12.1+) and timers are everywhere. On a real phone, worth a look: Home's greeting shine is the same after scrolling down and back; the glass sky keeps its pace while scrolling. A run at CPU ×6 before/after was not made side by side (time); the ×6 baseline is in the committed JSON for the next comparison.

## Re-running

```
cd tools/mobile-perf && npm ci                     # puppeteer, for the screenshots
node tools/webperf/run.js --label now              # the whole matrix (hours); --devices --looks --cpu --nets --runs --only load,gestures
bash tools/webperf/ab.sh 190bf9d WORKTREE before after --cpu 4 --nets none,fast3g --runs 3
node tools/webperf/compare.js before after [--full]
node tools/webperf/compare.js tools/webperf/baseline/master-190bf9d.json now
bash tools/webperf/shots.sh 190bf9d WORKTREE name --devices desktop-1440,tablet-1024,tablet-820,phone-390,phone-360x800 --looks glass,legacy --extra-wait 4000
```

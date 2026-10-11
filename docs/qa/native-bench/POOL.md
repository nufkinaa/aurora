# The recycling shelf and the recycling grid on the Mi TV (2026-10-10 / 11)

Lab `C:\elia\aurora-lab`, branch `native-lab`, app `com.auroratv.lab` on the Mi TV (MiTV-AFMU0, Android 14, 1080p,
59.94 Hz), server `:4000`, profile "Claude QA", trailers off. Production untouched. What was built offline is in
`POOL-PLAN.md`; this is what the device said. Data: `pool/` (captures, logcats, traces and raw dumps are in the
worktree only — `pool/.gitignore`).

**The session was cut off before the end.** What that leaves open is listed in "Not finished" — read it before
relying on a number.

## Short version

1. **The recycling shelf (`exp pool`) works and is the same picture.** A held key along a 24-card shelf: frames
   over 32 ms 106 → 18 (four runs), janky 4.2 → 1.4 %, p99 53 → 31 ms, presented 56.3 → 58.3 fps, the UI thread's
   overrun 546 → 98 ms per run. Mounts in the middle of a shelf: 33 views per window move → 0.
2. **Long frames are not gone, they are four per run instead of ~26:** the first window move away from either END
   of a shelf still mounts three cards (the window grows from 6 to 9) — one 47–65 ms frame each time.
3. **The recycling grid (`impl grid=native`) is the same picture after one device fix, and is not a clear win.**
   It removes the FlatList's 190–230 ms mount stall, but re-binding twelve cards every second row costs
   30–55 ms frames of its own on the first pass. Slow stepping (S3) is unchanged.
4. Two bugs found on the way, both fixed: the grid let a press reach rows the FlatList cannot reach (different
   rest rows); and `cardlayer` silently lost a card's hardware layer after any props update (React Native resets
   the layer type) — an older lab bug that the pool made visible.
5. A finding about the REFERENCE, not changed: while a key is held at repeat speed about half of the shelf is
   empty on screen, keyed or pooled alike (below).

## What the two do

- **Shelf** — `Row.tsx` `NativeRow` under `exp pool`: the same mounted window as today (3 behind, 5 ahead, moved
  when focus is 3 away), but the cards sit in nine SLOTS keyed by slot number, item *i* in slot *i mod 9*. A window
  move hands the three slots that fell out the three items that came in: new props on existing views, in one
  commit. `AuroraRowView` paints the slots in shelf order (`PoolHost.kt`).
- **Grid** — `NativeGrid.tsx` + `AuroraGridView.kt` under `impl grid=native`: Browse's cards in a pool of 8 rows
  (48 cards) inside the same React Native ScrollView, re-bound two rows at a time.

## What was wrong on the device, and the fixes

| | found by | cause | fix |
|---|---|---|---|
| Grid: after N presses DOWN the two grids rested on different rows at different scroll offsets (`grid-down-12`: 1.19 M px) | pixel states | The FlatList has `removeClippedSubviews`: a row wholly outside the scroll window is DETACHED, focus search cannot find it, and `ScrollView.arrowScroll` then pages by half a screen with focus staying put. In Browse that is **every third DOWN** (press, press, page), at any speed — it is how the reference moves. The pool kept its rows attached, so every press moved focus. | `AuroraGridView.addFocusables` leaves rows that do not intersect the scroll window out of the focus search (the test `ReactViewGroup.updateSubviewClipStatus` makes). `exp gridfree=1` turns it off (every press moves — arguably the better behaviour, but not the reference's). |
| Shelf + `cardlayer`: the card right of the lit one differed by 1/255 on 906 px, 3 of 3 runs (0 of 3 without pool) | `pool-wrap-shadow`, strict | `BaseViewManager.onAfterUpdateTransaction` ends EVERY props transaction with `setLayerType(NONE)`. `AuroraFocusableView.syncLayer` compared with its own `layered` flag, so a card whose props were updated drew without its layer for good. In a pooled shelf that is slot 0 (its `edgeLeft` flips on the first re-bind); in the keyed row it is any card React re-renders with changed Focusable props. | `syncLayer` compares with the view's real layer type and runs at the end of `applyProps` (after React Native's reset). 0 px, 2 of 2 runs. Commit `aa7dc15`. This is a fix to the recommended configuration itself, pool or no pool. |
| Focus tables "differ" on every state with a window move | harness | A react tag names a view; a recycled slot is one view showing items 0, 9, 18. | `trace.py` names a gain by the ITEM (`row0[9]`) from the container's own `[pool] … focus=<index>` line when both sides have one. Stricter, not looser. `diff.py` / `strict.py` unchanged. |
| `browse/focus-r2c3` trace rule failed at 0 px | harness | the state's last key landed while the previous spring was running (README rule 8) | `wait:800` before the last key in the state file |

Smoke (pool, grid): rows slide, OK opens a title and BACK returns onto the same card (0 px against the frame
before), RIGHT on the last grid column opens the panel and LEFT closes it onto the same card, LEFT at card 0 /
column 0 opens the rail, re-entry lands on the last focused card (states `left-at-0*`, `reentry-*`,
`grid-rail-return`). The long-press peek was pressed once with `input keyevent --longpress` and opened Detail;
it was **not** compared with pool off (not finished).

## Pixels

`run.py` rule unchanged; "strict" = pixels that differ at all. Both sides native unless said.

| group | A → B | states | run.py | strict |
|---|---|---|---|---|
| shelf, 22 row states (18 old + `pool-wrap-shadow`, `pool-hold-right-left-end`, `pool-continue-far`, `-back`) | none → `pool` | 22 | 22 pass | 16 at 0 px; 6 with 164–22,806 px at ≤ 1/255 inside the LIT card's box |
| the same noise, measured: recommended → recommended (no pool), 8 states × 3 | control | 24 | 24 pass | 14 at 0; 10 with 92–2,855 px, ≤ 2/255, same boxes |
| recommended → recommended + pool, same 8 states × 3 (before the layer fix) | | 24 | 24 pass | same noise; plus `pool-wrap-shadow` 906 px 3/3 = the layer bug → 0 px after the fix |
| grid, 7 browse states (3 old + `grid-down-12`, `grid-down-up`, `grid-down-right`, `grid-rail-return`) | all JS → grid only native | 7 | 7 pass | **0 px in all 7** |
| grid with everything on | FCRHN+rec+pool → FCRHNG+rec+pool | 7 | 7 pass | **0 px in all 7** |
| row + render + app, everything on (after the layer fix) | FCRHN+rec → FCRHNG+rec+pool | 48 | 45 pass, 3 fail | 39 at 0 px; 6 with 92–4,402 px ≤ 2/255 (lit-card noise); the 3 fails below |
| focusable, card, hero, navrail regression (before the layer fix) | FCRHN+rec → FCRHNG+rec+pool | 63 | 54 pass, 5 skipped (server fixtures), 4 fail | **0 px in all 54** |

"rec" = `cardlayer, cull, shadowcache, unstuff`. The lit-card noise (a few hundred to a few thousand pixels by
1/255 around the focused card) appears with the same size between two runs of the SAME configuration; it is the
known halo noise of `REPORT.md`, not the pool.

The fails:
- regression run: `card/progress-bar`, `card/size-frame-episode` — the server answered "S3 E4 · Episode 4" in one
  capture and "S3 E4 · Whatever You Do, Don't G…" in the other (it flips sides between the two states); 3 of 3
  pass on the re-run. `navrail/item-profile-wrap` — different screens, 3 of 3 pass on the re-run.
  `hero/down-burst-4` — the known 9 dp rest difference of a DOWN burst; 2 of 3 pass on the re-run. It was B
  (pool + grid) that rested at −998.5 both times it failed; **whether the pool shifts the odds was not checked.**
- everything-on run after the fix: `app/home-down-hold-8` (the same burst quirk), `app/rail-to-settings` (the
  known Settings first-focus race), `app/movies-grid-hold` (a 50 ms burst in the grid: which press pages and
  which moves depends on where the smooth scroll is; 8 against 9 focus moves). All three passed in the run
  before the fix. **Not re-run** — the TV was taken.

### A re-bound card never shows the previous title

`tools/tv-pool-artcheck.sh` + `pool-art-check.py`: a reference screencap of every card of a shelf at rest, then a
screenrecord while RIGHT and LEFT are HELD along it (real key repeat), every frame cut out, the shelf located in
each frame and every card place classified against ALL the shelf's cards. A planted wrong picture is caught
(self-test).

| shelf (recommended + pool) | frames | places: right card | empty | unsure (best match is its OWN card: lit, scaled, moving) | **another card's picture** |
|---|---|---|---|---|---|
| Trending to Stream, 24 posters | 248 | 584 | 230 | 113 | **0** |
| Your Next Watch, 24 posters, one with a NEW pill | 246 | 536 | 218 | 134 | **0**; the pill seen on 83 places, never on a card that does not own it |

Limits: screenrecord kept ~42 of 60 frames per second during the motion, so "not for one frame" is a sample, not
every frame; by the code a picture is only drawn after the request of the CURRENT address answered
(`AuroraCardView.restartPicture`). Labels and progress bars could not be tested re-bound at all: Continue
Watching has 4 cards on this profile and its window never moves.

### Are cards "being filled in" while you scroll right? Yes — and it is the reference too

The same recordings, `tools/pool-coverage.py` (share of the shelf's strip that shows a card, moving frames only;
a shelf at rest reads ~85 %):

| held along a 24-card shelf | shelf shown, mean | frames with under half of it | frames with under a tenth |
|---|---|---|---|
| keyed row, no experiment | 48 % | 59 % | 6 % |
| recommended + pool | 46 % | 61 % | 2 % |
| recommended + pool, second shelf | 48 % | 62 % | 2 % |

One recording each. Why: the window is anchored on FOCUS (3 behind, 5 ahead) but the picture is where the SPRING
is, and at 20 cards a second the spring trails focus by several cards; so the cards on the left of the screen are
already unmounted, and JS moves the window after the fact. The pool does not change that (it is the same window);
it only has fewer wholly empty frames. Also at REST the reference shows one or two empty places at the right edge
whenever focus is one or two cards past the window's anchor (seen in the reference captures, e.g. focus on
card 5: nothing right of card 8). Fixing either means a window that follows the track's position or is wider —
a picture change, so not done here.

## Mounts

`[pool]` lines (focus log on), a real held key. `direct` = children of the track, `desc` = views anywhere under it.

| | per window move, mid-shelf | whole hold right + left (24 cards) | window moves that mounted anything |
|---|---|---|---|
| keyed shelf (Trending) | direct +3 / −3, desc +33 / −33 | direct +36 / −33, desc +396 / −363 | 13 |
| pooled shelf | **+0 / −0, +0 / −0** | direct +6 / −3, desc +66 / −33 (the two ends) | 3 |
| keyed, a shelf of mixed shapes (Your Next Watch) | desc +34..38 / −34..38 | | 13 |
| pooled, same shelf | direct 0; desc +2/−6, +1/−2, +2/−1, +6/−2 on four of twelve moves (pills that one card has and the next has not), 0 on the rest | | |

Grid, DOWN / UP / DOWN / UP held (`[mounts]` = AuroraFocusable views created / dropped anywhere):
FlatList +49 / −3 after the first hold (it mounts each row once and, in this 124-title catalogue, never drops
one), then nothing; pool +0 / −0 on every hold but −3 / +3 for the short last row when a page landed
(`[pool]` direct +0 / −0 on every other line).

## Frames

`tools/tv-pool-bench.sh`, 4 interleaved rounds, a cold start per run, build `aa7dc15`. A = recommended (all five
native + `cardlayer, cull, shadowcache, unstuff`), B = A + `pool`, C = B + `grid=native`.
L1 = Home's 4th shelf (24 cards): RIGHT held to the end, LEFT held back, twice — real key repeat (uinput), 92
card moves, ~28 window moves. G1 = Movies: DOWN held, UP held, twice. S3 = the old grid scenario (DOWN ×12 at
300 ms, RIGHT ×5). Medians; totals over the four runs in brackets. Full table: `pool/bench/table.md`.

| scn | cfg | p50 / p90 / p99 ms | longest frame ms | frames > 32 ms (4 runs) | > 64 ms (4 runs) | janky % | presented fps | refreshes without a new frame /1000 | UI thread over 24 ms, frames per run | UI overrun ms per run | PSS / GPU MB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | A | 12 / 22 / 53 | 63 | 26 (106) | 0 (2) | 4.2 | 56.3 | 60.9 | 25–31 | 546 | 252 / 59 |
| L1 | **B** | 12 / 22 / **31** | 61 | **4 (18)** | 0 (1) | **1.4** | **58.3** | **27.5** | **4–5** | **98** | 253 / 61 |
| S1 | A | 21 / 24 / 48 | 105 | 14 (64) | 2 (9) | 1.5 | 58.2 | 28.9 | – | – | 254 / 56 |
| S1 | B | 21 / 26 / 53 | 109 | 21 (88) | 2 (8) | 1.7 | 58.3 | 26.6 | – | – | 256 / 56 |
| S3 | A | 14 / 30 / 113 | 775 | 35 (131) | 12 (48) | 4.1 | 55.6 | 72.2 | – | – | 326 / 87 |
| S3 | B | 14 / 28 / 101 | 900 | 27 (114) | 10 (40) | 3.4 | 56.2 | 63.0 | – | – | 327 / 87 |
| S3 | C | 12 / 26 / 107 | 850 | 26 (129) | 12 (45) | 3.5 | 55.5 | 74.2 | – | – | 328 / 87 |
| G1 | A | 11 / 24 / 50 | 250 | 22 (91) | 3 (11) | 2.4 | 58.0 | 32.2 | 5–11 | 389 | 310 / 76 |
| G1 | B | 11 / 24 / 53 | 245 | 21 (84) | 3 (13) | 2.3 | 58.1 | 30.0 | 9–11 | 422 | 316 / 77 |
| G1 | C | 11 / **19** / 52 | **114** | **14 (58)** | 4 (14) | 2.4 | 57.2 | 45.0 | 8–10 | **290** | 310 / 82 |

RenderThread CPU per frame is the same in all three (5.2–5.7 ms on L1 / G1, 5.9–6.1 on S1): the pool changes the
UI thread, not the drawing. UI-thread CPU per frame on L1: 5.0 → 3.8 ms.

How to read it:
- **S1 does not test the pool on this profile.** Its shelf is Continue Watching, which has 4 cards: three moves,
  no window move. A and B differ by noise there. L1 is the shelf scenario.
- S3 (one press every 300 ms) is the same in A, B and C; its worst frame is opening Browse, not the grid. B has no
  grid change, so A against B on S3 / G1 shows the run-to-run spread.
- "Refreshes without a new frame" leaves out gaps longer than six refreshes (`present-parse.py` treats them as
  pauses). The FlatList's 230–275 ms stall is such a gap, so that column and "presented fps" FLATTER A on G1.
  The frame counts, the longest frame and the UI overrun do not have that blind spot.
- L1's per-frame rows cover ~85 % of its frames (a hold is a little longer than gfxinfo's 120-frame table); the
  counts over 32 / 64 ms are from gfxinfo's histogram and are complete, the UI-thread columns are from the rows.
- POOL-PLAN's pass rule for the shelf (p99 lower in ≥ 3 of 4 rounds and ≥ 20 % lower in the median, p50 / p90
  not worse by 1 ms, memory not higher): **met on L1** (p99 53 53 53 53 → 34 31 31 28; −42 %).
  For the grid ("p99 and frames > 64 ms lower"): **not met** (p99 50 → 52, > 64 ms 11 → 14).

## The long frames that remain

`tools/ui-profile.py`: simpleperf on the app during the scenario, the main thread's samples put inside each
frame's UI part by time. One profiled run per configuration (`pool/anatomy/`); the profiler slows the app, so
shares, not milliseconds.

**Shelf, pool on (B, L1):** 5 of 480 frames had a UI part of 24 ms or more (keyed: 32 of 480; CPU inside them
165 ms against 922 ms). Four of the five are the same event — **the three cards mounted when the window first
leaves an end of the shelf** (6 → 9 cards; once per hold). Whole frame 47–72 ms, of which the mount callback
32–41 ms: first props of the ~33 new views 21–37 %, Fresco requests 13–15 %, record 10–18 %, focus 10–15 %,
creating views 8–13 %. The fifth is 24 ms of Fresco requests. Text layout is under 2 % everywhere; optional
children (pills) did not produce a long frame. In the middle of a shelf there is no long UI frame left.
What would remove the four: keep all nine slots mounted from the start, the three spare ones parked invisible and
not focusable — at the price of three more cards per shelf when the shelf first mounts (stepping down Home),
unless they are mounted one per idle frame after the shelf takes focus. Not built.

**Keyed shelf (A, L1):** the same frame 13 times a hold cycle, plus the deletes: props 22 %, Fresco 17 %, focus
12 %, record 9 %, create 8 %, insert/remove 8 %.

**Grid, pool on (C, G1):** 22 of 440 frames over 24 ms, **52 % of the CPU in them is submitting Fresco requests**
(72 % in the worst, a 112 ms UI part): a window move re-binds 12 cards = 24 picture layers in one commit, and
`AuroraCardView.restartPicture` builds each request on the UI thread. They sit almost all in the FIRST pass down;
later passes over the same rows are short. Knobs not tried: `GRID_SLACK` 1 (6 cards per commit), spreading the
requests over frames.

**FlatList (A, G1):** one 230–310 ms frame when it mounts a batch of rows (Fresco 27 %, props 23 %, focus 18 %,
create 10 %) and 12–24 ms of display-list recording on the frames around it; nothing on later passes, because in
a catalogue of this size it keeps every row it ever mounted.

## Not finished (the session was cut off, then the TV was needed elsewhere)

- **`exp recycle`** (Fabric `enableViewRecycling` + `useOptimizedViewRegistryOnAndroid`, forced after the stock
  entry point) and **`exp prepdraw`** (`Bitmap.prepareToDraw()` when a card's picture arrives): built, compiled,
  **never switched on on the device — not smoke-tested, not pixel-checked, not measured.** No result.
- The 63-state regression run was made BEFORE the `cardlayer` layer fix and not repeated after it; the 48-state
  everything-on run was repeated after it (its three burst / race fails not re-run).
- The benches and profiles ran on build `aa7dc15`. The last commit (`22041b7`) only makes the `[mounts]` QA
  counter free while the focus log is off; **that build was not installed** (the install did not complete).
- `hero/down-burst-4` with the pool: 2 fails in 4 takes, the control was not run.
- Long-press peek with pool against without; Continue Watching removal under the pool (POOL-PLAN §5.5); grid
  behaviour list §5.7 beyond the pixel states; `--art-delay` / `artFail` server variants (the lab uses the live
  server, which was not touched).
- One recording per row of the coverage table; one profiled run per configuration.
- **The TV was not put back.** As left: build `aa7dc15` installed, `impl` = five native + grid js, `exp` =
  `cardlayer, cull, shadowcache, unstuff` still ON, freeze / trace / focus log off, `security.perf_harden` back
  at 1, stay-awake on (never touched), no key sender running on the PC at the last check. `exp none` still has
  to be sent.

## Recommendation

- **Shelf pool: keep it, behind its switch, as part of the recommended set.** Same picture (0 px apart from the
  noise two identical runs show), a third of the janky frames on a held key, no cost anywhere measured. Before it
  is on by default: the unfinished checks above (regression after the layer fix, peek, removal in Continue
  Watching), and ideally the parked spare slots so the end mounts go too.
- **The `cardlayer` fix: keep regardless** — without it the recommended configuration loses layers as cards are
  re-rendered.
- **Grid: do not ship as it is.** Pixel-identical now, and it removes the one very long frame, but it is not
  better on p99 or frames over 64 ms and it is unchanged at stepping speed. It becomes worth it if the Fresco
  submits are spread or `GRID_SLACK` drops to 1 — and it is the only one of the two that bounds memory when the
  catalogue is in the thousands (the FlatList kept all 124 titles mounted). Decide `gridfree` separately: every
  third DOWN paging instead of moving is the reference's behaviour, and probably not what anyone wants.
- Worth its own round: the half-empty shelf during a held key. It is the most visible thing in the recordings
  and neither implementation addresses it.

## Files

- Fixes: `AuroraGridView.kt` (focus search window, `gridfree`), `AuroraFocusableView.kt` (`syncLayer`).
- Switches / QA: `AuroraExp.kt` (`pool`, `gridfree`, `recycle`, `prepdraw`), `MainApplication.kt` (`recycle`),
  `AuroraCardView.kt` (`prepdraw`), `AuroraQa.kt` + the Focusable / Card managers (`[mounts]`).
- Harness: `tools/tv-pixel-diff/trace.py` (gains by item), `run.py` (`--exp-a`, `--impl-a`), `refocus.py`,
  `states/row.json` (+4), `states/browse.json` (+4, `focus-r2c3`), `README.md`, `PROTOCOL.md`.
- Tools: `tv-pool-bench.sh`, `pool-parse.py`, `pool-report.py`, `tv-pool-artcheck.sh`, `pool-art-check.py`,
  `pool-coverage.py`, `ui-profile.py`.
- Data: `pool/bench/` (jsonl + `table.md`), `pool/anatomy/`, `pool/mounts/`, `pool/artcheck/`, `pool/px-*/`
  (summaries and results).

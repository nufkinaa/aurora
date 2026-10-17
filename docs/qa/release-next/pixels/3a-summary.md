# TV pixel diff — 2026-10-17

**29 pass · 58 fail · 5 skipped** — impl `FCRHN`, states `focusable,card,row,hero,navrail,browse`, runs 1

| field | value |
|---|---|
| APK versionCode | 102 (5.2.0) `com.auroratv` |
| commit | 0e97cf2f2f52 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=102 impl=- exp=- src=qa |
| server flags declared | (none) |
| started / finished | 2026-10-17T18:02:30 / 2026-10-17T18:55:18 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| focusable | card-rest | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - | 0 | **FAIL** |
| focusable | card-lit | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | ok | 0 | **FAIL** |
| focusable | btn-primary-lit | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - | 0 | **FAIL** |
| focusable | btn-primary-rest | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - | 0 | **FAIL** |
| focusable | btn-secondary-lit | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | ok | 0 | **FAIL** |
| focusable | btn-secondary-rest | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - | 0 | **FAIL** |
| focusable | chip-on-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | chip-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-surface-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | navitem-lit | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL | 0 | **FAIL** |
| focusable | navitem-lit-2 | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - | 0 | **FAIL** |
| focusable | sources-row-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | - | 0 | PASS |
| focusable | sources-row-lit-2 | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok | 0 | PASS |
| card | rest-home | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - | 0 | **FAIL** |
| card | size-frame | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | ok | 0 | **FAIL** |
| card | progress-bar | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - | 0 | **FAIL** |
| card | size-frame-episode | 1 | FCRHN | 482 | 21 | 0.00022 | 47 | - | 0 | **FAIL** |
| card | size-poster | 1 | FCRHN | 0 | 0 | 0.00000 | 3 | ok | 0 | PASS |
| card | kind-tag | 1 | FCRHN | 0 | 0 | 0.00000 | 3 | - | 0 | PASS |
| card | size-poster-row2 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | grid-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | grid-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | new-tag | 1 | FCRHN | 0 | 0 | 0.00000 | 8 | - | 0 | PASS |
| card | new-tag-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 3 | - | 0 | PASS |
| card | size-wide | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with fixture (declare --server <flag>) |
| card | size-compact | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with aiMock (declare --server <flag>) |
| card | blur-up | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with artDelay (declare --server <flag>) |
| card | broken-tile | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with artFail (declare --server <flag>) |
| row | offset-0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| row | offset-1 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| row | lead | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| row | offset-5 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| row | offset-9 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | offset-10 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| row | back-left | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| row | hold-right-12 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL (rest only) · focus ok | 0 | **FAIL** |
| row | hold-right-end | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL (rest only) · focus ok | 0 | **FAIL** |
| row | hold-right-left | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL (rest only) · focus ok | 0 | **FAIL** |
| row | reentry-down | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| row | reentry-up | 1 | FCRHN | 0 | 0 | 0.00000 | 3 | FAIL · focus ok | 0 | **FAIL** |
| row | left-at-0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | left-at-0-return | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | poster-row1-step | 1 | FCRHN | 0 | 0 | 0.00000 | 3 | FAIL · focus ok | 0 | **FAIL** |
| row | continue-rest | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL · focus ok | 0 | **FAIL** |
| row | continue-step | 1 | FCRHN | 482 | 21 | 0.00022 | 47 | FAIL · focus ok | 0 | **FAIL** |
| row | continue-step-2 | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL · focus ok | 0 | **FAIL** |
| row | pool-wrap-shadow | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-hold-right-left-end | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-continue-far | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| row | pool-continue-far-back | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| hero | rest | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - | 1 | **FAIL** |
| hero | scrolled | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | ok · focus ok | 0 | **FAIL** |
| hero | scrolled-back | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | ok | 0 | **FAIL** |
| hero | first-slide | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | ok · focus ok | 0 | **FAIL** |
| hero | details-lit | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| hero | scrolled-row1 | 1 | FCRHN | 0 | 0 | 0.00000 | 3 | ok · focus ok | 0 | PASS |
| hero | scrolled-row3 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | down-burst-4 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| hero | back-from-row1 | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | ok · focus ok | 0 | **FAIL** |
| hero | slide-then-scrolled | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | ok | 0 | **FAIL** |
| hero | slide-scrolled-back | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | ok | 0 | **FAIL** |
| hero | mid-fade-row0 | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | ok | 0 | **FAIL** |
| hero | mid-fade-row1 | 1 | FCRHN | 564 | 3 | 0.00027 | 50 | ok | 0 | **FAIL** |
| hero | mute-pill | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with fixtureTrailer (declare --server <flag>) |
| navrail | closed | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | open | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL · focus ok | 0 | **FAIL** |
| navrail | item-search | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | item-home | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | item-movies | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | item-shows | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | item-list | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | item-ai | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | item-settings | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | item-profile | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | item-profile-wrap | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | closed-again | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL · focus ok | 0 | **FAIL** |
| navrail | mid-open | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL | 0 | **FAIL** |
| navrail | closed-back | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL · focus ok | 0 | **FAIL** |
| navrail | open-from-row | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL · focus ok | 0 | **FAIL** |
| navrail | row-closed-again | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL · focus ok | 0 | **FAIL** |
| navrail | row-closed-back | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL · focus ok | 0 | **FAIL** |
| navrail | ok-movies | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| navrail | ok-home | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |
| navrail | reopen | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | FAIL · focus ok | 0 | **FAIL** |
| browse | first-page | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| browse | focus-r2c3 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| browse | panel-open | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| browse | grid-down-12 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| browse | grid-down-up | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| browse | grid-down-right | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| browse | grid-rail-return | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

- hero/rest: dither ±2/255 [0, 0, 1920, 1080] — hero scrim gradient (hero-scrim.png stretched) — Android may dither the stretched 480x270 RGBA; only matters at threshold 0

## Failures

- **focusable/card-rest** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `focusable/card-rest/triptych.png`
- **focusable/card-lit** run 1: 3 differing px off the edge mask (bbox [1301, 290, 1302, 293]) — see `focusable/card-lit/triptych.png`
- **focusable/btn-primary-lit** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `focusable/btn-primary-lit/triptych.png`
- **focusable/btn-primary-rest** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `focusable/btn-primary-rest/triptych.png`
- **focusable/btn-secondary-lit** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `focusable/btn-secondary-lit/triptych.png`
- **focusable/btn-secondary-rest** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `focusable/btn-secondary-rest/triptych.png`
- **focusable/navitem-lit** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]); trace focus.ring: A step 1 at 16.0 ms = 0.638151, off B's curve [0, 0.591722] within +-28.2009 ms (|err| 0.0464 > 0.001) — see `focusable/navitem-lit/triptych.png`
- **focusable/navitem-lit-2** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `focusable/navitem-lit-2/triptych.png`
- **card/rest-home** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `card/rest-home/triptych.png`
- **card/size-frame** run 1: 3 differing px off the edge mask (bbox [1301, 290, 1302, 293]) — see `card/size-frame/triptych.png`
- **card/progress-bar** run 1: 3 differing px off the edge mask (bbox [1301, 290, 1302, 293]) — see `card/progress-bar/triptych.png`
- **card/size-frame-episode** run 1: 21 differing px off the edge mask (bbox [822, 279, 896, 292]) — see `card/size-frame-episode/triptych.png`
- **row/offset-0** run 1: trace no [anim] steps for row.tx in A — see `row/offset-0/triptych.png`
- **row/offset-1** run 1: trace no [anim] steps for row.tx in A — see `row/offset-1/triptych.png`
- **row/lead** run 1: trace no [anim] steps for row.tx in A — see `row/lead/triptych.png`
- **row/offset-5** run 1: trace no [anim] steps for row.tx in A — see `row/offset-5/triptych.png`
- **row/offset-10** run 1: trace no [anim] steps for row.tx in A — see `row/offset-10/triptych.png`
- **row/back-left** run 1: trace no [anim] steps for row.tx in A — see `row/back-left/triptych.png`
- **row/hold-right-12** run 1: trace no [anim] steps for row.tx in A — see `row/hold-right-12/triptych.png`
- **row/hold-right-end** run 1: trace no [anim] steps for row.tx in A — see `row/hold-right-end/triptych.png`
- **row/hold-right-left** run 1: trace no [anim] steps for row.tx in A — see `row/hold-right-left/triptych.png`
- **row/reentry-down** run 1: trace no [anim] steps for row.tx in A — see `row/reentry-down/triptych.png`
- **row/reentry-up** run 1: trace no [anim] steps for row.tx in A — see `row/reentry-up/triptych.png`
- **row/poster-row1-step** run 1: trace no [anim] steps for row.tx in A — see `row/poster-row1-step/triptych.png`
- **row/continue-rest** run 1: 3 differing px off the edge mask (bbox [1301, 290, 1302, 293]); trace no [anim] steps for row.tx in A — see `row/continue-rest/triptych.png`
- **row/continue-step** run 1: 21 differing px off the edge mask (bbox [822, 279, 896, 292]); trace no [anim] steps for row.tx in A — see `row/continue-step/triptych.png`
- **row/continue-step-2** run 1: 3 differing px off the edge mask (bbox [349, 290, 350, 293]); trace no [anim] steps for row.tx in A — see `row/continue-step-2/triptych.png`
- **row/pool-continue-far** run 1: 3 differing px off the edge mask (bbox [349, 290, 350, 293]) — see `row/pool-continue-far/triptych.png`
- **row/pool-continue-far-back** run 1: 3 differing px off the edge mask (bbox [1301, 290, 1302, 293]) — see `row/pool-continue-far-back/triptych.png`
- **hero/rest** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `hero/rest/triptych.png`
- **hero/scrolled** run 1: 3 differing px off the edge mask (bbox [1301, 290, 1302, 293]) — see `hero/scrolled/triptych.png`
- **hero/scrolled-back** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `hero/scrolled-back/triptych.png`
- **hero/first-slide** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `hero/first-slide/triptych.png`
- **hero/details-lit** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `hero/details-lit/triptych.png`
- **hero/back-from-row1** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `hero/back-from-row1/triptych.png`
- **hero/slide-then-scrolled** run 1: 3 differing px off the edge mask (bbox [1301, 290, 1302, 293]) — see `hero/slide-then-scrolled/triptych.png`
- **hero/slide-scrolled-back** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `hero/slide-scrolled-back/triptych.png`
- **hero/mid-fade-row0** run 1: 3 differing px off the edge mask (bbox [1301, 619, 1302, 622]) — see `hero/mid-fade-row0/triptych.png`
- **hero/mid-fade-row1** run 1: 3 differing px off the edge mask (bbox [1301, 427, 1302, 430]) — see `hero/mid-fade-row1/triptych.png`
- **navrail/closed** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/closed/triptych.png`
- **navrail/open** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]); trace rail.slide: B step 1 at 67.2 ms = 0.704003, off A's curve [0.794656, 0.941874] within +-28.2007 ms (|err| 0.0907 > 0.001); trace rail.slide: A step 1 at 36.0 ms = 0.785976, off B's curve [0.0817066, 0.672575] within +-28.2007 ms (|err| 0.113 > 0.001); trace rail.slide: settle time A=208.0 ms B=268.8 ms (> 53.2007 ms apart); trace rail.strip: B step 1 at 67.2 ms = 0.295997, off A's curve [0.0571388, 0.20245] within +-28.2007 ms (|err| 0.0935 > 0.001); trace rail.strip: A step 1 at 35.0 ms = 0.214024, off B's curve [0.337902, 0.928769] within +-28.2007 ms (|err| 0.124 > 0.001); trace rail.strip: settle time A=207.0 ms B=268.8 ms (> 53.2007 ms apart) — see `navrail/open/triptych.png`
- **navrail/item-search** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/item-search/triptych.png`
- **navrail/item-home** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/item-home/triptych.png`
- **navrail/item-movies** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/item-movies/triptych.png`
- **navrail/item-shows** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/item-shows/triptych.png`
- **navrail/item-list** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/item-list/triptych.png`
- **navrail/item-ai** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/item-ai/triptych.png`
- **navrail/item-settings** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/item-settings/triptych.png`
- **navrail/item-profile** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/item-profile/triptych.png`
- **navrail/item-profile-wrap** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/item-profile-wrap/triptych.png`
- **navrail/closed-again** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]); trace rail.slide: B step 1 at 16.8 ms = 0.787939, off A's curve [0.835847, 1] within +-25 ms (|err| 0.0479 > 0.001); trace rail.slide: A step 1 at 54.0 ms = 0.787939, off B's curve [0.243892, 0.638248] within +-25 ms (|err| 0.15 > 0.001); trace rail.strip: B step 1 at 16.8 ms = 0.212061, off A's curve [0, 0.161168] within +-25 ms (|err| 0.0509 > 0.001); trace rail.strip: A step 1 at 55.0 ms = 0.212061, off B's curve [0.374023, 0.762079] within +-25 ms (|err| 0.162 > 0.001) — see `navrail/closed-again/triptych.png`
- **navrail/mid-open** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]); trace rail.slide: B step 2 at 84.0 ms = 0.392988, off A's curve [0.419609, 0.476538] within +-25 ms (|err| 0.0266 > 0.0005); trace rail.slide: A step 1 at 36.0 ms = 0.392988, off B's curve [0.0638762, 0.324318] within +-25 ms (|err| 0.0687 > 0.0005); trace rail.slide: settle time A=209.0 ms B=285.6 ms (> 50 ms apart); trace rail.strip: B step 2 at 84.0 ms = 0.607012, off A's curve [0.523462, 0.580487] within +-25 ms (|err| 0.0265 > 0.0005); trace rail.strip: A step 1 at 37.0 ms = 0.607012, off B's curve [0.672697, 0.930317] within +-25 ms (|err| 0.0657 > 0.0005); trace rail.strip: settle time A=209.0 ms B=285.6 ms (> 50 ms apart) — see `navrail/mid-open/triptych.png`
- **navrail/closed-back** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]); trace rail.slide: B step 1 at 16.8 ms = 0.787939, off A's curve [0.829534, 1] within +-25 ms (|err| 0.0416 > 0.001); trace rail.slide: A step 1 at 52.0 ms = 0.787939, off B's curve [0.255831, 0.662786] within +-25 ms (|err| 0.125 > 0.001); trace rail.strip: B step 1 at 16.8 ms = 0.212061, off A's curve [0, 0.167249] within +-25 ms (|err| 0.0448 > 0.001); trace rail.strip: A step 1 at 53.0 ms = 0.212061, off B's curve [0.349484, 0.75014] within +-25 ms (|err| 0.137 > 0.001) — see `navrail/closed-back/triptych.png`
- **navrail/open-from-row** run 1: 3 differing px off the edge mask (bbox [1301, 290, 1302, 293]); trace rail.slide: B step 1 at 67.2 ms = 0.704003, off A's curve [0.798836, 0.917581] within +-28.2007 ms (|err| 0.0948 > 0.001); trace rail.slide: A step 1 at 37.0 ms = 0.785976, off B's curve [0.0921828, 0.683051] within +-28.2007 ms (|err| 0.103 > 0.001); trace rail.strip: B step 1 at 67.2 ms = 0.295997, off A's curve [0.0824194, 0.20245] within +-28.2007 ms (|err| 0.0935 > 0.001); trace rail.strip: A step 1 at 37.0 ms = 0.214024, off B's curve [0.316949, 0.907817] within +-28.2007 ms (|err| 0.103 > 0.001) — see `navrail/open-from-row/triptych.png`
- **navrail/row-closed-again** run 1: 3 differing px off the edge mask (bbox [1301, 290, 1302, 293]); trace rail.slide: A step 4 at 41.0 ms = 0.295997, off B's curve [0.321515, 0.798043] within +-25 ms (|err| 0.0255 > 0.001); trace rail.strip: B step 5 at 100.8 ms = 0.843844, off A's curve [0.84553, 0.94016] within +-25 ms (|err| 0.00169 > 0.001); trace rail.strip: A step 4 at 40.0 ms = 0.704003, off B's curve [0.189335, 0.672515] within +-25 ms (|err| 0.0315 > 0.001) — see `navrail/row-closed-again/triptych.png`
- **navrail/row-closed-back** run 1: 3 differing px off the edge mask (bbox [1301, 290, 1302, 293]); trace rail.slide: B step 3 at 50.4 ms = 0.414653, off A's curve [0.124883, 0.313263] within +-25 ms (|err| 0.101 > 0.001); trace rail.slide: A step 3 at 16.0 ms = 0.414653, off B's curve [0.508167, 1] within +-25 ms (|err| 0.0935 > 0.001); trace rail.strip: B step 3 at 50.4 ms = 0.585347, off A's curve [0.686737, 0.873471] within +-25 ms (|err| 0.101 > 0.001); trace rail.strip: A step 3 at 16.0 ms = 0.585347, off B's curve [0, 0.491833] within +-25 ms (|err| 0.0935 > 0.001) — see `navrail/row-closed-back/triptych.png`
- **navrail/ok-home** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `navrail/ok-home/triptych.png`
- **navrail/reopen** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]); trace rail.slide: B step 1 at 67.2 ms = 0.704003, off A's curve [0.819479, 0.931717] within +-28.2002 ms (|err| 0.115 > 0.001); trace rail.slide: A step 1 at 28.0 ms = 0.785976, off B's curve [0, 0.588765] within +-28.2002 ms (|err| 0.197 > 0.001); trace rail.slide: settle time A=213.0 ms B=268.8 ms (> 53.2002 ms apart); trace rail.strip: B step 1 at 67.2 ms = 0.295997, off A's curve [0.0691391, 0.180521] within +-28.2002 ms (|err| 0.115 > 0.001); trace rail.strip: A step 1 at 28.0 ms = 0.214024, off B's curve [0.411235, 1] within +-28.2002 ms (|err| 0.197 > 0.001); trace rail.strip: settle time A=213.0 ms B=268.8 ms (> 53.2002 ms apart) — see `navrail/reopen/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

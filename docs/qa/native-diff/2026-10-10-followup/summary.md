# TV pixel diff — 2026-10-10

**66 pass · 10 fail · 5 skipped** — impl `FCRHN`, states `focusable,card,row,hero,navrail`, runs 1

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | 616f35f9f487 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=- exp=cull+cardlayer+shadowcache+unstuff |
| server flags declared | (none) |
| started / finished | 2026-10-10T18:56:33 / 2026-10-10T19:41:36 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| focusable | card-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | card-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok | 0 | PASS |
| focusable | btn-primary-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | btn-primary-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | btn-secondary-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | btn-secondary-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-on-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | chip-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-surface-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | navitem-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | navitem-lit-2 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | sources-row-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | sources-row-lit-2 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | rest-home | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-frame | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok | 0 | PASS |
| card | progress-bar | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | - | 0 | PASS |
| card | size-frame-episode | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | - | 0 | PASS |
| card | size-poster | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | kind-tag | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-poster-row2 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | grid-rest | 1 | FCRHN | 344461 | 226995 | 0.05665 | 248 | - | 0 | **FAIL** |
| card | grid-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | new-tag | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | new-tag-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-wide | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with fixture (declare --server <flag>) |
| card | size-compact | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with aiMock (declare --server <flag>) |
| card | blur-up | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with artDelay (declare --server <flag>) |
| card | broken-tile | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with artFail (declare --server <flag>) |
| row | offset-0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | offset-1 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | lead | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | offset-5 | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | ok · focus ok | 0 | PASS |
| row | offset-9 | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | - · focus ok | 0 | PASS |
| row | offset-10 | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | back-left | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | hold-right-12 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-end | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-left | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | reentry-down | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | reentry-up | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | left-at-0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | left-at-0-return | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | poster-row1-step | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | continue-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | continue-step | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | continue-step-2 | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| hero | rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 1 | PASS |
| hero | scrolled | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| hero | scrolled-back | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | first-slide | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| hero | details-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| hero | scrolled-row1 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | scrolled-row3 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | down-burst-4 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| hero | back-from-row1 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | slide-then-scrolled | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | slide-scrolled-back | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | mid-fade-row0 | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok | 0 | PASS |
| hero | mid-fade-row1 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | mute-pill | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with fixtureTrailer (declare --server <flag>) |
| navrail | closed | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | open | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| navrail | item-search | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-home | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-movies | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-shows | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-list | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-ai | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-settings | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-profile | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-profile-wrap | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | closed-again | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| navrail | mid-open | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL | 0 | **FAIL** |
| navrail | closed-back | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| navrail | open-from-row | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| navrail | row-closed-again | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | FAIL · focus ok | 0 | **FAIL** |
| navrail | row-closed-back | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | FAIL · focus ok | 0 | **FAIL** |
| navrail | ok-movies | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| navrail | ok-home | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | reopen | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |

## Masks and dither regions (what was not compared, or compared loosely)

- hero/rest: dither ±2/255 [0, 0, 1920, 1080] — hero scrim gradient (hero-scrim.png stretched) — Android may dither the stretched 480x270 RGBA; only matters at threshold 0

## Failures

- **card/grid-rest** run 1: 226995 differing px off the edge mask (bbox [57, 45, 1818, 1080]); on-edge diff fraction 0.056648 > 0.0005 — see `card/grid-rest/triptych.png`
- **hero/first-slide** run 1: trace hero.swap: A step 6 at 101.0 ms = 0.843844, off B's curve [0.628854, 0.840455] within +-25 ms (|err| 0.00339 > 0.001) — see `hero/first-slide/triptych.png`
- **navrail/open** run 1: trace rail.slide: B step 2 at 67.2 ms = 0.704003, off A's curve [0.804669, 0.909177] within +-25 ms (|err| 0.101 > 0.001); trace rail.slide: A step 1 at 38.0 ms = 0.785976, off B's curve [0.150984, 0.674344] within +-25 ms (|err| 0.112 > 0.001); trace rail.strip: B step 2 at 67.2 ms = 0.295997, off A's curve [0.0896686, 0.19088] within +-25 ms (|err| 0.105 > 0.001); trace rail.strip: A step 1 at 37.0 ms = 0.214024, off B's curve [0.332719, 0.86063] within +-25 ms (|err| 0.119 > 0.001) — see `navrail/open/triptych.png`
- **navrail/closed-again** run 1: trace rail.slide: B step 1 at 16.8 ms = 0.787939, off A's curve [0.819116, 1] within +-112 ms (|err| 0.0312 > 0.001); trace rail.slide: A step 1 at 151.0 ms = 0.787939, off B's curve [0.00120613, 0.528068] within +-112 ms (|err| 0.26 > 0.001); trace rail.strip: B step 1 at 16.8 ms = 0.212061, off A's curve [0, 0.181089] within +-113 ms (|err| 0.031 > 0.001); trace rail.strip: A step 1 at 152.0 ms = 0.212061, off B's curve [0.471932, 0.999013] within +-113 ms (|err| 0.26 > 0.001) — see `navrail/closed-again/triptych.png`
- **navrail/mid-open** run 1: trace rail.slide: B step 1 at 67.2 ms = 0.352002, off A's curve [0.392988, 0.461017] within +-28.199 ms (|err| 0.041 > 0.0005); trace rail.slide: A step 1 at 39.0 ms = 0.392988, off B's curve [0.056578, 0.352002] within +-28.199 ms (|err| 0.041 > 0.0005); trace rail.strip: B step 1 at 67.2 ms = 0.647998, off A's curve [0.538247, 0.607012] within +-28.199 ms (|err| 0.041 > 0.0005); trace rail.strip: A step 1 at 39.0 ms = 0.607012, off B's curve [0.647998, 0.943422] within +-28.199 ms (|err| 0.041 > 0.0005) — see `navrail/mid-open/triptych.png`
- **navrail/closed-back** run 1: trace rail.slide: B step 1 at 16.8 ms = 0.787939, off A's curve [0.821328, 1] within +-102 ms (|err| 0.0334 > 0.001); trace rail.slide: A step 1 at 141.0 ms = 0.787939, off B's curve [0.00420678, 0.528067] within +-102 ms (|err| 0.26 > 0.001); trace rail.strip: B step 1 at 16.8 ms = 0.212061, off A's curve [0, 0.178672] within +-102 ms (|err| 0.0334 > 0.001); trace rail.strip: A step 1 at 141.0 ms = 0.212061, off B's curve [0.471933, 0.995793] within +-102 ms (|err| 0.26 > 0.001) — see `navrail/closed-back/triptych.png`
- **navrail/open-from-row** run 1: trace rail.slide: B step 1 at 67.2 ms = 0.704003, off A's curve [0.712862, 0.92452] within +-28.2 ms (|err| 0.00886 > 0.001); trace rail.slide: A step 1 at 43.0 ms = 0.785976, off B's curve [0.155048, 0.72352] within +-28.2 ms (|err| 0.0625 > 0.001); trace rail.slide: settle time A=228.0 ms B=285.6 ms (> 53.2 ms apart); trace rail.strip: B step 1 at 67.2 ms = 0.295997, off A's curve [0.0754798, 0.287138] within +-28.2 ms (|err| 0.00886 > 0.001); trace rail.strip: A step 1 at 43.0 ms = 0.214024, off B's curve [0.27648, 0.844952] within +-28.2 ms (|err| 0.0625 > 0.001); trace rail.strip: settle time A=228.0 ms B=285.6 ms (> 53.2 ms apart) — see `navrail/open-from-row/triptych.png`
- **navrail/row-closed-again** run 1: trace rail.slide: A step 4 at 42.0 ms = 0.295997, off B's curve [0.315529, 0.785483] within +-25 ms (|err| 0.0195 > 0.001); trace rail.strip: A step 4 at 43.0 ms = 0.704003, off B's curve [0.226788, 0.690443] within +-25 ms (|err| 0.0136 > 0.001) — see `navrail/row-closed-again/triptych.png`
- **navrail/row-closed-back** run 1: trace rail.slide: B step 3 at 50.4 ms = 0.414653, off A's curve [0.129834, 0.349053] within +-25 ms (|err| 0.0656 > 0.001); trace rail.slide: A step 3 at 16.0 ms = 0.414653, off B's curve [0.508161, 1] within +-25 ms (|err| 0.0935 > 0.001); trace rail.strip: B step 3 at 50.4 ms = 0.585347, off A's curve [0.650947, 0.870166] within +-25 ms (|err| 0.0656 > 0.001); trace rail.strip: A step 3 at 16.0 ms = 0.585347, off B's curve [0, 0.491839] within +-25 ms (|err| 0.0935 > 0.001) — see `navrail/row-closed-back/triptych.png`
- **navrail/reopen** run 1: trace rail.slide: B step 1 at 67.2 ms = 0.704003, off A's curve [0.758652, 0.926933] within +-28.1986 ms (|err| 0.0546 > 0.001); trace rail.slide: A step 1 at 27.0 ms = 0.704003, off B's curve [0, 0.578286] within +-28.1986 ms (|err| 0.126 > 0.001); trace rail.strip: B step 1 at 67.2 ms = 0.295997, off A's curve [0.0734209, 0.241348] within +-28.1986 ms (|err| 0.0546 > 0.001); trace rail.strip: A step 1 at 27.0 ms = 0.295997, off B's curve [0.421714, 1] within +-28.1986 ms (|err| 0.126 > 0.001) — see `navrail/reopen/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

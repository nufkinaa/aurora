# TV pixel diff — 2026-10-17

**8 pass · 3 fail · 0 skipped** — impl `FCRHN`, states `focusable,card,row,hero,navrail,states/app.json`, runs 1

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
| started / finished | 2026-10-17T19:06:25 / 2026-10-17T19:12:07 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| focusable | card-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | rest-home | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | progress-bar | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | - | 0 | PASS |
| card | size-frame-episode | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | - | 0 | PASS |
| row | continue-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | FAIL · focus ok | 0 | **FAIL** |
| row | continue-step | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | FAIL · focus ok | 0 | **FAIL** |
| hero | rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 1 | PASS |
| hero | mid-fade-row1 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| navrail | open | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | FAIL · focus ok | 0 | **FAIL** |
| navrail | item-home | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-rail-home | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

- hero/rest: dither ±2/255 [0, 0, 1920, 1080] — hero scrim gradient (hero-scrim.png stretched) — Android may dither the stretched 480x270 RGBA; only matters at threshold 0

## Failures

- **row/continue-rest** run 1: trace no [anim] steps for row.tx in A — see `row/continue-rest/triptych.png`
- **row/continue-step** run 1: trace no [anim] steps for row.tx in A — see `row/continue-step/triptych.png`
- **navrail/open** run 1: trace rail.slide: B step 2 at 84.0 ms = 0.785976, off A's curve [0.849445, 0.951686] within +-28.2 ms (|err| 0.0635 > 0.001); trace rail.slide: A step 1 at 44.0 ms = 0.785976, off B's curve [0.165525, 0.7284] within +-28.2 ms (|err| 0.0576 > 0.001); trace rail.strip: B step 1 at 67.2 ms = 0.295997, off A's curve [0.0688175, 0.287138] within +-28.2 ms (|err| 0.00886 > 0.001); trace rail.strip: A step 1 at 43.0 ms = 0.214024, off B's curve [0.27648, 0.844952] within +-28.2 ms (|err| 0.0625 > 0.001); trace rail.strip: settle time A=215.0 ms B=268.8 ms (> 53.2 ms apart) — see `navrail/open/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

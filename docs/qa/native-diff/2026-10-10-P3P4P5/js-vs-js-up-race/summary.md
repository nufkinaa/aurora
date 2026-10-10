# TV pixel diff — 2026-10-10

**2 pass · 2 fail · 0 skipped** — impl `-`, states `hero`, runs 4

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | a143637e9198 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=FC |
| server flags declared | (none) |
| started / finished | 2026-10-10T03:24:43 / 2026-10-10T03:27:00 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| hero | scrolled-back | 1 | - | 287029 | 242633 | 0.02141 | 249 | FAIL | 0 | **FAIL** |
| hero | scrolled-back | 2 | - | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | scrolled-back | 3 | - | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | scrolled-back | 4 | - | 287029 | 262046 | 0.01205 | 249 | FAIL | 0 | **FAIL** |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **hero/scrolled-back** run 1: 242633 differing px off the edge mask (bbox [0, 0, 550, 1080]); on-edge diff fraction 0.021410 > 0.0005; trace hero.atTop: B step 4 at 4.0 ms = 0.785976, off A's curve [0, 0.640967] within +-61 ms (|err| 0.145 > 0.001); trace hero.atTop: A step 4 at 82.0 ms = 0.704003, off B's curve [0.802955, 0.994584] within +-61 ms (|err| 0.099 > 0.001); trace hero.ty: B step 4 at 5.0 ms = -177.514, off A's curve [-329, -233.355] within +-60 ms (|err| 55.8 > 0.329); trace hero.ty: A step 4 at 82.0 ms = -213.248, off B's curve [-167.524, -49.3119] within +-60 ms (|err| 45.7 > 0.329) — see `hero/scrolled-back/triptych.png`
- **hero/scrolled-back** run 4: 262046 differing px off the edge mask (bbox [0, 0, 550, 1080]); on-edge diff fraction 0.012048 > 0.0005; trace hero.atTop: B step 9 at 210.0 ms = 0.981735, off A's curve [0.990682, 1] within +-57 ms (|err| 0.00895 > 0.001); trace hero.atTop: A step 5 at 144.0 ms = 0.989082, off B's curve [0.737758, 0.977804] within +-57 ms (|err| 0.0113 > 0.001) — see `hero/scrolled-back/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

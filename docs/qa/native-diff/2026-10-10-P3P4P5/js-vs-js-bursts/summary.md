# TV pixel diff — 2026-10-10

**3 pass · 3 fail · 0 skipped** — impl `-`, states `app`, runs 2

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | a143637e9198 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=- |
| server flags declared | (none) |
| started / finished | 2026-10-10T04:03:05 / 2026-10-10T04:07:17 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| app | home-down-hold-8 | 1 | - | 931924 | 661656 | 0.13034 | 255 | - · focus ok | 0 | **FAIL** |
| app | home-down-hold-8 | 2 | - | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | rail-to-settings | 1 | - | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | rail-to-settings | 2 | - | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-grid-hold | 1 | - | 256840 | 103576 | 0.07391 | 255 | - · focus ok | 0 | **FAIL** |
| app | movies-grid-hold | 2 | - | 1108806 | 851557 | 0.12406 | 255 | - · focus FAIL | 0 | **FAIL** |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **app/home-down-hold-8** run 1: 661656 differing px off the edge mask (bbox [161, 0, 1794, 1080]); on-edge diff fraction 0.130338 > 0.0005 — see `app/home-down-hold-8/triptych.png`
- **app/movies-grid-hold** run 1: 103576 differing px off the edge mask (bbox [164, 136, 1784, 1080]); on-edge diff fraction 0.073912 > 0.0005 — see `app/movies-grid-hold/triptych.png`
- **app/movies-grid-hold** run 2: 851557 differing px off the edge mask (bbox [161, 136, 1786, 1080]); on-edge diff fraction 0.124059 > 0.0005; focus table differs (20 vs 18 rows) — see `app/movies-grid-hold/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

# TV pixel diff — 2026-10-17

**12 pass · 3 fail · 0 skipped** — impl `FCRHN`, states `states/app.json`, runs 1

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
| started / finished | 2026-10-17T18:55:19 / 2026-10-17T19:05:41 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| app | home-down-6 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-down-4-up-2 | 1 | FCRHN | 0 | 0 | 0.00000 | 3 | - · focus ok | 0 | PASS |
| app | home-down-hold-8 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-row-hold | 1 | FCRHN | 0 | 0 | 0.00000 | 3 | - · focus ok | 0 | PASS |
| app | home-row-then-down | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-open-title | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-title-back | 1 | FCRHN | 0 | 0 | 0.00000 | 3 | - · focus ok | 0 | PASS |
| app | rail-to-shows | 1 | FCRHN | 0 | 0 | 0.00000 | 8 | - · focus ok | 0 | PASS |
| app | rail-to-settings | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus FAIL | 0 | **FAIL** |
| app | movies-grid-walk | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-grid-hold | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus FAIL | 0 | **FAIL** |
| app | movies-open-title | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-title-back | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-rail-open | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-rail-home | 1 | FCRHN | 532 | 3 | 0.00026 | 50 | - · focus ok | 0 | **FAIL** |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **app/rail-to-settings** run 1: focus table differs (19 vs 16 rows) — see `app/rail-to-settings/triptych.png`
- **app/movies-grid-hold** run 1: focus table differs (20 vs 16 rows) — see `app/movies-grid-hold/triptych.png`
- **app/movies-rail-home** run 1: 3 differing px off the edge mask (bbox [1301, 948, 1302, 951]) — see `app/movies-rail-home/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

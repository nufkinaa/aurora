# TV pixel diff — 2026-10-10

**1 pass · 2 fail · 0 skipped** — impl `FCRHN`, states `app`, runs 3

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | a143637e9198 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=F |
| server flags declared | (none) |
| started / finished | 2026-10-10T04:08:55 / 2026-10-10T04:10:53 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| app | rail-to-settings | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | rail-to-settings | 2 | FCRHN | 33027 | 7380 | 0.01237 | 230 | - · focus FAIL | 0 | **FAIL** |
| app | rail-to-settings | 3 | FCRHN | 33027 | 7380 | 0.01237 | 230 | - · focus FAIL | 0 | **FAIL** |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **app/rail-to-settings** run 2: 7380 differing px off the edge mask (bbox [165, 376, 1824, 799]); on-edge diff fraction 0.012368 > 0.0005; focus table differs (17 vs 18 rows) — see `app/rail-to-settings/triptych.png`
- **app/rail-to-settings** run 3: 7380 differing px off the edge mask (bbox [165, 376, 1824, 799]); on-edge diff fraction 0.012368 > 0.0005; focus table differs (17 vs 18 rows) — see `app/rail-to-settings/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

# TV pixel diff — 2026-10-10

**7 pass · 0 fail · 0 skipped** — impl `G`, states `browse`, runs 1

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | 3ad862322624 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=- exp=pool |
| server flags declared | (none) |
| started / finished | 2026-10-10T23:18:39 / 2026-10-10T23:26:18 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| browse | first-page | 1 | G | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| browse | focus-r2c3 | 1 | G | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| browse | panel-open | 1 | G | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| browse | grid-down-12 | 1 | G | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| browse | grid-down-up | 1 | G | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| browse | grid-down-right | 1 | G | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| browse | grid-rail-return | 1 | G | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

none

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

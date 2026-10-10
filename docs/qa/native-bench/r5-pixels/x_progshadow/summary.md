# TV pixel diff — 2026-10-10

**0 pass · 3 fail · 0 skipped** — impl `(per file)`, states `tools/tv-pixel-diff/states/render.json`, runs 1

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | 94e492caa134 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=FCRHN exp=- |
| server flags declared | (none) |
| started / finished | 2026-10-10T11:35:59 / 2026-10-10T11:37:44 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| render | hero-rest | 1 | FCRHN | 94 | 14 | 0.00004 | 46 | - | 0 | **FAIL** |
| render | row0-card0 | 1 | FCRHN | 97 | 15 | 0.00004 | 46 | - | 0 | **FAIL** |
| render | row0-card2 | 1 | FCRHN | 69 | 10 | 0.00003 | 46 | - | 0 | **FAIL** |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **render/hero-rest** run 1: 14 differing px off the edge mask (bbox [432, 1057, 1834, 1059]) — see `render/hero-rest/triptych.png`
- **render/row0-card0** run 1: 15 differing px off the edge mask (bbox [434, 399, 1834, 401]) — see `render/row0-card0/triptych.png`
- **render/row0-card2** run 1: 10 differing px off the edge mask (bbox [200, 399, 1358, 401]) — see `render/row0-card2/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

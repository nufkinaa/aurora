# TV pixel diff — 2026-10-10

**10 pass · 1 fail · 0 skipped** — impl `(per file)`, states `tools/tv-pixel-diff/states/render.json`, runs 1

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | 94e492caa134 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=- exp=cull |
| server flags declared | (none) |
| started / finished | 2026-10-10T10:27:14 / 2026-10-10T10:33:46 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| render | hero-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | - | 0 | PASS |
| render | hero-details | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | - | 0 | PASS |
| render | row0-card0 | 1 | FCRHN | 252 | 0 | 0.00012 | 100 | - | 0 | PASS |
| render | row0-card2 | 1 | FCRHN | 20 | 0 | 0.00001 | 98 | - | 0 | PASS |
| render | row1-card0 | 1 | FCRHN | 2 | 0 | 0.00000 | 35 | - | 0 | PASS |
| render | row1-card3 | 1 | FCRHN | 0 | 0 | 0.00000 | 25 | - | 0 | PASS |
| render | row2-card0 | 1 | FCRHN | 0 | 0 | 0.00000 | 32 | - | 0 | PASS |
| render | row2-hold-12 | 1 | FCRHN | 5 | 0 | 0.00000 | 32 | - | 0 | PASS |
| render | row3-and-back | 1 | FCRHN | 2 | 0 | 0.00000 | 35 | - | 0 | PASS |
| render | hero-back | 1 | FCRHN | 287029 | 242633 | 0.02141 | 249 | - | 0 | **FAIL** |
| render | rail-from-row | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | - | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **render/hero-back** run 1: 242633 differing px off the edge mask (bbox [0, 0, 550, 1080]); on-edge diff fraction 0.021410 > 0.0005 — see `render/hero-back/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

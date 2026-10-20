# TV pixel diff — 2026-10-20

**2 pass · 0 fail · 0 skipped** — impl `FCRHN`, states `states/render.json`, runs 2

| field | value |
|---|---|
| APK versionCode | 119 (5.3.0) `com.auroratv` |
| commit | 8787008ebd7f |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=119 impl=FCRHN exp=cardlayer+cull+shadowcache+unstuff+pool+keyrate+cardtext+ringshare+herotext src=saved |
| server flags declared | (none) |
| started / finished | 2026-10-20T04:30:27 / 2026-10-20T04:31:55 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| render | rail-from-row | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | rail-from-row | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

none

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

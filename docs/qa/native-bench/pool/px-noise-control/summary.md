# TV pixel diff — 2026-10-11

**24 pass · 0 fail · 0 skipped** — impl `FCRHN`, states `row`, runs 3

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | 3ad862322624 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=- exp=cull+cardlayer+shadowcache+unstuff+pool |
| server flags declared | (none) |
| started / finished | 2026-10-11T01:09:04 / 2026-10-11T01:27:25 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| row | offset-5 | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | ok · focus ok | 0 | PASS |
| row | offset-5 | 2 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | offset-5 | 3 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | offset-9 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | offset-9 | 2 | FCRHN | 0 | 0 | 0.00000 | 1 | - · focus ok | 0 | PASS |
| row | offset-9 | 3 | FCRHN | 0 | 0 | 0.00000 | 1 | - · focus ok | 0 | PASS |
| row | offset-10 | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | ok · focus ok | 0 | PASS |
| row | offset-10 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | offset-10 | 3 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | back-left | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | back-left | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | back-left | 3 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | poster-row1-step | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | poster-row1-step | 2 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | poster-row1-step | 3 | FCRHN | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | continue-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | continue-rest | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | continue-rest | 3 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | pool-wrap-shadow | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-wrap-shadow | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-wrap-shadow | 3 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-continue-far | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-continue-far | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-continue-far | 3 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

none

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

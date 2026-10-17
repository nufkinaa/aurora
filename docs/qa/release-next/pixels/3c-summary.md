# TV pixel diff — 2026-10-17

**32 pass · 1 fail · 0 skipped** — impl `FCRHN`, states `row,states/render.json`, runs 1

| field | value |
|---|---|
| APK versionCode | 102 (5.2.0) `com.auroratv` |
| commit | 0e97cf2f2f52 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=102 impl=- exp=cardlayer+cull+shadowcache+unstuff+pool+ringshare src=qa |
| server flags declared | (none) |
| started / finished | 2026-10-17T23:46:03 / 2026-10-18T00:06:39 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| row | offset-0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | offset-1 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | lead | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | offset-5 | 1 | FCRHN | 38650 | 26877 | 0.00568 | 255 | ok · focus ok | 0 | **FAIL** |
| row | offset-9 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | offset-10 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | back-left | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | hold-right-12 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-end | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-left | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | reentry-down | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | reentry-up | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | left-at-0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | left-at-0-return | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | poster-row1-step | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | continue-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | continue-step | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | continue-step-2 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | pool-wrap-shadow | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-hold-right-left-end | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-continue-far | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-continue-far-back | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| render | hero-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | hero-details | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-card0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-card2 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row1-card0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row1-card3 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row2-card0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row2-hold-12 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row3-and-back | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-back | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | rail-from-row | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **row/offset-5** run 1: 26877 differing px off the edge mask (bbox [170, 0, 1920, 36]); on-edge diff fraction 0.005678 > 0.0005 — see `row/offset-5/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

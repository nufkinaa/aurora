# TV pixel diff — 2026-10-20

**14 pass · 2 fail · 0 skipped** — impl `FCRHN`, states `states/app.json,row`, runs 2

| field | value |
|---|---|
| APK versionCode | 118 (5.3.0) `com.auroratv` |
| commit | 8342ef555cd8 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=118 impl=- exp=cardlayer+cull+shadowcache+unstuff+pool+cardtext+ringshare+herotext src=qa |
| server flags declared | (none) |
| started / finished | 2026-10-20T02:24:20 / 2026-10-20T02:37:14 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| app | home-down-hold-8 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-down-hold-8 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-row-hold | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-row-hold | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-grid-hold | 1 | FCRHN | 170104 | 24784 | 0.07008 | 252 | - · focus ok | 0 | **FAIL** |
| app | movies-grid-hold | 2 | FCRHN | 81599 | 3992 | 0.03743 | 215 | - · focus ok | 0 | **FAIL** |
| row | hold-right-12 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-12 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-end | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-end | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-left | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-left | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | left-at-0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | left-at-0 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | left-at-0-return | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | left-at-0-return | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **app/movies-grid-hold** run 1: 24784 differing px off the edge mask (bbox [169, 136, 1782, 1080]); on-edge diff fraction 0.070081 > 0.0005 — see `app/movies-grid-hold/triptych.png`
- **app/movies-grid-hold** run 2: 3992 differing px off the edge mask (bbox [170, 136, 1775, 1080]); on-edge diff fraction 0.037426 > 0.0005 — see `app/movies-grid-hold/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

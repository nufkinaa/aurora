# TV pixel diff — 2026-10-20

**0 pass · 2 fail · 0 skipped** — impl `FCRHN`, states `states/app.json`, runs 2

| field | value |
|---|---|
| APK versionCode | 118 (5.3.0) `com.auroratv` |
| commit | 8342ef555cd8 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=118 impl=- exp=cardlayer+cull+shadowcache+unstuff+pool+keyrate+ringshare+herotext src=qa |
| server flags declared | (none) |
| started / finished | 2026-10-20T02:37:20 / 2026-10-20T02:39:05 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| app | movies-grid-hold | 1 | FCRHN | 170506 | 26123 | 0.06963 | 252 | - · focus ok | 0 | **FAIL** |
| app | movies-grid-hold | 2 | FCRHN | 170506 | 26123 | 0.06963 | 252 | - · focus ok | 0 | **FAIL** |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **app/movies-grid-hold** run 1: 26123 differing px off the edge mask (bbox [169, 136, 1784, 1080]); on-edge diff fraction 0.069629 > 0.0005 — see `app/movies-grid-hold/triptych.png`
- **app/movies-grid-hold** run 2: 26123 differing px off the edge mask (bbox [169, 136, 1784, 1080]); on-edge diff fraction 0.069629 > 0.0005 — see `app/movies-grid-hold/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

# TV pixel diff — 2026-10-20

**10 pass · 3 fail · 1 skipped** — impl `FCRHN`, states `hero`, runs 1

| field | value |
|---|---|
| APK versionCode | 118 (5.3.0) `com.auroratv` |
| commit | 8342ef555cd8 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=118 impl=- exp=cardlayer+cull+shadowcache+unstuff+pool+ringshare+herotext src=qa |
| server flags declared | (none) |
| started / finished | 2026-10-20T02:39:15 / 2026-10-20T02:47:26 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| hero | rest | 1 | FCRHN | 8 | 0 | 0.00000 | 95 | - | 1 | PASS |
| hero | scrolled | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | scrolled-back | 1 | FCRHN | 8 | 0 | 0.00000 | 95 | ok | 0 | PASS |
| hero | first-slide | 1 | FCRHN | 63 | 48 | 0.00001 | 139 | ok · focus ok | 0 | **FAIL** |
| hero | details-lit | 1 | FCRHN | 8 | 0 | 0.00000 | 95 | - · focus ok | 0 | PASS |
| hero | scrolled-row1 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | scrolled-row3 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | down-burst-4 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| hero | back-from-row1 | 1 | FCRHN | 8 | 0 | 0.00000 | 95 | ok · focus ok | 0 | PASS |
| hero | slide-then-scrolled | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | slide-scrolled-back | 1 | FCRHN | 63 | 48 | 0.00001 | 139 | ok | 0 | **FAIL** |
| hero | mid-fade-row0 | 1 | FCRHN | 11 | 7 | 0.00000 | 92 | FAIL | 0 | **FAIL** |
| hero | mid-fade-row1 | 1 | FCRHN | 514 | 0 | 0.00025 | 96 | ok | 0 | PASS |
| hero | mute-pill | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with fixtureTrailer (declare --server <flag>) |

## Masks and dither regions (what was not compared, or compared loosely)

- hero/rest: dither ±2/255 [0, 0, 1920, 1080] — hero scrim gradient (hero-scrim.png stretched) — Android may dither the stretched 480x270 RGBA; only matters at threshold 0

## Failures

- **hero/first-slide** run 1: 48 differing px off the edge mask (bbox [734, 382, 756, 386]) — see `hero/first-slide/triptych.png`
- **hero/slide-scrolled-back** run 1: 48 differing px off the edge mask (bbox [734, 382, 756, 386]) — see `hero/slide-scrolled-back/triptych.png`
- **hero/mid-fade-row0** run 1: 7 differing px off the edge mask (bbox [379, 53, 386, 54]); trace hero.art: A step 4 at 117.6 ms = 1, off B's curve [0.931573, 0.997675] within +-45 ms (|err| 0.00233 > 0.00027) — see `hero/mid-fade-row0/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

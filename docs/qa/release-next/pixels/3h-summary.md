# TV pixel diff — 2026-10-17

**48 pass · 0 fail · 2 skipped** — impl `FCRHN`, states `hero,states/render.json`, runs 2

| field | value |
|---|---|
| APK versionCode | 102 (5.2.0) `com.auroratv` |
| commit | 0e97cf2f2f52 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=102 impl=- exp=cardlayer+cull+shadowcache+unstuff+pool src=qa |
| server flags declared | (none) |
| started / finished | 2026-10-17T22:52:09 / 2026-10-17T23:18:28 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| hero | rest | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | - | 1 | PASS |
| hero | rest | 2 | FCRHN | 0 | 0 | 0.00000 | 2 | - | 1 | PASS |
| hero | scrolled | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | scrolled | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | scrolled-back | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | ok | 0 | PASS |
| hero | scrolled-back | 2 | FCRHN | 0 | 0 | 0.00000 | 2 | ok | 0 | PASS |
| hero | first-slide | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | ok · focus ok | 0 | PASS |
| hero | first-slide | 2 | FCRHN | 0 | 0 | 0.00000 | 2 | ok · focus ok | 0 | PASS |
| hero | details-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | - · focus ok | 0 | PASS |
| hero | details-lit | 2 | FCRHN | 0 | 0 | 0.00000 | 2 | - · focus ok | 0 | PASS |
| hero | scrolled-row1 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | scrolled-row1 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | scrolled-row3 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | scrolled-row3 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | down-burst-4 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| hero | down-burst-4 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| hero | back-from-row1 | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | ok · focus ok | 0 | PASS |
| hero | back-from-row1 | 2 | FCRHN | 0 | 0 | 0.00000 | 2 | ok · focus ok | 0 | PASS |
| hero | slide-then-scrolled | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | slide-then-scrolled | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | slide-scrolled-back | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | ok | 0 | PASS |
| hero | slide-scrolled-back | 2 | FCRHN | 0 | 0 | 0.00000 | 2 | ok | 0 | PASS |
| hero | mid-fade-row0 | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | ok | 0 | PASS |
| hero | mid-fade-row0 | 2 | FCRHN | 0 | 0 | 0.00000 | 2 | ok | 0 | PASS |
| hero | mid-fade-row1 | 1 | FCRHN | 672 | 0 | 0.00032 | 104 | ok | 0 | PASS |
| hero | mid-fade-row1 | 2 | FCRHN | 672 | 0 | 0.00032 | 104 | ok | 0 | PASS |
| hero | mute-pill | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with fixtureTrailer (declare --server <flag>) |
| hero | mute-pill | 2 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with fixtureTrailer (declare --server <flag>) |
| render | hero-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | - | 0 | PASS |
| render | hero-rest | 2 | FCRHN | 0 | 0 | 0.00000 | 2 | - | 0 | PASS |
| render | hero-details | 1 | FCRHN | 0 | 0 | 0.00000 | 2 | - | 0 | PASS |
| render | hero-details | 2 | FCRHN | 0 | 0 | 0.00000 | 2 | - | 0 | PASS |
| render | row0-card0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-card0 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-card2 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-card2 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row1-card0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row1-card0 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row1-card3 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row1-card3 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row2-card0 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row2-card0 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row2-hold-12 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row2-hold-12 | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row3-and-back | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row3-and-back | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-back | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-back | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | rail-from-row | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | rail-from-row | 2 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

- hero/rest: dither ±2/255 [0, 0, 1920, 1080] — hero scrim gradient (hero-scrim.png stretched) — Android may dither the stretched 480x270 RGBA; only matters at threshold 0
- hero/rest: dither ±2/255 [0, 0, 1920, 1080] — hero scrim gradient (hero-scrim.png stretched) — Android may dither the stretched 480x270 RGBA; only matters at threshold 0

## Failures

none

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

# TV pixel diff — 2026-10-10

**29 pass · 4 fail · 4 skipped** — impl `FCRHN`, states `app,focusable,card`, runs 1

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | a143637e9198 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=- |
| server flags declared | (none) |
| started / finished | 2026-10-10T04:51:57 / 2026-10-10T05:12:24 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| app | rail-to-shows | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | rail-to-settings | 1 | FCRHN | 33027 | 7380 | 0.01237 | 230 | - · focus FAIL | 0 | **FAIL** |
| app | movies-grid-walk | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-grid-hold | 1 | FCRHN | 71179 | 2824 | 0.03296 | 215 | - · focus ok | 0 | **FAIL** |
| app | movies-open-title | 1 | FCRHN | -1 | -1 | 0.00000 | -1 | - | 0 | **FAIL** |
| app | movies-title-back | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-rail-open | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-rail-home | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| focusable | card-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | card-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | ok | 0 | PASS |
| focusable | btn-primary-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | btn-primary-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | btn-secondary-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | btn-secondary-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-on-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | chip-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-surface-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | navitem-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | navitem-lit-2 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | sources-row-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | sources-row-lit-2 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | rest-home | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-frame | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | FAIL | 0 | **FAIL** |
| card | progress-bar | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | - | 0 | PASS |
| card | size-frame-episode | 1 | FCRHN | 0 | 0 | 0.00000 | 1 | - | 0 | PASS |
| card | size-poster | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | kind-tag | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-poster-row2 | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | grid-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | grid-lit | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | new-tag | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | new-tag-rest | 1 | FCRHN | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-wide | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with fixture (declare --server <flag>) |
| card | size-compact | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with aiMock (declare --server <flag>) |
| card | blur-up | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with artDelay (declare --server <flag>) |
| card | broken-tile | 1 | FCRHN | - | - | - | - | - | SKIP: needs the instance started with artFail (declare --server <flag>) |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **app/rail-to-settings** run 1: 7380 differing px off the edge mask (bbox [165, 376, 1824, 799]); on-edge diff fraction 0.012368 > 0.0005; focus table differs (17 vs 18 rows) — see `app/rail-to-settings/triptych.png`
- **app/movies-grid-hold** run 1: 2824 differing px off the edge mask (bbox [170, 136, 1780, 1073]); on-edge diff fraction 0.032964 > 0.0005 — see `app/movies-grid-hold/triptych.png`
- **app/movies-open-title** run 1: harness error: [qa] nav 'browse:movie' -> err timeout — see `app/movies-open-title/triptych.png`
- **card/size-frame** run 1: trace focus.ring: B step 5 at 100.8 ms = 0.961255, off A's curve [0.886156, 0.957675] within +-25 ms (|err| 0.00358 > 0.001); trace focus.ring: A step 5 at 131.0 ms = 0.961255, off B's curve [0.967322, 0.998776] within +-25 ms (|err| 0.00607 > 0.001); trace focus.spring: B step 5 at 100.8 ms = 0.864673, off A's curve [0.66375, 0.852968] within +-25 ms (|err| 0.0117 > 0.00102); trace focus.spring: A step 5 at 131.0 ms = 0.864673, off B's curve [0.886319, 1.00455] within +-25 ms (|err| 0.0216 > 0.00102); trace focus.ring.out: B step 5 at 100.8 ms = 0.038745, off A's curve [0.0409475, 0.105616] within +-25 ms (|err| 0.0022 > 0.001); trace focus.ring.out: A step 5 at 129.0 ms = 0.038745, off B's curve [0.00142774, 0.0350122] within +-25 ms (|err| 0.00373 > 0.001); trace focus.spring.out: B step 5 at 100.8 ms = 0.135327, off A's curve [0.142529, 0.317806] within +-25 ms (|err| 0.0072 > 0.00102); trace focus.spring.out: A step 5 at 129.0 ms = 0.135327, off B's curve [-0.00313616, 0.122009] within +-25 ms (|err| 0.0133 > 0.00102) — see `card/size-frame/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

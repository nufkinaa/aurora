# TV pixel diff — 2026-10-10

**24 pass · 1 fail · 4 skipped** — impl `FC`, states `focusable,card`, runs 1

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | 65ecfc53deff |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=- |
| server flags declared | (none) |
| started / finished | 2026-10-10T02:01:13 / 2026-10-10T02:15:38 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| focusable | card-rest | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | card-lit | 1 | FC | 0 | 0 | 0.00000 | 1 | ok | 0 | PASS |
| focusable | btn-primary-lit | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | btn-primary-rest | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | btn-secondary-lit | 1 | FC | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | btn-secondary-rest | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-on-lit | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-lit | 1 | FC | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | chip-rest | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-surface-lit | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | navitem-lit | 1 | FC | 0 | 0 | 0.00000 | 0 | FAIL | 0 | **FAIL** |
| focusable | navitem-lit-2 | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | sources-row-lit | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | sources-row-lit-2 | 1 | FC | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | rest-home | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-frame | 1 | FC | 0 | 0 | 0.00000 | 1 | ok | 0 | PASS |
| card | progress-bar | 1 | FC | 0 | 0 | 0.00000 | 1 | - | 0 | PASS |
| card | size-frame-episode | 1 | FC | 0 | 0 | 0.00000 | 1 | - | 0 | PASS |
| card | size-poster | 1 | FC | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | kind-tag | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-poster-row2 | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | grid-rest | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | grid-lit | 1 | FC | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | new-tag | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | new-tag-rest | 1 | FC | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-wide | 1 | FC | - | - | - | - | - | SKIP: needs the instance started with fixture (declare --server <flag>) |
| card | size-compact | 1 | FC | - | - | - | - | - | SKIP: needs the instance started with aiMock (declare --server <flag>) |
| card | blur-up | 1 | FC | - | - | - | - | - | SKIP: needs the instance started with artDelay (declare --server <flag>) |
| card | broken-tile | 1 | FC | - | - | - | - | - | SKIP: needs the instance started with artFail (declare --server <flag>) |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **focusable/navitem-lit** run 1: trace focus.ring: A step 1 at 20.0 ms = 0.638151, off B's curve [0, 0.63008] within +-28.2011 ms (|err| 0.00807 > 0.001) — see `focusable/navitem-lit/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

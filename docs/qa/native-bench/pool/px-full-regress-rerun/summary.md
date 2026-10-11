# TV pixel diff — 2026-10-11

**11 pass · 1 fail · 0 skipped** — impl `FCRHNG`, states `card,hero,navrail`, runs 3

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | 3ad862322624 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=- exp=cull+cardlayer+shadowcache+unstuff |
| server flags declared | (none) |
| started / finished | 2026-10-11T01:27:35 / 2026-10-11T01:35:39 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| card | progress-bar | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | progress-bar | 2 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | progress-bar | 3 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-frame-episode | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-frame-episode | 2 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-frame-episode | 3 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| hero | down-burst-4 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| hero | down-burst-4 | 2 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| hero | down-burst-4 | 3 | FCRHNG | 413274 | 248191 | 0.07961 | 255 | FAIL (rest only) · focus ok | 0 | **FAIL** |
| navrail | item-profile-wrap | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-profile-wrap | 2 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-profile-wrap | 3 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **hero/down-burst-4** run 3: 248191 differing px off the edge mask (bbox [161, 0, 1796, 1080]); on-edge diff fraction 0.079612 > 0.0005; trace hero.ty: rest value A=-989.5 B=-998.5 — see `hero/down-burst-4/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

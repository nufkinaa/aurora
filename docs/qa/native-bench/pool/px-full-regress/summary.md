# TV pixel diff — 2026-10-11

**54 pass · 4 fail · 5 skipped** — impl `FCRHNG`, states `focusable,card,hero,navrail`, runs 1

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
| started / finished | 2026-10-11T00:13:21 / 2026-10-11T00:51:14 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| focusable | card-rest | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | card-lit | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | btn-primary-lit | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | btn-primary-rest | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | btn-secondary-lit | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | btn-secondary-rest | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-on-lit | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-lit | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | chip-rest | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | chip-surface-lit | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | navitem-lit | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| focusable | navitem-lit-2 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | sources-row-lit | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| focusable | sources-row-lit-2 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | rest-home | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-frame | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | progress-bar | 1 | FCRHNG | 2801 | 111 | 0.00130 | 201 | - | 0 | **FAIL** |
| card | size-frame-episode | 1 | FCRHNG | 3084 | 1819 | 0.00061 | 190 | - | 0 | **FAIL** |
| card | size-poster | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | kind-tag | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-poster-row2 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | grid-rest | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | grid-lit | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| card | new-tag | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | new-tag-rest | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| card | size-wide | 1 | FCRHNG | - | - | - | - | - | SKIP: needs the instance started with fixture (declare --server <flag>) |
| card | size-compact | 1 | FCRHNG | - | - | - | - | - | SKIP: needs the instance started with aiMock (declare --server <flag>) |
| card | blur-up | 1 | FCRHNG | - | - | - | - | - | SKIP: needs the instance started with artDelay (declare --server <flag>) |
| card | broken-tile | 1 | FCRHNG | - | - | - | - | - | SKIP: needs the instance started with artFail (declare --server <flag>) |
| hero | rest | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 1 | PASS |
| hero | scrolled | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | scrolled-back | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | first-slide | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | details-lit | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| hero | scrolled-row1 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | scrolled-row3 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | down-burst-4 | 1 | FCRHNG | 434875 | 273666 | 0.07774 | 255 | FAIL (rest only) · focus ok | 0 | **FAIL** |
| hero | back-from-row1 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| hero | slide-then-scrolled | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | slide-scrolled-back | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | mid-fade-row0 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | mid-fade-row1 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| hero | mute-pill | 1 | FCRHNG | - | - | - | - | - | SKIP: needs the instance started with fixtureTrailer (declare --server <flag>) |
| navrail | closed | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | open | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| navrail | item-search | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-home | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-movies | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-shows | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-list | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-ai | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-settings | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-profile | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | item-profile-wrap | 1 | FCRHNG | 634658 | 604527 | 0.01453 | 228 | - · focus ok | 0 | **FAIL** |
| navrail | closed-again | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| navrail | mid-open | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok | 0 | PASS |
| navrail | closed-back | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| navrail | open-from-row | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| navrail | row-closed-again | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| navrail | row-closed-back | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| navrail | ok-movies | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| navrail | ok-home | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| navrail | reopen | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

- hero/rest: dither ±2/255 [0, 0, 1920, 1080] — hero scrim gradient (hero-scrim.png stretched) — Android may dither the stretched 480x270 RGBA; only matters at threshold 0

## Failures

- **card/progress-bar** run 1: 111 differing px off the edge mask (bbox [1237, 317, 1345, 343]); on-edge diff fraction 0.001297 > 0.0005 — see `card/progress-bar/triptych.png`
- **card/size-frame-episode** run 1: 1819 differing px off the edge mask (bbox [757, 313, 1078, 339]); on-edge diff fraction 0.000610 > 0.0005 — see `card/size-frame-episode/triptych.png`
- **hero/down-burst-4** run 1: 273666 differing px off the edge mask (bbox [161, 0, 1796, 1080]); on-edge diff fraction 0.077744 > 0.0005; trace hero.ty: rest value A=-989.5 B=-998.5 — see `hero/down-burst-4/triptych.png`
- **navrail/item-profile-wrap** run 1: 604527 differing px off the edge mask (bbox [491, 0, 1920, 735]); on-edge diff fraction 0.014531 > 0.0005 — see `navrail/item-profile-wrap/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

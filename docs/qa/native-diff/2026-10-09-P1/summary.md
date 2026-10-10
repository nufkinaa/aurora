# TV pixel diff — 2026-10-09

**0 pass · 12 fail · 0 skipped** — impl `F`, states `focusable`, runs 1

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | 06f12cd2e5bc |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=- |
| server flags declared | (none) |
| started / finished | 2026-10-09T23:37:43 / 2026-10-09T23:51:53 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces within 1e-3 x range per aligned step, step count +-1.

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| focusable | card-rest | 1 | F | 496275 | 462348 | 0.01636 | 244 | - | 0 | **FAIL** |
| focusable | card-lit | 1 | F | 1095911 | 976941 | 0.05737 | 255 | FAIL | 0 | **FAIL** |
| focusable | btn-primary-lit | 1 | F | 673663 | 630912 | 0.02062 | 245 | FAIL | 0 | **FAIL** |
| focusable | btn-primary-rest | 1 | F | 739060 | 709026 | 0.01448 | 244 | - | 0 | **FAIL** |
| focusable | btn-secondary-lit | 1 | F | 942843 | 883524 | 0.02861 | 245 | FAIL | 0 | **FAIL** |
| focusable | btn-secondary-rest | 1 | F | 659109 | 612238 | 0.02260 | 245 | - | 0 | **FAIL** |
| focusable | chip-on-lit | 1 | F | 7945 | 22 | 0.00382 | 223 | - | 0 | **FAIL** |
| focusable | chip-lit | 1 | F | 122410 | 53254 | 0.03335 | 252 | FAIL | 0 | **FAIL** |
| focusable | chip-rest | 1 | F | 103420 | 58212 | 0.02180 | 254 | - | 0 | **FAIL** |
| focusable | navitem-lit | 1 | F | 605676 | 567525 | 0.01840 | 239 | FAIL | 0 | **FAIL** |
| focusable | navitem-lit-2 | 1 | F | 182805 | 130108 | 0.02541 | 246 | - | 0 | **FAIL** |
| focusable | sources-row-lit | 1 | F | 1000903 | 921882 | 0.03811 | 253 | FAIL | 0 | **FAIL** |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **focusable/card-rest** run 1: 462348 differing px off the edge mask (bbox [91, 0, 1920, 760]); on-edge diff fraction 0.016361 > 0.0005; A: idle timeout before capture; B: idle timeout before capture — see `focusable/card-rest/triptych.png`
- **focusable/card-lit** run 1: 976941 differing px off the edge mask (bbox [158, 0, 1920, 1080]); on-edge diff fraction 0.057374 > 0.0005; A: idle timeout before capture; B: idle timeout before capture; trace focus.ring: step 0 A=0 B=1 (|err| 1 > 0.001); trace focus.ring: step count A=738 B=816 (slack 1); trace focus.spring: step 0 A=0 B=0.999714 (|err| 1 > 0.00103); trace focus.spring: step count A=1537 B=1496 (slack 1); trace no [anim] steps for hero.ty in A; trace no [anim] steps for hero.atTop in A — see `focusable/card-lit/triptych.png`
- **focusable/btn-primary-lit** run 1: 630912 differing px off the edge mask (bbox [0, 0, 1920, 1080]); on-edge diff fraction 0.020617 > 0.0005; A: idle timeout before capture; B: idle timeout before capture; trace focus.ring: step 24 A=1 B=0.640877 (|err| 0.359 > 0.001); trace focus.ring: step count A=805 B=820 (slack 1); trace focus.spring: step 0 A=-0.010343 B=1.01382 (|err| 1.02 > 0.00103); trace focus.spring: step count A=1465 B=1488 (slack 1) — see `focusable/btn-primary-lit/triptych.png`
- **focusable/btn-primary-rest** run 1: 709026 differing px off the edge mask (bbox [102, 0, 1920, 753]); on-edge diff fraction 0.014484 > 0.0005; A: idle timeout before capture; B: idle timeout before capture — see `focusable/btn-primary-rest/triptych.png`
- **focusable/btn-secondary-lit** run 1: 883524 differing px off the edge mask (bbox [0, 0, 1920, 1080]); on-edge diff fraction 0.028607 > 0.0005; A: idle timeout before capture; B: idle timeout before capture; trace focus.ring: step 0 A=1 B=0.001713 (|err| 0.998 > 0.001); trace focus.ring: step count A=1025 B=569 (slack 1); trace focus.spring: step 0 A=0.999754 B=-0.001153 (|err| 1 > 0.00103); trace focus.spring: step count A=1566 B=1258 (slack 1) — see `focusable/btn-secondary-lit/triptych.png`
- **focusable/btn-secondary-rest** run 1: 612238 differing px off the edge mask (bbox [0, 0, 1920, 1080]); on-edge diff fraction 0.022604 > 0.0005; A: idle timeout before capture; B: idle timeout before capture — see `focusable/btn-secondary-rest/triptych.png`
- **focusable/chip-on-lit** run 1: 22 differing px off the edge mask (bbox [714, 188, 966, 568]); on-edge diff fraction 0.003821 > 0.0005; A: idle timeout before capture; B: idle timeout before capture — see `focusable/chip-on-lit/triptych.png`
- **focusable/chip-lit** run 1: 53254 differing px off the edge mask (bbox [163, 579, 1511, 965]); on-edge diff fraction 0.033351 > 0.0005; A: idle timeout before capture; B: idle timeout before capture; trace focus.ring: step 0 A=0 B=1 (|err| 1 > 0.001); trace focus.ring: step count A=1169 B=811 (slack 1); trace focus.spring: step 0 A=0.976061 B=0.000279 (|err| 0.976 > 0.00103); trace focus.spring: step count A=2227 B=1627 (slack 1) — see `focusable/chip-lit/triptych.png`
- **focusable/chip-rest** run 1: 58212 differing px off the edge mask (bbox [709, 691, 1237, 1080]); on-edge diff fraction 0.021802 > 0.0005; A: idle timeout before capture; B: idle timeout before capture — see `focusable/chip-rest/triptych.png`
- **focusable/navitem-lit** run 1: 567525 differing px off the edge mask (bbox [100, 0, 1920, 715]); on-edge diff fraction 0.018398 > 0.0005; A: idle timeout before capture; B: idle timeout before capture; trace no [anim] steps for rail.slide in A; trace no [anim] steps for rail.strip in A; trace focus.ring: step 2 A=0.640877 B=0.070421 (|err| 0.57 > 0.001); trace focus.ring: step count A=716 B=573 (slack 1); trace focus.spring: step 0 A=0.000283 B=-0.013453 (|err| 0.0137 > 0.00103); trace focus.spring: step count A=1530 B=1293 (slack 1) — see `focusable/navitem-lit/triptych.png`
- **focusable/navitem-lit-2** run 1: 130108 differing px off the edge mask (bbox [99, 132, 1920, 424]); on-edge diff fraction 0.025413 > 0.0005; A: idle timeout before capture; B: idle timeout before capture — see `focusable/navitem-lit-2/triptych.png`
- **focusable/sources-row-lit** run 1: 921882 differing px off the edge mask (bbox [162, 0, 1920, 1080]); on-edge diff fraction 0.038108 > 0.0005; A: idle timeout before capture; B: idle timeout before capture; trace focus.ring: step 0 A=0 B=1 (|err| 1 > 0.001); trace focus.ring: step count A=1151 B=974 (slack 1); trace focus.spring: step 8 A=0.380383 B=0.371271 (|err| 0.00911 > 0.00103); trace focus.spring: step count A=1693 B=2037 (slack 1) — see `focusable/sources-row-lit/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

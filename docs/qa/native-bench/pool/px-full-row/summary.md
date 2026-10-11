# TV pixel diff — 2026-10-11

**45 pass · 3 fail · 0 skipped** — impl `FCRHNG`, states `row,render,app`, runs 1

| field | value |
|---|---|
| APK versionCode | 9000 (9.9.9-lab) `com.auroratv.lab` |
| commit | aa7dc15e7bb2 |
| device | MiTV-AFMU0 sdk 34 `Xiaomi/twilight/twilight:14/UKG3.250826.001/V816.0.7.0.UZFAABX:user/release-keys` |
| display mode | mActiveModeId=20 · Physical size: 1920x1080 · Physical density: 320 |
| locale / tz | en-US / Asia/Jerusalem |
| animator / transition / window scale | null / 1.0 / 1.0 · font 1.0 · screensaver 1 |
| receiver ping | v=9000 impl=- exp=cull+cardlayer+shadowcache+unstuff+pool |
| server flags declared | (none) |
| started / finished | 2026-10-11T01:49:30 / 2026-10-11T02:26:06 |

## Results

Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; ON-edge differing pixels must be <= 0.05 % of compared pixels; traces: each step on the other run's value-vs-time curve within +-25 ms (+ 1e-3 x range), same rest value, settle times within 50 ms (trace.py).

| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |
|---|---|---|---|---|---|---|---|---|---|---|
| row | offset-0 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | offset-1 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | lead | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | offset-5 | 1 | FCRHNG | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | offset-9 | 1 | FCRHNG | 0 | 0 | 0.00000 | 1 | - · focus ok | 0 | PASS |
| row | offset-10 | 1 | FCRHNG | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | back-left | 1 | FCRHNG | 0 | 0 | 0.00000 | 2 | ok · focus ok | 0 | PASS |
| row | hold-right-12 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-end | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | hold-right-left | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok (rest only) · focus ok | 0 | PASS |
| row | reentry-down | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | reentry-up | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | left-at-0 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | left-at-0-return | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | poster-row1-step | 1 | FCRHNG | 0 | 0 | 0.00000 | 1 | ok · focus ok | 0 | PASS |
| row | continue-rest | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | continue-step | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | continue-step-2 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | ok · focus ok | 0 | PASS |
| row | pool-wrap-shadow | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-hold-right-left-end | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-continue-far | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| row | pool-continue-far-back | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| render | hero-rest | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | hero-details | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-card0 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-card2 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row1-card0 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row1-card3 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row2-card0 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row2-hold-12 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row3-and-back | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | row0-back | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| render | rail-from-row | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - | 0 | PASS |
| app | home-down-6 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-down-4-up-2 | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-down-hold-8 | 1 | FCRHNG | 526009 | 307487 | 0.10538 | 255 | - · focus ok | 0 | **FAIL** |
| app | home-row-hold | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-row-then-down | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-open-title | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | home-title-back | 1 | FCRHNG | 0 | 0 | 0.00000 | 1 | - · focus ok | 0 | PASS |
| app | rail-to-shows | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | rail-to-settings | 1 | FCRHNG | 33029 | 7382 | 0.01237 | 230 | - · focus FAIL | 0 | **FAIL** |
| app | movies-grid-walk | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-grid-hold | 1 | FCRHNG | 1108560 | 850420 | 0.12449 | 255 | - · focus FAIL | 0 | **FAIL** |
| app | movies-open-title | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-title-back | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-rail-open | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |
| app | movies-rail-home | 1 | FCRHNG | 0 | 0 | 0.00000 | 0 | - · focus ok | 0 | PASS |

## Masks and dither regions (what was not compared, or compared loosely)

none

## Failures

- **app/home-down-hold-8** run 1: 307487 differing px off the edge mask (bbox [161, 0, 1796, 1080]); on-edge diff fraction 0.105383 > 0.0005 — see `app/home-down-hold-8/triptych.png`
- **app/rail-to-settings** run 1: 7382 differing px off the edge mask (bbox [165, 376, 1824, 799]); on-edge diff fraction 0.012368 > 0.0005; focus table differs (18 vs 18 rows) — see `app/rail-to-settings/triptych.png`
- **app/movies-grid-hold** run 1: 850420 differing px off the edge mask (bbox [161, 136, 1786, 1080]); on-edge diff fraction 0.124489 > 0.0005; focus table differs (16 vs 18 rows) — see `app/movies-grid-hold/triptych.png`

## Layout

`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, `traces/<component>.<state>.json`, `env.json`, `summary.json`.

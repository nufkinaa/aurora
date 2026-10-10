# Native rewrite lab — final report (2026-10-10)

Lab: `C:\elia\aurora-lab`, branch `native-lab`, app `com.auroratv.lab` beside the real one on the Mi TV
(MiTV-AFMU0, Android 14, 1080p, 59.94 Hz, 4 cores). The production app was not changed by any of this.

## What was built
Five native (Kotlin, Fabric) components behind per-component switches, each with its JS twin kept:
Focusable (ring + spring), Card (art, shades, blur-up, retry ladder), Row (shelf slide), Hero art + page
column (slide and cross-fades), Rail panel (drawing + open/close slide). Text stays React Native text.

## Is it 1:1?
Pixel diff, JS vs native, same build, same screen, frozen (`docs/qa/native-diff/`):
Focusable 14/14, Card 11/11 (4 need server fixtures, not run), Row 18/18, Hero + column 12/12,
Rail 20/20 pictures — all at 0 differing pixels. Not identical / not proven:
- A lit Continue Watching card's shadow halo differs by 1/255 in up to 20k px in 4 states (below the diff threshold; also seen JS vs JS once).
- 8 rail states fail the *timing-trace* rule with identical pictures (JS trace lines are stamped late).
- Fast DOWN bursts on Home rest up to 9 dp apart: a quirk of the JS clamp, not of the native code.
- Settings' first focus landed on a different element in 3 of 5 native takes (a race in that screen).
- Not checked: trailer layer order (trailers were off), rotation and hue motion only by eye.

## Does it perform better? (medians; frame budget 16.7 ms)
Unloaded, 4 interleaved rounds (`r3/`), JS → all five native:

| scenario | p50 ms | p90 ms | janky % | PSS MB |
|---|---|---|---|---|
| hold along a home row | 21 → 23 | 40 → 38 | 6.0 → 5.3 | 309 → 284 |
| step through home rows | 25 → 24 | 48 → 42 | 9.7 → 5.9 | 350 → 338 |
| Movies grid | 20 → 16 | 36 → 32 | 5.8 → 4.0 | 381 → 347 |
| open/close the rail | 26 → 25 | 43 → 39 | 3.9 → 3.1 | 304 → 288 |

Three of four cores pinned by busy loops, 3 rounds (`r4-load3/`):

| scenario | p50 ms | p90 ms | janky % |
|---|---|---|---|
| hold along a home row | 23 → 23 | 40 → 36 | 7.0 → 5.4 |
| step through home rows | 29 → 22 | 53 → 46 | 14.7 → 8.1 |
| Movies grid | 20 → 16 | 36 → 34 | 5.1 → 4.1 |
| open/close the rail | 26 → 24 | 40 → 38 | 3.9 → 3.3 |

Per step (unloaded): Card is the largest single gain (grid p90 36 → 30, memory −18..−37 MB); Row adds a few
ms on home p90; Hero is small; Rail fixes the rail scenario. Focusable alone is within noise.

## Reading
- Real, consistent, modest: p90 −2..−7 ms, janky frames down by a quarter to a third (nearly half when
  stepping rows under load), memory −12..−35 MB. Native reacts 20–60 ms sooner to a key.
- Not a transformation: Home's typical frame stays ~23 ms against 16.7 ms in both. Whatever caps Home near
  45 fps under input is not what these five components moved.
- The gap widens under CPU pressure, which is the weak-box case.
- Caveats: one device; the load test is busy loops, not a weak GPU or low RAM; the first two measurement
  rounds were discarded (stray key senders on the PC).

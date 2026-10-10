# Follow-up: the rail that opens by itself, the rail-slide regression, the "21 ms" row (2026-10-10)

Lab `C:\elia\aurora-lab`, branch `native-lab`, app `com.auroratv.lab` on the Mi TV (MiTV-AFMU0, Android 14,
1080p, 59.94 Hz), the local server, profile "Claude QA", billboard trailers off. Nothing in production was
changed; the fix of problem 1 is offered as a patch (`rail-self-open.patch`).

## The short version

1. **The rail opening by itself is a production bug and it is not a race.** JS hears a D-pad key only when the
   key comes UP; Android moves focus when it goes DOWN. Every key handler that asks "did this press start
   here?" therefore runs after the move its own press made. With a real press (30–350 ms held) UP from the first
   shelf opened the rail **20 of 20 times at every hold length, in both implementations**; with
   `adb shell input keyevent` (down and up in the same millisecond) 8 of 20 and 6 of 20 — which is why it
   looked like a race. After the fix: **0 of 380**. Three sibling cases had the same cause and are fixed by
   the same change.
2. **The S4 "regression" is buffer stuffing, and no single switch causes it.** Each rail slide starts with a
   60–70 ms frame (the panel mounts); the app then produces frames back to back and the pipeline fills. How
   full it gets depends on how light the frames are: the more RenderThread work the switches remove, the
   more often a whole extra frame ends up parked in the UI thread (0 of 4 runs at baseline, 4 of 4 with all
   three). The frames are not lost — S4 presents 57.6 fps at baseline and 58.4 with the three switches — they
   are shown a refresh later. A new switch, `unstuff`, holds one vsync back when that state is seen and
   removes it: frames shown two or more refreshes late on S4 44 % → 4 % (baseline 16 %).
3. **Holding along a row already presents 57 frames per second.** gfxinfo's 21–23 ms is the age of a frame
   that waited in a full pipeline, not the rate. All-native S1: 57.0 fps while moving, 49 refreshes per 1000
   without a new frame (all-JS: 55.9 fps, 68 per 1000). REPORT.md's "capped near 45 fps" is wrong for S1.
   What the wait costs is latency: a frame reaches the screen 42 ms after its vsync instead of 31. A second
   switch, `unstuffq`, removes that too (31.4 ms, gfx p50 23 → 14) for about four held-back vsyncs per run.
4. Nothing is wrong with composition: one opaque layer, composed by the display hardware (`DEVICE`), no extra
   surface. The CPU is not at its top frequency during these scenarios (mean 2.0–2.2 of 2.5 GHz); the system's
   performance-hint session is accepted by this box and changes nothing measurable.

## Problem 1 — the rail opens by itself

### Mechanism

- `ReactAndroidHWInputDeviceHelper.shouldDispatchEvent` (react-native-tvos): a key event goes to JS on
  `ACTION_UP` only; key-downs are sent only with `ReactFeatureFlags.enableKeyDownEvents`, which is `false`
  and set nowhere in the app. (A key held past the system's repeat delay is reported as `longUp` etc.)
  So the comment above `acceptTvEvent` in `focus.ts` ("reports a press twice") does not describe this build:
  `useTVEventHandler` handlers see one event per press, at the release.
- Android's focus engine moves on the key-DOWN.
- `Home.tsx`, the hero's key handler: `if (heroBtn >= 0 && isTop) { if (t === 'up' || …) requestRailOpen() }`
  with no check at all on the UP branch. UP from the first shelf: key-down → focus lands on the hero's Play
  button → its focus event sets `heroBtn = 0` and `isTop` → 30–350 ms later the key-up reaches JS → "UP on a
  hero button" → the rail opens.
- Device trace (old build, real press held 120 ms): `[key] …419 DPAD_UP`, `[focus] …429 gain tag=102` (Play),
  `[focus] …700 gain tag=728` (the rail's item), `rail.slide` starts. No second key.
- Under `adb shell input keyevent` the key-up follows the key-down within a millisecond and reaches JS
  before or after the focus event — a real race, 30–40 %. That is the only reason it looked occasional. The
  cold-start case fixed in 5.1.30 was a different way in.
- The existing guard `focusJustMoved(120)` (a 120 ms window after a focus move) has the same blind spot
  wherever it is used: it only covers presses shorter than about 120 ms. Measured on the old build with a
  200 ms press (`f1-rail/siblings-before.txt`):
  - hero, RIGHT from Play to Details: focus moved **and the billboard turned a slide**;
  - hero, LEFT from Details back to Play: focus moved **and the rail opened**;
  - shelf, LEFT from the second card to the first: focus moved **and the rail opened** (the "one press acts
    twice near the side panel" report);
  - open rail, UP from Home to Search: focus moved **and wrapped on to the profile pill** (the 2026-10-06 report).

### Reproduction

A virtual remote made with Android's own `uinput` shell tool (`tools/tv-keys-uinput.py`; no root — the shell
user is in group `uhid`): real key-down, a chosen hold, real key-up, through the same input pipeline as the
Bluetooth remote. `tools/tv-rail-selfopen.sh` repeats DOWN, UP, RIGHT from the hero and counts the UP presses
after which the rail slid (`[anim] rail.slide`). `sendevent` is denied on this build; `input keyevent
--longpress` produces `longUp`, which no handler acts on (0 of 20 before and after).

| UP press | before, all native | before, all JS | after, all native | after, all JS |
|---|---|---|---|---|
| `input keyevent` (0 ms) | 8 / 20 | 6 / 20 | 0 / 50 | 0 / 50 |
| held 30 ms | 20 / 20 | 20 / 20 | 0 / 20 | 0 / 20 |
| held 80 ms | 20 / 20 | 20 / 20 | 0 / 50 | 0 / 50 |
| held 120 ms | 20 / 20 | 20 / 20 | – | – |
| held 200 ms | 20 / 20 | 20 / 20 | 0 / 50 | 0 / 50 |
| held 350 ms | 20 / 20 | 20 / 20 | 0 / 20 | 0 / 20 |

(`f1-rail/before.txt`, `after.txt`; "after" is the final build, 380 presses. The build before the 40 ms rule
below gave the same 0 of 380.) From a hand this was every time, not sometimes.

### Fix (JS only; `focus.ts`, `Home.tsx`, `NavRail.tsx`, `Browse.tsx`)

What does not depend on how long a key is held is the ORDER of events JS sees. A press that starts on an
element moved no focus since the key event before it; a press that arrived there did.

- `focus.ts`: every key event JS hears and every focus move take a ticket from one counter.
  `pressMovedFocus()` = "focus moved after the previous key event, and less than 600 ms ago". A plain key-up
  cannot arrive later than the key-repeat delay (400 ms) after its key-down, so an older move is never this
  press's; the bound keeps a focus move the app did not announce (a screen's first focus, Android's restore
  after BACK) from costing more than one press made within 600 ms of it.
- Moves the app makes itself are announced with `noteOwnFocusMove()` and do not count: the rail taking focus
  when it opens, the rail or a trap handing focus back (`captureFocus`), the rail's wrap.
- A focus move that lands within 40 ms AFTER a key event is booked under that key: an injected key (adb, a
  phone remote) goes down and up in the same millisecond and its key-up can reach JS before the focus
  event, and without this the next press, if made within 600 ms, looked like the one that had arrived
  (found by the pixel harness: `card/grid-rest`, RIGHT ×5 then RIGHT 300 ms later, did not open the filter
  panel in the all-JS run; with it 3 of 3 runs open it on both sides). 40 ms is shorter than any gap a hand
  leaves between releasing one key and pressing the next.
- `useTVKeys` stamps the key before its gates, so a key swallowed by a trap still counts as "a key came since".
- `Home.tsx`: the hero's handler returns when `pressMovedFocus()` — before the UP / LEFT / RIGHT branches.
- `NavRail.tsx` (LEFT at the edge, the wrap) and `Browse.tsx` (RIGHT into the filter panel):
  `focusJustMoved(120)` stays and `pressMovedFocus()` is added beside it.

Why it is right: it asks the question the 120 ms window was approximating ("did THIS press move focus?")
with the one fact JS has that answers it exactly for a real remote — whether a key event separates the focus
move from this key event. Under adb's simultaneous down/up the old window still covers the other order.

Intended behaviours, checked with real presses in both implementations (`f1-rail/intended-after-*.txt`): UP on
the hero opens the rail; RIGHT shuts it and UP 300 ms later opens it again; LEFT on Play opens it; RIGHT on
the last button turns the slide; LEFT on a shelf's first card opens it; DOWN, UP (arrives, stays shut), UP
again 150 ms or 700 ms later (opens); in the open rail UP wraps to the profile pill and DOWN wraps back. The
four sibling cases above no longer act twice (`f1-rail/siblings-after*.txt`).

Known cost: after a focus move the app did not announce, one UP / LEFT made within 600 ms is taken as "the
press that arrived" and does nothing; the next one works.

The alternative — turning `enableKeyDownEvents` on, which is what `acceptTvEvent` was written for — changes
when every handler in the app acts and was not tried.

### The production patch

`docs/qa/native-bench/rail-self-open.patch`: the diff of the four files, one line of context.
`git -C /c/elia/aurora apply --check` passes against master `bbead1f` (1.6.85; also against `0bbe65a`; `NavRail.tsx` and
`Home.tsx` differ between the trees, the hunks apply with offsets). Not applied there. Production has not been
built or run with it: the evidence is the lab app in its all-JS configuration, which is the same JS.

## Problem 2 — the rail slide with the render fixes on

### Which switch

None alone. `f2-s4/`, S4 only, 4 interleaved rounds, all native:

| config | RT CPU ms/frame | runs with the UI thread a frame behind | gfx p50 per run | frames shown ≥ 2 refreshes late % | presented fps | refreshes without a new frame /1000 |
|---|---|---|---|---|---|---|
| baseline | 9.7 | 0 / 4 | 25 26 25 25 | 5 | 57.5 | 40 |
| `shadowcache` | 8.8 | 0 / 4 | 26 25 28 26 | 12 | 57.6 | 38 |
| `cull` | 9.0 | 1 / 4 | 25 26 26 26 | 16 | 58.0 | 32 |
| `cardlayer` | 7.6 | 2 / 4 | 24 24 26 25 | 43 | 57.6 | 39 |
| `cardlayer` + `cull` | 7.3 | 2 / 4 | 32 25 24 25 | 30 | 58.1 | 31 |
| `cull` + `shadowcache` | 8.3 | 3 / 4 | 34 34 36 27 | 48 | 57.9 | 35 |
| `cardlayer` + `shadowcache` | 6.7 | 4 / 4 | 32 32 32 34 | 60 | 58.2 | 28 |
| all three | 6.0 | 4 / 4 | 34 32 34 34 | 70 | 58.2 | 28 |

It follows the amount of work removed, not a switch. The frames of the slide show no sign of a layer being
rebuilt or invalidated: issue work per frame is flat at 3–6 ms from the third frame on with all three
switches (`frame-bursts.py`), lower than the baseline's 6–8 ms on every frame. (The view hierarchy was not
inspected for it; the timings leave no room for it.)

### Why

`tools/frame-bursts.py` prints each motion frame by frame (times in ms after the frame's own vsync). Every
close of the rail, in every configuration, starts like this (`f4-final/raw/*-S4-2.gfx.txt`):

```
 #  vs  start queued   sync    dq  work   swap
 1   0    0.3   63.3   63.4   0.0   3.2   68.6     the key: 63 ms on the UI thread before the frame is handed over
 2   1   49.0   50.6   52.8   0.0   6.4   60.2     the next frame starts 49 ms late, right behind it
 3   3    4.1    5.0   20.5  15.5   5.6   42.5     from here every frame waits: for the RenderThread (queued → sync)
 4   1    5.0   10.5   28.0   7.9   5.3   42.2     and the RenderThread for a buffer (dq)
```

Two frames are finished inside one refresh, SurfaceFlinger shows one per refresh, the app goes on making one
per refresh: the surplus never drains. It sits in one of two places:

- **a buffer queued** — the RenderThread waits ~7–10 ms in `dequeueBuffer` every frame, the UI thread starts
  on time. One refresh late. This is the baseline's steady state on S4 and on S1.
- **the UI thread a frame behind** — as well as that, the UI thread is still blocked in the previous frame's
  sync when its vsync arrives, so each frame starts ~10 ms late ("UI start" 1.2 → 11 ms) and is shown two
  refreshes late. gfxinfo's p50 goes 25 → 32–34 ms.

Lighter frames make the second state more likely: after the opening stall the RenderThread finishes sooner,
takes the next frame sooner and then waits longer for a buffer with the UI thread blocked behind it. Work
6.0 instead of 9.7 ms, dequeue wait 10.2 instead of 7.1 ms — the saved work became waiting.

Android 14 has no recovery from this (HWUI's `isSwapChainStuffed` is not called; recovery arrived in Android
16), which is the research note's prediction (`research/2-android-rendering.md` §1); the frame-by-frame data
confirms it. `dumpsys SurfaceFlinger --frametimeline` cannot label it on this TV: the HWC returns no present
fences, every frame is "Unknown jank". A Perfetto trace was not taken.

### Fix: `unstuff` (`AuroraClock.kt`, off by default)

When the frame callback has run more than 5 ms after its vsync three frames in a row AND the last frame kept
the UI thread waiting rather than working (wall time minus the thread's CPU time > 5 ms — a UI thread that is
busy mounting something is late too and must not be touched), the clock steps no driver for one vsync, at
most once per 500 ms. SurfaceFlinger gets one buffer ahead and the UI thread starts on its vsync again. The
drivers are stepped with the frame's time, so the motion stays where the clock says; the held vsync shows the
previous frame again. It acts only on animations run by `AuroraClock` (the native components).

S4, 4 interleaved rounds (`f4-final/`):

| | all native | + three switches | + `unstuff` |
|---|---|---|---|
| gfx p50 (range over runs) | 25 (25–25) | 24 (23–32) | 24 (23–24) |
| gfx p90 | 42 | 36 | 34 |
| vsync → GPU done p50 | 36.5 | 39.8 | 32.1 |
| UI start → sync queued p50 | 1.4 | 6.0 | 1.3 |
| frames shown ≥ 2 refreshes late | 16 % | 44 % | 4 % |
| vsync → screen p50 / p90 ms | 44.8 / 64.6 | 55.5 / 69.6 | 45.8 / 52.5 |
| presented fps | 57.6 | 58.4 | 58.1 |
| held-back vsyncs per run (10 slides) | – | – | 4 |

Not worse than baseline on S4 in p50, and S1–S3 keep their gains (table below; `unstuff` holds 1–2 vsyncs per
run there).

## Problem 3 — holding along a row

### What the viewer gets

`tools/tv-present-bench.sh` polls `dumpsys SurfaceFlinger --latency <the app's layer>` during a scenario
(every buffer: when it was queued, the vsync it was shown on) and joins it with gfxinfo's frames
(`tools/present-parse.py`, `present-join.py`). "Presented fps" counts refreshes with a new frame while
something moves (gaps over six refreshes are pauses between motions and are left out). S1, 4 rounds:

| | all JS | all native | + three switches | + `unstuffq` |
|---|---|---|---|---|
| **presented fps while moving** | 55.9 | 57.0 | 58.2 | 57.8 |
| refreshes without a new frame /1000 | 68 | 49 | 30 | 36 |
| gfx p50 ms | 19 | 23 | 21 | 14 |
| vsync → screen p50 ms (straight through = 31.4) | 25.9 | 41.9 | 45.6 | 31.4 |
| frames shown a refresh late | 0 % | 72 % | 80 % | 0 % |
| RenderThread waits in `dequeueBuffer` p50 ms | 0.0 | 5.7 | 9.3 | 0.5 |
| UI thread waits for the RenderThread p50 ms | 0.2 | 12.2 | 8.6 | 0.2 |

- **The rate is ~57 fps, not 45.** 21–23 ms is how old the typical frame is when the GPU finishes it, because
  it waited 12 ms for the RenderThread, which waited 6 ms for a buffer. It is latency.
- The native build is *more* stuffed than the JS one on S1: JS misses more refreshes (68 against 49 per
  1000), and every miss drains the queue. That is why JS shows the lower gfx p50 (19 against 23) while
  presenting fewer frames — gfx p50 points the wrong way here.
- Janky % and p90 do follow what is seen: 5.5 % / 39 ms (JS), 3.9 % / 35 (native), 1.8 % / 26 (switches).

### What it is not

- **Composition.** `dumpsys SurfaceFlinger`: the app is the only layer on the display, `composition type=DEVICE`,
  `isOpaque=true`, `blend=NONE`, sRGB; no SurfaceView, TextureView or second window (trailers off). The theme
  is opaque. Nothing to switch.
- **The pipeline's timing** is the vendor's: app work duration 18.68 ms, SurfaceFlinger 12.68 ms — a frame that
  goes straight through is on screen two refreshes (31.4 ms) after its vsync. `debug.sf.disable_backpressure=1`,
  `latch_unsignaled=1` are set by the vendor; nothing here is the app's to change.
- **CPU frequency.** `schedutil`; over S1 the cluster averages 2.0–2.2 GHz of 2.5 (54–64 % of the time at the
  top step), over S4 1.7–2.0 GHz (31–40 %). So the "ms of work" are partly ms at a reduced clock.
- **The performance-hint session.** `debug.hwui.use_hint_manager=true` is accepted (`dumpsys performance_hint`:
  a session with four threads, target 13.08 ms) and changes nothing measurable in 3 interleaved rounds
  (`f3-hint/`): S1 56.8 against 57.2 fps, RT CPU 9.7 against 9.2 ms, mean frequency 2127 against 2118 MHz; S2
  54.0 against 53.2 fps. The property was put back to empty.

### The switch: `unstuffq`

`unstuff`, plus: when frames have kept the UI thread waiting more than 5 ms each for 12 frames in a row
(200 ms) with the callback on time — one buffer queued — hold one vsync back, at most once a second.
On S1 it takes the pipeline to empty for the rest of the hold: vsync → screen 45.6 → 31.4 ms, gfx p50 21 → 14,
whole frame 30 → 14 ms, for about four held vsyncs per run; presented fps 58.2 → 57.8 (within the spread of
the runs: 25–34 against 26–43 refreshes without a new frame per 1000). On S2 38 → 27 ms.

It buys one refresh of delay between the remote and the picture during a held key; it does not make the
motion smoother, and each held vsync is one repeated frame. Whether that trade is wanted is a call for an eye
on the TV, so it is separate from `unstuff`.

## Final bench — 4 interleaved rounds, a cold start per run (`f4-final/`)

`js` = everything JS; `nat` = the five components native, no experiment; `ccs` = + `cardlayer`, `cull`,
`shadowcache`; `ccsu` = + `unstuff` (**recommended**); `ccsq` = + `unstuffq`. Medians.

| config | scn | presented fps in motion | refreshes without a new frame /1000 (range) | vsync → screen p50 / p90 ms | shown ≥1 / ≥2 refreshes late % | gfx p50 (range) / p90 / p99 | janky % | RT CPU ms/frame | PSS MB | held vsyncs |
|---|---|---|---|---|---|---|---|---|---|---|
| js | S1 | 55.9 | 67.6 (56–69) | 25.9 / 33.4 | 0 / 0 | 19 (19–19) / 39 / 67 | 5.5 | 9.8 | 324 | – |
| nat | S1 | 57.0 | 49.1 (44–55) | 41.9 / 49.8 | 72 / 0 | 23 (23–23) / 35 / 61 | 3.9 | 9.1 | 301 | – |
| ccs | S1 | 58.2 | 29.6 (25–34) | 45.6 / 52.7 | 80 / 0 | 21 (21–21) / 26 / 53 | 1.8 | 6.5 | 242 | – |
| **ccsu** | S1 | 58.0 | 32.0 (28–36) | 46.2 / 52.5 | 90 / 0 | 21 (21–21) / 26 / 50 | 1.6 | 6.6 | 241 | 2 |
| ccsq | S1 | 57.8 | 36.0 (26–43) | 31.4 / 36.0 | 0 / 0 | 14 (13–14) / 25 / 50 | 1.7 | 6.6 | 242 | 4 |
| js | S2 | 52.9 | 117.3 (89–131) | 47.4 / 63.6 | 58 / 32 | 26 (25–26) / 47 / 115 | 10.1 | 13.9 | 364 | – |
| nat | S2 | 53.4 | 108.4 (88–116) | 50.2 / 64.7 | 85 / 28 | 23 (20–24) / 42 / 113 | 6.5 | 13.1 | 334 | – |
| ccs | S2 | 55.8 | 68.6 (65–71) | 38.1 / 49.3 | 49 / 0 | 17 (13–21) / 28 / 75 | 3.4 | 6.6 | 274 | – |
| **ccsu** | S2 | 56.0 | 65.8 (57–76) | 38.2 / 43.9 | 39 / 0 | 18 (13–21) / 30 / 77 | 3.5 | 6.6 | 272 | 1 |
| ccsq | S2 | 55.9 | 67.9 (67–68) | 27.0 / 35.3 | 0 / 0 | 14 (13–14) / 28 / 75 | 3.1 | 6.5 | 270 | 4 |
| js | S3 | 55.8 | 68.8 (66–75) | 32.5 / 43.8 | 22 / 4 | 19 (18–22) / 36 / 150 | 5.5 | 7.7 | 378 | – |
| nat | S3 | 56.2 | 62.8 (61–74) | 30.2 / 42.7 | 12 / 5 | 18 (16–20) / 33 / 99 | 4.6 | 7.4 | 344 | – |
| ccs | S3 | 55.6 | 73.0 (66–75) | 25.8 / 46.6 | 22 / 5 | 13 (12–14) / 35 / 117 | 3.9 | 5.3 | 332 | – |
| **ccsu** | S3 | 55.9 | 67.8 (64–76) | 30.6 / 49.8 | 23 / 7 | 13 (12–15) / 30 / 111 | 3.7 | 5.3 | 334 | 2 |
| ccsq | S3 | 55.8 | 69.7 (66–75) | 30.2 / 50.7 | 23 / 5 | 14 (12–14) / 28 / 101 | 4.3 | 5.2 | 330 | 4 |
| js | S4 | 58.1 | 31.4 (27–39) | 46.8 / 53.2 | 80 / 8 | 26 (26–26) / 41 / 105 | 3.6 | 9.8 | 304 | – |
| nat | S4 | 57.6 | 38.3 (33–50) | 44.8 / 64.6 | 82 / 16 | 25 (25–25) / 42 / 99 | 4.2 | 9.8 | 296 | – |
| ccs | S4 | 58.4 | 25.4 (22–28) | 55.5 / 69.6 | 83 / 44 | 24 (23–32) / 36 / 95 | 2.8 | 6.0 | 192 | – |
| **ccsu** | S4 | 58.1 | 31.1 (26–42) | 45.8 / 52.5 | 91 / 4 | 24 (23–24) / 34 / 93 | 3.4 | 6.1 | 190 | 4 |
| ccsq | S4 | 58.2 | 29.3 (22–31) | 39.8 / 51.5 | 58 / 5 | 24 (23–24) / 32 / 97 | 3.0 | 6.1 | 194 | 6 |

Full table with CPU frequency: `f4-final/table.md`. Frame stages (medians of the last 120 frames of each run;
`f4-final/stages.md`):

| config | scn | UI thread | UI waits for the RenderThread | sync | dequeueBuffer wait | issue work p50 / p90 | eglSwapBuffers | GPU finish | vsync → GPU done p50 / p90 |
|---|---|---|---|---|---|---|---|---|---|
| js | S1 | 1.6 | 0.2 | 1.8 | 0.0 | 8.5 / 9.7 | 0.9 | 6.0 | 18.6 / 20.2 |
| nat | S1 | 1.1 | 12.2 | 1.3 | 5.7 | 8.6 / 9.8 | 0.8 | 6.0 | 35.1 / 36.5 |
| ccsu | S1 | 1.4 | 8.6 | 1.6 | 9.3 | 4.6 / 5.6 | 1.0 | 4.9 | 30.4 / 31.7 |
| ccsq | S1 | 1.4 | 0.2 | 2.0 | 0.5 | 4.6 / 5.5 | 1.0 | 4.9 | 13.8 / 15.2 |
| js | S2 | 5.2 | 11.8 | 3.2 | 0.0 | 13.7 / 19.1 | 0.7 | 6.1 | 45.4 / 65.2 |
| nat | S2 | 4.3 | 13.6 | 2.5 | 0.0 | 13.8 / 18.4 | 0.7 | 6.0 | 45.2 / 62.7 |
| ccsu | S2 | 1.4 | 4.6 | 1.2 | 4.2 | 5.7 / 8.9 | 0.9 | 6.5 | 24.4 / 29.7 |
| ccsq | S2 | 1.4 | 0.1 | 1.2 | 0.4 | 5.6 / 8.4 | 0.9 | 5.7 | 15.9 / 21.6 |
| js | S3 | 2.3 | 0.2 | 1.1 | 0.1 | 5.9 / 9.4 | 0.8 | 5.7 | 17.2 / 37.6 |
| nat | S3 | 1.2 | 0.1 | 0.7 | 1.5 | 5.3 / 8.4 | 0.8 | 5.5 | 15.4 / 36.2 |
| ccsu | S3 | 1.3 | 0.1 | 0.9 | 0.0 | 3.3 / 5.2 | 0.8 | 4.5 | 11.7 / 32.8 |
| js | S4 | 2.0 | 9.6 | 1.5 | 7.1 | 7.1 / 9.9 | 0.8 | 7.8 | 35.7 / 45.4 |
| nat | S4 | 1.4 | 11.0 | 1.2 | 6.9 | 7.3 / 11.3 | 0.8 | 7.8 | 36.5 / 55.5 |
| ccs | S4 | 6.0 | 10.9 | 1.0 | 10.1 | 4.3 / 5.7 | 0.9 | 6.6 | 39.8 / 50.4 |
| ccsu | S4 | 1.3 | 7.5 | 1.0 | 10.2 | 4.3 / 5.9 | 0.9 | 6.6 | 32.1 / 34.5 |

Reading, recommended configuration (`ccsu`) against all-JS:
- frames presented: S1 55.9 → 58.0 fps, S2 52.9 → 56.0, S3 and S4 the same (55.8 / 55.9, 58.1 / 58.1);
- refreshes without a new frame: S1 68 → 32 per 1000, S2 117 → 66, S3 and S4 unchanged;
- janky frames: 5.5 → 1.6 %, 10.1 → 3.5 %, 5.5 → 3.7 %, 3.6 → 3.4 %; p90 39 → 26, 47 → 30, 36 → 30, 41 → 34 ms;
- RenderThread work per frame: 9.8 → 6.6, 13.9 → 6.6, 7.7 → 5.3, 9.8 → 6.1 ms; memory −40 to −110 MB.
- Latency on S1 is the one number where JS is ahead (26 against 46 ms from vsync to screen), because JS drops
  enough frames to keep its queue empty; `unstuffq` closes it (31 ms).

## Pixels

- `tools/tv-pixel-diff --states states/render.json --exp cardlayer=1,cull=1,shadowcache=1,unstuff=1` (both sides
  all native; `f5-pixels/ccsu`): run.py 11 of 11 pass at 0 px; `strict.py`: 18,561–39,982 px differ at all,
  90–994 px by more than 1/255, **none by more than 8/255, max 7/255** — the three switches' known difference
  (`r5-pixels/ccs`: the same maxima); `unstuff` adds nothing at rest. diff.py and strict.py are unchanged.
- The component state sets, all JS against all native, `--impl FCRHN --states focusable,card,row,hero,navrail`
  (`docs/qa/native-diff/2026-10-10-followup/`, 81 states): 66 pass, 5 skipped (they need server fixtures, as
  before), 10 fail:
  - 8 `navrail/*` with **0 differing px**, on the timing-trace rule only — the same eight as in
    `2026-10-10-P3P4P5` (JS trace lines are stamped late);
  - `hero/first-slide`, 0 px, the same trace rule by 0.003 on one step; 3 of 3 pass on the re-run (`rerun/`);
  - `card/grid-rest`, 344,461 px: the two sides were on different screens — the filter panel had opened in
    the native run and not in the JS run. That was the key fix itself misreading injected keys (the 40 ms rule
    above); fixed, 3 of 3 runs at 0 px (`rerun/`).
  Every state that compares the same screen is at 0 differing px. The full run was made with the build before
  the 40 ms rule (a change in `focus.ts` only); the two states it touches were re-run on the final build.
- Motion is still not covered by any pixel check: a held vsync shows the previous frame once more, by design.

## What remains unknown

- A person's press on the physical remote was not made; the virtual remote goes through the same input path
  (kernel input device → InputReader → the activity) with the same down / hold / up.
- Production was not built or run with the patch.
- Whether a held-back vsync is visible to the eye, and whether the shorter delay of `unstuffq` is felt.
- `unstuff` on another box: the thresholds (5 ms late, 5 ms waited, 3 / 12 frames) were chosen on this TV's
  timings (SurfaceFlinger wakes 4 ms after vsync; a stuffed frame starts ~10 ms late).
- The window's buffer count and SurfaceFlinger's own classification of the frames (no present fences on this
  HWC; no Perfetto trace taken).
- The presented-frame times are SurfaceFlinger's vsync clock, not measured light; a frame the panel itself
  dropped would not be seen by any of this.
- The server was restarted (1.6.82 → 1.6.84) after the benches and before the last pixel run.

## Files

- Fix 1: `tv-native/src/focus.ts`, `src/screens/Home.tsx`, `src/components/NavRail.tsx`, `src/screens/Browse.tsx`;
  `docs/qa/native-bench/rail-self-open.patch`.
- Switches: `tv-native/android/app/src/main/java/com/auroratv/ui/anim/AuroraClock.kt` (`unstuff`, `unstuffq`),
  `ui/AuroraExp.kt`; `tools/tv-pixel-diff/PROTOCOL.md` §3.
- Tools: `tools/tv-keys-uinput.py`, `tv-rail-selfopen.sh`, `tv-rail-selfopen-matrix.sh` (problem 1);
  `tv-present-bench.sh`, `present-parse.py`, `present-join.py`, `present-merge.py`, `present-report.py`,
  `present-rejoin.py`, `frame-bursts.py` (presented frames, frame-by-frame motions).
- Data: `f1-rail/`, `f2-s4/` (the bisect), `f3-hint/`, `f4-final/`, `f5-pixels/` (raw gfxinfo and latency dumps
  under `raw/`).

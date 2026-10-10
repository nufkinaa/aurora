# Home's RenderThread time — diagnosis and fixes (2026-10-10)

Lab: `C:\elia\aurora-lab`, branch `native-lab`, app `com.auroratv.lab` on the Mi TV (MiTV-AFMU0, Android 14,
1920×1080 at density 320, 59.94 Hz, 4 × Cortex-A55, Mali-G310, HWUI pipeline "Skia (OpenGL)"). Everything is
measured with all five components native (`FCRHN`), profile "Claude QA", billboard trailers off, the local server.
The production app is untouched. Every fix is behind a switch that is **off by default**.

## The short version

1. **The "21 ms on the RenderThread" is not 21 ms of work.** Per frame on Home the RenderThread *works*
   11.7 ms (holding along a row, S1) to 13.1 ms (stepping through rows, S2). The rest of the 21–24 ms the frame
   stages show is waiting: ~5 ms inside "issue GPU commands" blocked in `dequeueBuffer` for a free buffer, and
   ~6–8 ms inside "swap buffers" that is the GPU finishing the frame, not the thread (`eglSwapBuffers` itself
   returns in 0.8 ms). That is why forcing 720p changed nothing but "swap".
2. **Half of the real work is the cards** (5.7–6.1 ms of it), and inside the cards the expensive things are not
   the picture, the rounded clip or the shade (all ≈ 0) but the small decorations: the progress bar's two glows
   (two React Native `box-shadow`s per bar: 1.0–1.6 ms per frame), the kind pill with its icon (1.0–2.1 ms) and,
   elsewhere, the focus ring's and the Play button's `box-shadow`s (0.6–1.9 ms). React Native re-blurs every
   `box-shadow` on every frame it is on screen.
3. **The billboard stack, the bloom, the rail strip and the row fade cost the RenderThread nothing measurable**
   (each within ±0.2 ms when removed outright). Flattening them cannot help the thread; it was not built.
4. **Most impactful single fix: one hardware layer per resting card (`cardlayer`)** — RenderThread work −3.3 ms
   on S1 (−28 %), −3.0 ms on S2 (−23 %); janky frames 4.9 → 2.1 % and 6.8 → 3.1 %; p90 36 → 25 ms and 44 → 30 ms.
   Pixels: at most 40 px per screen differ by 2/255, the rest by ≤ 1/255.
5. **Best combination: `cardlayer` + `cull` + `shadowcache`** — RenderThread work 11.6 → 7.8 ms (S1),
   13.0 → 6.7 ms (S2), 7.8 → 5.5 ms (S3), 10.0 → 6.3 ms (S4); stepping through rows the typical frame goes from
   22 ms to 13 ms and p90 from 44 to 29 ms; memory is lower, not higher (GPU caches 76 → 51 MB on S1).
   One thing got worse: the rail slide (S4) presents one vsync later in most runs (p50 25 → 32 ms), see below.

## Part 1 — diagnosis

### Method

- **Profiler.** The lab manifest got `<profileable android:shell="true"/>`; `simpleperf record --app
  com.auroratv.lab -e cpu-clock -f 2000 -g` works from the adb shell on this user build (`simpleperf record -p`
  does not: permission denied). Samples were aggregated per RenderThread stage and per canvas op with
  `tools/render-profile.py` / `tools/render-profile-kw.py` (outputs in `r5-profile/`). The profiler itself more
  than doubles the thread's time per frame, so it is used for *proportions* only, never for milliseconds.
- **Work per frame, without a profiler.** `tools/tv-render-bench.sh` reads the RenderThread's `utime+stime`
  from `/proc/<pid>/task/<tid>/stat` before and after a scenario and divides by the frames rendered:
  **RT CPU ms/frame**. It repeats to ±0.1–0.2 ms between cold starts, which no frame-stage percentile does.
- **Stages.** `dumpsys gfxinfo framestats` (last 120 frames of a run), including the two columns the stage
  table did not use before: `DequeueBufferDuration` and `GpuCompleted` (`tools/render-parse.py`).
- **Attribution by removal.** Twenty-one lab switches (`x_…`, `AuroraExp.kt`) each take ONE thing out of the
  frame (alpha 0, not drawn, or not mounted) and the scenario is measured again, interleaved with the baseline
  (`r5-diag/` 2 rounds, `r5-fix/` 3 rounds).
- Scenarios as in `tools/tv-bench.sh`: S1 hold along a home row, S2 step down/up through home rows, S3 Movies
  grid, S4 open/close the rail. A cold start per run.

### What a "frame time" on this TV is made of (S1, baseline, medians of 3 rounds)

| piece | ms | what it is |
|---|---|---|
| UI thread | 1.1 | input + animation + layout + record. The slides are RenderNode properties: "draw (record)" is 0.2 ms, nothing is re-recorded. |
| sync | 1.3 | `prepareTree` over every mounted node |
| issue GPU commands | 14.7 | of which **5.3 ms blocked in `dequeueBuffer`** and **9.0 ms of work** (p90 10.8): replaying every display list into Skia, then Skia's flush (the GL calls) |
| `eglSwapBuffers` | 0.8 | the call itself |
| "swap buffers" as the stage table prints it | 6.0 | SwapBuffers → FrameCompleted = **the GPU finishing the frame** (`GpuCompleted − SwapBuffers` is the same 6.0); not RenderThread time |
| RenderThread CPU per frame, measured | **11.6–11.8** | = 1.3 + 9.0 + 0.8 + the kernel/driver share; frames are produced every 16.8 ms |

In S1 the frames arrive at the display's rate (IntendedVsync steps by 16.8 ms, frame after frame) while each
"takes" 35 ms from its vsync to completion: the pipeline is running two frames deep, and the RenderThread spends
the slack waiting for a buffer. A frame is janky when its *work* overruns, not because the typical frame does.
In S2 (the whole column moves) the work is larger — issue minus dequeue is 13.1 ms p50 / 18.3 ms p90, sync 2.6 ms —
and that scenario really is bound by the RenderThread.

So the earlier result "720p did not reduce issue-GPU-commands, only swap" is explained: the issue stage is CPU
work plus a buffer wait (neither scales with pixels) and "swap" is the GPU (which does: 6 ms of a 16.7 ms budget —
the GPU is not what limits Home).

### What the profiler says the work is (`r5-profile/S1-base.txt`, 29,857 RenderThread samples)

| share of RenderThread CPU | |
|---|---|
| 42.5 % | replaying display lists into Skia: 12.9 % walking the node tree itself, text 5.5 %, round-rects 5.5 %, images 5.8 %, **paths through a blur mask filter (box-shadows) 4.6 %**, clips 3.6 %, rects 1.8 % |
| 24.2 % + 10.8 % | Skia's flush and the Mali driver under it (the GL calls): fill-rect ops 4.8 %, textured quads 3.7 %, round-rect ops 4.1 %, text 3.1 %; 4.8 % looking up a GL program per draw |
| 14.3 % | `prepareTree` (sync), 4 % of the total pinning mutable bitmaps (every react-native-svg icon is one) |
| ~8 % | the rest (swap/queueBuffer 1 %, kernel, bookkeeping) |

It is flat: no single function is above 5 %. And three suspects are simply absent
(`r5-profile/S1-base-keywords.txt`): **no `saveLayer` anywhere** (0.00 % — group opacity and rounded
`overflow: hidden` do not make layers in this tree: `ReactViewGroup.hasOverlappingRendering` is false and the
rounded clips are `clipPath`s), **no texture uploads** (`writePixels`/`uploadTexData` 0.05 % — bitmaps are not
re-uploaded), no image filters. The cost is the *number* of draw operations, each paid in full every frame,
on a slow core.

### Attribution by removal (RenderThread CPU ms per frame; Δ against the interleaved baseline)

Baseline: S1 11.7 ms, S2 13.1 ms (`r5-diag/`, 2 rounds); 11.8 / 13.0 (`r5-fix/`, 3 rounds). Run-to-run spread ≤ 0.3 ms.

| removed from the frame | switch | S1 Δ ms | S2 Δ ms | janky % S1 / S2 (base 5.2 / 6.2) |
|---|---|---|---|---|
| **every card** (alpha 0; still walked by `prepareTree`) | `x_cards` | **−5.7** (−49 %) | **−6.1** (−47 %) | 1.0 / 2.5 |
| the cards' tags and progress bars | `x_tags` | **−3.0** (−26 %) | **−3.4** (−26 %) | 2.0 / 2.6 |
| · the progress bar (Continue Watching) | `x_progress` | −2.2 | −1.1 | 2.1 / 2.8 |
| · · only its two glows (`boxShadow` on the fill and on the bead) | `x_progshadow` | −1.6 | −1.0 | 2.4 / 2.8 |
| · · only its gradient | `x_proggrad` | −0.3 | +0.1 | 4.4 / 5.8 |
| · the kind pill (bordered pill + SVG icon) | `x_kind` | −1.0 | −2.1 | 3.6 / 4.0 |
| · the NEW pill | `x_new` | −0.1 | 0.0 | 4.6 / 6.3 |
| box-shadows of the focus ring, the Play button, the lit dot | `x_shadow` | −0.6 | −1.9 | 3.1 / 3.3 |
| the cards' pictures (blur-up, art, shade — the whole art layer) | `x_cardart` | −0.8 | −1.3 | 3.4 / 5.1 |
| every icon (react-native-svg) | `x_svg` | −0.8 | −0.7 | 4.5 / 5.4 |
| the cards' words | `x_text` | −0.8 | −0.2 | 2.5 / 5.2 |
| · only the text shadows | `x_textshadow` | −0.3 | −0.3 | 3.3 / 5.7 |
| the hero lockup (title, facts, synopsis, buttons, dots) | `x_herocol` | −0.5 | −0.8 | 4.2 / 4.0 |
| the cards' hairline border and raised fill | `x_border` | −0.4 | −0.5 | 4.0 / 5.5 |
| the row left-fade | `x_fade` | −0.5 (one round −0.9, one −0.1) | −0.1 | 4.7 / 6.1 |
| the row headings | `x_rowtitle` | +0.2 | −0.5 | 5.3 / 6.1 |
| **the billboard: art, second art, dim, scrim** | `x_hero` | −0.2 | +0.1 | 5.3 / 6.3 |
| **the ambient bloom** | `x_ambient` | +0.2 | −0.2 | 5.0 / 6.7 |
| **the rail strip and its scrim** | `x_rail` | +0.1 | +0.2 | 5.6 / 6.5 |
| the rounded clip on the card layers | `x_clip` | 0.0 | −0.3 | 4.6 / 6.6 |
| the card shade PNGs | `x_shade` | +0.1 | −0.2 | 4.3 / 6.2 |

Removing the billboard changed only the GPU's finish time in S2 (7.2 → 5.1 ms; it was never the bottleneck) and
nothing at all in S1. Removing the bloom took 0.8 ms off the GPU's time in S1.

### Ranked attribution — "X costs about N ms of RenderThread work per frame on Home"

| | S1 | S2 | evidence |
|---|---|---|---|
| 1. The cards, all together | 5.7 ms | 6.1 ms | `x_cards` |
| 2. · of which their tags: progress bar + kind pill | 3.0 ms | 3.4 ms | `x_tags`; = `x_progress` + `x_kind` |
| 3. React Native `box-shadow`s, all of them (progress glows + ring + Play + dot) | 2.2 ms | 2.9 ms | `x_progshadow` + `x_shadow`; profile: `drawPath` through `BlurMaskFilter` |
| 4. Nodes that are mounted but off screen | 0.3 ms | 2.1 ms | the `cull` fix below (sync 2.6 → 0.9 ms in S2) |
| 5. Icons (SVG views: a mutable bitmap each, pinned every frame) | 0.8 ms | 0.7 ms | `x_svg`; `pinImages` 4 % |
| 6. Everything that is not a card and is on screen: lockup, headings, rail, art | ≤ 1 ms | ≤ 1.5 ms | the remaining rows of the table |
| 7. The floor: `prepareTree` over ~350 views, the tree walk, swap, driver | ~5 ms | ~5 ms | what is left with every card at alpha 0 (6.0 / 7.0) minus row 6 |

**The single most expensive thing** is the card's tag layer — the progress bar with its two glows and the kind
pill: 3.0–3.4 ms, a quarter of all RenderThread work, for a few hundred pixels. The single most expensive
*primitive* is React Native's `box-shadow` (`OutsetBoxShadowDrawable`: a `clipOutPath` and a `drawPath` through a
`BlurMaskFilter`, re-issued and re-blurred every frame): 2.2–2.9 ms across about a dozen shadows.

The six candidates of the earlier analysis, against the data:

| candidate | verdict |
|---|---|
| 1. Flatten the billboard | **Discarded.** Removing it entirely (the upper bound of any flattening) changes RenderThread work by −0.2 / +0.1 ms and janky frames by +0.1 pt. It would only shorten the GPU's finish time, which is 6–8 ms of 16.7. Not built. |
| 2. Card: one draw instead of several (bake shade, no rounded clip, pre-rendered shadow) | The clip and the shade cost 0.0–0.3 ms; the whole art layer 0.8–1.3 ms, so baking can save a fraction of that. Not built as such: `cardlayer` turns the *whole* resting card into one draw, and `shadowcache` is the pre-rendered shadow. |
| 3. Cull what is covered or off screen | **Built (`cull`)**: −0.3 / −2.1 ms. (The second art layer at rest is already skipped at alpha 0; the page under the hero is not a draw at all.) |
| 4. Remove saveLayers | **Nothing to remove**: 0 samples in `saveLayer`. The cost of `box-shadow` is a blur per frame, not a layer. |
| 5. Stop full-tree invalidation during slides | **Not happening**: slides are RenderNode translations, the UI thread records 0.2 ms per frame. But HWUI *replays* every display list of the tree on every frame regardless — which is what the layers below avoid. |
| 6. Hardware bitmaps / immutable uploads | **No re-upload found** (0.05 % in texture uploads). The only per-frame bitmap work is pinning the SVG icons' mutable bitmaps (4 % of the thread). |

## Part 2 — fixes, one at a time

Mechanism: `adb shell am broadcast -n com.auroratv.lab/com.auroratv.ui.qa.QaReceiver -a com.auroratv.QA --es token
aurora-lab-qa --es cmd exp --es arg "cardlayer=1,cull=1"` (`exp none` clears). Stored in SharedPreferences
`aurora_exp`, read once per process (`AuroraExp.kt`), exposed to JS as `exp('key')` (`src/exp.ts`), and sent in
the `perf` usage event as `exp: "cardlayer+cull"` beside `impl`. `ping` answers `exp=…`. Contract:
`tools/tv-pixel-diff/PROTOCOL.md §3`.

| switch | what it does |
|---|---|
| `cardlayer` | A card that is dark and at rest draws nothing outside its own box, so the native Focusable makes it ONE hardware layer (`setLayerType(HARDWARE)`): border, picture, shade, words, tags are rendered once and then composited as one textured quad. The layer is dropped the moment the card is focused or animating (a layer would cut the ring's shadow) and taken again when it rests dark. `AuroraFocusableView.syncLayer`. |
| `taglayer` | `renderToHardwareTextureAndroid` on the progress bar and on the NEW / kind pills (`Card.tsx`): each is drawn once into its own layer. On the lit card the layers are suspended (v2), because a layer is a bitmap at the element's unscaled size and the lit card is drawn 5.5 % larger. |
| `cull` | The shelf's track and the page column leave children that are wholly off screen (plus 96 dp) out of their display list: `drawChild` returns without drawing; on each slide step the set is recomputed and the host is invalidated only when it changes. Views stay mounted, laid out, focusable. `Cull.kt`. |
| `shadowcache` | A `box-shadow` (the focus ring's, the light ring's, and an element's own — the Play button) gets a host view large enough for the blur, holding RN's own shadow drawable, as a hardware layer: blurred once, then one quad; a ring's fade is the layer's alpha. No layer while the shadow is invisible. `ShadowLayer.kt`. |

### Each fix alone (medians of 3 interleaved rounds; `r5-fix/`, and `r5-combo/` for `taglayer` v2)

| fix | scn | RT CPU ms/frame | Δ | issue p50 / p90 | sync p50 | GPU finish p50 | gfx p50 / p90 | janky % | PSS MB | GPU cache MB | pixels changed (max over 10–11 rest states) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | S1 | 11.8 | – | 14.4 / 15.7 | 1.3 | 6.0 | 23 / 34 | 4.6 | 285 | 76 | – |
| baseline | S2 | 13.0 | – | 14.4 / 20.2 | 2.6 | 7.7 | 24 / 44 | 6.5 | 340 | 88 | – |
| **`cardlayer`** | S1 | **8.4** | **−3.4 (−29 %)** | 14.0 / 15.4 | 1.6 | 4.9 | 21 / 26 | 2.4 | 304 | 87 | ≤ 29,606 px differ at all, **≤ 40 px by more than 1/255, none by more than 2/255** |
| | S2 | **9.9** | **−3.1 (−24 %)** | 11.6 / 14.7 | 2.8 | 6.6 | 17 / 29 | 2.8 | 341 | 88 | |
| `taglayer` v1 (layers also on the lit card) | S1 | 9.2 | −2.6 (−22 %) | 14.3 / 15.7 | 1.5 | 5.9 | 22 / 25 | 1.7 | 243 | 66 | ≤ 4,802 px; **≤ 888 px > 1/255, ≤ 449 px > 8/255, up to 100/255** — all on the lit card's bar or pill (a stretched bitmap) |
| | S2 | 11.0 | −2.0 (−16 %) | 12.8 / 15.4 | 2.7 | 7.7 | 22 / 32 | 2.6 | 323 | 89 | |
| `taglayer` v2 (lit card draws directly) | S1 | 10.2 | −1.4 (−12 %) | 14.2 / 15.6 | 1.5 | 5.9 | 23 / 32 | 3.0 | 277 | 76 | ≤ 23,807 px; ≤ 22 px > 1/255, none > 2/255 |
| | S2 | 11.3 | −1.8 (−13 %) | 13.0 / 16.1 | 2.7 | 7.7 | 22 / 32 | 3.4 | 339 | 88 | |
| `cull` | S1 | 11.5 | −0.3 (−3 %) | 14.7 / 16.2 | 1.1 | 6.0 | 23 / 34 | 4.1 | 282 | 74 | **0 px** in 9 of 10 states; the tenth is the 1/255 noise the baseline shows against itself |
| | S2 | 10.9 | −2.1 (−16 %) | 14.8 / 20.8 | 0.9 | 7.7 | 23 / 38 | 5.0 | 349 | 88 | |
| `shadowcache` | S1 | 11.4 | −0.4 (−4 %) | 14.3 / 15.6 | 1.5 | 5.9 | 23 / 34 | 3.8 | 243 | 50 | ≤ 32,274 px; ≤ 991 px > 1/255, none > 8/255, **max 7/255** (the lit ring's halo) |
| | S2 | 11.9 | −1.1 (−9 %) | 13.3 / 16.4 | 3.1 | 7.7 | 22 / 38 | 4.0 | 291 | 60 | |

(`cardlayer` measured a second time in `r5-combo/`: 8.3 / 10.0 ms, janky 2.1 / 3.1 %, p90 25 / 30.)

Pixels: `tools/tv-pixel-diff/run.py --exp <fix>` captures eleven rest states of Home (`states/render.json`:
billboard, three shelves, a 12-press burst, down four shelves and back, the rail over a shelf) with both sides
all-native — A with every experiment off, B with the fix — and `strict.py` counts every pixel that differs **at
all** (run.py's own verdict uses a perceptual threshold and says "0" for all of these). The noise floor, off
against off (`r5-pixels/null`): 0 px in 7 states, and 38 / 3,195 / 20,375 px differing by exactly 1/255 in three
(the known lit-card halo dither). Tables per run: `r5-pixels/<run>/strict.md`. Motion is not covered by this —
only where things come to rest. (The first five runs had a state `hero-back` that goes UP from the first shelf
onto the billboard; under adb keys that press races the rail — the harness's known `expectGains` case — and
the rail opened in 2 of those 5 runs. It is left out of every number here and was replaced by `row0-back`.)

What did nothing, or nearly: `cull` on S1 (the row slide: only a few cards are off screen horizontally);
`shadowcache` on S1; `taglayer` once `cardlayer` is on (see below).

An alternative to `taglayer` that needs no layer at all: **delete the two `boxShadow`s of the progress bar**
(`x_progshadow`): −1.6 / −1.0 ms. The bar is `overflow: hidden`, so almost all of each glow is already clipped
away; without them 560–1,266 px change per screen (max 46/255), a faint brightening of the track beside the bead.

### The combination, S1–S4 (medians of 3 interleaved rounds; `r5-combo/`)

`ccs` = `cardlayer` + `cull` + `shadowcache`; `all4` adds `taglayer`; `tcs` = `taglayer` + `cull` + `shadowcache`.

| config | scn | RT CPU ms/frame | Δ | issue work p50 / p90 | dequeue wait p50 | GPU finish p50 | whole frame p50 / p90 | gfx p50 / p90 / p99 | janky % | PSS MB | GPU cache MB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | S1 | 11.6 | – | 9.0 / 10.8 | 5.3 | 6.0 | 36 / 38 | 23 / 36 / 61 | 4.9 | 285 | 76 |
| `cardlayer` | S1 | 8.3 | −3.3 (−28 %) | 5.2 / 7.6 | 8.6 | 4.8 | 31 / 33 | 21 / 25 / 53 | 2.1 | 295 | 87 |
| `tcs` | S1 | 9.5 | −2.1 (−18 %) | 7.6 / 8.7 | 6.6 | 5.9 | 34 / 36 | 22 / 32 / 57 | 3.1 | 226 | 45 |
| **`ccs`** | S1 | **7.8** | **−3.8 (−33 %)** | 4.7 / 5.7 | 9.1 | 4.9 | 30 / 32 | 21 / 26 / 48 | 2.1 | 235 | 51 |
| `all4` | S1 | 7.8 | −3.7 (−32 %) | 4.8 / 5.9 | 9.1 | 4.9 | 30 / 32 | 21 / 25 / 53 | 1.7 | 237 | 52 |
| baseline | S2 | 13.0 | – | 13.1 / 18.3 | 0.0 | 7.7 | 45 / 63 | 22 / 44 / 117 | 6.8 | 342 | 88 |
| `cardlayer` | S2 | 10.0 | −3.0 (−23 %) | 7.8 / 12.1 | 0.0 | 6.4 | 32 / 39 | 16 / 30 / 101 | 3.1 | 345 | 88 |
| `tcs` | S2 | 8.2 | −4.8 (−37 %) | 7.9 / 10.7 | 6.6 | 7.7 | 36 / 41 | 22 / 32 / 77 | 3.8 | 262 | 56 |
| **`ccs`** | S2 | **6.7** | **−6.3 (−48 %)** | 5.8 / 8.9 | 1.2 | 5.8 | **16 / 20** | **13 / 29 / 73** | 2.9 | 262 | 61 |
| `all4` | S2 | 6.7 | −6.3 (−48 %) | 5.7 / 8.5 | 1.1 | 6.6 | 16 / 22 | 14 / 28 / 73 | 3.4 | 277 | 66 |
| baseline | S3 | 7.8 | – | 5.8 / 9.2 | 1.8 | 5.6 | 16 / 38 | 16 / 36 / 105 | 4.4 | 345 | 83 |
| `cardlayer` | S3 | 6.6 | −1.2 (−15 %) | 4.4 / 7.6 | 1.2 | 4.3 | 13 / 34 | 14 / 29 / 97 | 3.9 | 369 | 76 |
| **`ccs`** | S3 | **5.5** | **−2.2 (−29 %)** | 3.4 / 5.5 | 1.2 | 4.5 | 12 / 33 | 13 / 27 / 125 | 3.6 | 335 | 87 |
| `all4` | S3 | 5.5 | −2.3 (−29 %) | 3.5 / 5.1 | 0.0 | 4.6 | 12 / 33 | 13 / 28 / 93 | 3.0 | 315 | 87 |
| baseline | S4 | 10.0 | – | 7.5 / 10.3 | 6.8 | 7.8 | 37 / 56 | 25 / 42 / 93 | 4.5 | 292 | 86 |
| `cardlayer` | S4 | 7.9 | −2.2 (−22 %) | 5.0 / 9.0 | 8.7 | 6.6 | 49 / 51 | **32** / 40 / 89 | 3.6 | 290 | 87 |
| **`ccs`** | S4 | **6.3** | **−3.7 (−37 %)** | 4.1 / 5.7 | 10.5 | 6.5 | 49 / 51 | **32** / 38 / 93 | 3.3 | 198 | 30 |
| `all4` | S4 | 6.3 | −3.7 (−37 %) | 4.2 / 5.8 | 10.3 | 6.6 | 48 / 50 | **34** / 38 / 89 | 2.7 | 200 | 34 |

("whole frame" = IntendedVsync → the GPU's completion over the last 120 frames of the run; "gfx" = gfxinfo's own
histogram over the whole run.)

Pixels of the combination (`r5-pixels/ccs`, eleven states): 11,520–41,312 px differ at all, 2–994 px by more than
1/255, **none by more than 8/255, max 7/255**. `all4`: the same within a dozen pixels.

Reading:
- `ccs` is the best; `taglayer` adds nothing on top of `cardlayer` (a resting card is already one quad, and on
  the lit card the tag layers are suspended).
- Stepping through rows is where it shows: the RenderThread's work halves, the pipeline stops running two
  frames deep (whole frame 45 → 16 ms), janky frames 6.8 → 2.9 %.
- Holding along a row the work drops by a third and janky frames by more than half, but the typical frame is
  still presented two vsyncs after its own (30 ms instead of 36): the thread now simply waits longer for a
  buffer (dequeue 5.3 → 9.1 ms). The pipeline's depth, not the app's work, sets that number.
- Memory goes down, not up: the card layers add ~11 MB of GPU cache on their own (`cardlayer` 76 → 87 MB on
  S1), but `shadowcache` frees the large scratch render targets Skia kept for re-blurring shadows (76 → 50 MB
  alone). PSS varies ±20 MB between cold starts; treat its column as "not higher".
- **S4 got worse in one respect.** With `ccs` the rail slide's frames were one vsync deeper in the queue in 5 of
  5 runs (gfxinfo p50 32–34 ms, whole frame 48–49 ms) against 0 of 7 baseline runs (25–26 ms, 36 ms). The work is
  smaller (6.3 vs 10.0 ms), p90 and janky % are better, but the UI thread starts each frame ~10 ms after its
  vsync and the RenderThread waits 10.5 ms in `dequeueBuffer`. Alone, the fixes showed the deeper mode
  only sporadically (by gfxinfo's p50: `cardlayer` 2 of 7 runs, `cardlayer` + `cull` 1 of 3, `cull` or
  `shadowcache` alone 0 of 3; `r5-s4/`). Not explained — see below.

## What could not be determined

- **Why the rail slide sits a frame deeper in the buffer queue with the fixes on** (S4 p50 25 → 32 ms). It is
  queueing, not work, and it is bimodal run to run; which event tips it was not found.
- **Where exactly the 5–10 ms `dequeueBuffer` wait comes from** (buffer count, SurfaceFlinger's latch timing):
  an off-CPU profile (`simpleperf --trace-offcpu`) slows the thread so much that the pipeline leaves that
  regime, and perfetto/atrace was not tried. The wait itself is measured directly (`DequeueBufferDuration`).
- **Why a kind pill costs as much as it does** (1.0–2.1 ms for ~15–20 small pills): a bordered round-rect, its
  fill and a react-native-svg view of four nested nodes with a mutable bitmap. Measured as a whole, not split.
- **Per-op counts of a frame** (display-list ops, RenderNodes): this user build exposes neither the display
  list nor SKP capture. `dumpsys gfxinfo` gives 305–357 views and 541–646 kB of render nodes on Home; the split
  by op type is the profiler's.
- **Other devices.** One TV. The three layer-based fixes assume the app's canvas is drawn 1:1 (960 dp on a
  1920 px panel at density 2, as here). On a panel where `src/canvas.tsx` scales the canvas, a hardware layer
  is rendered at the logical size and stretched — text in a layered card would be soft. Not tested; a product
  version must either size the layer for the scale or skip layering there.
- **Motion.** Pixel identity is proven at rest only. During a slide a layered card is a bitmap moved by a
  fractional offset; nothing looked different by eye on the TV, and nothing measures it.

## Notes on the runs

- The worktree also holds someone else's uncommitted lab work (the art-format experiment: `src/artFormat.ts`,
  `ui/art/`, `api.ts`, `Detail.tsx`, server files). Its switches are off by default. The later builds — certainly the one
  behind `r5-combo/`, the last pixel runs and the build left on the TV, possibly the one behind `r5-fix/` —
  contain that code, inert; the baselines of `r5-diag/`, `r5-fix/` and `r5-combo/` agree (11.7 / 11.8 / 11.6 ms on
  S1, 13.1 / 13.0 / 13.0 on S2). None of it is in this commit.
- `simpleperf` sets the system property `security.perf_harden` to 0 when it records; it was set back to 1. No
  `debug.hwui.*` property and no display override was set. Recordings under `/data/local/tmp` were deleted.
- The earlier stage tables (and `tools/frame-stages.py`) label SwapBuffers → FrameCompleted "swap buffers";
  on this TV that interval is the GPU finishing the frame.

## Files

- Switches: `tv-native/android/app/src/main/java/com/auroratv/ui/AuroraExp.kt` (+ `AuroraImpl.kt` constants,
  `ui/qa/QaReceiver.kt` `exp` command, `MainApplication.kt`), `tv-native/src/exp.ts`, `src/perfTier.ts`.
- Fixes: `ui/view/Cull.kt`, `ui/view/ShadowLayer.kt`, `ui/view/AuroraFocusableView.kt` + `AuroraFocusableManager.kt`
  (`cardlayer`, `shadowcache`, the tag-layer suspension), `AuroraRowView.kt`, `AuroraSlideColumnView.kt` (`cull`),
  `src/components/Card.tsx` (`taglayer`).
- Removals (`x_…`): `Card.tsx`, `Row.tsx`, `Home.tsx`, `NavRail.tsx`, `Ambient.tsx`, `Btn.tsx`, `Icon.tsx`,
  `AuroraCardView.kt`, `AuroraHeroArtView.kt`, `RoundClip.kt`, `AuroraFocusableView.kt`.
- Tools: `tools/tv-render-bench.sh`, `tools/render-parse.py`, `tools/render-report.py`,
  `tools/render-profile.py`, `tools/render-profile-kw.py`, `tools/frame-stages.py`,
  `tools/tv-pixel-diff/run.py --exp`, `tools/tv-pixel-diff/strict.py`, `tools/tv-pixel-diff/states/render.json`.
- Lab manifest: `<profileable android:shell="true"/>`.
- Data: `r5-diag/` (attribution, 2 rounds), `r5-fix/` (sub-attribution + single fixes, 3 rounds), `r5-combo/`
  (S1–S4, 3 rounds), `r5-s4/` (S4 only), `r5-final/` (the installed build, 1 round), `r5-profile/` (profiler
  aggregates, one raw framestats dump), `r5-pixels/` (summaries and `strict.md` per run; the PNG captures stay
  in the worktree, not in git).

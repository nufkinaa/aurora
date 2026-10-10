# Research 2 — the Android rendering pipeline: what else can make Aurora TV smoother

2026-10-10. Read-only research: web sources + AOSP Android 14 source + the lab code (`C:\elia\aurora-lab`,
branch `native-lab`). Nothing was built, no adb. Device facts are the ones in `docs/qa/native-bench/RENDER.md`
(Mi TV MiTV-AFMU0, Android 14, 4 × A55, Mali-G310, 1080p 59.94 Hz, HWUI "Skia (OpenGL)").

Every claim is tagged: **[D]** documented (URL given), **[S]** read in AOSP `android14-release` source,
**[M]** measured by us (RENDER.md / REPORT.md), **[I]** my inference — plausible, not proven on this TV.

Paths: `ui/...` = `tv-native/android/app/src/main/java/com/auroratv/ui/...`.

---

## 0. The three findings that matter most

1. **The two-deep queue is "buffer stuffing", and in the hold scenario it is a latency cost, not a smoothness
   cost.** Frames are produced every 16.8 ms [M] — that is 60 fps. gfxinfo's "23 ms p50" is the age of a frame
   whose start was delayed by the previous frame's buffer wait; it is **not** 45 fps. REPORT.md's sentence
   "Whatever caps Home near 45 fps under input" is, for S1, a reading artefact of gfxinfo. Smoothness must be
   judged by *presented* frames (Perfetto FrameTimeline / `dumpsys SurfaceFlinger --latency`), not by frame age.
2. **Android 14's HWUI has no working recovery from buffer stuffing.** The old heuristic
   (`CanvasContext::isSwapChainStuffed`) is still in the file but is no longer called [S]; real recovery only
   arrived in Android 16 [D]. So once two buffers are in flight they stay in flight until the animation ends.
   An app can recover by itself (skip exactly one vsync of production). Whether we *want* to is a product
   choice: the extra queued buffer is also a one-frame cushion against a late frame.
3. **Our benchmark ran with billboard trailers off.** The hero trailer is a `TextureView`
   (`tv-native/src/components/Trailer.tsx:51-52,152`). A TextureView makes the app redraw its window for
   every video frame and copy the video through the app's GPU [D]. With a RenderThread that needs 8–13 ms per
   frame [M], that is the largest *unmeasured* cost in the real app. A `SurfaceView` with the poster faded out
   above it removes it entirely.

---

## 1. Why a 60 fps producer sits two frames deep, with `dequeueBuffer` blocking ~5 ms

### 1.1 What the pipeline is on Android 14

- An app window's buffers go through a **BLASTBufferQueue that lives in the app's process**. HWUI sizes it:
  `setBufferCount()` asks the window for `NATIVE_WINDOW_MIN_UNDEQUEUED_BUFFERS` and sets
  `bufferCount = min_undequeued + 2` [S: `libs/hwui/renderthread/CanvasContext.cpp:165-178`].
  `min_undequeued` follows SurfaceFlinger's "max acquired buffer count":
  `max(1, ceil((appWorkDuration + sfWorkDuration) / vsyncPeriod) − 1)`
  [S: `SurfaceFlinger.cpp` `calculateMaxAcquiredBufferCount`, `getMaxAcquiredBufferCountForRefreshRate`;
  `BLASTBufferQueue.cpp:174-175`]. With ordinary 60 Hz durations that is 1, so the window has **3 buffers**
  ("triple buffering"); a vendor config whose app + SF durations add up to more than two periods gives 4.
  [I] which one this TV has — `dumpsys SurfaceFlinger` prints the durations (see §6).
- The dequeue timeout is infinite: "set dequeue timeout explicitly so that dequeueBuffer will block"
  [S: `libs/gui/BLASTBufferQueue.cpp:156-158`]. HWUI never uses swap interval 0.
- A buffer comes back to the app only when SurfaceFlinger has latched a *newer* one and released the old one —
  i.e. on SurfaceFlinger's clock, once per vsync.
- https://source.android.com/docs/core/graphics/implement-vsync [D]: app and SF wake at different offsets from
  hardware vsync; the normal path is already two periods from app vsync to photons.

### 1.2 The mechanism

With 3 buffers: one is on screen (held by SF), one is drawn into. If a **second finished buffer** is ever waiting
for SF, the app has nothing free, and `dequeueBuffer` blocks until SF's next latch. From then on the app makes
exactly one frame per vsync and SF consumes exactly one per vsync, so the extra buffer never drains. That is the
textbook definition:

- Perfetto [D] https://perfetto.dev/docs/data-sources/frametimeline — *BufferStuffing*: the app "keeps sending
  new frames to SurfaceFlinger before the previous frame was even presented"; frames are then presented late
  however fast the app is, the app can block waiting for a buffer, and animation can stay smooth while latency
  rises.
- Android games docs [D] https://developer.android.com/games/sdk/frame-pacing — the display pipeline holds "a
  queue of frames, typically of size 2", which fills; with no room "the rendering thread is blocked by an OpenGL
  or Vulkan call" and there is "an extra frame of latency".
- AOSP's own note [D] https://android.googlesource.com/platform/frameworks/native/+/android-16.0.0_r2/libs/gui/BufferStuffing.md —
  it starts when one frame is missed while "the client continues producing buffers at the same rate"; the client
  then "has one less buffer to render into" and must "wait for buffer release callbacks".

How the second buffer gets there [I, the standard cause]: **one late frame at the start of the motion.** The
first key press costs a long frame (focus change, JS, a mount). Its Choreographer callback finishes inside the
next vsync interval, and the next callback runs immediately after it: two buffers are queued inside one
interval, SF can show only one. From there the queue is one deeper for the rest of the hold.

Our numbers fit this in four independent ways:

| observation [M] | what stuffing predicts |
|---|---|
| S1: frames every 16.8 ms, yet "whole frame" 36 ms; `dequeueBuffer` 5.3 ms | cadence locked to SF's release; each frame aged by the wait in front of it |
| S1 with `ccs`: work −3.8 ms, **dequeue wait +3.8 ms** (5.3 → 9.1), whole frame only 36 → 30 | the RenderThread reaches `dequeueBuffer` earlier and waits for the *same* release instant; saved work turns into waiting |
| S2 baseline: dequeue 0.0 ms, frame 45 ms; S2 `ccs`: 16 ms | S2 was work-bound: an app that misses vsyncs drains the queue by itself. Once fast enough, and with no burst, it runs one-deep |
| S4 with `ccs`: one vsync deeper in 5/5 runs vs 0/7; bimodal; UI thread starts ~10 ms after its vsync; dequeue 10.5 ms | lighter frames make "two frames inside one interval" after the opening hiccup possible *every time*; before, the heavier frames often could not catch up, so the queue stayed shallow. The UI thread starts late because its sync blocks on a RenderThread that is still inside `dequeueBuffer` for the previous frame |

So the S4 "regression" is most likely not a regression of work but the app becoming fast enough to stuff the
queue reliably [I]. It costs one vsync of latency on that slide and no frames.

### 1.3 Why nothing recovers on this TV

- HWUI used to drop a frame when the swap chain looked stuffed (`dequeue` or `queue` ≥ 6 ms for three frames).
  In `android14-release` `isSwapChainStuffed()` is defined at `CanvasContext.cpp:363` and **called nowhere**;
  `prepareTree` only skips a frame when it "already drew for this vsync pulse" [S]. (Our 5.3 ms p50 would have
  sat just under the old 6 ms threshold anyway.)
- Recovery was added in Android 16: Choreographer shifts the animation timeline by one frame when the client is
  found blocked in `dequeueBuffer` (flag `android.view.flags.buffer_stuffing_recovery`) [D: BufferStuffing.md
  above; https://android.googlesource.com/platform/frameworks/native/+/e524dd9d13].

### 1.4 The knobs asked about — which an app controls, which could matter

| knob | app-controllable? | applies / could explain or fix the queue? | gain for us |
|---|---|---|---|
| BufferQueue size (`min_undequeued + 2`) | No (HWUI + SF decide) [S] | It *is* the queue. 3 vs 4 buffers decides whether "two deep" or "three deep" is possible (S4 at 49 ms hints at more than 3 — [I], check) | — |
| EGL swap interval | No for a View window (HWUI owns the EGL surface) | Not the cause; interval 0 would drop/tear, not help | none |
| HWUI frame pacing | No | Android 14 has none that recovers (§1.3) | — |
| SF app/SF vsync offsets, early wake-up (`ro.surface_flinger.*`, `debug.sf.*`) | No (vendor; `debug.sf.*` via adb shell only) | Decide the 5–10 ms phase between our `dequeueBuffer` and SF's release, and the buffer count. Explain the *size* of the wait, not its existence | none (read them, §6) |
| `debug.hwui.render_ahead` | No. In Android 14 it is `ro.hwui.render_ahead`, read-only, default 0 [S: `libs/hwui/Properties.cpp:41-42`] | It is the *deliberate* version of what we have: an extra queued frame as a cushion | none |
| `Surface.setFrameRate` / `FRAME_RATE_COMPATIBILITY_*` | Yes | Only chooses the display mode. Useful for the **player** (24/25 fps content on a 59.94 panel, if the TV's "match content frame rate" is on); irrelevant to browse | none for browse |
| `Window.setFrameRateBoostOnTouch` | API 35, VRR panels, touch | Not on this TV | none |
| ADPF `PerformanceHintManager` | **Yes** (API 31+) | HWUI has its own session (UI thread, RenderThread, HWUI pool) but it is **off unless the device sets `debug.hwui.use_hint_manager`**: default `false` [S: `Properties.cpp:84,148`; `HintSessionWrapper::init`]. Not about the queue; about CPU speed. See §1.5 | unknown → measure |
| `windowIsTranslucent` / `Window.setFormat` | Yes | Our window is already opaque: theme `Theme.AppCompat.DayNight.NoActionBar`, no translucency (`res/values/styles.xml:4`). SF already treats the layer as opaque; the buffer stays RGBA_8888 either way | none |
| Remove the window background | Yes | Already done: `styles.xml:19` + `DeviceModule.dropWindowBackground()`. It is one colour op inside the same surface, never a separate SF layer | none left |
| Wide colour / HDR surface | Yes (`android:colorMode`) | Manifest sets none → sRGB 8-bit. Nothing to remove | none |
| `setSustainedPerformanceMode` | Yes | Made for long VR sessions; *lowers* peak to avoid throttling | none / negative |
| Amlogic HWC: device vs client composition, OSD/video planes, AFBC | No | With one opaque full-screen app layer HWC should scan it out from the OSD plane with no SF GPU pass [I]. If `dumpsys SurfaceFlinger` shows the layer as CLIENT, SF's GPU pass shares our Mali and cores — it would lengthen "GPU finish" and SF's latch. Worth one look (§6). Generic rule [D] https://source.android.com/docs/core/graphics/hwc : more layers than planes → GPU composition | none expected |

### 1.5 CPU frequency: the unmeasured variable behind "11.7 ms of work" [I]

All four cores are A55; there is no big core to migrate to, only frequency. The RenderThread uses ~70 % of one
core at most, the UI thread 20–35 %; a `schedutil`-style governor may hold the cluster below its top frequency.
Our "ms of RenderThread CPU" would then be ms at a reduced clock. Nothing in RENDER.md rules this out.

- Measure: `cat /sys/devices/system/cpu/cpufreq/policy0/stats/time_in_state` before/after S1 and S2.
- If the cluster is not at top frequency during a hold: (a) lab test `setprop debug.hwui.use_hint_manager true`
  + app restart; (b) product fix: our own hint session — `PerformanceHintManager.createHintSession(tids, 16.6 ms)`
  [D] https://developer.android.com/reference/android/os/PerformanceHintManager with the UI thread, the JS
  thread and the RenderThread (its tid is readable from `/proc/self/task/*/comm`), reporting each frame's
  duration from the JankStats/FrameMetrics listener we already have (`DeviceModule.kt:38`). It returns null when
  the device has no support — then nothing is lost.
- Gain: none if already at top frequency; **medium–large** if not (work scales with clock). Effort: 1 hour to
  measure, 1 day to build. Risk: low.

### 1.6 What to do about the queue

- **Decide with a trace first** (§6) — confirm "Buffer Stuffing" on the FrameTimeline and the buffer count.
- **Option A — leave it.** Held-key slides are continuous motion; one frame of lag inside the motion is not
  visible, and the first frame after a key is not affected (the queue is empty at rest). The cushion hides an
  occasional late frame. Fix the *metric* instead (§6).
- **Option B — recover like Android 16 does.** In `ui/anim/AuroraClock.kt:27-43` skip stepping the drivers for
  exactly one vsync when stuffing is detected, then continue on frame time (the drivers already take
  `frameTimeNanos`, so the motion stays time-correct). Detection without hidden APIs: `FrameMetrics`
  `TOTAL_DURATION` > 1.5 × period for ≥ 3 consecutive frames while `INTENDED_VSYNC` advances one period at a
  time and input+animation+layout+draw+sync is small. Rate-limit (HWUI's old code used 500 ms).
  Gain: −1 vsync (16.7 ms) end-to-end latency during holds and on the rail slide; S1 "whole frame" 30 → ~14 ms;
  **no gain in dropped frames, possibly a few more visible ones**. Effort: 1–2 days with the pixel/trace
  harness. Risk: medium (a deliberate one-frame hold; RN's own animations can still draw in the skipped vsync).

---

## 2. Reducing draw-op count and RenderThread CPU

State after the measured fixes (`ccs`): RenderThread 7.8 ms (S1) / 6.7 ms (S2) per frame; issue work 4.7–5.8 ms,
sync 1.5–2.8 ms, swap call 0.8 ms [M]. The remaining cost is per *RenderNode* and per *op on the lit / unlayered
parts*, over ~305–357 views [M].

| # | technique | what / evidence | applies to us | gain | effort | risk |
|---|---|---|---|---|---|---|
| 2.1 | Hardware layer per resting card | [D] https://developer.android.com/develop/ui/views/graphics/hardware-accel : drawn once, then translation/alpha/scale are free; layers "consume video memory" | Built: `ui/view/AuroraFocusableView.kt:437-447` | **large**, measured −24..29 % | done (lab) | Layers hurt when their content changes: every `invalidate()` inside re-renders the layer in its own render pass (expensive on a tile-based Mali). Keep a card unlayered until its picture has landed and any fade is over; never layer the lit card (already so). A layer is the size of the unscaled view — see RENDER.md "other devices" |
| 2.2 | Pre-blurred shadow bitmap instead of a shadow layer | One stretchable bitmap (nine-patch style, blurred once per radius/colour) drawn with `drawBitmap`; no per-instance layer, no `BlurMaskFilter` | Replaces `ui/view/ShadowLayer.kt` for the ring / Play glow; replaces or deletes the progress bar's two `boxShadow`s (`x_progshadow` −1.6 / −1.0 ms [M]) | **medium** on the lit card and Continue Watching (the parts layers cannot cover) | 1–2 days | Pixels differ slightly from RN's blur; needs a pixel-diff budget |
| 2.3 | **One View per card: tags, pill, progress bar, icon and text drawn in `AuroraCardView.onDraw`** | Each child view is a RenderNode: walked in `prepareTree` even under a layer ([S] `RenderNode::prepareTreeImpl` recurses into children), replayed when unlayered. The docs' first tip: "Reduce the number of views" [D, same URL] | Today text stays RN text, pills and bars are RN views, icons are react-native-svg views with a mutable bitmap each (pinned every frame: 4 % [M]); the kind pill alone is 1.0–2.1 ms [M] | **medium**: est. −1..−2 ms RT on top of `ccs` (sync 1.5 → <1; lit and newly mounted cards cheaper) [I], plus less Fabric/JS mount work per card | 1–2 weeks (text via a `StaticLayout` built once per title; icons as immutable bitmaps or `Path`s) | Text must match RN's line breaking exactly (the pixel harness exists); accessibility labels must be kept |
| 2.4 | One View (or one layer) per shelf | Row at rest = 1 quad instead of ~7 | After 2.1 a row is already ~7 quads; quads are not our cost | small | medium | A row-sized texture (1920 × ~300 px ≈ 2.3 MB each), re-rendered whenever any card's image lands or focus moves in the row |
| 2.5 | `TextureView` / `SurfaceView` per row | Extra producer / extra SF layers | No: more layers than the SoC has UI planes pushes SF into GPU composition [D hwc] | negative | — | — |
| 2.6 | Texture atlas / `drawBitmapMesh` / `drawVertices` | Lets Skia merge textured quads into one draw call | Textured quads are 3.7 % of the thread, images 5.8 % [M]; posters are dynamic content | small (<0.3 ms) | high | — |
| 2.7 | `PrecomputedText` / `StaticLayout` reuse / text as bitmap | Moves *layout* off the UI thread; drawing glyphs is unchanged | UI thread is 1.1 ms/frame [M]; card text is 0.2–0.8 ms and already inside the card layer | none in steady state; small at mount | — | — |
| 2.8 | Rounded clips | `clipPath(roundRect)` on API 29+ is a hardware clip, no layer | Measured 0.0–0.3 ms (`x_clip`) [M]; `ui/view/RoundClip.kt:65-69` | none | — | — |
| 2.9 | Elevation shadows | Tessellated, cached geometry — cheap, but a different look (not a coloured glow) | Would change the design | small | low | visual change |
| 2.10 | `RenderEffect` blur | Applied on the GPU each frame the node is drawn [I] | Not used anywhere in `ui/`; do not introduce it on a G310 | negative | — | — |
| 2.11 | `setHasOverlappingRendering(false)` | Avoids a `saveLayer` for alpha | Already false in `ReactViewGroup`; 0 % `saveLayer` [M] | none | — | — |
| 2.12 | `HardwareRenderer` knobs | The public ones are for own render trees; `debug.hwui.*` are adb-only | Buffer age / partial updates are on by default [S `Properties.cpp:50`] | none | — | — |
| 2.13 | Hardware bitmaps (`Bitmap.Config.HARDWARE`) | Uploaded off the frame, never pinned: "avoid jank caused by texture uploads at draw time", half the memory [D] https://bumptech.github.io/glide/doc/hardwarebitmaps.html | We decode ARGB_8888 everywhere on purpose (`MainApplication.kt:48`, `ui/view/AuroraCardView.kt:482`, `ui/image/AuroraBitmaps.kt:21`). Steady-state uploads are 0.05 % [M], so the gain is only the **one frame in which a 1920-wide hero bitmap is first drawn** (an ~8 MB upload on the RenderThread) and the baked PNGs | small–medium on p99 when the hero changes; none on p50 | 2–3 days (hero + baked art via `ImageDecoder`; Fresco's cards stay as they are) | breaks code that reads pixels or draws to a software canvas |

Skia batching note [I, from how Ganesh works]: consecutive same-kind ops (rect fills, round-rects, text from one
atlas) merge into one draw; a different shader, clip effect or texture between them breaks the run. The
profile's "4.8 % looking up a GL program per draw" [M] is that. The practical lever is not "help Skia batch" but
"have fewer ops" (2.1–2.3).

---

## 3. Going past Views

| option | what it would buy, given our bottleneck is op / node count | cost | verdict |
|---|---|---|---|
| **Own renderer in one `SurfaceView` (GL / Vulkan / Skia)** — the Netflix-Gibbon / LightningJS model: everything is a cached texture, a frame is a list of quads | Draw-issue work for ~80 quads would be well under 1 ms, and we would own frame pacing (presentation timestamps, as the Frame Pacing library does [D]). But after 2.1–2.3 HWUI is already drawing mostly quads; the realistic extra saving is ~3–4 ms of a 7 ms thread that already fits in 16.7 ms [I] | Months: text shaping and rasterising to textures, texture memory management, a focus engine, TalkBack through a virtual tree, losing RN views for everything inside it | **Not worth it.** Large effort, small remaining gain, highest risk |
| **Compose for TV** | Compose draws through the same HWUI RenderNodes and Skia; a composable is not a RenderNode unless it has a graphics layer, so a card is one display list — the same thing 2.3 achieves with a custom View | Rewrite of every screen and leaving RN for them | **No rendering win.** Field reports on weak TV hardware are mixed-to-negative: developers report D-pad scroll jank in the standard LazyColumn-of-LazyRows layout that persists after the first visit, and lag on cheap sticks (Kotlin Slack: https://slack-chats.kotlinlang.org/t/34171952/hi-everyone-i-m-working-on-an-android-tv-app-using-the-lates , https://slack-chats.kotlinlang.org/t/511830/i-created-an-app-in-compose-for-androidtv-i-m-now-ditching-c — seen as search summaries only, the pages would not load; treat as anecdote). Google moved TV lists onto the standard lazy layouts in Foundation 1.7 [D] https://developer.android.com/training/tv/playback/compose/lists . No benchmark showing Compose beating Views on a low-end TV SoC was found |
| **Leanback / RecyclerView rows** | Why they are smooth [D] "RecyclerView Prefetch" (Chet Haase, Google Developers on Medium) and https://developer.android.com/reference/androidx/recyclerview/widget/LinearLayoutManager : a bounded view count (recycling + a shared `RecycledViewPool`), `GapWorker` creating and binding the next items in the idle part of a frame, `setInitialPrefetchItemCount` for nested rows, the item view cache. This attacks **mount cost on the UI thread and view count**, not per-frame replay. Our `cull` already keeps off-screen nodes out of the RenderThread (sync 2.6 → 0.9 ms [M]) | The RN-compatible form: a native row that takes **data, not children**, and creates / binds / recycles native card views itself (needs 2.3 first). 2–4 weeks | **Medium, for a different symptom**: hitches when shelves mount or a long row is held to its end, memory, start-up. None for steady-state frame time |

---

## 4. Video under the UI on an Amlogic box

- **TextureView** [D] https://developer.android.com/media/media3/ui/surface : its contents "must be copied
  internally" into the app's UI; SurfaceView has "significantly lower power consumption", "more accurate frame
  timing", and is composited by the hardware composer as an overlay. For us: every decoded video frame
  invalidates the window, so HWUI draws and swaps a frame 24–60 times a second even when nothing in the UI
  moves, and the video is sampled by our Mali into our buffer.
- **SurfaceView**: the video is its own SurfaceFlinger layer behind a hole in our window. On Amlogic the decoder
  output goes to the SoC's video plane and the UI to the OSD plane, blended by display hardware [I — matches
  public descriptions of Amlogic boxes; confirm with `dumpsys SurfaceFlinger`: two layers, both DEVICE]. The UI
  is not redrawn when the video advances.
- Our code: hero trailers use `ViewType.TEXTURE` so that the cross-fade's opacity reaches the picture
  (`tv-native/src/components/Trailer.tsx:51-52,152`); the full-screen player already uses a SurfaceView
  (`tv-native/src/canvas.tsx:18-22`).
- **Fix**: a SurfaceView for the hero too, with the cross-fade done the other way round — keep the billboard art
  in the UI layer *above* the hole and fade the art's alpha to 0 (and back to 1 before the player is released).
  Views drawn after the SurfaceView in the same window are composited on top of it.
- Gain: **large while a trailer plays** (removes a forced redraw per video frame plus a GPU copy; S1/S2 with a
  trailer running were never measured — expect them to be clearly worse than the tables). None with trailers
  off. Effort: 3–5 days including pixel states for the fade. Risk: medium — both SF layers must get planes; the
  hole is black if the first video frame is late (hold the art until the player reports its first rendered
  frame); on a scaled canvas the SurfaceView must scale the same way.

---

## 5. Start-up and steady state

| item | evidence | us | gain | effort | risk |
|---|---|---|---|---|---|
| **Baseline Profile + `androidx.profileinstaller`** | [D] https://developer.android.com/baseline-profiles : ~30 % faster code from first launch. For sideloaded APKs ProfileInstaller queues the profile for the next background dexopt [D] https://developer.android.com/topic/performance/baselineprofiles/debug-baseline-profiles . The install filter is `speed-profile`, which **without a profile equals `verify`** (interpreter + JIT) [D] https://source.android.com/docs/core/runtime/configure/package-manager | A self-updating sideloaded app with no profile in the APK (none under `android/app/src/main/`). After every update our Kotlin and RN's Java (Fabric mounting, view managers, our views and drivers) start interpreted | **medium for cold start and the first minute** (first focus moves, first shelf mounts); none for a warmed-up hold | 2–3 days (Macrobenchmark generator, or a hand-written profile for `com.auroratv.**` + `com.facebook.react.**`) | low |
| Force AOT on our own TVs | `adb shell cmd package compile -m speed -f com.auroratv` | Immediate, but lost on each app update | same as above, zero dev | minutes per TV | none |
| R8 | Smaller, inlined dex | `enableProguardInReleaseBuilds = false` (`android/app/build.gradle:135,218`) | small (start-up) | 1–2 days of keep rules | medium (reflection in RN libraries) |
| ART GC | Concurrent; short pauses, but the GC thread takes a core for a while | Bitmaps are native memory; per-frame garbage is small (`ui/anim/AuroraClock.kt:31` allocates one small array per animated frame — trivial to remove) | small | hours | none |
| `largeHeap` | Raises the Java heap ceiling only | No Java-heap pressure is reported | none | — | — |
| Trim-memory | Fresco's registry is wired (`MainApplication.kt:26-42,109-129`) | Fine as is | none | — | — |
| **Image decodes competing during a held key** | Fresco decodes on a pool sized to the core count at background priority [I, Fresco defaults]; with 4 cores, UI + RenderThread + JS already want three. REPORT.md's 3-core load test shows how far p90 / janky move under CPU pressure [M] | `ui/image/AuroraImages.kt`; RN's default Fresco config (`MainApplication.kt:56-70`) | **small–medium on p90 while new cards stream in**; none when art is cached. Options: `ImagePipeline.pause()` while a key auto-repeats and `resume()` at rest, or cap decode threads at 2 | 1–2 days | cards show the blur-up longer during a fast hold |
| Thread priorities | RenderThread already runs at display priority; nothing to raise. `TrailersModule.kt:73` threads run at default priority — give them `THREAD_PRIORITY_BACKGROUND` | | small | minutes | none |
| ADPF hint session | §1.5 | | unknown | | |

---

## 6. Measuring better than gfxinfo

What gfxinfo cannot say: whether a frame was *presented on its vsync*. Its durations include waits (buffer,
GPU), so a perfectly smooth stuffed pipeline reads as "23–36 ms frames".

1. **Perfetto FrameTimeline** (Android 12+; runs from the adb shell on a user build; the lab manifest is
   already `profileable`, `AndroidManifest.xml:54`) [D] https://perfetto.dev/docs/data-sources/frametimeline .
   Data sources: `android.surfaceflinger.frametimeline` + ftrace `sched/*` + atrace categories `gfx view sf hal
   input`. Per frame it gives expected vs actual present and a jank type: *AppDeadlineMissed* (our work),
   *BufferStuffing* (our queue), *SurfaceFlingerCpu/GpuDeadlineMissed*, *DisplayHAL*, *PredictionError*.
   Expected result [I]: S1 frames on time but tagged "Buffer Stuffing", the janky few "App Deadline Missed";
   S4 + `ccs` stuffed from the second frame on. The trace also shows the queued-buffer counter of our layer
   (`QueuedBuffer - …BLAST#n`, [S] `BLASTBufferQueue.cpp:169`) and the RenderThread's `dequeueBuffer` slices
   against SF's latch — the direct proof RENDER.md could not get with simpleperf.
   Extra: `setprop debug.hwui.skia_tracing_enabled true` [S `libs/hwui/Properties.h:157`] puts Skia's ops in
   the trace — the per-op counts RENDER.md lists under "could not be determined".
2. **`dumpsys SurfaceFlinger --latency <layer>`**: desired present, actual present and frame-ready for the last
   ~127 frames. An `actualPresent` step that is not one period = a really dropped frame. This should become
   the bench's headline number ("frames presented late per 1000"), replacing gfx p50.
3. **`dumpsys SurfaceFlinger`** once: composition type of our layer (DEVICE vs CLIENT), layer count with and
   without a trailer, app / SF work durations and offsets (→ the buffer count of §1.1).
4. **JankStats** (already in `DeviceModule.kt`): on API 31+ it judges against the frame deadline, so stuffed
   frames are over-reported as slow. Add `FrameMetrics` `DEADLINE` and the UI-side durations to the `perf` event
   so field data can separate "late because of work" from "late because of the queue".
5. **Macrobenchmark `FrameTimingMetric`** [D, Android developers "Macrobenchmark metrics" page]:
   `frameDurationCpuMs` (work only, no waits) and `frameOverrunMs` (against the deadline, API 31+), computed
   from the same Perfetto data. Worth it only if the bench moves to instrumentation; item 1 gives the same facts.
6. **CPU frequency residency** (§1.5).

Fixing Buffer Stuffing, in order of preference: (a) accept it for held slides; (b) a one-vsync skip in our
clock (§1.6 B); (c) nothing else is available to a View-based app on Android 14 — swap interval, buffer count
and SF offsets are not ours.

---

## 7. Ranked top 10

| # | action | expected gain on our numbers | effort | risk |
|---|---|---|---|---|
| 1 | Ship `cardlayer` + `cull` + `shadowcache` (already measured) and remove or pre-bake the progress bar's two glows | RT 11.6 → 7.8 ms (S1), 13.0 → 6.7 ms (S2), janky halved [M]; the glows a further ≤ 1.0–1.6 ms on Continue Watching | days | low–medium (scaled-canvas panels) |
| 2 | Hero trailer on a SurfaceView with the art fading above it | large whenever a trailer plays (unmeasured today) | 3–5 days | medium |
| 3 | Perfetto FrameTimeline + `SurfaceFlinger --latency` in the bench; headline metric = frames presented late | no ms by itself; ends the "45 fps" misreading and settles S4 | 1–2 days | none |
| 4 | Measure CPU frequency during S1/S2; if below top, an ADPF hint session (UI + RenderThread + JS) | unknown: none … large | 1 h + 1 day | low |
| 5 | One View per card (tags, pill, bar, icons, text drawn natively) | −1..−2 ms RT beyond #1, cheaper mounts, removes the SVG bitmap pinning | 1–2 weeks | medium |
| 6 | Baseline Profile + ProfileInstaller (and `cmd package compile -m speed` on our TVs now) | cold start and first-minute hitches; ~30 % on cold Java paths [D] | 2–3 days / minutes | low |
| 7 | Replace every RN `boxShadow` on moving elements with one pre-blurred stretchable bitmap | 0.6–1.9 ms on the lit-card paths that layers cannot cover; frees the shadow layers | 1–2 days | low (pixel budget) |
| 8 | Pause or cap image decoding while a key is held | p90 / janky during holds through uncached art | 1–2 days | low |
| 9 | Buffer-stuffing recovery (skip one vsync) in `AuroraClock` | −16.7 ms latency in holds and on the rail slide; no smoothness gain | 1–2 days | medium |
| 10 | Hardware bitmaps for hero / backdrop and baked art; later, data-driven recycling rows | p99 when the hero changes; mount hitches and memory | 2–3 days; weeks | medium |

## 8. Sounds good, will not help us

- **Own GL / Vulkan / Skia renderer for browse** — after layers HWUI is already compositing quads; months of work for ~3 ms on a thread that fits its budget.
- **Jetpack Compose for TV** — the same HWUI/Skia underneath; no evidence that it beats Views on weak TV SoCs, some that it does worse.
- **Rendering at 720p** — already measured: only the GPU part shrinks, and the GPU is not the limit [M].
- **Window tricks**: `setFormat(OPAQUE/RGBX)`, `windowIsTranslucent`, removing the window background — already opaque, already done.
- **`setFrameRate`, `setFrameRateBoostOnTouch`, `setSustainedPerformanceMode`, wide-colour settings** — nothing to gain on a fixed 59.94 Hz sRGB panel (`setFrameRate` belongs in the player only).
- **`render_ahead`, swap interval, SurfaceFlinger offsets, Vulkan HWUI (`ro.hwui.use_vulkan`)** — device properties, not an app's.
- **`largeHeap`** — our memory is bitmaps and GPU caches, not Java heap.
- **`RenderEffect` blur, elevation shadows** — the first is a GPU blur per frame, the second a different look.
- **Texture atlas / `drawBitmapMesh` / `drawVertices`** — saves draw calls on quads, which are ~4 % of the thread.
- **`setHasOverlappingRendering(false)`, hunting `saveLayer`s, removing rounded clips** — measured at zero.
- **`PrecomputedText`** — moves layout work we do not have (UI thread 1.1 ms per frame).
- **A `TextureView` / `SurfaceView` per row** — more SF layers than the SoC has planes means GPU composition in SurfaceFlinger.
- **Flattening the billboard** — measured: ±0.2 ms [M].

## 9. Not verified here

- This TV's buffer count, vsync offsets and HWC composition types (needs `dumpsys SurfaceFlinger`).
- That FrameTimeline labels our frames "Buffer Stuffing" (needs one trace). Until then §1.2 is the best-fitting
  explanation, not a proven one.
- Amlogic plane assignment for a SurfaceView under our UI (the vendor HWC source is not public).
- CPU frequency behaviour, and whether this TV accepts hint sessions.
- The Compose-on-TV reports are forum anecdotes; no controlled benchmark was found either way.
- The vendor's Android 14 may differ from AOSP `android14-release` (a vendor could carry its own HWUI patches).
- Estimates marked [I] in §2–§5 (ms saved by 2.3, the hero upload cost, Fresco's thread defaults) are
  reasoned from our measurements, not measured.

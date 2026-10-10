# How the smoothest TV apps are built, and what transfers to Aurora

Research date: 2026-10-10. Scope: public engineering sources only (engineering blogs, conference talks, official docs, open-source repos).

Reading guide:

- **[F]** = documented fact, with the URL it comes from.
- **[I]** = my inference from those facts. Not stated by the source.
- **[?]** = something the brief asked about for which I found no public source. I say so rather than fill the gap.

Our own numbers, used throughout to judge relevance (Mi TV, 4-core Amlogic, Mali, 1080p60): main thread 3-6 ms/frame; RenderThread 11.7-13.1 ms/frame, dominated by the number of draw operations per card (picture + shade + tags + ring/shadow, redrawn every frame of a slide); caching each resting card as one GPU layer + culling + cached shadows halves janky frames; rare 60-150 ms frames when React mounts new cards during key-repeat; a held key sits two frames deep in the buffer queue.

The one-sentence finding: every fast TV stack, without exception, is a **retained tree of pre-rasterised textures that the renderer composites**, with **no element creation and no layout on the key-press path**, and with **animation limited to transform/opacity and run off the app-logic thread**. Our measurements say we already have a cheap logic thread and an expensive draw thread, so the patterns that matter most for us are the ones that cut draw operations per frame and remove mounting from key-repeat, not the ones that replace JavaScript.

---

## 1. Netflix on TV

**Architecture**

- [F] Three layers: "an SDK installed natively on the device, a JavaScript application that can be updated at any time, and a rendering layer known as Gibbon." https://netflixtechblog.com/crafting-a-high-performance-tv-user-interface-using-react-3350e5a6ad3b
- [F] History: Flash Lite (2009) -> QtWebKit (2010) -> their own "custom JS+native graphics framework" (2013). They left WebKit because their app is "a long-lived, single-page, image and video heavy user interface" and they "wanted optimizations for apps that do not need reflowable content". https://netflixtechblog.com/pioneering-application-design-on-tvs-tv-connected-devices-e361dbe02f66 and https://netflixtechblog.com/building-the-new-netflix-experience-for-tv-920d71d875de
- [F] The framework is a retained scene graph: "optimized for fast 2D rendering of images, text and color fills. We render from a tree of graphics objects ... Display property changes in these objects are aggregated then applied en masse post user interaction." (pioneering-application-design link above)
- [F] Surfaces: "A bespoke rendering pipeline enables granular control over surfaces, the bitmap data representation of one or more graphics objects. Our surfaces are similar to accelerated compositing surfaces used by modern browsers. Intelligent surface allocation reduces surface (re)creation costs and the resulting memory fragmentation over time. Additionally we have fine-grained control of image decode activity leading up to surface creation." (same link)
- [F] JS engine: JavaScriptCore without JIT ("an older non-JIT version of JavaScriptCore"); V8 and SpiderMonkey with JIT were "impractical" across chipsets. (both links above)
- [F] React-Gibbon (2015 rewrite): a custom React renderer whose only primitive is a "widget" with inline style, instead of div/span. (crafting link)
- [?] "Their move to a new rendering architecture": the only rendering-architecture moves I found documented by Netflix are WebKit -> Gibbon (2013) and the React-Gibbon rewrite (2015). I found no first-party engineering post describing a newer renderer; the 2025 TV redesign is covered by product/press posts only.

**Frame budgets, device floor, memory**

- [F] Device floor: "sub-GHz single core CPUs, low memory and limited graphics acceleration"; range is "hundreds of different devices" from PS4 Pro to budget sticks. (crafting link)
- [F] Memory arithmetic they design around: an accelerated animated rectangle costs width x height x 4 bytes; "animating one scene at 1080p would require close to 8MB ... but at 720p requires 3.5MB. We see devices with as little as 20MB memory allocated to a hardware-accelerated rendering cache." (building-the-new-netflix-experience link)
- [F] They rank memory at least as high as speed: "for Netflix TV we actually care about memory at least as much as performance, maybe more so." https://netflixtechblog.com/fixing-performance-regressions-before-they-happen-eab2602b86fe
- [F] The four metrics they steer by: Key Input Responsiveness ("the time taken to render a change in response to a key press"), Time To Interactivity, Frames Per Second, Memory Usage. (crafting link)
- [F] Production metrics also include TTR (time to render) and "empty box rate (how frequently titles in the viewport are missing images)". (regressions link)
- [?] I found no published per-frame millisecond budget from Netflix for low-end devices beyond the 60 fps goal.

**What they did to make key presses fast (all [F], crafting link)**

- Inline `React.createElement` at build time (Babel plugin); avoid refs so inlining works everywhere (focus is declarative: `<Widget focused={true} />`).
- Fewer props through component stacks ("death by a thousand props"); prototype-chain prop merging took a 100-deep/100-prop case from ~500 ms to ~60 ms.
- Split styles into static and dynamic so unchanged style is skipped by reference; a Babel plugin generates a per-widget `__update__` function so no style-key iteration happens at runtime.
- "Custom Composite Component - hyper optimized for our platform", "**Pre-mounting screens** to improve perceived transition time", "**Component pooling in Lists**", "Memoization of expensive computations".

**Device classes and motion tiers**

- [F] "grouping devices into performance classes that give us entry points to turn different knobs such as **pool sizes, prefetch ranges, effects, animations, and caching**". (building-the-new-netflix-experience link)
- [F] Effects pipeline (blur, desaturation, masking, tinting) is implemented "very close to the metal"; "cinematic animations & effects" are reserved for consoles. (pioneering + building links)
- [F] Netflix exposes a user-facing switch to reduce TV animation effects: https://help.netflix.com/en/node/130349 (I could read the page title, not its body.)
- [?] A published list of "what Netflix refuses to animate on weak devices" does not exist as far as I can find. What is documented is the mechanism (performance classes with an "animations" and "effects" knob), not the per-class table.

**Input**

- [F] Focus is a single source of truth: a `focusPath` held in app state; spatial navigation runs on a "focusable tree" culled from the widget tree; nearest-neighbour search borrowed from collision detection (frustum filter + Minkowski difference). https://netflixtechblog.com/pass-the-remote-user-input-on-tv-devices-923f6920c9a8
- [?] That post does not describe key-repeat throttling/coalescing. I found no Netflix source on key-repeat handling.

**Images**

- [F] Fine-grained control of image decode before surface creation; prefetch ranges per device class; "empty box rate" as a tracked metric (links above).
- [?] Texture atlases for box art, placeholder strategy: not documented publicly as far as I can find.

**Regression control**

- [F] ~50 performance tests per pull request on real and virtual devices, each run 3 times; memory tests take the max, responsiveness tests the median; alerts on > 4 standard deviations above the mean of the last 40 runs, plus changepoint detection over the last 100. Alert volume fell to 10% of the static-threshold era. (regressions link)

---

## 2. Other apps

### Prime Video (Amazon)

- [F] 2022 state: a thin on-device C++ layer (JS VM, input, media, network, image decoding); downloadable part = JavaScript app + the low-level engine. They moved the low-level engine ("scene management, the animation system, graphics rendering, layout, and resource management") from JavaScript to Rust compiled to WebAssembly. The Wasm VM and the JS VM run "in separate threads" and talk by messages, so that "the job of the Wasm components is to update nodes and pump frames out to the screen as fast as possible without any interruptions." https://www.amazon.science/blog/how-prime-video-updates-its-app-for-more-than-8-000-device-types
- [F] Measured result on a mid-range TV: average frame time 28 ms -> 18 ms, worst case 40 ms -> 25 ms. Wasm VM uses at most 7.5 MB; JS heap fell by 30 MB; 37,000 lines of Rust; Wasm binary 150 KB compressed. (same link)
- [F] What stayed in JS in 2022: the application/business logic (React-style UI code). (same link)
- [F] 2024 state (QCon SF talk): they then rewrote the app itself in Rust, on a new UI SDK with signals/effects reactivity (SolidJS-inspired), widgets (row, column, label, image, stack), and an entity-component-system under the scene tree. Reason: with logic in JS, input latency stayed poor on "dual-core devices with not even 1 gigahertz". Input latency on a low-end device: 247 ms (collections page) and 440 ms (details page) in JS/React -> 33 ms for both in Rust; mid-range ~70 ms -> 16-33 ms. Migration was page by page (profiles, collections, details first; search and settings stayed in JS at the time of the talk). https://www.infoq.com/presentations/prime-video-rust
- [F] A deliberate API constraint: app code cannot read back layout results ("It's impossible to read where on the screen an element ends up after layout"). (same talk)
- [I] The two steps are separable lessons. Step 1 (engine off the JS thread) fixed frame times. Step 2 (decisions off the JS thread) fixed input latency. On our box the JS/main thread is already 3-6 ms, so step 2 is not where our time goes; step 1's principle (the thread that produces frames is never blocked by app logic or element creation) is the part that applies.

### Disney+ (and Hulu/ESPN on the same platform)

- [F] "Native Client Platform v2", codename m5, shipped as the Disney+ ADK: runtime "written entirely from the ground up in C '99" (rendering, input, network, a Wasm interpreter); render hardware interface ("Steamboat RHI") over OpenGL ES / DirectX / Metal / PlayStation; the app itself is "Written in Rust, compiled to WebAssembly, remotely web hosted". Targets "10+ year old MIPS based devices" up to consoles. They benchmark on Raspberry Pis; a dev build ran at 71 FPS on a Raspberry Pi 4. https://medium.com/disney-streaming/introducing-the-disney-application-development-kit-adk-ad85ca139073
- [F] Stated reason for not using a browser: set-top browsers differ so much that "each new device becomes essentially a new application development cycle", and with a browser "there is no way for Disney Streaming engineering to fix a problem in the browser implementation." (same link)
- [?] Disney has not published the renderer's internals (scene graph, texture handling) that I could find; job postings only confirm C/C++/Rust and "a custom in-house runtime". https://jobs.disneycareers.com/job/seattle/senior-software-engineer-rust/391/76104815568
- [F] Disney+ Hotstar (web stack on TVs) is a separate case study: replaced a third-party carousel with an in-house one using composited animations, read card dimensions once per tray instead of per card, lazy-rendered trays (2 visible + 1 above/below), yielded long tasks, made tasks cancellable (abort a trailer fetch when the user moves on), preloaded next-page assets. INP 675 ms -> 272 ms; tray interaction ~400 ms -> ~100 ms; weekly card views per user 111 -> 226. https://web.dev/case-studies/hotstar-inp

### YouTube on TV (Cobalt / Starboard)

- [F] Cobalt is "a lightweight HTML5/CSS/JS application container" implementing only a subset of the web platform; Starboard is its C porting layer. https://cobalt.googlesource.com/cobalt/+/19.lts.stable/src/cobalt/site/docs/overview.md
- [F] Design rules in that overview: single process; no JIT required; shaders precompiled (no runtime shader compilation); "optimized to run on single-core CPUs"; the surface cache "never exceeds a predefined budget"; **animations only "for properties that don't affect layout, like `transform`", and they "always run animations on a separate thread"**; "the renderer and resource loader do not compete with layout operations". (same link)
- [F] Tuning knobs they expose to device makers: image cache size (and a multiplier to shrink it during video playback), glyph atlas size, a software surface cache, minimum frame interval, **render dirty region only**, thread priorities "to ensure animations remain smooth during JavaScript execution". https://cobalt.googlesource.com/cobalt/+/refs/heads/24.lts.stable/cobalt/doc/performance_tuning.md
- [F] (via Collabora's write-up, which I could only read in summary) Google is now merging Cobalt back onto Chromium ("Chrobalt") for standards and security updates while keeping Starboard. https://www.collabora.com/news-and-blog/news-and-events/re-engineering-youtube-for-the-living-room-bringing-%E2%80%9Cchrobalt%E2%80%9D-to-rdk.html
- [?] "Kabuki" (the YouTube TV web app's internal name): I found no public engineering description of its internals.

### Hulu

- [F] (2018) For consoles and Fire TV, Hulu is "a fully hosted modern web application written in HTML and JavaScript" on their "Client Device Platform", which embeds "a specially customized fork of Webkit". But **iOS, tvOS, Android and Roku are native apps**, because those platforms "benefit immensely from having their client experiences built as native applications - particularly when it comes to performance and access to native UX components." https://medium.com/disney-streaming/building-the-hulu-experience-in-the-living-room-10eabf5391d6
- [F] Their low-power lesson (Quickdraw.js): smooth animation failed while bindings "created and modified DOM elements during their changes - this caused reflows, repaints and garbage collection cycles"; the fix was to batch and defer all tree changes to an explicit render step (a full update of 50-100 ms, with the rendering part under 10 ms). https://medium.com/hulu-tech-blog/open-sourcing-hulus-data-binding-library-for-low-powered-living-room-devices-introducing-4e44a7eb5f1d

### Spotify TV

- [F] The TV/console app is "a web-based Single Page Application" on the Spotify Web API, built by a single team; it was the model for their 2019 web player rewrite. https://engineering.atspotify.com/2019/3/building-spotifys-new-web-player
- [?] No published rendering/performance detail found.

### Plex

- [F] Plex is rewriting its TV and mobile apps on one **React Native** codebase, Apple TV first (preview early 2025). The stated reasons are development speed and consistency ("It allows us to move faster", "If you fix a bug, it should be fixed everywhere"), not smoothness. https://www.lowpass.cc/p/plex-apple-tv-app-relaunch-tvos-react-native
- [I] Relevant to us only as evidence that a commercial TV app considers react-native-tvos viable; Plex has published no frame-time data.

### Kodi

- [F] Own GUI engine with **dirty-region rendering**: "By not re-rendering what hasn't changed the GUI can be sped up." Modes: union of dirty rects ("typically the fastest mode for slower GPUs due to only making one pass"), per-region, or whole-screen-if-anything-dirty (the safe default, because some drivers clear the buffer; "Almost all ARM-based devices ... will likely have flickering issues" with partial modes). https://kodi.wiki/view/HOW-TO:Modify_dirty_regions
- [F] Skin images are compiled ahead of time by TexturePacker into one `Textures.xbt`, "converting all images into a format that take less processing by Kodi when they need to be rendered" (the file may be larger than the sources: it trades size for load speed). https://kodi.wiki/view/TexturePacker
- [F] Library artwork goes through a texture cache: downscaled to a maximum box (default 1920x1080 for 16:9 fanart, 1280x720 for everything else), "re-encoded in a decoder-friendly way so that the image can be displayed as quickly as possible"; for "lagging GUI navigation on low powered equipment" the documented remedy is to lower those sizes. https://kodi.wiki/view/Artwork/Cache

### Jellyfin for Android TV

- [F] Leanback is being replaced incrementally, screen by screen: 0.20.0-beta.1 migrates the settings screens to Compose and "Recreate[s] LegacyImageCardView with compose" (PR #5343), i.e. Compose cards hosted inside Leanback rows. https://github.com/jellyfin/jellyfin-androidtv/releases and https://github.com/jellyfin/jellyfin-androidtv/pull/5343
- [F] The maintainers' own verdict on the hybrid: "Leanback <> Compose have the worst interop ever." https://github.com/jellyfin/jellyfin-androidtv/pull/5884
- [F] A downstream fork measured the hybrid home screen on a Google TV Streamer: p50 32 ms / p95 117 ms per frame, 14% janky, "because each card is its own Compose view inside a Leanback row"; proposed fix: Compose-native rows or fewer compositions per card. https://github.com/lucas-romanenko/jellyfin-tentacle-androidtv/issues/56 (a fork, not the official project)
- [F] A (closed, unmerged) PR to the official repo lists what moved the needle, measured with `gfxinfo`/atrace on a Google TV Streamer at 1080p60: retain and pre-lay-out rows so vertical moves do not create/measure a row of cards in the D-pad frame; keep focus state local to the focus-dependent overlay instead of recomposing the whole card; only the focused card subscribes to live progress; **debounce backdrop/metadata until focus has settled**; size backdrop requests to the display. Janky frames 7.38% -> 2.87%, p95 77 -> 38 ms; the largest `RV OnLayout` slice 90.6 ms -> 7.6 ms. https://github.com/jellyfin/jellyfin-androidtv/pull/5789
- [I] This is the closest public twin of our problem (cards as a declarative-UI subtree inside a native recycler, long frames when a row of cards is created during D-pad), and its fixes are the same five we would list.

### Stremio

- [F] `stremio-core` is "the single Rust codebase that contains all the logic shared between Stremio apps"; "The UIs are thin layers on top". Elm-style: UI dispatches an Action, models update and return Effects, runtime emits NewState. https://github.com/Stremio/stremio-core
- [F] An Android binding exists (Rust + protobuf bridge): https://github.com/Stremio/stremio-core-kotlin
- [I] Rust here is for shared logic, not for rendering. It says nothing about scroll smoothness; the platform shell still draws.

### SmartTube

- [F] Open-source Android TV client; the repo vendors Leanback (`leanback-1.0.0`) and a patched ExoPlayer (`exoplayer-amzn-2.10.6`). https://github.com/yuliskov/SmartTube
- [I] Its smoothness on cheap boxes is Leanback's: a RecyclerView per row, simple cards (one image + two text lines), fixed focus position, D-pad moves coalesced by the grid (see section 4).

---

## 3. Apple TV

**What tvOS gives every app for free**

- [F] Rendering is split across processes. The app does Event and Commit; then "The render server takes that submission, and prepares it for drawing on the GPU" and "The GPU draws your UI into a final image". Two kinds of hitch exist: commit hitch (app late) and render hitch (render server late). https://developer.apple.com/videos/play/tech-talks/10855/
- [F] Core Animation animations are handed to the render server and keep running even if the app's main thread is blocked. Apple engineer in WWDC 2014 session 419, summarised at https://nonstrict.eu/wwdcindex/wwdc2014/419/ ; independent explanation: https://medium.com/@beefon/should-you-use-pop-b986b10d4079
- [F] The same Apple talk says the pipeline is double-buffered: "The frame is processed for two frames before display". (tech-talks/10855)
- [F] Collection views give cell reuse and a prefetch protocol: "advance warning of the data requirements ... allowing the triggering of asynchronous data load operations", with cancellation when the data is no longer needed. https://developer.apple.com/documentation/uikit/uicollectionviewdatasourceprefetching
- [F] Focus motion is a system service: layered images (foreground/mid/background) give the parallax effect; the system, not the app, animates it. https://developer.apple.com/design/human-interface-guidelines/images
- [F] TVUIKit ships the standard lockups (TVLockupView, TVCardView "responds to focus interaction with a motion effect", TVMonogramView...). https://developer.apple.com/documentation/tvuikit
- [F] TVMLKit (the JS/markup route) "is deprecated in tvOS 18 and later"; Apple directs apps to SwiftUI or UIKit. https://developer.apple.com/documentation/tvmlkit
- [I] "Metal-backed blur" (UIVisualEffectView) is real and cheap on that GPU, but I did not find an Apple document that quantifies it, so treat it as hardware headroom rather than a technique.

**Hardware class**

| | Apple TV 4K (3rd gen, 2022) | Mali-G31-class Android TV (e.g. Amlogic S905X4 / T972) | Ratio |
|---|---|---|---|
| CPU | Apple A15, 5-core variant [F] https://everymac.com/systems/apple/apple-tv/specs/apple-tv-4k-3rd-gen-a15-2022-a2737-wifi-only-specs.html , https://macrumors.com/2022/11/14/new-apple-tv-5-core-cpu | 4x Cortex-A55 ~1.9-2.0 GHz [F] https://www.cnx-software.com/2021/11/11/amlogic-t972-multimedia-networking-sbc-supports-4k-v-by-one-displays/ | |
| Geekbench 5 single-core | ~1730 (A15 in iPhone 13) [F] https://www.laptopmag.com/news/iphone-13s-a15-bionic-shows-off-upgraded-benchmarks-pixel-6-pro-falls-behind | 159 (S905X4 box) [F] https://browser.geekbench.com/v5/cpu/9137852 | ~11x |
| Geekbench 5 multi-core | ~4621 (6-core iPhone 13; the Apple TV has 5 cores, so somewhat lower [I]) | 543 [F] same Geekbench entry | ~8x |
| GPU, 3DMark Wild Life | ~11,090 (A15 5-core GPU, Wild Life Unlimited average) [F] https://www.notebookcheck.net/Apple-A15-GPU-5-Core-GPU-Benchmarks-and-Specs.582222.0.html | 124 (Mali-G31 MP2, Wild Life) [F] https://hwpure.com/submission/1170-mali-g31-mp2-3dmark-wild-life | ~90x (different run modes: order of magnitude only) |
| GPU, Geekbench 6 Metal | 20,818 (Apple TV 4K 3rd gen) [F] https://applesilicongames.com/device/apple-tv-4k-3rd-generation | no comparable figure found | |
| GPU fill rate | not published | Mali-G31 MP2: 2.6 Gpix/s at 650 MHz [F] https://androidpctv.com/amlogic-s905y4-comparative/ | |

Caveats: I do not know the exact SoC in our Mi TV, only "4-core Amlogic, Mali"; older Mi TVs use Cortex-A53 with Mali-450, which is weaker still. The Geekbench CPU rows are like-for-like (same benchmark version); the GPU row mixes Wild Life and Wild Life Unlimited and is good for an order of magnitude only.

[I] What the fill-rate figure means: 1080p60 needs 1920 x 1080 x 60 = 124 Mpix/s per full-screen layer. A theoretical 2.6 Gpix/s is about 21 full-screen layers of plain fill per frame, and real textured, blended, shadowed drawing gets a fraction of that. A row slide that redraws backdrop + gradient + several cards each with picture, shade, tags and a soft shadow is already spending a visible part of the whole GPU. On the A15 the same scene is noise.

**Hardware vs compositor vs app design** [I], reasoned from the facts above:

- *Hardware* is the largest single part: roughly 10x CPU and far more than 10x GPU. An Apple TV app can be drawn carelessly and still hit 60.
- *Compositor model* is the second part, and it is exactly our measured bottleneck. On tvOS a resting poster is a layer whose bitmap already exists; sliding a row means the render server re-composites existing textures with new transforms, in another process, regardless of what the app is doing. On Android the RenderThread **replays the recorded display list of every view in the damaged area each frame** unless a view has been put in a hardware layer (https://developer.android.com/develop/ui/views/graphics/hardware-accel: unchanged views "can be redrawn simply by re-issuing the previously recorded display list"; a hardware layer is "rendered ... into a hardware texture" so alpha/translation/scale apply "directly onto the layer"). Our finding that "one GPU layer per resting card" halves jank is us rebuilding Core Animation's default by hand.
- *App design we can copy*: fixed-position focus with one system-standard motion; cell reuse plus prefetch with cancellation; lockups that are one image + minimal text; no bespoke per-card decoration animated during movement.
- Not an Apple advantage: pipeline depth. Apple documents two frames from event to display too. Our "two frames deep" on a held key is normal for a double-buffered compositor, not a defect of our app.

---

## 4. Android TV first-party guidance

- [F] Leanback is deprecated; Google's guidance is Compose for TV, migrating whole fragments at a time, starting with small screens. https://developer.android.com/training/tv/playback/leanback/migrate-to-compose
- [F] Leanback's core idea: `BaseGridView` keeps "the selected position ... at a predefined location" via window alignment + item alignment (ItemAlignmentFacet): the content moves, focus does not. https://developer.android.com/reference/androidx/leanback/widget/BaseGridView
- [F] **Key-repeat coalescing is built in.** Javadoc of `setSmoothScrollMaxPendingMoves`: "When holding DPAD, DPAD events are generated faster than the grid view can scroll. The grid view counts unhandled DPAD events and completes the movement after user release DPAD ... The default value is 10." The implementation is one `PendingMoveSmoothScroller` ("remembers pending DPAD keys and consume pending keys during scroll"): the first key starts one continuous scroll; later keys only increment a counter. Source: https://github.com/androidx/androidx/blob/androidx-main/leanback/leanback-grid/src/main/java/androidx/leanback/widget/BaseGridView.java and GridLayoutManager.java in the same folder.
- [F] RecyclerView prefetch: creating/binding a new item in the frame it is needed pushes the RenderThread past the deadline; prefetch moves create/bind into the UI thread's idle gap of the previous frame, in parallel with the RenderThread, using per-view-type timing averages to decide whether the work fits. Nested lists (rows inside a column, i.e. every TV home screen) need `setInitialItemPrefetchCount()` on the inner list. Also: "a minimal view tree will always be cheaper to create and bind". https://medium.com/google-developers/recyclerview-prefetch-c2f269075710
- [F] Hardware layers: turn them on for the animation and off afterwards because "hardware layers consume video memory"; overdraw rule of thumb "not ... more than 2.5 times the number of pixels on screen per frame"; "Reducing views is one of the easiest ways to optimize your UI". https://developer.android.com/develop/ui/views/graphics/hardware-accel
- [F] Memory on low-RAM TVs (1 GB / 720p UI, or 1.5 GB / 1080p UI): app total <= 280 MB, of which graphics 30-40 MB. Image rules: never load above UI resolution; use hardware bitmaps (Glide `ALLOW_HARDWARE_CONFIG`) so pixels are not held twice; "Avoid intermediate renders"; use colours, not images, as placeholders; **"Don't composite multiple images" on device, compose offline**. https://developer.android.com/training/tv/playback/memory
- [F] Compose performance: stable keys in lazy lists, `derivedStateOf`, defer state reads into lambdas so a changing value skips composition and layout; Baseline Profiles precompile critical paths. https://developer.android.com/develop/ui/compose/performance/bestpractices
- [F] TV quality checklist: Baseline Profiles "to improve overall performance, including app startup and reducing jank" (TV-BP); memory limits on low-RAM devices (TV-ME). https://developer.android.com/docs/quality-guidelines/tv-app-quality
- [?] I found no Google document giving numeric rules for focus-animation duration or card image sizes beyond "not above UI resolution"; Leanback's `FocusHighlight` only offers fixed zoom steps (none/xsmall/small/medium/large). https://developer.android.com/reference/android/support/v17/leanback/widget/FocusHighlight

---

## 5. Web-tech TV stacks

### LightningJS (Comcast / Sky / NBCU; "10M+ embedded devices")

- [F] WebGL 2D renderer with its own render tree, no DOM, no CSS layout. https://github.com/rdkcentral/Lightning/blob/master/docs/RenderEngine/index.md , production list: https://github.com/lightning-js/renderer
- [F] Per frame it (1) visits only branches tagged `hasUpdates`, (2) fills one coordinate buffer for visible on-screen textures, (3) draws. Stated contributors to speed: "No rendering of invisible parts", "Detection of out-of-screen branches, which enables ... (nearly) infinite, high-performance scrolling lists", and "No re-rendering when no changes are detected". (RenderEngine/index.md)
- [F] Every element is a texture (image, text, rectangle) or nothing; text is rasterised once to a texture; images are decoded in a Web Worker by default (`useImageWorker`); GPU memory is capped in pixels (`memoryPressure`, default 24e6; "A single pixel uses between 4 and 6 bytes") with unused-texture cleanup when the cap is hit. https://github.com/rdkcentral/Lightning/blob/master/docs/RuntimeConfig/index.md
- [F] `renderToTexture` flattens a subtree into one texture; a global `precision` setting renders the whole 1080p-authored UI at 720p (2/3) to cut memory and fill. (RuntimeConfig + https://github.com/rdkcentral/Lightning/blob/master/docs/RenderEngine/Elements/Rendering.md)
- [F] Lightning 3 moves text to SDF glyph atlases built at build time. https://lightningjs.io/blogs/lng3FontRendering.html
- Correction to the brief: [F] the documented atlas in Lightning is for glyphs. I found no documentation of an automatic image atlas for posters; posters are individual textures.

### Roku SceneGraph

- [F] A retained node tree owned by a dedicated render thread; app logic that blocks belongs in Task threads; "all BrightScript code executing on the render thread must execute within 16 milliseconds". https://developer.roku.com/docs/developer-program/core-concepts/threads.md and https://developer.roku.com/docs/developer-program/performance-guide/optimization-techniques.md
- [F] Crossing threads costs a "rendezvous" per field access; guidance is to "build an entire tree of nodes ... then pass the tree to the Render thread using one rendezvous". (threads.md)
- [F] Images: "Determine the appropriate size, then resize the image once outside the main render thread"; "An image that needs to be scaled takes more time to process by the GPU"; `Poster.loadWidth/loadHeight` decode to target size. (optimization-techniques.md, https://developer.roku.com/docs/references/scenegraph/renderable-nodes/poster.md)
- [F] `RowList`: item components are "created on demand for each visible item" and rebound through `itemContent`; **the focus indicator is one separate bitmap** (`focusBitmapUri`, ideally a 9-patch) that either floats or stays fixed while the row scrolls under it (`rowFocusAnimationStyle`). https://developer.roku.com/docs/references/scenegraph/list-and-grid-nodes/rowlist.md

### What these designs imply for weak hardware [I]

1. Cost is counted in textured quads and blended pixels per frame, not in "views". Everything is pre-rasterised once and then only moved.
2. Layout is either absent (Lightning: explicit x/y) or done once at build of the node, never during scroll.
3. The focus ring is one object that moves, not a property of every card.
4. Nothing is drawn when nothing changed; dirty tracking is at the tree level.
5. Image decode and text rasterisation are off the frame thread, to the exact size, before the item is on screen.
6. A global resolution dial (720p UI on a 1080p panel) exists as the device-class escape hatch.

---

## 6. Pattern table

Impact is judged against our numbers: RenderThread 11.7-13.1 ms is the standing cost, mounts during key-repeat are the worst frames, main thread has headroom.

| Pattern | Who uses it (documented) | Why it helps | Do we already? (from our measurements) | How we could adopt it | Expected impact for us | Effort |
|---|---|---|---|---|---|---|
| Card = one pre-composited texture (retained, not re-issued draw ops) | Netflix surfaces; Core Animation layers; Lightning textures / renderToTexture; Android hardware layers; Google: "don't composite multiple images on device" | Sliding N cards becomes N quads instead of N x (picture + shade + tags + ring + shadow) operations | Partly: per-card GPU layer cache proved it halves jank | Make it structural: bake shade/gradient (and ideally static tags) into the artwork on our server (it already produces sized/blurred variants); card view = one image + at most one text run; keep the layer only while resting/sliding | **Large**: attacks the measured dominant cost directly | Medium |
| Focus ring/shadow as one separate moving element | Roku RowList focus bitmap; Leanback fixed focus position; tvOS system focus | Removes ring + shadow from every card's draw list; only one soft shadow exists on screen | Partly: shadows cached, but still per card | One overlay view (9-patch or pre-rendered ring + shadow) at the fixed focus slot; cards carry no ring/shadow at all | **Medium-large**: shadows and rings are the most expensive per-card ops on a tile GPU | Small-medium |
| No mount/unmount during key-repeat: fixed recycling pool sized to viewport + margin, rebind only | Netflix "component pooling in lists"; RecyclerView/Leanback; Roku RowList; UICollectionView reuse; Jellyfin PR ("retain and pre-layout rows") | Creation + layout + first draw of a card is the one thing that cannot fit in a frame; rebind is setters only | No: this is our 60-150 ms frame | Pool of card instances per row created at screen build; moving along a row changes props/position of existing instances; rows above/below kept mounted and pre-laid-out | **Large** for worst-case frames (removes the visible hitch), small for the average | Medium (JS-level pool) to large (native recycler) |
| Create ahead in idle time (prefetch) with cancellation | RecyclerView GapWorker; UICollectionView prefetch; Netflix "prefetch ranges"; Hotstar cancellable tasks | When something must be created, do it in the idle gap of an earlier frame, never in the frame that needs it | Not stated in our data | If a pool cannot cover a case, mount the next cards after the slide settles or in idle callbacks, k items ahead in the direction of travel; cancel on direction change | Medium | Small-medium |
| Input coalescing during key-repeat (count pending moves, one continuous scroll) | Leanback `PendingMoveSmoothScroller` (max 10 pending) | One animation absorbs N key events; per-key work shrinks to a counter; scroll speed is bounded by what can be drawn | Not stated; a held key is "two frames deep", which suggests each repeat is handled as its own move | Handle repeat in native: first key starts a constant-velocity scroll, repeats extend the target, release settles on the nearest card; emit one focus event to JS at settle (plus a cheap "passing index" if needed) | **Medium-large** on held-key smoothness; also makes the pool sufficient | Medium |
| Settle, then enrich | Jellyfin PR (debounce backdrop/metadata until focus settles); Hotstar (abort trailer fetch on move); Netflix (changes "applied en masse post user interaction") | Heavy work (hero backdrop, metadata, trailer, blur) never competes with the slide | Not stated | Gate hero/backdrop/detail fetch and any big texture upload on ~150-300 ms of rest; cancel on move | Medium | Small |
| Animate transform/opacity only, on the render side; cap concurrent animations | Cobalt (only non-layout properties, separate thread); Core Animation render server; Android layers; Prime's Wasm engine thread | A frame of animation needs no layout, no re-raster, no app thread | Largely: main thread is 3-6 ms, so animations are not blocked by JS; unknown how many run at once | Audit: during a slide exactly one translation (the row) + one focus overlay tween; no per-card scale/elevation/opacity tweens in parallel; no animated blur or shadow radius | Small-medium | Small |
| Cull off-screen; draw nothing when nothing changed; dirty regions | Lightning (off-screen branch detection, no re-render when idle); Kodi dirty regions; Cobalt dirty-region option | Fewer quads; idle screen costs zero | Yes for culling (we measured it) | Extend to rows fully off-screen and to the hero when covered; verify no perpetual invalidation at rest (gfxinfo should show no frames while idle) | Small (mostly banked) | Small |
| Decode to exact drawn size, off-thread, upload before visible; hardware bitmaps | Roku (`loadWidth`), Kodi texture cache, Lightning image worker, Android TV memory guide, Netflix decode control | No scaling on GPU, no decode on frame thread, half the memory | Largely: server already serves sized variants | Confirm requested size == drawn pixel size on the TV, hardware-bitmap config on, decode finished before the card enters the pool's visible range; colour (not image) placeholders | Small-medium (protects against regressions and texture-upload spikes) | Small |
| Device performance classes / motion tiers | Netflix (pool sizes, prefetch ranges, effects, animations, caching per class; user "reduce animations" setting); Lightning `precision`; Android low-RAM class | The weakest device gets a design that fits it, without holding back the rest | Not stated | 2-3 tiers keyed on measured frame time at first run (we already collect TV frame timings): tier C = no blur, no shadow, shorter slides, smaller pools, optionally 720p UI surface | Medium on the weakest boxes, none on good ones | Small-medium |
| Pre-mount / preload the next screen | Netflix "pre-mounting screens"; Hotstar asset preloader; RecyclerView nested prefetch | Screen transitions feel instant; no mount storm on Enter | Not on TV as far as the data shows | When focus rests on a card, pre-build the details screen shell off-screen and fetch its data | Medium (perceived speed, not frame rate) | Medium |
| Thin, batched bridge between logic and renderer; logic cannot read layout back | Prime Video (message bus, no layout read-back); Roku (one rendezvous for a whole tree); Hulu Quickdraw (batch, explicit render); Netflix (aggregate then apply) | No sync round-trips mid-frame; frame thread never waits on app logic | Mostly: main thread has headroom | Keep focus/scroll state native-side; JS receives settled events; forbid measure-in-layout patterns in card code | Small | Small |
| Engine/logic rewritten in Rust or C | Prime Video, Disney+ | Removes a slow non-JIT JS VM from the frame and input path on sub-GHz devices | n/a | See "going really deep" below | **Small for us today** (our logic thread is not the bottleneck) | Very large |
| Per-commit performance tests on real devices with anomaly detection; Baseline Profiles | Netflix; Google TV quality guideline TV-BP | Stops regressions; fewer JIT/class-load hitches early in a session | Partly: we have a bench rig and frame-timing analytics | Fix a small scripted suite (hold-right 5 s, row-change x10, open/close details), compare median and p95 against the last N runs; add a Baseline Profile for the native side | Small now, large over time | Small-medium |

---

## 7. Ranked top 10 for Aurora

1. **One texture per card, built once.** Bake shade/gradient/static badges into the art server-side; a resting or sliding card is a single quad. Our RenderThread time is draw-op count; this is the only lever that removes ops instead of speeding them up. (Netflix surfaces, Core Animation, Lightning, Google's "compose offline".)
2. **A fixed card pool per row; rebind, never mount, while a key is down.** Removes the 60-150 ms frames. (Netflix pooling, RecyclerView, RowList, Jellyfin PR.)
3. **One focus overlay** (ring + shadow as a single pre-rendered element at a fixed slot) instead of ring/shadow on every card. (Roku RowList, Leanback, tvOS.)
4. **Coalesce key-repeat natively**: first press starts one continuous scroll, repeats add to a pending count (Leanback caps at 10), JS hears about it at settle.
5. **Settle, then enrich**: hero, backdrop, metadata, blur, trailers only after focus rests; cancel on move. (Jellyfin PR, Hotstar, Netflix.)
6. **Prefetch in idle time with cancellation** for anything the pool cannot cover: next row, next page of a row, decoded art k cards ahead. (RecyclerView prefetch, UICollectionView prefetch, Netflix prefetch ranges.)
7. **Performance classes** driven by our own frame-timing telemetry: the weakest tier drops blur/shadow, shortens slides, shrinks pools, and may render the UI at 720p. (Netflix, Lightning `precision`.)
8. **Animation discipline**: during movement exactly one row translation and one overlay tween, transform/opacity only, layers on for the animation and released after. (Cobalt, Android hardware-layer guidance.)
9. **Pre-mount the next screen** while focus rests on a card. (Netflix, Hotstar.)
10. **Lock it in**: a small per-commit device suite with median/p95 comparison against recent runs, plus a Baseline Profile and exact-size hardware-bitmap decode checks. (Netflix regression system, Google TV quality guideline.)

### "Going really deep": what a rewrite would and would not buy [I]

- The deep rewrites in the industry (Netflix Gibbon, Prime's Rust engine, Disney's C runtime, Cobalt) were driven by two things we do not have: a slow or non-JIT JS VM on sub-GHz CPUs, and the need to ship one binary to thousands of device types without a usable native toolkit. Prime's headline (247 -> 33 ms input latency) came from taking app logic off a slow JS thread. Our main thread is already at 3-6 ms.
- The rewrite that matches our measurements is narrower: **one native "shelf" view** (a row or the whole grid of rows) that owns the card pool, focus position, key-repeat handling and scrolling, draws each card as one bitmap, and exposes a data-only interface to React. That is items 1-4 implemented in one component. It is what Leanback's grid, Roku's RowList and UICollectionView are, and Hulu states it builds Android TV natively for exactly this reason. Effort: large but bounded (one component), and it can be adopted screen by screen as Prime and Jellyfin did.
- A full custom GPU renderer (our own scene graph on OpenGL/Vulkan, bypassing Android views) would let us batch all cards into a handful of draw calls from a real atlas. It is what Lightning and Gibbon do. Expected gain over a well-made native shelf: small-to-medium on this GPU, because after items 1-3 the remaining cost is fill rate, which no renderer avoids. Cost: text, accessibility, focus, image pipeline, and every Android quirk become ours. Not justified for a household app.
- Jellyfin's experience is the warning for half-measures: a declarative card subtree hosted per item inside a native recycler is the slowest combination (14% janky in the fork's measurement). If we go native for the shelf, the card inside it must be native-drawn too.

### What hardware alone explains (what software cannot fix on a cheap box)

An Apple TV 4K's A15 is about 11x faster per core than a Cortex-A55 Amlogic chip (Geekbench 5: ~1730 vs 159) and its GPU is one to two orders of magnitude ahead of a Mali-G31 MP2 (3DMark Wild Life: ~11,000 vs 124, different run modes, so order of magnitude only). On top of that, tvOS composites every layer as a cached texture in a separate process by default, which is the behaviour we have to build by hand on Android. So part of "Apple TV feels smoother" is real and permanent on our hardware: a Mali-G31's fill rate (2.6 Gpix/s on paper, about 21 plain full-screen layers per 1080p60 frame, far fewer once textured and blended) means full-screen blur, large soft shadows, stacked translucent gradients over a moving backdrop, parallax with several layers, and many simultaneous animations will never be free; at 4K UI resolution they are out of reach. A single slow A55 core also means any creation of views in the frame that needs them will miss the deadline, whatever the language, and the two-frame latency from key to photon is the compositor's pipeline (Apple documents the same two frames) and will not go to zero. What is not hardware: the number of draw operations per card, mounting during key-repeat, per-key animations instead of one coalesced scroll, and enrichment competing with movement. Those account for the janky frames we actually measured, and the apps that are smooth on boxes weaker than ours (Netflix on sub-GHz single cores, YouTube/Cobalt on single-core CPUs, Lightning on 2014-era set-top browsers) got there by restricting what is drawn and when, not by having more hardware. A realistic target on the Mi TV is a steady 60 fps for row and column movement with a plainer card and one focus overlay; an Apple-TV-like look with live blur and layered parallax at 60 fps is not a realistic target on this GPU.

---

## Source list

Netflix
- https://netflixtechblog.com/crafting-a-high-performance-tv-user-interface-using-react-3350e5a6ad3b
- https://netflixtechblog.com/pass-the-remote-user-input-on-tv-devices-923f6920c9a8
- https://netflixtechblog.com/building-the-new-netflix-experience-for-tv-920d71d875de
- https://netflixtechblog.com/pioneering-application-design-on-tvs-tv-connected-devices-e361dbe02f66
- https://netflixtechblog.com/fixing-performance-regressions-before-they-happen-eab2602b86fe
- https://help.netflix.com/en/node/130349

Prime Video
- https://www.amazon.science/blog/how-prime-video-updates-its-app-for-more-than-8-000-device-types
- https://www.infoq.com/presentations/prime-video-rust

Disney / Hulu / Hotstar
- https://medium.com/disney-streaming/introducing-the-disney-application-development-kit-adk-ad85ca139073
- https://medium.com/disney-streaming/building-the-hulu-experience-in-the-living-room-10eabf5391d6
- https://medium.com/hulu-tech-blog/open-sourcing-hulus-data-binding-library-for-low-powered-living-room-devices-introducing-4e44a7eb5f1d
- https://web.dev/case-studies/hotstar-inp

YouTube / Cobalt
- https://cobalt.googlesource.com/cobalt/+/19.lts.stable/src/cobalt/site/docs/overview.md
- https://cobalt.googlesource.com/cobalt/+/refs/heads/24.lts.stable/cobalt/doc/performance_tuning.md
- https://www.collabora.com/news-and-blog/news-and-events/re-engineering-youtube-for-the-living-room-bringing-%E2%80%9Cchrobalt%E2%80%9D-to-rdk.html

Spotify, Plex, Kodi, Jellyfin, Stremio, SmartTube
- https://engineering.atspotify.com/2019/3/building-spotifys-new-web-player
- https://www.lowpass.cc/p/plex-apple-tv-app-relaunch-tvos-react-native
- https://kodi.wiki/view/HOW-TO:Modify_dirty_regions , https://kodi.wiki/view/TexturePacker , https://kodi.wiki/view/Artwork/Cache
- https://github.com/jellyfin/jellyfin-androidtv/releases , /pull/5343 , /pull/5789 , /pull/5884
- https://github.com/lucas-romanenko/jellyfin-tentacle-androidtv/issues/56
- https://github.com/Stremio/stremio-core , https://github.com/Stremio/stremio-core-kotlin
- https://github.com/yuliskov/SmartTube

Apple
- https://developer.apple.com/videos/play/tech-talks/10855/
- https://nonstrict.eu/wwdcindex/wwdc2014/419/
- https://developer.apple.com/documentation/uikit/uicollectionviewdatasourceprefetching
- https://developer.apple.com/documentation/tvuikit , https://developer.apple.com/documentation/tvmlkit
- https://developer.apple.com/design/human-interface-guidelines/images

Android
- https://developer.android.com/training/tv/playback/memory
- https://developer.android.com/training/tv/playback/leanback/migrate-to-compose
- https://developer.android.com/reference/androidx/leanback/widget/BaseGridView
- https://github.com/androidx/androidx/tree/androidx-main/leanback/leanback-grid/src/main/java/androidx/leanback/widget
- https://medium.com/google-developers/recyclerview-prefetch-c2f269075710
- https://developer.android.com/develop/ui/views/graphics/hardware-accel
- https://developer.android.com/develop/ui/compose/performance/bestpractices
- https://developer.android.com/docs/quality-guidelines/tv-app-quality
- https://reactnative.dev/docs/view (renderToHardwareTextureAndroid: "render itself (and all of its children) into a single hardware texture on the GPU ... should be set back to false at the end of the interaction/animation")

Lightning / Roku
- https://github.com/rdkcentral/Lightning/tree/master/docs (RenderEngine/index.md, RuntimeConfig/index.md, RenderEngine/Elements/Rendering.md)
- https://github.com/lightning-js/renderer , https://lightningjs.io/blogs/lng3FontRendering.html
- https://developer.roku.com/docs/developer-program/core-concepts/threads.md
- https://developer.roku.com/docs/developer-program/performance-guide/optimization-techniques.md
- https://developer.roku.com/docs/references/scenegraph/list-and-grid-nodes/rowlist.md

Hardware
- https://everymac.com/systems/apple/apple-tv/specs/apple-tv-4k-3rd-gen-a15-2022-a2737-wifi-only-specs.html
- https://macrumors.com/2022/11/14/new-apple-tv-5-core-cpu
- https://www.laptopmag.com/news/iphone-13s-a15-bionic-shows-off-upgraded-benchmarks-pixel-6-pro-falls-behind
- https://browser.geekbench.com/v5/cpu/9137852
- https://www.notebookcheck.net/Apple-A15-GPU-5-Core-GPU-Benchmarks-and-Specs.582222.0.html
- https://hwpure.com/submission/1170-mali-g31-mp2-3dmark-wild-life
- https://applesilicongames.com/device/apple-tv-4k-3rd-generation
- https://androidpctv.com/amlogic-s905y4-comparative/
- https://www.cnx-software.com/2021/11/11/amlogic-t972-multimedia-networking-sbc-supports-4k-v-by-one-displays/

Sources I could not open directly and used only through search-result summaries: the Collabora "Chrobalt" post, the notebookcheck A15 GPU page, the hwpure Mali-G31 pages, the laptopmag/everymac/macrumors/applesilicongames/cnx-software pages, the Netflix help page body, WWDC 2014 session 419, the Roku Poster page and the Lightning 3 font blog. Figures from those should be re-checked before being quoted elsewhere.

# Research 1 — what React Native itself (Fabric, Hermes, react-native-tvos) still offers or costs us (2026-10-10)

Question: "what else can we do to make it even smoother — what can we rewrite that would bring results, even
if it means going really deep?" This file answers it from one angle only: the React Native stack.
Nothing was changed, built or run on the TV for this; it is reading (our code, the React Native source in
`tv-native/node_modules`, public docs). Where a statement is my inference and not documented, it says so.

Stack as found: `react-native-tvos@0.86.0-2`, React 19.2.3, new architecture + bridgeless, Hermes V1
(`hermes-compiler 250829098.0.14`; the release bundle is Hermes bytecode — magic `c6 1f bc 03`, 2.6 MB),
Fresco 3.6.0, default Metro config (`inlineRequires: true` is already the default of
`@react-native/metro-config`), default Babel preset, release level STABLE (no feature-flag overrides anywhere
in our app), `minifyEnabled false`, both ABIs shipped.

## The measured facts this is judged against

- UI thread per frame 1–6 ms. Not a bottleneck.
- RenderThread work 11.7–13.1 ms per frame, down to 6.7–7.8 ms with `cardlayer + cull + shadowcache`.
- Holding along a row: frames arrive every 16.8 ms but run two deep in the buffer queue (~5–9 ms waiting in
  `dequeueBuffer`). That is queueing, not work.
- Occasional 60–150 ms frames coincide with React mounting ~3 cards in / 3 out (~40 host views) every third
  key press.

Two consequences decide almost every verdict below:

1. **Steady-state frame time is not React Native's any more.** JS is off the frame path (native drivers, native
   twins, `startTransition` for mounts). Anything that makes JS faster (compiler, engine, GC, bundle) cannot move
   the 21 ms hold frame or the RenderThread number. It can only shorten key-to-reaction latency and the time a
   mount takes to get ready.
2. **The one frame-time problem that IS React Native's is the mount spike.** 3 cards = 60–150 ms means roughly
   20–50 ms per card, i.e. ~1.5–4 ms per host view. That is far above what creating an Android view costs, so
   the cost is in what each new view drags in on its first frame (text layout, an image request, an SVG bitmap,
   a first display list, a new hardware layer, shadows) — inference; nobody has split it yet (see T1 below).

---

## 1. Fabric mount cost

### 1.1 View flattening / `collapsable`

- What: Fabric drops host views for nodes that only affect layout; it happens inside the C++ differ and is on
  by default on Android. `collapsable={false}` opts a node out.
  Docs: https://reactnative.dev/architecture/view-flattening ·
  https://swmansion.com/blog/react-natives-new-architecture-the-tricky-parts-1-2-bb0c16950f2d
- The exact rule, from our source (`node_modules/react-native/ReactCommon/react/renderer/components/view/ViewShadowNode.cpp:50-75`):
  a `<View>` becomes a real host view if it has, among others, `pointerEvents` `none`/`box-only`, a `nativeID`,
  opacity ≠ 1, a transform, `overflow: hidden`, any event handler (`onLayout` counts), a background colour, a
  border, a `boxShadow`, `removeClippedSubviews`, or `collapsable={false}`.
- Applies to us: yes, in one specific and cheap way. **`pointerEvents="none"` forces a host view, and a TV app
  has no pointer.** It appears 13 times in `src/components/Card.tsx` (e.g. the label wrappers at
  `Card.tsx:701` and `:713`, the fallback wrapper at `:690`), 6 in `Focusable.tsx`, 6 in `Home.tsx`, 6 in
  `NavRail.tsx`, 2 in `Row.tsx`. Where the wrapper has no colour/border/shadow of its own (the label and
  frame-label wrappers, the fallback wrapper), removing the prop lets Fabric flatten it: the `Text` becomes a
  direct child of the Focusable. The row's slot wrapper (`Row.tsx:281-284`) is already flattened (position
  only) — `rowMath.ts` even notes "a flattened slot hands the row the card itself".
- Gain for us: **small**. Perhaps 1–2 of ~13 host views per card: a little off every mount, and a few of the
  ~350 nodes `prepareTree` walks (the 5 ms floor in RENDER.md). Pixels do not change (a flattened view draws
  nothing by definition).
- Effort/risk: an hour; risk is only where a wrapper is addressed by something (`gone('x_text')` styles, a
  `nativeID`, a hardware-layer prop — those must stay views). Pixel-diff covers it.

### 1.2 View preallocation

- What: while React renders on the JS thread, Fabric asks the UI thread to create the host views ahead of the
  commit, inside a budget of half a frame.
- Our source: on (`disableViewPreallocationAndroid = false`, `ReactNativeFeatureFlagsDefaults.kt:44`);
  executed in `FabricUIManager.java:1613` (`drainPreallocateViewsQueue`) and time-boxed in
  `MountItemDispatcher.kt:324` (`deadline = frameTime + 16.6 ms / 2`).
- Gain for us: **none to take** — already on. It matters for the diagnosis: plain view construction is already
  spread over earlier frames, so the 60–150 ms spike is mostly NOT `new ReactViewGroup()`. It is the commit
  (insert, layout, state: text and image) plus the first measure/draw of the new subtree (inference).
  Note our own Fabric components (`AuroraCard`, `AuroraFocusable`) are preallocated too, like any other.

### 1.3 View recycling (native pooling of host views)

- What: instead of destroying an unmounted host view, keep it in a pool per component type and hand it to the
  next mount. iOS has it on; **on Android it is behind a flag and off**.
  Source: `ReactNativeFeatureFlagsDefaults.kt:120` `enableViewRecycling(): Boolean = false` (the per-type
  switches `enableViewRecyclingForView/Text/Image` at `:122-128` are `true` but only take effect under the
  master flag — `ViewManager.java:67-71`, `ReactViewManager.kt:74-80`). Not turned on by the CANARY or
  EXPERIMENTAL release levels either (`ReactNativeFeatureFlagsOverrides_RNOSS_*_Android.kt`).
  Doc: https://swmansion.com/blog/react-natives-new-architecture-the-tricky-parts-1-2-bb0c16950f2d ("behind a
  feature flag on Android"; custom view managers must call `setupViewRecycling()` and reset state in
  `prepareToRecycleView`). A real-world recycling bug write-up:
  https://dev.to/pragathijayaram/the-bug-that-survived-being-recycled-automaticallyadjustkeyboardinsets-and-fabric-view-recycling-5e1e
- How we would set it: the app never overrides flags (`MainApplication.kt:100` just calls `loadReactNative`).
  It needs `ReactNativeFeatureFlags.override(object : ReactNativeNewArchitectureFeatureFlagsDefaults() { override fun enableViewRecycling() = true })`
  instead of the stock entry point (the stock one calls `override` itself, and it may be called once).
  Doc on levels: https://reactnative.dev/docs/release-levels
- Gain for us: **small, possibly none** — it only saves object construction, which 1.2 already moved off the
  commit frame, and RN drops the whole pool "with even slight memory pressure" (`ViewManager.java:473`). Our
  expensive parts (text layout, image request, layer, first draw) happen again on a recycled view.
- Effort/risk: an afternoon to try behind an `exp` switch; **risk medium-high**: off by default in open source
  in 0.86 means little outside testing; react-native-tvos adds focus state to `ReactViewGroup` (focus guide
  flags, destinations, `hasTVPreferredFocus`) and whether `recycleView()` resets all of it is unverified.
  Worth one measured experiment, not a plan.

### 1.4 Recycling at the React level (keep the component, change its item) — the real one

- What: this is what FlashList, RecyclerListView and react-tv-space-navigation do. A cell that leaves the
  window is not unmounted; its React component is re-used for the item entering, so React commits a handful of
  prop UPDATES (uri, strings) instead of ~13 deletes + ~13 creates per card.
  Evidence: BAM/Theodo measured their TV list (moves off-screen components to the other end and re-renders the
  data) against FlatList on TV: "reduces average CPU usage by over 30%", JS thread peaks 60 % instead of 90 %:
  https://github.com/Theodo-UK/rntv-blog/blob/main/data/blog/improve-tv-performance-with-virtualized-lists.mdx
  (their numbers are JS-thread CPU, not frame times).
- Applies to us: directly. `Row.tsx:283` keys every slot by the ITEM (`key={item.id || …}`), so when the
  anchor moves by `WINDOW_SLACK = 3` (`Row.tsx:84`, `rowMath.ts`), three cards unmount and three mount. Keying
  the slot by `index % windowSize` instead keeps nine card instances alive per row for ever; a window shift
  becomes three cards receiving a new `item` and a new `left`.
- What a recycled card saves, per card: Yoga node + shadow node creation, ~13 view creates/deletes, the
  Focusable's native ring/spring objects, the `cardlayer` hardware layer (kept, re-rendered once), the text
  views (a `setText` instead of a new `ReactTextView`), the SVG icon view. What it does not save: the image
  request and the first draw of the new bitmap; one text layout per changed string.
- Gain for us: **medium to large on the spike** (my estimate: the 60–150 ms frames become 20–50 ms — not
  measured; it depends on T1's split), nothing on steady-state frames.
- Effort: 2–4 days. Risk: medium, and it is all state hygiene — everything in `NativeCard` that is per-ITEM
  but stored per-INSTANCE must be reset when `item` changes: `tileUri`/`parked` (`Card.tsx:617-618`), the
  native card's blur-up/retry ladder (`AuroraCardView`), the Focusable's lit state (a recycled card is never
  the focused one: the window only drops cards ≥ 3 away, so this holds by construction). FlashList's docs list
  the same pitfall as its main one: https://www.mintlify.com/shopify/flash-list/fundamentals/performant-components
  A one-frame flash of the old poster is the classic visible bug; the native card must clear the image
  synchronously when its `uri` changes.

### 1.5 Smaller, later, idle mounts (scheduling instead of recycling)

- What: React commits a transition atomically, so three cards land in ONE UI-thread mount. Alternatives that
  need no new machinery: (a) move the window one card per press instead of three per third press (same total
  work, a third of the peak, but on every press); (b) shift the window only once the key has been up for
  ~150 ms and keep more cards ahead while held; (c) mount entering cards one per frame.
- Applies to us: `Row.tsx:80-84` and `:253`. The file's own history says why the window is small: 9/5 → 5/3
  cut GPU memory 110 → 87 MB.
- Gain: **small to medium** on the spike, and it trades against memory or against how soon a fast hold runs
  out of mounted cards. Inferior to 1.4, which removes the work instead of moving it. Useful as a stopgap.

### 1.6 The full native row (P3 of `docs/native-rewrite/00-plan.md`)

- What: the row owns its cards natively (a pool of card views bound from an `items` array, like a
  RecyclerView's `onBind`), so sliding along a shelf never commits a React tree at all.
- Applies to us: it is the step `Row.tsx:236-242` describes as not yet done, "needs the native card to carry its
  texts first".
- Gain: **large on the spike** (bind is a few setters + one Fresco request: I would expect < 4 ms per card,
  inference from what a RecyclerView bind costs), **none** on steady-state frames.
- Effort: 1–2 weeks including native text (section 4) and pixel parity; risk medium (focus order, the
  retry ladder and peek/remove actions all move to Kotlin). Do 1.4 first: it captures most of the gain for a
  fraction of the cost and tells us what is left.

### 1.7 Background executor / off-thread layout

- What: an old Fabric experiment that ran Yoga layout on a background thread.
- Status: not in the 0.86 flag list at all (I read all 92 flags in `ReactNativeFeatureFlagsDefaults.kt`); in
  bridgeless, render + layout + diff already run on the JS thread and only the mount runs on the UI thread
  (https://reactnative.dev/architecture/threading-model).
- Gain: **none**. Our UI thread is 1–6 ms.

### 1.8 Synchronous state updates / C++ state

- What: a native view can update its own Fabric state on the UI thread and re-layout without JS ("C++ State
  update: … skips rendering phase", threading-model doc above).
- Applies: our native twins already move by RenderNode properties and never go through state. **None.**

### 1.9 `useNativeDriver` vs Reanimated worklets vs our native drivers; the new shared animation backend

- What: Animated with the native driver runs the curve on the UI thread; Reanimated runs worklets on a second
  JS runtime on the UI thread; RN 0.85 added an experimental "Shared Animation Backend" (with Software Mansion)
  that also lets the native driver animate layout props:
  https://reactnative.dev/blog/2026/04/07/react-native-0.85 (flags `useSharedAnimatedBackend`,
  `cxxNativeAnimatedEnabled`, both `false` at STABLE, `true` only at EXPERIMENTAL).
- Applies: the hot movements (ring, card scale, row slide, hero/column, rail) are our own Kotlin springs
  started inside the focus change — strictly earlier and cheaper than either alternative. The remaining
  `Animated` uses (`Home.tsx:525-733`, `motion.ts`) are native-driven fades off the hot path.
- Gain: **none**. Reanimated would ADD a runtime and a per-frame worklet call on the thread we are protecting.

### 1.10 The key-event pipeline (TVEventHandler) and a synchronous JSI path

- What happens today: `MainActivity.dispatchKeyEvent` → Android's focus engine moves focus synchronously on
  the UI thread (our native views start their animation right there) → separately
  `ReactAndroidHWInputDeviceHelper.kt:25-50` emits the device event `onHWKeyEvent` to JS, asynchronously, where
  `TVEventHandler.js:47` fans it out to every `useTVEventHandler` listener (`src/focus.ts:336`).
- Is there a synchronous path? Not on Android in 0.86 that I can find: device events and view events are
  queued to the JS thread. The threading doc describes "discrete event interruption … executes synchronously on
  the UI thread" as a capability of the renderer; nothing in `ReactAndroid` exposes it for key events
  (inference from reading the source, not a documented statement). 0.84 added per-view `onKeyDown/onKeyUp`
  (flag `enableKeyEvents`, default `false`; https://reactnative.dev/blog/2026/02/11/react-native-0.84) — still
  asynchronous.
- Gain: **none on frames**; nothing visible waits for JS on a key press any more (REPORT.md: native reacts
  20–60 ms sooner). The only thing still behind the JS queue is what JS decides (rail open, hero spotlight,
  window shift), which is deliberately deferred.

### 1.11 Other mounting flags I checked (all `false` at STABLE in 0.86)

`useOptimizedViewRegistryOnAndroid` (`SurfaceMountingManager.kt:96`), `useLISAlgorithmInDifferentiator`,
`enableDifferentiatorMutationVectorPreallocation`, `enableAccumulatedUpdatesInRawPropsAndroid`,
`enablePropsUpdateReconciliationAndroid`, `enableViewCulling` (scroll views only: `ReactScrollView.java:1661`,
`CullingContext.cpp:23` — we have no scroll view on Home), `enableImagePrefetchingAndroid`
(`ImageShadowNode.cpp:34`: starts the Fresco fetch when the shadow node is created instead of at mount; only
for RN `<Image>`, our card art is `AuroraCard`). None is documented publicly beyond its name; each shaves the
differ or the registry, i.e. the JS-thread or UI-thread side of a commit, which are not where our time goes.
**Gain: none to small; risk: unknown.** Not worth a round on their own; if 1.3 is ever tried, try
`useOptimizedViewRegistryOnAndroid` in the same switch.

---

## 2. Lists

### 2.1 FlashList v2 / LegendList / RecyclerListView on TV

- What: FlashList v2 (new-architecture only, JS-only, uses synchronous layout reads) and LegendList (optional
  `recycleItems`) both recycle at the React level, inside a ScrollView.
  https://docs.expo.dev/versions/latest/sdk/flash-list/ · https://legendapp.com/open-source/list/v3/overview/
  Callstack's TV guidance: "Use FlatList/VirtualizedList, FlashList, or RecyclerListView instead of mounting
  every poster" and "Moving focus across one row should not re-render unrelated rows":
  https://github.com/callstackincubator/agent-skills/tree/main/skills/react-native-tv-best-practices (references/perf-lists.md)
- TV focus + recycling, what is known: I found no authoritative FlashList-v2-on-TV issue to cite (searched; the
  tracker is at https://github.com/shopify/flash-list/issues). The general failure modes are documented by the
  projects themselves: recycled cells keep instance state unless reset (FlashList docs above), and in a
  ScrollView-based list the native focus engine can only reach what is mounted, so fast holds outrun the list.
  react-native-tvos' own answer is `additionalRenderRegions` on VirtualizedList (keep named ranges mounted),
  per the Callstack reference above.
- Applies to us: **Home rows — no.** A scroll-view list brings back exactly what `Row.tsx:14-28` documents
  leaving: Android's animated scroll restarts its `ValueAnimator` on every key repeat, and our slide is a
  retargeted spring on a RenderNode. The useful idea in these libraries is the recycling, and 1.4 takes it
  without the ScrollView. **Browse grid — maybe.** `Browse.tsx:698-719` is a FlatList (`numColumns`,
  `windowSize={3}`, `removeClippedSubviews`). The Movies grid is already our best scenario (p50 16 ms, RT 5.5 ms
  with the fixes) but its p90/p99 (27–36 / 93–125 ms) are mount spikes of whole rows of cards.
- Gain: Home **none**; Browse **small to medium** on p90/p99 if the grid recycled. Effort for Browse with
  FlashList v2: 2–3 days plus a focus round (paging, `hasTVPreferredFocus` claims at `Browse.tsx:604`, the
  filter panel edge); risk medium. A hand-rolled slot-recycled grid like 1.4 has the same gain with no new
  dependency and no ScrollView.

### 2.2 `removeClippedSubviews` on Android/Fabric

- What: detaches children outside the parent's clip rect from the Android view tree (they stay mounted in
  React). On Fabric it still works (`ReactViewGroup.kt:391-450`), and it makes the node unflattenable.
- Applies: on for the Browse FlatList (`Browse.tsx:716`, with the measurement that justified it). Home's rows
  cannot use it (no clipping parent — `Row.tsx` styles say why), and `cull` already does the drawing half of it
  better (views stay focusable). Known TV hazard, from the source: a detached view cannot be found by
  `FocusFinder`; 0.86 has a flag `enableCustomFocusSearchOnClippedElementsAndroid` (default false) for that.
- Gain: **none** beyond what we have.

### 2.3 What large RN TV apps report

- BAM/Theodo (react-tv-space-navigation): custom recycled list, −30 % CPU vs FlatList (link in 1.4); their
  lists are "an animated view that … translates horizontally or vertically to scroll" — the same shape as our
  row (https://github.com/bamlab/react-tv-space-navigation/blob/main/docs/api.md). Their focus is JS-driven,
  which we must NOT copy: ours is native and reacts inside the key event.
- Callstack (react-native-tvos maintainers' employer; skill linked above): memoized cards, transform-only
  focus animation, ONE focus frame instead of per-card overlays, toggle opacity instead of unmounting, local
  state only, native driver, 100–150 ms focus animations, "profile on the weakest supported TV device". We do
  all of these except "one focus frame" (ours is a native ring per Focusable, drawn only when lit — equivalent).
- Amazon Prime Video is the instructive outlier: for living-room devices they moved UI rendering OUT of
  React/JavaScript into a Rust + WebAssembly engine with its own scene graph, and present performance on weak
  boxes as the reason: https://www.infoq.com/presentations/prime-video-rust and
  https://qconsf.com/presentation/nov2024/rebuilding-prime-video-ui-rust-and-webassembly — i.e. the big players'
  "going really deep" was taking the hot path away from React, which is the direction this lab already took.
  (Their previous stack was React in a JS engine of their own, not React Native; the lesson transfers, the
  numbers would not.)
- I could not find public, numeric engineering posts from Peacock or DAZN on RN TV rendering; not cited.

---

## 3. Hermes, React 19, the compiler

### 3.1 Bytecode, `inlineRequires`, lazy bundles

- Already in place: Hermes bytecode in the APK; `inlineRequires: true` by default
  (`node_modules/@react-native/metro-config/dist/index.js:88`). Lazy screens would cut start-up, not frames.
- Gain: **none** for smoothness. (Start-up was not part of the measured facts; if it matters, measure TTI first.)

### 3.2 Hermes V1 / Static Hermes

- Hermes V1 is the default engine since 0.84 and is what we run (`hermesV1Enabled` convention `true`,
  `PrivateReactExtension.kt:62`; official numbers on a real app: total TTI −7.6 % on low-end Android,
  https://reactnative.dev/blog/2025/10/08/react-native-0.82 ; default:
  https://reactnative.dev/blog/2026/02/11/react-native-0.84). "Static Hermes" as typed ahead-of-time native
  compilation is not a shipping option in 0.86 (the name was folded into V1:
  https://www.callstack.com/podcasts/from-static-hermes-to-hermes-v1-the-road-to-default).
- Gain: **none to take** — we have it.

### 3.3 GC pauses, 32-bit vs 64-bit

- Documented: Hades collects the old generation concurrently on a background thread only on 64-bit; "On 32-bit
  platforms we don't use any other threads, and instead run Hades in 'incremental mode' … we use a portion of
  each YG GC to do some OG GC work" (https://github.com/facebook/hermes/blob/main/doc/Hades.md). Published
  pause times: 48 ms at p99.9 on 64-bit, about 88 ms at p99.9 on 32-bit
  (https://reactnative.dev/blog/2021/10/26/toward-hermes-being-the-default). Young-generation collections stop
  the JS thread on both.
- TV context: "Nearly all Fire TV, Android TV, and Google TV streaming devices contain 64-bit hardware, but
  they run a 32-bit version of Android" (https://www.aftvnews.com/?p=43549); Google requires 64-bit builds on
  TV from August 2026 while still serving 32-bit devices
  (https://android-developers.googleblog.com/2025/08/64-bit-app-compatibility-for-google-tv-android-tv.html).
  **Which one the Mi TV and the Streamer run is not in our docs** — `adb shell getprop ro.product.cpu.abilist`
  answers it; our APK ships both (`gradle.properties:31`), so the box picks.
- What it means for us: a GC pause stops the JS thread only. With animation and focus native, it cannot drop a
  frame; it can delay a window shift, the hero spotlight or a rail decision by up to ~50–90 ms in the worst
  0.1 %. RN's Hermes config is fixed in C++ (`ReactCommon/react/runtime/hermes/HermesInstance.cpp:137-150`:
  3 GB max heap, allocate in old gen before TTI); bridgeless exposes only `allocInOldGenBeforeTTI`.
- Gain: **none on frames; small on worst-case reaction latency**, and only by allocating less in JS per key
  press (we already allocate little there). Not worth a project.

### 3.4 React Compiler

- Usable: yes. v1.0 is stable and "works on both React and React Native"
  (https://react.dev/blog/2025/10/07/react-compiler-1); in bare RN it is a Babel plugin that must run first
  (https://react.dev/learn/react-compiler/installation). Our `babel.config.js` has only the preset — not on.
- Would it cut our re-renders? On the hot path, **no**: Card/Row/Focusable are hand-memoized, the window moves
  in blocks so "most keypresses still cost zero React renders" (`Row.tsx:31-34`), and `motion.ts:60-66` records
  the one identity leak that mattered and its fix. Where it could help is the screens nobody hand-tuned
  (`Detail.tsx` 3,024 lines, `Sources.tsx`, `Overlays.tsx`) — screen-open time, not frames.
- Gain: **none on Home/Browse frames; small on screen opens.** Effort: half a day to enable + a full pixel-diff
  and focus regression pass; risk low-medium (code that mutates during render or reads refs in render is
  skipped or, rarely, miscompiled; the lint rule shows which).

### 3.5 React 19: transitions, `<Activity>`

- Transitions: in use (`motion.ts:66` `defer = startTransition`, called for every mount-changing state).
  One limit worth knowing: a transition makes the RENDER interruptible on the JS thread; the COMMIT to native
  is still one atomic mount on the UI thread — which is why three cards arrive in one long frame (1.4/1.5).
- `<Activity>` (React 19.2, in RN since 0.83: https://reactnative.dev/blog/2025/12/10/react-native-0.83):
  `mode="hidden"` keeps state, unmounts effects and defers updates. For us the stack navigator
  (`@react-navigation/native-stack` on react-native-screens) already keeps Home mounted under Detail, so going
  back is not a remount. A possible use: pre-render the NEXT shelf's cards hidden so that entering it is not a
  mount. On Fabric a hidden Activity's host views still exist (hidden with display none — inference; the flag
  `useTraitHiddenOnAndroid` in our tree suggests the mechanism is still being built), so it costs memory, which
  the 5/3 window was tuned to save.
- Gain: **none to small**; not a lever for the measured problems.

---

## 4. Text

### 4.1 What RN Text costs on Android today

- Mount: Fabric measures every paragraph on the JS thread by building an Android `Layout` (cached,
  `TextLayoutManager`), then `ReactTextView` (an AppCompat `TextView` subclass) receives the Spannable and
  builds its own layout again on the UI thread at first measure/draw. So each `<Text>` is laid out twice and is
  the heaviest stock view to create. A card has 1–3 (`Card.tsx:702-724`), a row heading 1 (`Row.tsx:261`).
- Draw: RENDER.md measured text at 5.5 % (replay) + 3.1 % (flush) of RenderThread CPU, `x_text` −0.8/−0.2 ms,
  text shadows −0.3 ms. With `cardlayer`, resting cards' text is inside the layer and costs nothing per frame.

### 4.2 `enablePreparedTextLayout` (PreparedLayout)

- What: with the flag on, Fabric's measurement produces a `PreparedLayout` (the actual `android.text.Layout`)
  that is handed to a slim `PreparedLayoutTextView` — a plain `ViewGroup` that "directly draws an existing
  layout, previously generated for measurement by Fabric, to ensure consistency of measurements, and avoid
  duplicate work" (`ReactAndroid/src/main/java/com/facebook/react/views/text/PreparedLayoutTextView.kt`
  header; wiring in `ParagraphShadowNode.cpp:242-326`, `MainReactPackage.kt:155`, cache size flag
  `preparedTextCacheSize = 200`).
- Status: `false` at every release level in 0.86 (`ReactNativeFeatureFlagsDefaults.kt:110`; not in the Canary
  or Experimental overrides). No public doc or release note describes it — everything here is from the source.
- Applies: to every `<Text>` in the app, with no JS change. It removes the second layout and the TextView
  machinery from each text mount.
- Gain: **small to medium on the mount spike** (if text is a large slice of the ~20–50 ms per card — T1 will
  say), **none** on steady frames. Risk: medium-high — unreleased; glyph positions should be identical since
  it draws the very layout that was measured, but ellipsis, `textShadow*`, `letterSpacing`, `lineHeight` and
  font-weight fallbacks must pass the pixel diff; selection/links are a separate manager. It is a one-line
  switch behind `exp`, so it is cheap to MEASURE even if we never ship it.

### 4.3 Native-drawn text in the card

- What: `AuroraCardView` draws the 1–3 lines itself (`StaticLayout`/`BoringLayout` built once per item on a
  background thread or with `PrecomputedText`, drawn in `onDraw`): no text host views, no Yoga nodes for them.
- Applies: it is the stated prerequisite of the full native row (1.6). Alone, it removes 2–5 host views per
  card (the Texts and their wrappers).
- Gain: alone **small** (a slice of the mount spike); as the enabler of 1.6 **large**. Effort 3–5 days with
  pixel parity (RN's text attributes → `TextPaint` exactly: weight 800, letter spacing, line height, shadow,
  ellipsis); risk medium — text is where 1/255 differences come from.

---

## 5. Images

### 5.1 What we run

Fresco 3.6.0 through RN's default config plus our trim registry (`MainApplication.kt:56-72`):
`DownsampleMode.AUTO`, OkHttp fetcher, ARGB_8888, default cache sizes; the native card shares RN's request
shape and caches (`ui/image/AuroraImages.kt`); the server already sends width-matched WebP (`?w=`), and
`progressiveRenderingEnabled` is `false` (`AuroraImages.kt:69`).
RENDER.md already settled the steady state: no per-frame texture uploads (0.05 %), art layer 0.8–1.3 ms.

### 5.2 Options

| option | what | verdict for us |
|---|---|---|
| `Bitmap.prepareToDraw()` after decode (one call in `AuroraCardView` when the image arrives; Fresco also has a pipeline experiment for it) | "Starting in Android N, this call initiates an asynchronous upload to the GPU on RenderThread" so the first frame that draws the bitmap does not pay the upload (https://developer.android.com/reference/android/graphics/Bitmap#prepareToDraw()) | **Small, cheap, worth trying**: 3–9 new pictures per window shift land in the same frame as the mount. Whether upload is a visible part of the spike is unmeasured. Risk low. |
| Hardware bitmaps (`Bitmap.Config.HARDWARE`) | pixels live only in GPU memory; no upload at draw, half the RAM | **Small** (RAM, not frames). Fresco does not offer it as a simple switch (Glide/Coil do); breaks anything that reads pixels (our blur post-processor, software-canvas captures). Not worth it alone. |
| RGB_565 | half the memory, banding on gradients/dark art | **No**: dark posters with shades band visibly; GPU caches are 51–88 MB, not our limit. |
| Downsampling / resize | decode at view size | Already effectively done by the server's `?w=` variants; `resizeMethod="resize"` only on unsized paths (`Card.tsx:390`). **None left.** |
| `progressiveRenderingEnabled` | progressive JPEG passes | **None/negative**: more decodes and redraws; our art is WebP. |
| Prefetch | warm the disk/bitmap cache for cards about to enter | Partly there (`src/prefetch.ts`); `enableImagePrefetchingAndroid` only covers RN `<Image>`. Makes art appear sooner; **none** on frame time. Callstack warns aggressive poster prefetch triggers TV memory kills (perf-lists.md). |
| Bitmap cache size / memory caps | `MemoryCacheParams` supplier (https://frescolib.org/docs/configure-image-pipeline.html) | Our memory already went DOWN with the fixes; trim handling exists. **None.** |
| Swap Fresco for Coil/Glide | different pipeline | **None** for frames: once decoded, every library hands HWUI the same bitmap. It would fork the cache from RN's own `<Image>` (hero art, shades) and cost a rewrite of the card's retry ladder. |

### 5.3 The icon bitmaps (react-native-svg)

Not Fresco, but the same subject: every `<Svg>` (`Icon.tsx:51`) renders into a mutable bitmap that HWUI pins
each frame (RENDER.md: 4 % of the thread, `x_svg` −0.7/−0.8 ms) and each mounted icon is one more
view-with-bitmap to create (the kind pill, `Card.tsx:742-757`). Pre-rasterised PNGs (immutable, shared, cached
by Fresco/resources) or drawing the two glyphs inside `AuroraCardView` removes both the per-frame pin and a
mount cost. **Small** once `cardlayer` hides resting cards (only lit/moving ones still pay), a bit more on the
mount spike. Effort: a day for the card's two icons.

---

## 6. Release build options

| option | what it speeds up | applies / state | gain for us | effort / risk |
|---|---|---|---|---|
| **R8 (minify + optimize)** | Java/Kotlin only: RN's mounting layer, Fresco, OkHttp, our Kotlin views. Android: "Faster startup time, reduced memory usage, improved rendering and runtime performance" (https://developer.android.com/topic/performance/app-optimization/enable-app-optimization); full mode is the default since AGP 8. | **Off**: `android/app/build.gradle:137` `enableProguardInReleaseBuilds = false`, and `:219` uses `proguard-android.txt`, which contains `-dontoptimize` — the doc says to use `proguard-android-optimize.txt`. The APK carries ~27 MB of dex. | **Small** on frames (UI thread is already 1–6 ms; the mount's Java part gets some inlining), small on start-up and memory. | Half a day + keep rules (NewPipeExtractor/Rhino are already listed in `proguard-rules.pro`; our ASM class rewrite in `build.gradle` must still find `ReactViewManager`; codegen'd Fabric classes are kept by RN's consumer rules). Risk medium: a missing keep rule fails at runtime, only on the path that hits it. |
| **Baseline Profile** | AOT-compiles listed DEX methods at install: "improve code execution speed by about 30% from the first launch"; DEX methods and classes only (https://developer.android.com/topic/performance/baselineprofiles/overview). Nothing in Hermes bytecode or `.so` files is touched. | The APK has only a 4 KB `assets/dexopt/baseline.prof` from AndroidX libraries; none for RN's or our classes. `profileinstaller` is present. We sideload, so per the same doc the profile is applied at first run by ProfileInstaller and compiled at the next background dexopt. | **Small**: first launches after an update run RN's Java interpreted/JIT'd until ART's own profile catches up (a day or two of use). Cold start after an in-app update and the first minutes of browsing are where it would show. Steady state on a box that has been used for days: **none** (ART has profiled the same code itself). | 1–2 days (a macrobenchmark module driving D-pad journeys on a device). Risk low. |
| `android:largeHeap` | raises the Java heap cap | Not set. Our pressure is native/GPU (PSS 235–345 MB), not Java heap; Fresco bitmaps on API 26+ are native. | **None** (can make GC pauses longer). | — |
| arm64-only vs armeabi-v7a | 64-bit code is faster and gives Hermes its concurrent GC (3.3) | We ship both (`gradle.properties:31`); the box chooses. Dropping v7a would lock out every 32-bit-userspace TV — most of them. | **None to take.** Do not drop v7a. | — |
| Hermes flags | `-O` is the release default; the bundle is already bytecode | default `react {}` block (`build.gradle`) | **None.** | — |
| Dev-only code | `__DEV__` branches are stripped by Metro in release; QA receiver/trace hooks are inert without their flag | `qa.ts`, `exp.ts`, `profileable` in the lab manifest | **None** measurable. Remove `<profileable>` from a product build. | — |

---

## 7. react-native-tvos specifics

- **Per-view accessibility binder call** — already removed by our patch
  (`patches/react-native+0.86.0-2.patch`) and the ASM rewrite in `build.gradle`. Nothing further.
- **`TVFocusGuideView`** — on Android it is a `ReactViewGroup` with extra focus logic
  (`ReactViewGroup.kt:1381-1401` `addFocusables`, `:1505-1524` `focusSearch`, `:1404` `requestChildFocus`).
  Its cost is per KEY PRESS, on the UI thread, inside Android's `FocusFinder` — which collects every focusable
  in the window and sorts candidates; with trap flags it short-circuits. We use one per row (`Row.tsx:265`) and
  in Browse (`Browse.tsx:745`). With ~70–90 focusables on Home that is well under a millisecond per press
  (inference from the 1.1 ms UI-thread median; not separately profiled). **Gain: none.**
  I found no react-native-tvos issue that documents a frame cost for it; not cited.
- **Focus search over mounted-but-culled cards** — `cull` keeps views focusable, by design. Fine.
- **`hasTVPreferredFocus` re-application** — `Focusable.tsx:341-347` documents Fabric re-applying it; handled by
  the `disarmed` state at the price of one extra re-render of the element that carried it. Negligible.
- **`useTVEventHandler` is global** — every mounted handler runs for every key (`focus.ts:12-15`, `:336`). All
  JS, a few handlers; off the frame path. **None.**
- **Key repeat / double events** — handled natively in `MainActivity.kt` and in `focus.ts:acceptTvEvent`.
- **`enableImperativeFocus` / `enableKeyEvents`** (core flags, default false) — alternatives to the tvos
  mechanisms, not faster ones.

---

## First, one day of measurement (T1) — because the top items depend on it

Nobody has yet split the 60–150 ms mount frame. Before building 1.4/1.6/4.x, capture those frames only:
`dumpsys gfxinfo framestats` rows for the spike frames (is the time in the UI thread's
`PerformTraversals`/`Draw`, in `SyncQueued→IssueDraw`, or in the RenderThread?), and a perfetto/atrace capture
with the `view` and `gfx` categories plus RN's own sections (`FabricUIManager::mountViews`,
`IntBufferBatchMountItem::execute`, Fresco's `SystraceRequestListener` which RN installs by default —
`FrescoModule.kt:155`). The lab build is already `profileable`. The answer picks between "text" (→ 4.2/4.3),
"view/Yoga churn" (→ 1.4), "first draw: layers, shadows, SVG, texture upload" (→ render-side fixes, 5.2
`prepareToDraw`, 5.3), and decides how much 1.6 is worth.

## Ranked top 10 for our situation

| # | what | expected gain (on what) | effort | risk |
|---|---|---|---|---|
| 1 | **T1: split the mount spike** with framestats + perfetto on the spike frames | none by itself; decides 2–6 | 1 day | none |
| 2 | **Slot recycling in the row window** (key by slot, not by item; reset per-item state) — 1.4 | medium–large on the 60–150 ms frames; none on steady frames | 2–4 days | medium (stale-state bugs) |
| 3 | **Full native row that binds its own cards** (P3), after native text — 1.6 + 4.3 | large on the spike (no React commit while sliding) | 1–2 weeks | medium |
| 4 | **Try `enablePreparedTextLayout` behind an `exp` switch** — 4.2 | small–medium on the spike; free to measure | half a day to test | medium-high to ship (unreleased flag) |
| 5 | **`Bitmap.prepareToDraw()` when a card's picture arrives** — 5.2 | small on the spike (upload leaves the first frame) | hours | low |
| 6 | **Drop `pointerEvents="none"` where it is the only reason a wrapper is a view** — 1.1 | small: 1–2 host views per card, fewer nodes in `prepareTree` | hours | low |
| 7 | **Card icons without react-native-svg** (PNG or drawn in `AuroraCardView`) — 5.3 | small: mount cost + the 4 % bitmap pinning on lit/moving cards | 1 day | low |
| 8 | **R8 with `proguard-android-optimize.txt`** — 6 | small: Java side of mounts, start-up, memory | half a day + regression | medium |
| 9 | **Baseline Profile for RN + our Kotlin** — 6 | small: first launches after each update only | 1–2 days | low |
| 10 | **Recycle the Browse grid** (FlashList v2, or the same slot scheme as #2) — 2.1 | small–medium on the grid's p90/p99 | 2–3 days | medium (focus) |

Experiments that did not make the list but cost almost nothing to run once, in one `exp` build:
`enableViewRecycling` + `useOptimizedViewRegistryOnAndroid` (1.3, 1.11), and one-card-per-press windowing (1.5).

## Sounds good, will not help us — and why

- **React Compiler / more memoization** — the hot path already renders nothing per key press; JS is not on the
  frame path. (Fine for Detail's open time; not smoothness.)
- **Reanimated worklets or the new shared animation backend** — our springs already start inside the focus
  change on the UI thread; a worklet runtime adds work to that thread.
- **FlashList / LegendList for Home rows** — they are ScrollView-based, which brings back the restarted-scroll
  animator `Row.tsx` was written to escape. Only their recycling idea is worth taking (#2).
- **A faster JS engine, Static Hermes, GC tuning, arm64-only** — a JS pause cannot drop a frame here; it can only
  delay a deferred mount. Dropping 32-bit would lock out most TV boxes.
- **`largeHeap`, RGB_565, a bigger/smaller Fresco cache, swapping Fresco for Coil/Glide** — memory is not what
  limits us (it went down with the fixes), steady-state image cost is ~1 ms, and decoded bitmaps draw the same
  whatever decoded them.
- **`removeClippedSubviews` on Home / `enableViewCulling`** — the first needs a clipping parent the rows cannot
  have; the second is for scroll views; `cull` already does the job natively.
- **Background layout / synchronous JSI key events / C++ state** — they shorten the JS→UI path, and our UI
  thread is 1–6 ms with nothing visible waiting on JS.
- **`<Activity>` to keep screens alive** — the native stack already keeps Home mounted; hidden pre-rendered
  shelves would spend the memory the 5/3 window was tuned to save.
- **Lazy bundles / inline requires / bytecode** — start-up only, and the last two are already on.
- **Anything in React Native for the two-deep buffer queue while holding a key (the ~5–9 ms in
  `dequeueBuffer`)** — that is between HWUI and SurfaceFlinger; React Native has no setting that reaches it.

## Sources

Our tree (read, not modified): `tv-native/src/components/{Row,Card,Focusable}.tsx`, `src/{motion,focus,rowMath,perfTier}.ts`,
`src/screens/{Home,Browse}.tsx`, `android/app/build.gradle`, `android/gradle.properties`,
`android/app/src/main/java/com/auroratv/{MainApplication,MainActivity}.kt`, `ui/image/AuroraImages.kt`,
`patches/`, the built `app-release.apk` (file listing only), `docs/qa/native-bench/{REPORT,RENDER}.md`,
`docs/native-rewrite/01-architecture.md`.

React Native 0.86.0-2 source in `tv-native/node_modules/react-native`:
`ReactAndroid/src/main/java/com/facebook/react/internal/featureflags/*`,
`defaults/DefaultNewArchitectureEntryPoint.kt`, `uimanager/ViewManager.java`,
`views/view/{ReactViewManager,ReactViewGroup}.kt`, `fabric/FabricUIManager.java`,
`fabric/mounting/{MountItemDispatcher,SurfaceMountingManager}.kt`,
`views/text/{PreparedLayout,PreparedLayoutTextView,TextLayoutManager}.kt`, `modules/fresco/FrescoModule.kt`,
`ReactAndroidHWInputDeviceHelper.kt`, `ReactCommon/react/renderer/components/view/ViewShadowNode.cpp`,
`ReactCommon/react/runtime/hermes/HermesInstance.cpp`, `Libraries/Components/TV/TVEventHandler.js`.

Web:
- https://reactnative.dev/architecture/view-flattening
- https://reactnative.dev/architecture/threading-model
- https://reactnative.dev/docs/release-levels
- https://reactnative.dev/blog/2025/10/08/react-native-0.82 · https://reactnative.dev/blog/2025/12/10/react-native-0.83 ·
  https://reactnative.dev/blog/2026/02/11/react-native-0.84 · https://reactnative.dev/blog/2026/04/07/react-native-0.85 ·
  https://reactnative.dev/blog/2026/06/11/react-native-0.86
- https://reactnative.dev/blog/2021/10/26/toward-hermes-being-the-default (Hades pause numbers)
- https://github.com/facebook/hermes/blob/main/doc/Hades.md
- https://swmansion.com/blog/react-natives-new-architecture-the-tricky-parts-1-2-bb0c16950f2d ·
  https://swmansion.com/blog/react-native-new-architecture-key-performance-boosts-4ce68cc3cc9f
- https://react.dev/blog/2025/10/07/react-compiler-1 · https://react.dev/learn/react-compiler/installation
- https://github.com/Theodo-UK/rntv-blog/blob/main/data/blog/improve-tv-performance-with-virtualized-lists.mdx
- https://github.com/bamlab/react-tv-space-navigation/blob/main/docs/api.md
- https://github.com/callstackincubator/agent-skills/tree/main/skills/react-native-tv-best-practices
- https://docs.expo.dev/versions/latest/sdk/flash-list/ · https://www.mintlify.com/shopify/flash-list/fundamentals/performant-components ·
  https://legendapp.com/open-source/list/v3/overview/
- https://www.infoq.com/presentations/prime-video-rust · https://qconsf.com/presentation/nov2024/rebuilding-prime-video-ui-rust-and-webassembly
- https://developer.android.com/topic/performance/baselineprofiles/overview
- https://developer.android.com/topic/performance/app-optimization/enable-app-optimization
- https://developer.android.com/reference/android/graphics/Bitmap#prepareToDraw()
- https://frescolib.org/docs/configure-image-pipeline.html
- https://www.aftvnews.com/?p=43549 · https://android-developers.googleblog.com/2025/08/64-bit-app-compatibility-for-google-tv-android-tv.html

Not found / not verified: a FlashList-v2-specific TV focus issue; any react-native-tvos issue quantifying
`TVFocusGuideView` cost; public numeric RN-TV posts from Peacock or DAZN; any public description of
`enablePreparedTextLayout` (source only); the exact name and signature of Fresco 3.6.0's prepare-to-draw
experiment (the Android API it wraps is documented; calling it ourselves needs no Fresco option); which ABI the
Mi TV runs our process in; the systrace section names in T1 are from memory of RN's source and should be
checked against a first capture.

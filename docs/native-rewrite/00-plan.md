# Native rewrite of the TV rendering layer — the plan

Status: DESIGN ONLY. Nothing here is started. elia decides when; this folder makes
"when" a one-word answer.

Companion files: `01-architecture.md` (the JS↔native contract and the math),
`02-verification.md` (how 1:1 is proven), `03-inventory.md` (every JS-drawn
surface, phase, risk, open questions). The per-component pixel specs are
`10-…` through `15-…` (written by other sessions: home/nav/cards, detail,
player, overlays, focusable/chip/btn/icon, navrail, card/row, home, browse);
this file does not repeat them — a phase's state matrix in `02 §4` is read
from the matching spec.

## 0. What is being rewritten, and why

The app is `tv-native/` — react-native-tvos **0.86.0-2**, React 19.2.3, **new
architecture on** (`android/gradle.properties`: `newArchEnabled=true`,
`hermesEnabled=true`; `MainActivity.kt` passes `fabricEnabled`), Kotlin 2.1.20,
minSdk 24 / compileSdk 36, armeabi-v7a + arm64-v8a, `react-android` linked as
the prebuilt Maven AAR (so Kotlin patches to RN itself are applied by an ASM
rewrite at build time, not by editing node_modules — `app/build.gradle`
`A11yQueryRewrite`). TV build 5.1.29 (versionCode 92) at the time of writing.

The motive is **smoothness on weak Android TV boxes**. An Android 13 user
reports freezes; the Mi TV (Android 14, Amlogic s7d, 2 GB, 1920×1080 @320 dpi =
960×540 dp) is the test device. Measured there, stock build, 1080p:

| scenario | p50 | p90 | janky |
|---|---|---|---|
| D-pad navigation on Home (5.0.3) | 28–29 ms | ~40 ms | — |
| Home shelf scroll, steady state (5.1.13) | 29 ms | 38 ms | 3.1 % |
| Browse grid | 19 ms | — | — |
| rail open (5.1.17, after RailAurora removed) | 16.7 ms | — | 0 % |
| idle | 0 frames drawn | | |
| RSS | 500–560 MB | | |

A 60 Hz panel has a 16.7 ms budget; the app spends ~29 ms per frame while a
direction is held. The JS side has already been squeezed hard (native-driver
animations everywhere, zero React renders per focus move in the common case,
coarse windowing, sized artwork, server-side blur, no per-frame accessibility
binder call, one-press-one-move, A11y ASM rewrite). What is left on the hot path
is structural:

1. **Every focus move still crosses the bridge.** `Focusable.onFocus` runs in
   JS (topFocus event → Pressability → handler), calls `claimRing` (a native
   `Animated.timing` start on the old ring), `noteFocus`, and starts two native
   animations on the new one: ~5 JSI/native calls per press, after a JS-thread
   hop. Hold a direction (Android repeats at ~20 Hz) and the JS thread is the
   bottleneck — the Streamer measurement in `Focusable.tsx`: 112 of 267 frames
   flagged *high input latency* while jank was only 6 %.
2. **Mount churn is on the UI thread.** A poster `Card` is ~12–15 native views
   (Focusable wrapper, ring, highlight, overlay, image, shade, label texts,
   tags, progress). Row's window slides in blocks of 3 cards (`WINDOW_SLACK`),
   so every third press mounts ~40 views and unmounts ~40 through Fabric's
   MountingManager — on the UI thread, in the same frame the spring is moving
   the shelf. `defer()`/`startTransition` moves the React work off the input
   path but the *mount* still lands in one frame.
3. **View count is the fill-rate and memory cost.** 90 Focusables on Home,
   each with a shadowed ring view; on a Mali-G31 overdraw was measured at 4×.

A native Card is 1–2 views with one `onDraw`; a native Row needs no React
commit to slide or to recycle; a native Focusable answers the key in the same
frame Android moved focus, with no bridge hop. That is the perf case. It is
also the only place left where a large win is available — the JS has no more
fat on this path.

## 1. The constraint that shapes everything: exact 1:1

elia's requirement is that the result is an **exact copy of today's app in
look and behaviour**. Not "a native version of the design" — the same pixels,
the same focus paths, the same timings. That decides the approach:

- The JS implementation stays the **reference** and stays in the build until
  the native one is proven, so both can be screenshotted **on the same build,
  same device, same server fixture**, and diffed. A rewrite that deletes the
  reference as it goes cannot be checked.
- Animations reproduce RN's own drivers (`SpringAnimation.kt`,
  `FrameBasedAnimationDriver.kt` — the native-driver code that runs today), not
  an "equivalent" `androidx` spring. Same equations, same frame sampling, same
  rest thresholds. The math is in `01-architecture.md §6`.
- Images come through the **same Fresco pipeline** with the same request
  (URI, headers, `ResizeOptions`, post-processor) so JS and native share cache
  entries and decode the same bitmap.
- Text stays on **the same renderer** for as long as possible: RN `Text`
  children inside the native component (allowed by Fabric `ViewGroupManager`),
  because text is not on the hot path and text rasterisation is the hardest
  thing to make pixel-identical.

## 2. The three options, honestly

### A — native Fabric components for the hot paths, inside the RN screens

Card / Row / Hero art / NavRail / the focus ring become Kotlin views declared
through codegen (`src/specs/*NativeComponent.ts` → `ViewManager`s). Screens
stay TSX; data, session, navigation, overlays, player stay as they are. Each
component ships behind a per-component switch (`AuroraImpl`, §4 of
`01-architecture.md`) so `Card` can be JS or native on the same APK.

- **+** Incremental; each step is independently shippable and revertible by
  flipping the switch.
- **+** The only option that allows the same-build A/B pixel diff.
- **+** Leaves the 20 k lines of screen logic (Detail.tsx is 3 023 lines,
  Player.tsx ~3 500) untouched — they are not the problem.
- **+** Builds on what is already native: `DeviceModule` (JankStats per
  screen), Fresco config, `MainActivity` key dedupe, `A11yServices`.
- **−** A hybrid tree: focus moves between RN views and native views; the
  JS facts in `focus.ts` (who holds focus, edge flags, `focusJustMoved`) must
  be fed by events from native components. Solvable (§5 of `01`), but it is
  the main integration risk.
- **−** Fabric view recycling and prop diffing have their own rules
  (`prepareToRecycleView`, props arrive in arbitrary order) — a learning cost
  on the first component, then amortised.
- **−** Row-level data (a `HeroItem[]` of up to ~40 items) crosses as props on
  every commit. Fine (Home's rows are ~10 × 20 items; the payload is small
  compared with the JSON already fetched), but it must be measured, not
  assumed.

### B — whole screens in native Views (or Compose for TV), RN kept for data/session

Home (and later Browse) becomes a native screen hosted in the RN stack, fed by
a TurboModule that carries the fetched JSON and receives navigation intents
back. RN keeps the API client, session, realtime socket, storage, update,
overlays, player.

- **+** Removes *all* Fabric mounting from the hot screen; one native layout
  pass, native recycling, native focus throughout.
- **+** Natural end state for Home: it is a billboard plus shelves, a classic
  Leanback shape.
- **−** Everything on the screen must be ported at once — hero rotation and
  trailer choreography (`Home.tsx` ~1 100 lines of state), parties strip, the
  update sheet trigger, focus fallback, `warmItem` prefetch hooks, usage
  tracking. Many small behaviours, each a 1:1 obligation.
- **−** A/B on the same build is still possible (two screen implementations
  behind the switch) but the surface is huge; the diff matrix explodes.
- **−** Compose for TV would *not* be 1:1 by construction: its focus system
  (`FocusRequester`, `BringIntoView`) and its text pipeline differ from the
  View system RN uses. If B is taken it must be **Views**, not Compose, or the
  1:1 rule is broken on day one. (Compose is the right choice only for option
  C, where "1:1 to RN" stops being the requirement.)

### C — full native app, JS gone

- **+** One runtime, ~100 MB less RSS (Hermes + JS heap + Fabric), fastest
  cold start, no bridge anywhere.
- **−** Rewrites ~20 000 lines of behaviour that are not the perf problem:
  the player (already ExoPlayer natively via react-native-video; the chrome
  logic, party sync, subtitle timing, jit/ladder paths are all JS), Detail's
  download-state machine, Sources, the kids PIN gate, sign-in handoff, the
  updater, realtime. Each is a 1:1 obligation with no A/B harness possible
  (different app).
- **−** No incremental delivery; the owner gets nothing until everything
  lands, and regressions have no reference build to diff against.
- **−** The sandbox (`tv-native/sandbox`, the app in a browser), the UI
  tests' server fixtures and the shared TS types with the web are all lost.

### Recommendation

**A first, then B for Home only if A's measurements say the remaining cost is
in the screen rather than in the components.** C is not recommended: its
benefit (RSS, cold start) is real but not the complaint, and its cost is the
whole app. The decision point for B is written down in §5.

## 3. Phases

Each phase has a gate. A phase does not start until the previous one's gate is
passed on the Mi TV (elia's rule: real device, not the sandbox).

### P0 — Evidence (no app rendering changes)

What elia asked for first: **aggregate the TV `perf` usage events in admin**.
Today `perfTier.ts` sends `track('perf', {screen, p50, p90, jank, frames, low,
lite})` up to 6× a session (every 120 s), a `device` event once (`mem_mb,
heap_mb, lowram, sdk, model, gpu, low`) and a `trim` event; `src/lib/usage.js`
**persists** them (`data/usage/events-YYYY-MM.jsonl`) but `apply()` has no
`perf` branch, so nothing is aggregated or shown. P0:

1. `src/lib/usage.js`: a `perf` branch → `agg.perf = {screens: {<screen>:
   {n, p50: [], p90: [], jank: [], frames}}, devices: {<model>: {n, sdk,
   mem_mb, heap_mb, gpu, low: {no, android, mem, heap, frames, trim}}}, tiers:
   {lite, low}}`; `summary()` + `text()` sections; `public/admin.html` a
   "TV frames" table (screen × p50/p90/jank, split by `impl` and `v`, see 2).
   Spec in `02-verification.md §6`.
2. The TV tags every `perf` event with `v` (versionCode) and `impl` (a short
   string of which components are native, e.g. `"-"` today, `"F"`, `"FCR"`).
   `cleanProps` keeps ≤ 10 keys — the event has 7 today, so 2 more fit.
3. Baseline capture on the Mi TV with the harness from P1 (so the harness is
   built in P0/P1 in parallel): `dumpsys gfxinfo` for the four scripted
   scenarios, PSS, and 10 sessions of `perf` events.

Gate: admin shows per-screen p50/p90/jank by model and version; baseline
numbers filed under `docs/qa/native-baseline-<date>/`.

### P1 — Infrastructure + the first component (Focusable)

- `package.json` `codegenConfig` (none exists today), `src/specs/`, an
  `AuroraUiPackage` with `createViewManagers`.
- `AuroraImpl` switch registry (SharedPreferences, adb-flippable, read by JS
  at start) and the `com.auroratv.QA` broadcast receiver (`02 §2`).
- `AuroraAnim`: the port of RN's two native drivers + `bezier.js` (`01 §6`).
- `AuroraFocusable` (a `ViewGroupManager`): ring, highlight wash, focus
  overlay fade, scale + lift spring, `light` gap/ring variant, the ring
  registry (one lit ring), `hasTVPreferredFocus` disarm, `holdLeft`,
  `focusDisabled`, long-press. Emits `onFocusChange {focused, edgeLeft,
  edgeRight}` so `focus.ts` keeps its facts.
- JS `Focusable.tsx` becomes a thin switch: `impl.focusable ? <AuroraFocusable
  …> : <today's body>`. Card/Btn/Chip/NavItem change nothing.

Gate (the 1:1 rule, §4): pixel diff at rest and lit states for Card, Btn
primary/secondary, Chip, NavItem, source row; animation traces match; focus
path table identical; D-pad-hold p50/p90 not worse, input-latency flag count
lower.

### P2 — Card

`AuroraCard`: the poster/landscape/compact/frame boxes, Fresco image via the
shared pipeline, blur-up placeholder, baked shades (`card-shade-v.png`,
`card-frame-shade.png`), brighten overlay, NEW/kind tags, ✕, progress bar
(gradient fill + glow + bead), retry/backup/park logic for failed pictures
(`Card.tsx` lines ~700–790 → Kotlin), **RN `Text` children for labels** (title,
sub, frame label, fallback title). Card's props = `HeroItem` subset (`01 §3`).

Gate: pixel diff for the 4 shapes × {rest, focused, with progress, NEW, kind,
episode label, frame label, fallback tile, blur-up mid-load (frozen)}.

### P3 — Row

`AuroraRow`: the sliding track (retargetable spring `speed 12 / bounciness 0`
→ stiffness 342.1 / damping 36.9, `01 §6.3`), the window (ahead 5 / behind 3 /
slack 3, `LEAD 1`), card creation **natively** from an `items` prop (no React
per window move), the left fade strip, the focus traps (`trapFocusLeft/Right`
semantics = `FocusFinder.findNextFocus` inside the group), `onItemFocus {index}`
and `onSelect {index}` / `onLongPress {index}` events back to JS. Title text
stays an RN `Text` above it (not in the hot path).

Gate: trace of `translateX` under a 20-press hold identical to JS within 1e-3
dp per frame; window mount/unmount counts identical; Home steady-state p90 ≤ 33
ms on the Mi TV (today 38) — the first phase with a hard perf target.

### P4 — Home's hero art + sliding column

`AuroraHeroArt` (rest/scrolled layers, dim, scrim, trailer slot as a child,
`atTop` 280 ms timing, `artFade` interpolation of the column offset) and
`AuroraSlideColumn` (the `ty` spring, clamped). The lockup text, buttons and
dots remain RN children positioned by Yoga inside the column.

### P5 — NavRail

`AuroraNavRail`: strip (scrim, mark, dots), panel slide (280 ms, −288 → 0),
feather, hues (two 8 s / 10.5 s sine loops, lite-gated), items as native
focusables (invert-on-focus, light ring). Labels as RN `Text` children. The
key logic (`onTV`, `focusJustMoved(120)`, wrap at ends) **stays in JS** in P5;
only drawing and focus containment move. (Moving the key logic native is a
P6 option once `focus.ts` has a native twin.)

### P6 — Grids (Browse, MyList, Search, Pick, ProfileGate) and the B decision

The vertical `FlatList` grids are the last JS list on a hot path. Either
`AuroraGrid` (native children, recycling, `scrollToOffset`, paging via
`onEndReached`) as option A, or Home-as-a-native-screen as option B. Decided by
P3/P4 numbers (§5).

Never in scope for A: overlays/sheets, Player chrome, Detail's page body,
Settings, SignIn, WhatsNew. They are not on the input-hold path, and their
animations (XraySheet spring, flash, skip hint) are already native-driver and
rare.

## 4. The 1:1 acceptance rule (applies to every step)

A component may be switched to native by default only when **all** hold, on
the Mi TV, same APK, same private server fixture (`02-verification.md`):

1. **Pixels at rest.** For every state in the component's state matrix, the
   native and JS screenshots differ in ≤ 0.05 % of pixels at pixelmatch
   threshold 0.1 (≈ 8/255 per channel after the YIQ weighting), and **zero**
   differing pixels outside a 1-px dilation of edges (anti-aliasing is the only
   permitted difference; a 1-px layout shift is a failure because it moves an
   edge). Masks exclude only what the fixture cannot freeze (listed per
   component, never silently).
2. **Motion.** Per-frame value traces (`[anim]` lines, `02 §4`) match RN's to
   1e-3 of the animated unit with the same frame count ±1; start-to-rest
   duration within one frame (16.7 ms).
3. **Behaviour.** The key-path table (focus target after each scripted key
   sequence, read from the `[focus]` QA log) is identical, including the
   negative cases (LEFT at the row's first card does **not** move; the rail
   opens; `focusJustMoved` suppressions).
4. **Performance.** On the scripted scenarios, p50/p90 and jank % not worse
   than JS on the same run day; PSS not more than +5 %. P3 onward has an
   improvement target stated in the phase.
5. **No regression in the app's own `perf` events** for a week in the field
   (admin table split by `impl`) before the JS path is deleted.
6. **elia's eyes** on the device, side by side (`screenrecord` A/B).

A step that cannot meet (1) because of a documented renderer difference (e.g.
a text glyph that Android's `TextView` and a `StaticLayout.draw` rasterise
differently) is **not** waved through: the component keeps RN `Text` for that
piece. That is why the plan keeps text on RN for as long as it can.

## 5. Decision points

- **After P1:** if the input-latency flag count on a 20-press hold does not
  drop by at least a third, the bridge hop was not the cost and P2/P3 should
  be re-measured before building (the Row's mount churn would then be the
  dominant term — go straight to P3 and keep Card in JS).
- **After P3/P4 (the B decision):** Home steady-state p90 on the Mi TV. If
  ≤ 25 ms, stop at A; the remaining time is not worth a screen rewrite. If
  the Fabric mounting of the *remaining* RN children (texts, buttons, lockup)
  still shows in `systrace`/Perfetto as ≥ 4 ms per commit on hero rotation,
  go B for Home only: `AuroraHomeView` hosting the existing native rows and
  hero, with the lockup text native (first place text must be made 1:1 — the
  `02 §3.4` text procedure applies).
- **Never:** C, unless the requirement changes from "1:1 copy" to "a new app".

## 6. Order by measured benefit and risk

| # | component | benefit (why) | risk | phase |
|---|---|---|---|---|
| 1 | Focusable (ring/scale/lift) | removes the per-press JS hop (5 native calls after a JS turn); the "answering the remote late" symptom | low: 527 lines, self-contained, no data | P1 |
| 2 | Row (slide + window) | removes React commits and ~40-view mount bursts from the hold path; the biggest frame-time term after P1 | medium: windowing/identity semantics, traps, events | P3 |
| 3 | Card | 12–15 views → 1–2 views per card (fill rate, mount cost, memory); retry logic moves | medium-high: pixel fidelity of shades/tags/progress; text kept on RN | P2 |
| 4 | Hero art + column | big bitmaps, 9 s re-render of the lockup, `artFade` | medium: trailer child, two art layers, scrolled-layer lifecycle | P4 |
| 5 | NavRail | consistency of the ring; the hues loops | low-medium: the key logic stays JS | P5 |
| 6 | Grids | Browse's FlatList (750 ms frames before `removeClippedSubviews`) | high: FlatList semantics, paging, scroll-into-view | P6 |

Card is listed before Row in the table but **built after Focusable and before
Row only if P1's result says view count matters more than commits** — the
default order is P1 → P3 (Row with JS Cards as children) → P2 (Card) → P4. A
native Row hosting JS Cards is legal in Fabric (children are RN views); it
measures the mount cost in isolation.

## 7. What already exists natively (reused, not rewritten)

`tv-native/android/app/src/main/java/com/auroratv/`:

- `DeviceModule.kt` — JankStats per-screen histograms (`setFrameScreen`,
  `takeFrameStats`), trim-memory events, GL renderer probe, window background
  drop. The perf-tier inputs live here already; the native components read the
  tier from a new `AuroraTier` object fed by `perfTier.ts` (`01 §9`).
- `MainApplication.kt` — RN's Fresco config + trim registry; the native Card
  must not initialise Fresco again.
- `MainActivity.kt` — `dispatchKeyEvent` 110 ms same-key dedupe (native) and
  the JS `acceptTvEvent` key-up dedupe (1 500 ms); both stay.
- `A11yServices.kt` + the ASM rewrite — stays until a react-native-tvos release
  carries #1159.
- `TrailersModule.kt` (NewPipe), `HomeScreen*.kt`, `DownloadNotices.kt`,
  `UpdaterModule.kt`, `RelaunchReceiver.kt` — untouched.

## 8. Risks and how the plan contains them

| risk | containment |
|---|---|
| text not pixel-identical | text stays RN `Text` children through P5; a text port happens only in B with its own procedure |
| focus semantics drift between RN views and native views | same Android `FocusFinder` under both; traps reproduced with the same `focusSearch` override; `focus.ts` fed by `onFocusChange`; the key-path table is a gate |
| animation timing differs by a frame | the drivers are ported line for line and driven from `ReactChoreographer`'s `NATIVE_ANIMATED_MODULE` phase; traces are a gate |
| layout rounding ±1 px | native components are Yoga-laid-out Fabric views (same `roundValueToPixelGrid`); internal drawing uses the same half-up rule |
| Fresco cache misses / double decode | identical `ImageRequest` (same URI, `ResizeOptions`, post-processor, headers via `ReactNetworkImageRequest`) |
| a native component crashes on one box | the switch defaults are per component and can be flipped from the server (`/api/home` `_impl` hint, `01 §4`) without an APK |
| the harness lies (screencap not frame-exact) | rest states only for pixels; motion by traces; `screenrecord` for eyes |

## 9. Candidly: how hard is a true 1:1

Hard, and hardest in four places. **Text**: RN measures with `StaticLayout`
in a Yoga measure function and draws with a `TextView` using the same flags
(`setIncludePad(true)`, `setLineSpacing(0,1)`, `setUseLineSpacingFromFallbacks(true)`
on API 28+, `letterSpacing` as em via `CustomLetterSpacingSpan`, `lineHeight`
via `CustomLineHeightSpan`); a native `StaticLayout.draw` with the same flags
*should* be identical, but one differing default (hyphenation frequency, break
strategy, the font-padding bit, weight mapping `Typeface.create(tf, 800,
false)` vs nearest-bold below API 28) moves every glyph a pixel — so the plan
simply does not port text until it has to. **Layout rounding**: Yoga snaps
to the pixel grid per node with half-up rounding on the *scaled* value and
force-ceil/floor on far edges; a native layout that computes `width = right −
left` from already-rounded edges differs by a pixel at odd densities — avoided
by letting Yoga lay out the Fabric views and only drawing inside them.
**Animation frame timing**: RN's timing driver does not interpolate between its
60 fps samples (`frames[floor(t/16.667)]`), its spring caps `deltaTime` at 64
ms and retargets by reading the running animation's position *and velocity*;
an `androidx` `SpringAnimation` or a `PathInterpolator` is close but not the
same curve, and "close" shows as a one-frame lead on a 20 Hz key repeat — so
the drivers are ported, not approximated, and the traces are compared
numerically rather than by screenshot. **Focus semantics**: react-native-tvos
adds `trapFocus*` (a `focusSearch` override), `autoFocus`/`destinations`
(`addFocusables`/`requestFocus` overrides with a "recover focus" dance),
`hasTVPreferredFocus` (`requestFocus(FOCUS_DOWN)` on attach, re-applied on
prop updates — the #670 yank the app disarms), and the JS side layers
`focusJustMoved(120)`, edge flags and a 120 ms focus-loss rescue on top; the
native components must reproduce the Android-side overrides exactly and keep
feeding the JS facts, and the only proof is the key-path table on the device.
The plan contains all four the same way: the JS stays as the reference on the
same build, each piece is switchable, and nothing is declared done by reading
code — only by the Mi TV's screenshots, traces and frame histograms agreeing.

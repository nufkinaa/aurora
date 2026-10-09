# Architecture — the JS↔native contract

For options A and B of `00-plan.md`. Everything here is pinned to what is in
the tree today: react-native-tvos 0.86.0-2 (Fabric), Kotlin 2.1.20, the
prebuilt `react-android` AAR, `tv-native/src/*` and
`tv-native/android/app/src/main/java/com/auroratv/*.kt`.

Naming: Kotlin lives in `com.auroratv.ui` (new package, beside the existing
modules); codegen specs in `tv-native/src/specs/`; JS wrappers keep today's
component names so screens do not change.

## 1. Declaring Fabric components

### 1.1 codegen

`tv-native/package.json` has **no** `codegenConfig` today (the app only has
legacy `ReactContextBaseJavaModule`s, which Fabric runs through the interop
layer). Add:

```json
"codegenConfig": {
  "name": "AuroraSpecs",
  "type": "all",
  "jsSrcsDir": "src/specs",
  "android": { "javaPackageName": "com.auroratv.specs" }
}
```

The React Native Gradle plugin (`apply plugin: "com.facebook.react"` is already
in `app/build.gradle`) runs codegen at build; generated Java lands in
`android/app/build/generated/source/codegen/java/com/auroratv/specs/`
(`AuroraCardManagerInterface`, `AuroraCardManagerDelegate`, …). Nothing is
committed from there.

### 1.2 a spec (TypeScript)

`src/specs/AuroraFocusableNativeComponent.ts`:

```ts
import type {HostComponent, ViewProps} from 'react-native';
import type {Double, Int32, WithDefault, DirectEventHandler} from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';
import codegenNativeCommands from 'react-native/Libraries/Utilities/codegenNativeCommands';

type FocusChange = Readonly<{focused: boolean; edgeLeft: boolean; edgeRight: boolean}>;

export interface NativeProps extends ViewProps {
  ringKind?: WithDefault<'white' | 'violet' | 'none', 'white'>;
  ringWidth?: WithDefault<Double, 3>;          // focus.borderWidth
  ringColor?: string;                           // overrides ringKind's colour (Card: rgba(255,255,255,0.9))
  ringRadius?: Double;                          // the flattened borderRadius (Focusable computes it today)
  shadow?: string;                              // CSS box-shadow text, same grammar RN parses
  light?: boolean;                              // --focus-ring-light: 3dp bg gap + 4dp ring outside the box
  highlightColor?: string;                      // wash whose opacity rides the ring value
  scaleTo?: WithDefault<Double, 1.055>;
  noScale?: boolean;
  lift?: WithDefault<Double, 0>;
  edgeLeft?: boolean;
  edgeRight?: boolean;
  holdLeft?: boolean;                           // nextFocusLeft = self
  focusDisabled?: boolean;                      // focusable=false + isTVSelectable=false
  preferredFocus?: boolean;                     // hasTVPreferredFocus, with the 600 ms disarm done natively
  overlayIndex?: WithDefault<Int32, -1>;        // which child is the focusOverlay (its alpha rides the ring value)
  onFocusChange?: DirectEventHandler<FocusChange>;
  onPress?: DirectEventHandler<Readonly<{}>>;
  onLongPress?: DirectEventHandler<Readonly<{}>>;
}

export const Commands = codegenNativeCommands<{
  requestTVFocus: (ref: React.ElementRef<HostComponent<NativeProps>>) => void;
  clearRing: (ref: React.ElementRef<HostComponent<NativeProps>>) => void;
}>({supportedCommands: ['requestTVFocus', 'clearRing']});

export default codegenNativeComponent<NativeProps>('AuroraFocusable') as HostComponent<NativeProps>;
```

Codegen limits that shape the specs: no union object types, no optional
nested objects inside arrays (use `WithDefault` scalars and flat objects),
colours as `string` (parsed natively with `ColorPropConverter`), arrays of
flat objects are fine (`ReadonlyArray<CardItem>`).

### 1.3 the ViewManager (Kotlin)

```kotlin
package com.auroratv.ui

@ReactModule(name = AuroraFocusableManager.NAME)
class AuroraFocusableManager : ViewGroupManager<AuroraFocusableView>(),
    AuroraFocusableManagerInterface<AuroraFocusableView> {
  private val delegate = AuroraFocusableManagerDelegate(this)
  override fun getName() = NAME
  override fun getDelegate() = delegate
  override fun createViewInstance(ctx: ThemedReactContext) = AuroraFocusableView(ctx)
  override fun getExportedCustomDirectEventTypeConstants() = mapOf(
    "topFocusChange" to mapOf("registrationName" to "onFocusChange"),
    "topPress" to mapOf("registrationName" to "onPress"),
    "topLongPress" to mapOf("registrationName" to "onLongPress"))
  override fun setRingKind(v: AuroraFocusableView, s: String?) { v.ringKind = s ?: "white" }
  // … one setter per prop, generated signatures from the delegate interface …
  override fun requestTVFocus(v: AuroraFocusableView) = v.requestFocusFromJS()
  override fun clearRing(v: AuroraFocusableView) = v.ring.release()
  // Fabric recycles views: a focused/animating view must not be handed to another node mid-animation.
  override fun prepareToRecycleView(ctx: ThemedReactContext, v: AuroraFocusableView): AuroraFocusableView? {
    v.resetForRecycle(); return super.prepareToRecycleView(ctx, v)
  }
  companion object { const val NAME = "AuroraFocusable" }
}
```

Registration: `AuroraUiPackage : ReactPackage` with
`createViewManagers(ctx) = listOf(AuroraFocusableManager(), AuroraCardManager(),
AuroraRowManager(), …)`, added in `MainApplication.kt` beside `UpdaterPackage()`.

**Base class.** Components that hold RN children (`Focusable`, `Row`,
`HeroArt`, `SlideColumn`, `NavRail`) extend
`com.facebook.react.views.view.ReactViewGroup` (public, open). That buys, for
free and identically: Yoga child positioning (`onLayout` no-op; children are
placed by `MountingManager`), `overflow`, border/background drawables,
`removeClippedSubviews`, hit-slop, the TV focus plumbing (`trapFocus*`,
`autoFocus`, `hasTVPreferredFocus`, `requestFocusFromJS`, `topFocus`/`topBlur`
events — see §5). Leaf drawers (`Card`'s picture stack) extend `View` and draw
in `onDraw`.

### 1.4 JS wrapper = the switch

```tsx
// Focusable.tsx
export default function Focusable(props: Props) {
  return impl('focusable') ? <NativeFocusable {...props} /> : <JsFocusable {...props} />;
}
```

`NativeFocusable` maps today's props one to one (it flattens `style` to find
`borderRadius` exactly as `Focusable.tsx:279-284` does, passes `ringRadius`),
forwards `onFocusChange` to `noteFocus(...)`/`noteFocusLost` and
`onFocusChange?.(f)`, and exposes `requestTVFocus` on the ref via
`Commands.requestTVFocus` so `focus.ts`'s `captureFocus()`/fallbacks keep
working unchanged (`focus.ts:82-85` only needs a node with `requestTVFocus`).

## 2. Component contracts

All dp values are **logical dp** (the 960-wide canvas; `canvas.tsx` scales the
whole tree by a transform, which native views inherit — §8).

### 2.1 AuroraFocusable — see §1.2

Draw order inside the view (matches `Focusable.tsx:375-447`): highlight wash
(alpha = ring value) → children → overlay child (alpha = ring value) → ring
(white/violet/none; or `light`: bg gap at −3 dp and ring at −7 dp with 4 dp
width) with its `boxShadow`. The reserved transparent 3 dp border is
**layout** (Yoga) — the JS wrapper keeps `styles.base` so nothing reflows.

State: `ringValue ∈ [0,1]` (timing 160 ms, bezier 0.2,0.7,0.2,1),
`springValue` (spring tension 180 / friction 14, interpolated to scale and
`translateY = −lift·v`). `onFocusChanged(gain)` → `AuroraRingRegistry.claim(this)`
(fades the previously lit ring out with the **same** 160 ms timing + spring to 0,
`Focusable.tsx:240-254`) → start both animations → emit `topFocusChange`.

### 2.2 AuroraCard

Props (a `HeroItem` subset, resolved in JS so `api.ts` stays the one place that
knows about art paths):

```ts
interface NativeProps extends ViewProps {
  shape: WithDefault<'poster' | 'wide' | 'compact' | 'frame', 'poster'>; // 124×186 / 176×99 / 116×174 / 224×140
  uri?: string; headersJson?: string;       // imgSrc(): {uri, headers:{X-Session,X-Profile}}
  sized: boolean;                           // artPath succeeded → no ResizeOptions re-encode
  retryUri?: string; backupUri?: string;    // the r=1 and /img/poster/<imdb> chain (Card.tsx:730-744)
  blurUri?: string;                         // data: URI from blur.ts, or absent
  blurSkip: boolean;                        // wasDrawn(uri)
  shade: WithDefault<'none' | 'rest' | 'frame', 'none'>;  // card-shade-v / card-frame-shade at rest
  shadeOnFocus: boolean;                    // poster with no label: shade fades in with focus
  brighten: boolean;                        // white @0.055 overlay on focus (always true today)
  removable: boolean;                       // the ✕ glyph on focus (drawn, not focusable)
  tag: WithDefault<'none' | 'new', 'none'>;
  kind: WithDefault<'none' | 'film' | 'series', 'none'>;
  progressPct: WithDefault<Int32, -1>;      // -1 = none; 0..100 draws the ramp + bead
  onImageEvent?: DirectEventHandler<Readonly<{phase: string; uri: string; error: string}>>; // 'load' | 'error' | 'tile' | 'parked'
}
```

Children: the RN `Text`s (label / sub / frame title / frame sub / frame meta /
fallback title) and the `Icon` of the kind tag (an `react-native-svg` view).
Native draws: background `bgRaised` + 1 dp edge `rgba(226,229,238,0.3)` at
radius 12, the picture (rounded to radius 11, `cover`), the blur-up layer, the
shade PNGs (`FIT_XY`), the brighten overlay, the tag pills (NEW: accentStrong
fill, radius 4, 1/5 insets — its **text** is still an RN child positioned by
Yoga, the pill is native), the ✕ disc (30 dp, `rgba(0,0,0,0.65)`; its glyph is
an RN `Text` child), the progress bar (`rgba(255,255,255,0.25)` track 4 dp,
fill `linear-gradient(90deg, #8b7bff, #7fd1e8, #8cffbe)`, glow `0 0 10px
rgba(140,255,190,0.55)`, 8 dp white bead with `0 0 8px rgba(255,255,255,0.9)`).

The retry state machine (1.5 s → `r=1`, then backup at once, then tile; slow
rounds 30 s / 2 min / 8 min; park until `welcome`) moves to Kotlin with the
same constants; JS is told through `onImageEvent` (for `trackError` and for
the `welcome` un-park, which JS triggers via a `retry` command).

### 2.3 AuroraRow

```ts
type RowItem = Readonly<{ key: string; /* …the AuroraCard props, flat… */ uri?: string; sized: boolean; shape: string; progressPct: Int32; tag: string; kind: string; removable: boolean;
  label?: string; sub?: string; frameTitle?: string; frameSub?: string; frameMeta?: string }>;
interface NativeProps extends ViewProps {
  items: ReadonlyArray<RowItem>;
  step: Double;            // card width + 14 (spacing.md)
  cardHeight: Double;      // CARD_H or FRAME_H
  contentLeft: WithDefault<Double, 84>;
  lead: WithDefault<Int32, 1>;
  ahead: WithDefault<Int32, 5>; behind: WithDefault<Int32, 3>; slack: WithDefault<Int32, 3>;
  fadeWidth: WithDefault<Double, 94>;   // contentLeft + 10, row-fade.png FIT_XY
  onItemFocus?: DirectEventHandler<Readonly<{index: Int32; key: string}>>;
  onSelect?: DirectEventHandler<Readonly<{index: Int32; key: string}>>;
  onLongPress?: DirectEventHandler<Readonly<{index: Int32; key: string}>>;
  onWindow?: DirectEventHandler<Readonly<{from: Int32; to: Int32}>>; // QA trace only
}
```

In P3 the row creates its cards natively (`AuroraCardView` instances it owns,
**not** RN children), positioned absolutely at `contentLeft + index·step`,
windowed `[anchor−behind, anchor+ahead]` with the anchor moving only when
`|index − anchor| ≥ slack` — the exact `Row.tsx:1243-1261` rule. Card texts in
this mode are native (`StaticLayout`, §7) — this is the first text port, and
it is gated by the text procedure in `02 §3.4`. Alternative for P3-lite: the
row hosts JS `Card` children (Fabric allows it) and only owns the slide; the
window stays a JS decision. The plan's default order tries P3-lite first.

Slide: a retargetable spring on `translationX` (§6.3) started on every
`onItemFocus` toward `−max(0, (index − lead)·step)`. Traps:
`trapFocusLeft/Right` on the viewport (reuse `ReactViewGroup`'s own fields via
the inherited props — the manager exposes them as before).

### 2.4 AuroraHeroArt and AuroraSlideColumn (Home)

`AuroraHeroArt`: props `restUri`, `scrolledUri` (nullable), `deviceBlurRest`,
`deviceBlurScrolled` (dp; 0 when the server blurred), `restDim`, `scrolledDim`,
`height`; one `Animated`-free Kotlin value `atTop` driven by a command
`setAtTop(boolean)` → 280 ms timing. Children: the trailer layer (an RN
`TrailerFrame` — ExoPlayer SurfaceView — positioned by Yoga) stays RN. The dim
and `hero-scrim.png` are drawn natively above the children exactly as
`Home.tsx:120-167` orders them (art → scrolled art → children → dim → scrim).

`AuroraSlideColumn`: the `ty` spring (speed 12 / bounciness 0) with
`slideTo(offset)` command and `clampMax` prop (`colH − height`), plus an
`onOffset` **native binding** to the sibling `artFade` (the hero layer's alpha
= interpolate(offset, [−0.9h, −0.3h, 0] → [0, 1, 1], clamp) — done by handing
the `AuroraHeroArt` a reference by `nativeId`, so no JS is in the loop).

### 2.5 AuroraNavRail (P5)

Props: `active`, `open` (boolean; the slide runs natively on change: 280 ms,
`translateX −288 → 0`, strip alpha `1 → 0`), `closing`, `lite`, `items:
ReadonlyArray<{key, label, icon, iconSize, withLabel, dot, on}>`, the profile
pill fields. Events `onItemFocus {index}`, `onItemPress {index}`,
`onSlideEnd {open}`. Labels and icons stay RN children (one Yoga column the
rail positions). `RailHues`: the two `glow.png` loops (8 000 / 10 500 ms,
`Easing.inOut(Easing.sin)`) in Kotlin, started only when `!lite`.

## 3. Data shapes

`api.ts:107-153 HeroItem` is the source. The JS wrapper derives card props the
way `Card.tsx:670-825` does today (`isEpisode`, `landscape`, `pct`,
`canFrame`, `picture`, `artDp`, `sizedPath`, `backup`, `blur`, `isNew`,
`leftTag`, `kind`, `showLabel`, `left`) and passes **results**, not the item.
Reason: `artPath`/`artPx`/`imgSrc`/`blurOf`/`wasDrawn` are the single source
of truth shared with everything else in the app, and moving them to Kotlin
would create a second copy to keep in step (the comment at
`HomeScreenRows.kt:20-28` is the cautionary tale: two mappings, written twice).

For `AuroraRow.items`, the same derivation runs per item in JS once per data
change (not per key press) — ~20 items × ~15 fields; measured cost target
< 1 ms per row commit on the Mi TV.

## 4. The per-component switch: `AuroraImpl`

- Kotlin `object AuroraImpl` reads `SharedPreferences("aurora_impl")`: keys
  `focusable|card|row|hero|rail|grid` → `"js" | "native"`. Defaults from
  `BuildConfig.IMPL_DEFAULTS` (a string like `"focusable=native,card=js"`, set
  in `app/build.gradle`, so a release flips defaults without code).
- Exposed to JS as a constant of `DeviceModule.getConstants()` (`impl: {…}`),
  read once at startup by `src/impl.ts`: `export const impl = (k) =>
  flags[k] === 'native'`. Read at startup only, by design: swapping an
  implementation while mounted would move focus; a change takes effect on the
  next launch (the harness restarts the app anyway).
- Flipped by `adb shell am broadcast -a com.auroratv.QA --es impl
  "card=native,row=js"` (receiver in `02 §2`) or, in the field, by a server
  hint `_impl` on `/api/home` (so a crashing native component can be turned
  off for everyone without an APK). The hint is applied for the *next* launch,
  never live.
- `perfTier.ts` appends `impl` (initial letters of native components, e.g.
  `"FCR"`) and `v` (versionCode from `DeviceModule`) to every `perf` event.

## 5. Focus: one Android focus tree, two owners

### 5.1 What RN does on Android (read from the 0.86.0-2 sources)

- A JS `Focusable` is a `ReactViewGroup` with `focusable=true`. Android's
  `FocusFinder` (`ViewGroup.focusSearch` → root → `FocusFinder.findNextFocus`)
  picks the next view on a D-pad key; **the framework moves focus, not JS.**
- `onFocusChanged` → `FocusEvent`/`BlurEvent` (`topFocus`/`topBlur`) to JS
  → `Pressable.onFocus`. The key itself is also broadcast to JS as
  `onHWKeyEvent` (`useTVEventHandler`, with `eventKeyAction` 0 = down, 1 = up)
  — two independent deliveries; their order is not guaranteed, which is what
  `focusJustMoved(120)` in `focus.ts:60-77` exists for.
- `hasTVPreferredFocus=true` → `ReactViewManager.setTVPreferredFocus` →
  `requestFocusFromJS()` (`super.requestFocus(FOCUS_DOWN, null)`, or deferred
  to `onAttachedToWindow` via `focusOnAttach`). Fabric re-applies props, so
  the JS disarms it after 600 ms / first focus (react-native-tvos#670).
- `trapFocusUp/Down/Left/Right` → `ReactViewGroup.focusSearch` override: when
  the trap matches the direction it returns
  `FocusFinder.getInstance().findNextFocus(this, focused, direction)` — the
  search is confined to this group's descendants, and a `null` result means
  **no move** (`ReactViewGroup.kt:1505-1525`).
- `autoFocus` / `destinations` → the view is a "TVFocusGuide": overrides
  `addFocusables` (offers itself instead of its children when it has a
  destination/last-focused), `requestFocus` (redirects to destination →
  last-focused → first focusable), remembers `lastFocusedElement` (WeakRef),
  and a `recoverFocus` dance when the focused child is removed.
- `requestTVFocus` command → `root.requestFocus()`.
- `nextFocusLeft` (used by `holdLeft`) is the stock `View.setNextFocusLeftId`.

### 5.2 Native components in the same tree

Because `AuroraFocusable` **extends `ReactViewGroup`**, all of the above is
inherited verbatim: the same `focusSearch`, the same guide behaviour, the same
`requestFocusFromJS`. Android does not know which views are "RN" and which are
"ours"; `FocusFinder` crosses the boundary freely. What changes is only *who
reacts* to `onFocusChanged`:

```kotlin
override fun onFocusChanged(gain: Boolean, direction: Int, prev: Rect?) {
  super.onFocusChanged(gain, direction, prev)        // keeps topFocus/topBlur for anything that listens
  if (gain) { AuroraRingRegistry.claim(this); AuroraFocusFacts.note(this, edgeLeft, edgeRight); ring.toLit(); }
  else { AuroraRingRegistry.release(this); ring.toDark() }
  emit("topFocusChange", mapOf("focused" to gain, "edgeLeft" to edgeLeft, "edgeRight" to edgeRight))
}
```

- `AuroraRingRegistry` (Kotlin singleton) is the "one lit ring" rule
  (`Focusable.tsx:59-78`). In the mixed phase the JS registry still exists for
  JS Focusables; the two are joined by: a native claim calls
  `AuroraFocusFacts.clearJsRing()` → emits one device event `AuroraRingClear`
  that the JS registry answers by fading its lit ring; a JS claim calls
  `Commands.clearRing` on the last native ring (the JS wrapper tracks it). One
  extra call per *cross-implementation* move only; gone when Focusable is
  native everywhere.
- `AuroraFocusFacts` mirrors `focus.ts`'s process-wide facts (`held`,
  `heldEdgeLeft/Right`, `lastFocusMoveAt`). In P1 it is write-only from native
  and JS keeps reading its own copy fed by `onFocusChange`; the two converge
  when the rail's key logic moves native (P6 option). `focusJustMoved`'s clock
  is `SystemClock.uptimeMillis()` natively vs `Date.now()` in JS — both are
  monotonic enough over 120 ms; the comparison is within one side only.
- Pressable semantics: OK/ENTER on a focused view → Android `performClick` on
  `ReactViewGroup` when `onClick` is set. `AuroraFocusable` sets
  `isClickable=true`, `setOnClickListener` → `topPress`, `setOnLongClickListener`
  → `topLongPress` (long-press threshold `ViewConfiguration.getLongPressTimeout()`,
  the same source RN's Pressability uses on Android TV for key-held `select`).
  BACK is untouched (RN `BackHandler` keeps working — it is delivered via
  `onBackPressed` on the activity).
- `focusDisabled` → `isFocusable=false` **and** `descendantFocusability =
  FOCUS_BLOCK_DESCENDANTS` while true (the rail's slide-out needs the rows to
  vanish from the search; `Focusable.tsx:138-143`).
- `preferredFocus` → `requestFocusFromJS()` on first attach only; the view
  then ignores further `true`s (the 600 ms/first-focus disarm, done where the
  yank originates instead of in JS).

### 5.3 Row's traps and focus-loss rescue

`AuroraRow`'s viewport keeps `trapFocusLeft/Right` through the inherited
setters. When the row recycles the focused card out of the window (it should
not — the window is centred on focus — but `items` can change under it), it
emits `onFocusLost` and JS's `noteFocusLost` → 120 ms rescue runs unchanged
(`focus.ts:92-113`). Native does **not** grab focus on its own; the policy
stays in JS.

### 5.4 The key dedupes

Both stay where they are: `MainActivity.dispatchKeyEvent` (110 ms same-key
double-press swallow, native) and `acceptTvEvent` (JS, key-up within 1 500 ms
of its key-down ignored). Native components never read raw keys; they react
to focus changes and clicks, like the JS ones.

## 6. Animations — reproducing RN's drivers exactly

Today every animation that matters runs with `useNativeDriver: true`, i.e. in
`com.facebook.react.animated.*` on the UI thread, ticked from
`ReactChoreographer` (`NativeAnimatedModule.kt:345-371`,
`CallbackType.NATIVE_ANIMATED_MODULE`). The native components use a
line-for-line Kotlin port, `com.auroratv.ui.anim`, ticked from the **same**
`ReactChoreographer` phase so ordering relative to RN's own animations is
unchanged:

```kotlin
object AuroraClock {
  private val cb = object : ChoreographerCompat.FrameCallback() {
    override fun doFrame(frameTimeNanos: Long) { for (a in active) a.step(frameTimeNanos); if (active.isNotEmpty()) post() }
  }
  fun post() = ReactChoreographer.getInstance().postFrameCallback(ReactChoreographer.CallbackType.NATIVE_ANIMATED_MODULE, cb)
}
```

### 6.1 Timing (`Animated.timing`) = `FrameBasedAnimationDriver`

RN does **not** evaluate the easing per frame. In JS,
`TimingAnimation.__getNativeAnimationConfig` pre-samples the curve:
`frameDuration = 1000/60`, `numFrames = round(duration / frameDuration)`,
`frames[i] = easing(i / numFrames)` for `i < numFrames`, then
`frames.push(easing(1))`. Natively (`FrameBasedAnimationDriver.kt`):
`frameIndex = ((frameTimeNanos − startFrameTimeNanos) / 1e6 / (1000/60)).toInt()`
(truncation), `value = from + frames[min(frameIndex, last)] · (to − from)`;
`startFrameTimeNanos` is the first frame **after** `start()` (one frame of
latency), and finishing happens when `frameIndex ≥ frames.size − 1`.

Port: `AuroraTiming(duration, easing)` builds the same `FloatArray` (for 160
ms: 10 samples + 1; for 280 ms: 17 + 1) and indexes it the same way. On a 60 Hz
panel this is bit-identical; on a 50 Hz TV mode both RN and the port truncate
to the same index because both use the same formula from the same
`frameTimeNanos`.

Easing `bezier(0.2, 0.7, 0.2, 1)` = RN's `bezier.js` (Gaëtan Renaudeau's
unit-bezier: `kSplineTableSize 11`, `NEWTON_ITERATIONS 4`, `NEWTON_MIN_SLOPE
0.001`, `SUBDIVISION_PRECISION 1e-7`, `SUBDIVISION_MAX_ITERATIONS 10`). Port
the ~60 lines; do **not** use `android.view.animation.PathInterpolator` (it
approximates the curve with segments at precision 0.002 — close, not equal,
and the gate in `02 §4` is 1e-3 on the *output value*, which a 0.002 parameter
error can exceed near the knee). Other curves in use: `Easing.linear`
(Skeleton, MiniSpinner), `Easing.inOut(Easing.sin)` = `(1 − cos(πt))/2`
(RailHues), `Easing.in(Easing.quad)` = `t²` (XraySheet close — stays JS).

### 6.2 Spring (`Animated.spring`) = `SpringAnimation.kt`

Parameters are converted in JS **before** reaching native:

- `tension/friction` → `stiffness = (tension − 30)·3.62 + 194`,
  `damping = (friction − 8)·3 + 25`, `mass = 1` (`SpringConfig.js`).
- `bounciness/speed` → `s = (speed/1.7)/20`, `bouncyTension = 0.5 + s·199.5`,
  `b = min(((bounciness/1.7)/20)·0.8, …)`, `bouncyFriction = quadOut(b,
  b3Nobounce(bouncyTension), 0.01)` where `b3Nobounce` is the piecewise cubic
  `b3Friction1/2/3` (`SpringConfig.js:57-82`), then the same two formulas.
- `stiffness/damping/mass` pass through.

The driver (`SpringAnimation.kt:82-185`): per frame `dt = (frameTimeMs −
lastTimeMs)/1000`, capped at `MAX_DELTA_TIME_SEC = 0.064`; analytic solution
of the damped oscillator from the **start of the animation** (`frameTime +=
dt`):

```
ζ = c / (2·√(k·m)),  ω0 = √(k/m),  ω1 = ω0·√(1 − ζ²),  x0 = to − start,  v0 = −startVelocity
ζ < 1:  env = e^(−ζ·ω0·t)
        x = to − env·( (v0 + ζ·ω0·x0)/ω1 · sin(ω1·t) + x0·cos(ω1·t) )
        v = ζ·ω0·env·( sin(ω1·t)·(v0 + ζ·ω0·x0)/ω1 + x0·cos(ω1·t) ) − env·( cos(ω1·t)·(v0 + ζ·ω0·x0) − ω1·x0·sin(ω1·t) )
ζ ≥ 1:  env = e^(−ω0·t);  x = to − env·(x0 + (v0 + ω0·x0)·t);  v = env·( v0·(t·ω0 − 1) + t·x0·ω0² )
rest:   |v| ≤ restSpeedThreshold (default 0.001) AND |to − x| ≤ restDisplacementThreshold (default 0.001)
        (or overshootClamping && overshooting);  on rest the value snaps to `to`.
```

**Retargeting** (the property `motion.ts` is built on): `Animated.spring` on a
value that is already springing reads `previousAnimation.getInternalState()` —
`{lastPosition, lastVelocity, lastTime}` — and starts the new animation **from
that position with that velocity**, so a held key bends one journey. The port
keeps the same state triple and `retarget(to)` = `start(from = x, v0 = v,
to)`; `frameTime` restarts at 0 for the new segment, as RN's does.

### 6.3 The app's springs, converted

| use | config | stiffness | damping | ζ | ω0 (rad/s) | note |
|---|---|---|---|---|---|---|
| focus scale/lift (`theme.focus.spring`) | tension 180, friction 14, restDisplacement 0.001 | 737 | 43 | 0.792 | 27.15 | under-damped: the "hair of overshoot"; envelope to 1e-3 ≈ 320 ms |
| shelf/column slide (`SLIDE_SPRING`) | speed 12, bounciness 0 | 342.1 | 36.93 | 0.998 | 18.50 | effectively critical; settles inside a 50 ms key repeat |
| XraySheet rise (stays JS) | stiffness 190, damping 20, mass 0.9 | 190 | 20 | 0.765 | 14.53 | listed for completeness |

Interpolations ride the same value: scale `[0,1,2] → [1, scaleTo, 2·scaleTo −
1]` (linear segments; `InterpolationAnimatedNode` with `extrapolate: extend`),
translateY `[0,1,2] → [0, −lift, −2·lift]`.

### 6.4 Transforms

RN decomposes the `transform` array into a matrix and applies
`setTranslationX/Y`, `setScaleX/Y`, `setRotation*` with the pivot at the view
centre (`BaseViewManager.setTransformProperty` → `resetPivot()` unless
`transformOrigin`). `AuroraFocusable` applies `scaleX = scaleY = s` and
`translationY = −lift·v` directly on itself with the default pivot — the same
matrix RN produces for `[{scale}, {translateY}]` (RN composes scale then
translate; translation is in parent space either way because the scale pivot
is the centre, so `translateY` is not scaled — verify with the P1 trace that
`getMatrix()` equals the JS view's for the same `v`; `02 §4.2`).

## 7. Images — one Fresco pipeline

RN's `ReactImageView` (0.86.0-2) does, for `<Image source={{uri, headers}}>`:

- `ImageRequestBuilder.newBuilderWithSource(uri)` →
  `com.facebook.react.modules.fresco.ReactNetworkImageRequest.fromBuilderWithHeaders(builder, headers, cacheControl)`
  (`ReactImageView.kt:479`; `cacheControl` = the `source.cache` prop, `default`
  in this app) so the `X-Session`/`X-Profile` headers reach RN's OkHttp fetcher
  (the same client `FrescoModule.getDefaultConfigBuilder` installed —
  `MainApplication.kt`). Using a plain `ImageRequest` instead would miss the
  headers (401 on every `/img/…`, the exact failure 1.6.77 fixed server-side)
  **and** produce a different `CacheKey`, defeating the shared cache.
- `resizeMethod="resize"` → `.setResizeOptions(ResizeOptions(w, h))` with the
  view's px size; `"auto"`/`"scale"` → none (today the sized server variants
  use `auto`, so **no** ResizeOptions — the cache key is URI + post-processor).
- `blurRadius` → `IterativeBoxBlurPostProcessor(2, dp→px / 2)` (the "/2 to
  match other platforms" line, `ReactImageView.kt:199-206`); only the hero on
  hosts the server cannot blur, and `Card`'s blur-up at `BLUR_RADIUS = 1`.
- Corners: `RoundingParams.fromCornersRadii` with
  `RoundingMethod.BITMAP_ONLY` (the bitmap is clipped, not the view) and
  `setPaintFilterBitmap(true)`; `resizeMode="cover"` → `ScaleType.CENTER_CROP`,
  `"stretch"` → `FIT_XY`.
- `fadeDuration` → `GenericDraweeHierarchy.setFadeDuration` (0 everywhere in
  the app except the hero's rest layer, 260 ms).
- Decode: RN's default `ImagePipelineConfig` (downsampling on, ARGB_8888, no
  hardware bitmaps); the trim registry wiring is the app's own.

`AuroraCardView` uses `Fresco.newDraweeControllerBuilder()` +
`DraweeHolder`/`MultiDraweeHolder` (one holder per layer: blur, picture) with
**the same `ImageRequest`** built by a shared helper
`AuroraImages.request(uri, headersJson, resizePx?, blurDp?)` that mirrors the
four bullets above. Same URI + same options ⇒ same `CacheKey` ⇒ the bitmap
decoded for a JS card is served from the bitmap cache to the native card (and
vice versa) — this is what makes JS and native pixel-identical for pictures,
and what keeps memory flat during the mixed phase. Draw with
`drawable.setBounds(innerRect)` + `RoundingParams` radius 11 dp (`radius.m −
1`, `Card.tsx:998`), shades with `BitmapDrawable` from the bundled PNGs
(decoded once into a process-wide cache, `FIT_XY` via bounds).

Server art ladder: unchanged (`api.ts:743 ART_LADDER`, `artPx = ceil(dp ·
PixelRatio.get())` snapped **up**; `/img/<id>?w=`, `/img/ext?u=&w=`, `blur=`
for the hero). JS computes the URL; native only loads it.

## 8. Measurement, dp and pixels

- **Density**: Mi TV 320 dpi → `density 2.0`; Streamer 960×540 dp at 320;
  other sets 1280×720 dp (density 1.5 at 1080p). `PixelUtil.toPixelFromDIP(dp)
  = dp · density` (float). Native drawing code uses `PixelUtil` from the AAR,
  never `resources.displayMetrics` directly, so the value is the same object
  RN reads.
- **Layout rounding**: Fabric/Yoga positions every node with
  `roundValueToPixelGrid(value, pointScaleFactor = density)` — half-up on the
  *scaled* value (`fractial ≥ 0.5 → up`), with `forceCeil`/`forceFloor` for
  far edges so adjacent nodes do not leave gaps (`yoga/algorithm/PixelGrid.cpp`).
  Since the native components are Fabric nodes laid out by Yoga, their outer
  rects already obey this. **Inside** a native view, anything positioned in dp
  (ring inset 3, progress bar 8/8/6/4, tag 7/7, ✕ 6/6/30) is converted with
  the same rule: `px(dp) = round_half_up(dp · density)`, computed from the
  view's **absolute** edge (left + dp) and not from an accumulated float, so a
  124 dp card at density 1.5 (186 px) puts its 8 dp progress inset at 12 px
  exactly as Yoga would for a child at `left: 8`.
- **The logical canvas** (`canvas.tsx`): on panels not 960 dp wide the whole
  tree sits under `translate + scale(width/960)`. Native views inherit the
  parent's matrix; text and vector drawing stay sharp (the display list is
  replayed under the matrix), bitmaps upscale — identical to RN views beside
  them. Nothing in a native component reads the window size; `useTvMetrics`
  still decides sizes in JS and passes dp props.
- **Hardware layers**: a view with `renderToHardwareTextureAndroid` is
  `LAYER_TYPE_HARDWARE` (w×h×4 bytes of GPU memory). The JS ring does not
  actually set it (the prop is discussed in a comment only); the native ring
  **also does not**, to keep the GPU budget identical. If P1 measurement shows
  the blurred shadow re-rasterising per frame, promote the ring *drawable* to
  a cached bitmap (`Bitmap` the size of the ring, drawn with alpha) — same
  pixels, one rasterisation.

## 9. Perf tiers and memory

- `perfTier.ts` keeps deciding `lite` (API ≤ 28, or p90 > 40 ms over 150 rAF
  frames) and `lowRam` (`isLowRamDevice`, < 2.5 GB, `memoryClass ≤ 192`, Home
  p90 > 33 ms via JankStats, or a TRIM_RUNNING_CRITICAL). A new
  `DeviceModule.setTier(lite, lowRam)` writes `object AuroraTier`; native
  components read it at the moments JS does (RailHues start; blur-up skipped
  on lowRam if JS ever does so). Nothing is stored across launches, as today.
- **Fresco budget** stays RN's default (bitmap cache ≈ `maxMemory/4` on a
  device with `memoryClass 256`, i.e. 64 MB; Mi TV `memoryClass` should be read
  from the first `device` perf event and recorded in `03-inventory.md` once
  known). Sized posters: 248×372 px ARGB ≈ 369 KB; ~90 cards ≈ 33 MB. The
  native card adds **no** bitmaps beyond what JS holds (shared cache), and
  removes ~10 `View` objects (~1 KB each plus RenderNode) per card.
- **View count target**: Home today ≈ 90 Focusables × ~13 views ≈ 1 200 views
  + rows/hero ≈ 1 400. After P2/P3: ≈ 90 × 2 + texts ≈ 400.
- Memory gate per phase: PSS (`dumpsys meminfo com.auroratv`, `TOTAL PSS` and
  `Graphics`) on the scripted Home scenario not above JS + 5 %; `Graphics`
  expected to **drop** after P2.

## 10. Threading

| what | thread | notes |
|---|---|---|
| props commit → Fabric mount (create/update/delete views, `setX` setters) | UI (main) | `MountingManager` applies diffs; keep setters O(1), no bitmap decode in a setter |
| `onDraw`, `onFocusChanged`, click listeners | UI | |
| `AuroraClock` steps and `invalidate()` | UI, `ReactChoreographer` NATIVE_ANIMATED_MODULE phase | same phase as RN's native-driver animations; runs after DISPATCH_UI in the same frame |
| Fresco fetch/decode | Fresco's background executors | callbacks marshalled to UI by `DraweeController`; `invalidate()` on arrival |
| events (`topFocusChange`, `topPress`, `onItemFocus`) | emitted on UI → `EventDispatcher` → JS thread | one event per move, like `topFocus` today; the JS side must stay O(1) (it is: `noteFocus` + a ref write) |
| JS `Animated` (the remaining ones) | unchanged | |
| codegen'd prop parsing (`ReadableMap` → Kotlin) | UI | for `AuroraRow.items` (~20 × 15 fields) measured target < 0.5 ms |

Rules: no `synchronized` on the draw path; `AuroraRingRegistry` and
`AuroraFocusFacts` are UI-thread-only (assert with `UiThreadUtil.assertOnUiThread()`
in debug); any work for the next window of cards (creating `AuroraCardView`s)
is done **before** the spring reaches them, triggered from `onItemFocus` on the
same frame, never from a posted runnable — that is the native equivalent of
`defer()` with the latency removed rather than moved.

## 11. Build & tooling notes

- Kotlin sources for the UI package: `android/app/src/main/java/com/auroratv/ui/`
  (`AuroraUiPackage.kt`, `anim/{AuroraClock,AuroraTiming,AuroraSpring,Bezier}.kt`,
  `focus/{AuroraRingRegistry,AuroraFocusFacts}.kt`, `view/{AuroraFocusableView,
  AuroraCardView,AuroraRowView,AuroraHeroArtView,AuroraSlideColumnView,
  AuroraNavRailView}.kt`, `images/AuroraImages.kt`, `qa/QaReceiver.kt`).
- No new Gradle dependencies: Fresco, `react-android`, `androidx.core` are
  already linked. (`androidx.dynamicanimation` is deliberately **not** used —
  §6.)
- Fabric debug: `adb shell setprop log.tag.ReactNative VERBOSE` shows mount
  ops; `AuroraClock` logs `[anim]` traces only when `QaReceiver` turned
  tracing on (`02 §4`).
- The ASM rewrite in `build.gradle` only targets `ReactViewManager`; our
  managers are untouched by it and do not call
  `getEnabledAccessibilityServiceList` (the `manageFocusGuideAccessibilityDelegate`
  path is inherited from `ReactViewGroup`, not from the manager, so the rewrite
  is not needed for them — verify once with `adb logcat -s A11yServices` in P1).

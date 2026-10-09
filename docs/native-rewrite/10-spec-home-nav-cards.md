# 10 · Home / Nav / Cards — 1:1 rendering spec for the native (Kotlin, Android TV) rewrite

**Scope of this document set:** the home side of the Aurora TV app — `NavRail`, `Home` (billboard, rows), `Browse` (Movies/Shows grids), `Card`, `Row`, `Chip`, `Btn`, `Focusable`, `Icon`, `theme.ts`, the sized-artwork rules in `api.ts`, and the perf tiers. The title/player side is another document.

**Source of truth measured:** working tree of `C:\elia\aurora\tv-native` at HEAD `42bb208` ("1.6.77 / Aurora TV 5.1.28"). The working tree carries **uncommitted 5.1.29 edits** (`build.gradle` versionName 5.1.29, `update.ts` APP_VERSION 5.1.29, `NavRail.tsx` mark 34/40 → 28/36 dp + a 4 dp optical nudge, re-rendered `logo-mark*.png`). This spec documents the **working tree**, and flags the uncommitted values where they occur. Line numbers are of the working tree files.

Runtime: `react-native-tvos@0.86.0-2` (`package.json:18`), `react-native-svg ^15.15.5`, `react-native-video ^6.19.2`, Fabric (new architecture, `MainActivity.kt:7`).

Every number below carries a `file:line` so a reviewer can check it. Behaviour that is accidental or arguably a bug is marked **[KEEP-AS-IS?]** — the owner decides; nothing was "improved" silently.

## Files in this set

| File | Covers |
|---|---|
| **10-spec-home-nav-cards.md** (this) | Global rules: the logical canvas, metrics formulas, theme tokens, typography/fonts, the focus & key-event model (`focus.ts`, `MainActivity.dispatchKeyEvent`, react-native-tvos key plumbing), artwork sizing (`api.ts`), blur-up, perf tiers, screen transitions, global native-mapping notes, summary of what is hardest to reproduce |
| [10a-spec-focusable-chip-btn-icon.md](10a-spec-focusable-chip-btn-icon.md) | `Focusable` (ring, scale spring, lift, light variant, highlight, overlay, hold/long-press, holdLeft/edgeLeft/edgeRight), `Chip`, `Btn`, `Icon`, `MiniSpinner`, `Skeleton`, `Empty`/`ErrorState` |
| [10b-spec-navrail.md](10b-spec-navrail.md) | Collapsed strip, open panel, scrim, feather, moving hues, items, profile pill, animations, focus trap, LEFT-from-edge / UP-from-hero opening, BACK, wrap |
| [10c-spec-card-row.md](10c-spec-card-row.md) | `Card` (poster / compact / wide / frame / episode), tags, progress bar, shades, blur-up, retry/park, peek on hold; `Row` (sliding shelf, windowing, fade) |
| [10d-spec-home.md](10d-spec-home.md) | Billboard art layers + server blur, scrims, lockup typography, buttons, dots, trailer in hero, rotation, the sliding column, rows, Continue Watching, loading/error/empty states, update chip |
| [10e-spec-browse.md](10e-spec-browse.md) | Movies/Shows grid, header + counts, edge strip, filter panel (categories, genre `Picker`, Unwatched, Surprise me), skeleton/empty/failed states, paging |

---

## 1. The logical canvas (every dp below is a canvas dp)

`canvas.tsx` (`src/canvas.tsx`, the second file in the cat output; its line n = printed line − 94):

* `BASE_W = 960` (canvas.tsx:27). The app **always lays out 960 dp wide**. `scale = windowWidth / 960`; canvas height = `round(windowHeight / scale)` (canvas.tsx:38-40).
* If `|scale − 1| < 0.01` the children render untransformed (canvas.tsx:42-46). Otherwise a `View` positioned at (0,0) with `width: 960, height: canvasH` is transformed `translateX((W−960)/2), translateY((H−canvasH)/2), scale(scale)` (canvas.tsx:50-64) — i.e. scaled about its centre to fill the window exactly.
* Consequence (canvas.tsx:11-13): text stays vector-sharp; **bitmaps decode at the logical size and are upscaled** by the matrix. `PixelRatio.get()` is the *panel's* density, not the canvas scale, so on a 1920-dp-wide set a 124-dp poster is fetched at `artPx(124)` (see §6) and drawn at 2× that — slightly soft by design. A 1:1 native port must reproduce this (fetch width from density only, not from the canvas scale) or it will look *sharper* than today.
* Measured panels (theme.ts:166-170, 180-183): Google TV Streamer 960×540 dp (1080p @ density 320); many sets 1280×720; 4K sets 1920×1080. A 16:10 panel gives a 960×600 canvas.

### 1.1 `useTvMetrics()` (theme.ts:173-208)

| metric | formula | @960×540 | @960×600 |
|---|---|---|---|
| `width`, `height` | canvas size (theme.ts:178-179) | 960, 540 | 960, 600 |
| `heroH` | `round(height × 0.66)` (theme.ts:197) | 356 | 396 |
| `heroPadBottom` | constant `18` (theme.ts:199) | 18 | 18 |
| `heroTitle` | `round(width × 0.03)` (theme.ts:202) | 29 | 29 |
| `safeBottom` | `max(20, round(min(w,h) × 0.05))` (theme.ts:205) | 27 | 30 |
| `detailBackdrop` | `round(height × 0.6)` (theme.ts:206) — not used in this scope | 324 | 360 |

---

## 2. Theme tokens (`src/theme.ts`)

### 2.1 Colours (theme.ts:9-42)

| token | value |
|---|---|
| `bg` | `#0b0c14` (also `android:windowBackground` → `@color/aurora_bg` `#0b0c14`, `res/values/colors.xml`, `styles.xml`) |
| `bgRaised` | `#131523` |
| `surface` | `rgba(255,255,255,0.06)` |
| `surfaceHover` | `rgba(255,255,255,0.11)` |
| `line` | `rgba(255,255,255,0.09)` |
| `glass` | `rgba(13,14,24,0.72)` (unused in this scope) |
| `text` | `#f3f4f8` |
| `textDim` | `#9aa1b5` |
| `textFaint` | `#616880` |
| `accent` | `#8b7bff` |
| `accentStrong` | `#6c58ff` |
| `progress` | `#8b7bff` |
| `focusRing` | `rgba(255,255,255,0.95)` |
| `star` | `#f5c542` |
| `kindFilm` | `#f0c67e` |
| `kindSeries` | `#7fd1e8` |
| `black` / `white` | `#000000` / `#ffffff` |

Other literal colours used in scope (not tokens): panel body `#0a0b14` (NavRail.tsx:627, Browse.tsx:839), rail scrim `#080910` (NavRail.tsx:466), feather `#0a0b14` (NavRail.tsx:383), card edge `rgba(226,229,238,0.3)` (Card.tsx:467-470), shade colour `#05060c` (gen_ambient.py:337), row-fade colour `(13,14,24)` (gen_ambient.py:204), tag fill `rgba(6,8,16,0.72)` (Card.tsx:538), error red `#ff7a7a` (States.tsx:92 → printed 315).

### 2.2 Radii, spacing, nav, motion (theme.ts:44, 83-93, 165)

* `radius = {s: 8, m: 12, l: 18, pill: 999}`
* `spacing = {xs: 4, sm: 8, md: 14, lg: 20, xl: 32, pageX: 48, pageY: 27, contentLeft: 84}` — `contentLeft` is rail 72 + 12 (theme.ts:85-86).
* `nav = {rail: 72, railOpen: 240}` (theme.ts:93).
* `motion = {fast: 160, med: 280}` (theme.ts:165).

### 2.3 Type scale (theme.ts:63-69) — note the header comment lists OLD values (34/26/20/16/14); the **code** is:

`fontSize = {hero: 30, title: 24, row: 18, body: 15, small: 13}`. (`hero` is not used by Home; Home uses `useTvMetrics().heroTitle` = 29 @960.) **[KEEP-AS-IS?]** the comment/code mismatch is documentation only.

### 2.4 Focus tokens (theme.ts:97-118)

* `borderWidth: 3`, `scale: 1.055`, `duration: 160` ms, `ease: cubic-bezier(0.2, 0.7, 0.2, 1)`, `spring: {tension: 180, friction: 14, restDisplacementThreshold: 0.001}`.

### 2.5 Card aura / clearance (theme.ts:128-163)

* `cardAura.edge = {width: 2, color: 'rgba(255,255,255,0.9)'}`; `cardAura.shadow = '0 18px 36px rgba(0,0,0,0.6)'`; `cardAura.lift = 3`.
* `CLEARANCE = {above: 28, below: 61}`; `CANCEL = {top: -23, bottom: -53}` (net 5 dp above / 8 dp below a shelf).

---

## 3. Typography and fonts

* **No font files are bundled.** No `fontFamily` appears anywhere in `tv-native/src`; there is no `assets/fonts` directory and no `.ttf/.otf` outside `node_modules`. Every `Text` therefore renders in **Android's default typeface (`Typeface.DEFAULT` → Roboto / `sans-serif`)** with the system's emoji font for glyphs such as 🍿 🔇 🔊 👥 🎲 ⚠️ ✕ ★ ▶ ▾.
* Weights: RN parses `fontWeight` '100'…'900' (ReactTypefaceUtils.kt `parseFontWeight`) and applies them with `Typeface.create(Typeface.DEFAULT, weight, italic)` on API ≥ 28, or `Typeface.create(tf, weight < 700 ? NORMAL : BOLD)` below API 28 (ReactFontManager.kt `TypefaceStyle.apply`, lines 146-151). So on Android 9+ the exact weights used in scope — 600, 700, 800, 900 — resolve to Roboto's nearest static face (Medium 500 for 600 on older Roboto; Bold 700; Black 900 for 800/900) or to the variable axis on Android 12+ Roboto Flex. **Native mapping: identical call, `Typeface.create(Typeface.DEFAULT, weight, false)`.**
* `includeFontPadding` is **true** by default in RN Android (TextAttributeProps.kt:95, :463) and nothing in scope sets it, so Android's default TextView behaviour already matches. Do **not** set `includeFontPadding=false` natively.
* `lineHeight` (where set) is applied by RN's `CustomLineHeightSpan`, which **centres** the glyph box inside the line (ascent/descent are rewritten symmetrically). Android's `TextView.setLineHeight()` instead adds the extra space *below*. To be 1:1, use a `LineHeightSpan` that reproduces RN's centring.
* `letterSpacing` in RN is in dp; Android `setLetterSpacing` is in em → pass `letterSpacing_dp / fontSize_dp`.
* `numberOfLines={n}` = `maxLines=n` + `ellipsize=END` (every use in scope is `ellipsizeMode="tail"` or default).
* `textShadow*` → `TextPaint.setShadowLayer(radius_px, dx_px, dy_px, color)` — RN passes `textShadowRadius` straight through as the blur radius.

---

## 4. The input model: keys, focus, press, hold

### 4.1 Native layer — `MainActivity.dispatchKeyEvent` (MainActivity.kt:60-88)

* For `DPAD_UP/DOWN/LEFT/RIGHT` only: an `ACTION_DOWN` with `repeatCount == 0` for the **same keycode** as the previous accepted one, arriving less than **110 ms** (`DOUBLE_PRESS_MS = 110L`, :87) after it, is **swallowed** (returns true) and `swallowingUp` is set so the matching `ACTION_UP` is swallowed too (:78-81). Held keys (`repeatCount > 0`) pass untouched (hold-to-scroll). Rationale: touchpad remotes deliver a swipe as two presses.
* `onCreate(savedInstanceState)` calls `super.onCreate(null)` (:43-45) — a clean slate on recreation.

### 4.2 Framework focus engine

Android's own `FocusFinder` moves focus on **key DOWN** (react-native-tvos does not replace it). `TVFocusGuideView` (used for every trap in scope) is `ReactViewGroup` with:
* `focusSearch(focused, dir)` returning `FocusFinder.getInstance().findNextFocus(this, focused, dir)` when `trapFocus<Dir>` is set for that direction (ReactViewGroup.kt:1505-1524) — i.e. the search is confined to the container's own descendants; when nothing is found in that direction **focus stays put**.
* `autoFocus`: `requestFocus()` goes to the **last focused descendant** if still attached, else the **first focusable** (ReactViewGroup.kt:1480-1498; last-focused is recorded in `requestChildFocus`, :1405-1409). It does *not* claim focus on mount by itself (NavRail.tsx:390-393) — `hasTVPreferredFocus` on a child does that.
* `hasTVPreferredFocus` on a view requests focus natively when set (ReactViewGroup.kt:459-461); `Focusable` forwards it only until first focus or 600 ms (see 10a-spec).
* `nextFocusLeft={selfTag}` (Focusable `holdLeft`) makes LEFT a focus no-op natively.

### 4.3 JS TV events (`useTVEventHandler`) — what the JS handlers actually receive

Dispatcher: `com.facebook.react.modules.core.ReactAndroidHWInputDeviceHelper` (the Java one; `ReactRootView.java:73,110,339`).
* `shouldDispatchEvent` (Java helper :188-194): a D-pad/select key is dispatched to JS on **`ACTION_UP` only** (`eventKeyAction: 1`) — `ReactFeatureFlags.enableKeyDownEvents` is `false` (ReactFeatureFlags.kt:34) — **plus** long-press variants while a key is held.
* Long press: a key held so that successive `ACTION_DOWN`s are > **300 ms** apart from the first (`mLongPressedDelta = 300`, :108) puts the helper in long-press state; it then emits **`longUp`/`longDown`/`longLeft`/`longRight`/`longSelect`** once per 300 ms window (:150-176) and the final UP also arrives as the long variant. The app's handlers only test `'left' | 'right' | 'up' | 'down'`, so **a held D-pad direction produces no JS action at all while held; the single `left`/`right`… event arrives on release** (the native focus engine, however, repeats moves at the system key-repeat rate while held).
* Event names (Kotlin table, ReactAndroidHWInputDeviceHelper.kt:60-78): `select`, `up`, `right`, `down`, `left`, `play`, `pause`, `playPause`, `rewind`, `fastForward`, `menu`, `info`, …

### 4.4 `focus.ts` — app-wide focus facts (quoted lines are of `src/focus.ts`)

* `noteFocus(node, edgeLeft, edgeRight)` (:47-52): every `Focusable` writes this on focus; `lastFocusMoveAt = Date.now()` when the node changed. `heldEdgeLeft` starts **true**, `heldEdgeRight` **false** (:37, :41).
* `focusJustMoved(ms)` = `Date.now() − lastFocusMoveAt < ms` (:76-77). Used with **120 ms** everywhere (NavRail.tsx:265, 286; Home.tsx:651; Browse.tsx:558). Purpose: the JS key event (on key-UP) lands *after* the native focus move (on key-DOWN); a press that *moved* focus to the edge must not also open the rail. **[KEEP-AS-IS?]** a press held longer than 120 ms before release (DOWN moved focus to the edge, UP arrives > 120 ms later) *will* both move focus and open the rail/panel/turn the slide on the same press — the literal behaviour of the 120 ms window.
* `captureFocus()` (:82-85) returns a closure that `requestTVFocus()`es the node that held focus at capture time.
* `noteFocusLost(node)` (:93-113): when the focused node unmounts, after **120 ms** with nothing focused, the innermost registered `useFocusFallback` ref gets `requestTVFocus()`.
* `useListClaim(key, ready)` (:140-147): index 0 gets `hasTVPreferredFocus` once per key, only when `ready`.
* Rail state: `noteRail(open)` counts; `railOpen()`; `onRailOpen/onRailClose` subscribers (:156-184); `setRailOpener/requestRailOpen` (:189-203) — the live rail registers how to open itself so Home's hero can summon it.
* `useKeyTrap(active)` (:216-228): while active, **every `useTVKeys` handler outside goes deaf** (`traps > 0`), and on deactivate focus is restored to the element captured on the way in.
* `acceptTvEvent(evt)` (:239-252): key-down (`eventKeyAction 0`) accepted and timestamped per `eventType`; key-up (1) accepted **only if no key-down of that type was seen in the last 1500 ms**; anything else accepted. With the Java dispatcher sending UPs only (nothing in react-native-tvos 0.86.0-2 or the app sets `enableKeyDownEvents`), every UP is accepted and this dedupe is **inert on this build** — the comment at focus.ts:230-238 ("reported TWICE … down and up") describes a key path the shipped binary does not take; the real double-press fix is `MainActivity`'s 110 ms swallow (§4.1). **[KEEP-AS-IS?]** keep the 1500 ms rule only if the native port ever delivers both edges to its handlers.
* `useTVKeys(handler, {deaf})` (:257-273): handler runs only when the screen is live (`useIsLive`, :277-291), not `deaf`, `traps == 0`, and `acceptTvEvent` passes.

### 4.5 Press / hold on a `Pressable` (what `Focusable` is)

* `DPAD_CENTER`/`ENTER` key-DOWN with `repeatCount 0` on the focused `ReactViewGroup` dispatches a native `PressInEvent`; key-UP dispatches `PressOutEvent` (ReactViewGroup.kt:1416-1457).
* Pressability (`Pressability.js:441-487`): on press-in it starts a **500 ms** long-press timer (`DEFAULT_LONG_PRESS_DELAY_MS = 500`, :264; `delayLongPress` default = 500 − `delayPressIn`(0)). If it fires, `onLongPress` runs **while the key is still held** and `_longPressSent = true`. On press-out the timer is cancelled; `onPress` fires **on release**, *unless* a long press was sent (then the release is swallowed) (:479-485). Android's touch sound plays on a plain press (:482-483).
* Spurious native `onClick`s with no `eventType` are ignored on TV (`Pressability.js:605-610`), so `onPress` has exactly one source: key-UP via press-out.
* **Native mapping:** key-down → start `Handler.postDelayed(500)`; key-up → cancel; if the delayed runnable ran, swallow the click; else `performClick()`. Do **not** rely on `ViewConfiguration.getLongPressTimeout()` (400 ms, device-dependent).

### 4.6 BACK

Handled per component with `BackHandler.addEventListener('hardwareBackPress')` returning `true` while a panel/sheet is open (NavRail.tsx:319-326, Browse.tsx:566-573, Picker.tsx:76-83, Sheet.tsx:29-35). Otherwise react-navigation pops the stack.

---

## 5. Screen stack and transitions (`src/navigation.tsx`)

* `createNativeStackNavigator`, `headerShown: false`, **`animation: 'fade'`, `animationDuration: 260`**, `freezeOnBlur: true`, transparent content (navigation.tsx:94-100). The `Player` screen uses `animation: 'none'` (:113).
* Theme background `transparent` (:64-67): the **Ambient** canvas is mounted once behind the whole navigator (:73) — `ambient.png` 480×270 stretched (FIT_XY) over the window (Ambient.tsx:62, printed 234), fully opaque; the window background is dropped natively two frames after it draws (Ambient.tsx:50-56 → printed 222-228) and restored on unmount.
* Each screen that enters with `useScreenIn()` (Browse does; Home does not): opacity 0→1 and translateY 10→0 over **280 ms**, bezier(0.2,0.7,0.2,1) (motion.ts:79-94).
* `frameScreen(name)` tags the JankStats frame monitor per route (:79, :88).

### 5.1 The ambient canvas (so the rows' background is known) — `tools/gen_ambient.py`

`ambient.png` is BG `(11,12,20)` with these elliptical radial blooms composited in order, each a **linear** ramp `a = peak × (1 − d/stop)` where `d` is the normalised elliptical distance (gen_ambient.py:68-107); centres/radii are fractions of the 480×270 frame:

| cx | cy | rx | ry | rgb | peak α | transparent stop |
|---|---|---|---|---|---|---|
| 0.80 | −0.01 | 0.69 | 0.63 | (96,80,220) | 0.24 | 0.62 |
| 0.11 | 1.01 | 0.66 | 0.60 | (48,112,184) | 0.17 | 0.60 |
| 0.42 | 0.20 | 0.62 | 0.17 | (70,200,150) | 0.19 | 0.95 |
| 0.12 | 0.50 | 0.34 | 0.13 | (60,180,140) | 0.12 | 0.95 |
| 0.84 | 0.74 | 0.40 | 0.20 | (64,190,150) | 0.10 | 0.95 |
| 0.50 | 0.50 | 0.58 | 0.62 | (58,38,112) | 0.40 | 1.0 |

(The first two centres are `−0.25 + v × 1.5` of the CSS positions 0.70/0.16 and 0.24/0.84; radii 0.46/0.42 and 0.44/0.40 × 1.5.) **Native: ship the same PNG and draw it FIT_XY.**

---

## 6. Artwork: which URL/width for which box (`src/api.ts`)

* `ART_LADDER = [240, 256, 352, 360, 448, 480, 640, 800, 960, 1280]` (api.ts:743) — identical to the server's `imgvariant.js` ladder.
* `artPx(dp)` = `ceil(dp × PixelRatio.get())` snapped **up** to the first ladder step ≥ it; `null` if above 1280 (api.ts:761-765).
* `artPath(path, px, blur=0)` (api.ts:771-785): query `w=<px>` plus `&blur=<n>` when `blur > 0`.
  * `/img/<id>` or `/img/meta/<id>` (regex `^\/img\/(?:meta\/)?[A-Za-z0-9._-]+$`) → `path?w=…`
  * `/img/poster/tt<digits>` (with or without existing query) → appended with `?`/`&`
  * any other `/img/…` (stills `/img/still/…`, frames `/img/frame/…`) → **null** (unsized)
  * `https://` on a proxied host (`image.tmdb.org`, `images.metahub.space`, `live.metahub.space`, `static.tvmaze.com`, `commons.wikimedia.org`, `upload.wikimedia.org`, api.ts:745-752) → `/img/ext?u=<encoded>&w=…`
  * anything else → null.
* `imgSrc(path)` (api.ts:721-728): absolute URL = `baseUrl + path` for root-relative; **`X-Session` and `X-Profile` headers** are attached only to URLs under `baseUrl` (api.ts:798-804).
* `serverCanBlur()` is `/api/ping`'s `imgBlur` flag (api.ts:654, 756-757).

Resulting requests at **density 2.0** (1080p set; the Streamer):

| box | dp | px asked | ladder |
|---|---|---|---|
| poster card `CARD_W` 124 | 124 | 248 | **256** |
| compact card `COMPACT_W` 116 | 116 | 232 | **240** |
| wide card `WIDE_W` 176 | 176 | 352 | **352** |
| frame card picture, backdrop/still: `FRAME_ART_W = ceil(140×16/9)` = 249 | 249 | 498 | **640** |
| frame card picture, poster fallback `FRAME_W` 224 | 224 | 448 | **448** |
| hero billboard | `heroPx(width)` = ladder step ≥ `min(1280, ceil(width×density))` (Home.tsx:99-102) → 1920 → capped **1280** | | |
| peek sheet art | 256 → 512 → **640** (Overlays.tsx:117) | | |

### 6.1 Blur-up placeholders (`src/blur.ts`; printed lines n = n − 268)

* Every GET carries `X-Blur: 1` (api.ts:565). The answer's `_blur` map (raw path → `data:image/webp…`, a 16-px-wide WebP, ~150 B) is kept in a `Map` capped at 3000 entries, oldest out (blur.ts:11-27 → printed 279-295); the field is deleted before any screen sees the body.
* `blurOf(rawPath)` is keyed by the path **as the JSON carried it** (`item.cover` / `poster` / `backdrop`), never by the sized URL.
* `wasDrawn(uri)` / `markDrawn(uri)` (blur.ts:35-40 → printed 303-308): absolute URIs already loaded this run (set capped 4000, cleared wholesale when exceeded) skip the placeholder.

---

## 7. Perf tiers (`src/perfTier.ts`)

Two independent judgements, decided fresh every launch (perfTier.ts:37-38):

**LITE** (`isLite()`, :81, :93):
1. up front: `Platform.Version <= 28` (Android 9 or older) → lite (:81);
2. measured: `measureOnce()` (:102-121), called **5 s after Home becomes live** (Home.tsx:460-468): times 150 `requestAnimationFrame` deltas; if the p90 delta > **40 ms** → lite for the session.

What lite changes **in this scope**:
* Home never starts a billboard trailer (Home.tsx:540 `if (isLite() …) return`); the still art rotates as usual.
* The nav panel's moving hues do not animate (NavRail.tsx:91) — the two glow discs stay at their `0` keyframe (violet opacity 0.26 at translate (−14,−10) scale 1; green opacity 0.18 at (22,16) scale 1.08).
* Nothing else in the home/nav/cards layer differs.

**LOW-RAM** (`isLowRam()`, :83-99): `ActivityManager.isLowRamDevice`, or total memory < 2.5 GB, or `memoryClass` ≤ 192 MB, or Home's JankStats p90 > 33 ms over ≥ 90 frames within 25 s (:218-243), or a `TRIM_MEMORY_RUNNING_CRITICAL` (:246-261). **No visible effect in this scope** — it changes ExoPlayer buffering and clears Fresco caches on the way into the player (title/player spec).

The frame monitor (`DeviceModule.kt`, androidx JankStats) reports p50/p90/jank per screen as `perf` usage events — telemetry, not rendering.

---

## 8. Global native-mapping notes

| RN construct as used here | Android equivalent that reproduces it exactly | Caveat |
|---|---|---|
| `View` (no `overflow: 'hidden'`) | `ViewGroup` with **`clipChildren=false`, `clipToPadding=false`** | RN views do not clip by default; Android ViewGroups do. Cards scale past their slot, the light ring draws outside its button, shadows reach out. Every container in scope except the ones that set `overflow:'hidden'` (`Skeleton` box, `panelBody`, `progress`, `Trailer` wrap, `peekArt`) must not clip. |
| `borderRadius` + `backgroundColor` (+ `borderWidth/Color`) | `GradientDrawable` (solid, corner radius, stroke) | RN draws the border *inside* the box; stroke in `GradientDrawable` is also inside the bounds — matches. |
| `boxShadow: 'x y blur rgba'` (RN 0.76+ Android) | `OutsetBoxShadowDrawable` semantics: a `BlurMaskFilter(radius, NORMAL)` where **σ = blur/2** (BoxShadow.kt / OutsetBoxShadowDrawable.kt:34,54), offset (x,y), spread 0, drawn behind the view at the view's own corner radius | Use `Paint.setMaskFilter(BlurMaskFilter(FilterHelper.sigmaToRadius(blur×0.5)))` on a rounded rect of the view's bounds. |
| `textShadow{Color,Offset,Radius}` | `TextPaint.setShadowLayer(radius, dx, dy, color)` | identical |
| `experimental_backgroundImage: 'linear-gradient(165deg, …)'` | **CSS** linear-gradient maths (RN's `LinearGradient.kt` implements the CSS gradient-line: length = |w·sinθ| + |h·cosθ|, centre of box), rendered via `android.graphics.LinearGradient` shader | `GradientDrawable.Orientation` cannot do 165°; write the shader by hand. |
| `react-native-svg` `<LinearGradient x1 y1 x2 y2>` with `<Stop>` | `android.graphics.LinearGradient` in objectBoundingBox units scaled to the view; stops with `stopOpacity` folded into ARGB | SVG default gradientUnits is objectBoundingBox — the fractions are of the painted rect. |
| `Image resizeMode="cover"` | Fresco `ScalingUtils.ScaleType.CENTER_CROP` (ReactImageView.kt:244, 414) | Fresco is shared — use `SimpleDraweeView` or the pipeline directly with the same OkHttp client. |
| `Image resizeMode="stretch"` | `ScaleType.FIT_XY` | |
| `Image style borderRadius` | `RoundingParams.fromCornersRadius(r)` with `RoundingMethod.BITMAP_ONLY` (ReactImageView.kt:432) | |
| `Image fadeDuration` | `GenericDraweeHierarchy.fadeDuration` — default **300 ms** for remote, **0** for bundled resources (ReactImageView.kt:436-440, 635) | Where this spec says "fadeDuration 0", set 0; where unset on a remote image, 300. |
| `Image blurRadius={dp}` | `IterativeBoxBlurPostProcessor(2, (int)(dp×density) / 2)` (ReactImageView.kt:199-207); radius 0 → no processor | integer division |
| `Image source={{uri, headers}}` | Fresco request with the same `X-Session`/`X-Profile` headers | |
| `Animated.timing(duration, Easing.bezier(0.2,0.7,0.2,1))` | `ValueAnimator` + `PathInterpolator(0.2f, 0.7f, 0.2f, 1f)` | identical curve |
| `Easing.inOut(Easing.sin)` | `AccelerateDecelerateInterpolator` (both are `0.5 − 0.5·cos(πt)`) | identical |
| `Animated.timing` with **no easing** (Skeleton, trailer fades) | RN default is `Easing.inOut(Easing.ease)` = inOut of `cubic-bezier(0.42, 0, 1, 1)` → `PathInterpolator` of that composed curve | not linear |
| `Animated.spring {tension, friction}` | damped harmonic oscillator, **mass 1, stiffness = (tension−30)×3.62+194, damping = (friction−8)×3+25** (SpringConfig.js), closed-form solution per frame (SpringAnimation.js:284-319), frame delta capped 64 ms; rest when |Δx| < 0.001 **and** |v| < 0.001 | `androidx.dynamicanimation.SpringAnimation` with `SpringForce.setStiffness(k)` and `setDampingRatio(ζ = c / 2√k)`; retarget with `animateToFinalPosition` (keeps velocity, as RN's `Animated.spring` does when restarted on a moving value). Rest thresholds differ slightly (dynamicanimation stops at 1 px visible change by default) — set `setMinimumVisibleChange(0.001f)` to match. |
| `useNativeDriver: true` | all of the above are already native | no JS frame dependency to reproduce |
| `TVFocusGuideView trapFocus*` / `autoFocus` | `FrameLayout` overriding `focusSearch` to `FocusFinder.findNextFocus(this, …)` for trapped directions, and `requestFocus` → last focused child else first focusable | see §4.2 |
| `Pressable` on TV | focusable, clickable `View`; key-down starts the 500 ms long-press timer; key-up fires click unless long press fired | see §4.5 |
| `Text` | `TextView` with `Typeface.create(DEFAULT, weight, false)`, `includeFontPadding` left **true**, RN-style centred `LineHeightSpan`, `setLetterSpacing(dp/size)` | §3 |
| `zIndex` | `elevation`/`translationZ` or child order | Android draws in child order unless `elevation` differs; RN sorts by zIndex within a parent. |

**Things that cannot be made identical natively, and why**
1. **The 120 ms "focusJustMoved" races** (rail open, wrap, hero turn, Browse panel open) exist because the JS key-up event and the native focus move are separate events. Natively one key event does both, so these become deterministic; the literal "press held > 120 ms acts twice" edge case can only be reproduced by deliberately re-creating the timing rule (see §4.4 [KEEP-AS-IS?]).
2. **JS timer jitter**: the 9 s hero rotation, 4.5 s trailer hold, 25/50 s caps, 15 s hold, 600 ms disarm, 120 ms rescue are JS `setTimeout`s and drift with JS-thread load; native timers will be more exact, never less.
3. **Bitmap softness from the canvas scale** (§1) — reproducible only by deliberately fetching at `density × dp` rather than at the drawn pixel size.
4. **Spring rest thresholds** (0.001 dp displacement *and* velocity) — reproducible to within a frame.
5. **`react-native-svg` gradients** rasterise on the UI thread into software bitmaps per view (Card.tsx:51-58 explains why the shades were baked). A native shader is sharper at non-integer scales than the SVG bitmap of the same gradient — a difference below one level of 255 in practice.

---

## 9. Summary — what is hardest to reproduce 1:1 in this scope

The geometry, colours and curves are all literal and portable; the hard part is the **emergent behaviour of the focus/key layer**. Today the app runs two uncoordinated input paths — Android's focus engine moving focus on key-down, and react-native-tvos delivering `left/right/up/down` to JS on key-up only (with `longLeft`… while held) — and a dozen rules in `focus.ts`, `NavRail`, `Home` and `Browse` are tuned around that race (`focusJustMoved(120)`, `acceptTvEvent`'s 1500 ms down/up pairing, the 110 ms double-press swallow in `MainActivity`, the 120 ms focus-rescue, the 600 ms `hasTVPreferredFocus` disarm, `holdLeft` via `nextFocusLeft=self`, native-only traps that JS cannot see). A native rewrite will naturally *not* have the race, so to "behave exactly like today" it must choose between re-creating these timing windows literally (including their edge cases, flagged **[KEEP-AS-IS?]**) or accepting that some one-press-acts-twice situations disappear. Second hardest: the **row/hero motion model** — one retargetable critically-damped spring (stiffness 342.1, ζ≈0.998) for the shelf and the column, driven at key-repeat rate with mount work deferred off the input path — reproducible with `dynamicanimation` but easy to get subtly wrong (restart-vs-retarget, velocity carry, the 64 ms frame cap). Third: the **layered billboard** (two server-blurred JPEGs cross-faded on `atTop`, a black dim at 0.45/0.42, the precomposed `hero-scrim.png`, a `TextureView` trailer under the scrims, and the art fading on the column's own translation) — every layer is simple, but their stacking order, blend and timing all have to match.

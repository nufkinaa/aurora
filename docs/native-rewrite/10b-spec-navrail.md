# 10b · NavRail — 1:1 spec

Part of [10-spec-home-nav-cards.md](10-spec-home-nav-cards.md). Lines are of `tv-native/src/components/NavRail.tsx` (working tree, which includes the **uncommitted 5.1.29 edit**: mark 28/36 dp with a 4 dp nudge; HEAD 42bb208 has 34/40 and no nudge — flagged below). Sections referenced: `navSection.ts` for the item list.

The rail is mounted by every screen (`<NavRail active=… disabled=… />`, e.g. Home.tsx:1022, Browse.tsx:786) and is `position: absolute` over the page; it **never reflows content** (:12-15).

---

## 1. Items (`navSection.ts:25-41`, NavRail.tsx:59-76)

`NAV_SECTIONS` in order: `search` ("Search", icon `search` 18), `home` ("Home"), `movies` ("Movies"), `shows` ("Shows"), `list` ("My List"), `ai` ("AI"), `settings` ("Preferences", icon `gear` 19, `foot: true`). The rail's `ITEMS` = those (with `settings` relabelled **"Settings"** and `withLabel: true`, :68-73) + a final `profile` item (:74). `FOOT_FROM = 6` (index of settings) — a `flex: 1` spacer is inserted **before** item 6 (:76, :440-449), pushing Settings and the profile pill to the bottom.

Rendering rule per item (:577-588): an item with an `icon` and **no** `withLabel` draws **only the icon** (Search → a lone 18 dp magnifier, no word); otherwise a row `flexDirection row, alignItems center, gap 8` (:707) of optional icon + label + optional "new" dot. `dot` is `it.key === 'new' && newUnseen` (:414) but no item has key `'new'` any more → **the dot is never drawn [KEEP-AS-IS?]** (dead code since AI replaced New, navSection.ts:37-39).

---

## 2. Collapsed strip (always mounted; passive — nothing focusable)

* Container (`styles.strip`, :596-605): `position absolute, top 0, left 0, bottom 0, width 72, paddingTop 27 (PAD_Y), alignItems center, zIndex 100`, `pointerEvents none`; **opacity = 1 − slide** (:354-356), so it fades out as the panel arrives.
* **Scrim** (:460-474): an SVG the strip's size; `<Rect width=72 height=100%>` filled with a horizontal gradient `x1=0→x2=1`: `#080910` α **0.9** at 0 → `#080910` α **0** at 1.
* **Mark** (`styles.mark`, :678): `Image` `logo-mark.png` **28×28 dp**, `transform: [{translateX: 4}]` (optical centring over the dots; measured on the Mi TV, :675-677). *HEAD has 34×34 with no translate.* Asset: `logo-mark.png` 28 px, `@2x` 56, `@3x` 84, `@4x` 112 — the bare Beam mark on a transparent square, rendered from SVG by headless Chrome at 1024 and Lanczos-downscaled (`docs/brand/tools/build.py:282-285`, `TV_MARKS = (("logo-mark", 28), ("logo-mark-open", 36))`); RN picks the density file so the bitmap is never rescaled. Local resource → `fadeDuration` 0.
* **Dots** (`styles.dots`, :689): `marginTop 10, gap 8, alignItems center`; one per `NAV_SECTIONS` entry (**7** dots, including Preferences) (:359-363). Dot (:692): `width 5, height 5, borderRadius 999, backgroundColor rgba(255,255,255,0.3)`. Active (`dotOn`, :693): `height 16` (a 5×16 pill), `backgroundColor #ffffff`, `boxShadow '0 0 10px rgba(255,255,255,0.5)'`.

Layout on a 540-dp canvas: mark at y 27..55 (x 22+4 .. 50+4); dots start y 65; pitch 5+8 = 13 (active one is 16 tall).

---

## 3. Open panel (mounted only while `open`)

### 3.1 Container and body

* **panel** (:606-614): `position absolute, top 0, left 0, bottom 0, width 240 + 48 = 288, zIndex 101`; `transform translateX = slide ∈ [0,1] → [−288, 0]` (:370).
* **panelBody #1** (:374, :621-637): absolute `top 0, left 0, bottom 0, width 240`, `backgroundColor #0a0b14`, `experimental_backgroundImage: 'linear-gradient(165deg, rgba(104,86,226,0.20) 0%, rgba(10,11,20,0) 46%, rgba(70,200,150,0.12) 100%)'`, `overflow hidden`.
* **panelBody #2** (:377-379): the **same `styles.panelBody`** again (opaque colour + the same gradient) as an `Animated.View` with `opacity: slide`, containing `RailHues`. **[KEEP-AS-IS?]** at rest (`slide = 1`) the opaque `#0a0b14` + gradient is painted **twice**, so the gradient tint is effectively applied over itself (violet corner ≈ 1 − 0.8² = 0.36 effective α instead of 0.20; green foot ≈ 0.226 instead of 0.12). A 1:1 port must draw the body twice (or pre-compose the doubled tint).
* **RailHues** (:87-145) inside body #2, container `hues` (:639): absolute `top 0, left 0, bottom 0, width 240`, `pointerEvents none`, clipped by the body.
  * violet glow (`hueViolet`, :648): `Animated.Image glow.png`, `position absolute, top −150, left −170, width 440, height 440, tintColor #6856e2`, `fadeDuration 0`; `opacity = a: [0,1]→[0.26, 0.46]`; `translateX = a → [−14, 26]`; `translateY = b → [−10, 34]`; `scale = a → [1, 1.14]` (:113-123).
  * green glow (`hueGreen`, :649): `bottom −190, left −150, width 460, height 460, tintColor #46c896`; `opacity = b → [0.18, 0.36]`; `translateX = b → [22, −18]`; `translateY = a → [16, −30]`; `scale = b → [1.08, 0.96]` (:128-138).
  * drivers (:90-107): `a` loops `0→1` over **8000 ms** then `1→0` over 8000 ms; `b` **10500 ms** each way; both `Easing.inOut(Easing.sin)` (= `AccelerateDecelerateInterpolator`), native driver. **Not started when `isLite()`** (:91) — values stay at 0.
  * `glow.png` (gen_ambient.py:216-226): 96×96 white, `alpha = (1 − smoothstep(d))^1.6` with `d = min(1, 2·dist_from_centre_normalised)`.
  * **huesEdge** (:142, :640-647): absolute `top 0, right 0, bottom 0, width round(240 × 0.5) = 120`, gradient `90deg, rgba(10,11,20,0) 0% → rgba(10,11,20,1) 100%` — brings the right edge back to the body colour so the feather has no seam.
* **Feather** (:380-389, :650-656): SVG absolute `top 0, bottom 0, left 240, width 48, height 100%`; `<Rect 48×100%>` horizontal gradient `#0a0b14`: α **1** @0, **0.55** @0.45, **0** @1.

### 3.2 Content (`panelInner`, :394-451, :659-666)

`TVFocusGuideView autoFocus trapFocusLeft trapFocusRight trapFocusUp trapFocusDown`, style `flex 1, width 240, paddingLeft 48, paddingRight 16, paddingVertical 27, gap 4`.

1. **Logo row** (`styles.logo`, :682): `flexDirection row, alignItems center, gap 10, marginBottom 10`, not focusable. Mark `Image logo-mark-open.png` with `[styles.mark, styles.markOpen]` → **36×36 dp** (`markOpen`, :679) **and still `translateX 4` inherited from `styles.mark`** (markOpen does not reset the transform) **[KEEP-AS-IS?]**. Asset 36/72/108/144 px. Wordmark Text "Aurora" (:685): `color #f3f4f8, fontSize 23, fontWeight 800, letterSpacing 0.4`.
2. **Items** in `ITEMS` order with the spacer before index 6 (see §1).

### 3.3 `NavItem` (non-profile) (:481-591)

`Focusable round light highlightColor=#ffffff edgeLeft` (:555-576), `accessibilityLabel=label`, `hasTVPreferredFocus = (key === active)`, `focusDisabled = closing`.

* Style (`item`, :696-703): `alignSelf stretch, minHeight 48, justifyContent center, paddingVertical 8, paddingHorizontal 16, backgroundColor transparent`; `on && !focused` → `backgroundColor rgba(255,255,255,0.06)` (`itemOn`, :705). (Plus the Focusable's 3 dp reserved border around it.)
* Foreground colour `fg` (:553): focused → `#0b0c14`; else active → `#f3f4f8`; else `rgba(255,255,255,0.92)`.
* Label (`itemText`, :706): `fontSize 15, fontWeight 600`, 1 line; when **not focused** also `itemTextLift` (:712-716): `textShadowColor rgba(8,9,16,0.9), offset (0,1), radius 6`.
* Icon colour = `fg`, size `iconSize || 18`.
* new dot (never drawn, see §1): `7×7, radius 4, #8b7bff`; on light `#6c58ff` (:708-709).

States: **default** transparent bg, 0.92-white text with cast shadow; **active (`on`)** `surface` bg, pure white text; **focused** → the `highlightColor` white fill fades in (160 ms) under the content, text flips to `#0b0c14`, shadow dropped, light ring: 3 dp `#0b0c14` gap + 4 dp **white** ring + halo; scale 1.055.

### 3.4 Profile pill (:519-547)

`Focusable round edgeLeft` with the **default white 3 dp ring** (not light, :517-518), `accessibilityLabel = name`.
* Style (`profile`, :719-729): `alignSelf stretch, minHeight 48, flexDirection row, alignItems center, gap 10, paddingVertical 5, paddingLeft 6, paddingRight 14, backgroundColor rgba(255,255,255,0.06)`.
* Avatar (`avatar`, :731): `30×30, borderRadius 999, alignItems/justifyContent center, backgroundColor = profile.color || rgba(255,255,255,0.11)`; inside either `Image` (profile `avatarImage`, `resizeMode cover`, `fadeDuration 0`, `width/height 100%, borderRadius 999`, :733) or a Text glyph `fontSize 16` = `me.avatar || '🍿'` (:416, :732).
* Name (`profileName`, :735): `color #f3f4f8, fontSize 14, fontWeight 600, flexShrink 1`, 1 line; text = `me.name || 'Profile'`, or **"Press again"** while `confirmSwitch` (:419-425).

---

## 4. Animations

| | property | from → to | duration / curve | trigger |
|---|---|---|---|---|
| open | `slide` | 0 → 1 (panel `translateX` −288→0, strip opacity 1→0, body #2 opacity 0→1) | **280 ms** (`motion.med`), `bezier(0.2,0.7,0.2,1)` (:236-242) | `open && !closing` becomes true |
| close | `slide` | 1 → 0 | 280 ms, same curve (:202-212); on completion `closing=false, open=false` (panel unmounts) | `close()` |
| instant close | `slide.setValue(0)`, panel unmounted immediately (:217-222) | | | navigating from an item (:344), screen losing liveness while open (:311-316) |
| hues | see §3.1 | | 8 s / 10.5 s half-cycles | while panel mounted, non-lite |

During **close**, before the slide starts: `restore.current()` hands focus back to the page element captured on open (:199-201), and every row gets `focusDisabled` (`closing`) so Android cannot focus-search back into the departing panel (:164-170, :415).

---

## 5. Focus and keys (`onTV`, :245-291; via `useTVKeys(onTV, {deaf: disabled})`, :294)

Closed:
* `left` **and** `atLeftEdge()` **and** `!focusJustMoved(120)` → `restore = captureFocus(); setOpen(true)` (:265-268). Anything else ignored. (`atLeftEdge()` is whatever the focused `Focusable` declared with `edgeLeft`; it starts `true` on a screen where nothing has focused yet.)
* Also opened by `requestRailOpen()` from a screen handler (Home's hero: UP from any hero button, LEFT from the first) — the rail registers `setRailOpener` while live, closed and enabled (:298-306).

Open:
* `right` → `close()` (:273-276).
* `up` with `at === 0` → focus wraps to the **last** item (profile pill); `down` with `at === last` → wraps to item 0 (Search) — **not** if `focusJustMoved(120)` (:286-288). Within the list, UP/DOWN are the native focus engine's (trapped inside the guide).
* `left` → nothing (every item is `edgeLeft`; the guide traps LEFT) (:559-561).
* **BACK** → `close()`, consumed (:319-326).
* OK on a section → `instantClose()` (no focus restore — the screen is being left), then `goSection` (popToTop + push; pressing the section already on screen does nothing but close) (:332-348, navSection.ts:101-120).
* OK on the profile pill: first press **arms** (label → "Press again", **4000 ms** window, :333-339); second press within the window → `switchProfile()`; focus moving to any other item disarms (:434-435).
* On open, focus goes to the **active section's item** (`hasTVPreferredFocus = claimFocus = key === active`, :427) — the guide's `autoFocus` alone would not claim it (:390-393).
* While open, `noteRail(true)` (:227-231) → Home stops any trailer (10d-spec §6) and per-screen handlers (Browse's RIGHT) check `railOpen()`.
* `disabled` (a modal/panel owns the screen): the component returns **null — not even the collapsed strip is drawn** (:328-330).

---

## 6. Native mapping notes

* The strip and panel are two overlays in the Activity's root `FrameLayout` (`elevation` 100/101 above page content), `clipChildren=false` on the root so the feather and shadows draw.
* Scrim/feather: `android.graphics.LinearGradient` shaders with the stops above (objectBoundingBox → view bounds).
* Body gradient: CSS-angle linear gradient (10-spec §8). Draw the body twice to keep today's doubled tint, or pre-compose — owner's call per the [KEEP-AS-IS?].
* Hues: two `ImageView`s with `glow.png`, `setColorFilter(tint, SRC_IN)`, driven by two `ValueAnimator`s (8000/10500 ms, `REVERSE`, `AccelerateDecelerateInterpolator`, infinite), updating alpha/translation/scale per the interpolations; skip on lite.
* Panel slide: `ValueAnimator` 280 ms `PathInterpolator(0.2,0.7,0.2,1)` driving `translationX` of the panel, alpha of the strip (1 − t) and of body #2 (t).
* Focus trap: a `FrameLayout` whose `focusSearch` confines all four directions; on open call `requestFocus()` on the active item; record focus for the wrap logic; implement wrap on the UP/DOWN key-up at the ends (only if the key-down did not itself move focus).
* Mark: `ImageView` with the density-matched PNG, `translationX = 4dp` in both states (keep-as-is) — or none if the owner drops the inherited nudge for the open mark.
* Text shadow on labels: `setShadowLayer(6, 0, 1, 0xE6080910)` (α 0.9) when not focused.

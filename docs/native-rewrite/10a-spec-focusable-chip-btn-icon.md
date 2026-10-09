# 10a · Focusable, Chip, Btn, Icon, MiniSpinner, Skeleton, Empty/ErrorState — 1:1 spec

Part of [10-spec-home-nav-cards.md](10-spec-home-nav-cards.md). Lines are of the working-tree files under `tv-native/src/components/`. Combined cat outputs: `Chip.tsx` lines are as printed (1-120); `Icon.tsx` printed n → file line n − 120; `Btn.tsx` as printed (1-146); `Skeleton.tsx` n − 146; `States.tsx` n − 223; `MiniSpinner.tsx` n − 316.

---

## 1. `Focusable` (`Focusable.tsx`) — the one focus primitive

An `Animated.createAnimatedComponent(Pressable)` (:31) carrying two natively-driven `Animated.Value`s: `anim` (ring/highlight/overlay opacity, timing) and `springAnim` (scale + lift, spring) (:195-200).

### 1.1 Geometry

* **Base style** (`styles.base`, :461-465): `borderWidth: 3`, `borderColor: 'transparent'`, `borderRadius: 12`. The 3 dp transparent border is **layout** — it reserves the ring's thickness so focusing never reflows neighbours (:459-460). Every Focusable's content box is therefore inset 3 dp from the element's layout box.
* `round` → `borderRadius: 999` (:281, :369). The caller's `style` is applied after, so its `borderRadius` wins; `ringRadius = flattened borderRadius ?? 12` (:279-284).
* **Ring** (`styles.ring`, :475-488): absolute, **inset 0** (over the reserved border), `borderWidth: 3`, `borderColor: rgba(255,255,255,0.95)`, `borderRadius: ringRadius`, `boxShadow: '0 10px 24px rgba(0,0,0,0.5)'`, `opacity: anim`. Props may override: `ringWidth` (a Card passes 2 — the 2 dp ring then sits inside the 3 dp reserved border, nothing reflows, :132-136), `ringColor`, `shadow` (Card passes `0 18px 36px rgba(0,0,0,0.6)`), `ring='violet'` → `#8b7bff`, `ring='none'` → no ring view at all (:430, :53-57).
* **Light variant** (`light` prop; used by `Btn primary`, `Chip on`, `NavItem`) — two extra absolute views **outside** the box, both at `opacity: anim`:
  * gap (`styles.lightGap`, :497-505): inset **−3** on all sides, `borderWidth: 3`, `borderColor: #0b0c14` (`colors.bg`), `borderRadius: ringRadius + 3`;
  * ring (`styles.lightRing`, :506-515): inset **−7** (`LIGHT_GAP 3 + LIGHT_RING 4`; `LIGHT_RING = focus.borderWidth + 1 = 4`, :48-49), `borderWidth: 4`, `borderRadius: ringRadius + 7`, `borderColor` = `RING_COLOR[ring]` (white unless `ring='violet'`; `'none'` falls back to white, :425), `boxShadow: '0 10px 24px rgba(0,0,0,0.5)'`.
  * So a focused light element shows, from inside out: its own fill → 3 dp page-colour gap → 4 dp ring (white or violet) with the halo shadow. The parent must not clip (10-spec §8).
* **Highlight** (`highlightColor` prop, :375-387): absolute fill, `backgroundColor: highlightColor`, `borderRadius: ringRadius`, `opacity: anim`, drawn **under** children.
* **Focus overlay** (`focusOverlay` prop, :389-393): absolute fill at `opacity: anim`, drawn **over** children, `pointerEvents none`.

### 1.2 Animations

| what | from → to | driver | trigger |
|---|---|---|---|
| `anim` (ring, gap, light ring, highlight, overlay opacity) | 0 → 1 | `Animated.timing`, **160 ms**, `Easing.bezier(0.2,0.7,0.2,1)` (:323-329) | onFocus |
| `anim` | 1 → 0 | same 160 ms timing (:344-350; also :241-247 when another element claims the ring) | onBlur, or another Focusable gaining focus (`claimRing`) |
| `springAnim` | 0 → 1 | `Animated.spring` **tension 180, friction 14, restDisplacementThreshold 0.001** (restSpeedThreshold default 0.001) (:330-335) → stiffness 737, damping 43, mass 1, ζ ≈ 0.792, ω₀ ≈ 27.1 rad/s; first peak overshoot ≈ 1.7 % of the step | onFocus |
| `springAnim` | 1 → 0 | same spring (:351-356, :248-253) | onBlur / claim |
| `scale` | `springAnim` interpolated `[0,1,2] → [1, s, 2s−1]` where `s = scaleTo ?? 1.055` (:286-290) — linear, so the spring's overshoot continues past `s` | transform on the Pressable unless `noScale` |
| `translateY` | `[0,1,2] → [0, −lift, −2·lift]` when `lift` set (:293-295) | same spring; transform order `[{scale}, {translateY}]` (:372) |

All animations use `isInteraction: false`, `useNativeDriver: true`. **Fade-outs animate, they never snap** (:234-247).

### 1.3 "Only one ring" registry (:59-78, :232-263)

Each instance has an id; `claimRing(id)` on focus runs the previously lit instance's clear (its fade-out) so at most one ring is lit even if Android drops a blur event. On unmount: `releaseRing`, and `noteFocusLost(lastNode)` (the **last real** host node, since React nulls the ref before cleanup, :207-214, :255-262).

### 1.4 Props → behaviour

* `hasTVPreferredFocus`: forwarded as `wantsFocus = prop && !disarmed`; disarmed on first focus (:339) or after **600 ms** (:272-276), so Fabric can never yank focus back later (react-native-tvos#670).
* `focusDisabled`: `focusable: false, isTVSelectable: false` (:300).
* `holdLeft`: on ref attach `findNodeHandle(self)` → `nextFocusLeft: selfTag` (:217-225, :301). Pair with `edgeLeft`.
* `edgeLeft` / `edgeRight`: written to `focus.ts` on **every** focus via `noteFocus(node, !!edgeLeft, !!edgeRight)` (:308).
* `onLongPress`: Pressable long press = **500 ms** hold of OK (10-spec §4.5); the ring registry is untouched (:144-148).
* `onFocusChange(bool)` is called after the animations are started (:340, :357).
* `accessibilityLabel` forwarded (:303).

### 1.5 States

| state | ring/gap/light ring opacity | scale | highlight/overlay |
|---|---|---|---|
| default | 0 | 1 | 0 |
| focused | 1 (after 160 ms) | `scaleTo` (spring, ~1.7 % overshoot), lifted `−lift` | 1 |
| pressed | **no visual change** — Focusable has no pressed style; `Btn`/`NavItem` hold their own `focused` React state only | | |
| disabled | not a prop here (`focusDisabled` only removes it from the D-pad; it draws exactly as default) | | |

### 1.6 Native mapping

* One `FrameLayout` subclass per Focusable: padding 3 dp (the reserved border), `clipChildren=false`, `clipToPadding=false`; a ring `Drawable` (stroke 3 or `ringWidth`, colour, radius, box-shadow with σ = 12 px/2 … per 10-spec §8) at `alpha = anim`; `setScaleX/Y` and `translationY` from a `SpringAnimation` (stiffness 737, ζ 0.792) on a 0..1 progress; `ValueAnimator` 160 ms `PathInterpolator(0.2,0.7,0.2,1)` for alpha. Light variant: two extra drawables at −3 and −7 dp insets. Keep a process-wide "lit" owner and fade the previous one on focus.
* `exported`: `focusRing` style object (:453-456) = `{borderWidth: 3, borderColor: rgba(255,255,255,0.95)}` for the rare non-Pressable ring.

---

## 2. `Chip` (`Chip.tsx`)

A `Focusable round` (:50-75) with `light={on}` (:55) and `ring = on && small ? 'violet' : 'white'` (:61). `edgeLeft`, `hasTVPreferredFocus`, `onFocusChange` forwarded.

| variant | style | text |
|---|---|---|
| `bare` (`.cat-pill`, Browse categories) | `minHeight 48, justifyContent center, paddingVertical 9, paddingHorizontal 18, borderRadius 999, backgroundColor transparent` (:81-88) | `color #616880 (textFaint), fontSize 16, fontWeight 800` (:117); 1 line |
| surface (default; Unwatched, AI chips) | `minHeight 48, pv 8, ph 16, radius 999, backgroundColor rgba(255,255,255,0.06)` (:90-97) **plus** an absolute `edge` child: inset 0, `borderWidth 1`, `borderColor rgba(255,255,255,0.09)`, radius 999 (:98-107) — drawn only when `!bare && !on` (:71) | `color #f3f4f8, fontSize 16, fontWeight 700` (:118) |
| `small` (surface only in practice) | `+ minHeight 36, pv 6, ph 13` (:108) | surface text `fontSize 14` (:110); a bare+small keeps 16 |
| `on` (selected) | `backgroundColor #ffffff` (:111); bare+on also `boxShadow: '0 4px 14px rgba(0,0,0,0.35)'` (:114) | `color #0b0c14` (:119) |

Selected and focused are independent: a selected chip stays white while focused and gains the light ring (white, or violet when `small`).

Note the Focusable base adds its 3 dp transparent border **outside** these paddings (so a bare chip's layout height is ≥ 54 dp: 48 min + 2×3 border). This applies to every Focusable in the app; measure accordingly.

---

## 3. `Btn` (`Btn.tsx`)

`Focusable round`, `light={primary}`, `ring = primary ? 'violet' : 'white'` (:63-68). Holds a `focused` React state to drop its rest hairline while focused (:61, :89).

* **Layout** (`styles.btn`, :114-123): `flexDirection row, alignItems center, justifyContent center, gap 8, paddingVertical 9, paddingHorizontal 20, minHeight 40, borderRadius 999`. (The header comment's "minHeight 48" is stale; the code says **40**.) **[KEEP-AS-IS?]** comment/code mismatch only.
* `small` (:126): `paddingVertical 7, paddingHorizontal 14, minHeight 34`.
* **Surface** (default) (:127): `backgroundColor rgba(255,255,255,0.06)`; rest hairline child (:131-140): absolute inset 0, `borderWidth 1, borderColor rgba(255,255,255,0.07), radius 999`, present only while **not** focused and not primary (:89).
* **Primary** (:130): `backgroundColor #ffffff`, `boxShadow '0 8px 24px rgba(0,0,0,0.38)'`, plus an SVG child filling the box: `<Rect rx=999>` filled with a vertical `LinearGradient` `#ffffff` (0) → `#eceef7` (1) (:79-88).
* **Children order**: `leading` node (:90), `Icon` 18 dp (colour `#0b0c14` on primary else `#f3f4f8`, :91-93), `glyph` Text (emoji, styled like the label, :96-98), label Text 1 line (:99-108).
* **Label** (:142): `color #f3f4f8, fontSize 15, lineHeight 22, fontWeight 700, letterSpacing 0.16`; `small` → `fontSize 13, lineHeight 19` (:143); primary → `color #0b0c14` (:144); `dim` → `color #9aa1b5` (:145).
* **Focus**: non-primary → white 3 dp ring at inset 0 + halo; primary → light variant (3 dp `#0b0c14` gap, 4 dp **violet `#8b7bff`** ring) — "the ONLY violet focus treatment in the app" (:43-44). Scale 1.055 (default), no lift.

---

## 4. `Icon` (`Icon.tsx`; printed n → n − 120)

`<Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>` (:49-53 → printed 169-173), default `size 24`, default `color #ffffff`. Glyph `d` strings are the site's `public/js/ui.js` paths verbatim — **copy them byte-for-byte from `Icon.tsx:58-191` (printed 178-311)** into `VectorDrawable`s (same 24×24 viewport). Specials:
* `gear`: wrapped in `<G translateX={-1}>` (printed 297) — optical centring.
* `volumeOff`: `<G scale={0.92}>` (printed 307).
* `forward10` / `back10`: an SVG `<text x=8.2 y=15.5 fontSize=7.5 fontWeight=800>10</text>` inside the arrow (printed 264-266, 273-275) — native: draw "10" with `Paint.setTextSize(7.5/24 × size)` bold at that position.
* `xray` uses `fillRule="evenodd"` (printed 186).

Icons in this scope: `search` 18 dp (rail), `gear` 19 dp (rail), `play` 18, `info` 18 (hero buttons), `film`/`series` 11 dp (card kind tag).

**Native mapping:** `VectorDrawable` per glyph, `android:tint` = colour; identical geometry.

---

## 5. `MiniSpinner` (`MiniSpinner.tsx`; printed n → n − 316)

`size` default **18**; `Animated.View` `width/height size, borderRadius size/2, borderWidth 2, borderColor rgba(255,255,255,0.2), borderTopColor #ffffff` rotating `0deg → 360deg` every **800 ms, linear**, looped (printed 327-353). Native: `RotateAnimation` 800 ms `LinearInterpolator` on a ring drawable with one white quadrant.

---

## 6. `Skeleton` (`Skeleton.tsx`; printed n → n − 146)

Default `width 124, height 186, round 12` (printed 165-167). Box: `overflow hidden, backgroundColor rgba(255,255,255,0.05)` (printed 222). Inside, an `Animated.View` **2× the width**, `translateX` `0 → −2·width`, **1400 ms**, looped, **default easing** (`Easing.inOut(Easing.ease)` — not linear) (printed 174-185, 193-200). It holds an SVG gradient `x1=0 y1=0 x2=1 y2=0.176` (100°, `TILT = 0.176`, printed 162) with stops: 0.20 white α .05, 0.25 α .10, 0.30 α .05, 0.70 α .05, 0.75 α .10, 0.80 α .05 (printed 206-211).

---

## 7. `Empty` and `ErrorState` (`States.tsx`; printed n → n − 223)

Both register their button as the screen's focus fallback and give it `hasTVPreferredFocus` and `edgeLeft` (default true) (printed 261-267, 287-294).

* Wrap (printed 303-309): `alignItems center, justifyContent center, paddingVertical 45, paddingHorizontal 48, gap 14`.
* Glyph Text (printed 312): `fontSize 35, marginBottom −2` — `Empty` shows the caller's emoji, `ErrorState` shows `⚠️`.
* `message` (printed 313): `color #9aa1b5, fontSize 16, textAlign center` — `Empty`'s message, `ErrorState`'s optional `detail`.
* `error` (printed 315): `color #ff7a7a, fontSize 16, fontWeight 700, textAlign center` — `ErrorState`'s `message`.
* The action: a default (surface) `Btn` labelled `actionLabel` (`ErrorState` default `'Retry'`).

# 10c · Card and Row — 1:1 spec

Part of [10-spec-home-nav-cards.md](10-spec-home-nav-cards.md). Lines are of `tv-native/src/components/Card.tsx` and `Row.tsx` (working tree = HEAD for these files). Asset recipes: `tv-native/tools/gen_ambient.py`.

---

## 1. Card variants and sizes (Card.tsx:33-49, 79)

| variant | prop | box (w×h dp) | picture dp asked (`artDp`) | used by |
|---|---|---|---|---|
| poster | (default) | **124 × 186** `CARD_W/H` | 124 → 256 px @2× | Home rows, Browse/MyList/Search grids, Detail "similar" |
| compact poster | `compact` | **116 × 174** `COMPACT_W/H` | 116 → 240 px | AI page (`Pick.tsx:286`) |
| wide (landscape) | `wide`, or **any episode** (`item.showId && item.type !== 'show'`, :143-144) | **176 × 99** `WIDE_W/H` | 176 → 352 px | episode cards in rows |
| frame | `frame` (Continue Watching: Home passes `wide` **and** `frame`, Row.tsx:169-170) | **224 × 140** `FRAME_W/H` | backdrop/still: `FRAME_ART_W = ceil(140×16/9) = 249` → 640 px; poster fallback: 224 → 448 px (:162-170) | Continue Watching |

Style per variant (:467-470): `width, height, borderRadius 12, backgroundColor #131523 (bgRaised), borderWidth 1, borderColor rgba(226,229,238,0.3)` — the hairline edge is the card's own border, inside the radius. No `overflow: hidden` (:462-463). Remember the enclosing Focusable adds a 3 dp transparent border outside this box (10a-spec §1.1), so the **slot** a card occupies is `(w+6) × (h+6)` with the picture box at offset 3.

Inner picture (`styles.poster`, :471): `width/height 100%, borderRadius 11` (`radius.m − 1`, inside the 1 dp border).

### 1.1 Focus treatment (the Focusable props, :301-320)

`scaleTo 1.055`, `lift 3` (translateY −3 at focus), `ringWidth 2`, `ringColor rgba(255,255,255,0.9)`, `shadow '0 18px 36px rgba(0,0,0,0.6)'` — the 2 dp ring sits at inset 0 of the Focusable (i.e. **1 dp outside the card's own hairline**, within the reserved 3 dp). No `light`. Spring/timing per 10a-spec §1.2.

`focusOverlay` (fades in with the ring, :321-340):
1. `brighten` (:495-504): absolute fill, `#ffffff` at **opacity 0.055**, radius 12 (stands in for CSS `brightness()`).
2. when the card has **no permanent label** (`!showLabel`): a `Shade` (card-shade-v.png) — a poster gains the foot shade only on focus (:328-331).
3. when `onRemove` is set (Continue Watching): the ✕ badge (:334-338, :561-572): absolute `top 6, right 6, 30×30, borderRadius 15, backgroundColor rgba(0,0,0,0.65)`, centred Text `✕` `color #f3f4f8, fontSize 15, fontWeight 800`. Drawn, never focusable.

### 1.2 Picture selection (`picture`, :150-157)

* `canFrame = frame && progress.position > 20 && item.id && !id.startsWith('torrent|')` (:154) → `/img/frame/<id>?t=<floor(position)>` (a server-cut still; **unsized**, `resizeMethod 'resize'`).
* else frame card & not episode & `item.backdrop` → backdrop; else `item.cover || item.poster`.
* Sized URL: `artPath(picture, artPx(artDp))` (:171) or the plain path when unsizable (frames, non-proxied hosts). `resizeMethod` = `'auto'` when sized or showing the sized backup, else `'resize'` (:357). `fadeDuration 0` (:358). `resizeMode cover`.

### 1.3 Blur-up placeholder (:255-264, :342-345)

`blur = blurOf(rawPath)` where rawPath = `backdrop || cover || poster` for `canFrame`, else the same path rule as the picture (:255-257). Shown (`showBlur`) when a blur exists, `src` exists, not `broken`, the real picture has not loaded yet (`loadedUri !== src.uri`) and `!wasDrawn(src.uri)` (:259). Drawn **under** the picture: `Image {uri: dataUri}`, `styles.blur` absolute inset 0, `borderRadius 11`, `resizeMode cover`, **`blurRadius 1`** (`BLUR_RADIUS = 1`, :27 → IterativeBoxBlur(2, (int)(1×density)/2) = 1 px @2×), `fadeDuration 0`. On the picture's `onLoad`: `markDrawn(uri)`, then one state change removes the placeholder (:260-264).

### 1.4 Failure → retry → tile → park (:173-245)

Per address `src.uri` (a new picture restarts the sequence):

| event | what is shown next | when |
|---|---|---|
| 1st `onError` | same URL + `r=1` (`?r=1` or `&r=1`) | after **1500 ms** (:244) — and the failure is reported once via `trackError('image <shape>: <error>')` where shape = path without host, `u=…` reduced, 12-char `/img/<id>` collapsed, ≤ 60 chars (:226-229) |
| 2nd `onError` | **backup poster** `/img/poster/<imdbId>?type=movie|show[&t=<title ≤80>][&y=<year>]` sized to `artDp` — only when `item.imdbId` matches `^tt\d+$` and not `canFrame` (:203-209) | **immediately** (`n === 2 ? 0 : 1500`, :244) |
| `tries ≥ TILE_AT` (`TILE_AT = backup ? 3 : 2`, :210) | the **titled tile** (`broken`) | and a "round" timer starts: **30 s, 120 s, 480 s** (`ROUND_MS`, :86) → at expiry the card goes back to the first address |
| after the 3rd round fails | **parked**: tile stays, no more requests | until the realtime socket's `welcome` message (server back) resets the rounds (:195-202) or the card remounts |

**Titled tile** (`.card-fallback`, :363-380, :481-493): the `poster` box with an SVG `<Rect rx=12>` filled by a `LinearGradient x1=0 y1=0 x2=0.34 y2=0.94` (≈160°) `#1b1d31` → `#101120`; centred Text `item.title` `color #9aa1b5, fontSize 14, fontWeight 700, textAlign center`, **3 lines**, `padding 10`. Also used while there is no `src` at all.

---

## 2. Shades (baked PNGs, 8×256, `resizeMode stretch`, `fadeDuration 0`, style `shade`: absolute `top 0, left 0, width/height 100%, borderRadius 12`, :61-72, :473)

Alpha is sampled at each texel's centre and **linear between stops** (gen_ambient.py:341-363); colour `#05060c` `(5,6,12)`. Offsets are measured from the card's **foot** (0 = bottom, 1 = top):

* `card-shade-v.png` (`Shade`): α **0.92 @0 → 0 @0.45**, clear above.
* `card-frame-shade.png` (`FrameShade`): α **0.95 @0, 0.72 @0.24, 0.18 @0.52, 0 @0.68**, clear above.

When drawn (:383): a card with a permanent label (`showLabel`) draws its shade at rest — `FrameShade` for a frame card, `Shade` otherwise; a card without a label gets `Shade` only in the focus overlay (§1.1).

`showLabel = !hideLabel && (landscape || item.upNext)` (:265) — posters carry **no text** unless they are the synthesised "up next" entry.

**Native:** ship both PNGs, draw FIT_XY in a rounded (12 dp) clip — or draw the exact linear ramps with a `LinearGradient` shader using the same stops (the PNG *is* the ramp; a shader is the same picture to within one level).

---

## 3. Labels

### 3.1 Wide / episode / up-next label (:403-420, :509-527)

Container `label`: absolute `left 8, right 8, bottom 7`; **`bottom 14`** when a progress bar is present (`labelRaised`, :511). `pointerEvents none`.
* Episode: `labelSub` = `item.showTitle` (`color #9aa1b5, fontSize 14, fontWeight 600, textShadow rgba(0,0,0,0.8) (0,1) r6`) then `labelText` = `S{season} E{episode} · {title}` (`color #f3f4f8, fontSize 14, fontWeight 700, same shadow`); both 1 line, tail ellipsis.
* Otherwise one `labelText` line = `item.title`.

### 3.2 Frame card label (:389-402, :476-479)

Container `frameLabel`: absolute `left 11, right 11, bottom 17`.
* `frameTitle`: `color #f3f4f8, fontSize 17, fontWeight 800, letterSpacing −0.2, lineHeight 20, textShadow rgba(0,0,0,0.6) (0,1) r10`; text = episode ? `showTitle || title` : `title`; 1 line, tail.
* episode only: `frameSub` `color rgba(243,244,248,0.84), fontSize 13, fontWeight 600, marginTop 1` = `S{season} E{episode} · {title}`; 1 line.
* `frameMeta` (when `left`): `color rgba(243,244,248,0.8), fontSize 13, fontWeight 600, marginTop 3`; text `▶  {N} min left` (two spaces), `N = max(1, round((duration − position)/60))` (:267-270), only when `pct != null && duration > 0`.

---

## 4. Tags (:283-298, :422-446, :532-555)

Base `tag`: absolute `top 7, paddingVertical 2, paddingHorizontal 6, borderRadius 5, backgroundColor rgba(6,8,16,0.72), borderWidth 1, borderColor rgba(255,255,255,0.16)`; `tagText` `color #cbd2e6, fontSize 14, fontWeight 900, letterSpacing 1.68` (base only — see NEW).

* **NEW** (left corner, `tagLeft`: `left 7, maxWidth 81`): drawn when `item.addedAt` is within **7 days** and the item has **no** `progress` object (:283-284, `NEW_WINDOW_MS`). Overrides: `tagNew` `backgroundColor #6c58ff, borderColor transparent, paddingVertical 1, paddingHorizontal 5, borderRadius 4`; text "NEW" `color #ffffff, fontSize 11, letterSpacing 1.2` (weight 900 inherited) (:550-551). NEW is the only left-corner tag (the STREAM pill is gone, :293-295).
* **Kind** (right corner, `tagKind`: `right 7, flexDirection row, alignItems center`): drawn when `showKind && !landscape && !onRemove` (:298) — i.e. **posters in Home's mixed rows**, never on wide/frame cards, never beside the ✕. Icon-only: `Icon film|series` **11 dp** in `#f0c67e` / `#7fd1e8`; border colour `rgba(240,198,126,0.32)` (film) / `rgba(127,209,232,0.32)` (series) (:554-555). The base fill/padding/radius 5 apply.

---

## 5. Progress bar (:146-149, :448-454, :577-608)

`pct = min(100, round(position/duration × 100))` when `progress` exists, `duration > 0` and `!finished`; else none.
* Track `progress`: absolute `left 8, right 8, bottom 6, height 4, borderRadius 2, backgroundColor rgba(255,255,255,0.25), overflow hidden`. Frame card (`progressFrame`, :480): `left 11, right 11, bottom 9, height 3`.
* Fill `progressFill`: `height 100%, borderRadius 2, backgroundColor #8cffbe, experimental_backgroundImage 'linear-gradient(90deg, #8b7bff, #7fd1e8, #8cffbe)', boxShadow '0 0 10px rgba(140,255,190,0.55)'`, `width: pct%`.
* Head `progressHead`: absolute `right −3, top −2, 8×8, borderRadius 4, backgroundColor #ffffff, boxShadow '0 0 8px rgba(255,255,255,0.9)'` — **but the track has `overflow hidden`**, so the bead is clipped to the track's 4 dp (3 dp on frame) height and its right 3 dp are cut at 100 % **[KEEP-AS-IS?]** (the glow is also clipped).

---

## 6. Behaviour

* `onPress(item)` → the row/grid's handler (Home/Browse: open the title page; hero Play is elsewhere). Fires on OK **release** (10-spec §4.5).
* **Hold OK (500 ms)** → `openPeek(item, onRemove)` (:319): the app-wide peek sheet (`Overlays.tsx:67-200`, `Sheet.tsx`) — summarised here because the card owns the gesture:
  * `Sheet` backdrop: absolute fill `rgba(5,6,12,0.72)`, `zIndex/elevation 500`, centred, `padding 48` (Sheet.tsx:64-76); card `width 720` (PeekSheet, Overlays.tsx:160) with `glass` = `backgroundColor rgba(19,21,34,0.97), borderWidth 1, borderColor rgba(255,255,255,0.10), borderTopColor rgba(255,255,255,0.22), boxShadow '0 30px 80px rgba(0,0,0,0.6)'`, `borderRadius 22, padding 32, maxWidth/maxHeight 92%` (Sheet.tsx:54-61, 77-83); focus trapped (`useKeyTrap(true)` + guide traps), BACK closes.
  * Row `gap 20`: art box `256×144, radius 12, bg #131523, overflow hidden` with `artSrc(backdrop||cover||poster, 256)` cover and, when mid-way, a 4 dp bar `rgba(255,255,255,0.2)` with fill `#8b7bff` at `pct%` (Overlays.tsx:954-958); text column: title `24 dp 900 ls −0.5` 2 lines, sub `13 dp 700 textDim mt 4` (`year · Series|Film` or `showTitle · S E`), `peekLeft` `13 dp 700 #8b7bff` = `{pct}% watched · {N min|Nh Mm} left`, synopsis `15 dp lh 23 textDim mt 8` 4 lines (:960-963). Actions: Primary `▶  Play`/`▶  Open`, Ghost `Details`, Ghost `+  My List`/`✓  In My List`, and `Remove from Continue Watching` when `onRemove` (Overlays.tsx:183-199).
  * The release after a long press does **not** also fire `onPress` (Pressability swallows it).
* `onFocus(item, index)` on focus gain only (:320) — the row slides, Home scrolls, prefetch warms the title.
* `edgeLeft` (first card of a row / column 0), `holdLeft` (Detail's similar row), `edgeRight` (last grid column) forwarded to the Focusable.
* `hasTVPreferredFocus` forwarded (grid first-fill claim).
* `React.memo(Card)` (:459): props must stay referentially stable — a native port has no equivalent concern, but note that a card **never re-renders on focus**; only the fail/blur state changes touch it.

---

## 7. `Row` (`Row.tsx`) — the sliding shelf

### 7.1 Geometry

* `row` (:195): `marginTop 8`.
* Title (`title`, :196-205): `color #f3f4f8, fontSize 18 (fontSize.row), fontWeight 800, marginBottom 7, paddingLeft 84, paddingRight 48`.
* Viewport (`TVFocusGuideView autoFocus trapFocusLeft trapFocusRight`, UP/DOWN not trapped, :138-144; `styles.viewport` :216-221): `paddingTop 28, paddingBottom 61, marginTop −23, marginBottom −53` (CLEARANCE/CANCEL → net 5 above / 8 below). **No clipping.**
* Track (`Animated.View`, :145-146, :225): `alignSelf flex-start`, `height = cardH` (**186** poster / **140** frame), `transform translateX = tx`.
* Slots (:150-163, :231): each card absolutely positioned `top 0, left = 84 + index × step`, where `step = (wide ? 224 : 124) + 14` = **138** (poster) / **238** (frame) (:97). Cards are keyed by identity (`id || imdbId || title-index`).
* Left fade (:182-184, :229-230): absolute `left 0, top 0, bottom 0, width 84 + 10 = 94`, over the cards, `row-fade.png` stretched to `94 × 100%`: colour `(13,14,24)`, alpha `1 − smoothstep(x)` across its width (gen_ambient.py:204-208) — page colour at the screen edge melting to clear where the cards begin.
* Resulting vertical pitch of a poster shelf: 8 + title line (18 dp type; natural Roboto line ≈ 21-22 dp) + 7 + 5 + 186 + 8 ≈ 236-237 dp between successive shelf tops at the same type (02-home's 247 assumed a 30 dp heading).

### 7.2 Motion (`useSlide`, motion.ts:36-64)

`tx.to(−max(0, (index − LEAD) × step))`, `LEAD = 1` (:55, :112) — the focused card rests one card in from the left margin (card 0 and 1 both rest at offset 0). The spring is **retargeted, never restarted**: `Animated.spring {speed: 12, bounciness: 0}` → tension 70.91 / friction 11.98 → **stiffness 342.1, damping 36.93, ζ ≈ 0.998** (critically damped), native driver, `isInteraction false`. Firing at key-repeat rate bends one journey toward the moving target.

### 7.3 Windowing (:67-71, :106-125)

Mounted cards = `items.slice(max(0, anchor − 3), min(n, anchor + 5 + 1))` (`VISIBLE_BEHIND 3`, `VISIBLE_AHEAD 5`); `anchor` moves to the focused index only when `|index − anchor| ≥ 3` (`WINDOW_SLACK`), inside `startTransition` (`defer`), so most presses mount nothing. Cards that slide past the left edge are **unmounted**, not clipped (:206-210) — they vanish under the fade.

### 7.4 Focus

* `autoFocus` guide: entering the row from above/below lands on the row's **last focused card** (or its first). LEFT/RIGHT at the ends are no-ops natively (traps); LEFT from card 0 (`edgeLeft`) opens the rail via NavRail's handler.
* `onItemFocus(item)` bubbles to Home (`toRow`, prefetch).

### 7.5 Native mapping

A `FrameLayout` (no clip) holding absolutely placed card views at `84 + i×step`, translated by a `SpringAnimation` (stiffness 342.1, dampingRatio 0.998) with `animateToFinalPosition`; a `RecyclerView`/`HorizontalScrollView` must **not** be used — Android's smooth scroll restarts its `ValueAnimator` from the previous target and discards velocity, which is exactly the teleport this component was written to remove (Row.tsx:14-29). Mount/unmount the window as above (or keep all views and let the fade cover the left; the visual is identical only if unmounted cards never peek out past x < 0 — they are off-screen anyway).

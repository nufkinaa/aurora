# 10d · Home — 1:1 spec

Part of [10-spec-home-nav-cards.md](10-spec-home-nav-cards.md). Lines are of `tv-native/src/screens/Home.tsx` (working tree = HEAD). Metrics `width/height/heroH/heroPadBottom/heroTitle/safeBottom` are `useTvMetrics()` (10-spec §1.1); values quoted "@960×540".

**Structure** (:3-11, :840-1030): the artwork is a **fixed** layer behind; the hero lockup and the shelves are **one sliding column** above it, translated by a retargetable spring (`ty`, `useSlide`). Press DOWN and the hero travels off the top; the art fades with the column's offset. The page does not scroll in the Android sense — the column's `translateY` is the scroll.

---

## 1. Z-order (root `View flex 1`, no background — the window colour / Ambient shows through, :1034-1036)

1. `artFade` (absolute fill, :1046) → `HeroArt` (:862-887) — only when `art` exists.
2. `column` (absolute `top 0, left 0, right 0`, :1055, `pointerEvents box-none`) translated by `ty.value` (:889-894): [no-hero bar] → hero block → rows → bottom spacer `height safeBottom` (:1019).
3. `NavRail active="home"` (:1022).
4. `updateChip` (:1024-1028) when an update is known.

---

## 2. The billboard art (`HeroArt`, :120-169; styles :1045-1052)

Art path = `hero.backdrop || hero.cover` (:822); nothing drawn when neither.

### 2.1 Layers inside `artLayer` (absolute `top 0, left 0, right 0`, **height = window height** (`h={height}`, :863), `pointerEvents none`)

| # | layer | style | source / notes |
|---|---|---|---|
| 1 | rest art | `Image` `styles.art` (absolute fill, 100%), `resizeMode cover`, `blurRadius = art.rest.deviceBlur`, **`fadeDuration 260`** (:148-154) | `rest` layer (below) |
| 2 | scrolled art | `Animated.Image` same style, `opacity = 1 − atTop`, `blurRadius = scrolled.deviceBlur`, `fadeDuration 0` (:155-163) | mounted only once focus has left the hero for this pick (`scrolledArt`, :824-829, :397) |
| 3 | trailer layer | children (§6) | |
| 4 | dim | `Animated.View` absolute fill `#000000`, `opacity = atTop ∈ [0,1] → [0.42, 0.45]` (:144, :165, :1050) | `brightness()` as a black scrim |
| 5 | scrim | `Image hero-scrim.png` absolute fill, `resizeMode stretch`, `fadeDuration 0` (:166, :1052) | precomposed `hero-side` + `ambient-veil` (§2.3) |

### 2.2 Which picture, which blur (`heroLayers`, :81-118)

* `REST = {blur: 1, dim: 0.45}`, `SCROLLED = {blur: 2, dim: 0.42}` (:81-82) — blur in **dp as `Image.blurRadius` would take it**.
* `deviceBlurPx(dp) = floor(floor(dp × density) / 2)` (:97) — the pixel radius Android's `ReactImageView.setBlurRadius` would use (2 iterations). @density 2: rest **1 px**, scrolled **2 px**. On a density where it comes to 0 → no blur at all (:94-96, :112).
* `heroPx(width) = ART_LADDER.find(s ≥ min(1280, ceil(width × density))) || 1280` (:99-102) → **1280** @960×2.
* A library still (`uri` contains `/img/still`) is **sharp in both states**: one layer, no blur, no scrolled layer (:108-109).
* Otherwise, per layer: if `serverCanBlur()` and `artPath(raw, heroPx, r)` is sizable → `?w=1280&blur=<r>` from the server, `deviceBlur 0`; else the plain URL with on-box `blurRadius = dp` (1 / 2) (:110-116).

### 2.3 `hero-scrim.png` (480×270 RGBA, stretched over the whole window; gen_ambient.py:267-327)

Porter-Duff **over** of two layers, baked:
* **hero-side** (gen_side_scrim.py:51-59): a left→right alpha ramp of page colour `(11,12,20)`, stops `α 168/255 @0 → 120/255 @0.30 → 0 @0.58 → 0 @1.0` (linear), stretched over the **left 72 %** of the window (`SIDE_BOX = 0.72`), sampled bilinearly at each texel centre.
* **ambient-veil** (gen_ambient.py:113-164): the ambient canvas (10-spec §5.1) with a vertical alpha ramp; `DISSOLVE = [(0.50,0),(0.66,0.25),(0.78,0.65),(0.87,1.0)]` scaled by `HERO = 0.86` for Home → alpha **0 until y = 0.43 of the window, 0.25 @0.5676, 0.65 @0.6708, 1.0 @0.7482**, linear between, opaque below.

So the art is fully dissolved into the ambient by **75 % of the window height**, and the left ~58 % of the picture carries a 0.66→0.47→0 page-colour wash. **Native: ship the PNG, FIT_XY over the window.**

### 2.4 The art fades with the column (:850-861)

`artFade.opacity = ty.value` interpolated `[−round(heroH×0.9), −round(heroH×0.3), 0] → [0, 1, 1]`, clamped. @540: fully visible until the column has slid 107 dp, gone at 320 dp.

### 2.5 `atTop` (:393-415)

`Animated.Value` 1 at rest; `setTop(next)` animates to 1/0 over **280 ms** `bezier(0.2,0.7,0.2,1)` when the boolean changes; on going down it also (deferred) sets `scrolledIdx = current pick` so layer 2 mounts and decodes while fading in (:402-405, :129-134). Layer 2 is dropped when the billboard has rotated past its pick (:824-829).

---

## 3. The hero block (inside the column; :916-1016)

Container `hero` (:1057): `height heroH` (**356** @540), `paddingBottom heroPadBottom` (**18**), `justifyContent flex-end`, `paddingLeft 84, paddingRight 48`.

### 3.1 Lockup (`heroInner`, :920-1000; :1059)

`Animated.View flexDirection row, alignItems flex-end, gap 24`; **opacity = swap**, **translateX = swap ∈ [0,1] → [52, 0]** (:924-928). `swap` resets to 0 and animates to 1 over **280 ms** `bezier(0.2,0.7,0.2,1)` on every `heroIdx` change (:601-610) — the lockup slides in 52 dp from the right and fades.

Inside, one `info` column `flex 1, maxWidth round(width × 0.46)` (**442** @960) (:930, :1061). (No poster beside it any more, :998-999.)

| element | style | content |
|---|---|---|
| kicker (:931-937, :1075) | `fontSize 12, fontWeight 900, letterSpacing 2, marginBottom 4`, colour `#7fd1e8` (show) / `#f0c67e` (film) | `SERIES` / `FILM` |
| title (:938-940, :1076-1083) | `fontSize heroTitle` (**29**), `fontWeight 900, letterSpacing −1.4, color #f3f4f8, textShadow rgba(0,0,0,0.55) offset (0,3) radius 26`, **2 lines** | episode ? `showTitle || title` : `title` |
| facts (:831-838, :941, :1084-1092) | `color #9aa1b5, fontSize 13, fontWeight 700, marginTop 6, textShadow rgba(0,0,0,0.6) (0,1) r10` | parts joined by `'   ·   '` (3 spaces each side): `★ {rating}`, `{year}`, `S{season} E{episode}` (episode), up to 3 genres joined `' · '`; omitted when empty |
| synopsis (:943-949, :1066-1072) | `color rgba(243,244,248,0.88), fontSize 15, lineHeight 22, marginTop 8, marginBottom 13, maxWidth round(width × 0.42)` (**403**), **2 lines** | `hero.synopsis` |
| actions row (:950-991, :1093) | `flexDirection row, gap 8, marginTop 12, flexWrap wrap, alignItems center` | buttons below |
| party note (:992-996, :1094) | `color #9aa1b5, fontSize 13, fontWeight 600, marginTop 8`, 1 line | `{host} is watching {title} · {members} in · code {code}` joined by `'   ·   '` for up to 2 parties |

### 3.2 Buttons (all `Btn`, 10a-spec §3), in order = hero-button indices

| idx | button | props |
|---|---|---|
| 0 | **Play** / **Stream** (`hero.source === 'stream' ? 'Stream' : 'Play'`) | `primary`, `icon play`, `hasTVPreferredFocus`, `ref=escape` (focus fallback), **not** `edgeLeft` (:951-965) |
| 1 | **Details** | `icon info` (:966-971) |
| 2 (only while a trailer plays) | **Unmute** / **Mute** | `small`, glyph `🔇` / `🔊` (:972-980) |
| 2(+1) … | **Join {host}'s party** ×≤2 | `small`, glyph `👥` (:981-990) |

`heroBtnCount = 2 + (trailerOn ? 1 : 0) + min(2, parties.length)` (:628).

### 3.3 Dots (`heroes.length > 1`; :1005-1014, :1102-1104)

Absolute `right 48, bottom heroPadBottom + 20 = 38`, `flexDirection row, alignItems center, gap 5`, `pointerEvents none`. Dot `7×7, borderRadius 999, rgba(255,255,255,0.36)`; active `width 22, #ffffff, boxShadow '0 0 10px rgba(255,255,255,0.5)'`. One per hero; drawn, never focusable.

### 3.4 No-hero bar (`!hero` but rows exist; :899-912, :1106)

`paddingTop 27, paddingLeft 84, flexDirection row` with a `small` surface `Btn "Refresh"` (`edgeLeft`, focus fallback).

---

## 4. Rotation and the hero's keys

* `heroes = data.hero` or, if empty, the first row's first item (:417).
* **Auto-advance**: every **9000 ms** while `heroes.length ≥ 2` and the screen is live, `heroIdx = (i+1) % n` — skipped while focus is in the shelves (`!isTop`), while `Date.now() < holdUntil`, or while a trailer is busy/playing (:419-426).
* **Hold**: `holdUntil = now + 15000` after a manual turn (:632) and after pressing Play (:962).
* **Hero key handler** (`useTVKeys`, :641-656), active only while a hero button is focused (`heroBtn ≥ 0`) and `isTop`:
  * `up`, or `left` **on button 0** → `requestRailOpen()` (remembering which button, :646-649);
  * otherwise if `!focusJustMoved(120)`: `right` on the **last** button → `turnHero(+1)` (:651-652). (LEFT on button 0 is the rail, not "previous slide"; the comment at :959 is stale **[KEEP-AS-IS?]**.) There is no key that turns the slide backwards.
* `turnHero(dir)` (:629-637): no-op with < 2 heroes; sets the 15 s hold; stops a busy/playing trailer (no advance); `heroIdx = (i + dir + n) % n`.
* Focus landing on any hero button → `toHero()`: `setTop(true)`, `ty.to(0)` (:612-615, :684-692).

---

## 5. The sliding column and rows

* `ty = useSlide()` — the same critically-damped spring as the shelves (stiffness 342.1, ζ 0.998; motion.ts:36).
* `toRow(index)` (:694-715): `setTop(false)`; stop any trailer; target `−min(max(0, rowY[index] − 27), max(0, colH − height))` — the focused row's heading comes to rest **27 dp (`pageY`) from the top**, clamped so the column never travels past its own bottom; then (deferred) `reach = max(reach, index + 3)`.
* Rows mounted: `rows.slice(0, reach + 1)` with `reach` starting at **3** → 4 shelves on first paint (:374, :1018). Rows above the focus stay mounted.
* `rowY[i]` is each row wrapper's measured `layout.y` (:750-752); `colH` the column's measured height (:891-893).
* Every row is a `Row` (10c-spec §7) with `showKind` **true**; the row with `id === 'continue'` gets `wide` (→ frame cards) and `onRemove` (:753-764).
* **Continue Watching removal** (:724-744): the card is removed locally at once, then `api.dismissUpNext(profile, showId, id)` for an `upNext` card, else `api.clearProgress(profile, id)`. Triggered from the peek sheet's "Remove…" (10c-spec §6).
* Bottom spacer `height safeBottom` (**27** @540).
* The "new downloads" shelf is just another server row (ids/titles come from `/api/home`); nothing on the client special-cases it beyond `showKind`.

---

## 6. The billboard trailer (:428-597, :657-683, :864-885)

Prerequisites to arm (:536-540): screen live, a hero with `imdbId` not in `noTrailer`, `prefs.heroTrailers !== false`, **not lite**, fewer than **2** trailers this visit (`trailersThisVisit` resets when Home becomes live, :459-462).

Timeline for a pick:
1. Arm immediately: resolve what would play (`api.discoverMeta` → YouTube keys; `prepareTrailer` with `maxYoutube 2`) during the hold (:546-568).
2. At **4500 ms** (:569-579): if still the same pick, `isTop` and the rail is closed → `trailerBusy = true` (freezes rotation), await the resolution; if nothing → `noTrailer.add(imdbId)`; else mount `TrailerFrame`.
3. `TrailerFrame` reports `playing` when `currentTime > 0` (Trailer.tsx:92-97) → `trailerOn = true`, `trailerFade` **0 → 1 over 800 ms, default easing** (`Easing.inOut(Easing.ease)`) (:510-517), Unmute button appears (count becomes 3), cap armed.
4. Cap: **25 s** muted, **50 s** once unmuted, measured from `startedAt` (:503-507); at the cap, or on `ended` → `stopTrailer(advance = true)` (:518-519).
5. `stopTrailer` (:470-501): `trailerFade` **1 → 0 over 700 ms** (default easing), then `cmd('stop')` and unmount; `advance` → `holdUntil = 0` and next pick.

Ends it at once (`stopTrailer(false)`): leaving the hero for a shelf (:697), a manual turn (:633), the pick changing or the screen going away (effect cleanup, :580-583), the **rail opening** (:665-668; on rail close over the hero the hold re-arms via `railEpoch`, and if the rail had been opened from Unmute, focus goes to Play instead, :669-678). `error` → the key/title is remembered as failed, no advance (:520-525).

**Frame geometry** (:876-882): the `TrailerFrame` is absolutely placed at **115 % of the window width**, 16:9: `width round(w × 1.15)` (**1104**), `height round(w × 1.15 × 9/16)` (**621**), `left −round(w × 0.075)` (**−72**), `top round((h − 621)/2)` (**−40** @540 — JS `Math.round(−40.5) = −40`). It sits in `trailerLayer` (absolute fill, `backgroundColor #000`, `opacity trailerFade`, :1095) between the art and the dim/scrim, so the lockup stays legible.

**Player** (Trailer.tsx:141-165): `react-native-video` `Video` with `viewType TEXTURE` for the hero (so opacity applies), `maxBitRate 6_000_000`, `muted`/`volume 0|1`, `resizeMode cover`, `repeat false`, `controls false`, `shutterColor transparent`, `focusable false`, `disableFocus` (no audio focus), `progressUpdateInterval 500`; a YouTube stream that errors after starting is re-resolved once and resumed at the same position (Trailer.tsx:109-119). Wrapper `overflow hidden, backgroundColor #000`.

Mute toggle (:586-596): `cmd('unmute'|'mute')`; unmuting re-arms the cap at 50 s.

---

## 7. Data and lifecycle (behavioural, not pixels)

* `api.home(profileId)` on becoming live, throttled to once per **15 s** (:226-244); `library_updated` socket messages re-read after a **2.5 s** debounce (:208-225). The TV launcher's home-screen channel is synced from the rows (:237).
* Update offers: `checkForUpdate` **1.5 s** after data (4 s before), then every 30 min; the sheet is not re-offered within 10 min; the `updateChip` shows `Update {version}` (:250-289, :1024-1028, :1107-1116: absolute `top 25, right 48, backgroundColor #6c58ff, borderRadius 999, paddingVertical 6, paddingHorizontal 16`, text `#ffffff 13 dp 800`).
* Parties: fetched on live, pushed over the socket (:291-304).
* `measureOnce()` 5 s after live (perf tier, :460-468).
* `warmSections()` once data is in; `warmItem` on card focus (:315-318, :759).

---

## 8. States

| state | render |
|---|---|
| loading (`!data && !error`, :770-781) | `center` (`flex 1, alignItems/justifyContent center, gap 20`): `ActivityIndicator large` in `#f3f4f8`, surface `Btn "Switch profile"` (`hasTVPreferredFocus`, `edgeLeft`, focus fallback), `NavRail` |
| error (:782-797) | `ErrorState message "Could not load home." detail <server message>` + Retry → refetch; `NavRail` |
| empty (`heroes.length === 0 && rows.length === 0`, :804-819) | `ErrorState "Nothing to show yet." detail "The server answered but had no titles for this profile — it may still be warming up after a restart." actionLabel "Try again"`; `NavRail` |
| normal | §1 |

Focus fallback (`escape`): the loading state's Switch-profile button, then the hero Play button, else the no-hero Refresh (:184-190, :777, :902, :953).

---

## 9. Native mapping notes

* Art: three `SimpleDraweeView`s (rest, scrolled, FIT_XY scrim PNG) + a black `View` for the dim, in a `FrameLayout` sized to the window; the scrolled view's alpha and the dim's alpha from one 280 ms `ValueAnimator` (`PathInterpolator(0.2,0.7,0.2,1)`). Request `?w=1280&blur=1|2` when the server advertises `imgBlur`; otherwise `IterativeBoxBlurPostProcessor(2, 1|2)`. Rest art `fadeDuration 260`, others 0.
* The whole art stack's alpha is a function of the column's translation (§2.4) — bind it to the same spring value.
* Column: a tall `FrameLayout` (no clip) translated by `SpringAnimation` (stiffness 342.1, ζ 0.998); measure each row's top for `toRow`.
* Lockup entrance: `ValueAnimator` 280 ms driving `alpha` and `translationX (52 → 0)`.
* Trailer: ExoPlayer in a `TextureView` with `maxVideoBitrate 6 Mbps`, placed at the 115 % frame, alpha from 800/700 ms animators with `PathInterpolator` of `inOut(ease)` (10-spec §8).
* Timers (9 s, 15 s, 4.5 s, 25/50 s, 1.5/4 s) as `Handler` posts; honour the same cancellation points.
* `requestRailOpen` → the rail's open routine; `onRailOpen/Close` as listeners.

# 11b · 1:1 spec — Overlays.tsx, Trailer.tsx, trailers.ts and the hero trailer

Part of [11-spec-detail-player-pick.md](11-spec-detail-player-pick.md). HEAD `42bb208`. Files: `tv-native/src/components/Overlays.tsx` (983 lines), `components/Trailer.tsx` (172), `trailers.ts` (163), `overlay.ts` (64), `toast.ts` (33), `components/Sheet.tsx` (92), plus the hero-trailer section of `screens/Home.tsx` (`:428-596`, `:657-683`, `:862-887`, `:972-980`).

---

## 0. The overlay host (`overlay.ts`, `Overlays.tsx:816-831`)
- **One sheet at a time**: `openOverlay` is a no-op while one is up (`overlay.ts:532-535`). Kinds: `peek`, `report`, `join`, `update`, `updateReady`, `trailer`, `actions`, `xray` (`:511-520`).
- `Overlays` is mounted once above the navigator (`navigation.tsx:117`) and renders the current sheet and `<Toasts>` (`Overlays.tsx:816-831`). Everything here stacks at `zIndex/elevation 500`; toasts at **600** (`:939`).
- Every sheet traps keys (`useKeyTrap`), traps D-pad focus in all four directions (`TVFocusGuideView`), and closes on BACK. Closing a trap returns focus to the element that had it when the sheet opened (`focus.ts:428-440`).

### 0.1 Shared buttons (`:373-382`, `:834-848`)
- `Primary`: Focusable `round light ring="violet"`; white, pv 12 / ph 26, minWidth 130, centred; text 15/`800` `bg`; `busy` → an `ActivityIndicator` in `bg` replaces the label.
- `Ghost`: Focusable `round` (white ring); fill `rgba(255,255,255,0.12)`, border 1 same, pv 12 / ph 20, centred; text 15/`700` `text`.
- `actions` row: wrap, gap 8, marginTop 20; `actionsSpread` adds `justifyContent space-between` (primary left under the field, Cancel far right — so DOWN from a text field lands on the primary, `:846-848`).
- Text styles: `body` 15 lineHeight 24 `text`; `faint` 13 `textDim` mt 8; `error` `#ff8080` 15 mt 8; `input` fill `rgba(255,255,255,0.06)`, border 1 `line`, radius 12, 15, pv 12 / ph 16, mt 14, minHeight 84, top-aligned (`:917-932`); `codeInput` 34/`900` letterSpacing 12 centred maxWidth 260 (`:933`).

---

## 1. Toasts (`toast.ts`, `Overlays.tsx:385-400`, `:939-951`)
- `showToast(text, glyph?, ms = 3800)`. The list keeps the two newest plus the new one — **never more than three** (`toast.ts:675-677`); oldest first, top to bottom.
- Container: absolute `left 0 / right 0`, **`bottom 28`**, `alignItems center`, gap 8, `zIndex 600`, `pointerEvents none`.
- Toast: `glass` (fill `rgba(19,21,34,0.97)`, border 1 `rgba(255,255,255,0.10)`, top `rgba(255,255,255,0.22)`, shadow `0 30px 80px rgba(0,0,0,0.6)`), **pill**, row gap 10, pv 10 / ph 22, maxWidth 70 %. Glyph 16; text 15/`700` `text`, `numberOfLines 2`.
- **No enter/exit animation** — a toast appears and vanishes in one frame. **[KEEP-AS-IS?]**
- Who fires them: Detail (download flow, follow, marks), the peek sheet (`Added to My List` / `Removed from My List` ✓), report (`Sent — thank you. It landed with the admin.` 🛠️), Settings (`You're on the latest version (5.1.28)` ✓), Pick (`OFF_TEXT` ⚠️), Downloads (`Cancelled “…”` 🗑), UpdateReady (`Allow "Display over other apps" for Aurora under Settings → Apps → Special app access` ⚙️). The **player never uses these** (it has its own, 11a §3.11).

---

## 2. Sheets built on `Sheet` (geometry in 11 §0.5)

### 2.1 Peek (`PeekSheet`, `:407-536`, styles `:954-963`)
Width **720**. `peekRow` row gap 20: art box 256×144 radius 12 `bgRaised`, image `artSrc(backdrop||cover||poster, 256)` cover, no fade; a 4 dp progress bar on its foot `rgba(255,255,255,0.2)` with a `progress` fill when `0 < pct` and not finished. Text column flex 1: title 24/`900` letterSpacing −0.5, 2 lines; sub 13/`700` `textDim` mt 4 (`<show> · S1 E3` or `2024 · Film|Series`); `pct% watched · 42 min left` / `1h 05m left` 13/`700` `accent` mt 4; synopsis 15 lineHeight 23 `textDim` mt 8, 4 lines (fetched if missing). Actions: `▶  Play` / `▶  Open` (Primary, focused), `Details`, `✓  In My List` / `+  My List` (once known), `Remove from Continue Watching` (when `onRemove`).

### 2.2 Report a problem (`:539-597`)
Kicker `HELP`, title `Report a problem`, body copy, a multiline `TextInput` (autoFocus, placeholder `What went wrong? What did you expect?`), error line, `Send report` (Primary, busy spinner) + `Cancel` spread.

### 2.3 Join a watch party (`:600-643`)
Kicker `WATCH TOGETHER`, title `Join a watch party`, body, the code input (upper-cased A–Z0–9, max 6, placeholder `ABCD`, `codeInput` style), error `No party with that code. Codes are four letters and expire when the host leaves.`, `Join` + `Cancel`.

### 2.4 Update available (`UpdateSheet`, `:703-837`) — width 680, `accent` card
Kicker `UPDATE AVAILABLE`, title `Aurora TV 5.1.29 is ready`. Stages: `offer` (notes body, faint line `This TV runs … Later asks again in ten minutes.`, `Update now` focused + `Later`), `downloading` (`Downloading the update…`, progress bar height 8 radius 4 `rgba(255,255,255,0.14)` mt 14 with `accent` fill or an indeterminate 30 %-wide fill at opacity 0.6, faint `12.3 MB of 41.0 MB · 30%`, `Cancel`), `perm` (permission copy, `Open the permission` + `Later`), `installing` (`Close`), `error` (`Try again` + `Later`).

### 2.5 Update ready (`UpdateReadySheet`, `:648-699`) — `accent` card
Kicker `UPDATE READY`, title `Aurora TV <v>`, body explaining restart, `Restart now` (focused, busy) + `Later` + optionally `Let Aurora reopen itself`.

### 2.6 Actions (`ActionsSheet`, `:1022-1050`, styles `:904-916`) — width 520
Kicker = `sub` (`<show> · S1 E3`), title = the episode name. List gap 8 mt 8; each row a Focusable (default rounded-rect ring, radius 12) row `space-between`, pv 12 / ph 16, fill `rgba(255,255,255,0.08)`; label 15/`700` (`#ff8080` when `danger`); tag 13 `textDim` ml 14. First row focused. A press closes the sheet **then** runs the action.

---

## 3. X-Ray sheet (`XraySheet`, `:880-1017`; styles `:851-903`)
Not a `Sheet`: a bottom sheet with its own rise.
- `xrBackdrop`: absolute fill, `justifyContent flex-end`, zIndex 500. `xrWash` `rgba(4,5,10,0.6)` with opacity = rise value.
- `xrPanel`: `marginHorizontal 36` (pageX − 12), `maxHeight 446`, top radii 24 (square bottom), paddingTop 18, paddingHorizontal 28, paddingBottom 22, **opaque** `rgb(14,16,28)` + gradient `140deg rgba(104,86,226,0.28) 0% → rgba(14,16,28,0) 48% → rgba(70,200,150,0.18) 100%`, border 1 `rgba(255,255,255,0.10)` top `rgba(255,255,255,0.22)` no bottom border, shadow `0 −24px 70px rgba(0,0,0,0.6)`.
- **Rise** (`:885`, `:902`, `:950-957`): `Animated.spring(rise → 1, stiffness 190, damping 20, mass 0.9)`; panel `translateY 120 → 0`, `scale 0.96 → 1`, opacity `[0, 0.4, 1] → [0, 1, 1]`; wash opacity `0 → 1`. **Close** (`:887-892`): `timing(rise → 0, 160 ms, Easing.in(quad))` then `closeOverlay()` + `onClose` (the player resumes if it was playing).
- Head (`xrHead` row, `alignItems flex-start`, gap 20): kicker `X-RAY` 11/`800` ls 3 `accent` mb 2; heading 24/`900` lineHeight 30, one line (`<show> · S1 E3 — <ep title>` or the title); facts 13 `textDim` mt 4 one line (`Aired 12 Mar 2024   ·   52 min   ·   ★ 8.1 IMDb` or `★ … · Released … · Runtime · Country · Box office`); behind-the-camera line 13 `textDim` mt 2 (`Directed by …   ·   Written by …` or up to 6 `Job: Name`). Right side: a `BACK` key cap (text 10/`800` ls 1, ph 7 pv 3, radius 6, border 1 `rgba(255,255,255,0.28)`) + `closes` 13 `textFaint` (row gap 6 mt 6) — replaced by a Ghost `✕  Close` (focused) when nobody is listed or the fetch failed.
- Body `ScrollView` mt 8, maxHeight 300, `fadingEdgeLength 36`: episode overview 13 lineHeight 20, 2 lines; section labels 11/`800` ls 1.2 `textFaint` mt 10 mb 2 (`IN THIS EPISODE` / `CAST` / `REGULAR CAST`); horizontal rows gap 6, pv 4, ph 2; up to 18 regulars.
- `Face` (`:853-873`): Focusable (default ring, radius 12) width 114, centred, pv 6 / ph 5; disc 58 circle `rgba(255,255,255,0.1)` with initials 17/`800` `textDim` under a cover photo; name 12/`700` `text` mt 5 maxWidth 104; role 11 `textFaint` mt 1. First face of the first row is focused.
- Loading: `ActivityIndicator white` with marginVertical 48. Failure body: `X-Ray couldn't reach its sources for this title.`; empty: `Nothing known about this one yet.`

---

## 4. TrailerModal (`:722-813`; styles `:849`, `:965-983`)
Full-screen `trailerRoot` black, zIndex 500. Phases `resolving → loading → playing | none`.
- `TrailerFrame` fills the screen (SurfaceView, `muted={false}`, bitrate cap **9 Mbps**) once a trailer is resolved; a `TVFocusGuideView autoFocus` head bar sits over it: absolute top, row `alignItems center`, gap 8, paddingHorizontal 48, paddingTop 22, paddingBottom 30, fill `rgba(0,0,0,0.55)`; title `<title> — trailer` 18/`800` flex 1 one line; `Open in YouTube` Ghost (only when a YouTube key is known: `vnd.youtube:<id>` intent, falling back to `https://www.youtube.com/watch?v=<id>`); `✕  Close` Ghost with preferred focus.
- While resolving/loading: a centred `ActivityIndicator large white`. `none`: centred `No trailer available for this title` (15/lh 24) on black with ph 80.
- `ended` → closes the sheet; `error` → next attempt (Apple → YouTube key → next key), **at most 2 further attempts** (`:768-772`); BACK closes. The head bar never hides. **[KEEP-AS-IS?]** there is no auto-hide of the head bar over the trailer.

---

## 5. TrailerFrame (`components/Trailer.tsx`)
- Mounted only while a trailer runs. `<Video>` absolute fill, `resizeMode cover`, `repeat false`, `controls false`, `shutterColor transparent`, `focusable false`, `progressUpdateInterval 500`, `playInBackground false` (`:141-164`).
- `hero` → `ViewType.TEXTURE` (so the cross-fade's opacity reaches the picture) and `maxBitRate 6_000_000`; sheet → `SURFACE` and `9_000_000` (`:25-26`, `:152-153`); `disableFocus={hero}` (a muted billboard never takes audio focus).
- States reported: `ready` on load, `playing` at the first `currentTime > 0`, `paused`/`playing` on the handle's commands, `ended`, `error` (`:89-123`). A YouTube stream that errors after it started is re-resolved **once** and resumed from `startPosition` (`:109-119`).
- `handle.cmd`: `mute`/`unmute` (volume 0/1 + muted), `pause`/`play`, `stop` (unmounts the Video and leaves an empty black view, `:137`).
- Wrapper `overflow hidden`, black (`:170`).

## 6. Resolution (`trailers.ts`)
1. `api.trailer(imdbId, type)` → Apple HLS when the server has one (`:264-273`).
2. Else the server's YouTube ids ∪ the ids the page holds, filtered (`/^[\w-]{6,20}$/`, not skipped, not failed in the last **30 min**), the first `maxYoutube ?? 3` resolved **on the TV** by `AuroraTrailers.resolve` (NewPipeExtractor; `android/.../TrailersModule.kt`: 15 s per-call timeout, 30 s whole resolve, max 1080p H.264 DASH, then YouTube DASH, then progressive, then HLS) (`:274-284`). A resolved key is kept **15 min** (`:210`).
3. `prepareTrailer` memoises one promise per title for **45 min** (`:297-312`); a failure forgets it.
Every failure is reported to `POST /api/trailer/report` and the usage stats (`:218-229`).

## 7. The hero trailer on Home (behaviour owned by this scope; `Home.tsx`)
- Pre-conditions: `prefs.heroTrailers !== false` (Settings → "Trailers on the home billboard"), the pick has an IMDb id not already failed this visit, the box is not `isLite()`, and fewer than **2** trailers have played this visit (`:538-540`). The count resets when Home becomes live again (`:460-468`).
- On a new pick the trailer is **resolved immediately** (discoverMeta → `prepareTrailer`, `maxYoutube 2`) while a **4 500 ms** timer runs (`:546-579`). When it fires: not on top of the page, or the rail open, or the resolution failed → nothing (a miss marks the title as "no trailer" for the visit); otherwise `setTrailer` and the rotation is held (`trailerBusy`).
- `trailerLayer` (`:1095`, `:865-884`): absolute fill, **black**, opacity `trailerFade`; the frame is positioned 16:9 at **115 % of the width**: `width = round(w×1.15)`, `height = round(w×1.15×9/16)`, `left = −round(w×0.075)`, `top = round((h − height)/2)` → @960×540: 1104×621 at (−72, −40).
- On `playing`: `timing(trailerFade → 1, 800 ms)`; the cap timer is armed for **25 s** muted, **50 s** once unmuted, measured from the start (`:503-517`). On the cap or `ended`: stop and **advance** to the next pick. On `error`: stop without advancing and remember the key.
- `stopTrailer` (`:470-501`): if playing, `timing(trailerFade → 0, 700 ms)` then `cmd('stop')` and unmount; unmuted state resets to muted.
- Stops on: moving down to a shelf (`toRow`, `:697`), turning the hero (`:633`), the pick changing or the screen going away (effect cleanup `:580-583`), and **the rail opening** (`onRailOpen`, `:665-668`); the rail closing re-arms the hold for the pick on show (`railEpoch`, `:669-678`) and, if the rail was opened from the Unmute button that has since vanished, focus goes to Play.
- **Mute pill** (`:972-980`): a `Btn small` with glyph `🔇`/`🔊` and label `Unmute`/`Mute`, inserted as the **third** hero button only while `trailerOn`; press toggles `cmd('unmute'|'mute')`; unmuting re-arms the cap to 50 s. No separate "mute/unmute pill" style exists — it is the standard small surface Btn (34 dp).

## 8. Native mapping notes — overlays and trailers
- Sheets: a full-screen `FrameLayout` overlay added to the activity's decor view (above the navigator), backdrop colour per §0.5; card = `GradientDrawable` radius 22 with the glass stroke colours (top edge lighter — Android strokes are one colour, so draw the top highlight as a second 1 dp drawable layer in a `LayerDrawable`).
- Toasts: a `LinearLayout` column anchored 28 dp above the bottom, centred, no animation; cap three.
- X-Ray rise: `SpringAnimation` on `TRANSLATION_Y` (120→0) and `SCALE_X/Y` (0.96→1) with `SpringForce` tuned to settle like RN's `stiffness 190 / damping 20 / mass 0.9` (RN's are the physical constants; Android's `DynamicAnimation` uses stiffness/damping-ratio — convert: ζ = 20 / (2·√(190·0.9)) ≈ **0.765**, ω₀ = √(190/0.9) ≈ 14.5 rad/s); alpha keyed to the same progress (1 at 40 %). Close = 160 ms `AccelerateInterpolator`.
- Trailer playback: ExoPlayer with `TextureView` for the hero (opacity cross-fade) and the same bitrate caps (`DefaultTrackSelector` `setMaxVideoBitrate`); the YouTube resolve module is already native and stays.
- **Cannot be identical**: RN's `fadeDuration` image fades are Fresco linear fades; the toast glass `boxShadow 0 30px 80px` is a very wide blur best baked; emoji glyphs depend on the system emoji font.

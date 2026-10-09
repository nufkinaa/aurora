# 11 · 1:1 spec — title page, player, AI page and the small screens

**Measured at HEAD `42bb208`** (1.6.77 / Aurora TV 5.1.28, 2026-10-09). Every number below is quoted from source as `file:line`; nothing is estimated. Where the current behaviour looks accidental it is marked **[KEEP-AS-IS?]** — the owner decides, the spec does not "improve" it.

This document is the contract the native (Kotlin / Android TV) rendering layer is held to for the screens in this scope. The Home / Browse / NavRail / Card / Focusable / theme spec is a sibling document; this one only restates the parts of those primitives that the screens here *consume*, so a reader can check a value without opening a second file.

| Part | File | What it covers |
|---|---|---|
| **This file** | `11-spec-detail-player-pick.md` | conventions, the shared primitives as consumed, **Detail.tsx** (film + show pages, inline Sources panel, More like this), Detail native-mapping notes, closing summary |
| 11a | [`11a-spec-player.md`](11a-spec-player.md) | **playback/Player.tsx** — chrome, scrubber, menus, overlays, every key, every timer |
| 11b | [`11b-spec-overlays-trailer.md`](11b-spec-overlays-trailer.md) | **Overlays.tsx** (all sheets, toasts, X-Ray, TrailerModal), **Trailer.tsx**, the hero-trailer behaviour Home drives, `trailers.ts` |
| 11c | [`11c-spec-pick-settings-signin-gate-whatsnew-search.md`](11c-spec-pick-settings-signin-gate-whatsnew-search.md) | **Pick.tsx**, **Settings.tsx**, **Downloads.tsx**, **SignIn.tsx**, **ProfileGate.tsx**, **WhatsNew.tsx**, **Search.tsx** |

---

## 0. Conventions used in every part

### 0.1 The canvas: everything is 960 dp wide
`canvas.tsx:27` — `BASE_W = 960`. The app lays out on a logical canvas 960 dp wide and scales it to the real window (`canvas.tsx:38-41`: `scale = width/960`, `height = round(windowH/scale)`). On a 1080p 16:9 panel the canvas is **960×540**; on 16:10 it is **960×600**. Within 1% of scale 1 no transform is applied (`canvas.tsx:42`). All "dp" below are *canvas* dp. `useTvMetrics()` (`theme.ts:173-208`) exposes `width`, `height`, `safeBottom = max(20, round(min(w,h)×0.05))` (= 27 @540, 30 @600), `heroH = round(h×0.66)`, `detailBackdrop = round(h×0.6)` (unused by Detail at HEAD).

Native mapping: one root `FrameLayout` sized 960×(h/scale) with `scaleX/scaleY = scale` and pivot at the centre, exactly as `canvas.tsx:52-64` does with `translate` + `scale`. Text stays vector-sharp through the matrix; bitmaps decode at logical size and are upscaled.

### 0.2 Tokens consumed here (`theme.ts`)
| token | value | line |
|---|---|---|
| `bg` | `#0b0c14` | 10 |
| `bgRaised` | `#131523` | 11 |
| `surface` | `rgba(255,255,255,0.06)` | 16 |
| `surfaceHover` | `rgba(255,255,255,0.11)` | 17 |
| `line` | `rgba(255,255,255,0.09)` | 18 |
| `text` | `#f3f4f8` | 23 |
| `textDim` | `#9aa1b5` | 24 |
| `textFaint` | `#616880` | 25 |
| `accent` | `#8b7bff` | 26 |
| `progress` | `#8b7bff` | 28 |
| `focusRing` | `rgba(255,255,255,0.95)` | 34 |
| `star` | `#f5c542` | 35 |
| `kindFilm` / `kindSeries` | `#f0c67e` / `#7fd1e8` | 38-39 |
| `radius` | s 8 · m 12 · l 18 · pill 999 | 44 |
| `fontSize` | hero 30 · title 24 · row 18 · body 15 · small 13 | 63-69 |
| `spacing` | xs 4 · sm 8 · md 14 · lg 20 · xl 32 · pageX 48 · pageY 27 · contentLeft 84 | 83-87 |
| `focus` | borderWidth 3 · scale 1.055 · duration 160 ms · ease bezier(0.2,0.7,0.2,1) · spring {tension 180, friction 14, restDisplacementThreshold 0.001} | 97-118 |
| `cardAura` | edge 2 dp `rgba(255,255,255,0.9)` · shadow `0 18px 36px rgba(0,0,0,0.6)` · lift 3 | 128-135 |
| `CLEARANCE` | above 28 · below 61 | 151 |
| `motion` | fast 160 · med 280 | 165 |

Typography: every `Text` is the platform default sans (Roboto on Android TV); no custom family is loaded anywhere in this scope. Weights are RN numeric strings (`'600'…'900'`) → Roboto Medium/Bold/Black. RN text has **no font padding** equivalent to Android's `includeFontPadding=true` default: set `includeFontPadding=false` on every `TextView` or every line box grows ~3–4 dp and the pills change height.

### 0.3 The Focusable contract, as every screen here relies on it (`components/Focusable.tsx`)
- Reserves a **3 dp transparent border** in layout (`:461-465`) so gaining focus never reflows. A style passed in that sets its own `borderWidth` (episode card = 1, icon disc = 1, source row = 1) *replaces* that reservation.
- **Ring** (`:475-488`): a 3 dp border in `focusRing`, drawn at inset 0 inside the reserved border, with `boxShadow 0 10px 24px rgba(0,0,0,0.5)`; opacity 0→1 over **160 ms**, `bezier(0.2,0.7,0.2,1)` (`:323-329`); out the same way (`:344-350`). `ring="violet"` = `accent`; `ring="none"` = nothing drawn.
- **Light variant** (`light` prop, `:394-429`, `:497-515`): for white fills. A 3 dp gap ring in `bg` at inset −3, then a **4 dp** ring (`LIGHT_RING = focus.borderWidth+1`, `:49`) at inset −7 in the ring colour, same shadow. Both ride the same opacity value.
- **Scale**: spring `focus.spring` 0→1 mapped to `1 → scaleTo ?? 1.055` (`:286-290`), with `lift` as `translateY 0 → −lift` on the same spring (`:293-295`). `noScale` removes the transform node.
- **highlightColor**: an absolute fill in that colour, radius = the element's own radius, opacity riding the ring value (`:375-387`). This is how the player buttons and the icon discs "fill white on focus".
- **One ring at a time**: whoever gains focus fades out the previously lit ring (`:72-78`, `:240-254`).
- `hasTVPreferredFocus` is forwarded only until first focus or **600 ms** (`:270-276`) — a mount-time claim, never a later yank.
- `holdLeft` sets `nextFocusLeft` to itself (`:301`) so LEFT moves nothing and the rail's handler sees an un-moved press.
- `onLongPress` is a plain Pressable long press (Android default ~500 ms); the ring registry is not touched.

### 0.4 focus.ts behaviours the screens depend on
| API | behaviour | line |
|---|---|---|
| `noteFocus(node, edgeLeft, edgeRight)` | every Focusable writes who holds focus and whether LEFT belongs to the rail; records `lastFocusMoveAt` when the node changes | 259-264 |
| `focusJustMoved(ms)` | true while a focus move is younger than `ms`; the rail opens only on a press that moved nothing | 288-289 |
| `noteFocusLost` → fallbacks | a focused element unmounting arms a **120 ms** timer; if nothing has taken focus by then the innermost `useFocusFallback` ref gets `requestTVFocus()` | 305-325 |
| `useKeyTrap(active)` | `traps++` while active; every `useTVKeys` handler outside goes deaf; on close, focus returns to the element that held it when the trap went up (`captureFocus`) | 428-440 |
| `acceptTvEvent` | a D-pad press arrives as key-down (0) and key-up (1); act on the down, ignore an up whose down was seen < **1500 ms** ago | 451-464 |
| `noteRail / onRailOpen / onRailClose / requestRailOpen` | rail-open counter + listeners; Home's trailer stops on open and re-arms on close | 374-415 |
| `useTVKeys` | gated by: screen is live (react-navigation focused), not `deaf`, `traps === 0`, `acceptTvEvent` | 469-485 |

### 0.5 Shared small components as consumed here
**Btn** (`components/Btn.tsx`): pill; row, gap 8, `paddingVertical 9 / paddingHorizontal 20`, `minHeight 40` (`:114-123`); `small`: 7/14, minHeight 34 (`:126`); surface fill `colors.surface` + a 1 dp `rgba(255,255,255,0.07)` hairline that disappears while focused (`:89`, `:131-140`); `primary`: white with an SVG vertical gradient `#ffffff → #eceef7` (`:79-87`), `boxShadow 0 8px 24px rgba(0,0,0,0.38)` (`:130`), label colour `bg`, `light` + `ring="violet"` (`:65-67`); label 15/`700`, lineHeight 22, letterSpacing 0.16 (`:142`); small label 13/lh 19; `dim` → `textDim`. Icon size 18 (`:92`).

**Chip** (`components/Chip.tsx`): `surface` variant minHeight 48, pv 8 / ph 16, pill, `surface` fill + 1 dp `line` edge child when not on (`:237-253`); `bare` minHeight 48, pv 9 / ph 18, transparent, text 16/`800` `textFaint` (`:227-234`, `:263`); `small`: minHeight 36, pv 6 / ph 13, text 14 (`:254-256`); `on`: white fill, text `bg`, `light` ring, and **violet ring only when `on && small`** (`:207`); bare+on adds `boxShadow 0 4px 14px rgba(0,0,0,0.35)` (`:260`). Text 16/`700`.

**Sheet** (`components/Sheet.tsx`): full-screen backdrop `rgba(5,6,12,0.72)` (accent variant `0.86`), `zIndex/elevation 500`, centred, padding 48 (`:330-342`, `:350`); card = `glass` (`backgroundColor rgba(19,21,34,0.97)`, border 1 `rgba(255,255,255,0.10)` with top `rgba(255,255,255,0.22)`, `boxShadow 0 30px 80px rgba(0,0,0,0.6)`, `:320-327`) + radius 22, padding 32, maxWidth/maxHeight 92%, width prop default 560 (`:280`, `:343-349`); accent variant border `rgba(139,123,255,0.55)`, top `rgba(199,191,255,0.8)`, shadow `0 0 0 1px rgba(139,123,255,0.25), 0 30px 90px rgba(0,0,0,0.7), 0 0 60px rgba(108,88,255,0.35)` (`:351-355`); kicker 13/`800` letterSpacing 3 `accent` mb 4; title 24/`900` mb 8 (`:356-357`). `useKeyTrap(true)`, BACK closes, `TVFocusGuideView autoFocus` + all four traps (`:294-314`).

**MiniSpinner** (`components/MiniSpinner.tsx`): 18 dp ring, border 2 `rgba(255,255,255,0.2)` with white top, one linear turn per **800 ms** (`:367-395`).

**Icon** (`components/Icon.tsx`): 24×24 viewBox SVG paths copied from the site's `ui.js`; `fill = color`. Names used in this scope: play, pause, back, plus, check, cc, forward10, back10, speed, download, search, close, info, gear, volume, volumeOff, film, series, people, xray, skip, sparkle, chat, calendar, clock, refresh, warning. `forward10/back10` draw the "10" as SVG `<text>` 7.5/800 at (8.2,15.5) (`:541`, `:550`); `gear` is translated −1 in x (`:574`); `volumeOff` is scaled 0.92 (`:584`).

### 0.6 Artwork URL rules (`api.ts:743-793`)
- Ladder `[240,256,352,360,448,480,640,800,960,1280]` device px (`:743`). `artPx(dp) = ceil(dp × PixelRatio)` snapped **up** to the ladder, `null` above 1280 (`:761-765`).
- `artPath` adds `?w=<px>` to `/img/<name>`, `/img/meta/<name>`, `/img/poster/tt…`, and wraps the six proxied hosts (`image.tmdb.org`, `images.metahub.space`, `live.metahub.space`, `static.tvmaze.com`, `commons.wikimedia.org`, `upload.wikimedia.org`) as `/img/ext?u=<enc>&w=<px>` (`:745-752`, `:771-785`). Anything else (stills, frames) is used as-is and the `<Image>` gets `resizeMethod="resize"`.
- Every image request from a signed-in / profiled app carries `X-Session` and `X-Profile` headers (`:798-804`).

---

## 1. Detail.tsx — the title page (film and show)

File: `tv-native/src/screens/Detail.tsx` (3023 lines). Two returns: show (`:2387-2515`) and film (`:2521-2627`). Both share `HeroArt`, `NavRail`, a vertical `ScrollView`, `DetailHero`, and the two overlays (Sources, More like this).

### 1.1 Page skeleton and geometry
```
root (flex 1, no background — windowBackground is bg)          :2633
  HeroArt (absolute, see 1.2)
  NavRail active=movies|shows disabled={srcPanel||likePanel}   :2393 / :2526
  ScrollView contentContainer { paddingTop: artTop, paddingBottom: safeBottom }   :2397 / :2530
    DetailHero (paddingLeft 84, paddingRight 48, paddingBottom bottomInset+14)     :270, :2724
    … dock (show: "Episodes" + pills + rail; film: "More like this" shelf)
  [loading spinner — film only]   absolute bottom 32, left 84   :2624, :2837
  sourcesOverlay / moreOverlay (absolute full, zIndex 10, elevation 10)
```
- **`artTop = round(height × 0.22)`** (`:1487`) — 119 dp @540, 132 @600. The lockup *starts* there; it is top-anchored inside the scroll, not bottom-anchored (the comment at `:1484-1486` still says "42%"; the code says 22% — **[KEEP-AS-IS?]** the comment is stale, the number is live).
- `scroll` is `flex: 1` (`:2725`); `showsVerticalScrollIndicator={false}`.
- A focused episode card / shelf card calls `scrollToEnd({animated:true})` (`:2200-2201`, `:2207`, `:2276`) so the rail always rests at the page's bottom padding rather than flush to the screen edge.

### 1.2 The artwork stack (`HeroArt`, `:322-360`, styles `:2705-2719`)
| layer | geometry | paint |
|---|---|---|
| `artBox` | absolute `top 0, right 0, left '30%', height '76%'` → @960×540: x 288→960, y 0→410 | — |
| `art` (Image) | fills the box; `resizeMode cover`, `resizeMethod resize`, **`fadeDuration 260`** (`:344`), `blurRadius 28` when the picture is a poster pressed into service (`sharp=false`, `:348`), 0 otherwise | — |
| `artDim` | fills the box | `rgba(6,7,14,0.18)` (`:2715`) |
| `DETAIL_MASK` (Image) | **full-screen** absolute, `resizeMode stretch`, `fadeDuration 0` (`:357`) | `assets/detail-mask.png` 480×270 RGBA |

**The mask** (`tools/gen_ambient.py:230-265`): colour = the ambient bake (the page's blooms over `bg`), alpha = `max(left, foot)` where `left = 1 − smoothstep(clamp((fx − 0.30)/0.45))` (page-coloured at x = 30 %, clear by x = 75 %) and `foot = smoothstep(clamp((fy − 0.40)/(0.76 − 0.40)))` (clear above y = 40 %, solid at y = 76 %), with alpha 0 everywhere x < 30 % − 3.5 px or y > 76 % + 3.5 px (`LEAD`). Bilinear stretch of 480→960 spreads an alpha step over ~8 screen px; the 3.5 px lead exists for that (`:242-246`).

**Which picture** (`:1478-1483`): `keyArt = https://images.metahub.space/background/medium/<imdb>/img` whenever an IMDb id is known (`item.imdbId || libImdb`), else `item.backdrop || item.cover || item.poster`; through `imgSrc` (no `?w=` sizing — **[KEEP-AS-IS?]** the backdrop is the one big image not sized through `artSrc`). `sharp = !!(keyArt || item.backdrop)`. No placeholder is drawn while it loads: the page colour shows, then the picture fades in over 260 ms.

Unused leftovers: `HERO_SIDE`, `HERO_VEIL` are required (`:55`, `:58`) and `artSide`/`artVeil`/`artFallback` styles exist (`:2711`, `:2718-2719`) but nothing renders them.

### 1.3 The lockup (`DetailHero`, `:226-318`, styles `:2724-2836`)
Column order (fixed, `:276-313`): kicker → title → meta row → **actions (children)** → secondary icon row → synopsis → genre line → cast line → note.

| element | style | source |
|---|---|---|
| `lockupRow` | row, `alignItems flex-end`, gap 20 | `:2747` |
| `lockup` | `maxWidth '42%'` of the hero's content width (828 dp @960 → **347.8 dp**) | `:2746` |
| `kicker` ("FILM" / "SERIES") | 13/`800`, letterSpacing 3, `accent` | `:2759` |
| `title` | **30**/`900`, letterSpacing −1.2, marginTop 4, text shadow `rgba(0,0,0,0.5)` offset (0,3) radius 24; `numberOfLines 2` | `:2760-2769`, `:283` |
| `metaRow` | row, wrap, `alignItems center`, gap 10, marginTop 6 | `:2771` |
| `rating` (`★ 8.1`) | 13/`800` `star` | `:2772` |
| `meta` (parts joined by `'  ·  '`) | 13/`600` `textDim` | `:2773`, `:288` |
| `Badge` (12+ / HD / 4K / 720p / SD / CC) | border 1 `rgba(255,255,255,0.22)`, fill `rgba(255,255,255,0.08)`, radius 6, ph 8 pv 2; text 12/`900` letterSpacing 1 `text` | `:2793-2801` |
| `actions` | row, wrap, gap 8, marginTop 20 | `:2802` |
| `actionsSecondary` | row, wrap, gap 2, marginTop 8, **marginLeft −16** (the icon row starts at x = 68) | `:2804` |
| `synopsis` | 15, lineHeight 22, `rgba(243,244,248,0.86)`, marginTop 14; **3 lines on a film, 2 on a show** | `:2790`, `:2551`, `:2410` |
| `genreLine` (first 4 genres, `'  ·  '`) | 13/`700` `textFaint`, marginTop 6; films only (shows pass no `genres`) | `:2776`, `:302-306` |
| `cast` ("Cast " + first 4 names) | 13 `textDim`, marginTop 6; label 800 `textFaint` | `:2791-2792` |
| `note` (srcNote) | 13/`700` `accent`, marginTop 8 | `:2836` |

Text passes through `unescapeHtml` (`:128-135`: `&apos; &#39; &quot; &amp; &lt; &gt; &nbsp;` only).

`dense`, `poster` and `titleDense` exist (`:257-262`, `:2750-2758`, `:2770`) but **no caller passes them** at HEAD; `titleDense` would be 30 (= `fontSize.title + 6`), i.e. identical to the normal title.

**Meta parts**: film → `[year, fmtDuration(full.duration) || streamMeta.runtime]` (`:2536-2539`); show → `[year, "N season(s)", "N downloaded"]` (`:2403-2407`). **Badges**: film → `[certificate, resBadge(height,width), 'CC' if subtitles]` (`:2540-2544`), `resBadge` = 4K if w≥3200 or h≥2000, HD if w≥1600 or h≥1000, 720p if w≥1100 or h≥700, else SD (`:116-123`); show → `[streamMeta.certificate, 'CC' if any episode has subs]` (`:2408`). `fmtDuration`: `Nh Mm` or `Mm` (`:101-106`).

### 1.4 Play / Continue button (`PrimaryBtn`, `:371-406`)
- Focusable `round light ring="violet"`, `edgeLeft` + `holdLeft` (`:387-396`), `hasTVPreferredFocus` on both pages (`:2439`, `:2583`).
- Style `playBtn`: white, pv 9 / ph 22, minHeight 40, centred (`:2805`). With the reserved 3 dp border the box is ≥ 40 tall; the violet ring's outer edge sits 7 dp outside it (0.3 §).
- Label 15/`800` colour `bg` (`:2820`). Busy: a `small` `ActivityIndicator` in `bg`, scaled 0.8 inside a 16×16 box, gap 8 before the label (`:397-401`, `:2818-2819`).

**Label state machine — film** (`:2585-2599`):
| condition | label | onPress | onLongPress |
|---|---|---|---|
| owned & resume > 10 s and not finished | `▶  Resume H:MM:SS` (`fmtClock`, `:137-143`) | play (Player with id) | — |
| owned | `▶  Play` | play | — |
| not owned, a job exists | `⬇  Requested` / `⬇  Starting` / `⬇  Saving 37%` (`dlText` lower-cased then capitalised) | downloadBestMovie (says "already on its way") | openSources |
| not owned, `heroDl.busy` | `Getting it…` (+ spinner) | downloadBestMovie | openSources |
| not owned | `▶  Play` | downloadBestMovie | openSources (long press = source list) |

**Show** (`:2438-2451`): `busy ? "Getting S1 E3…" : nextUp.resume ? "▶  Continue S2 E5" : "▶  Play S1 E1"`; press = `heroEp.onPlay()`; long press (only when the hero episode is not owned) opens that episode's sources. `heroEp` = the `nextUp` episode (part-watched owned episode first, else first owned unwatched), else the first episode of season 1 (or of the first listed season) (`:2053-2086`). It is **one button for every state** so a finishing download relabels the focused button instead of remounting it (`:2432-2437`).

### 1.5 The status line under Play (`heroStatusLine`, `:2163-2185`, styles `:2808-2816`)
Rendered inside `actions` as a `flexBasis '100%'` child (so it wraps to its own line), marginTop 6, gap 5. Contents:
1. Optional strip (`movieDlTrack`): width **240**, height 4, radius 2, `rgba(255,255,255,0.14)`, overflow hidden; fill = `epBarFill` + `epBarFillDl` + `movieDlFill` (mint gradient `#7fd1e8 → #8cffbe`, glow `0 0 10px rgba(140,255,190,0.55)`, width `max(2, round(pct×100))%`).
2. `dlLineRow`: row, gap 6; glyph `download` 11 `#8cffbe` when tone = live, `check` 11 `#8cffbe` when ok; text 13 `textFaint` by default (`movieDlHint`), `textDim` when live, `#8cffbe` when ok, `kindFilm #f0c67e` when warn; `numberOfLines 1`.

**Copy** (`dlStatus`, `:569-605`; `name` = "S1 E3" or the film's title):
| state | busy | line | pct | tone |
|---|---|---|---|---|
| job pending | yes | `[Already on its way  ·  ]Requested <name>  ·  waiting for approval` | — | live |
| job, phase copying | yes | `<name> is moving into the library…` | job.progress | live |
| job approved/downloading | yes | `Downloading <name>  ·  best source  ·  37%[  ·  2.1 MB/s]` | job.progress | live |
| note finding | yes | `Getting <name>  ·  finding the best source…` | — | live |
| note already | yes | `<name> is already on its way…` | — | live |
| note ended/ready & owned | no | `Ready — press Play` | — | ok |
| note ended/ready, not yet owned | yes | `Finishing <name>…` | 1 (full strip) | live |
| note failed | no | `note.text` | — | warn |
| not owned, nothing happening | no | `Press Play to save the best source  ·  hold for the list` | — | hint |
| owned | — | *(no line)* | — | — |

`fmtRate`: blank under 30 kB/s, `x.y MB/s` ≥ 1e6, else `N KB/s` (`:558-559`). The speed repaints at most every **2 s** and only when it changed by ≥ 0.1 MB/s (`:1002-1015`).

**Timers** (`:2137-2161`): `ended` → `ready` the moment the library re-read shows the copy; `ready` clears after **30 000 ms**; `ended` with no copy yet re-reads the library after **12 000 ms** and after **30 000 ms** becomes `failed: "<name> isn't in the library yet  ·  press Play to check"`. A job that leaves the list becomes `ended` (or `failed` with `endedText`, `:561-566`: declined → `<name> was declined  ·  hold Play for other sources`; removed/canceled/dismissed → `<name>'s download was removed  ·  press Play to try again`; else `Couldn't get <name>  ·  hold Play for other sources`).

**Press-to-save flow** (`downloadBest` `:1831-1922`, `downloadBestMovie` `:1929-1994`): toasts in order — `Finding the best source for <name>…` ⬇ → then one of `Already yours — it's in the library` ✅ / `<name> is already on its way` ⏳ / `Requested <quality> · <size> — waiting for approval` ⬇ / `Saving <quality> · <size> — the card shows the progress` ⬇ (film: `— Play shows the progress`). Unaired episode: toast `Not aired yet` / `Not scheduled yet` ⏳ and a warn line. A re-press while running: toast `<name> is already on its way · saving 37% — hold for its sources` ⏳. A 1 500 ms later jobs re-read (`:1906-1911`).

### 1.6 The icon row (`IconBtn`, `:408-456`, styles `:2727-2741`)
- Wrapper `iconBtn`: `alignItems center`, **width 66**, pv 2 (five fit the lockup).
- Disc: 40×40, radius 20, fill `rgba(255,255,255,0.10)`, border 1 `rgba(255,255,255,0.14)`; `on` → white fill + white border. Focusable `round ring="none" highlightColor={white}` → on focus the disc fills white (160 ms) and the glyph flips to `bg`; `edgeLeft`+`holdLeft` on the first disc only.
- Icon 18 (`text` / `bg` when lit); text glyph (`⋯`, `≡`) 18/`800` lineHeight 22.
- Label under: 11/`700` `textDim`, marginTop 6, `numberOfLines 1`; `text` while focused (`iconBtnLabelOn`).

Order — film (`:2555-2571`): **My List** (plus/check, `on=inList`, ref = page focus fallback) · **Trailer** (film icon, only when `streamMeta.trailers.length`) · **Versions** (`≡`, only when owned) · **X-Ray** (xray) · **Watched** (check, `on=movieWatched`, only when owned).
Show (`:2414-2431`): **My List** · **Follow/Following** (plus/check, only when `followImdb` known) · **Trailer** · **Similar** (`⋯`) · **X-Ray**.

Toasts: follow → `Following <title> — new episodes will download by themselves` 🔔 / `Stopped following <title>` 🔕 (`:1247-1250`); failure `Couldn't save that` ⚠. My List on this page shows **no toast** (optimistic flip only, `:1189-1214`).

### 1.7 Season pills, "Mark season watched", hint (show page, `:2455-2492`)
- `dockTitle` "Episodes": 18/`800`, lineHeight 24, paddingLeft 84, marginBottom 2 (`:2860-2867`).
- Season `FlatList` horizontal, `style height SEASON_H = 54, flexGrow 0` (`:2841`, `:88`), content `paddingLeft 84, paddingRight 48, gap 8, alignItems center` (`:2844-2849`). Only rendered when **more than one** season (`:2458`).
- Pill: `pill` = `rgba(255,255,255,0.12)`, pv 8 / ph 18, `alignSelf center`, round (`:2850-2855`); on → white fill, text `bg`; `light` when on (white ring with bg gap — **not** violet, `ring` is the default). Text 13/`700` (`:2857`). Label `Season N`. First pill `edgeLeft`+`holdLeft`.
- `seasonTools` row: gap 14, paddingLeft 84, paddingRight 48, marginBottom 4 (`:2842`); shown when the season has ≥ 1 aired episode. The pill label: `Saving…` while busy; `Mark season unwatched` when every aired episode is watched; else `Mark season watched` + ` (N left)` when some are already watched (`:2487`). Then `seasonHint` text `Hold OK on an episode for more`, 13 `textFaint` (`:2843`).
- Marking writes one `markWatched` call for the whole season and toasts `Season N marked watched/unwatched` ✓ (`:2025-2047`).

### 1.8 Episode cards row (`EpisodeCard`, `:654-783`; constants `:68-98`; styles `:2892-3022`)
Constants: `EP_W 202`, `EP_EDGE 1`, `EP_PAD 5`, `EP_ART_W = 190`, `EP_ART_H = round(190×9/16) = 107`, `EP_THUMB_H = 119`, `EP_BODY_H 102`. (`LIKE_H 240` and `RAIL_H 237` are computed and unused.)

Rail: horizontal `FlatList` keyed `season-<n>` (remounts on season change, `:2497`), `style flexGrow 0`, content `paddingLeft 84, paddingRight 48, paddingVertical 28 (CLEARANCE.above), gap 14` (`:2874-2879`), `initialNumToRender 6, windowSize 5`. While `loading && !curSeason` an `ActivityIndicator` sits at left 84 with marginBottom 32 (`:2887`).

**Card box** (`epCard`): width 202, radius 12, **border 1** `rgba(226,229,238,0.3)`, fill `surface`, padding 5, paddingBottom 8 → height **224** (1+5+107+102+8+1). Owned → border `rgba(74,222,128,0.38)`; up-next → border `rgba(139,123,255,0.5)` (up-next wins when both, `:705`). Focusable: `scaleTo 1.045`, `lift 3`, `shadow 0 18px 36px rgba(0,0,0,0.6)`, `highlightColor rgba(255,255,255,0.04)`, first card `edgeLeft`+`holdLeft`, press = `onPlay`, long press = actions sheet (`:689-705`). The 3 dp white ring is drawn at inset 0, i.e. over the 1 dp edge and the first 2 dp of padding.

**Glow strip** (`epOwnedGlow`, `:2909`): absolute top 0 left 0, **200×222** (the padding box), radius 11, `resizeMode stretch`, no fade. Assets are 8×128 RGBA, alpha 0 at the top rising to the bottom as roughly `t^1.55`: `owned-glow.png` colour `(74,222,128)` → alpha 76/255 (0.30) at the foot; `upnext-glow.png` `(139,123,255)` → 87/255 (0.34); `owned-upnext-glow.png` colour lerps `(139,123,255)` at the top to `(74,222,128)` at the foot, alpha as up-next (sampled from the PNGs; no generator script is in the repo — **[KEEP-AS-IS?]** regenerate by sampling, not by formula).

**Still** (`epThumb`): width 100 % of content (190), height 107, top radii 8 only, fill `bgRaised`, overflow hidden (`:2913-2927`); image fills, `cover`, `resizeMethod` `auto` when server-sized else `resize`, no fade (`:717-723`); URL `artSrc(ep.thumb, 190)` → `?w=` snapped (380 px @2× → 448).

**Timeline bar** (`epBar`, `:2955-2985`): absolute left 5 / right 5, `top = 5 + 107 − 2 = 110`, height 3, track `rgba(255,255,255,0.14)`. Fill: `#8b7bff` with gradient `90deg #8b7bff → #a6c8ff`, glow `0 0 10px rgba(139,123,255,0.6)`; download variant mint `#8cffbe` with `90deg #7fd1e8 → #8cffbe`, glow `rgba(140,255,190,0.55)`; width `max(2, round(progress×100))%` for a download, `pct%` for watch progress; a 7×7 white bead at `right −3, top −2`, radius 4, glow `0 0 8px rgba(255,255,255,0.9)`. Drawn when `ep.dl` (download first) else when `ep.pct > 0`.

**Body** (`epBody`): height 102, paddingTop 8, paddingHorizontal 3, `justifyContent space-between`; opacity 0.6 when not aired (`:2989-2991`).
- Kicker row gap 5: `EPISODE N  ·  53 MIN` (or `EPISODE N  ·  STARTING` / `SAVING 37%` / `REQUESTED` while a job runs, then a `download` icon 11 `#8cffbe`); 10/`700`, lineHeight 14, letterSpacing 0.9, `rgba(243,244,248,0.7)`; `#8cffbe` while downloading (`:751-757`, `:2993-2999`, `dlText` `:540-545`).
- Title 13/`800`, lineHeight 18, letterSpacing −0.1, marginTop 2, 1 line (`:3000-3007`).
- Overview 12, lineHeight 16, `rgba(243,244,248,0.62)`, marginTop 3, 2 lines (`:3008`).
- Foot row (height 18, gap 6): `Date TBA` (12/`600` `textFaint`) · or a `play` icon 11 + air label (`29 Sep` / `12 Mar 2024`, `fmtAirDate` `:612-618`; `textFaint` when upcoming else `textDim`) · `CC` badge (10/`900` ls 0.8 `textFaint`, border 1 `line`, radius 4, ph 5) · spacer · `check` 14 `textDim` when watched (`:767-779`, `:3009-3022`).

Air states (`resolveAirStates`, `:635-648`): a dated future episode = `upcoming`; a date-less episode numbered after the last dated one = `tba`; everything else = `aired`; a local file is always `aired`.

**Long-press actions sheet** (`episodeActions`, `:1995-2019`): not owned → `Sources` (tag `streams and downloads`), `Mark watched/unwatched` (`ticks it off` / `back to unseen`); owned → `Mark …`, `Play` (`your copy`), `Sources` (`other versions`). Title = episode name, kicker = `<show> · S1 E3`. Toast after marking: `S1 E3 marked watched` ✓.

**Focus keeper** (`:1759-1823`): after a press-to-save from a card, that card is watched until 3 s after the request lands; if it blurs and nothing else gains focus (`focusJustMoved` false), focus is handed back after **180 ms** (blur) or on the next tick (remount).

### 1.9 "More like this" (film shelf and the show's overlay)
Film page shelf (`:2602-2622`): `dockTitle` "More like this"; `likeRailContent` paddingLeft 84, paddingRight 48, paddingTop 20, paddingBottom 8, gap 14 (`:2880-2886`); standard `Card` (124×186), first card `edgeLeft holdLeft`, `initialNumToRender 8, windowSize 5`; empty → `Nothing close enough to suggest.` 13 `textDim` at paddingLeft 84, paddingTop 14 (`:2868`); loading → spinner at left 84.

Show page overlay (`moreOverlay`, `:2286-2332`; styles `:2665-2696`): absolute full, **opaque `bg`**, zIndex/elevation 10, paddingTop 40, paddingLeft 84, paddingRight 48; `useKeyTrap`, `TVFocusGuideView autoFocus` + four traps; BACK closes. Head row gap 14 mb 8: title 24/`900` "More like this"; sub 13/`600` `textDim` mt 2 = `<title> · <genre1> · <genre2>`; `‹ Back` pill `rgba(255,255,255,0.14)` border 1 same, pv 8 / ph 18, text 13/`700`. Grid: `numColumns = max(3, floor((width − 84 − 48 + 14)/(124 + 14)))` = **6** @960 (`:2265-2268`); content paddingTop 28 / paddingBottom 61; row gap 14, marginBottom 14; first card `hasTVPreferredFocus`; spinner centred while `similar === null`; failure text `Couldn't find similar titles right now — try again later.` 15 `textDim` mt 32. Data = top-rated in genre 1 then trending in genre 2, self removed, max 18 (`:1350-1408`).

### 1.10 The inline Sources panel (`sourcesOverlay`, `:2334-2385`; `SourcesPanel embedded` in `screens/Sources.tsx`)
Shell (`srcOverlay`, `:2635-2661`): absolute full, **opaque `bg`**, zIndex/elevation 10, row, paddingTop 56, paddingLeft 84, paddingRight 48, paddingBottom 20, gap 32. `useKeyTrap`, `TVFocusGuideView autoFocus` + four traps; BACK closes (`:1427-1435`); the rail is `disabled` while up.

Left column `srcLeft` width 190 (`:2698-2701`): poster `artSrc(item.cover||poster, 190)` 190×285, radius 12, `bgRaised`, `fadeDuration 160`; label 24/`900` mt 14 (`item.title` or `S1 E3`), 2 lines; sub 13/`700` `textDim` mt 4 (the show title for an episode). Right column flex 1 (606 dp @960).

**SourcesPanel (embedded)** — `Sources.tsx`:
- Head row gap 14 mb 14 (`:772`): poster 46 wide 2:3 radius 8; heading 24/`900` `<title>  ·  S1 E3`; sub 13/`600` `textDim` mt 2 = `N sources` / `No sources` / `Finding sources`; `‹ Back` pill (`rgba(255,255,255,0.14)`, border 1, pv 8 / ph 18, text 13/`700`) which takes preferred focus only when there is nothing else to focus (`:660-666`).
- Toast line (panel-local, not the app toast): 15/`700` `accent`, mb 8, **4 000 ms** (`:406-411`, `:786`). Copy: `Requesting…`, `Already yours — it's in the library`, `Already queued. Patience.`, `Download requested — the server is low on space, so it needs admin approval.`, `Downloading now! Go grab some popcorn.`, `Couldn't request the download`, `Saved to your library — it plays instantly now`, `<error>` / `That download failed`.
- **Owned row** (pinned above the list, `:674-701`): same row geometry; quality badge says `Yours` in `#4ade80`; title `In your library`, meta `Plays instantly` (green 13/`700`); right side a green pill (`#4ade80`, pv 7 / ph 16, gap 6, play icon 16 `bg`, `Play` 13/`900` `bg`). Takes first focus when present at first paint (`:459-462`).
- Loading: spinner + `Finding sources…` 15 `textDim`, paddingTop 80 gap 14. Errors: `Could not reach the source provider.` / `No sources with active peers.` in `#ff8080` 15 mt 20.
- List: `FlatList`, content `paddingBottom 32, gap 8`; rows ordered done → active → server rank (`:345-363`).
- **Row** (`rowWrap` row gap 8): main Focusable `row` flex 1, row, gap 14, fill `rgba(255,255,255,0.07)`, border 1 `rgba(255,255,255,0.08)`, radius 12, padding 14, `scaleTo 1.01`, `highlightColor surfaceHover` (`:797-809`). Quality badge: border 1 in quality colour (2160p `#c084fc`, 1080p `#60a5fa`, 720p `#34d399`, 480p `#fbbf24`, SD `#9aa1b5`), radius 8, pv 4 / ph 10, minWidth 66; text 13/`800` same colour (`:147-153`, `:810-811`). Title line: first 4 tags `'BluRay · DD+ · H.265'` 15/`700` (ellipsizes), then the job badge (`✓ DOWNLOADED` white-on-green 11/`900` ls 0.8 radius 4; `⬇ DOWNLOADING` / `⏳ QUEUED` / `⏳ NEEDS APPROVAL` outlined `#60a5fa`), `Best` (`#f5c542`), `Cam` (`#ff8080`), `Dub` (`#fbbf24`) pills 12/`900`, border 1 at 45 % alpha of their colour, radius 4, ph 6 pv 1 (`:816-818`). Meta line (gap 14, mt 4, wrap): `N seeders` 13/`800` coloured ≥30 `#34d399`, ≥5 `#fbbf24`, else `#9aa1b5`; or the live job line in `#60a5fa` (`#f87171` on error); size 13/`600` `textDim`; up to 4 languages `+N`. A row whose job is done and whose copy is resolved shows `In your library · plays instantly` and a `play` icon 22 on the right, and the row itself turns `rowOwned`: border `rgba(74,222,128,0.45)`, gradient `90deg rgba(74,222,128,0.12) → #17181f 60%` (`:827-833`).
- **Stream** button (hidden once the copy is yours): width 76, `rgba(255,255,255,0.05)`, border 1 `rgba(255,255,255,0.12)`, radius 12, gap 2, `⚠` `#fbbf24` 16/lh 20 over `STREAM` 10/`900` ls 1 `textDim`; `scaleTo 1.03` (`:563-573`, `:859-870`).
- **Save** button: width 76, `surface`, radius 12, `scaleTo 1.03`; idle = `download` icon 22 + `SAVE` 10/`900` ls 1 `textDim` mt 2; with a job = `dlFace` (`✓` / `⏳` / `⋯` / `→` / `37` / `!`) 15/`800` (13/`900` inside a ring) and, when a percentage exists, an SVG ring 44 dp, r 19, stroke 4, track `rgba(255,255,255,0.14)`, sweep `accent`, round caps, starting at 12 o'clock (`:124-145`); done → border `rgba(74,222,128,0.4)` fill `rgba(74,222,128,0.10)` glyph green; error → border `rgba(248,113,113,0.45)` fill `rgba(248,113,113,0.08)` glyph `#f87171` (`:576-608`, `:845-856`).
- Row press = **Save** (or play the copy once done); Stream is the smaller secondary button (`:494-499`). Jobs poll every **3 000 ms** while any is active (5 000 after a failure), re-armed by a press (`:263-338`).

### 1.11 Focus, keys and BACK on Detail
- Preferred focus on arrival: the Play/Continue button (`:2439`, `:2583`). Page focus fallback: the My List disc (`:846-847`).
- LEFT from Play, the first icon disc, the first season pill, the Mark-season pill and the first episode/shelf card is held (`holdLeft`) and marked `edgeLeft` → opens the nav rail (`:365-370`, `:2416`, `:2470-2471`, `:2485`, `:2206`, `:2276`).
- UP/DOWN are the native focus search inside one vertical ScrollView; the rail's focused card scrolls the page to its end.
- OK on a card: owned → Player; not owned → press-to-save; **hold OK** → actions sheet. Hold on Play (unowned) → sources.
- BACK: with the Sources or More-like-this overlay up, closes it (`:1427-1435`); otherwise react-navigation pops.
- Navigation guard: `canNavigate` = screen focused and ≥ **350 ms** since the last push (`navLock.ts:12-22`).
- Watch progress is re-read on every focus of the screen (`:1498-1513`); jobs are read on arrival, on socket `download_update` / `download_removed` / `welcome` / `library_updated`, every 10 s while a job shows with the socket open, every 4 s when it is shut (`:1528-1617`).

### 1.12 Trailer from the title page
`Trailer` disc → `openTrailer(ids, title, {imdbId, type, year})` (`:2422`, `:2559`) — the full-screen TrailerModal in 11b. The page **pre-resolves** the trailer the moment `streamMeta` lands (`prepareTrailer`, `:811-821`, `maxYoutube 2`) so the modal usually opens straight into `loading`.

### 1.13 Native mapping notes — Detail
- **Layout**: one `NestedScrollView`/`ScrollView` with a `LinearLayout` column; `paddingTop = round(h×0.22)`, `paddingBottom = safeBottom`. Lockup `maxWidth = 0.42 × (960−84−48)` must be computed, not a percent of the screen.
- **Art box**: `ImageView` with `scaleType centerCrop` inside a `FrameLayout` at `(0.30w, 0, w, 0.76h)`; the 260 ms fade = `TransitionDrawable`/alpha `ObjectAnimator` 260 ms linear (RN's `fadeDuration` is Fresco's linear fade). The poster-as-backdrop case needs a **28 px box blur** (`RenderEffect.createBlurEffect(28,28)` on API 31+, or a pre-blurred bitmap); the sharp/blurred decision is data-driven (§1.2).
- **Mask**: draw `detail-mask.png` stretched full-screen with `FILTER_BILINEAR`; do not re-derive it as two `GradientDrawable`s — the seam behaviour at the 30 % edge is baked into the 3.5 px lead and the ambient colour.
- **Text shadows**: `TextView.setShadowLayer(24, 0, 3, 0x80000000)` for the title; note Android's shadow radius is a blur radius like RN's `textShadowRadius`.
- **Pills/buttons**: `GradientDrawable` with `cornerRadius 999`; the Focusable's reserved 3 dp border becomes 3 dp of padding on the focus-ring overlay, with the ring drawn by a `foreground` drawable whose alpha animates 160 ms on `bezier(0.2,0.7,0.2,1)` (`PathInterpolator`). Scale: `SpringAnimation` (`SpringForce` stiffness ≈ 180 → Android stiffness is in different units; match **by settle time ≈ 160–200 ms with a hair of overshoot**, not by the RN numbers). The light ring = two extra ring drawables at −3 and −7 dp with `clipChildren=false` on the parent row.
- **Episode card**: `MaterialCardView`-like `FrameLayout` 202×224, stroke 1, radius 12; the glow strip is an `ImageView` 200×222 `fitXY` behind the content with 11 dp corner clip (`outlineProvider`). The timeline fill's horizontal gradient + glow = `GradientDrawable` (LEFT_RIGHT) plus a `BlurMaskFilter`'d paint or a pre-rendered 9-patch; the 7 dp bead with glow is cheapest as a small pre-rendered bitmap.
- **Gradients with `experimental_backgroundImage`** (`epBarFill`, `rowOwned`, X-Ray panel, player menu) all map to `GradientDrawable` with explicit `setColors` + `setOrientation`; angle 140° (menus/X-Ray) needs `GradientDrawable.Orientation` approximated to **TL_BR** — Android has no arbitrary-angle gradient drawable; use a `ShaderFactory` with `LinearGradient` for exactness.
- **Cannot be identical**: RN `boxShadow` on Android is a drawn blurred rect (RN 0.76+); Android `elevation` shadows differ in colour and spread. Use `ViewOutlineProvider` + `setOutlineAmbientShadowColor/SpotShadowColor` (API 28+) or a baked shadow bitmap for the card shadow `0 18px 36px rgba(0,0,0,0.6)`; accept a small spread difference or bake it. The emoji glyphs (`⋯ ≡ ⚠ ⏳ ✓`) render from the TV's emoji font in both runtimes — identical only if the same system font is used.

---

## 2. Closing summary — what is hardest to make identical in this scope
The pixel geometry is all explicit and ports cleanly; the hard parts are the *dynamic* ones. (1) The focus treatment: RN's spring (`tension 180 / friction 14`) and the 160 ms bezier ring fade run on two independent natively-driven values, with the previously lit ring fading out in parallel, the "light" variant drawing two rings *outside* the view's bounds, and `hasTVPreferredFocus` disarmed after 600 ms — Android's `SpringAnimation` uses different units and view-bounds clipping, so settle time and overshoot have to be matched by eye, and the out-of-bounds rings need `clipChildren=false` up the whole ancestor chain. (2) The player chrome's state machine: seven overlapping timers (7 s hide, 450 ms seek debounce, 900 ms skip chain, 4.2 s toast, 25/90 s slow-start, 25 s re-buffer watchdog, 4-attempt/30 s recovery budget) and the far-seek probe/retire protocol are what the viewer actually feels, and they are entangled with ExoPlayer events in ways that `react-native-video` currently mediates (buffering flags, `seekableDuration` growth, the frozen-while-buffering cue clock). (3) The baked PNG ramps (`detail-mask`, `player-top/bottom`, the three glow strips, `hero-side`) carry smoothstep curves, an ambient-coloured mask and a 3.5 px anti-seam lead that no `GradientDrawable` reproduces — ship the same PNGs. (4) `boxShadow`/`textShadow`/`experimental_backgroundImage` at arbitrary angles have no exact Android drawable equivalent and will need shader-backed custom drawables or pre-rendered bitmaps. (5) The X-Ray sheet's rise (`stiffness 190, damping 20, mass 0.9` on translateY/scale with a fade keyed to the first 40 % of the same value) and the player flash/skip-hint micro-animations are small but visible, and must be re-tuned rather than copied numerically.

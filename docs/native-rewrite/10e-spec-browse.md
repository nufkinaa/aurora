# 10e · Browse (Movies / Shows) — 1:1 spec

Part of [10-spec-home-nav-cards.md](10-spec-home-nav-cards.md). Lines are of `tv-native/src/screens/Browse.tsx` and `components/Picker.tsx` (working tree = HEAD).

Route params `{kind: 'movie' | 'show'}`; title `'Shows'` / `'Movies'` (:110-111). Rail section `shows` / `movies` (:786).

---

## 1. Constants (:63-80)

`GRID_GAP 13`, `SKELETONS 18`, `PANEL_W 300`, `STRIP_W 44`, `PREFETCH_ROWS 2`, `BACKOFF = [3000, 8000, 20000]` ms.

Columns (:118-121): `cols = max(3, floor((width − 84 − 44 − 8 + 13) / (124 + 13)))` → **6** @960 (837/137). The grid is left-aligned under `contentLeft`; the residue stays on the right (:812-814).

Categories (:93-100), verbatim labels: **All** (`trending` + local library first), **Trending**, **New**, **Top rated**, **For you** (`trending`, taste-ranked), **Downloaded** (local only).

---

## 2. Layout

Root `View flex 1` (no background, :798); page `Animated.View flex 1` with `useScreenIn()` (opacity 0→1, translateY 10→0, 280 ms bezier) (:660, :799).

### 2.1 Header (`head`, :663-672, :800)

`flexDirection row, alignItems baseline, gap 16, paddingTop 27, paddingBottom 2, paddingLeft 84, paddingRight 44 + 8 = 52` (`frame`, :793).
* `h1` (:802): `color #f3f4f8, fontSize 24, lineHeight 39, fontWeight 900, letterSpacing −0.52`.
* `count` (:803): `color #616880, fontSize 16, lineHeight 24, fontWeight 600, flexShrink 1`, 1 line.
* spacer `flex 1`.
* `active` (:807): `color #9aa1b5, fontSize 16, lineHeight 24, fontWeight 700, flexShrink 1`, 1 line = `[category label, genre, 'Unwatched' if on].join(' · ')` (:670).

**Count string** (:621-630):
* library needed but unknown: `''` if the library read failed, else `'Loading…'`;
* Downloaded: `'{n} downloaded'`;
* catalogue first page pending: `('{owned} downloaded · ' if owned) + ("the rest didn't load" if failed else 'loading the rest…')`;
* otherwise `('{owned} downloaded · ' if owned) + '{n − owned} to stream' + (' · more available' if hasMore)`.

### 2.2 Grid (`FlatList`, :698-720)

* `key = {kind}-{cols}`, `numColumns cols`, `keyExtractor = id || imdbId || title`, `style flex 1`.
* `columnWrapperStyle rowGap` (:814): `gap 13, marginBottom 13`.
* `contentContainerStyle grid` (:811): `paddingTop 28` (CLEARANCE.above), `paddingLeft 84, paddingRight 52`, `paddingBottom 61 + safeBottom` (**88** @540). **No cancelling margins** (a recycled cell cannot carry them, :809-810).
* `initialNumToRender 24`, `maxToRenderPerBatch 12`, `removeClippedSubviews`, `windowSize 3`.
* Cells: default poster `Card` (124×186 + 3 dp focus border each side → cell 130×192), `edgeLeft = index % cols === 0`, `edgeRight = index % cols === cols − 1`, `hasTVPreferredFocus = claims(index)` (first card, once, when the grid first fills and the library — if needed — is known, :583, :592-608). Column pitch = 130 + 13 = **143**; row pitch = 192 + 13 = **205**.
* Footer (:643-656, `footer`: `alignItems center, paddingVertical 14`): `MiniSpinner` while loading a page; a `small` surface `Btn "Retry"` when the first page failed under a library grid; Text `note` (`color #616880, fontSize 14, fontWeight 600, marginTop 2`, :853) `"Couldn't load more — trying again"` when a next page failed; none for Downloaded or an empty list.

### 2.3 Skeleton state (:680-685, :815)

`skelGrid`: `flexDirection row, flexWrap wrap, gap 13, paddingTop 28, paddingLeft 84, paddingRight 52`, **18** `Skeleton` cells 124×186 r12 (10a-spec §6). Shown when nothing is known yet and nothing failed (`holdForLib`, or empty list while loading/pending) (:638).

### 2.4 Failed and empty (:674-696)

* `failed` (:636) → `ErrorState message "Couldn't load — the server took too long or the connection dropped"`, `detail 'Trying again…'` while an automatic retry is scheduled, Retry = `retryAll`.
* `items.length === 0` → `Empty glyph 🍿`, message `Nothing in {genre} here. Try another genre?` or `Nothing matches. Try fewer filters?`, action **"Change filters"** → opens the panel.

### 2.5 Edge strip (passive; :726-734, :819-830)

Absolute `top 0, right 0, bottom 0, width 44, alignItems center, paddingTop 27 + 8 = 35, zIndex 100`, `pointerEvents none`, **opacity = 1 − slide**. Contains `tune` (`gap 4, alignItems flex-end, width 18`): three bars `height 2, borderRadius 1, backgroundColor rgba(255,255,255,0.35)` of widths **18, 12, 6** (right-aligned).

---

## 3. Filter panel (mounted while `panel`; :736-781, :831-854)

* `panel`: absolute `top 0, right 0, bottom 0, width 300, backgroundColor #0a0b14, borderLeftWidth 1, borderLeftColor rgba(255,255,255,0.09), zIndex 101`; `transform translateX = slide ∈ [0,1] → [300, 0]`.
* **Open animation**: `slide` 0 → 1 over **280 ms** `bezier(0.2,0.7,0.2,1)` (:538-547). **Close is instant**: `slide.setValue(0)` and unmount, no slide-out (:516-518) **[KEEP-AS-IS?]** (asymmetric with the rail, which animates out).
* Inner `TVFocusGuideView autoFocus` + all four traps (:745-751), `panelInner` (:848): `flex 1, paddingLeft 18, paddingRight 48, paddingTop 18, paddingBottom 27`. Contents top to bottom:
  1. kicker Text (:752, :849): `color #8b7bff, fontSize 13, fontWeight 800, letterSpacing 3, marginBottom 4` = title upper-cased (`MOVIES` / `SHOWS`).
  2. `cats` (`alignItems flex-start`, :850): six **bare** `Chip`s, `on = category === id`, `hasTVPreferredFocus` on the active one (focus lands there on open); pressing the active one does nothing (:753-764).
  3. `rule` (:765, :851): `height 1, backgroundColor rgba(255,255,255,0.09), marginVertical 4`.
  4. `Picker label "Genre"` with options `All genres` ('' ) + the server's genre list (:766-772) — see §4.
  5. `toolRow` (`flexDirection row, alignItems center`, :852): a **surface** `Chip "Unwatched"` toggling `on` (:773-775).
  6. `note` (when "For you" without a genre): `From your {g1, g2, g3}` (:631-632, :776).
  7. spacer `flex 1`.
  8. `small` surface `Btn glyph 🎲 label "Surprise me"` (:778).
  Budget on a 540 canvas (comment :845-847): 18 + 24 + 6×48 + 9 + 48 + 48 + 48 + 27 = 510 (chips are ≥ 54 with the Focusable border, so the real stack is tighter than the comment).

### 3.1 Panel behaviour

* **Open**: `right` while `atRightEdge()` (focus on a last-column card), the rail closed, and `!focusJustMoved(120)` (:554-559); or the Empty state's "Change filters". `restore = captureFocus(); dirty = false` (:509-513).
* **Close**: `left` (:561), **BACK** (:566-573), or a Surprise pick. If a filter changed (`dirty`): the list scrolls to offset 0 (no animation) and focus goes to the **first card**; else focus returns to the card it came from (:516-533).
* While the panel or the genre picker is open, `NavRail disabled` → **the rail (even its strip) is not drawn** (:786).
* Filter pick (`pick(fn)`): marks dirty and applies; the catalogue list resets and re-fetches (cached per `kind|category|genre` for the session, :259-263, :289-296).
* **Surprise me** (:481-494): random pick from library + fetched catalogue; closes the panel first (or captures focus), then **60 ms** later pushes `Detail`; when Browse is focused again the same element is re-focused.

---

## 4. `Picker` (`Picker.tsx`) — the genre dropdown

* Button: `Focusable round` (white ring), `styles.btn` (:154-163): `flexDirection row, alignItems baseline, gap 8, minHeight 48, paddingVertical 8, paddingHorizontal 16, borderRadius 999, backgroundColor rgba(255,255,255,0.06)`; absolute `edge` child `borderWidth 1, borderColor rgba(255,255,255,0.09), radius 999` (:164-173), brighter `rgba(255,255,255,0.35)` when a value is set (`edgeSet`, :176). Texts: label `#616880 16 600`, value `#f3f4f8 16 700` (`'All'` when none), caret `▾` `#616880 16 700` (:178-180).
* **Dropdown** (`open`): `TVFocusGuideView` trapping all four directions, `styles.panel` (:181-192): absolute `left 0, minWidth 200, padding 6, borderRadius 14, backgroundColor #131523, borderWidth 1, borderColor rgba(255,255,255,0.09), boxShadow '0 22px 60px rgba(0,0,0,0.6)', zIndex 291`; placed **below** (`top 100%, marginTop 6`) or **above** (`bottom 100%, marginBottom 6`) the button — above when `y − 14 > height − (y + h) − 14` (:53-67); `maxHeight = min(round(height × 0.6), max(96, room))` (**324** cap @540). Inside a `ScrollView` of `Focusable noScale ringWidth 2 ringColor #ffffff highlightColor rgba(255,255,255,0.11)` items (:117-141): `height 48, justifyContent center, paddingHorizontal 12, borderRadius 9`; text `#9aa1b5 16 600`, selected `#f3f4f8 16 800` (:196-198). The current value (or the first row if the value vanished) gets `hasTVPreferredFocus`.
* `useKeyTrap(open)`: every outside key handler is deaf while open; closing returns focus to the button (:72). BACK closes (:76-83). Re-picking the current value does not reset the grid (:131-136).

---

## 5. Data behaviour (not pixels, but visible)

* Library read on mount / kind change; on failure the grid is **held** (skeletons, count `''`) and retried at 3 s / 8 s / 20 s only while the screen is on top, then only by Retry (:160-196).
* Catalogue page 0 per `kind|category|genre`; failure → error with the same backoff (:272-341). Next pages: fetched when the focused index ≥ `count − cols × 2` (:584-591), appended with de-dupe by key (:382-423); a failed next page waits the backoff and retries by itself if focus is still near the end (:406-421).
* `visible()` rules (:434-460): library titles (alphabetical, genre/unwatched-filtered) first when the category asks; catalogue items lacking an `imdbId` or whose normalised title is in the library are dropped; "For you" floats liked-genre items (profile's liked genres, else the library's top-6 genres) to the front.
* `library_updated` → the library shelf re-reads after 2.5 s; catalogue pages on screen do not move (:220-243).

---

## 6. Native mapping notes

* Grid: a `RecyclerView` with `GridLayoutManager(6)` **is** acceptable here (unlike the shelves) because the list never animates its scroll on focus beyond Android's default bring-into-view — RN's `FlatList` here is a vertical `ScrollView` with native focus-driven scrolling (`removeClippedSubviews`, clearance as padding). Keep `clipToPadding=false`, item decoration gap 13, top padding 28, bottom 61 + safeBottom.
* Panel/strip: overlays at elevation 100/101; slide-in `ValueAnimator` 280 ms `PathInterpolator(0.2,0.7,0.2,1)` on `translationX 300→0` and strip alpha; close by removing the view at once.
* Picker dropdown: a child view anchored to the button with the above/below rule; trap focus inside; the `boxShadow` per 10-spec §8 (σ = 30 px).
* Skeleton shimmer and MiniSpinner per 10a-spec.

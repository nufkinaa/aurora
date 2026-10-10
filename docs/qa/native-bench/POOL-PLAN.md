# The recycling shelf and the recycling grid — what was built, and what the TV has to say

Branch `native-lab-pool` (from `native-lab` @ 60f1a15). Built **offline**: nothing below has
been on a device. Everything that can be proven without one is proven by
`tv-native/tools/gen-pool-fixtures.js` (860 focus walks) and `PoolMathTest` (JVM); the rest
is listed in §5 as exact device checks with pass criteria.

Two switches, both off by default:

| switch | what it turns on | needs |
|---|---|---|
| `exp pool=1` | the recycling shelf (Home's rows) | `impl row=native,card=native` (ignored otherwise) |
| `impl grid=native` (letter **G**) | the recycling grid (Browse: Movies / Shows) | nothing — works over a JS or a native card |

---

## 1. The problem, in the numbers the code implies

Today's native row (`NativeRow`, P3-lite) keeps a window of cards mounted around the focused
one — 3 behind, 5 ahead, re-anchored when focus is 3 away — as React children **keyed by
title**. Every re-anchor React unmounts the cards that left and mounts the ones that entered:
per card an `AuroraFocusable`, two `AuroraCard` layers, the overlay view, plus its texts,
pills and bar — created and deleted through Fabric on the UI thread.

`gen-pool-fixtures.js` counts it (JS up to date, a 40-card shelf):

| walk | window moves | keyed window (today) | pool |
|---|---|---|---|
| `hold-right-12` (states/row.json) | 4 | **12 cards mounted, 9 unmounted** | 3 mounted, 0 unmounted, 9 rebound |
| hold right to the end (43 presses) | 13 | 34 mounted, 36 unmounted | 3 mounted, 5 unmounted, 31 rebound |
| right to the end and back | 26 | 70 mounted, 70 unmounted | 8 mounted, 8 unmounted, 62 rebound |
| bench S1 (RIGHT×20, LEFT×20 @50 ms) | 12 | 33 mounted, 33 unmounted | 3 mounted, 3 unmounted, 30 rebound |

The pool's few mounts are all at the two ENDS of a shelf, where the reference window itself is
shorter than 9 (§3.2 says why they were kept). In the middle of a shelf a window move mounts
nothing.

---

## 2. Text: which of the three ways, and why

* **(a) keep nine real React cards and have native rebind their props without a commit.**
  Not possible: an RN `<Text>`'s content is not a view prop, it is a shadow-tree
  (`ParagraphShadowNode`) attributed string measured by Yoga on the JS/Fabric side. Native
  cannot change it behind React's back, and a size change (a pill is as wide as its word)
  needs layout.

* **(c) the slots stay mounted; JS rebinds them in ONE commit that changes props only.**
  **Chosen and built.** Reasons:
  1. *Text stays RN `<Text>`* — the same component, the same `TextLayoutManager`, the same
     Yoga measure. There is nothing to compare: it is 1:1 by construction.
  2. *The cost that is being removed is the mount, not the commit.* A rebound slot is, for a
     plain poster, two prop updates (the art layer's addresses, the slot's `left`) on views
     that exist; a mount is ~10 creates, ~10 inserts, a layout of each, and the mirror-image
     deletes. The commit itself is already off the input path (`startTransition`).
  3. *It needs no new native drawing code*, so it cannot introduce a pixel difference in a
     card. The only native addition is the paint order (§3.3), which is one sort.
  4. The scheme makes "which slot" trivial and provable: item *i* lives in slot *i mod 9*.

  What (c) does **not** remove: a React render + commit per window move (the row and
  the three rebound cards re-render, in a transition), the prop diff, and — when two items differ in SHAPE — the
  mount/unmount of the small optional children (the `NEW` pill, the kind pill, the progress
  bar and the label block are conditional children of the card). The `[pool]` log's `desc=`
  field counts exactly those (§5.3).

* **(b) the row owns nine card instances and draws their text itself** — the further step,
  **not built**. Written up in §7 with what would have to be pixel-checked. It removes the
  React commit as well, at the price of re-implementing RN's text layout; it should only be
  started if the device numbers of (c) still show the p99 frames that started this.

---

## 3. Step 1 — the recycling shelf (`exp pool`)

### 3.1 Contract

* `src/poolMath.ts` — pure functions, no imports. `slotOf(i, pool) = i mod pool`;
  `slotItems(from, to, pool)` → slot → item (or −1); `poolAnchor(prev, index, latest, count,
  slack, behind, ahead)` = Row.tsx's anchor rule with one guard (below).
  Kotlin twin: `android/.../ui/pool/PoolMath.kt`.
* `src/components/Row.tsx`, `NativeRow` — one branch. With `exp('pool') && impl.card`:
  * the window is **the reference window**, `windowRange(anchor, count)` of `rowMath.ts`,
    moved at the same moment (the track's `onItemFocus`, deferred with `startTransition`);
  * the children of `AuroraRow` are the nine slots, **keyed by slot number and listed in
    slot order**; slot *s* renders the one item of the window with `i mod 9 == s`, at
    `left = contentLeft + i * step`, or nothing when the window has no such item;
  * the card gets the same props as today (`item`, `index`, `onPress`, `wide`, `frame`,
    `showKind`, `onRemove`, `edgeLeft = index === 0`).
* `AuroraRowView.kt` — under `pool` it paints its children in shelf order (by `left`) instead
  of child order (`PoolHost.kt`). Always (switch on or off) it counts mounts for the QA log.
* No change to `AuroraCardView`, `AuroraFocusableView`, the specs, or the row's slide.

### 3.2 What follows from that

* **A card that stays in the window keeps its slot** (same key, same props → `React.memo`
  skips it: not re-rendered, no prop touched, no layout). The focused card is in every window
  the rule produces, so **its slot is never rebound** — proven for every walk, including with
  the anchor update running 1, 2, 3 and 6 presses late.
* **A slot whose item left is handed the item that entered**: React re-renders that one
  `Card` with a new `item`; Fabric updates props on the existing views; Yoga moves the slot
  (`left`). No view is created, deleted, or moved in its parent's child list.
* **The mounted set is exactly today's**, card for card and commit for commit. That is why the
  pool is *not* padded to nine at the ends of a shelf: at anchor 0 the reference mounts cards
  0‥5 only, and card 6 (left = 84 + 6 × 138 = 912 dp) would be ON SCREEN — mounting it early
  would change the picture. So a slot is mounted or unmounted only when the window changes
  length: three cards at the first move off the head of a shelf, and the mirror at its tail.
  Same reasoning forbids "parking" a tail slot instead of unmounting it: a parked card one
  place behind the window can sit under the row's left fade, where the reference has nothing.
* **The guard in `poolAnchor`.** The reference rule moves the anchor to the index an event
  reported, whatever focus has done since. If JS is several presses behind a *reversal*, that
  window can exclude the card that is focused *now*: the reference then unmounts the focused
  card (focus falls to the fallback); a pool would hand its slot to another item. `poolAnchor`
  refuses a move whose window would not contain `latest` — the newest focus JS has heard of —
  and keeps the old window; the following events settle it. With JS up to date the guard never
  acts (asserted: the anchor equals `nextAnchor` on every step of every walk at lag 0; in the
  walks it first acts at a lag of 6 presses). **Residual, not closable from JS:** `latest` is
  what JS has *handled*; focus the UI thread has moved since is unknown to it. To defeat the
  guard focus must travel ≥ 4 cards back, or 6 on, between a commit being computed and
  mounted — at 50 ms a press that is 200 ms of a blocked UI-to-JS path during one commit.

### 3.3 Why the track has to sort its children

Slots are children in slot order; after the first move slot order is not shelf order (for the
window 3‥11 the slots show, in child order, items `9 10 11 3 4 5 6 7 8`). Paint order is part of the picture: a lit card's shadow
(`0 18px 36px`) reaches over its neighbours, landing **on** the ones painted before it and
**under** the ones painted after. The reference paints in shelf order (child order). So under
`pool` the track enables custom child drawing order and paints by laid-out `left`
(`PoolMath.paintOrder`, recomputed at the top of each `dispatchDraw`; a moved slot invalidates
its parent, so a rebind always re-records). Focus search is geometric and unaffected.

The alternative — listing the slots in shelf order so React reorders them — was rejected: a
reorder is a Fabric remove + insert per moved slot, i.e. a detach/attach of the card's whole
subtree (Fresco holders detach, a `cardlayer` hardware layer is destroyed).

### 3.4 What a rebound card shows

A rebind is a prop update of the art layer, which `AuroraCardView.applyProps` already treats
as "a new address" (`restartPicture`): `loaded = false`, the fade back to 0, a new failure
ladder, the blur re-submitted, a new request token (a late callback of the old request is
ignored). The picture is only drawn when `loaded` — so the previous item's art cannot be drawn
for the new item; the card shows what a freshly mounted one shows (the blur-up placeholder, or
the bare `bgRaised` card, or the tile). `blurUri` is computed in the same render as on a mount
(`blur && !wasDrawn(uri)`). JS state in `NativeCard` (`tileUri`, `parked`) is keyed by the
address and so resets itself. This is by reading the code; §5.4 is the device check.

### 3.5 Behaviour that is deliberately different

* **A shelf whose items change under it** (Home refetch, Continue Watching reorder, a removal):
  the reference is keyed by title, so a card *moves with its item*; the pool is keyed by slot,
  so the card at a *position* is rebound to the item now at that position. If the focused
  item is removed, the reference unmounts the focused card (focus → fallback); the pool keeps
  focus where it is, on the item that slid into that place — and Home is **not** told (no
  focus event fires), so its spotlight keeps the old item until the next move. §5.5 checks it.

---

## 4. Step 2 — the recycling grid (`impl.grid`, letter G)

### 4.1 Why the vertical slide is NOT a native spring here

The brief suggested a container that owns the vertical slide like `AuroraSlideColumnView`.
That does not transfer, for a concrete reason: **Browse's vertical movement is not a spring.**
The FlatList is a `ReactScrollView`; when focus lands on a card, `requestChildFocus →
scrollToChild → scrollBy(0, delta)` moves the content **at once**, by the **smallest** amount
that brings the card's rectangle into the viewport. Home's column is a retargeted spring to a
fixed focus line. Replacing the scroll with a spring would change both the motion (instant →
eased) and the resting positions (minimal scroll → a focus line). `states/browse.json` names
no trace id for it either (its only traces are `focus.ring` / `focus.spring`).

So the closest sound alternative was built: **the scroll view stays** — the same
`ScrollView`, hence the same Java, fed the same card rectangle — and only what was *inside* it
is replaced: the FlatList's virtualised rows become a pool of rows that is rebound.

### 4.2 Contract

* `src/components/NativeGrid.tsx` (new) — `{items, cols, gap, onSelect, onItemFocus, claims,
  firstRef, edgeRight, style, contentContainerStyle, footer}`. Renders
  `TVFocusGuideView(style, trapFocusUp = from > 0, trapFocusDown = to < rows)` →
  `ScrollView(style, contentContainerStyle)` → `AuroraGrid(height = rows × rowPitch)` →
  the slots, then the footer. That is the FlatList's own tree on TV (the patched
  `VirtualizedList` wraps its ScrollView in a focus guide that mirrors the list's style and
  traps UP/DOWN while cells exist beyond the rendered ones).
* Geometry, stated instead of flowed: card (r, c) at `left = c × (CARD_W + gap)`,
  `top = r × (CARD_H + gap)` inside the grid body → 137 / 199 dp pitches for Browse; the
  FlatList's rows are `gap` apart with a trailing `marginBottom: gap`, which is the same
  arithmetic, and the body's height `rows × 199` is the rows' total. (10e-spec §2.2 says the
  cell is 130 × 192; the code says 124 × 186 — `styles.card` overrides the Focusable's 3 dp
  border with its own 1 dp — and `cols = floor((width − 84 − 44 − 8 + 13) / 137)` agrees
  with the code.)
* Pool: **8 rows** (`GRID_BEHIND 3`, `GRID_AHEAD 4`), re-anchored when focus is
  `GRID_SLACK 2` rows from the anchor. Row *r* lives in row-slot *r mod 8*, card (r, c) in
  slot `(r mod 8) × cols + c`; slots keyed by slot number, listed in slot order.
  Unlike a shelf the window is **always 8 rows** (slid back from the end of the grid): rows
  mounted outside the viewport are clipped by the scroll view, so mounting them changes
  nothing on screen — and a window of constant length never mounts or unmounts while moving.
* `AuroraGrid` → `AuroraGridView.kt` (new Fabric component): fires `onItemFocus {index}`
  from the focused child's laid-out edges (the cards get **no** `onFocus` prop — one event,
  not two); paints the slots by position (top, then left = item order = the FlatList's row
  and cell order); leaves rows outside the window out of its display list (`Cull`, always on
  here — the stand-in for the FlatList's `removeClippedSubviews`, re-evaluated on scroll);
  writes the `[pool] … grid …` mount count.
* `Browse.tsx`: `impl.grid ? <NativeGrid …/> : <FlatList …/>` in the card area only. Header,
  count string, skeletons, error / empty states, the edge strip, the 300 dp panel, `Picker`,
  paging, backoff: untouched. `onItemFocus` is Browse's own `onCardFocus` (`warmItem`,
  `lastFocusIdx`, `loadNext` two rows from the end), now called from the grid's event.

### 4.3 What had to be re-made because the FlatList did it implicitly

* **The first card is always reachable.** The FlatList keeps its first 24 cells mounted for
  ever, so Browse's `firstCard` ref (the focus fallback, and where focus goes when the panel
  closes on a changed grid) always pointed at a view. In the pool, row 0's slots are handed
  on. `NativeGrid` therefore puts into `firstRef` an object whose `requestTVFocus()` focuses
  card 0 if it is mounted and otherwise scrolls to 0, moves the window to row 0 and focuses
  it after that commit.
* **A filter change starts a new grid.** `NativeGrid` is keyed by
  `kind-cols-category-genre-unwatched`, so a changed filter remounts it: scroll 0, window at
  row 0. The FlatList is instead scrolled to 0 by `closePanel` (still called; `listRef` is
  unset, a no-op). Difference: with a cached category the FlatList's content changes while
  the panel is open and jumps to the top when it closes; the pool is at the top as soon as
  the filter is picked. (A filter change remounts every cell in the reference too — the items
  differ.)

### 4.4 Counts (generator, cols = 6)

| walk | pool mounts / unmounts / rebinds |
|---|---|
| hold DOWN 20 rows, 120 items | 0 / 0 / 72 |
| down 20 rows and back | 0 / 0 / 144 |
| hold DOWN while pages of 20 land (60 → 140) | 6 / 10 / 86 |

The paging line is the short last row: 20 is not a multiple of 6, so the last row has 2 or 4
cards until the next page fills it. Proven bound: a move or a landing page mounts / unmounts
at most `cols − 1` slots, and nothing at all between windows of full rows.

---

## 5. Device checks

Lab build `com.auroratv.lab`, the private fixture instance, the box pinned as
`tools/tv-pixel-diff/README.md` says. `Q` below is the QA broadcast of
`tools/tv-bench-matrix.sh` (`Q exp "pool=1"`, `Q impl "all=native"` …); a change takes effect
on the next launch. `tools/tv-pixel-diff/PROTOCOL.md` §3 should gain `pool` in its list of
`exp` keys (not edited here: `tools/**` is being edited on `native-lab`).

### 5.0 Smoke (5 minutes, before anything else)

1. `Q impl "focusable=native,card=native,row=native,hero=native,rail=native"`, `Q exp "pool=1"`,
   launch. Home draws; walk a shelf right to its end and back; DOWN/UP between shelves; OK on
   a card opens Detail and BACK returns onto the same card; hold OK opens the peek sheet.
2. `Q exp none`, `Q impl "…,grid=native"`, launch, open Movies. Grid draws; DOWN ×12, UP ×12,
   RIGHT to the last column, RIGHT again opens the panel, LEFT closes it onto the same card.

### 5.1 Pixels — the shelf (`exp pool`)

```
cd tools/tv-pixel-diff
python run.py --impl FCRHN --exp pool=1 --states row,card,app --out ../../docs/qa/native-bench/pool-pixels/
python strict.py ../../docs/qa/native-bench/pool-pixels/
```

Both sides native, A = `exp none`, B = `exp pool=1`. **Pass: `strict.py` reports 0 differing
pixels in every state** — this is not a JS-vs-native comparison with an anti-aliasing
allowance; the two sides run the same views and must be bit-identical. The states that
matter most:

| state (states/row.json) | what it proves |
|---|---|
| `offset-5`, `offset-9`, `offset-10`, `hold-right-12`, `hold-right-end` | after 1, 3, 3, 4 and all window moves the same cards are at the same places — the slots show the right items |
| `back-left`, `hold-right-left` | slots rebound back the other way |
| `offset-9` / `offset-10` (window 6‥14: the children are, in order, items `9 10 11 12 13 14 6 7 8` — the lit card 9 is the FIRST child and its left neighbour 8 the LAST) | **the paint order**: the lit card's shadow lies over its left neighbour and under its right one. If §3.3 were wrong this is where it shows |
| `left-at-0`, `left-at-0-return` | `edgeLeft` on a slot that has been item 0, then 9, then 0 again still opens the rail |
| `reentry-down`, `reentry-up` | the shelf's focus guide returns to the last-focused card |
| `continue-rest`, `continue-step`, `continue-step-2` | frame cards (labels, progress bars) in slots |

Add two states (suggested, not written — `tools/**`): `pool-wrap-shadow` = `DPAD_DOWN ×3`,
`DPAD_RIGHT*8@150`, `wait:900` (focus on item 8 = slot 8, its right neighbour item 9 = slot 0:
the pair that is furthest apart in child order), and the same on the Continue Watching shelf.

### 5.2 Motion — the shelf

`python run.py --impl FCRHN --exp pool=1 --states row --only lead,hold-right-12,hold-right-left`
with the states' own traces (`row.tx`, `focus.ring`, `focus.spring`). **Pass:** `row.tx`
traces identical to 1e-3 dp with the same frame count ±1 (the slide is untouched code; a
difference would mean a rebind's layout pass disturbed the track's `translationX`).

### 5.3 Mounts per press — the number this step exists for

`Q focuslog on`, then for A (`exp none`) and B (`exp pool=1`), same impl letters:

```
adb logcat -c
# Home, first poster shelf: DOWN to it, then
#   DPAD_RIGHT*24@50, wait 1500, DPAD_LEFT*24@50   (the harness key syntax; or tools/tv-bench.sh S1)
adb logcat -d -s AuroraAnim:D | grep '\[pool\]'
```

Each focus change inside a shelf or a grid writes

```
[pool] <uptimeMs> row|grid tag=<id> focus=<index> direct=+a/-r desc=+c/-d views=<n>
```

`direct` = children Fabric added to / removed from the container, `desc` = views anywhere
under it that appeared / disappeared, both **since the previous line of the same container**
(so the commit caused by press *k* shows on line *k+1*, or later if JS was behind). The line
is written with the pool off too — that is the baseline.

**Pass (B, a shelf of ≥ 18 poster cards with no NEW pills, e.g. a catalogue shelf):**
* every line except those after the first window move off the head and the last moves at the
  tail: `direct=+0/-0 desc=+0/-0`;
* over RIGHT×24 from card 0: total `direct` = +3/−0 mid-shelf (+3 then −k at the tail), where
  A shows about +3 / −3 direct **per window move** and `desc` ≈ ×(views per card);
* `views=` is constant between those lines.
A non-zero `desc` with `direct=+0/-0` on a mid-shelf line means two items differ in shape
(a NEW pill, a progress bar): expected on mixed shelves, and worth recording per shelf — it is
the remaining mount cost of (c), and the argument for or against §7.

**Grid (impl G, `Q focuslog on`, Movies, DOWN×12@300 then UP×12@300):** every line
`direct=+0/-0`; `desc=+0/-0` unless a page landed between two lines (then ≤ +5/−5 direct,
§4.4) or NEW pills differ.

### 5.4 The rebound card never shows the previous art

Instance started with `--art-delay` (`--server artDelay`), `exp pool=1`. On a poster shelf:
`DPAD_RIGHT*12@50`, then screenrecord (`--screenrecord`) the next `DPAD_RIGHT*6@300`.
**Pass:** stepping the recording frame by frame, every card entering from the right shows its
own blur-up placeholder (or the dark `bgRaised` card) and then its own art; no frame shows a
poster that belongs to a card that left on the left. Same check with `--server artFail` for
the tile: a rebound slot whose previous item was showing the titled tile must show the new
item's art (or its own tile, with the NEW title), never the old title.
Compare A/B stills of `card.json`'s blur-up states under `--exp pool=1`: 0 differing pixels.

### 5.5 Behaviour that differs by design (§3.5) — look, then decide

Continue Watching, `exp pool=1`: hold OK on the 2nd card → Remove. Record: where focus is,
what the hero spotlight shows, whether LEFT/RIGHT work at once. Reference: focus falls to the
fallback. **Acceptable** if focus stays on the card now in 2nd place and one D-pad press
brings the spotlight back in step; **not acceptable** if focus is lost or the ring is on a
card that is not the focused view. If the spotlight lag is disliked, the fix is one line in
`NativeRow` (fire `onItemFocus(items[latest])` in an effect when `items` changes).

### 5.6 Pixels — the grid (`impl G`)

```
python run.py --impl G --states browse --out ../../docs/qa/native-bench/grid-pixels/        # A = js FlatList, B = native grid
python run.py --impl FCRHNG --states browse,app --out ../../docs/qa/native-bench/grid-pixels-all/
```

**Pass:** the standard 1:1 rule (≤ 0.05 % at threshold 0.1, zero outside a 1-px edge
dilation) — and since the cards are the same component on both sides, expect **0** differing
pixels; anything else is geometry and is a failure. States: `first-page` (header, rows 0‥2,
card 0 lit, edge strip), `focus-r2c3` (the scroll position after DOWN×2 is the ScrollView's —
this is the state that proves §4.1), `panel-open`.

States to add for the pool (suggested): `grid-down-12` = `DPAD_DOWN*12@300`, `wait:900`
(3 window moves: the slots show rows 9‥16; the lit card's shadow over the row above and under
the row below = the paint order across a row-slot boundary); `grid-down-up` =
`DPAD_DOWN*12@300`, `DPAD_UP*12@300` (back at the top: must equal `first-page` exactly);
`grid-last-row` = hold DOWN to the end of "Downloaded" (a short last row, the footer, DOWN at
the last row); `grid-filter` = open the panel, pick "Top rated", LEFT (focus on card 0 of a
new grid at scroll 0).

`[focus]` log on both sides for `focus-r2c3` and `grid-down-12`: the same sequence of
`gain` lines (same cards, same `edgeL` / `edgeR`).

### 5.7 Grid behaviour list (manual, impl G)

| do | must |
|---|---|
| hold DOWN through two page loads | no blank row ever scrolls into view; the spinner row appears under the grid while a page loads; focus never stops short of the last loaded row |
| hold UP from row 20 back to 0 | no blank row at the top (if one shows, raise `GRID_BEHIND` or lower `GRID_SLACK` in `poolMath.ts` — see §6) |
| RIGHT on the last column | opens the panel; LEFT closes it onto the same card |
| LEFT on column 0 | opens the rail; RIGHT returns to the same card |
| panel → another category → LEFT | focus on the FIRST card, grid at the top |
| panel → Unwatched → LEFT | same |
| OK on a card in row 10, BACK | returns to that card, same scroll position |
| Surprise me, BACK | focus where it was |
| DOWN on the last row of "All" with the first catalogue page failed | reaches Retry |
| Downloaded with 1‥5 titles (one short row) | draws, focus works, DOWN does nothing |

### 5.8 Frames

Interleaved, 4 rounds, as r3/r5 (`tools/tv-bench-matrix.sh`), exp set by hand before each
configuration (the matrix script only sets `impl`):

| label | impl | exp | scenarios |
|---|---|---|---|
| `FCRHN` | all but grid native | none | S1 S3 |
| `FCRHN+pool` | same | `pool=1` | S1 |
| `FCRHN+pool+fix` | same | `pool=1` + the r5 fixes that passed (`cull=1,cardlayer=1,taglayer=1,shadowcache=1` as applicable) | S1 |
| `FCRHNG` | all native | none | S3 |
| `js` | all js | none | S1 S3 (the anchor) |

Compare per scenario: `p50`, `p90`, `p95`, **`p99`**, `janky_pct`, and — from JankStats /
`dumpsys gfxinfo framestats` — the **longest frame** and the **count of frames > 32 ms and
> 64 ms** of each run (the p99 of a 40-press run is one or two frames; the count is the
steadier number).

**Pass, shelf (S1):**
* `p99` of `FCRHN+pool` ≤ `p99` of `FCRHN` in at least 3 of 4 rounds, and the median over
  rounds lower by ≥ 20 %;
* frames > 64 ms: fewer in total over the 4 rounds, and **none that coincide with a window
  move** (line the `[pool]` timestamps up against the frame table in a separate, logged run —
  never log during the timed runs);
* `p50` / `p90` not worse by more than 1 ms (the pool must not cost the common frame);
* PSS and `views` not higher (they should be equal: the same cards are mounted).
If p99 does **not** move, the mount burst was not the cause of those frames — record that and
do not start §7; the next suspects are the commit's JS time and Fresco's decode of the three
entering posters.

**Pass, grid (S3):** `FCRHNG` vs `FCRHN`: `p99` and frames > 64 ms lower, `p50` not worse by
more than 1 ms, `views` lower or equal (48 pooled cards vs the FlatList's window), PSS not
higher by more than 5 MB (eight rows of decoded posters; the FlatList at `windowSize 3` holds
about the same).

---

## 6. The knobs

`src/poolMath.ts` (the Kotlin twin and the fixtures follow: `node tools/gen-pool-fixtures.js`).

| constant | value | raise it when | cost |
|---|---|---|---|
| `GRID_BEHIND` | 3 | a blank row shows at the top on a fast UP | 6 more mounted cards per row |
| `GRID_AHEAD` | 4 | a blank row shows at the bottom on a fast DOWN | same |
| `GRID_SLACK` | 2 | (lower to 1) rows arrive late; (raise) too many commits | 1 = a 6-card rebind per row moved; 2 = 12 cards every second row |

The shelf's constants are Row.tsx's and are not the pool's to change.

---

## 7. The further step, not built: (b) the row draws the card's text

What it would be: `AuroraRow` takes `items` (a typed array prop of everything a card shows),
creates nine `AuroraCardView`s itself, binds them on its own UI-thread window moves and fires
`onPress {index}` / `onLongPress {index}` / `onItemFocus {index}`. No React commit on a hold
at all; `PoolMath.kt` already holds the assignment for it.

What it costs: every text of the card drawn with `android.text` so that it matches what
`TextLayoutManager.kt` produces for the same style. To be reproduced exactly (file:
`ReactAndroid/.../views/text/TextLayoutManager.kt`):

* the spans it sets per fragment — `ReactAbsoluteSizeSpan(fontSize px)`,
  `CustomStyleSpan(style, weight, fontFeatureSettings, family, assets)` (so the **Typeface**
  is `ReactFontManager`'s for weight 600 / 700 / 800 / 900 — synthesised bold or a real face,
  whichever the box has), `CustomLetterSpacingSpan(letterSpacing px)` (applied as
  `paint.letterSpacing = px / textSize`, an em fraction), `CustomLineHeightSpan(lineHeight)`
  (its ascent/descent redistribution, with its rounding), `ShadowStyleSpan(dx, dy, radius,
  color)` (→ `paint.setShadowLayer`);
* the layout choice — `BoringLayout` when `isBoring` and the width fits, else
  `StaticLayout.Builder` with `setAlignment`, `setLineSpacing(0, 1)`,
  `setIncludePad(includeFontPadding)` (default **true**), `setBreakStrategy`
  (`HIGH_QUALITY`), `setHyphenationFrequency` (`NONE`), `setEllipsize(END)` +
  `setMaxLines(n)` when `numberOfLines` is set, `setUseLineSpacingFromFallbacks(true)`;
* the widths — `ceil(Layout.getDesiredWidth)` for an unconstrained measure,
  `ceil(width)` for EXACTLY: the NEW pill is as wide as that number plus its padding, so one
  pixel of difference moves the pill's right edge;
* where the layout is drawn inside the text view (padding, the vertical offset of a layout
  shorter than its box), font scale (`allowFontScaling` × the system font scale, pinned at
  1.0 for the diff runs), and the paint flags RN sets (anti-alias, subpixel, linear text).

What would have to be pixel-checked on the device before it could replace RN Text — each as
a **strict, 0-pixel** A/B of the native-text card against the RN-text card:

1. `labelText` 14/700 with the 6 dp shadow, one line, short title; and a title long enough
   to ellipsize (where the ellipsis lands, and that the kept text is the same glyph run);
2. `labelSub` + `labelText` stacked (an episode card): the baseline of both lines and the gap;
3. `frameTitle` 17/800, `letterSpacing −0.2`, `lineHeight 20`, shadow radius 10; `frameSub`
   and `frameMeta` 13/600 with `marginTop` (the `▶` glyph: a fallback font —
   `setUseLineSpacingFromFallbacks`);
4. `fallbackText` 14/700 centred, `numberOfLines 3`: one, two, three and four-line titles
   (line breaking, centring, the three-line cut);
5. `NEW` 11/900 `letterSpacing 1.2`: the pill's width and the text's x inside it; the trailing
   letter-spacing after the last glyph is part of the measured width in Android;
6. the `✕` 15/800 in its 30 dp disc; `S1 E1 · Title` (a middle dot, digits);
7. a title in Hebrew / Arabic (bidi, a different fallback font) and one with an emoji;
8. all of the above at font scale 1.0 on the Mi TV **and** on the Streamer (different system
   fonts are possible), and after a density change (1080p / 720p / 4K UI modes).

Risks: any one of these failing means a visible text difference somewhere in the catalogue
that no state file covers (titles are data). And the press / long-press / focus-ring path
would have to move from `AuroraFocusableView` instances that React owns to instances the row
owns — `focus.ts`'s facts (`noteFocus`, `captureFocus`, the rail's restore) would need a
native twin first (00-plan P6 says the same). Recommendation: only if §5.8 shows (c) removed
the mounts **and** the p99 frames are still there with the commit as the measured cause.

---

## 8. Files

New: `tv-native/src/poolMath.ts`, `src/components/NativeGrid.tsx`,
`src/specs/AuroraGridNativeComponent.ts`, `tools/gen-pool-fixtures.js`,
`android/.../ui/pool/PoolMath.kt`, `android/.../ui/view/PoolHost.kt`,
`android/.../ui/view/AuroraGridView.kt`, `android/.../ui/view/AuroraGridManager.kt`,
`android/app/src/test/java/com/auroratv/ui/pool/PoolMathTest.kt`,
`android/app/src/test/resources/pool-fixtures.json`, this file.

Changed:
* `src/components/Row.tsx` — `NativeRow` only: the pool branch (imports, `POOL` /
  `POOL_SLOTS`, the `latest` / `countRef` refs, the anchor updater, the slot list). `JsRow`
  and the keyed branch are untouched.
* `src/screens/Browse.tsx` — two imports and the `impl.grid ? <NativeGrid/> :` branch in
  front of the `<FlatList>`.
* `android/.../ui/view/AuroraRowView.kt` — `slots.pressed(index)` in `requestChildFocus`,
  `if (pooled) slots.beginDraw()` in `dispatchDraw`, and one added block (`pooled`, `slots`,
  `init`, `getChildDrawingOrder`, `onViewAdded`, `onViewRemoved`).
* `android/.../ui/AuroraUiPackage.kt` — one import, `AuroraGridManager()` appended to the list.
* **Shared with `native-lab` (merge-sensitive): `android/.../ui/AuroraExp.kt` — exactly ONE
  added line**, `"pool",` at the end of `FIXES`. `src/exp.ts` is **not** changed (it has no
  key list). No other shared file is touched: not `Cull.kt` (used as is by the grid),
  `ShadowLayer.kt`, `AuroraFocusableView`, `AuroraSlideColumnView`, `AuroraRailPanelView`,
  `NavRail.tsx`, `Home.tsx`, `focus.ts`, nor any existing file under `tools/**` or
  `docs/qa/native-bench/**` (one new file in each).

# 4 — Audit of our own code: costs nobody has measured yet (2026-10-10)

Scope: `C:\elia\aurora-lab` (branch `native-lab`) — `tv-native/App.tsx`, `tv-native/src/**`,
`tv-native/android/app/src/main/java/com/auroratv/**`, and the server routes the TV calls while moving around
(`src/routes/api.js`, `src/routes/stream.js`, `src/lib/imgvariant.js`, `src/lib/blurup.js`).
Read-only on the app. No adb, no builds, no servers started. The only things run: read-only `GET`s against the
already-running local server (`http://localhost:4000`) to weigh payloads, and `grep`/`node` on the files.

What this is NOT: it does not repeat `REPORT.md` / `RENDER.md` / `ART-FORMAT.md` (draw-op cost of cards, box-shadows,
card layers, culling, the backdrop re-encode, the rail self-open race). Those are taken as given.

**How to read the ratings.** "Impact" is for a weak box (4 slow cores, 2 GB): none / small / medium / large.
Nothing below was timed on a device — every millisecond figure that is not a payload size is an **estimate from
reading the code** and is marked so. Payload sizes and counts ARE measured. Where the production app
(`C:\elia\aurora`, TV 5.1.30, which runs the JS implementations only) has the same code, it says "also in production"
with the production line.

Two facts frame everything:

- **Production runs the JS path** (`impl.*` are all false there: `JsFocusable`, `JsCard`, `JsRow`, the JS hero and rail).
  So what a key press costs on the JS thread still decides when the shelf and the page start to slide
  (`Row.tsx:144` `tx.to`, `Home.tsx:847` `ty.to` are started from JS inside the focus event).
- `REPORT.md` already says the rare 60–150 ms frames "coincide with React mounting cards during key-repeat".
  Findings A1–A3 and B1–B3 below are the concrete reasons React is doing more than mounting those cards.

---

## A. Work on a key press / focus change (JS thread)

### The chain today, one D-pad step along a Home row (JS path)

1. Android moves focus on key-DOWN. Two events reach JS: blur of the old `Pressable`, focus of the new one.
2. `Focusable.tsx:424` `onBlur` → `releaseRing` + **2** `Animated.*.start()` (ring timing, scale spring).
3. `Focusable.tsx:383` `onFocus` → `claimRing` (`:102`) runs the *previous* ring's registered clear (`:293`) →
   **2 more** `start()` on the element that `onBlur` has just animated; then `noteFocus`; then **2** `start()` for the
   new element.
4. `Card.tsx:353` → `Row.tsx:139 focusCard` → `tx.to()` (`:144`, **1** spring start) → Home's `onItemFocus`
   (`Home.tsx:943`) → `toRow(i)` → `ty.to()` (`Home.tsx:847`, **1** spring start, even when the row did not change)
   + `warmItem` (clearTimeout + setTimeout 450 ms, `prefetch.ts:47`).
5. `defer(setAnchor)` (`Row.tsx:148`) and `defer(setReach)` (`Home.tsx:850`) — usually bail out with the same value.
6. On key-UP, the HW event goes to every mounted `useTVKeys`/`useTVEventHandler` listener: on Home that is 2
   (the hero handler `Home.tsx:770`, Home's `NavRail.tsx:342`) plus one `NavRail` per other mounted screen in the stack.
   Each does `noteKey`, the gates, and returns. Cheap.

So: **8 native-driven animation starts per step** (each is a JS object graph + a `startAnimatingNode` call, and a
stop of the one it replaces), at ~20 steps/s when a key is held = ~160 starts/s. Three of the eight are redundant.

### A1. Any Home state change re-renders every Row and every Card (JS path) — also in production

- **Evidence.** `Home.tsx:943-948`: `onItemFocus={impl.hero ? warmItem : it => { toRow(i); warmItem(it); }}`.
  `renderRow` is a `useCallback`, but it is *called* during render (`Home.tsx:1183`), so the arrow is a new function
  on every Home render. `Row` is `React.memo` (`Row.tsx:307`) → it re-renders. `focusCard` depends on `onItemFocus`
  (`Row.tsx:152`) → new identity → every `Card` gets a new `onFocus` → `React.memo(Card)` (`Card.tsx:150`) fails for
  all of them. Production: `C:\elia\aurora\tv-native\src\screens\Home.tsx:757`.
  `motion.ts:53-58` describes this exact storm as already fixed ("`React.memo(Card)` bailed on all ~90 cards each
  time Home re-rendered") — the inline arrow re-opened it.
- **What triggers a Home render.** `setReach` (each new row reached going DOWN, `:850`), `setScrolledIdx` (leaving the
  hero, `:520`), the hero rotation every 9 s (`:548`), `setParties` (`:411`, a fresh `[]` on every return to Home —
  never equal to the last one), `setUpdate` (`:373`), `live` flipping on every blur/focus (`useIsLive`),
  `setTrailer` / `setTrailerOn` / `setUnmuted`, `setRailEpoch` (`:812`, every rail close over the hero), `setData`.
- **Why it costs.** A `JsCard` render is not small: two regex tests, `artPath` ×2, `imgSrc` ×2, `blurOf`, then
  `JsFocusable`: `StyleSheet.flatten` (`Focusable.tsx:355`) and **new `interpolate()` nodes every render**
  (`:362`, `:369`). New interpolation objects make `Animated` build a new props node, attach it and detach the old
  one natively — several native-animated calls per Focusable per re-render, for nothing.
  Cards mounted: 24 at start (4 rows × 6), and `js.jsonl` S2 shows **757 views after stepping through the rows vs
  342 before** — i.e. ~60–70 cards. At an estimated 1–2 ms of JS per card on an A55 that is **60–140 ms of JS per
  Home render** (estimate), which is the size of the "rare long frames", and it lands exactly when a new row is
  being reached (`setReach`) — on top of that row's real mount.
- **Fix.** Give `Row` a stable handler: pass `rowIndex={i}` and one stable `onItemFocus(item, rowIndex)` from Home
  (a `useCallback` over `toRow`/`warmItem`), or keep a `Map<number, fn>` in a ref. Add
  `setParties(prev => sameParties(prev, next) ? prev : next)`. Memoise the two interpolations in `JsFocusable`
  (`useMemo` on `springAnim, scaleTo, lift`) so a re-render that does happen does not rebuild the animated graph.
- **Impact: large** (JS path). It removes the biggest JS burst from stepping down rows and from the 9 s rotation.
  **Effort:** an hour. **Risk:** very low (no behaviour change; the native-hero path already passes a stable `warmItem`).

### A2. The losing element is faded out twice; the page spring is restarted on every horizontal step — also in production

- **Evidence.** `Focusable.tsx:293-309` (registry clear) and `:424-445` (`onBlur`) both start the same two
  animations to 0 on the same element within one event batch. `Home.tsx:847`: `ty.to(…)` runs for every card focus
  via `toRow`, although the target only changes when the row does.
- **Why it costs.** 3 of the 8 animation starts per key are redundant (≈60/s when held), each with a native call.
- **Fix.** In the registry clear and in `onBlur`, skip when `heading.current` is already `false` (the ref exists,
  `:255`); in `toRow`, remember the last target and return when unchanged (keep `setTop`, the trailer stop and the
  `defer`).
- **Impact: small–medium** on the JS path (fewer bridge calls in front of the next key). **Effort:** 30 min.
  **Risk:** low — the registry clear exists for a *dropped* blur; with the guard the first of the two still runs.

### A3. `startTransition` is used in the right places; one gap

`defer` wraps `setAnchor` (`Row.tsx:148`), `setReach` (`Home.tsx:850`, `:877`) and `setScrolledIdx` (`:520`). Good.
Not deferred: `Browse.tsx` `loadNext` → `setLoading(true)` (`:387`) fires synchronously from the card's focus
handler (`:591`), re-rendering Browse (and, through `renderCard`'s changing identity — `claims` is a new closure
every render, `:584` → `:608` — every visible FlatList cell wrapper) on the input path. Wrap the state
changes of a page fetch in `defer`, and make `claims` stable (`useCallback`/ref). **Impact: small. Risk: low.**

### A4. Context providers

- `App.tsx:287` — `value={{profileId, switchProfile}}` is a new object and `switchProfile` a new function on every
  `App` render. `App` only re-renders on stage/session changes, so today this is harmless; noted because one
  more `useState` in `App` would turn it into an app-wide re-render. `useMemo` it. **Impact: none today.**
- `canvas.tsx` — on a 960-dp panel the provider value is a new literal per render of `TvCanvas`
  (`{width, height, scale: 1}`); `TvCanvas` re-renders only with `App`. Same note. The scaled branch is memoised.

### A5. Timers, intervals and loops alive per screen

| screen | timer | period | gated | note |
|---|---|---|---|---|
| app-wide | `usage.ts:40` flush | 20 s after the first event | – | one POST |
| app-wide | `perfTier.ts:215` report | 120 s | never stopped | keeps running after its 6-event quota (`:178`) |
| app-wide | `perfTier.ts:247` measureHome | 5 s × ≤5, once | – | |
| app-wide | websocket reconnect | 1 → 30 s backoff | – | |
| app-wide | JankStats listener (`DeviceModule.kt`) | every frame | never stopped | a FrameMetrics callback + histogram per frame for the whole session; tiny, but it has no use after the quota is spent |
| Home | hero rotation `:544` | 9 s | `live`, at top | → full Home render (A1) |
| Home | update check `:384` | 30 min (+1.5 s after each return) | `live` | `tv-version.json` fetch |
| Home | update-ready poll `:396` | **20 s** | `live` | no-op unless a quiet update is waiting; could be event-only |
| Home | trailer hold `:706` | 4.5 s per pick | `live` | the resolve starts at t=0 (G3) |
| Home | `measureOnce` `:590` | 5 s after each return | `live` | |
| Home | `library_updated` hold | 2.5 s | – | |
| Browse | retry backoff | 3 / 8 / 20 s | on error | |
| Detail | jobs poll `:1544` | 4 s while a download shows (10 s read) | focused | |
| Detail | `bumpLibrarySoon` | 0.7 s | – | |
| Player | cue tick `:361` | **200 ms** | while cues exist | setState only on text change — fine |
| Player | progress event | 1 s | – | setState only while chrome is up — fine |
| Player | `saveProgress` `:2139` | 5 s | not paused | a POST every 5 s for the whole film |
| Player | activity `:2124` | 5 s | – | ws message, also while paused |
| Player | party heartbeat `:1582` | 5 s | host only | |
| Player | decode-stall watch `:2194` | 2 s | – | refs only |
| Player | slow-start watch `:2222` | 1 s until first frame | – | |
| Player | keep-alive `:2156` | 60 s | – | |
| Player | stalled-playlist watch `:2274` | 5 s | – | refs only |
| Player | torrent status `:1294` | 1.5 s | before hand-off | |
| rail open | `RailHues` loops `NavRail.tsx:113` | 16 s / 21 s, native | not on lite | only while the panel is mounted |
| loading | `Skeleton.tsx:30` | 1.4 s native loop **per skeleton** (18 on Browse) | – | see C6 |
| loading | `MiniSpinner.tsx:13` | native loop | – | |

Nothing here is a per-frame JS loop. The two worth touching: the Player's 5 s POST + 5 s socket message say the same
thing twice (the `activity` message already carries position and duration — the server could save from it; small),
and the two monitors that never stop.

### A6. Websocket listeners that set state on screens not in focus

- `Home.tsx:326` `library_updated` — correctly does nothing while not live. `:413` `party_list` is only subscribed while live. Good.
- `Browse.tsx:224` `library_updated` — **not** gated on focus: a Browse buried under Detail/Player refetches
  `/api/library` (93 KB, measured) and `setLib`s; the frozen screen applies it on return. One parse behind the
  player per library change (a season landing = one per 2.5 s window). Gate it like Home does. **Small.**
- `realtime.ts:99` — `library_updated` calls `forgetMemo()` with no prefix: the *whole* read cache goes (catalogue
  pages, genres, per-title meta, trailers, changelog), not only library-derived entries. Every screen then refetches
  from cold. Use `forgetMemo('library')` + `forgetMemo('/api/item/')` as `Detail.tsx:967-968` already does. **Small.**
- `SessionWiring.tsx:52` `download_update` — arrives once a second per running job; only acts on `done`. Fine.
- `Card.tsx:229` — a `welcome` listener only on parked cards. Fine.

---

## B. Lists, mounting and screen transitions

### B1. Returning to Home re-renders everything three times, during the transition — also in production

- **Evidence.** On focus regain: (1) `useIsLive` → `setLive(true)` → Home render; (2) `Home.tsx:411` parties →
  `setParties([])` (new array) → Home render; (3) `Home.tsx:344-351`: older than 15 s → `api.home` → `setData(h)`.
  Measured: two consecutive `/api/home` answers are **byte-identical** (`cmp`), 206,291 B, and the server sends an
  `ETag` nobody uses. The new parse gives every item a new object identity → every `Row` gets new `items`, every
  `Card` a new `item` → nothing can bail out, on either implementation.
  Plus (4) `syncHomeScreen` → `GET /api/downloads?profile=` (`homeScreen.ts:207`), and (5) the update check 1.5 s later.
- **Why it costs.** ~206 KB of JSON parsed on the JS thread (estimate 10–30 ms on an A55, plus ~26 incremental
  XHR events, D5) and then a full Home reconciliation (A1's 60–140 ms estimate, now unavoidable because the
  identities really changed) — while the 260 ms cross-fade back to Home is running and the pictures are being
  re-attached.
- **Fix.** In `api.home` keep the last response *text*; when the new text is `===` the old, return the old parsed
  object (so `setData` bails out and `syncHomeScreen`'s own signature check short-circuits). Better still, send
  `If-None-Match` and let the server answer 304 (Express already computes the ETag; no body, no parse).
  When the body did change, reuse the previous item object wherever `JSON.stringify(old) === JSON.stringify(new)`
  per row, so only Continue Watching re-renders. `setParties` with an equality check.
- **Impact: large** for the "back from a title" moment. **Effort:** 1–2 h. **Risk:** low (same data, same order).

### B2. Browse: appending a page re-renders every mounted card; batches are two rows — also in production

- **Evidence.** `Browse.tsx:451`: `let tagged = stream.map(i => ({...i, source: 'stream' as const}))` inside the
  `items` memo, which depends on `fetched`. Every page append (`:395`), and also `lib`/`profState` arriving, rebuilds
  **every** catalogue item object → `React.memo(Card)` fails for the whole mounted window (3 screens of cards,
  `windowSize={3}`). It fires while a key is held down the grid (`:591` triggers the fetch two rows before the end).
  Production: `Browse.tsx:450`. Same pattern: `Search.tsx:109`, `Detail.tsx:1375` (once per fetch — fine there).
  `maxToRenderPerBatch={12}` (`:712`) mounts two rows (12 cards ≈ 130 host views + 12 pictures) in one commit;
  no `getItemLayout` although every row is exactly `CARD_H + GRID_GAP` tall.
- **Fix.** Tag at fetch time (`setFetched(list.map(tag))`, and tag only the new page on append) so the memo passes
  objects through untouched; `maxToRenderPerBatch={cols}`; add `getItemLayout`; `initialNumToRender` 24 → 18
  (three rows are on screen; the fourth is mounted during the push animation for nothing).
- **Impact: medium–large** on the grid (S3's p99 is 93–125 ms in `RENDER.md`). **Effort:** 1 h. **Risk:** low;
  `getItemLayout` must count rows, not items, with `numColumns`.

### B3. Home's first commit mounts four shelves; one is visible — also in production

- **Evidence.** `Home.tsx:490` `reach = 3` → rows 0–3 mount with the hero in the first commit: 24 cards ≈ 260 host
  views, 24 poster requests, ~14 native-animated nodes per JS card. `theme.ts:197`: the hero is 66 % of the height,
  so at rest only row 0 shows (its top ~140 dp); rows 1–3 are fully off screen.
- **Fix.** Start at `reach = 1`, and `defer(() => setReach(3))` once the first frame is out (an effect + a
  `requestAnimationFrame`, or after the hero art's `onLoad`). Needs A1 fixed first, or growing `reach` re-renders
  rows 0–1.
- **Impact: medium** on time-to-first-usable-Home and on the hero backdrop arriving (18 fewer pictures competing
  with it). **Effort:** 30 min. **Risk:** low — DOWN pressed in the first ~200 ms lands on row 0, which exists.

### B4. Home never unmounts a shelf it has passed (the big structural one)

- **Evidence.** `Home.tsx:487-490` (the comment says so) and `:1183`. Measured in `js.jsonl`: 342 views before,
  **757 after** stepping through the rows; each visited row keeps up to 9 cards and their decoded pictures
  (256×384×4 ≈ 0.4 MB each + the GPU copy). `RENDER.md` row 7 puts the *floor* of RenderThread work
  (`prepareTree` over every mounted view) at ~5 ms with ~350 views — it scales with this number, and `cull` does not
  remove it (culled views are still walked).
- **Fix (lab).** Window the shelves vertically: keep focus ±2 rows mounted, replace the others with a spacer of
  the measured height (`rowY` already holds the offsets). Keep each row's `anchor` in a Home-level ref keyed by
  `row.id` so a shelf comes back where it was left.
- **Impact: medium–large** for long sessions and memory (−20…−40 MB after a walk down the page; lower
  `prepareTree`). **Effort:** a day incl. focus edge cases. **Risk:** medium — UP into a row that is being
  mounted, row heights (Continue Watching is shorter), `useFocusFallback`.

### B5. Cards are created and destroyed; nothing is recycled (the "go deep" candidate)

- **Evidence.** `Row.tsx:155-157` + identity keys (`:190`): moving the window unmounts up to 3 cards and mounts 3
  (≈33 host views, ~42 animated nodes, 3 picture requests) in one commit every third step. Browse's `FlatList`
  (`:699`) does the same per row. Per card: `Pressable` + overlay + brighten + shade + ring + blur-up + picture +
  kind pill + 3 SVG views ≈ **11 host views** for a poster, ~15 for a Continue Watching card (counted from the JSX;
  24 cards + hero + chrome ≈ 330, which matches gfxinfo's 305–357).
- **Fix (lab).** A recycling shelf: a fixed pool of card instances keyed by *slot* (`index % POOL`), each handed a
  new `item` and `left` as the window moves. `JsCard` already keys its fail/blur state by address ("a card that is
  handed a new picture starts over", `Card.tsx:217`), so a prop swap is supported; a swap is a picture change and
  two text updates instead of 11 view creations + teardown. The same pool idea for the grids (or FlashList-style
  recycling). If the native path wins instead, this is the "row creates its own cards from an `items` prop" step
  that `Row.tsx:239-243` already names.
- **Impact: large** on exactly the frames `REPORT.md` calls rare-but-long. **Effort:** 2–4 days. **Risk:** medium —
  with slot keys, a Continue Watching reorder changes the *content* under a focused slot instead of moving the
  card (today's identity keys were chosen for that case, `Row.tsx:182-189`).
- **Cheap experiment first (lab):** `WINDOW_SLACK` 3 → 1 mounts one card per step instead of three every third
  step — same total work, a third of the worst commit.

### B6. Screen transitions: what mounts, what stays

- Native stack, `animation: 'fade'` 260 ms, `freezeOnBlur: true` (`navigation.tsx:169-171`); Player `animation:
  'none'`. Screens under the top one stay **mounted** (React tree, host views, their `NavRail`) and are detached
  natively; nothing is unmounted until popped. `goSection` keeps the stack at Home + one section (`navSection.ts:120`).
- During the 260 ms fade both screens are drawn every frame: Home's ~12 ms of RenderThread work plus the new
  screen's first frames (its mount, its pictures). On a lite box use `animation: 'none'` (see H3).
- Mount size at open (estimates from the JSX): **Browse** — 24 cards in the initial batch ≈ 260 views + 28 cell
  wrappers, or 18 skeletons (90 views, 18 software SVG bitmaps of 496×372 px ≈ 13 MB, 18 native loops) when the
  page is not warm; **Detail (show)** — lockup ≈ 35, 6 episode cards × ~14, pills, rail ≈ 150–200;
  **Detail (film)** — lockup + 8 shelf cards ≈ 130; **Player** — video + chrome ≈ 60.
- **Every screen module is evaluated before Home's first frame.** `navigation.tsx:176-186` references all eleven
  components in JSX, so with `inlineRequires` (on by default, `@react-native/metro-config`) they are all required in
  `AppNavigator`'s first render: `Player.tsx` (4,018 lines, ~470 lines of `StyleSheet`), `Detail.tsx` (3,024),
  `react-native-video`, `Sources`, `Pick`, `Settings`… Use `getComponent={() => require('./playback/Player').default}`
  for everything but Home. **Impact: small–medium on cold start** (estimate 50–200 ms of module init on an A55; the
  bundle is 2.62 MB of bytecode). **Effort:** 20 min. **Risk:** low (first open of each screen pays its own init).
- **No `onLayout` → `setState` loops found.** `Home.tsx:935` and `:1239` write refs. `Settings.tsx:207` writes a map.
  `NativeColumn` sets its own state from layout, guarded by an equality check (`Home.tsx:266`).
- Sorting/filtering in render: Browse's `items` memo sorts the whole library with `localeCompare` and runs a regex
  `norm()` over every title on each recompute (`Browse.tsx:444-449`) — 35 titles here, fine; it grows with the
  library. Detail's `uiSeasons` (`:1620-1714`) rebuilds **every episode of every season** with fresh closures
  whenever `epJobs` ticks a percent → all visible `EpisodeCard`s (memoised on the object) re-render every few
  seconds during a download. Reuse the previous `UiEp` when its fields are equal. **Small.**
- Horizontal lists on Detail/Search/Pick are `FlatList`s scrolled by the platform: exactly the
  `ReactScrollViewHelper.smoothScrollTo` restart-on-repeat behaviour `Row.tsx:14-25` documents as the reason the
  shelves left `FlatList`. The episode rail teleports under a held key for the same reason. (Known in principle,
  never applied to Detail.) **Lab.**

---

## C. Images (beyond the two already fixed)

Panel assumed 1920×1080 at density 2 (960 dp). "On-box work" = anything beyond one decode at the drawn size.

| screen | image | drawn (px) | requested | format | on-box work | file:line |
|---|---|---|---|---|---|---|
| Home/Browse/MyList/Search/Pick | poster card | 248×372 | `?w=256` (server variant) | WebP | none | `Card.tsx:203` |
| Home | Continue Watching, title art | 498×280 | `?w=640` | WebP | none (1.3× over-size) | `Card.tsx:194` |
| Home | **Continue Watching, resume frame** `/img/frame/<id>?t=` | 498×280 | 640×360 original | JPEG | **`resizeMethod="resize"` → Fresco re-encode of a picture 1.28× the box** | `Card.tsx:188`, `:390` |
| all cards | blur-up placeholder | card box | 16 px data: URI (≈245 chars) | WebP | **`blurRadius={1}` post-process + 1 extra view + 1 extra card render on load** | `Card.tsx:377`, `:295` |
| Home | hero, rest / scrolled | 1920×1080 | `?w=1280&blur=1|2` | JPEG (WebP behind `artWebp`) | none (measured in ART-FORMAT) | `Home.tsx:112` |
| Home | hero, library still | 1920×1080 | `/img/still` 1280×720 | JPEG | none | `Home.tsx:106` |
| Detail | backdrop | 1344×821 | original (1920 behind `artWebp`) | JPEG | re-encode — known, fix exists | `Detail.tsx:334` |
| Detail | **backdrop when it is a poster** (no key art) | 1344×821 | original poster | JPEG | **`resize` + `blurRadius={28}` on the box**, every visit | `Detail.tsx:348`, `:1484` |
| Detail | **backdrop, library titles** | 1344×821 | first `/img/still` (1280), then metahub key art once the IMDb id resolves | JPEG | **two full decodes + two 260 ms fades**; the first is thrown away | `Detail.tsx:1480-1483` |
| Detail | **episode still, catalogue shows** | 380×214 | `https://episodes.metahub.space/…/w780.jpg` — host not in the proxy list | JPEG | **internet fetch + `resize` re-encode per episode card** | `Detail.tsx:671`, `:721`; `api.ts:751`; `stream.js:155` |
| Detail | episode still, library episode | 380×214 | `/img/still/<id>` 1280×720 (not sizable, `api.ts:794-796`) | JPEG | **`resize` re-encode of a 1280 px picture per card** | same |
| Detail | sources-panel poster | 380×570 | `?w=448` | WebP | none | `Detail.tsx:2345` |
| Detail | lockup poster (`DetailHero.poster`) | 240×360 | – | – | dead code: the prop is never passed | `Detail.tsx:273` |
| Sources panel | head poster | small | original (`imgSrc(poster)`) | JPEG | full-size decode into a small box | `Sources.tsx:649` |
| Sources (route) | blurred art | full screen | original + `resize` + `blurRadius={32}` | JPEG | unreachable: nothing pushes `Sources` any more | `Sources.tsx:628-636` |
| Peek sheet | art | 512×288 | `?w=640` | WebP | none | `Overlays.tsx:117` |
| X-Ray | face | 116×116 | TVMaze `medium` 210×295 / TMDB, unsized; default 300 ms fade | JPEG | none (≈0.25 MB each, ≤20) | `Overlays.tsx:525` |
| Player | resume card frame | card | `/img/frame` 640×360 | JPEG | none | `Player.tsx:3147` |
| NavRail / gate | avatar | 60×60 / tile | `/avatars/…` unsized | – | none | `NavRail.tsx:614`, `ProfileGate.tsx:305` |
| Downloads | poster | 88 px | `?w=240` | WebP | none | `Downloads.tsx:156` |
| chrome | ambient, scrims, shades, row fade, glows, logo | – | bundled PNG | PNG | none | – |
| rail strip (JS) | scrim | 144×1080 | **react-native-svg gradient, one per mounted screen** | software bitmap | UI-thread raster at mount; pinned every frame | `NavRail.tsx:541` |
| loading | skeleton shimmer | 496×372 ×18 | **react-native-svg gradient per skeleton** | software bitmap | 18 rasters + ~13 MB while loading | `Skeleton.tsx:58` |
| cards | kind glyph | 22×22 | **react-native-svg per card** (3 host views) | software bitmap | `RENDER.md` measured the pill at 1.0–2.1 ms/frame and could not say why | `Card.tsx:473`, `Icon.tsx:49` |

### C1. Episode stills go around the server and are re-encoded on the box — also in production

- **Evidence.** `/api/discover/meta/series/<id>` returns `"thumbnail":"https://episodes.metahub.space/tt…/1/1/w780.jpg"`
  (measured). `episodes.metahub.space` is in neither `PROXY_ART_HOSTS` (`api.ts:751`) nor the server's
  `EXT_IMG_HOSTS` (`stream.js:155`), so `artSrc` returns `sized: false` and `Detail.tsx:721` asks for `resize`:
  a 780×439 JPEG fetched from the internet, transcoded by Fresco to 380 px, decoded again — per episode card,
  six at page open and one per step along the rail. Library episodes do the same with a 1280×720 `/img/still`.
- **Fix.** Add the host to both allow-lists (the server then serves a cached 448-px WebP at LAN speed); let
  `/img/still` and `/img/frame` accept `?w=` (they are plain files — `sendArt` already does everything) and extend
  `artPath`'s pattern (`api.ts:796`) to them.
- **Impact: medium** on opening a show page and on walking its rail (the backdrop's re-encode measured 79–303 ms
  for 1920 px; a 780–1280 px one is a fraction of that, but ×6 at once on Fresco's threads while the page mounts).
  **Effort:** 1 h (server + TV). **Risk:** low; the server proxy fetches a new host — same SSRF rules as the others.

### C2. Continue Watching's frame is re-encoded to save nothing — also in production

`Card.tsx:390`: a `/img/frame` picture is 640×360 for a 498×280 box. `resize` runs Fresco's JPEG transcoder to
shave 22 % of the pixels. Use `'auto'` for frames (or size them server-side with C1's `?w=`). **Impact: small**
(a handful of cards, but they are the first row of Home). **Effort:** one line. **Risk:** none.

### C3. Blur-up costs a view, a post-process and a render per first-time card

`Card.tsx:375-378`, `:290-296`. Each card whose picture has not been drawn this run mounts a second `Image`
(data: URI, `blurRadius={1}` → Fresco copies the bitmap and runs a box blur, a separate cache entry), then
`setLoadedUri` re-renders that card and removes the view when the real picture lands. On a fresh row during
key-repeat that is an extra commit per card. The placeholder is 16 px wide stretched over 248 px — bilinear
filtering already blurs it; `BLUR_RADIUS = 1` "only takes the edge off" (`Card.tsx:35-39`).
**Fix:** drop `blurRadius` (or blur the 16-px tile once on the server); on a lite box skip blur-up entirely (H3).
**Impact: small. Effort:** minutes. **Risk:** the placeholder may look slightly blockier — look at it on the TV.

### C4. Detail still blurs on the box for poster-only titles; library titles decode two backdrops

- `Detail.tsx:348` `blurRadius={sharp ? 0 : 28}` — the same Fresco iterative blur on a full bitmap that Home's
  hero was moved off (`Home.tsx:92-100`). Ask the server (`artPath(raw, px, blur)`), as the hero does.
- `Detail.tsx:1480-1483`: `keyArt` depends on `item.imdbId || libImdb`. A library card has no `imdbId`, so the page
  opens on `item.backdrop` (a 1280 px still), then `imdbFor` resolves and the source switches to metahub's key art:
  a second network fetch, a second full decode, a second 260 ms fade, ~1 s after open. Either hold the art until
  the id is known (it is memoised 30 min, `api.ts:913`, and often already warm from `warmItem`), or have
  the card/`/api/item` carry `imdbId`, or keep the still.
- **Impact: small–medium** on the open of a library title. **Effort:** 1 h. **Risk:** visual choice (which picture).

### C5. `fadeDuration`

Cards, shades, scrims: 0. Hero 260, Detail backdrop 260, source poster 160: deliberate. X-Ray faces use the
default 300 ms (`Overlays.tsx:525`) — up to 20 cross-fades at once over a paused film; set 0.

### C6. SVG gradients that should be PNGs

`NavRail.tsx:541` (one per mounted screen), `Skeleton.tsx:58` (×18), `Card.tsx:399` (the fallback tile),
`NavRail.tsx:522` (feather). Every other gradient in the app was already baked (`card-shade-v.png`, `row-fade.png`,
`hero-scrim.png`…) for the reason `Card.tsx:69-70` gives: "The SVG painted a software bitmap per card… on the UI
thread", and `RENDER.md` found each one is a mutable bitmap pinned every frame. The kind glyph (`film`/`series`,
two shapes, two colours) is the one that is on every poster card: two 22-px PNGs with `tintColor` would remove
3 host views and a software bitmap per card. **Impact: small–medium** (mount of every poster card; the pill's
1.0–2.1 ms/frame in `RENDER.md` is the upper bound of what the glyph part can give back). **Effort:** 2 h.
**Risk:** low; pixel-diff the pill.

---

## D. Network on navigation (payloads measured against `localhost:4000`, profile `242da3b05797`)

| request | bytes (with `X-Blur: 1`) | of which `_blur` | gzip | when |
|---|---|---|---|---|
| `GET /api/ping` | 84 | – | – | boot, ×1–2 |
| `GET /api/home?slim=1&profile=` | **206,737** (170,964 without blur) | 35,764 (120 entries) | 53,482 | Home mount; **every return to Home after 15 s** |
| `GET /api/library` | 93,259 (77,518) | 15,732 | 25,108 | warm (2.5 s after Home), Browse, Search, Detail of a stream card without `inLibrary`; memo 60 s |
| `GET /api/catalog?…page=0` | 49,609 | 26,708 | – | warm ×2; Browse; Detail "more like this" ×2; memo 60 s |
| `GET /api/catalog?…page=1` | 28,119 | – | – | paging; **3.85 s on the server when cold** |
| `GET /api/catalog/genres` | 198 | – | – | warm ×2 |
| `GET /api/changelog` | **122,677** | – | – | **warmed 5–6 s after every Home mount** (`prefetch.ts:31`) |
| `GET /api/discover/meta/series/<id>` | 3,333 – 7,720 | – | – | 450 ms dwell on a card; Detail; hero trailer; 0.36–0.48 s server time cold |
| `GET /api/discover/meta/movie/<id>` | 799 | – | – | same |
| `GET /api/item/<id>` | 2,640 (film) / 5,231 (show) | – | – | dwell; Detail; Player; memo 45 s |
| `GET /api/downloads` | 4,971 (7 jobs) | – | – | Detail open (twice, D3); Home return |
| `GET /api/profiles` | 1,822 | – | – | boot (kids check), rail avatar, Follow |
| `GET /api/party` | 14 | – | – | every return to Home |
| `GET /api/trailer` | 42 | – | – | hero pick |
| `GET /api/xray` | 4,597 | – | – | X-Ray |
| `GET /api/discover/search?q=` | 6,817 | – | – | search, debounced 350 ms |
| `GET /api/profiles/<id>/state`, `/watchlist` | not measured (401 without the unlock token; GET-only rule) | | | boot; Browse; **every focus of Detail and MyList** |

### D1. `/api/home` sends cards three times what a card needs

- **Evidence.** 249 items in 11 rows. By field (bytes over all row items): `synopsis` **60,808**, `backdrop` 14,823,
  `cover` 12,797, `poster` 10,412 (identical to `cover` on catalogue items), `genres` 8,673, `title` 5,992,
  `transcodeBase` 3,888, `hlsUrl` 3,726, `downloadUrl` 3,645, `videoUrl` 3,159, plus `sizeBytes`, `duration`,
  `certificate`, `container`, `width`, `height`, `yearGuessed`. A card reads none of `synopsis`, the four URLs or
  the file facts. `?slim=1` (`api.js:981-986`) strips *less* than the website's `cardStrip` (`:1003-1014`), which
  already drops exactly these. Home mounts 24 of the 249 items at start.
- **Fix.** Let `slim=1` use `cardStrip` (keeping `synopsis` on `hero`, as it does) and drop the duplicate
  `poster` when it equals `cover`: ≈170 KB → ≈80 KB before blur. The peek sheet already fetches a missing synopsis
  (`Overlays.tsx:74-90`) and Detail falls back to `full`/`streamMeta` (`Detail.tsx:2410`). One reader would lose
  data: the launcher row's `description: i.synopsis` (`homeScreen.ts:238`) — keep `synopsis` on the `recommended`
  row only, or accept a null description.
  Deeper: answer with the first 4 rows' items and ids/titles for the rest, and fetch a row's items when `reach`
  gets near it.
- **Impact: medium** — less to download on a slow line (`api.ts:499` describes a 0.9 Mbit line), less to parse,
  less JS heap (the parsed tree is held for the whole session). **Effort:** 1 h server + check. **Risk:** low–medium
  (an older TV build talking to a newer server still works: the fields only disappear).

### D2. Prefetch competes with scrolling

- `prefetch.ts:21-41`: 2.5 s after Home has data, then one every 0.7 s: library (93 KB), two catalogue pages
  (50 KB each), two genre lists, and **the changelog (123 KB)** — ~365 KB of JSON parsed on the JS thread during
  the first seconds of browsing, when the viewer is most likely to be holding a key. The changelog is only read by
  Settings → What's new.
- `prefetch.ts:47-57`: a 450 ms dwell fires up to two requests per card; the meta call costs the *server* 0.36–0.48 s
  when cold (Cinemeta), and every answer is parsed and kept (F1).
- **Fix.** Drop the changelog from the warm list; start the warm on the first idle moment (no focus move for ~1.5 s)
  rather than on a fixed clock; skip a step while a key was pressed in the last second (focus.ts already keeps
  `lastFocusMoveAt`).
- **Impact: small–medium** in the first 10 s of a session. **Effort:** 30 min. **Risk:** none.

### D3. Opening Detail: 7–9 requests, each its own render of a 3,000-line component

Per visit: `api.item` (`:867`), `api.library` when the card has no `inLibrary` (`:898` — the **whole library, 93 KB**,
to find one title; hero and My List cards take this path), then a second `api.item`, `api.watchlist` (`:925` — the
whole list to compute one boolean, not memoised, on every visit), `imdbFor`, `discoverMeta`, `api.state` (`:1504`,
again on **every** focus), `api.downloads` (`:1036`), two `api.catalog` calls for "more like this" **awaited one
after the other** (`:1387-1389`, a `for … await`), the trailer prepare (`:813`), `loadMe`. Each resolves into its own
`setState` → 8+ renders of `Detail` in the first second, while the 260 ms fade runs.
- `Detail.tsx:1618`: the jobs effect depends on `loadEpJobs`, which depends on `libImdb` — so for a library title
  `/api/downloads` is read, the effect torn down, and read **again** when the id resolves.
- **Fix.** Server: one `/api/title?…` that answers item + inList + progress for this title + jobs for this title
  (deep); or cheaply: `Promise.all` the two catalogue calls; read `inLibrary`/`inList` from data already in memory
  (the library memo, a watchlist memo with a short TTL invalidated by `toggleWatchlist`); key the jobs effect on a
  ref instead of `loadEpJobs`; batch the first wave of results into one state object.
- **Impact: medium** on the open of a title page. **Effort:** half a day (client only) / 1–2 days (server endpoint).
  **Risk:** low for the client-only part.

### D4. What is refetched on every focus / return

Home: `/api/home` (15 s throttle), `/api/party`, `/api/downloads?profile=`, `tv-version.json` (after 1.5 s).
Detail: `/api/profiles/<id>/state`, `/api/downloads`. MyList: `/watchlist` + `/state` (`MyList.tsx:134`).
None is conditional; `state` is the whole profile's progress map each time. Fix as B1 (an unchanged-body
short-circuit in `request()` would cover all of them at once: keep `{etag, parsed}` per path and send
`If-None-Match`).

### D5. Every GET is delivered to JS in 8 KB pieces

`api.ts:539-543` sets `onprogress` and `onreadystatechange` with `responseType = 'text'`. On Android that makes
React Native read the body with `readWithProgress` (`NetworkingModule.kt:820`, 8 KB chunks) and emit one
native→JS event per chunk; JS appends (`_response += …`) and the handler re-arms a timer each time. `/api/home` =
~26 events instead of 1. It is the price of the idle-timeout design. **Impact: small.** If it shows up in a
profile: keep `onreadystatechange` for the first byte only (clear it at state 2) and drop `onprogress` for
requests outside the big-path list; the 30 s idle guard then applies to the big lists only.

---

## E. Player

- **What redraws while a film plays, chrome hidden:** nothing per frame from JS. Progress arrives at 1 Hz
  (`Player.tsx:2808`) and only writes refs (`:2439-2475`); `setCurrent` runs only while the chrome is up. The cue layer
  ticks every 200 ms but sets state only when the text changes (`:325-365`) — a memoised leaf. Good design.
- **Chrome up:** `setCurrent` + `setBuffered` once a second re-render the whole 4,000-line `Player` function (the
  scrubber's `width: '${pct}%'` forces a layout). Moving the scrubber + the two times into a small memoised child that
  owns `current`/`buffered` would make that a leaf render. **Impact: small** (1 Hz). **Effort:** 2 h. **Risk:** low.
- **Seeking:** `seekPreview` state per key (`:686`) → whole-Player render per repeat while scrubbing. Same child fixes it.
- **Video surface:** the film is a `SurfaceView` (react-native-video default; `canvas.tsx:19-23` confirms the layer is
  scaled by SurfaceFlinger). The app window sits above it as one alpha-blended full-screen layer; with the chrome
  hidden the window does not redraw, so the UI costs nothing per video frame. Under the chrome, the window still
  contains `Ambient`'s opaque full-screen picture and the Player's black root (`Player.tsx:3549`) — two full-screen
  fills under a hole. Only matters while the chrome animates. The scrubber's fill and bead carry three `boxShadow`s
  (`:3713`, `:3726`) — `RENDER.md`'s most expensive primitive — redrawn on every chrome frame.
- **The hero trailer is the opposite case** (`Trailer.tsx:152`): `ViewType.TEXTURE` so the cross-fade's opacity
  reaches the picture. A `TextureView` is drawn *inside* the window: every video frame (24–30/s) invalidates it and
  the RenderThread replays the whole Home tree — the ~12 ms of work `RENDER.md` measured — for as long as the trailer
  runs, plus `progressUpdateInterval={500}` (`:159`). See G3.
- **JS during playback:** POST `/progress` every 5 s (`:2139`) + ws `activity` every 5 s (`:2124`) + 2 s / 5 s
  watchdogs on refs. Negligible next to a hardware decode; merging the POST into the socket message would remove
  one HTTP round trip per 5 s.
- **Buffer:** `maxBufferMs: 120000`, `backBufferDurationMs: 30000` (`:159-164`); low-RAM boxes get 10 s back buffer
  (`:175-177`) and `DEPENDING_ON_MEMORY` (`:2801`). See H1 for who is "low-RAM".

---

## F. Memory

- **F1. `memoStore` never evicts** (`api.ts:623-634`). An expired entry is only replaced when the same key is asked
  again; nothing sweeps. Keys: every title a card dwelt on (`meta:…`, `/api/item/…`), every catalogue first page
  per type × category × genre (50 KB JSON ≈ 150+ KB of heap each), `imdbFor`, trailers. A long evening of browsing
  keeps all of it; only `library_updated` empties it (all at once, A6). Fix: sweep expired entries on insert and cap
  at ~60 keys (Map order = age). **Impact: small** (a few MB on a 2 GB box). **Effort:** 10 lines. **Risk:** none.
- **F2. Blur-up strings** (`blur.ts`): bounded at 3,000 × ~300 B ≈ 1 MB. `/api/home` carries 120 (35.7 KB,
  17 % of the response). Fine. `drawn` is cleared wholesale at 4,000 — after that every card shows its
  placeholder again once; harmless.
- **F3. Home's parsed payload** (≈0.5–1 MB of heap for 249 items with synopses and URLs) lives as long as Home; D1 halves it.
- **F4. Browse's per-screen `cache` ref** (`Browse.tsx:261`) holds every catalogue list opened this visit; released on unmount. Fine.
- **F5. Trailers:** `prepared` / `resolved` / `failedAt` maps (`trailers.ts`) grow by one small entry per title; no bound, negligible.
- **F6. Fresco** (`MainApplication.kt`, `frescoConfig()`): React Native's defaults — ARGB_8888, software bitmaps (so
  every picture exists twice: the bitmap and its GL texture; `RENDER.md` reports 76–88 MB of GPU cache), cache sized
  from `memoryClass`. The trim registry is the app's own addition: `onTrimMemory` ≥ UI_HIDDEN empties the caches,
  RUNNING_CRITICAL trims and flips the session to low-RAM (`perfTier.ts:255-263`). Reasonable. Not tried anywhere:
  `Bitmap.Config.HARDWARE` for decoded posters (one copy instead of two) — a lab experiment, with the caveat that
  the native card's own drawing must not read pixels.
- **F7. Mounted-but-unseen pictures**: B4 (rows never unmount) is the largest holder — ~0.4 MB per card bitmap plus texture.
- **F8. `clearImageMemory()` on entering the Player** (`Player.tsx:605`) only on low-RAM boxes — see H1: it may be running on boxes that are not.

---

## G. Startup

Sequence (`App.tsx:61-183`): `loadSession` (4 AsyncStorage reads, parallel) → `resolveServer` → [closed mode: `me` →
`profile-token` → `saveProfile`] or [open: `api.state(profileId)`] → `setStage('home')` → navigator + all screen
modules evaluated (B6) → Home mounts → `api.home` → first content. Native side: `MainApplication.onCreate` reads two
small SharedPreferences (`AuroraQa.load`, `AuroraExp.ensureLoaded`) on the main thread and loads React Native; the
modules do nothing heavy in their constructors (NewPipe is initialised lazily, the GL probe is cached per firmware).

- **G1. Server discovery is serial with a 2 s timeout and a retry** (`api.ts:704-711`). Production list:
  `10.0.0.1:4000`, then `nufurora.com`. A TV that is not in the house (every remote viewer) waits for the LAN ping
  to time out **twice — up to 4 s on a black loading screen, on every cold start**, before the server it always
  ends up on is even asked. The saved address is deliberately ignored (the comment at `:681-702` explains why).
  **Fix:** ping both at once; LAN wins if it answers; if the remote answers first, give the LAN a short grace
  (≈600 ms) and go; retry only when *both* failed (the "Wi-Fi still waking" case fails both).
  **Impact: large for remote TVs (−2…−4 s per launch), none in the house.** **Effort:** 1 h. **Risk:** medium —
  this code has three recorded incidents; the in-house priority rule must stay ("LAN whenever it answers").
- **G2. Three round trips in a row before content**: ping → `api.state` (`App.tsx:124`, only a validity check) →
  `/api/home`. Start `/api/home` in parallel with `state` and hand the promise to Home (a one-shot memo keyed by
  profile). **Impact: small on LAN, medium over the internet** (one RTT + 53 KB gz sooner). **Effort:** 30 min.
  **Risk:** low.
- **G3. The first hero's trailer is resolved at the worst moment** (`Home.tsx:673-693`): at Home's first render the
  effect fires `discoverMeta` + `/api/trailer` and, for YouTube, the NewPipe extractor (network + signature
  deciphering on a pool thread) — concurrently with the first 24 posters and the hero backdrop on four slow cores.
  The trailer cannot start before 4.5 s anyway. Delay the prepare by ~1.5–2 s. **Impact: small. Risk:** none
  (still ready by 4.5 s; the resolve takes 1–2 s per the comment at `:670`).
- **G4. Bundle:** 2.62 MB Hermes bytecode; `inlineRequires` on; no lazy screens (B6). APK 46 MB with two ABIs.
  `enableProguardInReleaseBuilds = false` (`build.gradle:137`) — R8 would shrink the dex (startup class loading);
  not free to turn on (keep rules for NewPipe/Rhino). Lab.
- **G5. Home's first commit** — B3.

---

## H. Perf tiers (`perfTier.ts`)

- **What the tiers switch off.** *Lite*: hero trailers (`Home.tsx:665`), the rail's moving hues (`NavRail.tsx:111`,
  and the `lite` prop of the native panel). That is all. *Low-RAM*: ExoPlayer buffers by memory with a 10 s back
  buffer, and Fresco's memory caches are emptied on entering the Player (`Player.tsx:605`).
- **H1. The low-RAM frame threshold probably trips on a healthy TV.** `LOW_RAM_FRAME_P90_MS = 33` (`:81`) against
  JankStats' *total* frame duration (`DeviceModule.kt` `frameDurationTotalNanos` on Android 12+). `RENDER.md` shows
  why that number is not "work": on Home the pipeline runs two frames deep, frames "take" 35 ms from vsync to
  completion while the RenderThread works 12 ms. The benchmark's own p90 on Home is 36–53 ms on the Mi TV
  (`REPORT.md`, `js.jsonl`). So whenever the viewer moves during the 5–25 s judging window (`:223-248`), the Mi TV
  — the reference device — is marked low-RAM `frames`. Consequence: `clearImageMemory()` on every entry to the
  Player; Home/Detail under it are detached, so their pictures are released, and **every card re-decodes from disk
  on the way back** — a self-inflicted stutter on return, on a box with memory to spare. Also a frame-time verdict
  is stored under a memory name. **Not verified on the device:** check `perf` events with `low: 'frames'`
  (Admin → Analytics; `perfTier.ts:187`, `:211`).
  **Fix:** judge frames for *lite*, not for low-RAM; if a frame rule stays, use janky % (JankStats' `isJank`) or
  p90 > 50 ms; keep low-RAM for the four memory signals only.
- **H2. The lite measurement cannot see the bottleneck.** `:104-123` times 150 `requestAnimationFrame` deltas on the
  JS thread and marks lite at p90 > 40 ms (`:120`). rAF ticks at vsync whenever the JS thread is idle, whatever the
  RenderThread is doing; `RENDER.md` shows the RenderThread is what binds Home. A box at 20 fps with an idle JS
  thread measures 16.7 ms and is never lite; in practice lite = "Android 9 or older" (`:83`). Use the JankStats
  histogram that is already being collected (janky % > ~15, or p90 > 50) for lite.
- **H3. What else should be tiered on lite** (each is already known to cost, or is in this audit): stack `animation:
  'none'` (B6); no blur-up placeholders (C3); the progress bar's two glows and the dot/ring/Play `boxShadow`s
  (`RENDER.md`: 2.2–2.9 ms/frame — `x_progshadow` exists as the switch); text shadows on card labels; hero
  rotation paused or without the 52 dp lockup slide; `VISIBLE_AHEAD` 5 → 4; `useScreenIn`'s entry animation; the
  warm-up prefetch (D2) and the dwell prefetch (longer dwell, 800 ms).
- **H4.** `report()` (`:177-189`) deletes a screen's counts when it has fewer than 30 frames (`:181`) instead of
  keeping them to merge next time, so briefly-visited screens (Search, Settings) never report; and after 6 events
  the interval and the JankStats listener keep running with nowhere to send (A5).

---

## I. Dead weight

- **Unreachable:** the `Sources` *route* (`Sources.tsx:736-757` + its full-screen art branch `:628-643`; nothing
  pushes `'Sources'` — Detail embeds `SourcesPanel`). `DetailHero`'s `poster` prop and style (`Detail.tsx:262`,
  `:272-274`, `:2751-2759`) — never passed. `styles.heroPoster` (`Home.tsx:1288`). `export const focusRing`
  (`Focusable.tsx:685`). `trailerStepDown` (`Trailer.tsx:19`, a no-op "kept for the callers" with no callers).
  `api.ping` (`api.ts:853`, unused; it would 401 in closed mode). `api.discover` (unused; the answer is 219,741 B).
  `resolveServer`'s `_savedUrl` parameter. `acceptTvEvent`'s key-down branch if key-downs never reach JS (bug 5).
- **Not required by any module** (repo weight only — Metro does not ship them): `ambient-grain.png`,
  `ambient-veil.png`, `card-shade.png`, `edge-ramp.png`, `foot-ramp.png`, `hero-fade.png`, `logo.png`,
  `nav-scrim.png` (≈110 KB).
- **Twins that could go if the native path became the only one:** `JsFocusable` (≈300 lines: the Animated
  ring/spring, `ringRegistry`, the `AuroraRingLit`/`AuroraRingClear` bridge and `jsRingClaimed`), `JsCard` (≈340
  lines; the retry ladder is duplicated in `CardImageLadder.kt`), `JsRow` + `useSlide` for shelves, Home's
  `HeroArt` + `Animated` column + `toRow`/`toHero`/`atTop`, the rail's JS panel (`RailHues`, `Scrim`, the SVG
  feather), the "restate inline + fixture generator" machinery around `rowMath.ts`/`homeMath.ts`, `impl.ts`, the
  JS-side trace hooks (`traceValue`, `traceDerived`, `useTraces`), and the 21 `x_…` removal switches threaded
  through `Card`/`Row`/`Home`/`NavRail`/`Btn`/`Icon`. If instead JS stays the only one in production, none of the
  lab code ships and this list is empty there.
- **41 `console.log` calls** in `src/`, none on the per-key path (the focus log is gated). Harmless.

---

## Ranked top 15

| # | finding | impact (weak box) | effort | risk | where |
|---|---|---|---|---|---|
| 1 | A1 — every Home state change re-renders all Rows and Cards (inline `onItemFocus`); interpolations rebuilt per render | large (JS path = production) | 1 h | very low | prod |
| 2 | B1 — return to Home: identical 206 KB refetched, parsed, every card re-rendered; + 2 more full renders | large | 1–2 h | low | prod |
| 3 | B2 — Browse: page append gives every item a new identity → whole window re-renders; 12-card batches; no `getItemLayout` | medium–large | 1 h | low | prod |
| 4 | B5 — cards are created/destroyed, never recycled (pool by slot; or the native row owning its cards) | large on the long frames | 2–4 d | medium | lab |
| 5 | B4 — Home keeps every visited shelf mounted (342 → 757 views measured) | medium–large, memory too | 1 d | medium | lab |
| 6 | G1 — serial server discovery: up to 4 s of black screen per cold start for TVs outside the house | large there, none at home | 1 h | medium | prod, carefully |
| 7 | H1/H2 — low-RAM judged by a frame number the healthy Mi TV exceeds → image caches emptied on entering the Player → re-decode on return; lite judged on the wrong thread | medium (verify first) | 2 h | low | prod after a check |
| 8 | C1 — episode stills bypass the server (host not proxied) and are re-encoded on the box per card; `/img/still`, `/img/frame` cannot be sized | medium | 1 h | low | prod (server + TV) |
| 9 | B3 — first commit mounts 4 shelves, 1 visible | medium (startup) | 30 min | low | prod (after #1) |
| 10 | D1 — `/api/home` cards carry synopsis + player URLs: 171 KB → ~80 KB | medium (slow lines, parse, heap) | 1 h | low–medium | prod (server) |
| 11 | D3 — Detail open: 7–9 requests → 8+ renders; whole library/watchlist for one boolean; downloads read twice; sequential awaits | medium | 0.5–2 d | low | prod (client part) |
| 12 | A2 — 3 of 8 animation starts per key are redundant | small–medium | 30 min | low | prod |
| 13 | B6 — all screen modules evaluated before the first frame (`getComponent`) | small–medium (cold start) | 20 min | low | prod |
| 14 | G3 + E — hero trailer: resolved at cold start; `TextureView` redraws the whole Home tree per video frame | medium while a trailer plays | 10 min / days | none / medium | prod / lab |
| 15 | C2/C3/C4/C6 — remaining on-box picture work: frame cards `resize`, blur-up `blurRadius`, poster-backdrop blur 28, double backdrop on library titles, SVG gradients and the kind glyph | small each, medium together | 0.5 d | low | mixed |

Below the line (small): D2 prefetch timing and the 123 KB changelog warm; F1 memo eviction; A6 Browse listener +
whole-memo wipe; D5 incremental XHR events; Player scrubber as a leaf; A5 monitors that never stop; `uiSeasons` reuse.

## Safe to do in the production app right now (small, low risk, no visual change)

1. **Stable `onItemFocus` for `Row`** (`Home.tsx:757` in production) + `useMemo` the two interpolations in `Focusable`. (A1)
2. **`setParties` with an equality check** (`Home.tsx:411/413`). (A1/B1)
3. **`api.home`: return the previous object when the response text is unchanged** (or `If-None-Match`). (B1)
4. **Browse: tag `source: 'stream'` when a page is fetched, not in the memo**; `maxToRenderPerBatch={cols}`; stable `claims`. (B2/A3)
5. **Skip the duplicate fade-out and the unchanged `ty.to`** (`Focusable.tsx:293/424`, `Home.tsx:847`). (A2)
6. **`reach` 1 → 3 after the first frame** (do #1 first). (B3)
7. **`getComponent` for every screen but Home.** (B6)
8. **Frame cards: `resizeMethod='auto'`** (`Card.tsx:390`). (C2)
9. **Add `episodes.metahub.space` to both allow-lists** (`api.ts:751`, `stream.js:155`). (C1, first half)
10. **Take the changelog out of `warmSections`**; delay the first hero's trailer prepare by ~2 s. (D2, G3)
11. **`memoStore`: sweep expired + cap; `library_updated` forgets only library keys; gate Browse's listener on focus.** (F1, A6)
12. **`Promise.all` the two "more like this" catalogue calls; key Detail's jobs effect on a ref.** (D3)
13. **X-Ray faces `fadeDuration={0}`**; stop the perf interval and JankStats tracking once the quota is spent. (C5, A5)
14. **`/api/home?slim=1` through `cardStrip`** (server) — after deciding what the launcher row's description shows. (D1)

## Needs the lab (measure on the TV, or changes how something looks/behaves)

- B5 card recycling (and the `WINDOW_SLACK` 3 → 1 experiment); B4 vertical windowing of Home's shelves.
- G1 parallel server discovery (three past incidents in that function).
- H1/H2 tier thresholds: first read what the field reports (`low: 'frames'`), then move the frame rule to lite.
- H3 the lite list (transition `none`, no blur-up, no glows) — each changes pixels.
- C3 placeholder without `blurRadius`; C4 server-blurred poster backdrop and the single-backdrop rule; C6 baked
  kind glyph / skeleton / rail scrim — pixel-diff each.
- C1 second half: `?w=` on `/img/still` and `/img/frame`.
- `getItemLayout` on the grids; `initialNumToRender` 18.
- E: the scrubber as a memoised leaf; the hero trailer on a `SurfaceView` behind a hole instead of a `TextureView`.
- D3 the one-request title endpoint; D1 lazy rows.
- F6 hardware bitmaps; G4 R8.
- Episode rail and the other horizontal `FlatList`s on the shelf's retargetable slide.

## Things that look like BUGS (not perf), tripped over on the way

1. **Regression of a documented fix.** `motion.ts:53-58` records that an unstable handler made every card re-render
   on each Home render and that it was fixed; `Home.tsx:943-948` (production `:757`) passes a fresh arrow per row per
   render, which re-creates the same effect. (Perf in effect; listed here because the code contradicts its own note.)
2. **"Low-RAM" can be decided by frame time** (`perfTier.ts:237`, `:242`) with a threshold (33 ms) below the
   reference TV's normal Home p90 (36–53 ms). The label then drives memory behaviour (`Player.tsx:605`). Suspected,
   not verified on the device.
3. **A library title's backdrop changes about a second after the page opens** (`Detail.tsx:1480-1483`): the still
   first, then metahub's key art once the IMDb id resolves — two different pictures, each fading in. Read from the
   code, not seen on the TV.
4. **A 200 answer that is not JSON surfaces a raw parser error.** `api.ts:608` `await res.json()` is not guarded;
   a captive portal or a proxy error page returning HTML with status 200 throws a `SyntaxError`, and Home prints
   its message as the error detail (`Home.tsx:355`).
5. **Two comments in `focus.ts` contradict each other about what JS receives.** `:104-109`: key-downs are never
   sent to JS (`enableKeyDownEvents` off — it is `false` in `ReactFeatureFlags.kt:34`). `:294-302`: "reports a
   D-pad press TWICE… the key-down is acted on". If the first is right, `acceptTvEvent`'s down branch and the
   `lastDown` map are dead and every handler acts on key-UP only (which also means a held key gives JS nothing
   until release). Worth one look with the focus log on.
6. `perfTier.ts:181` deletes a screen's frame counts when there are fewer than 30, instead of keeping them to merge:
   short visits never reach the analytics table.
7. `realtime.ts:99` `forgetMemo()` clears every memoised read on `library_updated`, not just library-derived ones
   (`Detail.tsx:967-968` shows the narrower call).
8. `Browse.tsx:224` refetches the library on `library_updated` even when the screen is buried under Detail/Player
   (Home gates the same event on `live`).
9. `api.ts:853` `ping: () => request<Home>('/api/home')` — unused, and its comment ("public and cheap") is no longer
   true (401 in closed mode, 171 KB).
10. The TV's proxy list (`api.ts:751-758`) and the server's (`stream.js:155-164`) differ: the server also allows
    `thumb.wikimedia.org`; neither has `episodes.metahub.space`.
11. `Card.tsx:315` computes NEW from `Date.now()` during render of a memoised card: a card mounted on day 6 keeps
    its NEW pill until something re-renders it. Cosmetic.

## What was not verified

- No timing on a device: every "ms" that is not a payload size or a quote from `RENDER.md`/`REPORT.md` is an estimate.
  The cheapest check for A1/B1/B2: a render counter in `JsCard` behind the QA flag, logged per key.
- `/api/profiles/<id>/state` and `/watchlist` sizes (401 without an unlock token; POST was out of bounds).
- Whether the Mi TV is actually flagged `low: 'frames'` in the field (H1).
- Hermes `JSON.parse` speed on the A55 (10–30 ms for 206 KB is a guess; on this PC's node it is 0.56 ms).
- The host-view counts per card and per screen are counted from the JSX, not from a view dump (they agree with
  gfxinfo's 305–357 for Home at rest).

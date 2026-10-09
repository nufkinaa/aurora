# 11c · 1:1 spec — Pick (AI), Settings, Downloads, SignIn, ProfileGate, WhatsNew, Search

Part of [11-spec-detail-player-pick.md](11-spec-detail-player-pick.md). HEAD `42bb208`. All pages except SignIn/ProfileGate sit beside the nav rail and use the content gutters `paddingLeft 84 (contentLeft)`, `paddingRight 48 (pageX)`; **`paddingTop 27`** (= `pageY`) on Settings/WhatsNew/Downloads/Search and on Pick's list content.

---

## 1. Pick.tsx — the AI page (670 lines)

### 1.1 Data and constants (`:46-97`)
`KINDS` Movies (mix 0) / Shows (mix 100); `ERAS` Any era · Recent · Not too old · A classic; `LENGTHS.movie` Any length · Under 100 min · Under 2 hours · Something long; `LENGTHS.show` Any length · One or two seasons · Many seasons; `EXAMPLES` four mood strings; `STAGES` four narration lines cycling every **2 600 ms** while busy (`:181-186`); `OFF_TEXT` the no-key notice; `GAP 14`; `AMBER #fbbf24`; `MINT #8cffbe`. The last answer lives at module scope and is restored on return (`:97`, `:120-127`).

### 1.2 Grid geometry
`cols = max(4, floor((width − 84 − 48 + 14) / (COMPACT_W + 14)))` = **6** @960 (`:115-118`; `COMPACT_W 116`, `COMPACT_H 174`, `Card.tsx:46-47`). The whole page is one `FlatList` (`numColumns cols`, header = the controls, `ListEmptyComponent` = the state body), content `paddingTop 27`, `paddingBottom 61 + safeBottom` (`:538-553`, `:565`); rows `gap 14, marginBottom 18` (`:648`).

### 1.3 Header (`:323-483`; styles `:568-656`)
- Kicker row gap 6: `sparkle` 16 `accent` + `AI` 13/`800` ls 3 `accent`.
- `h1` `What are you in the mood for?` 24/`900` lineHeight 30 mt 2, one line; `sub` 14 lineHeight 19 `textDim` mt 2 mb 12, one line.
- Off notice (recommender not configured): row gap 10, pv 9 / ph 14, radius 12, fill `rgba(251,191,36,0.08)`, border 1 `rgba(251,191,36,0.35)`, mb 12; `warning` icon 20 amber; text amber 14/`600` lineHeight 19.
- **Panel** (`styles.panel`): fill `rgba(255,255,255,0.035)`, border 1 `line`, radius 18, pv 12 / ph 14.
  - `askRow` row gap 12: **field** flex 1, height 44, row gap 10, paddingLeft 14 / paddingRight 8, radius 12, `surface`, border 1 `line`; focused → border `accent` + fill `surfaceHover`; off → opacity 0.55, not editable. `chat` icon 18 (`accent` when focused else `textFaint`); `TextInput` 16 `text`, placeholder `e.g. <example>` (example rotates with the typed length), maxLength 300, **no autoFocus**. Then `Btn primary icon="sparkle"` `Find me something` / `Thinking…` — **preferred focus on arrival**; wrapped in a `TVFocusGuideView trapFocusLeft` while the field is off.
  - `hr` 1 dp `line`, mv 12.
  - `dialRow` row `alignItems center` gap 16: `Group WHAT` (icon film/series) → two `Chip small` (`Movies`, `Shows`; first `edgeLeft`); `vr` 1 dp `line` stretched, mv 4; `Group ERA` (calendar) → four chips. `dialRowNext` mt 8: `Group LENGTH` (clock) → the kind's lengths (first `edgeLeft`). Group = row gap 6; label column **width 92** (icon 16 `accent` + text 13/`800` ls 1.4 `textDim`).
- **Folded summary** (`:343-368`, `:617-633`), drawn instead of the panel once picks exist and focus is in the grid: Focusable `round ring="none" highlightColor={white}` — same glass fill/border/radius 18 as the panel, pv 10 / ph 14, row gap 10: `chat` 16 `accent`; vibe 15/`700` (`No mood given` when empty); dials 14/`600` `textDim` separated by `·` in `textFaint`; `Change` 13/`700` `textFaint` `marginLeft auto`. **Focusing it unfolds** (`onFocusChange` → `unfold`): panel back, Find re-focused at 0 and 150 ms, and the summary stays mounted invisible (`summaryGhost`: opacity 0, height 0, no padding/border) for **400 ms** as a hand-off so Android never drops focus onto the first pick (`:146-153`). **[KEEP-AS-IS?]** a white `highlightColor` on a `ring="none"` Focusable means the line flashes white for the frame it is focused before unfolding.
- **Picks head** (`picksHead` row gap 8 mt 14 mb 16), shown from the first ask on: `sparkle` 16 `accent`; `Picked for you` / `Thinking…` / `No picks` 16/`800`; status 14 `textDim` flex 1 (`6 films for “…” · from earlier · not much fits those filters, try loosening one` or the stage line while busy); legend (`check` 13 mint `on this server`, `play` 13 `textFaint` `streams`, 13 `textFaint`); `Btn small icon="refresh"` `Try again` (`dim` while busy).

### 1.4 Cards (`renderCard`, `:281-308`; styles `:649-656`)
`pick` width 116: `Card compact` (116×174, `Card.tsx:468`: radius 12, `bgRaised`, border 1 `rgba(226,229,238,0.3)`), `edgeLeft` on every row's first; title 14/`700` lineHeight 18 mt 7 one line; meta row gap 4 mt 1: `check` 13 mint (on this server) or `play` 13 `textFaint` + year 13 lineHeight 17 (`textDim`, mint when on server; `On server`/`Stream` when no year); `why` 13 lineHeight 17 `textDim` mt 4, **3 lines**.

### 1.5 Body states (`:486-532`)
- Busy: `waitRow` (MiniSpinner + 14 `textFaint` copy) mb 14, then one row of `cols` skeletons 116×174 with two shimmer lines (10 dp, radius 5, `rgba(255,255,255,0.06)`, mt 9 / mt 6 60 % wide).
- Error: `warning` 28 `#ff7a7a`, message 16/`700` `#ff7a7a`, hint `Try again in a moment, or change the question.` 14 `textDim`; `state` pv 36 gap 8 centred.
- Empty: `search` 28 `textDim`, `Nothing matched — try fewer filters`, `Or describe it a different way.`
- Before the first ask (and not off): `Try` 14/`700` `textFaint` + three `Chip small bare` examples (wrap, gap 6, mt 14); a press asks with that text.

### 1.6 Focus and keys (`:191-220`, `:222-272`)
- UP from the grid's **top row** goes to `Try again` (or Find when there is no answer) deterministically (`useTVKeys`, `:207-211`). LEFT from Find while the field is off → the first What chip, else the rail (`:202-206`).
- Focusing a card folds the panel (`:215-220`). After an answer lands the panel folds and focus moves to `Try again` (0 and 150 ms) because Find is about to unmount (`:261-264`).
- Fallbacks: the field (via `focus()`), then Find (registered later, so it wins) (`:155-161`).
- Ask: < 3 chars → focus the field; off → toast `OFF_TEXT` ⚠️.

---

## 2. Settings.tsx (423 lines)
`ScrollView`, content `pl 84 / pr 48 / pt 27`, bottom `safeBottom + 32` (`:187-189`, `:387`).
- `h1` `Settings` 24/`900` mt 14; `sub` `for <name>` 15 `textDim` mt 2; `h2` 18/`800` mt 32 mb 4; `note` 13 `textDim` mb 14 maxWidth 720 (`:388-397`).
- **Genre chips** (`:200-219`, `:398-408`): wrap gap 8; Focusable `round light={on}`: `surface`, border 1 `line`, pv 8 / ph 18; on → white, border transparent; text 13/`700` `textDim` → `bg`. `edgeLeft` is **measured** from layout x < 2 (`:91-100`). Toggle = fire-and-forget `setPreferences`.
- **Rows** (`Row`, `:32-60`, `:409-422`): Focusable `scaleTo 1.01 edgeLeft highlightColor={surfaceHover}`; row gap 14, `surface`, radius 12, pv 14 / ph 14; label 15/`700`; note 13 `textFaint` mt 2; value 15/`800` `accent` right (`›`, `On`/`Off`, `Hebrew`, `Medium`, `Update`/`Check`). Lists gap 8.
- Sections and rows, in order: **Aurora** — What's new (`•` suffix when unseen), My downloads, Join a watch party, Report a problem. **Playback** — Autoplay next episode; Trailers on the home billboard (note and value change on a lite box: forced `Off`). **Subtitles** — Turn subtitles on automatically; Preferred subtitle language (cycles `any → he → en`, labels `First available / Hebrew / English`); Subtitle size (S/M/L → Small/Medium/Large); Subtitle background. **Notifications** — download notices (asks the Android 13 permission when turned on; failure replaces the note). **Privacy** — Usage stats. **This TV** — `Aurora TV 5.1.28` with note `Version x is available — press to update.` / `Checking…` / `Press to check for a newer version.`; value `Update`/`Check`. **Account** (only with a session) — `signOut` box (`surface`, radius 12, pv 14 / ph 18, mt 2; 15/`700` + 13 `textFaint` note) with `scaleTo 1.01`.
- An update check on open; pressing Check toasts `You're on the latest version (…)` ✓ when none.

---

## 3. Downloads.tsx (258 lines) — reached from Settings
`ScrollView` `pl 84 / pr 48 / pt 27`. `h1` `My downloads` 24/`900` mt 14; sections (`marginTop 20, gap 8`) `Ready to play` · `On its way` · `Waiting for approval` · `Didn't make it` · `Also on the server`, each `h2` 18/`800` mb 8 with a count 13/`700` `textFaint`. Empty → `Empty` state (`States.tsx`: glyph 35, message 16 `textDim`, `Back` Btn; pv 45, gap 14).
- Row (`:158-188`, `:235-257`): Focusable `scaleTo 1.01 edgeLeft highlightColor={surfaceHover}`, first row focused; row gap 14, fill `rgba(255,255,255,0.06)`, border 1 `rgba(255,255,255,0.08)` (done → `rgba(74,222,128,0.35)`), radius 12, padding 10 (right 14). Poster 44×66 radius 8 `bgRaised` (`artSrc(poster, 44)`); title 15/`700` one line + `NEW` tag (white-on-`#4ade80` 11/`900` radius 4 ph 6) + quality 12/`900` ls 1 `#60a5fa`; status 13 `textDim` mt 3 (`Ready · 5 min ago`, `37% · 2.1 MB/s · 12 min left`, `Finding peers…`, `Copying into the library · 80%`, `Queued — starts when a slot frees up`, `Waiting for approval — <reason>`, `Declined by the admin`, `Canceled`, `Failed — <error>`, prefixed `Next episode, queued for you · ` for smart downloads, suffixed ` · 1.4 GB`); progress bar height 4 radius 2 `rgba(255,255,255,0.14)` mt 8 with `accent` fill while active; action text right 13/`800` minWidth 70: `▶  Play` / `Cancel` / `Remove`.
- Live over the socket (`download_update`, `download_removed`, `welcome`); a 15 s poll only when the socket is shut (`:88-119`).

---

## 4. SignIn.tsx (453 lines) — QR pairing
Root: `bg`, `paddingHorizontal 72` (pageX + 24), vertically centred, no rail (`:392-397`).
- Kicker `SIGN IN` 13/`800` ls 3 `accent`; heading **30**/`900` mt 4; sub 15 `textDim` mt 6 maxWidth 560 (`:398-400`).
- **QR home** (`:338-388`): `pairRow` row `alignItems center` gap 32 mt 20: `qrCard` **230×230**, radius 18, white, centred, holding a `QRCode` of `<base><linkPath>` at **size 190**, modules `#0b0c14` on `#ffffff` (a `bg`-coloured `ActivityIndicator` while minting). `pairText` flex 1 maxWidth 520: `No camera handy? On your phone, open` (sub) · `<host>/link` 18/`800` mt 2 · `and type this code:` · the code **40/`900` letterSpacing 10** mt 4 (`· · · · · ·` while minting) · `Waiting for your phone…` 13/`600` `textFaint` mt 10 · pairing error `#ff8080` 15 · `New to Aurora? …` 13 `textFaint` mt 18. Buttons row gap 14 mt 32: `Type username & password` (ghost: `surface`, pv 13 / ph 24, text 15/`700`, **preferred focus**, the screen's focus fallback), `Continue with Google` (only when the server advertises a TV Google client).
- Pairing: `deviceStart` once; poll `devicePoll` every **3 000 ms**; a fresh code `max(30, expiresIn − 10)` s later; a 410 mints a new code at once (`:78-124`).
- **Typed** (`:237-279`): heading `Username & password`; two inputs (`surface`, border 1 `line`, radius 12, 18, pv 14 / ph 22, maxWidth 520, mt 14; first autoFocus; password secure); `Sign in` (primary: white, pv 13 / ph 34, minWidth 150, text 15/`800` `bg`; spinner while busy) + `Back` ghost; error line 15 `#ff8080` mt 14 maxWidth 560. BACK returns to the QR view.
- **Google** (`:281-335`): QR of the verification URL + `user_code` at the same 190 in the same card, right column `Scan the code, or on any device open` / url 18/`800` / `and enter` / code 40/`900` / `Waiting for Google…`; or the signup copy with `Request access` (primary, focused) when Google knows the account but no profile is linked; `Back` ghost.

---

## 5. ProfileGate.tsx (539 lines)
- `TILE_W 168`, `AVATAR 104` (`:42-43`); `cols = max(3, floor((width − 96 + 20)/(168 + 20)))` = **4** @960 (`:121-124`).
- Grid (`rootTop`: `bg`): `FlatList numColumns`, content `paddingHorizontal 48, paddingTop 32, paddingBottom 20`, row `gap 20, marginBottom 20`; header `Who's watching?` 30/`900` (+ spinner mt 20 / error 13 `#ff8080` mt 14 / `Try again` ghost when the list failed) (`:418-459`, `:471-475`).
- Tile (`:294-326`, `:476-508`): Focusable `scaleTo 1.07 highlightColor={surface}` (default white ring, radius 18), first tile focused (this TV's last profile — recents first, then by name); `alignItems center`, padding 14, radius 18, width 168; avatar 104×104 radius 18 filled `p.color || surfaceHover` with the image or the emoji 48; kids badge absolute `bottom −9` centred, `#86efac` pill ph 9 pv 2, `KIDS` 11/`800` ls 0.8 `#0b1a12`; name 15/`700` mt 14 one line with `  🔒` (password) or `  🚫` (locked) suffix; locked tiles opacity 0.45.
- Password / PIN views (`root`: `bg`, padding 48, centred): heading 30/`900` (`Enter password` / `Grown-ups only`); sub 18 `textDim` mt 8; input `surface` border 1 `line` radius 12, 18, pv 16 / ph 22, maxWidth 480, mt 20, autoFocus, secure (PIN: number pad, max 6, digits only); row gap 14 mt 20: primary (white, pv 14 / ph 40, minWidth 150; `Unlock`/`Open`) and `Back` ghost (pv 14 / ph 28); error 13 `#ff8080` mt 14. The password view deliberately gives **no** button preferred focus so the field's keyboard opens (`:394-398`).
- Kids lock: entering a kids profile locks the TV to it; leaving it asks for the household PIN (`exit` mode) unless no PIN is set; a password-less grown-up profile in a house with kids asks the PIN (`open` mode) (`:184-288`).

---

## 6. WhatsNew.tsx (209 lines)
`ScrollView` `pl 84 / pr 48 / pt 27`. Kicker `AURORA TV 5.1.28` 13/`800` ls 3 `accent`; `h1` `New in Aurora` 24/`900` mt 4; sub `Hi <name> — here's what this TV can do now, and how.` 15 `textDim` mt 2 mb 14.
- **Feature grid** (`:120-145`, `:177-203`): wrap gap 14; each card a Focusable `scaleTo 1.02 lift 2 highlightColor={surfaceHover}` (default ring, radius 18), `edgeLeft` on even indices, first focused; width **48.5 %**, row gap 14, padding 16, radius 18, fill `rgba(255,255,255,0.05)`, border 1 `rgba(255,255,255,0.08)` top `rgba(255,255,255,0.16)`. Cue box 52×52 radius 14 `rgba(139,123,255,0.16)` with the emoji at 26; body: title 15/`800`; `what` 14 lineHeight 20 `textDim` mt 4; `how` 14 lineHeight 20 `textFaint` mt 6 prefixed by `How ` in `textDim` 800; `<go label> ›` 14/`800` `accent` mt 8 when the feature has a destination. Nine fixed `FEATURES` (`:20-83`); a press runs the `go` action (home/movies/shows/settings section, join sheet, report sheet, Downloads).
- `Full changelog` / `Hide the full changelog` pill (`surface`, pv 10 / ph 20, mt 32, text 13/`700`, `edgeLeft`); when open, up to 8 releases: `relHead` `<version> — <date>` 15/`800` mb 6; items rendered as **plain text** `•  <item>` 14 lineHeight 21 `textDim` mb 6 (`:155-164`, `:206-208`). **There is no markdown rendering**: the server's changelog items are shown verbatim as single `Text` lines with a bullet prefix; nothing parses `*`, `_`, links or headings. Opening the page marks this version seen (the nav dot goes out).

---

## 7. Search.tsx (236 lines)
`body` `pl 84 / pr 48 / pt 27`. Input (`surface`, border 1 `line`, radius 12, **18**, pv 16 / ph 22, mb 20; autoFocus; placeholder `Search movies & shows…`) — while it has focus LEFT belongs to the field (`noteFocus(null,false)`, `:173-176`). `No matches yet…` 15 `textDim` mb 14 when a query has no results. Grid: `cols = max(3, floor((width − 84 − 48 + 14)/(124 + 14)))` = **6**; content `paddingTop 28, paddingBottom 61 + safeBottom, gap 14`; rows `gap 14, marginBottom 14`; standard `Card` 124×186, `edgeLeft` per row start. Local library hits appear instantly (`source: downloaded`); server results after a **350 ms** debounce, race-guarded, library titles removed (`:81-115`). UP from the grid's top row focuses the input deterministically (`:47-60`). Focus fallback = the input.

---

## 8. Native mapping notes — the small screens
- All of these are plain `LinearLayout`/`RecyclerView` work; the only non-trivial pieces are the QR (`zxing` `QRCodeWriter`, module colour `#0b0c14`, 190 dp inside a 230 dp white card — match the quiet zone by drawing the QR at 190 and letting the card provide the margin), the measured `edgeLeft` on wrapped genre chips (use `FlexboxLayout` and read each child's `left` after layout), and Pick's fold/unfold hand-off (keep the summary view in the hierarchy at 0 dp/alpha 0 for 400 ms before `GONE`, exactly as RN does, or focus falls into the grid).
- Pick's `TextInput` focus look (border `accent`, fill `surfaceHover`) and the Search/SignIn inputs are `EditText`s with state-list backgrounds; the on-screen keyboard behaviour (Pick: never auto-open; Search/SignIn/ProfileGate password: auto-open) is `requestFocus()` + `showSoftInput` policy.
- **Cannot be identical**: the `🔒 🚫 🍿 🎬 👥 ⏭ 💬 👆 ▶️ ⬇ 🔄 🛠️` glyphs depend on the TV's emoji font (same in both runtimes only if the same system font is used); `width: '48.5%'` with `gap 14` in a wrapping row must be computed as `(contentWidth − 14) / 2` rounded down so two cards fit as RN's Yoga does.

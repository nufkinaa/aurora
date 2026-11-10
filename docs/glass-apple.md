# The glass, closer to Apple's

Branch `glass-apple`, 2026-11-10. elia: "Try to make the glass on our website
more like apples, their looks good and text is always visible on it, it does
not have to be that clear but more accurate to how their looks."

This file: (1) what Apple's glass does, written before a line of CSS was
changed; (2) where our glass lives; (3) the new recipe; (4) what was tried,
kept and dropped; (5) the contrast in short; (6) performance; (7) what only
a real iPhone can say; (8) the recipe as plain values for the apps. The
whole contrast table is in `docs/qa/glass-apple/contrast.md`, the blind
comparison kit in `docs/qa/glass-apple/jury/`, the tools that made both in
`tools/glass-apple/`.

## 1. What Apple's glass does (from elia's iPhone recordings)

Source: frames of a screen recording of elia's iPhone (iOS 26, dark mode):
WhatsApp's tab bar at rest and pressed, the Apple TV app's tab bar at rest and
pressed, and our own tab bar on the same phone. All numbers below are sampled
from those frames (3 device px = 1 CSS px, values are 0–255 grey levels).
The two Apple TV frames are in the jury kit as its references; the WhatsApp
frames show private chats (names, faces, lines of messages), so they are NOT
in the repository — they stay on this PC, outside the worktree.

### The material at rest

- **It is dark and neutral.** The bar's interior is a flat dark grey:
  38–40 (`#262626`) in WhatsApp over a page of 13, 32 in Apple TV over pure
  black. No colour of its own: R, G and B are within one level of each other.
  Ours on the same phone is a blue wash (the bar is roughly `#17234f`).
- **It is not very clear.** What lies behind is dimmed a great deal and
  blurred a little: white chat text under the bar comes through as a soft
  grey ghost (about 85–95 where the bar is 38), still recognisable as words
  but far below the bar's own white labels (250+). A saturated photo under
  the bar keeps its hue, darker — colour comes through by saturation, not by
  a tint. In short: low transmission (a white backdrop ends near a third of
  its brightness), small blur radius, colour kept.
- **Labels and icons are plain white** (248–255), no shadow, medium weight.
  Because the material never gets brighter than a mid grey, white is always
  readable; Apple does not flip the text dark over a bright backdrop in these
  frames.
- **The rim is light caught on an edge, not an outline.**
  - top: a hairline 1–2 device px thick that peaks at 93–100 (white at about
    25–30 % over the bar), then a soft inner glow that starts near 50 and
    fades into the bar's grey over about 18 device px (6 CSS px);
  - bottom: the mirror, fainter in the glow — a gentle rise 40→45 over about
    15 device px, then a hairline at the very edge that is as bright as the
    top one (about 105). So the rim is top AND bottom, strongest where the
    surface turns away from the viewer;
  - sides: around the rounded ends the hairline thins out and a broader,
    softer band (50–60 for about 2 CSS px) takes over on the left end; the
    right end is nearly plain. Outside the hairline there is a 1 device px
    dark line (7) — the shadow the glass throws on the page right at its
    edge;
  - no big drop shadow in dark mode: the page is nearly black already. The
    separation comes from the rim and from the bar being lighter than black.
- **The shape is a full capsule** floating clear of the screen edges, with a
  second, separate round button (search) beside it in the same material.

### The selected tab

- A **darker capsule inside the bar**: 19–20 (`#131313`) inside WhatsApp's 38
  bar, 10 inside Apple TV's 32 bar — about half the bar's brightness, i.e. a
  black wash of roughly 45–65 %. It is inset a few px from the bar's edge and
  has the bar's own corner language (a capsule in a capsule).
- It has **no rim of its own** to speak of — at most the faintest inner line.
  It reads as a well pressed into the glass, not as a lit pill sitting on it.
  (Ours today is the opposite: a LIGHTER pill with a bright top line.)
- The label and icon on it: WhatsApp keeps them white; **Apple TV colours the
  icon and label in the app's accent** (its blue). The accent on near-black is
  the strongest "you are here" in the frame — stronger than our lighter pill.

### Pressed: the lens

- While a finger is on a tab, a **clear bubble** rises there: taller than the
  bar (it overhangs top and bottom by a few px), almost untinted, and it
  **magnifies** what is under it (the icon and label grow about 15–20 %).
- Its rim shows **chromatic fringes** (a thin blue/orange split) and dark
  crescents where it overhangs the bar — real refraction cues.
- It **slides** with the finger and settles into the new tab with a short
  spring; the dark selected capsule is what it leaves behind.
- Content at the bar's rounded ends is **squeezed** towards the edge (a
  profile picture under the left end is visibly bent): the bar refracts at
  its ends, even at rest. This is the only "liquid" cue at rest and it is
  subtle — the frame reads as glass without it.

### What makes it read as "Apple's" (in order of how much each one carries)

1. dark neutral body — a grey, never a colour;
2. white labels that are always readable, because the body is dark enough
   over anything;
3. the rim as a specular edge (top and bottom hairlines + inner glow) instead
   of an even 1 px border;
4. the selected state as a darker well, accent on the label;
5. capsule shapes, floating;
6. refraction at the ends and the lens on press — the "liquid" part, and the
   only part that needs more than `backdrop-filter` + gradients.

### What that means for a website

- 1–5 are tint, backdrop filter numbers, box-shadows and gradients: one set
  of tokens can carry them to every surface.
- The legibility rule is arithmetic. White text needs 4.5:1, so what is
  behind it must have a relative luminance of at most 0.183 (a grey of 118).
  The worst backdrop is pure white (saturation cannot lift anything above
  it), so the material must let through at most about 36 % of white — and
  it must do so by its TINT, not by its backdrop filter: Safari with reduced
  transparency, Firefox in places, our own lite and low-power paths all drop
  the filter, and text must still read.
- 6 needs `backdrop-filter: url(#displacement)`, which only Chromium draws.
  It can be an extra on top, never the base.

## 2. Where our glass lives

Every rule of the look is scoped `html[data-look="glass"]`; nearly all of
them are in `public/css/glass.css` (the site loads it inside the one bundle
`/css/aurora.css`). The recipe is a handful of custom properties at the top
of that file; the surfaces below take them, a few carried their own copy.

| surface | where | sizes | takes |
|---|---|---|---|
| tab bar (`.nav-items` at the foot) | glass.css, the phone block | phones, up to 720 px | chrome |
| floating top buttons (`.nav-logo`, `.nav-gear`, `.nav-profile`, `.nav-dl`) | glass.css | all | chrome |
| nav island (`.nav-items`, centred) and the bar of a tablet | glass.css | 721 px and up | chrome |
| chosen tab (`.nav-item.active`), open More (`.nav-more.open`) | glass.css | all | well |
| the remote's button in the nav (`.nav-remote`), its dock and picker | remote.css (not in the bundle; reads the tokens) | all | chrome |
| buttons over a picture (`.hero-actions .btn`, `.detail-actions .btn`), `.hero-unmute`, `.hero-picks` | glass.css | all | chrome |
| the phone's small action buttons on a title page | glass.css, the phone block | phones | slab, thin rim, no filter |
| menus and lists (`.nav-menu`, `.menu`, `.dropdown`, `.suggest-list`) | glass.css | all | thick |
| sheets and dialogs (`.look-notice`, `.peek`, `.modal`, `.claim-modal`, `.login-card`, `.trailer-box`) | glass.css | all | thick |
| toasts | glass.css | all | thick |
| chips and pills (`.chip`, `.cat-pill`, `.season-pill`, `.source-filter`, `.picker-btn`) | glass.css | all | slab, thin rim; chosen = well |
| panes in the page (`.pref-section`, `.detail-rate`, `.season-island`, `.dl-callout`, `.wrapped-card`, `.pair-card`, `.request-sent`) | glass.css | all | slab |
| rows in the page (`.episode`, `.source-row`, `.taste-tile`, `.party-strip-item`, `.dl-row`) | glass.css | all | slab (no filter: there are many) |
| calendar panels (`.calg-panel`, `.calg-next`), the saved-files drop (`.lf-drop`, `.lf-loose-row`) | components.css, screens.css (read the tokens) | all | chrome |
| player: the dock (`.player-bottom`), the top buttons, `.upnext`, `.resume-card`, `.party-pill`, `.party-panel`, `.quality-pill` | glass.css (play.css is not this branch's) | all; flat on phones | chrome / thick |
| the search field (`.search-box`) | glass.css | all | chrome |
| the type tag on a hero and a title page (`.hero-kicker`: "SERIES", "FILM") | glass.css | all | the thick body (84 %), thin rim, no filter |
| the remote's sheets (`.rm-sheet`: More, the pickers) | remote.css | all | thick |

Left as they are, on purpose: the hero slab and the poster cards (their
blur was taken off on 2026-10-07 — the sky froze under it — and nothing in
this branch puts a backdrop filter where there is none today); the phone's
More sheet (`.nav-more-sheet`, an opaque panel like the TV's); the X-Ray
panel and the player's menus (they carry "the room's light", the TV's hue,
over their own fill); the profile gate's blur; the dim behind a sheet;
the remote screen's own controls (its pads and rows are white-tinted slabs
on a near-black page of its own — a second material, to be moved over in a
round that owns that screen; only its sheets were done here); `#glass-sky` and the scripts that paint it; `public/css/play.css`; the
admin page; the legacy look.

The paths that drop the filter keep working and now look like the material
instead of a different one: `data-fx="lite"` (weak device, data saver),
`prefers-reduced-transparency`, the big-touch-screen rule and the phone's
player all fall back to the same body colour at 94 % — no blur, same rim.

## 3. The new recipe

One material, one body colour, three thicknesses. All of it is a handful of
custom properties at the top of `public/css/glass.css`; the surfaces take
them, and the places that carried their own copy of the old look now read
the tokens too. Nothing was moved or resized.

### The tokens

| token | value | what it is |
|---|---|---|
| `--g-tint` | `40, 40, 46` | the body colour: Apple's bar measured 38–40 grey; ours leans one step towards the night sky's blue so it does not look like a grey box on a blue page |
| `--g-fill` | body at **72 %** + sheen | chrome: what floats over pictures (tab bar, nav island, round buttons, buttons on a picture, the player's dock, the search field) |
| `--g-fill-thick` | body at **84 %** + sheen | what carries a list or a paragraph over anything (menus, the search list, sheets, dialogs, the peek, toasts, the player's panels) |
| `--g-fill-slab` | body at **76 %** + sheen | panes that lie in the page, over the sky only (settings panes, episodes, the season bar, chips, download rows) — most have no backdrop filter (rows and chips never; a settings pane keeps the one it has on a desktop), so the tint does the work |
| `--g-sheen` | white 5 % → 0 over the top 48 % | the faint fall of light across the pane |
| `--g-lift` | white 7 % | hover / pressed step, laid over any of the three |
| `--g-blur` | `blur(6px) saturate(1.8)` | the backdrop filter, wherever there was one already (was `blur(7px) saturate(1.9) brightness(1.08)`; the hero and title buttons had `blur(12px) saturate(1.5)`) |
| `--g-edge` | top hairline white 28 %, foot hairline white 12 %, all-round line white 5.5 %, a 10 px inner glow from the top (white 18 %) and a fainter one from the foot (8 %), 1 px black 26 % outside | the rim: light caught on an edge, strongest at the top and the foot, with the dark line the glass throws on the page |
| `--g-edge-thin` | top hairline 20 %, foot 7 %, all-round 6 % | the rim for small things in the page (a chip, a small round button): no inner glow |
| `--g-shadow` | `0 12px 32px` black 32 % + `0 2px 6px` black 20 % | the soft outer shadow (was one wide `0 24px 60px` black 38 %) |
| `--g-well` | black 40 % | the chosen tab / chip / season: a darker capsule pressed into the bar |
| `--g-well-edge` | inner shadow from the top (black 40 %, 2 px) + a faint light line at the foot (white 9 %) | the well's rim: the bar's language turned inside out |
| `--g-ink` | `#fff` | words and icons on glass |
| `--g-ink-on` | the profile's accent mixed 60 % with white (`color-mix`; plain white where the browser has none) | the chosen tab's word and icon — the default accent gives `rgb(185,176,255)` |
| `--g-ink-dim` | `#d0d5e2` | the second voice on a pane (the page's own is `#c2c7d6`) |
| `--g-ink-quiet` | `#b2b8ca` | the third voice on a pane (the page's own is `#8c93a8`) |

`--g-fill-strong` (the hero slab) is as it was.

### Why these numbers

- **72 %.** White words need the body to hold a white poster under a
  luminance of 0.18. A white backdrop behind `rgba(40,40,46,0.72)` is a grey
  of 100 — 5.9:1 against white, 5.1:1 measured at the brightest point of the
  sheen. That is with NO backdrop filter at all: the filter only softens and
  colours what comes through, it is never what makes the words readable. So
  Safari, Firefox, the lite path and reduced transparency all read the same.
  Apple's own bar lets through about as much (a white page under WhatsApp's
  bar comes out near a third).
- **Three thicknesses, one colour.** A menu's lines are long and small, so
  it is thicker (84 %). A row in the page has no blur behind it — a season of
  24 episodes cannot afford one — so the sky shows through it sharp; at the
  chrome's 72 % its small grey notes fell under 4.5:1, at 76 % they hold on
  the sky as it is.
- **Blur 6 px, saturation 1.8** — found by looking at a grid (3 / 6 / 10 px
  × 1.3 / 1.8 / 2.3) over posters and over white text, at phone and desktop
  size, next to elia's recordings. 3 px leaves the words under the bar crisp
  enough to argue with the bar's own; 10 px turns everything behind into
  fog, which is the old frosted look, not Apple's; 6 px gives Apple's "soft
  ghost you can still recognise". 1.3 is dull through a dark body, 2.3 makes
  a poster under the bar gaudy. The radius is SMALLER than today's (7 px,
  and 12 px on the hero buttons), and `brightness()` is gone — one filter
  step less.
- **The rim.** Today's was an even outline with one bright top line. Apple's
  is a hairline at the top, a mirror of it at the foot, and a soft glow
  inside both that reads as the thickness of the pane. Built from inset
  box-shadows only (they follow the capsule's ends by themselves).
- **The chosen tab is a well, not a lit pill.** Black at 40 % inside the
  bar — on the 72 % body that is about half the bar's brightness, which is
  what Apple's measures — and its word and icon in the accent, lifted
  towards white so it holds 4.5:1 on the well whatever accent a profile
  picked (5.5:1 over a white poster with the default). The same well marks
  the chosen chip, season and the open More tab.
- **The words do not flip any more.** `navTone.js` marks each nav button as
  being over something light or dark, and the old sheet turned the words
  dark over a bright poster. On a body that is dark over anything the flip
  is not needed, and the one moment the old bar was hard to read was exactly
  the half-way point of that flip (3.2–4.5:1 over white text or a bright
  sky). The script still sets its mark; no rule reads it.
- **No colour in the glass.** The phone's tab bar had a blue floor of its
  own; download rows, toasts and menus each had their own blue-black. All of
  them take the one neutral body now. The aurora's colours are in the sky,
  the accent is on the chosen word — and whatever is behind a bar tints it
  through the filter's saturation, as on an iPhone.

### What changed, surface by surface

- **Tab bar (phones), nav island and the bar of a tablet, the logo and the
  round buttons beside them**: neutral body, new rim, softer shadow, white
  words (were 82 % white), the chosen tab as a well with the accent word.
- **Buttons on a picture** (hero, title page): the same chrome; blur radius
  12 → 6 px.
- **Menus, the search list, sheets, dialogs, the peek, the sign-in card,
  toasts**: the thick pane; one body instead of four blue-blacks. The
  peek's picture fades into the pane's own colour (it faded into the old
  blue-black, which left a dark band above the title).
- **The settings button** (a nav item that stands alone): chosen, or under
  the pointer, it keeps its pane — the well and the lift lie over the body.
  Before, both REPLACED the body, and over a bright sky the chosen gear was
  a tinted hole.
- **Chips and pills** (genres, sources, the pickers, seasons): the slab with
  the thin rim; the chosen one is the well with the accent word.
- **Panes and rows in the page** (settings, the rating strip, the season
  bar, episodes, source rows, taste tiles, download rows, the Wrapped and
  pairing cards): the slab; their grey notes lifted one step
  (`--g-ink-dim`, `--g-ink-quiet`) because a pane is lighter than the sky
  the page's greys were drawn for.
- **The player**: the dock, the top buttons and the cards take the tokens,
  so they changed with everything else (no rule of the player was edited
  beyond the fall-back colour). Over a bright frame the dock is now a dark
  pane with white icons instead of a tinted copy of the frame.
- **The fall-backs** (`data-fx="lite"`, `prefers-reduced-transparency`, big
  touch screens, the phone's player): the same body at 94 % (88 % for the
  party panel), same rim, no filter — the material without its blur instead
  of a different, bluer one.
- **The type tag on a hero** ("SERIES" / "FILM" on Home's hero, and on a
  title page): it was a nearly clear pill (white 10 %, or its own cyan at
  14 %) and its gold or cyan letters sat on whatever the picture was — over
  a white picture 1.6:1 on Home and 1.3–1.4:1 on a title page. It is now the
  thick body with the thin rim: gold 5.4:1 over plain white, 7.5–8.9:1 over
  the hero as it is; cyan 6.3–8.4:1. No backdrop filter was added (there was
  none), and nothing dims the picture: the pill carries itself. The letters
  keep their colours.
- **The sign-in sheet's sentence** (`.claim-dim`): it was listed with the
  dims that go behind a sheet, by its name — so a sentence INSIDE the sheet
  got a dark box and a blur of its own. Taken out of that list.
- **The remote's sheets on a phone**: their blur was never drawn. The
  sheet's wrapper is a child of the screen, and every child of a screen
  fades in with an animation that fills "both"; an element with an opacity
  animation, even a finished one, is where a backdrop filter of anything
  inside it stops looking — so the sheet blurred the dim and nothing else,
  and the controls showed through sharp. The wrapper no longer takes that
  animation (it has its own fade), and the sheet takes the thick pane with
  the 6 px blur (was a blue-black at 78 % asking for 22 px). Photographed
  with stripes and words behind it: sharp before, soft after.
- **Pressed tab (the lens)**: see part 4.

Not touched: the hero slab, the poster cards, the More sheet, the X-Ray
panel and the player's own menus, the profile gate, `#glass-sky` and its
scripts, `play.css`, admin, the legacy look. No element gained a backdrop
filter and none got a larger one — counted on seven pages at three sizes,
with a menu and a toast open, by `tools/glass-apple/bfcount.js`. (The
remote's sheet had one already, 22 px, that did not draw; it now draws, at
6 px. The sign-in sentence lost one.) The three later fixes are
photographed and measured by `tools/glass-apple/fixes.js`.

## 4. Tried, kept and dropped

- **The lens on press — kept, toned down.** A tab under the finger grows to
  108 %, takes the lighter step (`--g-lift`) and a brighter rim (top line
  white 42 %), in 90 ms; when the finger lifts it settles back in 380 ms on
  a small overshoot (`cubic-bezier(0.3, 1.45, 0.5, 1)`). Transform and paint
  on one small box, only while something is pressed; nothing runs at rest.
  With reduced motion the tab lights up and does not move. Apple's lens
  also magnifies what is behind it and splits colour at its rim; ours does
  neither — it is the swell and the light, not the refraction. Photographed
  by `tools/glass-apple/lens.js`.
- **Refraction (SVG displacement in `backdrop-filter: url(#…)`) — dropped.**
  Built and photographed on the nav island and the tab bar in Chromium
  (`tools/glass-apple/refract.js`). What it buys: at the bar's rounded ends
  the picture behind bends towards the edge — 6.8 % of the bar's pixels
  change, by at most 70 grey levels, and only where something with an edge
  happens to be under an end. At the size the bar is on a page it reads as
  a slightly different blur, not as "liquid". What it costs: a displacement
  map drawn by a script for every size of every surface that takes it
  (the map has to match the element's box, so a resize redraws it), a
  second, different look for Chromium only (Safari, iOS and Firefox do not
  draw `url()` in a backdrop filter), and frame times that were not better
  and in two of three sizes looked worse (phone scroll p95 88 → 115 ms,
  desktop 1440 p99 52 → 234 ms; the PC was busy, so this is "not proven
  cheap" rather than "proven dear"). The brief's rule was "only if cheap
  and it degrades cleanly"; it is neither proven cheap nor worth a script.
  The thickness is carried by the fake instead: the inner glow at the top
  and the foot of the rim.
- **The sliding selection capsule — dropped.** One capsule that travels
  from the old tab to the new one needs an element (or a measured custom
  property) that outlives the route change, set by a script in the nav —
  shared plumbing (`main.js` / `router.js`) that this branch stays out of,
  for a movement of 200 ms. The chosen well cross-fades (0.3 s) instead.
  Worth doing later, on its own.
- **A clearer glass (55–65 %) — ruled out by the arithmetic.** It is
  prettier over a dark poster and fails over a white one: at 60 % a white
  backdrop leaves the bar at a grey of 126 and white words at 4.0:1, less
  under the sheen. elia: "it does not have to be that clear".
- **Blur 10 px, blur 3 px, saturation 1.3 and 2.3 — dropped** (the grid in
  part 3).
- **`brightness()` in the backdrop filter — dropped.** It lifted a dark
  page under the old, nearly clear glass; under a 72 % body it only lifts
  the worst case.
- **Dark words over a bright backdrop (the tone flip) — removed** (part 3).
- **Nearly opaque panes in the page — not done.** They would carry the
  last nine cells (part 5) and they stop being glass: the sky is the look's
  identity, and a settings page becomes a grey form. 76 % holds every word
  on the sky as it is.

## 5. Contrast, in short

The whole table, per surface and backdrop, is in
`docs/qa/glass-apple/contrast.md` (214 measured cells; white poster, bright
poster, mid grey, white text under, the brightest sky band, the sky as it
is, black).

| | today | this branch |
|---|---|---|
| cells under 4.5:1 | 61 of 214 | 9 of 214 |
| nav island (desktop), white text passing under: words / icons / quiet words | 4.5 / 3.8 / 3.6 | 10.1 / 11.7 / 11.3 |
| nav island (desktop), the brightest sky: icons / quiet words | 4.4 / 3.8 | 11.7 / 11.8 |
| nav island (desktop), a white poster: words | 14.9 (dark words, after the flip) | 5.1 (white words) |
| settings panes (desktop), the sky as it is: words / icons / quiet words | 3.8 / 3.0 / 2.8 | 9.2 / 6.4 / 7.4 |
| settings panes (desktop), the brightest sky: words | 1.2 | 5.9 |
| episodes (phone), the sky as it is: words / icons / quiet words | 4.8 / 2.6 / 2.9 | 7.6 / 5.2 / 5.3 |
| chips (phone), the sky as it is: quiet words | 2.0 | 6.0 |
| tab bar (phone), a white poster: chosen / icons / words | 5.4 / 6.9 / 5.6 | 5.5 / 5.6 / 5.8 |
| toast (phone), a white poster | 5.9 | 5.7 |

Where the reading got better: the nav island and the round buttons in the
moments between "dark" and "light" (white text or a bright sky under them),
and every pane that lies in the page. Where it did not need to: the phone's
tab bar and the toasts were readable today (their own blue floors were 80–86 %
opaque) — there the change is the colour and the rim, not the number. Over a
plain white poster the island's number is LOWER than today's (5.1 against
14.9) and still passes: today's words turn dark there, ours stay white on a
body that is dark enough.

The nine cells still under 4.5:1 are all second-voice text or small icons
on panes that lie in the page (chips, settings rows, episode rows, the
search list) with the WHOLE sky painted in its brightest green — a ceiling
the real sky never reaches all at once; they measure 3.6–4.4:1 there and
5.2:1 or more on the sky as it is. Closing them means a nearly opaque pane (part 4), a blur behind 24 episode
rows, or a second voice as bright as the first. Left, and said.

## 6. Performance

`tools/glass-apple/scrollperf.js`: Home scrolled at 3000 px/s for the
length of the page and back, the sky alive, GPU-backed headless Chrome,
medians of 4 runs, frame times from `requestAnimationFrame` (the Chrome
trace could not be parsed on this machine, so there is no compositor-side
number). A dozen other agents were running on the PC: the spread between
runs is larger than any difference below.

| size | | today | this branch |
|---|---|---|---|
| phone 402 × 874, CPU × 4 | scroll, mean frame | 27.7 ms | 28.0 ms |
| | scroll, p95 | 79.9 ms | 88.4 ms |
| | late frames | 17 | 14 |
| | at rest, mean | 23.2 ms | 20.9 ms |
| desktop 1440 × 900 | scroll, mean frame | 19.1 ms | 18.4 ms |
| | scroll, p95 | 43.5 ms | 27.8 ms |
| | late frames | 10.5 | 6.5 |
| | at rest, mean | 17.0 ms | 16.2 ms |
| desktop 2560 × 1440 | scroll, mean frame | 35.9 ms | 28.5 ms |
| | scroll, p95 | 110.4 ms | 86.7 ms |
| | late frames | 14 | 19 |
| | at rest, mean | 16.6 ms | 18.0 ms |

Read honestly: the same, within the noise — not worse. By construction it
cannot be dearer: the same elements carry a backdrop filter as today
(`tools/glass-apple/bfcount.js` counts them on seven pages at three sizes
with a menu and a toast open — identical), the blur radius went down
(7 → 6 px; 12 → 6 px on the buttons over a picture) and `brightness()`
left the filter. The rim is more inset shadows on the same boxes; they are
painted once, not per frame.

## 7. What only a real iPhone can say

Nothing here was seen in WebKit (there is none on this PC). The sheet is
written for it — every `backdrop-filter` has its `-webkit-` twin, the body
reads without any filter, `color-mix()` has a plain-white fall-back — but
these want elia's eyes on his iPhone:

1. **The tab bar over posters, scrolling.** Does the bar look like a dark
   neutral pane with a soft ghost of the posters, as in Apple TV? Safari's
   `saturate()` in a backdrop filter is stronger than Chrome's on some
   pictures: if a red poster glows through the bar, the number to lower is
   the 1.8 in `--g-blur`.
2. **The rim.** The top and foot hairlines and the inner glow are inset
   shadows on a capsule: on a 3× screen the hairline should be one crisp
   light line, not a grey band.
3. **The chosen tab.** A darker well with the word in lilac (the accent
   mixed with white). If the word is plain white, `color-mix()` did not
   take (iOS before 16.2) — still readable, just not coloured.
4. **Press a tab and hold.** It should swell a little and light up, then
   spring back on release. iOS only applies `:active` while the finger is
   down and sometimes not at all on a quick tap: a quick tap may show
   nothing, which is fine; a stuck swollen tab is not.
5. **The bar at the foot when Safari's toolbar hides and shows**, and over
   the home indicator: no clear strip under it, no seam.
6. **Scrolling Home for ten seconds**: as smooth as before (the sky must
   not freeze — that was the 2026-10-07 fault).
7. **Settings → Accessibility → Reduce Transparency**, and **Low Power
   Mode**: the bars become solid dark panes with the same rim; the words
   stay white.
8. **A menu, a sheet, a toast over the hero**: one dark neutral body for
   all three; nothing blue.
9. **The player's dock over a bright scene** (landscape and portrait).

## 8. The recipe for the apps (plain values)

For the Android phone app and the TV app — not edited in this branch.

| part | value |
|---|---|
| body colour | `rgb(40, 40, 46)` (`#28282E`) |
| chrome (tab bar, top bar, round buttons, buttons on a picture, the player's dock) | body at 72 % alpha over the content, behind it a blur of 6 dp and saturation × 1.8; without a blur (most TVs, weak phones): body at 94 % |
| menus, sheets, dialogs, toasts | body at 84 %; without a blur 94 % |
| panes in the page (settings groups, episode rows, chips) | body at 76 %, no blur |
| sheen | white 5 % at the top edge fading to nothing at 48 % of the height |
| rim, top | 1 px line, white 28 %; under it a glow 8–10 px deep, white 18 % fading to 0 |
| rim, foot | 1 px line, white 12 %; over it a glow 7–9 px deep, white 8 % fading to 0 |
| rim, all round | 1 px, white 5.5 % inside; 1 px, black 26 % outside |
| small things (a chip) | top line white 20 %, foot line white 7 %, all round white 6 %, no glow |
| shadow | `0 12 32` black 32 % plus `0 2 6` black 20 % (Android: elevation about 8 dp, ambient kept low) |
| chosen tab / chip | a capsule of black 40 % over the body, inset shadow from the top (black 40 %, 2 px), a light line at its foot (white 9 %) |
| chosen word and icon | the accent mixed 60 % with white — default accent gives `rgb(185, 176, 255)` (`#B9B0FF`); everything else on glass is `#FFFFFF` |
| second voice on a pane | `#D0D5E2`; third voice `#B2B8CA` |
| hover / focus / pressed step | white 7 % over the body; pressed on a touch screen: scale 1.08 in 90 ms, back in 380 ms with a small overshoot |
| corners | as today (capsules for bars and buttons, the look's large radius for panes) |

On the TV the focus ring stays the TV's own; the well is for "chosen", not
for "focused".

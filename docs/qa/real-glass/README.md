# Real glass (2026-11-20, fifth pass)

elia asked for "a look of real looking glass with chromatic aberration for the btns", on "the nav and every glass btn across the board". This is that look, on the website and in the Android phone app. The TV app is not touched.

Two jurors scored the first pass 7 and 6.5 (a drawn rainbow outline; metal rings) and the second 7.5 (the bars read as real glass, but every surface without a lens looked almost like today, with no colour split at all). The third scored 8.5 and 8.3; this fourth pass changes values and cost only. Sheets: `final/` (first), `final2/` (second), `final3/` (third), `final4/` (this one, a short set).

## Fifth pass (2026-11-20): what is behind the glass bends and splits into colours

elia, on seeing the fourth pass: "It looks great and keep it but I intended for the effect of red green and blue coming out slightly from an object behind and distorti[on]". So everything below stays, and the lens now works across the whole face, not only in the bevel:

- **The face bends what is behind it.** Everything is fetched from a little nearer the pane's middle (6 px just inside the bevel, nothing at the middle), and the whole view sits 9 px to one side, as glass moves what is behind it.
- **Every edge behind the pane parts into red and blue**, the middle included: about 2 px between them at the middle, more towards the rim. Two copies of the picture, the far one giving red and half the green, the near one blue and the other half.
- **Less frost** (1.4 px against 3), so what is behind can be made out. The dim holds the words, not the blur. The bevel shows the band inside it turned over and squeezed 1.6 times, and meets the face at a crease.
- The filter is shorter than before: the map, two bends, two colour shares, one sum (6 steps against 10), with the little softening as a plain `blur()` ahead of it.

The technique was checked against the open-source "liquid glass" recreations (rdev/liquid-glass-react, liquid-glass-js, @real-human/liquid-glass, shuding/liquid-glass, liquidGL, @ybouane/liquidglass, kube.io's write-up). All the SVG ones bend only the rim and spend three bends on the colours, so they show no split on the face at all; the face term and the sideways set are what give it. liquidGL's shader shifts red and blue and leaves green, which is what the two-copy split amounts to. None refracts a live backdrop in Safari: they bend a cloned or snapshotted page, which cannot follow a moving sky or a scroll. Nothing was taken as a dependency.

Cost (`final5/timings.txt`, desktop, processor time in 8 s, 8 runs a side): Home at rest with the hero in view 1507 → 1591 ms (+5.6 %), scrolled 1515 → 1637 ms (+8 %, with the lens-off control at +4.7 % in that batch, so about +3 to +8 %); a paused film's first ten seconds 249 → 338 ms (it was 410); after ten seconds and while playing, as today. Phone: scroll 17.8 / 18.1 / 18.2 ms on both sides, no late frames, the More menu's worst frame 36 ms on both. A lens on four round top buttons as well measured +4.4 % in all against today in its own batch: no more than the bar alone, so it is affordable on a desktop now; it is not built.

Words: every surface reads as today or better, to a tenth, after one fix: the paused player's lens is a step dimmer (0.44), because with less frost a bright frame's edges passed under the dock's clock (4.4:1; now 5.2:1). Layout: nothing moved in 36 cases.

The phone app cannot show what is behind it without a native backdrop. It is feasible on Android 13+ without a new package (the screen's content recorded into a RenderNode, drawn again under the tab bar through a blur and a small AGSL shader with three samples a pixel; blur only on Android 12; today's look below), but it is a new native view wired through the navigation root, and video surfaces cannot be sampled. It is not cheap enough for a values pass and is not built.

Sheets: `final5/` (same names as `final4/`, plus `01b-phone-bright`).

## What it is

The surfaces are the ones that took "Clear": what floats over pictures. A pane now reads as a thick piece of glass:

- **The bar's rim bends the picture** (Chrome, Edge, Android's browsers). The last 15 px or so before the edge of the top bar and of the phone tab bar are a bevel. It shows, turned over and squeezed, a wide band of the picture inside it. The face stays softly frosted, so words read as before.
- **The colour fringe there is real.** Red is bent more than green and blue less, inside the bevel only: a tenth either way on a phone, 0.12 on a desktop's bar, in three steps. Along the top edge the bevel shows at half strength, so over a white poster nothing reads as a line of light there.
- **Every pane keeps a still colour split.** One sharp pixel of violet inside the left end of a pane and of mint inside the right, their other halves just outside, swapped. They are crescents: widest at 9 and 3 o'clock, nothing at the top or the foot. Inside / outside strength: 0.36 / 0.22 on bars and text buttons, 0.5 / 0.22 on the small round buttons, 0.30 / 0.18 on a title's icon-only circles.
- **Every pane has a body.** It is darker towards its top and carries a little violet light towards its foot, so it is not a flat fill.
- **The rim is dim on top and lit along the foot**, with one small glint on the left shoulder and a fainter answer on the right foot. On a small round button nothing is lit above its middle. There is no light along the top (elia's ruling).
- **Depth.** Dark just under the top edge, a soft violet pool inside the foot, a tight contact shadow, and a little violet light let through below.

## Where the lens is, and when

A lens is worked out again for every frame in which what is behind it moves. So it is given where it shows and when it is cheap:

| surface | rim, split and body | lens |
|---|---|---|
| the desktop and tablet top bar, the phone tab bar | always | always |
| the hero's glass button | always | always, from tablet width up |
| the round top buttons, the logo pill, the profile button | always | never |
| the glass buttons on a film's or show's page (desktop, tablet) | always, calmer as a group | never |
| the player's dock and top pills | always | for the first ten seconds of a pause, from tablet width up |
| Up next, the resume card, the quality and party pills | always | never |
| the phone app's chrome | always | never: the app has no live backdrop |

Unchanged: the phone's side menu (More), every menu, sheet, dialog and toast, the player's menus, the panes, chips and rows in the page, a phone's action tiles under a title, the classic look, the TV app.

A lens under a desktop's pointer was tried and taken out again. The app's own hover look fills the button (the round ones turn white, a title's get a white ring and a lighter body), so a lens under the pointer cannot be seen. It also cost nothing measurable, so it can come back if the hover look ever changes.

## What it costs (the honest numbers)

Measured as the processor time the page's processes use in 8 seconds (`tools/real-glass/player-cost.js`), the two sides taking turns, on a desktop at 1440 × 900, on a calm machine. Frames are the same on both sides in every case. All of it is in `final4/timings.txt`.

| | today | real glass | |
|---|---:|---:|---|
| Home at rest, hero in view (8 runs) | 1522 ms (1446–1590) | 1580 ms (1560–1647) | +3.7 % |
| Home at rest, scrolled (8 runs) | 1495 ms (1475–1630) | 1554 ms (1513–1651) | +3.9 % |
| the same with the lens switched off | | 1506 / 1512 ms | as today |
| a film paused, after ten seconds | 235 ms | 240 ms | as today |
| a film paused, its first ten seconds | 246 ms | 410 ms | +20 ms a second |
| a film playing, controls held up | 596 ms (586–688) | 635 ms (610–868) | runs overlap |

- **The desktop bar's lens now costs under 4 % at rest** (it was 8 % with five colour steps). The medians sit inside today's own run-to-run range, which is about 10 % wide; they are not equal to today's.
- **Working the bevel out only in its own strips was tried and made it worse**: 16 % with the hero in view and 8.5 % scrolled, against 3.7 % and 3.9 % for one chain over the whole pane. What a lens costs while the picture behind it moves goes with the number of steps in the filter, not with the area they cover, and four strips are four chains. It was taken out.
- **A paused film.** The film stands still, but the page behind the player does not: the sky's two washes (`html::before` and `::after`, the animations `wash-hi` and `wash-lo`) and the "new" dot's breathing (`g-breathe`) keep the browser drawing frames, with no script involved, and a lens is worked out again for each. The controls do not hide while a film is paused, so the lens now rests after ten seconds of nothing moving (`.player.glass-rest`); any motion brings it back. After that a paused film costs what it costs today.

On a phone (390 × 844, CPU ×4, `final4/perf-phone.json`):

| | today | real glass |
|---|---:|---:|
| scroll: mean frame / p95 / p99 (ms), 8 runs | 17.8 / 18.5 / 18.6 | 17.8 / 18.5 / 18.6 |
| late frames in a scroll, and at rest | 0, 0 | 0, 0 |
| the More menu's worst frame (ms), 14 runs | 36 | 36 |

## Words on the glass

Measured again with `tools/glass-options/contrast.js` (the dimmest 1 % behind each word, over a white poster, a bright poster, mid grey, white text, a bright sky band and black; a white frame for the player), with the body's two gradients in place. Every real-glass surface reads the same as today, to a tenth:

| surface | lowest, today | lowest, real glass |
|---|---:|---:|
| phone tab bar, words / chosen tab | 6.3 / 5.4 | 6.3 / 5.4 |
| phone top buttons | 5.8 | 5.8 |
| desktop and tablet top bar, words / chosen tab | 5.3 / 5.1 | 5.3 / 5.1 |
| glass buttons on a title's page, quiet words | 5.7 | 5.7 |
| the player's dock and pills | 4.7 | 4.7 |

The cells under 4.5:1 are on surfaces this work did not touch (a chip's count, the season bar and a Settings pane's icons over a sky painted as one bright band), with the same numbers on both sides.

## How it is made

**The lens** (`public/js/glasslens.js`, Chromium only) is an SVG filter inside `backdrop-filter`: a displacement map, applied once per colour step with a slightly different strength, laid over a 3 px frosted copy of the backdrop. A map is drawn once per size of surface, at half the surface's size. The maps of surfaces that only show their lens at times are drawn at an idle moment. `ResizeObserver` says when a size changes; a window being dragged is fitted when it rests. Nothing runs per frame.

**The rest** (`public/css/glass.css`, the last section, "Real glass") is plain CSS and the same in every browser: box shadows for the split, the depth and the pool, two still gradients for the body, and one masked 1 px ring (`::before`) for the rim and its glint. `screens/player.js` sets `.is-paused` on the player on the video's own play and pause.

## Safari, iPhone and Firefox

They cannot draw the lens (Safari drops the whole backdrop filter when a `url()` is in it; WebKit bugs 245510, 317059), so they never see one: the stylesheet uses a `url()` only under `html[data-lens]`, and only the script sets that, after checking that the browser is Chromium. Every iPhone browser is refused whatever its name.

Their glass is everything except the bend: the split, the body, the rim, the glint, the depth, over Clear's blur and dim. `final3/13`–`15` show it, photographed in Chrome with the lens refused. There is no WebKit on this PC: Safari itself was not run.

Reduce Transparency, a TV's browser, a weak device, `forced-colors` and `prefers-contrast: more` get no lens; the last two get no ring either.

## Checks

- `tools/real-glass/layout-same.js`: every element's box against today's stylesheet on six screens at six widths, and every ring against its own surface. Nothing moved in any of the 36 cases, and every ring is its surface's.
- `test/glasslens.test.js`: the lens is Chromium's alone; the map; the colour steps; a `url()` only under `[data-lens]`; no surface but the bar and the hero's button has a lens at rest; no lens over a playing film.
- `test/ui/glass-lens.test.js`: rings at 1440, 1024, 768 and 390; the maps come back if taken out; a phone's lens is the tab bar's alone; an iPhone has none; the player takes it only while paused, and it rests; at 1024 and at 768 the profile menu opens above the bar; the classic look has none.

## Sheets (`final4/`, and the fuller set in `final3/`)

Every sheet shows the surface first **at its real size** (one pixel of the sheet is one CSS pixel), today beside or above real glass, and only then enlarged. 01–10 and 12–13 are this PC's own server, looked at only, as the test profile; 11 is a private test server.

- `01`, `02`: a phone over posters and over the dark sky alone.
- `03`–`07`: a desktop over the hero, over cream and white posters (the top edge), over posters, over the dark sky, on a film's page.
- `08`, `09`: the round buttons, desktop and phone.
- `10`: a tablet, 1024 wide.
- `11`: the player paused on a bright frame.
- `12`, `13`: with and without the lens.
- `app-home`, `app-title`: the phone app on the Pixel 9 emulator, each surface at its real size first.

## The phone app

React Native has no live backdrop, so there is no bend: the app wears the split, the body, the rim, the glint and the depth. Tokens are in `tv-native/src/phone/theme.ts` (`RG_*`); the rim is one small still drawing, `ui/GlassRim.tsx`, with nothing measured. Bodies are unchanged (the tab bar keeps its 86 %). Only the hero's "Details" is a real-glass pill; every glass button in a sheet or a page keeps the earlier look and its width.

On the Pixel 9 emulator (API 37), QA build 127 beside QA build 125 of origin/master: the crescents render (violet inside left, mint inside right, nothing at top or foot), the body shows, the glint is visible on the circles, and widths are the same as origin/master's. White on the tab bar's body in the label rows is 19.4:1, the same as today; with page words showing through under the labels, 14.1:1, also unchanged. The fourth pass's stronger crescents measure on the device (the settings circle's mint side went from 90,126,139 to 96,148,155) but are a small step at real size. Android ignores a gradient centre above the pane, so the app's top shade hangs from the top edge instead.

**It does not reach 9 at real size, and cannot without a live backdrop.** At 1× the split is a faint tint and the pane is still a dark fill; I put it at 8, the action circles at 7.5. What would take it further is a real blur and lens on the tab bar alone (Android 12's `RenderEffect`), which would have to be measured on a weak phone first. It is not built.

Not checked: a real phone's GPU (the emulator draws in software), Android below API 37, smoothness, pop-in by recording this pass (nothing is measured, so nothing can arrive late), and a few surfaces that share the same components (the Taste screen, the round Next, a lit player button, the TVs circle).

## Rigs (`tools/real-glass/`)

- `lab.js`: the scenes, on the private instance or (with `LIVE`) on this PC's server.
- `final4.py`, `final3.py` (and `final.py`, `final2.py`, `options.py`): the sheets. `one.py`, `z.py`, `zoom.py`: quick looks at real size and enlarged.
- `layout-same.js`: nothing moved; every ring is its surface's.
- `more-open.js`, `scroll-probe.js`: the More menu and a scroll, many times over.
- `player-cost.js`: processor time at rest, over a playing and a paused film, with parts of the lens off. `paused-probe.js`: what still asks for frames while a film is paused.
- Contrast and the phone's speed table are `tools/glass-options/contrast.js` and `perf.js`, with "a" = origin/master.
- `tools/real-glass-app/`: the phone app's sheets.

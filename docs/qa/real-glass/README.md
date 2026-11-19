# Real glass (2026-11-19, third pass)

elia asked for "a look of real looking glass with chromatic aberration for the btns", on "the nav and every glass btn across the board". This is that look, on the website and in the Android phone app. The TV app is not touched.

Two jurors scored the first pass 7 and 6.5 (a drawn rainbow outline; metal rings) and the second 7.5 (the bars read as real glass, but every surface without a lens looked almost like today, with no colour split at all). This is the third pass. Sheets: `final/` (first), `final2/` (second), `final3/` (this one).

## What it is

The surfaces are the ones that took "Clear": what floats over pictures. A pane now reads as a thick piece of glass:

- **The bar's rim bends the picture** (Chrome, Edge, Android's browsers). The last 15 px or so before the edge of the top bar and of the phone tab bar are a bevel. It shows, turned over and squeezed, a wide band of the picture inside it. The face stays softly frosted, so words read as before.
- **The colour fringe there is real.** Red is bent more than green and blue less, inside the bevel only: a tenth either way on a phone, 0.14 on a desktop's bar, which splits in five steps, a spectrum.
- **Every pane keeps a still colour split.** One sharp pixel of violet inside the left end of a pane and of mint inside the right, their other halves just outside, swapped. They are crescents: widest at 9 and 3 o'clock, nothing at the top or the foot. This is what the second pass lacked.
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
| the player's dock and top pills | always | while the film is paused, from tablet width up |
| Up next, the resume card, the quality and party pills | always | never |
| the phone app's chrome | always | never: the app has no live backdrop |

Unchanged: the phone's side menu (More), every menu, sheet, dialog and toast, the player's menus, the panes, chips and rows in the page, a phone's action tiles under a title, the classic look, the TV app.

A lens under a desktop's pointer was tried and taken out again. The app's own hover look fills the button (the round ones turn white, a title's get a white ring and a lighter body), so a lens under the pointer cannot be seen. It also cost nothing measurable, so it can come back if the hover look ever changes.

## What it costs (the honest numbers)

Measured as the processor time the page's processes use in 8 seconds (`tools/real-glass/player-cost.js`), the two sides taking turns, on a desktop at 1440 × 900. Frames are the same on both sides in every case; this is extra work behind smooth frames.

| | today | real glass | |
|---|---:|---:|---|
| Home at rest, hero in view | 1724 ms | 1872 ms | +8.6 % |
| Home at rest, scrolled | 1662 ms | 1794 ms | +8 % |
| the same with the lens switched off | | 1700 / 1680 ms | as today |
| (tried) the pointer resting on a button with a lens | | 1764 ms | no more than without it |
| a film playing | 794 ms | 755 ms | as today |
| a film paused, controls up | 274 ms | 411 ms | +17 ms a second |

- **The bar's lens costs about 8 % at rest on a desktop**, 16–19 ms of processor time a second, because the living sky never stands still behind it. The second pass's notes said "the same as today" for the bar alone; that measurement was not fine enough to see 8 %. This one is (runs of 1590–1830 ms on the same side).
- It can be made cheaper at a price in looks. Three colour steps instead of five: about +4 %. Three steps and no softening of the bevel's picture: as today, but the bevel speckles. Bending the frosted picture instead of a sharper one: one pass fewer, but the bend and the fringe all but vanish. Five steps are kept; it is one token (`--rg-taps`) to change.
- **A paused film** with the lens on the player's chrome costs 17 ms a second more than today, because the page still draws frames while paused. A playing film is unchanged.

On a phone (390 × 844, CPU ×4, `final3/perf-phone.json`, `timings.txt`):

| | today | real glass |
|---|---:|---:|
| scroll: mean frame / p95 / p99 (ms), 8 runs | 17.8 / 18.4 / 18.55 | 17.8 / 18.4 / 18.6 |
| late frames in a scroll, and at rest | 0, 0 | 0, 0 |
| the More menu's worst frame (ms), 14 runs | 54 | 53 |

The desktop scroll batch of this pass was taken while another build was running and today's own side is disturbed in it (5 late frames a run in the median, against 2 with real glass); the second pass's calm batch showed 17.9 ms and 0 late frames on both sides, and nothing in a scroll changed since.

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
- `test/ui/glass-lens.test.js`: rings at 1440, 1024, 768 and 390; the maps come back if taken out; a phone's lens is the tab bar's alone; an iPhone has none; the player takes it only while paused; at 1024 the profile menu opens above the bar; the classic look has none.

## Sheets (`final3/`)

Every sheet shows the surface first **at its real size** (one pixel of the sheet is one CSS pixel), today beside or above real glass, and only then enlarged. 01–11 and 13–15 are this PC's own server, looked at only, as the test profile; 12 is a private test server.

- `01`–`04`: a phone over posters, over the brightest posters, over the dark sky alone, on a film's page.
- `05`–`08`: a desktop over the hero, over posters, over the dark sky (the sky held still, the same on both sides), on a film's page.
- `09`–`11`: tablets, 1024 and 768 wide.
- `12`: the player paused on a bright frame.
- `13`–`15`: with and without the lens.
- `app-home`, `app-sky`, `app-title`, `app-sheet`, `app-player`: the phone app on the Pixel 9 emulator, each surface at its real size first.

## The phone app

React Native has no live backdrop, so there is no bend: the app wears the split, the body, the rim, the glint and the depth. Tokens are in `tv-native/src/phone/theme.ts` (`RG_*`); the rim is one small still drawing, `ui/GlassRim.tsx`, with nothing measured. Bodies are unchanged (the tab bar keeps its 86 %). Only the hero's "Details" is a real-glass pill; every glass button in a sheet or a page keeps the earlier look and its width.

On the Pixel 9 emulator (API 37), QA build 126 beside QA build 125 of origin/master: the crescents render (violet inside left, mint inside right, nothing at top or foot), the body shows, the glint is visible on the circles, widths are the same as origin/master's, and white on the tab bar's body beside the words is unchanged (12.1:1 at the brightest point under them, 17.9:1 today). Android ignores a gradient centre above the pane, so the app's top shade hangs from the top edge instead.

**It does not reach 9 at real size, and cannot without a live backdrop.** At 1× the split is a faint tint and the pane is still a dark fill; I put it at 8, the action circles at 7.5. What would take it further is a real blur and lens on the tab bar alone (Android 12's `RenderEffect`), which would have to be measured on a weak phone first. It is not built.

Not checked: a real phone's GPU (the emulator draws in software), Android below API 37, smoothness, pop-in by recording this pass (nothing is measured, so nothing can arrive late), and a few surfaces that share the same components (the Taste screen, the round Next, a lit player button, the TVs circle).

## Rigs (`tools/real-glass/`)

- `lab.js`: the scenes, on the private instance or (with `LIVE`) on this PC's server.
- `final3.py` (and `final.py`, `final2.py`, `options.py`): the sheets. `one.py`, `z.py`, `zoom.py`: quick looks at real size and enlarged.
- `layout-same.js`: nothing moved; every ring is its surface's.
- `more-open.js`, `scroll-probe.js`: the More menu and a scroll, many times over.
- `player-cost.js`: processor time at rest, over a playing and a paused film, with parts of the lens off.
- Contrast and the phone's speed table are `tools/glass-options/contrast.js` and `perf.js`, with "a" = origin/master.
- `tools/real-glass-app/`: the phone app's sheets.

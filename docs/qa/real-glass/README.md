# Real glass (2026-11-19, second pass)

elia asked for "a look of real looking glass with chromatic aberration for the btns", on "the nav and every glass btn across the board". This is that look, on the website and in the Android phone app. The TV app is not touched.

A first pass was scored 7 and 6.5 out of 10 by two jurors: it read as glass only over bright pictures, as a drawn rainbow outline over dark pages, and its small round buttons read as metal rings. This is the second pass. The first pass's sheets are in `final/`, this one's in `final2/`.

## What it is

The surfaces are the ones that took "Clear": what floats over pictures. Their body is unchanged. A pane now reads as a thick piece of glass:

- **The bar's rim bends the picture** (Chrome, Edge, Android's browsers). The last 15 px or so before the edge of the top bar and of the phone tab bar are a bevel. It shows, turned over and squeezed, a wide band of the picture inside it, the way the edge of a thick lens gathers a whole view into a thin line. The face stays softly frosted, so words read as before.
- **The colour fringe is real, not drawn.** Red is bent a tenth more than green and blue a tenth less, inside the bevel only. A desktop's bar does it in five steps, a spectrum. Nothing coloured is drawn round a pane: over a dark page, where there is nothing to bend, the glass is quiet.
- **The rim is dim on top and lit along the foot.** No light along the top (elia's ruling). One small glint sits on the left shoulder with a faint answer on the right foot, tinted in Aurora's own violet and mint. On a small round button nothing is lit above its middle.
- **Depth.** Dark just under the top edge, a soft violet pool inside the foot, a tight contact shadow, and a little violet light let through onto what is below.

## What changed from the first pass

| the jurors said | now |
|---|---|
| the bevel stretched a thin band into streaks, with a seam against the face | it squeezes a wide band (up to 3.4 times at the rim) and fades in after the point where the picture stands still |
| the bend did not show at real size | the bar's bevel is 1.4 wide; its picture is softened 1.3 px so it does not speckle |
| a drawn rainbow outline over dark pages | the drawn fringe lines are gone; the arcs became one small glint at about half the strength |
| small circles read as metal rings | a 1 px rim, dim on top; nothing lit above the middle |
| the coral was off-palette | warm is Aurora's violet-magenta (232, 121, 249), cool its mint (94, 234, 212) |
| a flat outline | the rim runs from 5 % white on top to 32 % violet at the foot; the lens lifts the bevel by 4 %, not 15 % |
| nine identical rims on a title's page | the group's rims are at 70 %, and the icon-only buttons carry no glint |

## Where the lens is, and why not everywhere

The lens is on **the bar** (the desktop and tablet island, the phone tab bar) and, from tablet width up, on **the hero's glass button**. Every other surface in the table below wears the rim over Clear's plain backdrop. That is a measured choice, not a taste:

- A lens is worked out again for every frame in which what is behind it moves. On a desktop Home at rest the sky never stands still.
- With a lens on every button, the page's processes used **12 % more processor time at rest** than today (medians of 8 and of 6 interleaved runs, twice). With the bar's alone: the same as today.
- Over a playing film, lenses on the player's chrome used **3.7 times** the processor time (2.76 s against 0.74 s in 8 s). The player's chrome has no lens.
- On a phone, lenses on the round buttons made the More menu's first frame one frame late (71 ms against 53).
- At 42 px there is next to no picture in a bezel to bend. The bar is where the bend can be seen.

elia's call if he wants it otherwise: the buttons can take the lens on a desktop at that 12 %.

| real glass | unchanged |
|---|---|
| the desktop top bar and the phone tab bar (rim and lens) | the phone's side menu (More) |
| the hero's glass button (rim; lens from tablet width up) | every drop-down menu, sheet, dialog and toast |
| the round top buttons, the logo pill, the profile button (rim) | a phone's action tiles under a title (not glass panes, as with Clear) |
| the glass buttons on a film's or show's page, desktop and tablet (rim) | the player's menus; the panes, chips and rows in the page |
| the player's dock and top pills, Up next, the resume card, the quality and party pills (rim) | the classic look; the TV app |
| the phone app: tab bar, logo, round buttons, the hero's glass pill, action circles, the player's buttons (rim) | the phone app's sheets, pages and their buttons |

## How it is made

**The lens** (`public/js/glasslens.js`, Chromium only) is an SVG filter inside `backdrop-filter`: a displacement map, applied once per colour step with a slightly different strength, laid over a 3 px frosted copy of the backdrop. A map is drawn once per size of surface, at half the surface's size (it is smooth, and Chromium sends a filter's picture along with every frame it draws). `ResizeObserver` says when a size changes; a window being dragged is fitted when it rests. Nothing runs per frame.

**The rest** (`public/css/glass.css`, the last section, "Real glass") is plain CSS and the same in every browser: box shadows for the depth and the pool, and one masked 1 px ring (`::before`) for the rim and its glint.

## Faults the review found, fixed

- **721–1260 px:** the island is not centred there and was not placed, so its ring was the whole top bar's. It is placed now; `tools/real-glass/layout-same.js` checks that every ring is its own surface's size at six widths (and that nothing moved against today), and `test/ui/glass-lens.test.js` holds it at 1440, 1024, 768 and 390.
- **The party pill** was not placed either; fixed the same way, and it is in the focus rule.
- **Surfaces that left the page were still watched** (the player is built anew for every film). They are let go now.
- **The maps' hidden `<svg>` taken out of the page** would have left every lens pointing at nothing, and Chromium then draws no backdrop filter at all, the dim included. It is put back at once and every surface fitted again; the test takes it out and looks.
- **Maps for surfaces the stylesheet ignores** are no longer drawn; with the lens off (another look, Reduce Transparency) the maps are removed.
- **`forced-colors` and `prefers-contrast: more`:** no lens and no ring.

## Safari, iPhone and Firefox

They cannot draw the lens (Safari drops the whole backdrop filter when a `url()` is in it; WebKit bugs 245510, 317059), so they never see one: the stylesheet uses a `url()` only under `html[data-lens]`, and only the script sets that, after checking that the browser is Chromium. Every iPhone browser is refused whatever its name. `test/glasslens.test.js` and `test/ui/glass-lens.test.js` hold both rules.

Their glass is everything except the bend: the rim, the glint, the dark top, the pool, the depth, over Clear's blur and dim. `final2/15-no-lens-phone.png` and `16-no-lens-desktop.png` show it, photographed in Chrome with the lens refused. There is no WebKit on this PC: Safari itself was not run.

## Sheets (`final2/`)

Today beside real glass, the same moment twice. 01–12 and 14–16 are this PC's own server, looked at only, as the test profile; 13 is a private test server.

- `01-phone-home`, `02-phone-bright`, `03-phone-sky`, `04-phone-title`: a phone over posters, over the brightest posters, over the dark sky alone, on a film's page.
- `05-desktop-home`, `06-desktop-posters`, `07-desktop-sky`, `08-desktop-title`: the same on a desktop.
- `09`–`12`: tablets, 1024 and 768 wide.
- `13-player`: the player's controls and menu over a bright frame.
- `14-edge`: edges enlarged.
- `15`, `16`: with and without the lens.
- `app-home`, `app-sky`, `app-title`, `app-sheet`, `app-player`: the phone app, photographed on the Pixel 9 emulator.

## Words on the glass

CONTRAST

## Speed

SPEED

## The phone app

React Native has no live backdrop, so there is no bend: the app wears the rim, the glint and the depth. Tokens are in `tv-native/src/phone/theme.ts` (`RG_*`); the rim is one small still drawing, `tv-native/src/phone/ui/GlassRim.tsx`, with nothing measured, so nothing arrives a frame late. Bodies are unchanged: the tab bar keeps its 86 %. Only the hero's "Details" is a real-glass pill; every glass button in a sheet or a page keeps the earlier look and its width.

**On a device this time:** Pixel 9 emulator (API 37), QA build 123, against a private test server, beside QA build 121 of origin/master. The inset shadows render (dark under the top edge, the violet pool). The ring sits on the edge. Nothing was seen popping in. Layout bounds are the same as origin/master's (the hero's Details, the tab items, a sheet's Cancel and Send).

Not checked: a real phone's GPU (the emulator draws in software), Android below API 37, smoothness, and a few surfaces that share the same components but were not opened (the Taste screen, the round Next, a lit player button, the TVs circle).

## Rigs (`tools/real-glass/`)

- `lab.js`: the scenes, on the private instance or (with `LIVE`) on this PC's server, with an optional variant stylesheet from `variants/` (the first pass's three directions).
- `options.py`, `final.py`, `final2.py`: the sheets.
- `layout-same.js`: nothing moved; every ring is its surface's.
- `more-open.js`, `scroll-probe.js`: the More menu and a scroll, many times over.
- `player-cost.js`: processor time over a playing film, at rest and during a scroll, with parts of the lens off.
- `z.py`, `zoom.py`: enlargements to look at closely.
- Contrast and the phone's speed table are `tools/glass-options/contrast.js` and `perf.js`, with "a" = origin/master.
- `tools/real-glass-app/`: the phone app's sheets.

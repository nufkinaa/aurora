# Real glass (2026-11-19)

elia asked for "a look of real looking glass with chromatic aberration for the btns", on "the nav and every glass btn across the board". This is that look, on the website and in the Android phone app. The TV app is not touched.

## What it is

The surfaces are the ones that took "Clear" a week ago: what floats over pictures. Their body is unchanged (the picture behind is dimmed and its colour kept). What is new is that a pane now reads as a thick piece of glass:

- **Its rim bends the picture.** The last 6–13 px before the edge are a bevel. They show, turned over, the band of picture just inside the rim, the way the edge of a thick lens does. The face stays softly frosted, so words on it read as before.
- **The colour fringe of a lens.** Red is bent a tenth more than green, blue a tenth less, so an edge in the picture splits into its colours inside the bevel and nowhere else.
- **Light on the rim in two places only.** A short arc on the left shoulder and its answer on the right foot. Each arc is white in the middle and breaks into a warm end and a cool end. There is no light along the top: elia ruled that out for Clear and it stands.
- **Depth.** The glass is dark just under its top edge and gathers a soft violet light along its foot, Aurora's own colour. A faint glow runs inside the whole rim, and the shadow below is a little deeper.

## Where

| got real glass | unchanged |
|---|---|
| the desktop top bar and the phone tab bar | the phone's side menu (More) |
| the round top buttons (settings, remote, downloads), the logo pill, the profile button | every drop-down menu, sheet, dialog and toast |
| the glass buttons on the hero and on a film's or show's page (desktop and tablet) | a phone's action tiles under a title (not glass panes, as with Clear) |
| the player's dock and top pills, Up next, the resume card, the quality and party pills | the player's menus; the panes, chips and rows in the page |
| the phone app: tab bar, logo, round buttons, glass pill, action circles, the player's buttons | the classic look; the TV app |

## Three directions, and the one built (`options/`)

Each sheet shows today's glass and three directions on this PC's own server, with real posters.

- **A · Bevel**: the lens and a quiet even rim; the fringe only as two thin coloured lines at a pane's ends.
- **B · Prism**: the lens, plus the rim's light in two arcs that break into colour.
- **C · Crystal**: a bevel half as wide again that splits the colours nearly twice as far, a second line inside the rim, longer arcs.

**B is built.** A is honest but reads as today's glass with a coloured outline; over the dark sky, where nothing is behind to bend, it barely differs from Clear. C is the most striking at first sight, but its round buttons read as chrome rings, not glass, and its fringe over a poster with words on it is the 3D-glasses effect. B keeps the bend and the fringe where they are true and adds only the light a real rim would catch.

After the choice, two things changed in B: the arcs on a small round button were shortened (at full reach a 42 px circle was lit nearly all the way round, top included), and the lens's two numbers settled at a bevel 1.1 wide and a spread of a tenth.

## How it is made

**The lens** (`public/js/glasslens.js`, Chromium only). An SVG filter inside `backdrop-filter`:
- a displacement map drawn once per size of surface, moves each pixel of the bevel to the band inside it;
- it is applied three times, once per colour channel, with a slightly different strength (the fringe);
- the bevel's picture is laid over a 3 px frosted copy of the backdrop (the face); the dim and the colour boost follow as before.

A map is kept and shared by every surface of the same size (every 42 px round button uses one). The browser's `ResizeObserver` says when a size changes. Nothing runs per frame and nothing new is blurred.

**The rest** (`public/css/glass.css`, the last section, "Real glass") is plain CSS and the same in every browser: box shadows for the depth, the pool and the two fringe lines at a pane's ends, and one masked ring (`::before`) for the arcs. Some surfaces became `position: relative` for the ring; `tools/real-glass/layout-same.js` compared every element's box with today's stylesheet on six screens at four sizes: nothing moved.

## Safari, iPhone and Firefox

They cannot draw the lens: Safari drops the whole backdrop filter when a `url()` is in it (WebKit bugs 245510, 317059), and Firefox draws none. So they never see one. The stylesheet uses a `url()` only under `html[data-lens]`, and only the script sets that, after checking that the browser is Chromium. Every iPhone browser is refused whatever its name, and `test/glasslens.test.js` holds both rules.

Their glass is everything except the bend: the rim's two arcs with their colours, the fringe lines, the dark top, the pool, the depth, over Clear's own blur and dim. `final/08-no-lens.jpg` shows it. There is no WebKit on this PC; this was photographed in Chrome with the lens refused, which is the same stylesheet path, but Safari itself was not run.

Other fallbacks: Reduce Transparency, a TV's browser and a weak device (`data-fx="lite"`) get no lens and keep Clear's near-opaque body. A browser that cannot mask the ring gets no arcs. A person can switch the lens off with `localStorage["aurora-lens"] = "off"`.

## Sheets (`final/`)

Today beside real glass, the same moment twice.

- `01-phone-home.jpg`: phone Home, the tab bar over posters and the top buttons over the picture.
- `02-desktop-home.jpg`: desktop Home, the top bar over the hero.
- `03-desktop-posters.jpg`: the top bar over posters.
- `04-title-desktop.png`, `05-title-phone.png`: a film's page.
- `06-player.png`: the player's controls and menu over a bright frame.
- `07-edge-3x.png`: one edge enlarged, so the bend and the fringe can be seen.
- `08-no-lens.jpg`: what Safari and Firefox get.
- `app-home.png`, `app-title.png`: the phone app. These are drawn in a browser from the app's own style values. They are not photographs of a phone: no emulator was available.

Scenes 01–05, 07 and 08 are this PC's own server, looked at only, as the test profile; the player is a private test server.

## Words on the glass

Measured with `tools/glass-options/contrast.js` (the dimmest 1 % behind each word, over a white poster, a bright poster, mid grey, white text, a bright sky band and black; a white frame for the player). Every real-glass surface reads the same as with Clear, to a tenth:

| surface | lowest, today | lowest, real glass |
|---|---:|---:|
| phone tab bar, words / chosen tab | 6.3 / 5.4 | 6.3 / 5.4 |
| phone top buttons | 5.8 | 5.8 |
| desktop top bar, words / chosen tab | 5.3 / 5.1 | 5.3 / 5.1 |
| glass buttons on the hero and a title | 15.5 | 15.7 |
| the player's dock and pills | 4.7 | 4.7 |

The bend lives in the bevel, where no word is. The three cells under 4.5:1 are the same three as before, on surfaces this round did not touch (a chip's count and the season bar over a sky painted as one bright band).

## Speed

PERF

## The phone app

React Native has no live backdrop, so there is no bend: the app wears the drawn half of the look. The tokens are in `tv-native/src/phone/theme.ts` ("Real glass", `RG_*`) and the rim is one small still drawing, `tv-native/src/phone/ui/GlassRim.tsx` (react-native-svg, already in the app). Bodies are unchanged: the tab bar keeps its 86 %.

Not seen on a device. `tsc` and the logic tests pass. To check on the Pixel emulator:
1. The tab bar shows the dark under its top edge and the violet pool at its foot (inset shadows with negative spread are untested on Android).
2. The ring sits exactly on the edge of the tab bar, the glass pill and the player's Next pill.
3. No hairline popping in a frame late on the glass pill and the round buttons.
4. The hero's Details, Taste's "Edit list" and the Next pill are as wide as before.
5. The small round buttons show two arcs, not colour all round.
6. Home scrolls and the player opens as smoothly as before.
7. On Android 9, only the hairline, the arcs, the outside line and the shadow are expected.

## Rigs (`tools/real-glass/`)

- `lab.js`: the scenes, on the private instance or (with `LIVE`) on this PC's server, with an optional variant stylesheet from `variants/`.
- `options.py`, `final.py`: the sheets.
- `layout-same.js`: nothing moved.
- `z.py`, `zoom.py`: enlargements to look at closely.
- Contrast and speed are `tools/glass-options/contrast.js` and `perf.js`, with "a" = origin/master.
- `tools/real-glass-app/`: the phone app's drawing.

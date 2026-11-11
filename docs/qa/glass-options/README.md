# The website's glass: "Clear" (2026-11-11)

elia asked for better glass and a few versions to choose from: "search online see how other people do it, see how Apple does it how figma does it and give me a few versions to choose from". He saw five:
- A: today's grey glass.
- B Aurora: today's glass in Aurora's violet and green.
- C Liquid: closest to Apple's Liquid Glass, with refraction at the rim.
- D Frost: Figma's Glass effect.
- E Clear.

He chose **E, "Clear"**: "I think E looks the best!! Let's change to that." It is now the website's glass for everyone, on every screen and size. The classic look is untouched. The five-version sheets are in this branch's history: commit `4adcb16d`, `docs/qa/glass-options/*.png`.

## What Clear is

The most see-through glass. It has almost no body: a fifth of black over a light 3 px blur, so a poster behind a bar stays a poster. The backdrop is dimmed hard under the glass (brightness 0.48), which is Apple's "dimming layer" for its clear glass. Colour comes through but brightness does not, so white words read over a white poster.

A strong edge draws the shape:
- a 1 px light line all round inside, brighter along the top;
- a dark hairline outside, which parts the glass from a white page;
- a small close shadow.

Words on the bars carry a soft shadow of their own. The chosen tab is a lighter capsule with its own line, and its word is white.

Some surfaces differ from the bars:
- **Menus, sheets, dialogs and toasts** carry lines of words, so they frost more (10 px) and dim deeper.
- **Panes in the page** (Settings rows, episodes, sources, downloads, chips) are never blurred. Their body alone holds the words over the sky: 70 % of near-black for panes, 58 % for chips.
- **The phone's player chrome** (dock, top pills, Up next, resume card) is not blurred over video, because a live blur over moving video is the most expensive effect on a phone. It carries 62 % of black instead.
- **The phone's More menu** is a clear frosted pane over the dimmed page. Its frost comes on only once it has slid in, because a frosted pane re-blurs the whole screen on every frame of the slide.

When nothing behind can be blurred or dimmed, every body becomes a near-opaque dark grey and the edges stay. That covers Reduce Transparency, a TV's browser, a weak device (`data-fx="lite"`) and a browser without `backdrop-filter`.

The code is all in `public/css/glass.css`:
- the tokens at the top (`--g-fill…`, `--g-blur`, `--g-blur-thick`, `--g-edge…`, `--g-well`);
- the fallbacks in the "device tier" and reduced-transparency blocks;
- the section "the clear glass's own rules" near the end.

### Two faults found along the way, fixed

- **The player's menu on a desktop had no body.** The rule that lays the TV's hue over it replaced the menu's own fill, so over a bright frame its words were white on white (1.0:1). It now has a body (5.6:1).
- **The phone's More menu could never frost.** The page dim behind it stays at the end of its fade-in animation, and Chrome then treats it as a "backdrop root": the pane's blur sees only the dim, never the page. The dim's fade no longer stays applied once it has run.

## Sheets: today against Clear (`final/`)

Each sheet shows the same moment twice, today's glass beside Clear:
- `00-overview.png`: phone Home, the tab bar at 2×, the desktop profile menu, the player's menu over a bright frame.
- `01-phone-home.png`, `02-phone-more.png`, `03-phone-title.png`, `04-phone-sheet.png` (Recommend), `05-desktop-home.png`, `06-desktop-menu.png`, `07-desktop-title.png`, `08-player-menu.png`, `09-phone-toast.png`, `10-phone-bright.png` (the tab bar over white posters).

Scenes 01–03 and 05–07 come from this PC's own server with real posters. It was only looked at, as the test profile "Claude QA", and both stylesheets were answered by the rig. The others come from a private test server with made-up art. The sky is held still and the hero does not rotate, so only the glass differs.

## Words over the brightest backgrounds (`final/contrast.md`)

Every surface was measured over every background it can meet:
- white poster, bright poster, mid grey;
- white text passing under the glass;
- the sky painted as one bright green band, black;
- a white picture for buttons on a title, a white film frame for the player.

The ratio counted is the WCAG ratio behind the dimmest 1 % of each word's pixels. Surfaces measured: phone tab bar (402 and 320), top buttons, profile menu, sheets, toasts, peek, hero and title-page buttons, Settings panes, episodes and the season bar, chips, the desktop and 2560 nav island, search box and suggestions, the player's dock, top pills, resume card and Settings menu (desktop and phone), and the Remote screen (`tools/glass-apple/remote-contrast.js`).

| | under 4.5:1 (words, chosen tabs, icons) | lowest |
|---|---:|---:|
| today (1.15.28) | 6 cells | 1.0:1 (the desktop player menu) |
| **Clear** | **0** | **4.6:1** |

The Remote screen is the same as today or better on every pad (the TV picker 4.8 → 6.9:1).

## Speed (CPU ×4 on a phone, the same rig and hour, medians)

Measured with `tools/glass-options/perf.js` on Home: a fling top to bottom at 3000 px/s, three seconds at rest mid-page with the sky alive, then the More menu opened (its first 700 ms).

| phone 390 × 844, 6 runs | today | Clear |
|---|---:|---:|
| scroll: mean frame / p95 / p99 (ms) | 17.4 / 17.7 / 17.9 | 17.5 / 17.7 / 18.5 |
| scroll: late frames (> 25 ms) | 0 | 0 |
| at rest: mean / p95 (ms) | 17.4 / 17.6 | 17.3 / 17.7 |
| More menu: frames in 700 ms / p95 / worst / late | 38.5 / 17.7 / 52 / 1 | 39 / 17.7 / 34.5 / 1 |

On desktop 1440 × 900 (4 runs), the scroll mean / p95 / p99 is 16.9 / 17.8 / 18.5 ms today and 17.2 / 18.0 / 18.4 ms for Clear, with no late frames on either. Clear blurs fewer pixels than today on the bars (3 px against 6 px) and the same surfaces. Its only new blur is the More menu's, applied after the slide. A first try that frosted the pane during the slide had 5 late frames against 2; that is why it waits.

## Safari (iPhone)

Clear uses only what Safari draws: `-webkit-backdrop-filter` with blur, saturate and brightness, plus gradients and shadows. There is no SVG filter. Safari ignores one inside a backdrop filter and drops the whole filter with it (WebKit bugs 245510 and 317059); version C needed that and is gone. There is no WebKit on this PC, so Safari itself was not run.

Safari has no `prefers-reduced-transparency` media query. An iPhone with Reduce Transparency on still gets the clear glass from the website. Words still read, because the dim does the work.

## The TV app and the phone app (not changed; a picture comes first)

React Native has no cheap live backdrop blur. The TV draws pre-rendered glass edges, and the phone app has no blur on its bars either. What carries over from Clear is its edge and its words, not the dim, because nothing behind is blurred or dimmed:

- **TV.** Pills, buttons and the player's chrome would take a darker see-through body: about 55–60 % of black instead of a tinted pane, because without the dim the body must hold the words alone. They would take Clear's edge as the pre-rendered rim image: the light line all round, the brighter top line and the dark outside hairline. White words would get a soft shadow, and the chosen item a lighter capsule with a line. elia wants the TV to keep Aurora's colours ("it needs to still have the aurora colors"). So the rail and the menus would keep their violet and green panels and take only Clear's edge. Focus stays the TV's white fill.
- **Phone app.** The same as the TV for the tab bar, the top buttons and sheets: about 60 % of black, Clear's edges, white words. On Android 12 and later, a real 3 px blur with a dim (`RenderEffect`) is possible on the tab bar alone. It would need measuring first on the weakest phone we support.

## Sources (what each one gave)

1. **Apple WWDC25, "Meet Liquid Glass"**, https://developer.apple.com/videos/play/wwdc2025/219/. Lensing and "light concentrated at the edge", highlights that follow the shape, the Regular and Clear variants, no glass on glass, and what Reduce Transparency, Increase Contrast and Reduce Motion do.
2. **Apple HIG, Materials**, https://developer.apple.com/design/human-interface-guidelines/materials. Glass belongs to controls, not content. Clear glass only over rich pictures, with a dimming layer (35 %): the idea Clear is built on. Also the old thin, regular and thick materials and vibrancy levels.
3. **kube.io, "Liquid Glass in the Browser: Refraction with CSS and SVG"**, https://kube.io/blog/liquid-glass-css-svg/. Refraction from a bezel profile through an SVG displacement map. Used in version C, then dropped with it.
4. **Josh Comeau, "Next-level frosted glass with backdrop-filter"**, https://www.joshwcomeau.com/css/backdrop-filter/. Edge handling, a thin light strip as the "glass edge", and backdrop-filter pitfalls.
5. **Atlas Pup Labs, "Liquid Glass, but in CSS"**, https://atlaspuplabs.com/blog/liquid-glass-but-in-css. Layered inset highlights and RGB-split fringes. Chrome-only and heavy, which shaped versions C and D.
6. **LogRocket, "How to create Liquid Glass effects with CSS and SVG"**, https://blog.logrocket.com/how-create-liquid-glass-effects-css-and-svg/. The filter chain and fallback advice.
7. **WebKit bugs 245510 and 317059**, https://bugs.webkit.org/show_bug.cgi?id=245510. Safari ignores `url()` in `backdrop-filter` and drops the whole filter.
8. **Mozilla bugs 1808785 and 1961378**, https://bugzilla.mozilla.org/show_bug.cgi?id=1808785. Firefox draws no SVG filter in a backdrop filter.
9. **NN/g, "Liquid Glass Is Cracked, and Usability Suffers in iOS 26"**, https://www.nngroup.com/articles/liquid-glass/. Words over busy pictures and "text on text". This is why Clear measures against the brightest background, not the average, and why the More menu must frost.
10. **Figma, the Glass effect** (refraction, depth, dispersion, frost, light angle, splay), via Figma's help and community write-ups. It shaped version D. The panel's exact ranges could not be verified.

## Rigs (`tools/glass-options/`)

"a" means today: origin/master's stylesheet, answered by the rig (`GA_BEFORE_CSS`). "e" means this worktree.

- `shoot.js`: the scenes on the private instance.
- `live.js`: the same scenes on this PC's server, looked at only, as the test profile.
- `sheet.py`: the comparison sheets.
- `contrast.js` and `contrast.py`: the words over every background, including the player.
- `perf.js`: scroll and the More menu at CPU ×4.

They build on `tools/glass-apple/` (lib, stage, targets).

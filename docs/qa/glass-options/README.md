# The website's glass: "Clear" (2026-11-11)

elia asked for better glass and a few versions to choose from: "search online see how other people do it, see how Apple does it how figma does it and give me a few versions to choose from". He saw five:
- A: today's grey glass.
- B Aurora: today's glass in Aurora's violet and green.
- C Liquid: closest to Apple's Liquid Glass, with refraction at the rim.
- D Frost: Figma's Glass effect.
- E Clear.

He chose **E, "Clear"**: "I think E looks the best!! Let's change to that." He then added: "Not everything needs to change to this, for example to side nav on mobile web should stay the same…, and make sure we are not losing too much color".

So Clear is now the glass of **what floats over the pictures**, and everything else keeps today's glass. The classic look is untouched. The five-version sheets are in this branch's history: commit `4adcb16d`, `docs/qa/glass-options/*.png`.

## What Clear is, and where

Clear has almost no body: a fifth of a deep indigo-black over a light 3 px blur, so a poster behind a bar stays a poster. The backdrop is dimmed under the glass (brightness 0.5), which is Apple's "dimming layer" for its clear glass. That is what holds white words over a white poster. The blur also doubles the colour's saturation, so the posters' and the sky's colour come through stronger than through today's grey.

The edge is one faint, even light line all round, a dark hairline outside and a small shadow. There is no light along the top: elia said "glass looks better when there isn't hard white backdrop from the top of the glass". So there is no sheen, no top line, no corner glow, and no top line on the chosen or pressed tab.

Words on it carry a soft shadow of their own. The chosen tab is a lighter capsule in Aurora's violet with its own line, and its word is white.

| got Clear | kept today's glass |
|---|---|
| the top bar (desktop island, tablet bar) and the phone tab bar, with its chosen tab | the phone's side menu (More): pixel-identical to today, see below |
| the round top buttons (Settings gear, remote, downloads pill), the logo pill and the profile button | the profile menu and every drop-down menu |
| the glass buttons on the hero and on a film's or show's page. On a phone, the round action buttons under a title are not glass panes and look as today. | sheets and dialogs (Recommend, confirm, peek, sign-in), toasts, the search box and its suggestions |
| the player's dock, its top pills, its Settings, subtitles and speed menus, Up next, the resume card, the quality and party pills | the panes in the page: Settings rows, episodes, the season bar, sources, downloads, chips, the party panel |

**The phone's side menu is unchanged.** `tools/glass-options/more-same.js` opened it with today's stylesheet and with this one at 390 × 844, 375 × 812 and 430 × 932, in both looks, and compared the menu's own box pixel by pixel. The result was 0 different pixels in all six. A first run showed one legacy pair off by at most 3 levels across the whole box; the second run gave 0 in all six, so that was rendering noise.

**The phone player's chrome** is never blurred over video, because a live blur over moving video is the most expensive effect on a phone. So there it carries 62 % of black, and white words read at 6:1 over a white frame.

When nothing behind can be blurred or dimmed, Clear's body becomes a near-opaque dark grey and the edge stays. That covers Reduce Transparency, a TV's browser, a weak device (`data-fx="lite"`) and a browser without `backdrop-filter`.

The code is one section at the end of `public/css/glass.css`, "Clear: the glass of the chrome that floats over pictures". It holds the `--ge-*` tokens, the list of surfaces that take them, the player's menus, the words' shadow, the phone player's body and the fallbacks. The rest of the file is today's.

### A fault found along the way, fixed

The player's menu on a desktop had no body. The rule that lays the TV's hue over it replaced the menu's own fill, so over a bright frame its words were white on white (1.0:1). It now has a body (5.7:1).

## Sheets: today against Clear (`final/`)

Each sheet shows the same moment twice, today's glass beside Clear:
- `00-overview.png`: phone Home, the tab bar at 2×, the desktop profile menu (kept today's), the player's menu over a bright frame.
- `01-phone-home.png`, `02-phone-more.png` (the side menu, unchanged), `03-phone-title.png`, `04-phone-sheet.png` (Recommend, unchanged), `05-desktop-home.png`, `06-desktop-menu.png`, `07-desktop-title.png`, `08-player-menu.png`, `09-phone-toast.png` (the toast unchanged, the tab bar Clear), `10-phone-bright.png` (the tab bar over white posters).
- **`11-colour.png`: the colour through the glass**, today against Clear, in the same frames.

Scenes 01–03 and 05–07 come from this PC's own server with real posters. It was only looked at, as the test profile "Claude QA", and both stylesheets were answered by the rig. The two sides are taken a minute apart, so live state can differ between them (a TV coming online adds "Your TVs" to the profile menu); that is not the glass. The others come from a private test server with made-up art. The sky is held still and the hero does not rotate, so only the glass differs.

## Colour (`final/colour.md`, `final/11-colour.png`)

These are measured on the glass's own pixels in the same frames. "Colour" is the Hasler–Süsstrunk colourfulness; saturation is the HSV mean. Clear keeps or adds colour everywhere:

| glass part | colour today → Clear | saturation today → Clear |
|---|---:|---:|
| phone, round buttons over the sky | 65 → 66 | 0.60 → 0.69 |
| phone, tab bar over Continue Watching | 23 → 26 | 0.28 → 0.46 |
| phone, a film's buttons over its picture | 46 → 46 | 0.37 → 0.37 |
| desktop, the top bar over the hero | 24 → 24 | 0.26 → 0.30 |
| desktop, a film's buttons over its picture | 8 → 8 | 0.26 → 0.45 |

## Words over the brightest backgrounds (`final/contrast.md`)

Every surface was measured over every background it can meet:
- white poster, bright poster, mid grey;
- white text passing under the glass;
- the sky painted as one bright green band, black;
- a white picture for buttons on a title, a white film frame for the player.

The ratio counted is the WCAG ratio behind the dimmest 1 % of each word's pixels. Surfaces measured: phone tab bar (402 and 320), top buttons, nav island (1440 and 2560), hero and title-page buttons, the player's dock, top pills, resume card and Settings menu (desktop and phone), and the surfaces that kept today's look. The Remote screen was measured separately with `tools/glass-apple/remote-contrast.js`: the same as today or better on every pad.

| | under 4.5:1 (words, chosen tabs, icons) | lowest |
|---|---:|---:|
| today (1.15.28) | 6 cells | 1.0:1 (the desktop player menu) |
| **Clear** | **3 cells** | **3.8:1** |

Clear's three cells are all on surfaces that kept today's look, with the same numbers as today: episodes and the season bar, a chip's count, and the Settings panes' icons over the sky painted as one bright green band. Every surface that took Clear reads at **4.7:1 or better**.

## Speed (CPU ×4 on a phone, the same rig and hour, medians)

Measured with `tools/glass-options/perf.js` on Home: a fling top to bottom at 3000 px/s, three seconds at rest mid-page with the sky alive, then the More menu opened (its first 700 ms).

| phone 390 × 844, 8 runs | today | Clear |
|---|---:|---:|
| scroll: mean frame / p95 / p99 (ms) | 16.6 / 18.1 / 43.0 | 16.7 / 18.3 / 26.8 |
| scroll: late frames (> 25 ms) | 1 | 0.5 |
| at rest: mean / p95 (ms) | 16.4 / 18.3 | 16.2 / 18.1 |
| More menu: frames in 700 ms / p95 / worst / late | 38 / 18.4 / 70.5 / 1 | 41 / 18.2 / 61.5 / 1 |

On desktop 1440 × 900 (4 runs), the scroll mean / p95 / p99 is 16.5 / 18.1 / 18.4 ms today and 16.4 / 17.9 / 18.2 ms for Clear, with no late frames on either. Clear blurs the same surfaces as today with half the radius (3 px against 6 px) and adds no new blur.

The machine was shared with other agents' runs. One 6-run batch was noisier on both sides; the 8-run batch above is the one kept (`final/perf-phone.json`, `final/perf-desktop.json`).

## Safari (iPhone)

Clear uses only what Safari draws: `-webkit-backdrop-filter` with blur, saturate and brightness, plus gradients and shadows. There is no SVG filter. Safari ignores one inside a backdrop filter and drops the whole filter with it (WebKit bugs 245510 and 317059); version C needed that and is gone. There is no WebKit on this PC, so Safari itself was not run.

Safari has no `prefers-reduced-transparency` media query. An iPhone with Reduce Transparency on still gets the clear glass from the website. Words still read, because the dim does the work.

## The TV app and the phone app (not changed; a picture comes first)

React Native has no cheap live backdrop blur. The TV draws pre-rendered glass edges, and the phone app has no blur on its bars either. What carries over from Clear is its edge and its words, not the dim, because nothing behind is blurred or dimmed:

- **TV.** Only what floats over pictures, as on the website: pills, buttons and the player's chrome would take a darker see-through body: about 55–60 % of black instead of a tinted pane, because without the dim the body must hold the words alone. They would take Clear's edge as the pre-rendered rim image: one faint even light line all round (no light along the top) and the dark outside hairline. White words would get a soft shadow, and the chosen item a lighter violet capsule with a line, as on the website. elia wants the TV to keep Aurora's colours ("it needs to still have the aurora colors"). So the rail and the menus would keep their violet and green panels and take only Clear's edge. Focus stays the TV's white fill.
- **Phone app.** The same as the TV, and only where the website took Clear (the tab bar, the top buttons, the player's chrome): about 60 % of black, Clear's edges, white words, the violet chosen tab. Its side menu, sheets and lists stay as they are, as on the website. On Android 12 and later, a real 3 px blur with a dim (`RenderEffect`) is possible on the tab bar alone. It would need measuring first on the weakest phone we support.

## Sources (what each one gave)

1. **Apple WWDC25, "Meet Liquid Glass"**, https://developer.apple.com/videos/play/wwdc2025/219/. Lensing and "light concentrated at the edge", highlights that follow the shape, the Regular and Clear variants, no glass on glass, and what Reduce Transparency, Increase Contrast and Reduce Motion do.
2. **Apple HIG, Materials**, https://developer.apple.com/design/human-interface-guidelines/materials. Glass belongs to controls, not content. Clear glass only over rich pictures, with a dimming layer (35 %): the idea Clear is built on. Also the old thin, regular and thick materials and vibrancy levels.
3. **kube.io, "Liquid Glass in the Browser: Refraction with CSS and SVG"**, https://kube.io/blog/liquid-glass-css-svg/. Refraction from a bezel profile through an SVG displacement map. Used in version C, then dropped with it.
4. **Josh Comeau, "Next-level frosted glass with backdrop-filter"**, https://www.joshwcomeau.com/css/backdrop-filter/. Edge handling, a thin light strip as the "glass edge", and backdrop-filter pitfalls.
5. **Atlas Pup Labs, "Liquid Glass, but in CSS"**, https://atlaspuplabs.com/blog/liquid-glass-but-in-css. Layered inset highlights and RGB-split fringes. Chrome-only and heavy, which shaped versions C and D.
6. **LogRocket, "How to create Liquid Glass effects with CSS and SVG"**, https://blog.logrocket.com/how-create-liquid-glass-effects-css-and-svg/. The filter chain and fallback advice.
7. **WebKit bugs 245510 and 317059**, https://bugs.webkit.org/show_bug.cgi?id=245510. Safari ignores `url()` in `backdrop-filter` and drops the whole filter.
8. **Mozilla bugs 1808785 and 1961378**, https://bugzilla.mozilla.org/show_bug.cgi?id=1808785. Firefox draws no SVG filter in a backdrop filter.
9. **NN/g, "Liquid Glass Is Cracked, and Usability Suffers in iOS 26"**, https://www.nngroup.com/articles/liquid-glass/. Words over busy pictures and "text on text". This is why Clear measures against the brightest background, not the average.
10. **Figma, the Glass effect** (refraction, depth, dispersion, frost, light angle, splay), via Figma's help and community write-ups. It shaped version D. The panel's exact ranges could not be verified.

## Rigs (`tools/glass-options/`)

"a" means today: origin/master's stylesheet, answered by the rig (`GA_BEFORE_CSS`). "e" means this worktree.

- `shoot.js`: the scenes on the private instance.
- `live.js`: the same scenes on this PC's server, looked at only, as the test profile.
- `sheet.py`: the comparison sheets.
- `contrast.js` and `contrast.py`: the words over every background, including the player.
- `perf.js`: scroll and the More menu at CPU ×4.
- `more-same.js`: the side menu, pixel for pixel against today.
- `colour.py`: the colour through the glass.

They build on `tools/glass-apple/` (lib, stage, targets).

# Aurora logo proposals

Three directions for a real mark, to replace the plain violet gradient square (web) and the
letter "A" (TV). **Nothing is installed** - this folder is a proposal. Start with
`overview.png`: the three side by side at every size that matters.

Files per concept (`curtain`, `horizon`, `beam`):

| file | what it is |
| --- | --- |
| `<name>-mark.svg` | the mark alone, 512 box, transparent background |
| `<name>-icon.svg` | the mark as a full-bleed square app icon on navy (source for launcher / PWA icons) |
| `<name>-mono.svg` | one colour, `currentColor` (defaults to `#f3f4f8`) - favicon, notification, stencil |
| `<name>-lockup.svg` | mark + drawn "Aurora" wordmark, horizontal, for dark backgrounds |
| `<name>-tv-banner.svg` / `.png` | 320x180 Android TV banner |
| `<name>-512.png`, `-64.png`, `-32.png` | previews of the icon on navy |

The wordmark is not a font: it is six monoline letters built from straight lines and circular
arcs (x-height 100, cap height 142, stroke 14 units), so it renders identically everywhere.

The PNGs are the SVGs themselves, rasterised by headless Chrome at 1024 px (banner at
1280x720) and Lanczos-downscaled - not a redraw. `python docs/brand/tools/build.py`
regenerates every SVG and PNG from `tools/concepts.py` (needs Pillow and Chrome or Edge).

## 1. Curtain

**Idea.** An aurora is a curtain: tall blades of light hanging side by side. Two of them lean
together into an "A" - the green blade runs the full height and owns the apex, the
cyan-to-violet one tucks in behind it, and the dark opening between them is the curtain parting.

**Works best** as the identity proper: next to the wordmark, in the nav, as the TV home-row
logo (it answers the "plain letter A" directly), and in one colour - the silhouette alone
carries it, down to 16 px. Two plain filled paths, no clipping, so it converts cleanly to an
Android vector drawable.

**Weakness.** It is a monogram, so it says "A", not "films and shows"; at a glance it can read
as a tent or a sail. The apex is a fine point - below about 20 px it softens.

## 2. Horizon

**Idea.** The aurora seen from orbit, framed by the app's own rounded tile: the planet's dark
limb, a hairline of atmosphere, the green arc above it and violet sky fading to night. It keeps
the rounded violet square people already know and puts the northern lights in it.

**Works best** as an app icon: the richest and most cinematic of the three large, full-bleed
(so it fills a launcher tile or a round mask edge to edge), and the most continuous with
today's icon.

**Weakness.** It is a picture in a tile rather than a mark. The one-colour version is the
weakest of the three (a tile with two arcs - it loses the idea), the hairline limb disappears
below about 48 px, and on the app's own dark background the bottom of the tile is low-contrast.

## 3. Beam

**Idea.** A play triangle made of three bands of light - green, cyan, violet - parted by the
wavy hem of the curtain and converging on the tip like a projector beam. It says "press play"
and "aurora" in one shape.

**Works best** on a TV home screen and in a launcher, beside other streaming apps: nobody has
to be told what the app does. Solid, bold, and it survives 16 px as a coloured play arrow.

**Weakness.** However well dressed, it is still a play button, the most used shape in the
category. Below about 32 px the bands merge and only the arrow is left. It relies on a clip
path, so the Android vector needs a `<clip-path>` group.

## Recommendation: Curtain

Curtain is the only one of the three that is a mark in the strict sense - it works with the
colour taken away, it works at 16 px, and it is drawn from the name rather than from the
category. It also fixes the two actual complaints at once: the web icon stops being an
anonymous gradient, and the TV row gets an "A" that is Aurora's own instead of a typed letter.

Beam is the safe runner-up if the priority is being instantly recognised as a streaming app
on the TV's home row. Horizon is the prettiest tile but the weakest identity; if it is liked,
the sensible use is Curtain as the logo with the Horizon sky kept as launch / splash artwork.

## Colours

| role | value | from |
| --- | --- | --- |
| page navy | `#0b0c14` | `--bg` in `public/css/tokens.css` |
| icon tile glow (radial, top) | `#161a33` to `#0b0c14` | new |
| aurora green | `#46c896` | brief |
| aurora mint (highlight) | `#8cffbe` | brief |
| cyan | `#7fd1e8` | `--kind-series` |
| violet | `#8b7bff` | `--accent` |
| deep violet | `#6856e2` | brief |
| wordmark / mono | `#f3f4f8` | `--text` |
| Horizon sky | `#15153a`, `#4337b4`, `#6856e2` | new |
| Horizon planet / gap / limb | `#2b2a6a` to `#15162f`, `#0d0d22`, `#d9d4ff` | new |
| Beam cyan band | `#5fc4d8` to `#9be4f2` | around `#7fd1e8` |

On light backgrounds use the mono mark in `#0b0c14`; the mint and cyan do not hold on white.

## Install checklist (for later - nothing below has been touched)

All bitmaps come from `<name>-icon.svg` (full-bleed square) unless noted.

### Web

- [ ] `public/icon-180.png`, `public/icon-192.png`, `public/icon-512.png` - re-render from
      `<name>-icon.svg`. Both manifest icons are declared `any maskable`, so the mark must stay
      inside the central 80% circle; the icon SVG already scales it to 80%.
- [ ] `public/manifest.webmanifest` - paths stay; `background_color` / `theme_color`
      (`#070811`) already suit the navy tile. Only edit if a separate maskable file is added.
- [ ] `public/index.html` - the inline `<link rel="icon" href="data:image/svg+xml,...">`
      (gradient square, near line 22): replace with the mark SVG URL-encoded, or a
      `/favicon.svg` file. `<link rel="apple-touch-icon" href="/icon-180.png">` (near line 16)
      keeps its path.
- [ ] `public/index.html` nav logo - `<a class="nav-logo"><span class="logo-mark"></span><span>Aurora</span></a>`
      (near line 112). The mark is drawn in CSS, not an image:
      `public/css/components.css` `.nav-logo .logo-mark` (line 48: 26 px, radius 8, conic
      gradient, violet glow). Replace the gradient with the mark as an inline SVG or
      `background: url(...)`; drop the radius and glow for Curtain / Beam.
      Check the glass overrides of `.nav-logo` in `public/css/glass.css` (lines 92, 189, 2080,
      3319, 3587, 4163) and `public/css/responsive.css` (line 30) - they style the container, and
      `public/js/navTone.js` / `public/js/glassTone.js` tint `.nav-logo` text over bright art.
- [ ] `public/admin.html` - same conic-gradient `.logo-mark` in its own `<style>`: `.brand .logo-mark`
      (line 21, 30 px) and `.gate .logo-mark` (line 96, 46 px); used in the sidebar brand and in
      the sign-in gate markup.
- [ ] `public/browser.html` - `.start .logo-mark` (line 38, 60 px) and the `<span class="logo-mark">`
      on its start screen.
- [ ] `public/sw.js` - web-push notifications use `/icon-192.png` as both `icon` and `badge`
      (lines 217-218). Android shows the badge as a one-colour stencil: add a PNG rendered from
      `<name>-mono.svg` (white on transparent, 96 px) and point `badge` at it. Bump the service
      worker cache version so the new icons are fetched.

### Android TV (`tv-native/`)

The bitmaps are generated, not hand-placed: `tv-native/tools/gen_icons.py` writes every
launcher file, the banner and `src/assets/logo.png`; `tv-native/tools/gen_logo.py` writes
`src/assets/logo-mark.png`. Either teach those scripts to paste the new renders or replace
the outputs and retire the scripts - otherwise the next run overwrites the new logo.

- [ ] Legacy launcher icons, `tv-native/android/app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png`
      at 48 / 72 / 96 / 144 / 192 px, and `ic_launcher_round.png` at the same sizes (circle mask).
- [ ] Adaptive icon layers in the same five folders: `ic_launcher_background.png` and
      `ic_launcher_foreground.png` at 108 / 162 / 216 / 324 / 432 px. Background = the navy
      tile gradient only; foreground = `<name>-mark.svg` on transparent, scaled so it sits
      inside the 66/108 safe circle (about 55% of the layer). For Horizon the whole scene goes
      in the background layer and the foreground stays empty.
- [ ] `tv-native/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` and
      `ic_launcher_round.xml` - unchanged if the layer file names stay. They deliberately have
      no `<monochrome>` layer; with a real mono mark one can now be added from `<name>-mono.svg`.
- [ ] `tv-native/android/app/src/main/res/drawable/banner.png` (320x180) - replace with
      `<name>-tv-banner.png`. This is what the TV's apps row shows.
- [ ] `tv-native/android/app/src/main/AndroidManifest.xml` - no edit needed; `android:icon`,
      `android:roundIcon` and `android:banner` are set on both `<application>` and the activity
      (lines 39-41 and 56-57) and keep pointing at the same resource names.
- [ ] `tv-native/android/app/build.gradle` - bump `versionCode`: the comment near line 86
      records that the launcher caches the icon per versionCode, so a reinstall at the same
      code keeps showing the old one.
- [ ] TV home-screen row logo (the "A" the owner sees): `storeLogo()` in
      `tv-native/android/app/src/main/java/com/auroratv/HomeScreenRows.kt` (and the older copy in
      `HomeScreenModule.kt`) draws the app's own icon into a 160 px bitmap, once per run. It
      follows the launcher icon automatically; verify on the Mi TV that the row logo actually
      refreshes after the update (the channel may need its logo stored again).
- [ ] In-app nav rail: `tv-native/src/components/NavRail.tsx` - `const LOGO = require('../assets/logo-mark.png')`
      (line 44), drawn twice with `styles.mark` (26 dp, `borderRadius`, violet `boxShadow`, near
      line 653). Replace `tv-native/src/assets/logo-mark.png` (currently 208 px) with a render
      of `<name>-mark.svg` on transparent and remove the radius / shadow for Curtain or Beam.
      `tv-native/src/assets/logo.png` (96 px, written by `gen_icons.py`) is no longer imported
      anywhere - replace or delete it.
- [ ] Republish the APK (`public/aurora-tv.apk`, `public/tv-version.json`) as usual so TVs
      pick the new icon up.

### Elsewhere

- [ ] `README.md` and any screenshots under `docs/` that show the old square.

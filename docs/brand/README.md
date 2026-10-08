# Aurora logo: Beam

**Beam is Aurora's logo.** Three directions were proposed (Curtain, Horizon, Beam -
`overview.png`); the owner chose Beam and asked for more of the product's purple and green
in the background. That is done and the logo is installed on the site and in the Android TV
app. Everything is generated - see [Regenerating](#regenerating).

## The mark

A play triangle made of three bands of light - green, cyan, violet - parted by the wavy hem
of an aurora curtain and converging on the tip like a projector beam. It says "press play"
and "aurora" in one shape, and survives 16 px as a coloured play arrow.

The mark itself is unchanged from the proposal. It is drawn in `tools/concepts.py` (`beam`)
in a 512 box; the triangle spans x 136..442, y 88..424.

## The background

The proposal's tile was close to flat navy. It is now an aurora glow behind the mark, on the
page navy `#0b0c14`:

- a **violet bloom from the top-left corner** (`#8b7bff` at the heart, through `#6856e2`, to nothing);
- an **aurora-green bloom from the bottom-right corner** (`#8cffbe` at the heart, through `#46c896`, to nothing).

The corners are chosen for contrast: the violet sits behind the green band, the green stays
clear of the violet band, and the diagonal between them stays navy, so all three bands keep
their edge and the tile does not go muddy at 32-48 px.

Three intensities were rendered - `beam-background-options.png` shows the old background and
all three at 512 / 96 / 48 / 32 px and as the TV banner. **Medium** is the one installed:
Soft is hard to tell from the old tile at 48 px (the request would look unanswered); Vivid
is handsome large but its lit corners start to compete with the mark, and the green band
loses contrast against the bright violet corner. The levels are `BG_LEVELS` in
`tools/concepts.py` (peak alpha of the violet and green blooms: soft .40/.26, medium .62/.42,
vivid .86/.60); change `BG_CHOSEN` and run the install to switch.

## Where the logo lives

Sources and previews, `docs/brand/`:

| file | what it is |
| --- | --- |
| `beam-mark.svg` | the mark alone, 512 box, transparent |
| `beam-icon.svg` | full-bleed square app icon: hue background + mark at 80% (source of launcher / PWA icons) |
| `beam-mono.svg` | one colour, `currentColor` (defaults to `#f3f4f8`) |
| `beam-lockup.svg` | mark + drawn "Aurora" wordmark, horizontal, transparent, for dark backgrounds |
| `beam-tv-banner.svg` / `.png` | 320x180 Android TV banner on the hue background |
| `beam-512.png`, `-64.png`, `-32.png` | previews of the icon |
| `beam-background-options.png` | the background comparison sheet, the pick marked |
| `overview.png`, `curtain-*`, `horizon-*` | the original three proposals, kept for the record |

Installed - every file below is written by `build.py install`, at a fixed size:

| where | file(s) | size | what |
| --- | --- | --- | --- |
| web | `public/icon-180.png`, `icon-192.png`, `icon-512.png` | 180 / 192 / 512 | full-bleed icon. The manifest declares both as `any maskable`; the mark is at 80%, inside the maskable safe circle |
| web | `public/badge-96.png` | 96 | white mark on transparent - the notification badge (`badge:` in `public/sw.js`) |
| web | `public/index.html` | - | favicon: an inline `data:` SVG, the rounded hue tile with the mark |
| web | `public/css/components.css` `.nav-logo .logo-mark` | 26 px | the bare mark as a `data:` SVG background, with a soft violet `drop-shadow`. Glass and phone navs only style the container, so one rule covers them |
| web | `public/admin.html` `.brand .logo-mark`, `.gate .logo-mark` | 30 / 46 px | the same `data:` SVG |
| web | `public/browser.html` `.start .logo-mark` | 60 px | the same `data:` SVG |
| TV | `res/mipmap-{mdpi..xxxhdpi}/ic_launcher.png` | 48 / 72 / 96 / 144 / 192 | legacy icon, rounded square |
| TV | `res/mipmap-*/ic_launcher_round.png` | same | legacy icon, circle |
| TV | `res/mipmap-*/ic_launcher_background.png` | 108 / 162 / 216 / 324 / 432 | adaptive layer: the hue background, the blooms hung off the corners of the visible middle 72dp |
| TV | `res/mipmap-*/ic_launcher_foreground.png` | same | adaptive layer: the mark alone at 53% of the layer - inside the 66dp safe circle |
| TV | `res/drawable/banner.png` | 320x180 | mark + wordmark on the hue background: the tile in the TV's apps row |
| TV | `tv-native/src/assets/logo-mark.png` | 208 | the nav-rail mark: the rounded hue **tile** (not the bare mark), because `NavRail.tsx` `styles.mark` draws it at 26dp with `borderRadius` 8 and a violet `boxShadow`, and a glow around a transparent square would be a hollow halo |

(`res` = `tv-native/android/app/src/main/res`.)

The `data:` URIs in the four web files are rewritten in place by the install: the favicon
`<link rel="icon">`, and every CSS declaration that ends with the comment `/* brand:mark */`.
Keep that comment on the line and do not hand-edit the URI.

Not changed, on purpose:

- `public/manifest.webmanifest` - same paths, same sizes, `any maskable` still true.
- `res/mipmap-anydpi-v26/ic_launcher.xml`, `ic_launcher_round.xml` - same layer names. Still
  no `<monochrome>` layer: themed icons do not exist on Android TV, and adding one needs new
  drawables. `beam-mono.svg` is the source if it is ever wanted.
- `AndroidManifest.xml` - `android:icon`, `android:roundIcon`, `android:banner` keep pointing
  at the same resource names.
- `tv-native/src/assets/logo.png` (96 px, the old gradient square) - no longer imported
  anywhere; safe to delete.

## Regenerating

```
python docs/brand/tools/build.py            # docs/brand only: SVGs, previews, overview.png, beam-background-options.png
python docs/brand/tools/build.py install    # the Beam files in docs/brand, then every installed asset in the table above
```

Needs Python with Pillow, and Chrome or Edge. Nothing is redrawn by hand: every PNG is the
SVG itself, rasterised by headless Chrome at 1024 px (banner at 1280x720) and
Lanczos-downscaled. The install prints each file with its size and asserts the pixel
dimensions; it does not build the app, bump a version or touch git.

`tv-native/tools/gen_icons.py` and `gen_logo.py` drew the old logo and are **retired** (they
exit with a pointer here), so nothing can overwrite Beam with the gradient square.

After an install that changes the TV files, the usual release steps still apply:

- bump `versionCode` in `tv-native/android/app/build.gradle` - the launcher caches the icon
  per versionCode, so a reinstall at the same code keeps showing the old one;
- the TV home-screen row logo (`storeLogo()` in `HomeScreenRows.kt`) is drawn from the app
  icon once per run - check on the TV that it refreshed;
- `public/sw.js` refreshes its shell cache when the app version moves, so installed phones pick
  the new icons and `badge-96.png` up with the next release, not before.

## Colours

| role | value | from |
| --- | --- | --- |
| page navy (tile base) | `#0b0c14` | `--bg` in `public/css/tokens.css` |
| violet bloom | `#8b7bff` to `#6856e2` to transparent | `--accent`, brief |
| green bloom | `#8cffbe` to `#46c896` to transparent | brief |
| green band | `#46c896` to `#8cffbe` | brief |
| cyan band | `#5fc4d8` to `#9be4f2` | around `--kind-series` `#7fd1e8` |
| violet band | `#6856e2` to `#8b7bff` | brief, `--accent` |
| wordmark / mono | `#f3f4f8` | `--text` |

On light backgrounds use the mono mark in `#0b0c14`, or the tile; the mint and cyan do not
hold on white. The wordmark is not a font: six monoline letters built from straight lines
and circular arcs (x-height 100, cap height 142, stroke 14 units), so it renders identically
everywhere.

## Known limits

- Below about 32 px the three bands merge and only the coloured arrow is left.
- Under a circular mask (round launcher icon, maskable PWA icon) the corners are cut, so
  less of the two blooms shows than on the square tile.
- The mark relies on a clip path; an Android vector drawable of it needs a `<clip-path>` group.

## The proposals that were not chosen

- **Curtain** - two hanging blades of light leaning into an "A". The strongest pure mark
  (works in one colour, at 16 px), but a monogram: it says "A", not "films and shows".
- **Horizon** - the aurora seen from orbit inside the rounded tile. The prettiest picture,
  the weakest identity; its one-colour version loses the idea.

Their SVGs and previews stay in this folder and still build with `build.py`.

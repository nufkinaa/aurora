# The TV's glass

The website's glass (docs/glass-apple.md, §8 is the recipe) on the TV app, on
the real Mi TV. Branch `glass-tv`, from `ui-tv` a59c1b43 (that commit is the
"before" in every picture and number here).

The look, in one line: a dark neutral pane, white words that read whatever is
behind, a rim of light, a quiet sheen in its upper half, a soft shadow, and the
chosen item in a darker well with its word in the accent mixed with white. The
tvOS tab bar, in the TV app's own shapes.

All of it lives in `tv-native/src/glass.ts` (the values) and
`tv-native/src/components/GlassEdge.tsx` (the edge of a pane). Pictures of
every surface, before and after: `docs/qa/glass-tv/jury/`. Measured contrast:
`docs/qa/glass-tv/contrast.md`.

## 1. The values

| what | value |
|---|---|
| body | `rgb(40,40,46)`, opaque |
| body of a pane that opens on another pane (the genre menu) | `rgb(52,52,58)` |
| sheen | white 5 % at the top to 0 at 48 % of the pane's height (a toast: 7 % to 0 at 60 %) |
| rim of a menu, a sheet, a toast | top line white 36 %, foot line white 16 %, sides white 7.5 %, 1 dp |
| light inside that rim | top white 22 % to 0 over 15 dp, sides 7 % over 12 dp, foot 10 % over 13 dp |
| rim of the chrome (rail, filter pane) | top line white 28 %, foot line white 12 %, sides white 5.5 % |
| light inside that rim | top white 18 % to 0 over 9 dp, foot 8 % over 8 dp |
| shadow | `0 14 34` black 34 %, `0 3 8` black 22 %, `0 1 2` black 22 %, a dark hairline `0 0 0 0.5` black 30 % |
| chosen | a well: black 40 %, a 2 dp black 40 % line on top, a white 9 % line at the foot; the word and icon `#B9B0FF` |
| words | `#FFFFFF`; second voice `#D0D5E2`; third voice `#B2B8CA` |

Two things differ from the website's recipe, both because a TV panel has no
blur behind it:

- **Every pane is opaque.** The recipe's "without a blur" body is 94 %. On the
  Mi TV a sheet at 94 % over its wash showed the title page's own words as
  sharp ghost letters inside the sheet. The old rail had the same problem at
  97 %. So the glass on the TV is in the rim, the sheen and the shadow.
- **Nothing is blurred while it is drawn.** The shadow and the light inside the
  rim are still pictures (section 4).

## 2. What changed, surface by surface

| surface | before | after | file |
|---|---|---|---|
| Nav rail, open | flat near-black slab from the screen's edge, violet and green glows drifting in it, a 48 dp feather into the page; chosen = a lighter pill, white word | a floating capsule (corner 38) with the rim, the sheen and the shadow; chosen = a well, word and icon `#B9B0FF`; nothing in it moves | `components/NavRail.tsx`, `AuroraRailPanelView.kt`, `assets/glass-pane-edge*.png` |
| Browse's filter pane | flat near-black slab to the screen's edge, one hairline on its left | a floating pane (corner 28), same material; its chosen chip in a well; kicker `#B9B0FF`; labels in the third voice | `screens/Browse.tsx`, `components/Chip.tsx` (`glass` prop), `assets/glass-pane-edge-wide*.png` |
| Genre menu (the popup on the filter pane) | raised navy, one line, a 60 dp blurred shadow; grey rows, the set one white | the raised body, menu rim, sheen, edge pictures; white rows, the set one `#B9B0FF` bold (white while focus is on it) | `components/Picker.tsx` (`glass` prop) |
| Sheets (title peek, "What's wrong with this copy?", Versions, Recommend, Get another version, Pick together, update popup) | blue-black at 97 %, one bright top line, an 80 dp blurred shadow | the body, menu rim, sheen, edge pictures (corner 22); kicker `#B9B0FF`; second lines `#D0D5E2` | `components/Sheet.tsx`, `Overlays.tsx`, `RecommendSheet.tsx`, `ReplaceSheet.tsx`, `screens/GroupPick.tsx` |
| Player menus (subtitles, audio and more, speed, quality) | navy with a violet and green tint, grey rows, the set one white | the body, menu rim, sheen, edge pictures (corner 18); white rows, the set one and its tick `#B9B0FF`; headers and tags in the third voice | `playback/Player.tsx` (TV only) |
| X-Ray sheet, a person's page | navy with the same tint, a 70 dp blurred shadow | the body, menu rim without a foot line, sheen, edge pictures (corner 24); labels in the third voice | `components/Overlays.tsx`, `components/PersonSheet.tsx` |
| Toast | the sheet's old slab with its 80 dp blurred shadow; the "✓" near-black | the body, menu rim, the small sheen, a dark hairline; the "✓" white | `components/Overlays.tsx` |

The focus cue is untouched everywhere: the white fill with dark words and the
white ring. The well is only ever "chosen". Where focus lands on the chosen
item the well is not drawn at all, so focus looks exactly as it did.

### Left as it was

Nothing was changed on these, on purpose. Some of them are in the jury kit as
controls (both pictures should match).

- Home, the hero and its brightness, the rows, the posters and their badges.
- The player's own chrome: buttons, scrubber, the up-next card.
- The title page's round buttons, Settings' rows and genre chips, Search.
- Every chip on the bare page (AI, My List, Calendar, Household, Search,
  Franchise, Pick together). A well there is black on near-black: the chosen
  pill all but disappeared (photographed on the AI page), so it went back to
  the white pill. The well is only for chips that sit on glass.
- My List's two pickers (they sit on the bare page): the button as it was. The
  menu they open is the glass menu.
- The collapsed rail strip, the sign-in panel, the update card with the accent
  (it keeps its violet glow).

## 3. Frames, on the Mi TV

Two rules learned the hard way:

1. **Two starts of the same build differ by about a tenth** (the frame a menu
   opens on: 132 to 169 ms for one and the same build). Numbers from different
   starts of the app can only show big steps.
2. So the numbers that decide are from **one start of the app**: a test build
   that switches between looks by the clock while a script opens and closes
   the same menu 120 times (branch `glass-tv-exp`, not for merging).

### 3.1 The player's menu, inside one start (this decides)

Subtitles menu, film paused, 120 openings shared between four looks.

Test E4 (commit 947ea9ab, versionCode 244):

| look | openings | the frame it opens on (median; quartiles) | frames drawn per opening | late frames per opening | frame after, p50 / p90 | closing, p50 |
|---|---|---|---|---|---|---|
| old look (the base) | 34 | 135.6 ms (124 to 153) | 44.7 | 0.47 | 17.4 / 38.7 ms | 10.0 ms |
| glass, no edge | 28 | 131.0 ms (126 to 139) | 44.5 | 0.43 | 18.4 / 42.5 ms | 9.6 ms |
| glass, edge as eight `<Image>`s | 28 | 152.0 ms (145 to 164) | 44.8 | 0.64 | 17.7 / 41.7 ms | 11.0 ms |
| **glass, edge as one native view (what ships)** | 30 | **133.9 ms** (127 to 159) | 44.6 | 0.57 | 17.6 / 40.8 ms | 9.7 ms |

Test E3 (commit 34fac2d4, versionCode 243), the same without the eight-picture look:

| look | openings | the frame it opens on | frames per opening | late per opening | frame after, p50 / p90 |
|---|---|---|---|---|---|
| old look (the base) | 35 | 132.1 ms (125 to 144) | 44.4 | 0.51 | 17.6 / 42.9 ms |
| old look + the native edge | 32 | 135.0 ms | 44.4 | 0.44 | 17.6 ms |
| glass, no edge | 26 | 130.2 ms | 44.7 | 0.54 | 17.3 ms |
| **glass + the native edge (what ships)** | 27 | **135.0 ms** (128 to 146) | 44.3 | 0.41 | 18.0 / 43.8 ms |

Read: the glass as shipped opens its menu in the same time as the old look
(134 to 135 ms against 132 to 136 ms), draws as many frames and misses as few.
The eight-`<Image>` edge cost about 18 ms on the opening frame; that is why
the edge is one native view.

### 3.2 The player's menu, separate starts (big steps only)

Six times open and close, four runs each, medians.

| build | frames | late % | p50 | p90 | p95 | p99 |
|---|---|---|---|---|---|---|
| base (vc236) | 370.5 | 2.3 | 15 ms | 30 | 32.5 | 150 |
| three blurred shadows + five gradients (vc234) | 354 | 6.5 | 23 | 38 | 65 | 150 |
| shadow as pictures + five gradients (vc235) | 362 | 5.0 | 20 | 37 | 53 | 150 |
| pictures + one gradient (vc237) | 370.5 | 3.1 | 16.5 | 30.5 | 34 | 150 |
| one gradient, no pictures (vc238) | 372 | 2.8 | 15.5 | 31 | 34 | 150 |
| base again (vc240) | 371.5 | 2.2 | 13 | 27.5 | 34 | 133 |
| batch 5, the native edge (vc241) | 371.5 | 3.0 | 16.5 | 31.5 | 34 | 150 |
| batch 6 (vc242) | 371 | 2.7 | 16.5 | 29.5 | 34 | 150 |

The first three lines are the lesson: the box draws a blurred `boxShadow` and
every CSS gradient again on each frame while a pane is up. The small gap that
is left between the base and the last lines is inside what two starts of one
build differ by; section 3.1 is the fair comparison and shows none.

### 3.3 Home

`tools/tv-bench/tv-bench.sh`, medians. Base = vc236, new = vc239 (the rail and
Home code have not changed since).

| scenario | build | frames | late % | p50 | p90 | p95 | p99 |
|---|---|---|---|---|---|---|---|
| S2: down 8 rows, up 8 rows | base | 516 | 3.2 | 19 ms | 31 | 38 | 65 |
| | new | 520 | 3.1 | 20 | 32 | 36 | 65 |
| S1: along a row, 20 right, 20 left | base | 449 | 3.3 | 27 | 30 | 38 | 61 |
| | new | 265 | 5.2 | 26 | 34 | 42 | 65 |
| S4: the rail, open and close five times | base | 422 | 3.1 | 30 | 40 | 53 | 97 |
| | new | 270 | 9.6 | 32 | 46 | 53 | 105 |

- **S2 (scrolling Home): the same.** Nothing was added to Home's rows.
- **S1:** the count of late frames is the same (about 14 a run in both). The
  base drew about 184 more frames a run, and those were the old rail's two
  drifting glows: cheap frames that made the share look smaller. The new rail
  draws nothing when nothing moves.
- **S4 (the rail): this one is not equal, and it is said plainly.** Late
  frames per run went from about 13 to about 26. Frames late by more than
  3 ms: 2.3 per open-and-close before, 2.5 now. The extra ones are barely
  late and come just after the rail closes: the GPU has gone idle and wakes
  up. The old rail did not show it only because its glows kept the screen
  drawing about 150 more frames a run. p95 is the same (53 ms), p99 97 against
  105 ms. These are separate starts of the app, so the 13 against 26 carries
  that noise too. To the eye the slide is the same. If this is not acceptable
  the way back is cheap: the pane is one view and one picture.

## 4. What was tried and dropped

| tried | what happened | what it is now |
|---|---|---|
| the recipe's body at 94 % | the page's words stood readable inside sheets and the rail (Mi TV) | every pane opaque |
| keeping the violet and green hue in the rail and the player menus (elia asked for the hue on 2026-10-07) | the recipe is a neutral pane; white words read the same over all of it, and the rail's glows drew frames all the time | neutral glass. The jury should weigh this one: it removes something elia once asked for |
| the genre menu on the same body as the filter pane under it | the two ran into each other | a raised body, `rgb(52,52,58)` |
| a 38 corner on the filter pane, like the rail | the kicker sat against the curve | corner 28 |
| the chrome's thin rim on menus and sheets | the pane did not stand out from the page | the brighter menu rim and its thicker glow |
| the shadow as a blurred `boxShadow` (three layers) | 15 to 23 ms a frame, 2.3 to 6.5 % late (3.2) | pictures |
| five gradient layers for the light inside the rim | 20 ms, 5.0 % late | the light baked into the edge pictures, one gradient left (the sheen) |
| the rail's and the filter pane's rim as a border plus gradients | drawn again on each frame of the slide | one baked picture over a plain round box |
| X-Ray's 70 dp blurred shadow | blurred again on each frame as the sheet rises | edge pictures |
| the edge as eight `<Image>`s | +18 ms on the frame a menu opens on (3.1) | one native view that draws the same eight pictures (`AuroraGlassEdgeView.kt`) |
| the well for every chosen chip | on the bare page the chosen pill all but disappeared | the well only on glass (`glass` prop); elsewhere the white pill as before |
| the set row's lilac word while focus is on it (genre menu) | 4.0:1 on the focused row | white under focus, bold still marks it |
| the glass's voice on My List's pickers | they sit on the bare page, not on glass | as they were |
| the update card with the accent | it has its own violet glow | left alone |

The old panel drawing in `AuroraRailPanelView.kt` (`drawPanel`, `drawHues`,
`startHues`) is no longer called. It stays in the file until the look is
settled, then it can go.

## 5. Shared with the phone

- `playback/Player.tsx` is used by the phone too. Every change in it is behind
  the existing `const PHONE = isPhone()`: the phone keeps its navy menu and its
  colours, and does not mount the edge.
- Nothing under `tv-native/src/phone` was touched, and it imports none of the
  changed components.
- One new native view pair (`AuroraGlassEdgeView` / `Manager`) is registered in
  `AuroraUiPackage.kt`, in the Android project both apps build from. Only TV
  components mount it.
- For the phone lane to mirror when it moves to the glass: the values in
  `glass.ts`; opaque panes where there is no blur; no blurred shadow or gradient
  stack on anything that moves; the well only on glass.

## 6. How the pictures were made

`tools/gen_glass_edge.py` (PIL) writes the edge pictures from the same numbers
as `glass.ts`: eight pieces for a pane of any size (corners for radius 14, 18,
22, 24 and three runs), and one whole picture each for the rail and the filter
pane. Run it again after changing a value there.

## 7. The jury's pictures

`docs/qa/glass-tv/jury`: twenty scenes, each shot on the Mi TV before and after
(`scenes.md` says what each shows; `key.json` says which letter is the new
look). The measured contrast of every changed pair is in
`docs/qa/glass-tv/contrast.md`.

Which build each picture came from:

- every BEFORE picture: `ui-tv` a59c1b43;
- AFTER 01-11, 13, 14, 16, 17, 18: 9f87b1db;
- AFTER 15, 19, 20: 85d45057 (the chosen chip on the bare page back to its
  white pill);
- AFTER 12: 4ebfb2de, the last commit (the genre menu's set word white under
  focus).

The earlier pictures still stand for the last build. Shot again and compared
pixel by pixel: the filter pane (19) and the rail over Movies (17) on 85d45057
are identical to 9f87b1db; the filter pane on 4ebfb2de is identical again; the
genre menu on 4ebfb2de differs from 85d45057 only inside the set word's box.
The two later commits touch `Chip.tsx`, `Picker.tsx` and `Browse.tsx` only.

In scenes 09, 14, 15, 16 and 20 nothing was changed on purpose, and the two
pictures are identical byte for byte.

The pictures are full size (1920x1080), saved as 256-colour PNGs with Python
PIL to stay under 600 KB each (`sharp` is not in the repo); both pictures of a
scene went through the same steps. A screencap does not hold the film, so the
player scenes show flat dark grey behind the menus.

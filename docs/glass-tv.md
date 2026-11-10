# The TV's glass

The website's glass (docs/glass-apple.md, §8 is the recipe) on the TV app, on
the real Mi TV. Branch `glass-tv`, from `ui-tv` a59c1b43 (that commit is the
"before" in every picture and number here).

The look, in one line: a dark neutral pane, white words that read whatever is
behind, a rim of light, a quiet sheen in its upper half, a soft shadow, and the
chosen item in a darker well (in the rail its word full white and heavier; a
chosen chip's word in the accent mixed with white). The tvOS tab bar, in the TV
app's own shapes.

All of it lives in `tv-native/src/glass.ts` (the values) and
`tv-native/src/components/GlassEdge.tsx` (the edge of a pane). Pictures of
every surface, before and after: `docs/qa/glass-tv/jury/`. Measured contrast:
`docs/qa/glass-tv/contrast.md`.

Section 8 is the follow-up round of 2026-11-10: four faults both judges named
in this look, mended. Where it changed something said in sections 1 to 3 the
line says so.

## 1. The values

| what | value |
|---|---|
| body | `rgb(40,40,46)`, opaque |
| body of a pane that opens on another pane (the genre menu) | `rgb(52,52,58)` |
| sheen | white 5 % at the top to 0 at 48 % of the pane's height (a toast: 7 % to 0 at 60 %) |
| rim of a menu, a sheet, a toast | top line white 36 %, foot line white 16 %, sides white 7.5 %, 1 dp |
| light inside that rim | top white 22 % to 0 over 15 dp, sides 7 % over 12 dp, foot 10 % over 13 dp |
| rim of the chrome (rail, filter pane) | top line white 28 %, sides white 5.5 % (no foot: since section 8 these two panes run to the screen's foot) |
| light inside that rim | top white 18 % to 0 over 9 dp |
| shadow | `0 14 34` black 34 %, `0 3 8` black 22 %, `0 1 2` black 22 %, a dark hairline `0 0 0 0.5` black 30 % |
| chosen | a well: black 40 %, a 2 dp black 40 % line on top, a white 9 % line at the foot; the word and icon `#B9B0FF` on a chip, `#FFFFFF` at weight 800 in the rail (section 8) |
| words | `#FFFFFF`; second voice `#D0D5E2`; third voice `#B2B8CA` |
| words on a focused player-menu row (white fill, section 8) | `#0B0C14`; second line and tag `#454A5C`; a row that cannot be chosen `#62677A`; the star `#7A5C00` |

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
- **S4 (the rail): this one is not equal, and it is said plainly.** (Measured
  again after the follow-up, section 8.3: 26 before it, 27 after it.) Late
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

## 8. The follow-up: four faults both judges named (2026-11-10)

Commit 90f03315, versionCode 248 on the Mi TV. "Before" here is the glass the
first jury saw (versionCode 247). Pictures: `docs/qa/glass-tv/followup/`
(twelve scenes, two of them controls; `scenes.md`, `key.json`).

### 8.1 What changed

| fault | what it was | what it is now | files |
|---|---|---|---|
| 1. The chosen section in the rail read as switched off | its word and icon `#B9B0FF` in the well: 8.9:1, yet dimmer to the eye than the resting white labels | `ink.chosen` `#FFFFFF` at `CHOSEN_WEIGHT` 800 (a resting label is 600), the well as it was. Resting = white 600 on the pane; chosen = white 800 in the dark well; focused = dark words on the white fill | `glass.ts`, `components/NavRail.tsx` |
| 2. The page showed under the foot of the rail and of Browse's filter pane | the panes floated 11 dp above the screen's foot with round foot corners; the next row's cards showed there | the panes run to the screen's foot: `bottom: 0`, only the top corners round (38 and 28). The edge picture is baked for a taller pane and cut where the screen ends (529 and 536 dp of pane; `FOOT_OFF` 160 in the script), so the sides, their line and the shadow run to the cut. No new layer: the same one box and one picture | `components/NavRail.tsx`, `screens/Browse.tsx`, `tools/gen_glass_edge.py`, `assets/glass-pane-edge*.png` |
| 3. A square dark box behind the focused Play button and the focused face on the grey sheets | the focus ring's drop shadow, cut square by the sheet's scroll boxes | no drop shadow under a focus ring inside an opaque sheet: `FlatFocus` (a React context, `components/Focusable.tsx`) is set by `Sheet.tsx`, the X-Ray sheet and a person's page; a Focusable under it asks for `NO_SHADOW` (`0 0 0 rgba(0,0,0,0)`), and the native view reads a fully transparent shadow colour as "none". The ring itself is as it was | `components/Focusable.tsx`, `AuroraFocusableView.kt`, `components/Sheet.tsx`, `components/Overlays.tsx`, `components/PersonSheet.tsx`, `glass.ts` |
| 4. Focus in the player's menus was a slightly lighter grey pill | fill `colors.surfaceHover`, 1.4:1 against the menu; the set row's lilac word on it 5.3:1 | the white fill with dark words, as on the rail: `highlightColor` white, the row's word, tick and icon `inkOnWhite.text`, second line and tag `.second`, a row that cannot be chosen `.dim`, the star `.star`. The three subtitle-timing buttons the same. TV only | `playback/Player.tsx` (behind `PHONE`), `glass.ts` |

Left alone on purpose: the filter pane's chosen chip keeps `#B9B0FF` (the
judges named the rail); the genre menu and the rail keep the ring's shadow
(they are not sheets, and no box showed there); the party's reaction buttons
keep their ring.

With the panes on the screen's foot, 27 dp of the rail's pane is now under the
profile pill where 16 dp were; nothing in the pane moved.

### 8.2 Contrast, measured on the Mi TV's screencaps

| pair | before | after |
|---|---|---|
| the rail's chosen word in its well ("Movies") | 8.86 | 17.36 |
| the same, "Settings" | 9.03 | 17.70 |
| a resting rail word (unchanged) | 14.14 | 14.14 |
| the focused rail item (unchanged) | 19.50 | 19.50 |
| a player menu's focused row against the menu round it | 1.42 | 14.65 |
| the set row's word, with focus on it | 5.26 | 19.50 |
| another row's word, with focus on it | 10.31 | 19.50 |
| the focused row's second line | 5.20 | 8.80 |
| the focused set row's tick | (lilac on grey) | 19.50 |
| the focused set row's star | (gold on grey) | 6.25 |
| a row that cannot be chosen, with focus on it: its word | 3.69 | 5.61 |
| its note and its tag "Not here" | 4.81 | 8.80 |

The one pair that was under 4.5 after the first round (3.69) now passes.

### 8.3 Frames: the rail, open and close five times (S4)

`tools/tv-bench/tv-bench.sh` S4, a cold start for every run, the same evening
on the same TV. Late frames per run = frames drawn x the late share.

| build | runs | late frames per run | median | mean | frames per run (mean) | late share (mean) | p50 / p90 / p95 / p99 |
|---|---|---|---|---|---|---|---|
| the old look (section 3.3) | | about 13 | | | 422 | 3.1 % | 30 / 40 / 53 / 97 ms |
| glass before the follow-up (vc247) | 10 | 27, 26, 25, 26, 26, 25, 27, 25, 27, 24 | 26 | 25.8 | 264 | 9.78 % | 32 / 48 / 53 / 113 |
| glass after the follow-up (vc248) | 10 | 24, 24, 28, 29, 27, 24, 24, 31, 28, 28 | 27.5 | 26.7 | 274 | 9.77 % | 32 / 48 / 53 / 109 |

Read: 26 against 27 late frames a run, and the same share of late frames
(9.78 % against 9.77 %); the new build drew about ten more frames a run. One
run more or less is far inside what two starts differ by (about 15 %). The
taller pane costs nothing that this test can see: it is 11 dp more of the same
opaque box and the same picture, and nothing new is drawn.

### 8.4 The phone

- `Player.tsx`: every line of fix 4 is behind `PHONE`; the phone's menu rows
  keep `colors.surfaceHover` and their colours.
- `FlatFocus` is never set on the phone (it has its own sheets), and
  `JsFocusable`, the only Focusable the phone uses, also checks `!isPhone()`.
- `AuroraFocusableView.kt` is in the Android project both apps build from; the
  new branch runs only when a shadow colour with alpha 0 is handed to it, which
  nothing but `FlatFocus` does.
- Nothing under `tv-native/src/phone` was touched.

### 8.5 The pictures

`docs/qa/glass-tv/followup`: every BEFORE picture is versionCode 247 (the build
the first jury's winner was merged into), every AFTER picture versionCode 248
(90f03315). Scenes 09 (the Movies grid) and 10 (the Settings page) are
controls: the two screencaps are identical pixel for pixel. In the player
scenes the film is paused at 2:59 in one picture and 3:06 in the other, and in
the title sheet the "watched" line moved from 1 % to 2 %: the film had to be
played between the two sets.

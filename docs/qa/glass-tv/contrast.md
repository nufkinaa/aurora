# TV glass: measured contrast

Every pair of words and ground that the glass changed, measured from real
screencaps of the Mi TV (1920x1080), before (`ui-tv` a59c1b43) and after
(`glass-tv`). The pictures are the jury kit's scenes; the scene number is in each
heading.

## How it was measured

A box is drawn tight round one piece of text on one surface. In that box:

- **ink** = the colour the letters reach: the middle of the 3 % of pixels
  furthest in brightness from the box's main colour (the cores of the strokes,
  not their soft edges).
- **ground** = the WORST ground under those words: for light words the
  lightest ground in the box (97th percentile), for dark words the darkest.
  Only pixels with no letter within two pixels count as ground.
- **ratio** = the WCAG contrast of the two.

So each number is the worst case inside its box, on the picture the TV really
drew (sheen, rim light and focus fill included). A screencap does not hold the
film itself (the video plane is separate), so in the player scenes the menu is
measured over the flat grey the screencap shows; the panes are opaque, so what
is behind them does not change the numbers.

The rule: body text at least 4.5:1, large titles at least 3:1, and nothing
worse than before where before was already under.

## Summary

- 102 pairs measured. Under 4.5:1 before: 13. Under 4.5:1 after: 3.
- No pair is under 4.5:1 and worse than before.
- The 3 still under 4.5:1 were all under before and are all better now:
  - an unavailable row's title, with focus on it, scene 08: 2.17 to 3.69.
  - label "CAST" (inside the scroll's fading edge), scene 10: 1.81 to 3.47.
  - a role, lowest row (inside the scroll's fading edge), scene 10: 1.95 to 3.57.
  The two X-Ray ones sit inside the scroll's fading edge (the list fades its
  top and foot 36 dp into the pane, before and after alike); out of the fade
  the same labels are 7.40. The third is the title of a row that cannot be
  chosen, while focus is on it.
- The lowest numbers that pass: 4.72 (an unavailable row's title, scene 08); 4.81 (a row's second line, scene 08); 4.81 (tag "Not here", scene 08); 5.20 (the set row's second line, scene 07). The first is on a row that cannot be chosen (it is drawn dimmed); the others are on the row that has focus, where the focus fill lightens the ground.
- Where a number went down it is still far over the rule: white on the old
  blue-black body was 16.5:1, white on the glass body is 12 to 14.7:1 (the body
  is lighter, and the sheen and the rim light lighten its top).
- The pair that fell furthest is the set row of a player menu while focus is
  on it: 12.20 to 5.26. The set word is now the lilac, and the focus fill
  lightens the ground under it. It passes. In the genre menu the same pair
  measured 3.96 on the first try (the raised body is lighter), so there the
  set word turns white under focus: 7.76.

## The nav rail (scenes 01, 02, 03, 04, 13, 17)

The worst of the six scenes for each label. Over the old rail the tint
(violet on top, green at the foot) lightened the ground behind the lower labels;
the glass is the same all the way down.

| words | before, worst | after, worst | |
|---|---|---|---|
| "Home", resting (4 scenes) | 10.08 | 13.57 | passes |
| "Movies", resting (4 scenes) | 12.27 | 14.07 | passes |
| "Shows", resting (6 scenes) | 14.76 | 14.34 | passes |
| "My List", resting (5 scenes) | 15.94 | 14.65 | passes |
| "AI", resting (6 scenes) | 14.44 | 14.53 | passes |
| "Calendar", resting (5 scenes) | 11.20 | 14.65 | passes |
| "Settings", resting (4 scenes) | 8.77 | 14.65 | passes |
| "Claude QA", resting (6 scenes) | 6.83 | 11.10 | passes |
| the chosen section's word: white on a lighter pill before, `#B9B0FF` in the well after (4 readings) | 7.43 | 8.86 | passes |
| the focused item: dark words on the white fill, unchanged (4 readings) | 19.50 | 19.50 | passes |

## Title peek sheet over Home (scene 05)

| words | before: ink on ground | ratio | after: ink on ground | ratio | |
|---|---|---|---|---|---|
| title | `#F3F4F8` on `#131522` | 16.50 | `#F3F4F8` on `#303036` | 11.93 | passes |
| year and length line | `#9AA1B5` on `#121421` | 7.09 | `#D0D5E2` on `#2E2E34` | 9.19 | passes |
| "1% watched" line (accent) | `#8B7BFF` on `#131522` | 5.50 | `#B9B0FF` on `#2D2D33` | 6.98 | passes |
| description | `#9AA1B5` on `#121422` | 7.08 | `#D0D5E2` on `#2B2B31` | 9.58 | passes |
| button "Details" | `#F3F4F8` on `#31323C` | 11.57 | `#F3F4F8` on `#424247` | 9.09 | passes |
| button "My List" | `#F3F4F8` on `#31323E` | 11.54 | `#F3F4F8` on `#424247` | 9.09 | passes |
| button "Recommend" | `#F3F4F8` on `#31323E` | 11.54 | `#F3F4F8` on `#424247` | 9.09 | passes |
| row "Remove from Continue Watching" | `#F3F4F8` on `#31323E` | 11.54 | `#F3F4F8` on `#424247` | 9.09 | passes |

## Title peek sheet over white posters (scene 18, the stress scene)

| words | before: ink on ground | ratio | after: ink on ground | ratio | |
|---|---|---|---|---|---|
| title | `#F3F4F8` on `#141623` | 16.35 | `#F3F4F8` on `#303036` | 11.93 | passes |
| year and length line | `#9AA1B5` on `#141622` | 6.97 | `#D0D5E2` on `#2D2D33` | 9.32 | passes |
| description | `#9AA1B5` on `#141623` | 6.96 | `#D0D5E2` on `#2B2B31` | 9.58 | passes |
| button "Details" | `#F3F4F8` on `#31323E` | 11.54 | `#F3F4F8` on `#424247` | 9.09 | passes |
| button "Recommend" | `#F3F4F8` on `#31323E` | 11.54 | `#F3F4F8` on `#424247` | 9.09 | passes |

## "What's wrong with this copy?" sheet over a bright title page (scene 06)

| words | before: ink on ground | ratio | after: ink on ground | ratio | |
|---|---|---|---|---|---|
| kicker (accent) | `#8B7BFF` on `#121422` | 5.55 | `#B9B0FF` on `#313137` | 6.59 | passes |
| title | `#F3F4F8` on `#131522` | 16.50 | `#FFFFFF` on `#303036` | 13.11 | passes |
| body text | `#F3F4F8` on `#131522` | 16.50 | `#F3F4F8` on `#2E2E34` | 12.27 | passes |
| body text, second line | `#F3F4F8` on `#131522` | 16.50 | `#F3F4F8` on `#2D2D32` | 12.46 | passes |
| a row | `#F3F4F8` on `#262633` | 13.58 | `#F3F4F8` on `#39393E` | 10.45 | passes |
| the focused row | `#F3F4F8` on `#3E404A` | 9.38 | `#F3F4F8` on `#515155` | 7.19 | passes |

## Player: subtitles menu (scene 07)

| words | before: ink on ground | ratio | after: ink on ground | ratio | |
|---|---|---|---|---|---|
| header "SUBTITLES" | `#9AA1B5` on `#25204E` | 5.83 | `#B2B8CA` on `#323238` | 6.43 | passes |
| a row | `#9AA1B5` on `#1F1B3F` | 6.33 | `#FFFFFF` on `#2D2D33` | 13.68 | passes |
| the set row, with focus on it | `#F3F4F8` on `#2E2D40` | 12.20 | `#B9B0FF` on `#404045` | 5.26 | passes |
| the set row's second line | `#9AA1B5` on `#2C303B` | 5.11 | `#B2B8CA` on `#404045` | 5.20 | passes |
| a row lower down | `#9AA1B5` on `#121622` | 6.99 | `#FFFFFF` on `#28282E` | 14.65 | passes |

## Player: audio and more menu (scene 08)

| words | before: ink on ground | ratio | after: ink on ground | ratio | |
|---|---|---|---|---|---|
| header "AUDIO" | `#9AA1B5` on `#26204E` | 5.82 | `#B2B8CA` on `#323238` | 6.43 | passes |
| an unavailable row's title, with focus on it | `#6A6B87` on `#3A375A` | 2.17 | `#A2A2A5` on `#46464B` | 3.69 | under 4.5, better than before |
| an unavailable row's title | `#5B5C76` on `#1C1938` | 2.60 | `#949497` on `#2A2A30` | 4.72 | was under 4.5, now passes |
| a row's second line | `#9AA1B5` on `#383557` | 4.48 | `#B2B8CA` on `#45454A` | 4.81 | was under 4.5, now passes |
| tag "Not here" | `#616880` on `#2C303B` | 2.39 | `#B2B8CA` on `#45454A` | 4.81 | was under 4.5, now passes |
| row "Report a problem" | `#9AA1B5` on `#121522` | 7.04 | `#FFFFFF` on `#28282E` | 14.65 | passes |
| row "Get another version" | `#9AA1B5` on `#141C26` | 6.65 | `#B2B8CA` on `#28282E` | 7.40 | passes |

## X-Ray sheet (scene 10)

| words | before: ink on ground | ratio | after: ink on ground | ratio | |
|---|---|---|---|---|---|
| kicker "X-RAY" (accent) | `#8B7BFF` on `#25224E` | 4.50 | `#B9B0FF` on `#323238` | 6.50 | was under 4.5, now passes |
| title | `#F3F4F8` on `#24214C` | 13.68 | `#F3F4F8` on `#313137` | 11.76 | passes |
| facts line | `#9AA1B5` on `#222048` | 5.95 | `#D0D5E2` on `#2F2F35` | 9.06 | passes |
| crew line | `#9AA1B5` on `#211F45` | 6.04 | `#D0D5E2` on `#2E2E34` | 9.19 | passes |
| label "CAST" (inside the scroll's fading edge) | `#464967` on `#201E44` | 1.81 | `#7B7F8B` on `#2C2C32` | 3.47 | under 4.5, better than before |
| a name | `#F3F4F8` on `#17172F` | 15.92 | `#F3F4F8` on `#28282E` | 13.33 | passes |
| a role | `#616880` on `#15162C` | 3.21 | `#B2B8CA` on `#28282E` | 7.40 | was under 4.5, now passes |
| label "FILMMAKERS" | `#616880` on `#191935` | 3.09 | `#B2B8CA` on `#28282E` | 7.40 | was under 4.5, now passes |
| a name, lower row | `#F3F4F8` on `#101120` | 17.01 | `#F3F4F8` on `#28282E` | 13.33 | passes |
| a role, lowest row (inside the scroll's fading edge) | `#3F4458` on `#0F111E` | 1.95 | `#797D8A` on `#28282E` | 3.57 | under 4.5, better than before |
| hint "closes" | `#616880` on `#111B23` | 3.15 | `#B2B8CA` on `#313137` | 6.52 | was under 4.5, now passes |

## Toast (scene 11)

| words | before: ink on ground | ratio | after: ink on ground | ratio | |
|---|---|---|---|---|---|
| toast text | `#F3F4F8` on `#131522` | 16.50 | `#FFFFFF` on `#2F2F35` | 13.30 | passes |

## Genre menu on the filter pane (scene 12)

| words | before: ink on ground | ratio | after: ink on ground | ratio | |
|---|---|---|---|---|---|
| a row | `#9AA1B5` on `#131523` | 7.02 | `#FFFFFF` on `#39393E` | 11.48 | passes |
| a row lower down | `#9AA1B5` on `#131523` | 7.02 | `#FFFFFF` on `#34343A` | 12.37 | passes |
| the set row, with focus on it | `#F3F4F8` on `#2D2F3B` | 12.08 | `#FFFFFF` on `#525258` | 7.76 | passes |
| picker label "Genre" | `#51566A` on `#15161D` | 2.48 | `#AAB0C1` on `#343438` | 5.72 | was under 4.5, now passes |
| picker value | `#C1C2C5` on `#14151C` | 10.22 | `#E9E9ED` on `#343438` | 10.24 | passes |
| the set row, with focus on another row (after only) | | | `#B9B0FF` on `#3D3D43` | 5.50 | passes |

## Filter pane (scene 19)

| words | before: ink on ground | ratio | after: ink on ground | ratio | |
|---|---|---|---|---|---|
| kicker "MOVIES" (accent) | `#8B7BFF` on `#0A0B14` | 5.95 | `#B9B0FF` on `#323238` | 6.50 | passes |
| a chip ("Trending") | `#616880` on `#0A0B14` | 3.55 | `#B2B8CA` on `#2E2E34` | 6.81 | was under 4.5, now passes |
| a chip ("Downloaded") | `#616880` on `#0A0B14` | 3.55 | `#B2B8CA` on `#28282E` | 7.40 | was under 4.5, now passes |
| the chosen chip ("All") | `#0B0C14` on `#FFFFFF` | 19.50 | `#B9B0FF` on `#1D1D20` | 8.58 | passes |
| chip "Unwatched" | `#F3F4F8` on `#181922` | 15.91 | `#F3F4F8` on `#343439` | 11.26 | passes |
| button "Surprise me" | `#F3F4F8` on `#181922` | 15.91 | `#F3F4F8` on `#35353A` | 11.10 | passes |

## The follow-up of 2026-11-10

Four faults were mended after the first jury (docs/glass-tv.md, section 8).
These lines replace the ones above for the build after it (90f03315):

| pair | above | now |
|---|---|---|
| the rail's chosen word in its well | 8.86 | 17.36 (white, weight 800) |
| the set row of a player menu, with focus on it | 5.26 | 19.50 (dark on the white fill) |
| another row of a player menu, with focus on it | 10.31 on today's picture of versionCode 247 (the table above has 7.19 for its focused row) | 19.50 |
| the focused row's second line | 5.20 | 8.80 |
| an unavailable row's title, with focus on it | 3.69 | 5.61 |
| its second line and its tag "Not here" | 4.81 | 8.80 |
| the star on the focused set row | | 6.25 |

The focused row of a player menu against the menu round it: 1.42 before,
14.65 now.

## Not measured one by one

These use the same sheet and the same inks as the sheets above, so the same
numbers hold: a person's page, the Versions sheet, "Get another version", the
Recommend sheet (pressing inside it was off limits on the live server), "Pick
together" (the same), the update popup.

## Tools

Python with PIL, on the PNGs `adb screencap` gave. No picture was changed
before it was measured.

# The TV's glass, the second follow-up: the jury's scenes

Ten scenes. Each is two pictures of the same screen of the TV app, `NN-A.png`
and `NN-B.png`: one is the glass as the second jury saw it, the other the same
glass with four faults mended. Which letter is which changes from scene to
scene (it is in `key.json`; do not open it before you have judged).

The question for every scene: **which of the two looks better, and is anything
worse in it than in the other?** A fix ships only if both judges prefer it.

The four faults, as the second jury named them:

1. The foot of the rail and of Browse's filter pane. The page no longer showed
   under it, but the pane ran off the bottom of the screen: no round lower
   corners, no rim along the foot, not a closed floating shape any more. Wanted:
   the rounded foot with its lit rim, and no scraps of the page under it.
2. The star on the white focus pill was a muddy olive.
3. The set row, with focus on it, kept a black tick as its only sign of "set".
4. A focused row that cannot be chosen: its title was paler than its own note,
   and its white pill was as loud as on a row you can pick.

About the pictures:

- They are real: `adb screencap` on the Mi TV, 1920x1080, same screen, same
  focus, same content behind.
- Both pictures of a scene went through the same steps to fit under 600 KB:
  full size, saved as a 256-colour PNG (Python PIL; `sharp` is not in the repo).
  Fine grain in smooth dark areas comes from that and is the same in both.
- A screencap cannot see the film itself. In the player scenes (06, 07, 08) the
  film area is flat dark in both pictures; only a subtitle line shows.
- In the player scenes the film was paused one second apart for the two
  pictures (3:06 and 3:05), so the time and the subtitle line differ. Ignore
  those; judge the menu.
- In scenes 01 to 05 the two pictures are the same, pixel for pixel, above the
  lowest 94 px of the screen. Look at the foot.
- In scene 08 nothing in the menu was meant to change (the two differ only in
  the time and the subtitle line). In scenes 09 and 10 nothing was meant to
  change at all; say so if they are not the same.

| scene | what it shows | what to look at |
|---|---|---|
| 01 | The nav rail open over a bright yellow hero on Home. Focus on "Home", the chosen section. | The foot of the pane, under the profile pill, and its two lower corners. Is it a closed, floating shape with a rim along its foot? Does anything of the page show under it or round the corners? Where the dark under the foot meets the page beside the pane: a line, a band, or nothing you notice? |
| 02 | The rail open over Home's rows. Focus on "Home". | The same, with a row of cards running under the pane's foot and out to the right of it. Do the cards beside the foot end in a way that looks meant? |
| 03 | The rail over the Movies grid. Focus on "Movies", the chosen section. | The same, over posters. Is any sliver of a poster left under the foot? |
| 04 | Browse's filter pane over the Movies grid. Focus on the "Genre" button. | The foot of the pane (under "Surprise me") and its two lower corners, the left one over the posters. Closed shape, rim along the foot, nothing of the grid under it? |
| 05 | The rail over Settings. Focus on "Settings", the chosen section. | The same foot over a page of text ("My downloads" used to show half-cut here). |
| 06 | The player's subtitles menu. Focus on the row that is set ("English 5", with its tick, its star and its second line). | The star: a clean colour on white? Can it be read? Does the row still say "this one is set" while focus is on it, and how? Is the word still the easiest thing to read in the row? |
| 07 | The player's audio menu. Focus on a row that cannot be chosen ("Night mode", tagged "Not here"). | Is the title at least as strong as the note under it? Does the row say "you are here" and "you cannot pick this" together? Is its focus quieter than a focused row you can pick (scenes 06 and 08), and still easy to find? |
| 08 | The same subtitles menu with focus on the row under the set one ("English 6"). | Nothing in the menu was meant to change here. It shows the focus of a row you can pick, to hold scene 07 against. |
| 09 | The Movies grid, rail closed, focus on the first poster. | Nothing was meant to change here. |
| 10 | The Settings page, rail closed. | Nothing was meant to change here. |

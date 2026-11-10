# The TV's glass, the follow-up: the jury's scenes

Twelve scenes. Each is two pictures of the same screen of the TV app, `NN-A.png`
and `NN-B.png`: one is the glass as the first jury saw it, the other the same
glass with four faults mended. Which letter is which changes from scene to
scene (it is in `key.json`; do not open it before you have judged).

The question for every scene: **which of the two looks better, and is anything
worse in it than in the other?** A fix ships only if both judges prefer it.

The four faults, as the first jury named them:

1. The chosen section in the rail ("Home", "Movies", "Settings") read as dim or
   switched off beside the resting white labels.
2. The page showed under the foot of the floating panes (the rail, Browse's
   filter pane): card bottoms, a row's title, posters.
3. A square-cornered dark box stood behind the focused round button or face on
   the grey sheets.
4. Focus inside the player's menus was only a slightly lighter grey pill.

About the pictures:

- They are real: `adb screencap` on the Mi TV, 1920x1080, same screen, same
  focus, same content behind as far as the TV allowed.
- Both pictures of a scene went through the same steps to fit under 600 KB:
  full size, saved as a 256-colour PNG (Python PIL; `sharp` is not in the repo).
  Fine grain in smooth dark areas comes from that and is the same in both.
- A screencap cannot see the film itself. In the player scenes (08, 11, 12) the
  film area is flat dark in both pictures; only a subtitle line shows.
- In the player scenes the film was paused at a different second for the two
  pictures (2:59 and 3:06), so the time, the scrubber's dot and the subtitle
  line differ. Ignore those; judge the menu.
- In scene 06 the small "watched" line differs ("1% watched · 2h 2m left"
  against "2% watched · 2h 0m left"): the film was played between the two
  pictures. Ignore it.
- In scenes 09 and 10 nothing was meant to change. The two pictures should be
  the same; say so if they are not.

| scene | what it shows | what to look at |
|---|---|---|
| 01 | The nav rail open over a bright yellow hero on Home. Focus on search, "Home" is the chosen section. | "Home" in its dark well against the resting labels under it and the focused search above it: three different things at a glance? The foot of the pane, under the profile pill: does the page show there? |
| 02 | The rail open over Home's rows. Focus on "Movies", "Home" is chosen right above it. | Chosen right beside focused: is "Home" clearly lit, and is focus still the strongest thing? The foot of the pane and what is under it. |
| 03 | The rail over the Movies grid. "Movies" is chosen, focus on "My List". | Chosen against focused against resting. The foot of the pane over the posters. |
| 04 | Browse's filter pane over the Movies grid. Focus on the "Genre" button. | The foot of the pane (under "Surprise me") and its two lower corners: do posters show there? The pane's right edge down to the foot. |
| 05 | The rail over Settings. "Settings" is chosen, focus on "Calendar" right above it. | The same as 02, lower in the pane, with the profile pill right under the chosen item. The foot of the pane. |
| 06 | The title sheet ("About Time") over Home. Focus on "Play". | The area round the focused "Play" button, on the sheet's grey: is there a dark box behind it, and what shape? Is focus as easy to find? |
| 07 | The X-Ray sheet over a title page. Focus on the first face. | The area round the focused face card: the same question. |
| 08 | The player's subtitles menu. Focus on the row that is set ("English 5", with its tick, its star and its second line). | How fast do you find the focused row? Can its word, tick, star and second line all be read? Does the menu still say which row is set? |
| 09 | The Movies grid, rail closed, focus on the first poster. | Nothing was meant to change here. |
| 10 | The Settings page, rail closed. | Nothing was meant to change here. |
| 11 | The same subtitles menu with focus on the row under the set one ("English 6"). | Focused against set against resting rows: three different things at a glance? |
| 12 | The player's audio menu. Focus on a row that cannot be chosen ("Night mode", tagged "Not here"). | Can the focused row's word, its two-line note and its tag be read? Does it still look like a row that cannot be chosen, next to the rows under "HELP"? |

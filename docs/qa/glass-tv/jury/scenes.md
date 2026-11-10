# The TV's glass: the jury's scenes

Twenty scenes. Each is two pictures of the same screen of the TV app, `NN-A.png`
and `NN-B.png`: one is the look as it is today, the other the proposed look.
Which letter is which changes from scene to scene (it is in `key.json`; do not
open it before you have judged).

The question for every scene: **which of the two looks better, and can every
word be read?** The aim is the Apple TV tab bar: a dark floating pane, crisp
white words that read over anything, a rim of light, the chosen item as a
darker pill inside the pane.

About the pictures:

- They are real: `adb screencap` on the Mi TV, 1920x1080, same screen, same
  focus, same content behind as far as the TV allowed.
- Both pictures of a scene went through the same steps to fit under 600 KB:
  full size, saved as a 256-colour PNG (Python PIL; `sharp` is not in the repo).
  Fine grain in smooth dark areas comes from that and is the same in both.
- A screencap cannot see the film itself. In the player scenes (07, 08, 09) the
  film area is flat dark grey in both pictures; only a subtitle line shows.
- Focus is the white fill or the white ring. It must be at least as easy to
  find in both.
- In scenes 09, 14, 15, 16 and 20 nothing was meant to change. The two pictures
  should be the same; say so if they are not.

| scene | what it shows | what to look at |
|---|---|---|
| 01 | The nav rail open over a dark hero on Home. Focus on "Home". | The pane as a whole: its body, its edge against the picture, the labels. Is focus clear? |
| 02 | The nav rail open over a bright yellow hero. Focus on search, "Home" is the chosen section. | The labels over the bright picture. How "chosen" (Home) looks next to "focused" (search). The pane's edge against yellow. |
| 03 | The rail over the Movies grid. "Movies" is the chosen section, focus on "My List". | Chosen against focused against resting: can the three be told apart at a glance? |
| 04 | The rail over Settings. "Settings" is chosen, focus on "Calendar". | The same, lower in the pane. The profile pill at the foot. |
| 05 | The title sheet ("About Time") over Home. Focus on "Play". | The sheet's body and edge, the title, the grey second lines, the buttons. Does the page behind show through the words? |
| 06 | The "What's wrong with this copy?" sheet over a bright title page. Focus on the first row. | The small coloured kicker, the body text, the rows, the focused row. |
| 07 | The player's subtitles menu. Focus on the row that is set ("English 5"). | Row text, the header, the set row's tick and second line, the menu's edge. |
| 08 | The player's audio menu. Focus on a row that cannot be chosen. | The dim rows and their "Not here" tags: can they be read? The rows under "HELP". |
| 09 | The player's own controls, no menu. | Nothing was meant to change here. |
| 10 | The X-Ray sheet over a title page. Focus on the first face. | The small labels ("CAST", "FILMMAKERS", the roles), the facts lines, the hint "closes", the sheet's top edge against the picture. |
| 11 | A toast ("Added to My List") over a title page. | The toast only: its tick, its words, its edge. (The time on the Resume button differs between the two; ignore it.) |
| 12 | The genre menu open on Browse's filter pane. Focus on the row that is set ("All genres"). | The menu against the pane under it: can you see where one ends? Row text. The "Genre" button under the menu. |
| 13 | The rail over Settings with focus on the profile pill. | Focus on the pill at the pane's foot; "Settings" chosen right above it. |
| 14 | Home's rows: posters with their small badges, focus on a Continue Watching card. | Nothing was meant to change here. |
| 15 | Search, focus on a recent-search chip. | Nothing was meant to change here. |
| 16 | Settings: the genre chips, one chosen, focus on the next. | Nothing was meant to change here. |
| 17 | Stress: the rail over the Movies grid with its brightest posters right beside it. Focus on "Movies". | Do the pane and its labels hold next to white pictures? The pane's edge and shadow. |
| 18 | Stress: the title sheet over a grid of white and bright posters. | The same for a sheet: the words, the edge, anything showing through. |
| 19 | Browse's filter pane. "All" is the chosen chip, focus on the "Genre" button. | The pane, the chosen chip against the focused button, the grey chip labels, the small kicker. |
| 20 | The AI page: three rows of chips on the bare page, focus on "Find me something". | Nothing was meant to change here. |

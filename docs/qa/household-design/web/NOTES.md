# Household recommendations — website design pass (2026-10-28)

elia: *"'Recommended by your household' should be under 'Recommended for you' by default …
on mobile the Add to List button does not look that great — make sure it really looks good."*

Shots: real Chrome on a private instance, real posters, 9 widths (320 · 360 · 390 · 430 phones,
768 / 1024 touch tablets, 1280 · 1440 · 1920) × both looks. `after/` has every state
(`<width>-<look>-<state>.jpg`, plus `after/layout.json`, the measured card facts), `before/` the key
states from master (a480a2d), `reduced-motion/` a reduced-motion pass. `shoot.js` made them.

## Placement
- Checked in the browser at every width and in both looks. The order on Home is Recommended for
  You, then Recommended by your household (`after/*-01-home-row.jpg`, `layout.json` `order`).
  Without a stored Home order the server already does this, and when Recommended for You is
  absent the row takes the slot where it would have been.
- Profiles with a stored Home order (Settings → Home rows) got the row at the foot of Home. This
  branch found and fixed that, then dropped its fix because the TV design branch fixes the same
  thing in `orderRows` (src/routes/api.js + test/roworder.test.js). That fix is the one to keep.
  The website takes whatever order `/api/home` sends.

## Before → after (key shots)
| What | Before | After |
|---|---|---|
| The + on a phone card | `before/390-glass-01-home-row.jpg`: a disc floating mid-poster under the kind tag, lost on bright art | `after/390-glass-01-home-row.jpg`: owns the top-right corner across from NEW, 44 px press area, the kind tag steps aside as it does for the ✕ |
| Added | `before/390-legacy-04-added.jpg` | `after/390-legacy-04-added.jpg`: a green check, and the card no longer lifts or takes the focus on a tap |
| "From Dana and 10 others" | cut to "From Dana and 1…" | `after/320-glass-01-home-row.jpg`: "From Dana" / "and 10 others". Only the name is ever cut, never the count |
| Show all recommended | a pill under the row, crowding the next title | `after/1280-glass-02-hover-add.jpg`: at the end of the title line on wide screens, under the shelf on phones |
| Picker with many people | `before/1280-glass-11-picker-picked-note.jpg`: the title and Send scrolled away | `after/1280-glass-11-picker-picked-note.jpg`, `after/390-glass-11-…`: the title and Send stay put, the faces scroll with a fade, greyed faces keep a readable reason, long names take 2 lines, the note grows |
| Nobody else on the server | the note and a white Send still showed | `after/430-glass-14-picker-nobody.jpg` |
| Title page banner | `before/390-glass-20-title-banner.jpg`: words one per line, Hebrew quote scrambled | `after/390-glass-20-title-banner.jpg`: Not for me under the words, a Hebrew note as a right-to-left line |
| Show all page | `before/390-glass-50-showall.jpg`: tabs looked like the filter chips, 4 rows of people | `after/390-legacy-51-showall-filtered.jpg`: a segmented tab control, people in one swipeable line, the count follows the filter |
| You sent | `before/390-glass-52-you-sent.jpg`: posters with no titles, 3 cramped columns | `after/360-glass-52-you-sent.jpg`: titles under posters, 2 columns on a phone |
| Hebrew | Hebrew notes had their quote marks and dash scrambled | `after/390-glass-07-peek-hebrew.jpg`, `after/390-glass-41-arrival-one.jpg` ("שירה recommended הלהקה"), `after/1280-legacy-08-picker-hebrew-title.jpg`, `after/390-glass-30-settings.jpg` (mute chips). Right-to-left names and titles inside English lines are wrapped in invisible direction marks, as on the TV. A Hebrew note reads as a right-to-left line, and a Hebrew title or name on a card keeps its own direction |

The same words throughout (DESIGN.md table, the TV's). The tests are in `test/ui/household.test.js`,
under "the design": corner, disc size, the 44 px press area (49/49 points), no overlaps, one or two
lines of who with the count never cut, bidi, the picker's title and Send on screen with 12+ people,
the banner stacking, and where Show all sits.

Also: the glass peek sheet's ✕ now has the classic look's dark disc (it was invisible on bright
art), and a card taken off a shelf (Not for me, Continue Watching's ✕) stays off when a Home
answer that was already on its way lands. Not changed (outside this feature, noted by the review):
the app-wide toast's "+" icon for "Added to My List", and how the peek sheet's actions wrap.

# Taste — "The Deck"

The website's `#/taste` (public/js/screens/taste.js). What it does stays to the
letter: the same cards from the server, the same three answers, each saved the
moment it is given, the same Undo, Edit list, Done, Keep going. Only the look
and the motion change. Styles: the DECK and TASTE sections at the end of
public/css/play.css. Pure logic: public/js/play/tasteread.js and
public/js/play/constellation.js.

## The idea

One screen, one idea: **a deck of cards on a night sky, and every answer lights
the sky a little.** Stars are the currency (a loved title = a star), the
progress is an aurora ribbon, the reward is one meteor burst when the round
ends.

## The screen

```
 What's your taste?                     [↶ Undo] [Edit list] [Done]
 ━━━━━━━★━━━━━━━☆━━━━━━━☆━━━━━━━☆  7 / 24

              ╭───────────────╮      <- a pill pops here at a milestone:
              │   the card    │         "A pattern is showing: Comedy"
              │   (poster)    │
              │  Title        │
              │  2019 · Film  │
              ╰───────────────╯
               ╰─────────────╯        <- the next card, peeking
                ╰───────────╯         <- two plates: the deck has depth

            (✕)     (↑)     (♥)       <- three chunky keys
         Not for me  Haven't  Love
```

- **The room**: the kit's `room()` behind everything (fixed), so the screen
  looks the same in the glass and the legacy look.
- **The deck**: the card on show, the next card peeking out under it (9 px),
  and two decorative plates under that. The plates thin out as the round runs
  down (fewer than 4 cards left = one plate, fewer than 3 = none): the deck
  visibly runs out.
- **Drag**: the card turns about its bottom edge (as a held card does), the
  stamp fades in with the distance (as today), and the card underneath rises
  to meet the finger: `--pull` (0..1) on the deck drives its place, size and
  light. Let go early: everything springs back. Far or fast enough: it is
  thrown, as today (same thresholds).
- **Buttons, keys, a remote**: there is no drag to show the answer, so the
  stamp is *slammed* onto the card (190 ms, big to its size), the card takes
  the hit (a small nudge to that side), then it is thrown. The answer counts at
  once — the next card takes the keys immediately; a fast thumb is never held.
  The key that matches the answer flashes, so arrows teach the buttons.
- **Stamps**: thick rubber stamps. LOVE in aurora green, NOPE in rose,
  HAVEN'T SEEN in pale ink. Words unchanged.
- **Answer keys**: arcade keys with a chunky bottom edge that goes down when
  pressed: rose ✕, small glass ↑, green ♥. Labels unchanged.
- **The taste meter**: the old 4 px line becomes an aurora ribbon with four
  star pips at 25 / 50 / 75 / 100 %. A pip lights (pops) when the ribbon
  reaches it. The count ("7 / 24") stays next to it, and stays the thing a
  screen reader hears.
- **Milestones**: when a pip lights, a pill pops over the top edge of the card
  for about 2.5 s and says something made from this sitting's answers only:
  - 25 %: "First stars are lit" (a love so far) or "Tough crowd — keep going"
  - 50 %: "A pattern is showing: Comedy" (two loves share a genre) or "Halfway there"
  - 75 %: "Picky. Aurora likes that." (many more no than yes), "You keep
    loving Comedy" (three loves share a genre) or "Almost there"
  It moves nothing (it floats over the gap), it is said once per mark (Undo
  and answering again does not repeat it), and it is a polite status for a
  screen reader.
- **Phones**: the title row carries Done; the meter row carries the ribbon, the
  count, Undo (an icon) and Edit list — the ribbon is twice as long as the old
  line. The space kept clear of the tab bar is the shared stylesheet's
  (`--ts-reserve`), untouched.

## The end of a round — the one reward

The last card is thrown and the stage becomes the reward:

1. the constellation draws itself — one star for every title loved this
   sitting (up to 12), joined by thin lines, star by star;
2. the number lands in gold ("24") with **the meteor burst** (once per round;
   a smaller one for later rounds; never again for the same round after Undo);
3. the sentence (unchanged: "24 answers — Home is already using them"), the
   tally as three chips (♥ loved · ✕ not for you · not seen), and **what
   Aurora learned**: lit tags for the genres loved most ("★ Comedy"), dim ones
   for genres only refused ("less Horror");
4. Keep going / Done. Focus is on the first button from the first frame.

The answer keys step aside while the reward is up (the stage gets their room).
No loved titles: no constellation, the number and the rest.
Every title used up: the same panel with the server's own sentence, no number.

## Motion table

| What | How | Time |
|---|---|---|
| Screen in | head, deck, keys rise (opacity + translate) | 420 ms, 60 ms apart |
| Drag | inline transform on the card; `--pull` on the deck | follows the finger |
| Spring back | transform, a little overshoot | 260 ms |
| Stamp slam (button/key) | stamp scale 2.2 → 1, card nudge | 190 ms |
| Throw | translate + rotate + fade | 300 ms |
| Next card up | transform + opacity | 300 ms |
| Ribbon | scaleX | 500 ms |
| Pip lights | scale pop | 420 ms |
| Milestone pill | pop in, hold, fade | 300 / 2300 / 300 ms |
| Reward | stars pop 70 ms apart, lines fade, number pops, burst 1.7 s | about 2 s in all |

Only transform and opacity move. Nothing loops on this screen except the
room's own slow curtains (the kit's). When the screen is left the room is
destroyed, timers are cleared, the burst's canvas removes itself.

## Fallbacks

- **Reduced motion**: no slam, no throw (the card fades, as today), no pops,
  no burst; the pill appears and stays until the next answer; the reward is
  simply there, complete. The deck still shows its depth (still plates).
- **Missing poster**: the drawn stand-in (the site's `posterImg` fallback)
  inside the same card; the title is always on the card.
- **Long titles / Hebrew**: the title clamps to two lines; `dir="auto"` on the
  title and the lines so Hebrew reads right to left and sits on its own side.
- **Very small / very short screens** (320 px wide, a phone on its side): the
  shared stage rules shrink the card; the plates and the pill scale with it;
  on a short reward the constellation is dropped first, then the panel
  scrolls.
- **2560 px**: the deck is capped by the shared stage height (640 px); the
  room fills the rest.
- **Keyboard / TV browser**: the card has the focus and a visible white ring;
  arrows answer, Enter loves, Z undoes; arrows in the toolbar move focus as
  everywhere. All as before.
- **Kids profiles**: the server already sends a kids deck; the words here are
  all-ages.

## Not changed

Server, routes, the answer rules and thresholds, the texts of the heading, the
buttons, the stamps and the end sentence, the Edit list screen (`#/taste/list`).

# Pick together — "Party night"

The website's `#/group` and `#/group/:code` (public/js/screens/group.js; the
words are public/js/groupwords.js, shared with the TV and untouched). The
rules of the vote and every server answer stay exactly as they are. Only the
look and the motion change. Styles: the DECK and PICK TOGETHER sections at the
end of public/css/play.css. Pure logic: public/js/play/tally.js.

## The idea

A party game in five beats: **get a ticket → the room fills → everyone plays
their hand → the votes come in → the reveal.** The reveal is the moment of the
night and the only reward.

## The screens

### 1. Start or join (the chooser)
Two play cards on the night sky. "Join" has one big four-letter code field
(the letters as wide as a ticket's), "Start" has the deck choices as chunky
chips (the same radios), the big-screen switch, and the gold Start key.
Words, order and controls as today.

### 2. The lobby
```
   JOIN WITH THIS CODE
   ┌───────────────┐   ▓▓▓▓▓
   │  K  7  P  M   │   ▓ QR ▓        <- the code as a ticket, the QR on a tile
   └───────────────┘   ▓▓▓▓▓
   2 people are in
   (D) Dana ·host   (A) Avi   ( + ) ( + )     <- big round seats
   [ Add a title ]            [ Deal the cards ]
```
- Each person is a **seat**: a big avatar bubble with the name under it. A
  seat **pops in only when that person is new** (the lobby repaints on every
  update from the server; who has been seen is remembered for the session, so
  nobody pops twice). Away = dimmed with "away". The host has a small gold
  star. Two dashed empty seats say "there is room".
- The code is big, spaced, gold-edged — it is the thing people look for from
  the sofa. On the big screen it is bigger still (as today).
- Deal is the gold key.

### 3. Voting (your hand)
The same deck as Taste (shared DECK styles: plates under the card, the next
card rising under the finger, thick stamps YES / NO / MAYBE, the slam for
buttons and keys, arcade answer keys). Around it:
- the **time** as an aurora ribbon that drains (the same 1-second tick, the
  same element);
- **your hand**: "card 3 of 10" as it is today, in play type;
- who is in the room and who has finished, as small avatars with a tick.
Rules, thresholds, Undo, Add a title: unchanged.

### 4. Waiting for the others
The suspense builds: big seats again, each with **its own ribbon** (answered /
deck) and a tick when done; the sentence of today above. On the big screen
this is the main picture: the room's votes coming in, seat by seat.

### 5. The reveal — the one reward
The result page is complete from its first paint (title, the reason, the
buttons — exactly today's content, restyled as a prize: poster with a gold
edge, "Tonight's pick" kicker in gold, the tally as stars). Over it, **once
per result and only when this page saw the vote end**, a short show plays:

1. **"The votes are in…"** — the screen dims to the night sky, three stars
   light one after the other (about 1.4 s). Nothing of the result is visible.
2. **Only if it was a tie** (the first two picks have the same votes): **"A
   tie — the stars decide"** — the two posters side by side, a light jumps
   between them, slower and slower, and stops on the server's choice (about
   1.8 s). The server's order is the result; the show only tells it.
3. **The drop**: the winning poster falls into place, **the meteor burst**,
   the gold kicker, the title, and the tally stars count in: ★ for each yes,
   ☆ for each maybe.
4. The show lifts; the page under it is the result, focus on Play.

A click, a tap, Enter, Space or Escape **skips** the show at any point (and
does not press what is under it). "Something else" (the next pick) is a quick
flip of the card — no curtain, no burst. Someone who opens the page after the
result (a reload, a late phone) gets the still page.

### 6. Chosen / ended
Restyled to match (the title in play type, the room behind). No new burst.

## The tally
From the pick the server already sends (`yes`, `maybe`, `no`, `missing`, `of`):
a row of stars — gold filled for yes, outlined for maybe, a dim dot for no or
no answer — next to the server's own sentence (`pick.why`, unchanged, still in
`.gp-why`). A tie is `picks[0]` and `picks[1]` with the same yes and maybe
counts and not "everyone".

## Motion table

| What | How | Time |
|---|---|---|
| Seat arrives | pop (scale) | 420 ms |
| Deck | as Taste | — |
| Time ribbon | scaleX, linear, per second (as today) | 900 ms |
| Seat ribbon | scaleX | 500 ms |
| Votes are in | three stars pop, 380 ms apart | 1.4 s |
| Tie-break | highlight alternates, 9 jumps, slowing | 1.8 s |
| Drop | poster drop (translate + scale), burst 1.7 s | 600 ms + burst |
| Tally stars | pop, 90 ms apart | under 1 s |
| Something else | card flip (opacity + small translate) | 260 ms |

Only transform and opacity. The show's timers are cleared when it is skipped
or the screen is left; the curtain is inside the screen, so leaving removes it.

## Fallbacks

- **Reduced motion**: no show, no pops, no burst. The result is the still
  prize with the tally; a tie is told in a line ("It was a tie — the stars
  decided"). The time ribbon steps once a second without easing.
- **Missing poster**: the drawn stand-in, everywhere a poster is used.
- **Long titles / Hebrew / long names**: titles clamp, names ellipsis under
  their seat, `dir="auto"`.
- **320 px**: seats 56 px, the code 3.2 rem (the shared rule), one column.
  **Big screen / 2560 px**: the lobby and the waiting room scale up (the
  shared `.screen` rules), the reveal poster is capped at 300 px wide.
- **Keyboard / TV browser**: as today (arrows answer on the card; every
  control is a button with a white ring). The show is skipped with any key.
- **Kids profiles**: the server's rules, as today.

## Not changed

groupwords.js, the server, the routes, the first-time tutorial sheet and the
"add a title" search sheet (they are sheets over the page and keep the site's
sheet look), the join code/QR logic.

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

---

# As built (2026-11-10)

Everything above was the design on paper. This part says what was built where
it differs, what the three look passes found, what was measured, and what is
still weak.

## Where the build differs from the paper

- **Gold is kept for the win.** Start and Deal are aurora keys (the step
  forward), not gold. Gold is the ring round the winning poster, the
  "Tonight's pick" line, the stars of the tally and the Play key. The Join key
  lights up when four good letters are in.
- **The tie rule**, exactly: a tie-break is shown only when the first two
  picks have the same votes and it was not "everyone said yes". The server's
  order is the result; the show only tells it. With reduced motion, or for
  someone who opens the page later, a tie is one line: "It was a tie — the
  stars decided".
- **Skipping gives up the burst.** A press of Skip (or any key, tap or click)
  during the curtain ends the show at once, without the meteor burst. The
  Skip button is deliberately not a counted control.
- **A match that is not one**: the no-match page used to say "TONIGHT'S PICK"
  above "No match this time". The line above is now the feature's own ("What
  do we watch tonight?").
- **Each step gets its own room** (`data-step` on the screen): the voting
  step fills the window exactly; the lobby, the waiting room and the result
  are centred from 600 px wide.
- **Clear of the tab bar without a written-down height**: the screen reads
  the room the page already keeps for the bar into `--pg-reserve`. Before
  this work, on short phones and in the legacy look the labels of the answer
  keys sat under the bar, and on short phones the result's Play was below the
  fold.
- **A phone on its side** has its own layouts: voting is the card beside the
  keys; the result is the poster on one side and the words on the other; the
  waiting room and the curtain are compressed. Before this work the keys were
  off the screen there.
- **Wide screens grow**: from 1800 px (and again from 2400 px) the lobby, the
  code, the QR, the seats, the waiting room, the curtain and the result scale
  up (the paper said "the reveal poster is capped at 300 px").
- **The waiting room is updated in place.** Every push from the server used to
  rebuild the page; now a seat's ribbon and tick change where they are, and a
  seat that was already seen does not pop again.
- New words that exist only on the website (the `SHOW` list in group.js): "The
  votes are in…", "A tie — the stars decide", "It was a tie — the stars
  decided", "Skip", "Card 3 of 10". groupwords.js is untouched.

## Left as it was (the site's own behaviour)

- On the chooser the two cards swap sides between narrower screens and wide
  ones with a mouse (1200 px and up).
- The host's star leaves the seat once the host also joins from a phone: the
  list keeps "the person, not the TV", and that person's row carries no host
  mark. Existing data behaviour.

## The three look passes

**Pass 1 — the ten weakest**
1. Voting on a short phone (320 x 568): huge keys, labels under the bar — fixed.
2. Voting on a phone on its side: the card cut, keys off the screen — fixed.
3. The result on a phone on its side: title and Play below the fold — fixed.
4. The result at 320 x 568: Play under the tab bar — fixed (smaller poster).
5. The result at 1920 / 2560: small and stuck to the top — fixed.
6. The curtain at 1920 / 2560: small — fixed.
7. The curtain at 812 x 375 touching the top bar — fixed.
8. The lobby and the big-screen waiting room at 1920 / 2560: small — fixed.
9. The chooser's cards swap sides at 1200 px — the site's own; left.
10. "TONIGHT'S PICK" above "No match this time" — fixed.

**Pass 2** — the result at 667 x 375: the poster too tall (now sized from the
height); the result at 768 x 1024 top-heavy (centred); the waiting room on a
phone on its side and at 320 x 568 (compressed); a lobby that is not the big
screen kept a small code and QR at 1920 / 2560 (fixed); the waiting title too
big against small seats there (fixed); waiting / chosen / ended not centred
(centred); voting at 2560: the head and keys small (fixed).

**Pass 3** — 812 x 375: the result, voting and the lobby tight under the wide
top bar (more room; fixed). Confirmed the wide sizes. Accepted: see below.

## Measured

A phone-sized window (390 x 844), the processor slowed four times. This PC was
busy, and slowed-down runs of the same code differ by up to two times, so the
numbers are ranges. 60 is perfect.

| Moment | Before the pacing fixes | After (three runs) | Normal speed, after |
|---|---|---|---|
| The lobby, someone arrives | 57 | 57 – 60 | 59 |
| Six answers | 38 | 41 – 59 | 58 |
| Waiting, the other seat's ribbon moving | 18 | 55 – 56 | 58 |
| The votes are in, the reveal, the burst | 45 | 54 – 59 | 59 |

After leaving the page: the same number of frame callbacks as before entering
(the site's own loop), no node of the game left, no animation of the game.

## Still weak (accepted, or not verified)

- The result at 667 x 375: the third button and the "leave" row need a scroll.
  The waiting room on a phone on its side: the buttons need a scroll.
- With reduced motion there is no curtain at all: the result is simply there.
- The waiting room at 1920 sits a little above the middle (on purpose: the
  title reads first).
- Six answers slowed four times was once 41 frames a second in three runs;
  the site's own always-running work (the sky, the measuring of what is
  behind the top bar) is a large part of what is left.
- Real phones and a real TV were not used; two headless browsers played the
  host and the guest.
- The shots use the test catalogue, which has no real posters.

## Shots and recording

docs/play/shots/group/: `before-*` and `after-*` for chooser, lobby-alone,
lobby, swipe, swipe-mid, waiting, waiting-mid, result-early, result, and the
guest's phone (`*-g390`); `after-show-*` (the curtain); `group.webm` (38 s on
the host's phone: the chooser, the code, a guest arrives, voting, waiting,
"The votes are in…", the tie-break, the result).

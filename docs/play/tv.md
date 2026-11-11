# Aurora Play on the TV

The website's game look (docs/play/taste.md, pickforme.md, group.md,
wrapped.md) brought to the TV app (tv-native): **Taste**, **Pick for me**,
**Pick together**, and — new on the TV — **Wrapped**.

What each feature *does* stays exactly as it is: the same data, the same
rules, the same server answers, the same ways in. Only the look and the motion
change, plus one new screen (Wrapped) that reads data the server already
gives.

This is the design on paper. The part "As built" at the end says where the
build differs and what the TV itself showed.

## The art direction, for a sofa

The website's direction is a **night-sky arcade**: stars are the currency,
answers draw constellations, progress is an aurora ribbon, the reward is a
meteor burst, and there is **one warm gold, kept for a win**. The TV keeps all
of it and changes how it is made and how it is driven:

| On the website | On the TV | Why |
|---|---|---|
| A finger, a mouse, keys | Up / Down / Left / Right / OK / Back (and Play/Pause) | It is a remote. Every screen below has a remote map. |
| Hover, drag, tilt | Nothing of the kind. The **focus ring** (white, with the app's scale) stays THE way to say "you are here". | One focus language in the whole app. |
| Type from 12 px | Nothing under 13; the things read from the sofa (a code, a title, a number) are 30 – 96 | Three metres away. |
| Gradients, shadows and glows drawn by CSS | **Baked pictures** (tools/gen_play_kit.py): the room, the star, a glow, the ribbon, a meteor, a card's foot shade, the card back | On the Mi TV a CSS gradient and a blurred shadow are redrawn every frame. A picture is one texture. |
| The burst is 42 meteors on a canvas | **16 small pictures moved by one value** on the native driver | A canvas repainted in JS each frame is not affordable. |
| The room's two aurora curtains drift | The room is **one still picture** (a real curtain shape, since a still oval reads as a stripe) and five stars twinkle | Nothing big moves for ever on a weak box. |
| Motion in CSS | `Animated` with `useNativeDriver: true`, transform and opacity only, `isInteraction: false` | No JS per frame; the remote stays quick. |
| Reduced motion | **Calm**: the system's "remove animations" *or* the app's lite tier. Everything is still and complete. | A weak box gets the still version by itself. |

Rules every play screen keeps:

- **Focus is never lost and never jumps by itself.** A key that changes its
  meaning (Thinking… → Open) is the *same* mounted key. A screen hands focus
  once, at a moment the person caused.
- **Back leaves in one press** from any resting state. A show that is playing
  (the reveal, a landing) is skipped by Back first — that is not a resting
  state — and Back never needs more than that.
- **One reward per flow.** A burst is given once; coming back, undoing or
  drawing again never gives it twice.
- **Nothing runs when the screen is not the one in front**, and nothing after
  it is left: loops are stopped on blur and unmount, timers are cleared.
- **Overscan**: the app's own gutters (48 / 27 dp, 84 where the rail is).

## The kit (tv-native/src/play/)

Pure rules — ports of the website's modules, held to the website's own answers
by tests that load the website's files (`__tests__/logic/play-rules.test.ts`,
`play-wrapped.test.ts`):

| File | What |
|---|---|
| tokens.ts | The `--play-*` colours and the times |
| reel.ts | The draw's strip and its landing curve (`reelStops`: the curve as interpolation stops, so the landing is one native value) |
| tally.ts | The vote as stars, the tie rule, the tie-break's jumps |
| tasteRead.ts | What a sitting says (genres loved / refused), the meter's four marks, the milestone words |
| constellation.ts | The sky of loved titles (`lineBox`: a line as a turned bar) |
| count.ts | The number wheels |
| meteors.ts | The burst's meteors (`flight`: one meteor's life as stops of one value) |
| deck.ts | How many plates are left; the stamp-slam-throw as one run |
| wrappedRules.ts | Wrapped: the hours lines, the viewer type, the lines, the chapters, the sky |

Pieces (components):

| Piece | What it is | Cost |
|---|---|---|
| `Room` | The deeper sky behind a play screen: one opaque picture, five twinkles | one full-screen pass (like Detail's backdrop); one looping value |
| `Star`, `Glow` | The star and a soft light, tinted | a small picture |
| `Meter` | The aurora ribbon that fills, with four star pips | revealed, not squeezed: two translates |
| `Burst` | The meteor burst | 16 pictures, one value, 1.7 s, then unmounted |
| `Odometer` | A number that rolls in, left to right | one translate per digit |
| `Stamp` | LOVE / NOPE / YES… thick, tilted | a view |
| `Plates` | The deck under the top card, thinning as it runs out | two flat views |
| `Pill` | A line that pops over the card, holds, leaves | one value |
| `PlayKey` | The game's key on `Focusable`: **aurora** (the step forward), **gold** (the win), **glass** (everything else) | the aurora face is a picture; no shadow |
| `Pop`, `Rise` | Something arrives (scale) / words come up (translate) | one value each |
| `Flip` | A card turns over | one value, two faces |
| `SkyLines` | A constellation: stars lit one after the other, lines between | one value for all stars |

## Taste — "The Deck"

Way in: Settings → "Swipe your taste" (unchanged).

```
 What's your taste?            ━━━━━━━━━━★━━━━━☆━━━━━☆━━━━━☆   7 / 24      [↶ Undo] [Done]

                                ( A pattern is showing: Comedy )
                 ╭───────────────╮
     ◀           │               │            ▶
  Not for me     │    poster     │         Love it
                 │               │
                 │  Title        │   <- on the card's foot
                 │  2021 · Film · Comedy, Crime
                 ╰───────────────╯
                  ▔▔▔ next card, plates ▔▔▔
                        ▼ Haven't seen it          "why it is asked", two lines
```

- The card is the hero: bigger (62 % of the height), the title and its line on
  the card's foot over a baked shade. The next card peeks from under it; under
  that, plates — two, then one, then none as the deck runs out.
- **The three answers stand where the keys are**: left of the card "◀ Not for
  me" (rose), right "Love it ▶" (green), under it "▼ Haven't seen it". They
  are labels, not keys — the card is the one thing in focus — and the matching
  one **flashes** when its key is pressed.
- **The answer**: the stamp is slammed on the card (LOVE / NOPE / HAVEN'T
  SEEN, big to its size in 170 ms), the card takes the hit and is thrown to
  the answer's side (300 ms); the next card rises. One native run. The answer
  *counts* at the key press — a second press lands on the next card, never on
  a moving one.
- **The meter**: the aurora ribbon fills; a star lights at each quarter. At
  the first three a **pill** pops over the card with a remark about this
  sitting ("First stars are lit", "A pattern is showing: Comedy", "Picky.
  Aurora likes that."). Each remark is said once, also after Undo.
- **The end of a round — the one reward**: the loved titles become a
  **constellation** (one star each, up to twelve, lit 70 ms apart), the number
  of answers rolls in in gold, the **burst** (full the first round, smaller on
  later rounds, never twice for a round). Under it: the sentence, the tally (♥
  loved · ✕ not for you · not seen), what Aurora learned ("★ Comedy", "less
  Horror"), and two keys: **Keep going** (aurora, focused) and **Done**.

Remote:

| Key | On the card | At the end of a round |
|---|---|---|
| Right / OK | Love it | Right: to Done |
| Left | Not for me | Left: to Keep going |
| Down | Haven't seen it | — |
| Up | To Undo / Done at the top | To Undo / Done |
| Back | Leaves (answers are already saved) | Leaves |

Fallbacks: **calm** — no slam, no throw, no burst; the card changes with a
short fade, the pill appears still and stays until the next answer, the end
screen is complete at once. **No loved titles** — no constellation, the
number alone. **Every title answered** (the server has no more) — the
server's sentence, Done focused. **Nothing answered in the round** — no row of
noughts. **Missing poster** — a tile in the card's colours with the title.
**Long or Hebrew titles** — two lines on the card, then cut; the text follows
its own direction.

Motion: stamp slam 170 ms · throw 300 · next card rises 300 · ribbon 500 ·
pip pop 420 · pill 300 in / 2300 hold / 300 out · constellation 70 ms a star ·
number 900 · burst 1700.

## Pick for me — "The Draw"

Way in: the AI entry of the rail (unchanged). The question, the filters, the
examples, the request and "it comes back as you left it" are unchanged.

```
 ▌ AI
 ▌ What are you in the mood for?
 ▌ "a clever heist with a twist" · Film · Any era            <- the question, folded (OK: change it)
 ▌
 ▌  ╭─────────╮    ★ TONIGHT'S PICK · 1 of 6
 ▌ ▸│  reel   │◂   Title
 ▌  │         │    2019 · Film
 ▌  ╰─────────╯    "the reason, in full"
 ▌                 [ Open ]  [ Another one ↻ ]      ● ○ ○ ○ ○ ○
 ▌
 ▌ ★ The whole hand · 6 picks for "…"                         [Try again]
 ▌ [card][card][card][card][card][card]
```

- **Asking** (the key, an example): the question folds to its one-line summary
  and **the stage** appears: a poster-sized window with gold notches, and
  beside it the words. Focus is handed **once**, to the stage's main key. That
  key is mounted from this moment ("Thinking…", dim, does nothing) and
  *becomes* "Open" when the prize lands — the focus never moves by itself.
- **The wait**: card backs (star-marked) roll in the window at a steady pace;
  the four waiting lines change beside it, as today; three stars light in
  turn.
- **The landing**: the strip becomes the real posters (the picks round and
  round, the winner last) and slows for 1.9 s, runs a hair past, settles. A
  beat of stillness (260 ms).
- **The prize**: the window flashes gold, **the burst** (the one reward of an
  answer), the gold line "★ TONIGHT'S PICK", the title, year · Film/Series,
  the reason in full, and the keys **Open** (gold — the win) and **Another
  one ↻**. Open ignores presses for the first 400 ms, so a press meant for
  "Thinking…" does not open a title nobody has seen yet.
- **Another one**: a short spin (700 ms) lands on the next pick; a gold flash,
  no burst. It walks the server's order and wraps; the pips say where. With
  one pick the key is not there.
- **The whole hand**: under the stage, today's cards with their reasons, the
  drawn one ringed in gold; today's status line and "Try again".
- **Coming back** (same profile): the prize, still, on the pick last drawn;
  no spin, no burst.
- **Nothing came back / an error**: the stage folds away; the same sentences
  as today.

Remote:

| Where | Up | Down | Left | Right | OK | Back |
|---|---|---|---|---|---|---|
| The question (open) | — | examples / the hand | the rail | along the chips | ask / choose | leaves |
| The folded question | — | the stage's key | the rail | — | unfolds it | leaves |
| Open / Another one | the folded question | Try again, then the hand | the rail (from Open) | between the two | open the title / draw the next | leaves |
| The hand | the row above; from the top row: Try again | the row below | the rail (first column) | along the row | the title's page | leaves |

Fallbacks: **calm** — no reel: a still card back while waiting, the prize at
once, Another one is a plain change, no burst. **Missing poster** — the tile
with the title, in the reel and in the prize. **Long / Hebrew titles** — two
lines, then cut. **One pick** — no Another one, no pips. **The AI is off** —
today's notice.

Motion: stage in 280 · reel waiting 520 ms a card (one looping value) ·
landing 1900 (one value, the curve in its stops) · hold 260 · flash 500 ·
burst 1700 · words rise 60 ms apart · Another one 700.

## Pick together — "Party night"

Way in: the "Pick together" row on Pick for me (unchanged). The vote's rules,
the server, the words (groupPick.ts = the website's groupwords.js) and every
control are unchanged. The TV is usually **the room's screen**: the look is
built for that first.

Five beats: **the ticket → the room fills → the hands are played → the votes
come in → the reveal.**

1. **Start** — the choices as chips on the night sky, grouped under their own
   small headings; **Start** is the aurora key (the step forward).
2. **The lobby — the ticket.** The code is the thing people look for from the
   sofa: four big letters on a ticket with a gold edge (72 dp), the QR code on
   its own white tile next to it, the address under it. Under the ticket,
   **seats**: a round avatar with the name under it for each person; a seat
   **pops in once**, when that person is new (remembered for the session);
   "away" is dimmed; the host carries a small gold star; two dashed seats say
   there is room. **Deal** is the aurora key, dim until someone is in.
3. **Voting on the big screen** (the TV shows, the phones vote): the seats
   again, each with **its own ribbon** (answered / deck) and a tick when done;
   the time as an aurora ribbon that drains, with the clock; the host's keys.
   **Voting on the TV** (the TV is a voter too): the Taste deck — plates, the
   stamp slam (YES / NO / MAYBE), the throw — with the three answer keys under
   it (Yes focused, as today) and "Card 3 of 10".
4. **The reveal — the one reward.** The result page is complete under it from
   the first moment (title, why, keys — today's content as a prize: the poster
   with a gold edge, "★ TONIGHT'S PICK" in gold, the tally as stars: gold for
   a yes, outlined for a maybe, a dim dot for a no). Over it, **once per
   result and only when this screen saw the vote end**, the show:
   - "The votes are in…" — the sky, three stars light one after the other
     (1.4 s);
   - **only if it was a tie**: "A tie — the stars decide" — the two posters
     side by side, a light jumps between them, slower and slower, and stops on
     the server's choice (1.8 s);
   - the drop: the winning poster falls into place, **the burst**, the tally
     stars count in.
   Any key **skips** the show (and gives up the burst); OK does not also press
   Play under it. "Something else" is a quick change of the card: no show, no
   burst. A screen that opens on a result (a late join, a restart) gets the
   still page.
5. **Chosen / ended / no match** — the same room and type. No burst.

Remote: as today on every step (the same focus order, the same preferred
keys: Deal in the lobby, More time on the big screen, Yes on the deck, Play on
the result). **Back** in a session asks first (Stay / Leave / End for
everyone), as today; during the show Back skips the show.

Fallbacks: **calm** — no pops, no show, no burst; the result is the still
prize; a tie is told in a line ("It was a tie — the stars decided"); the time
ribbon steps once a second. **Missing poster** — the tile with the title.
**Long names** — one line under the seat, cut. **Many people** — seats shrink
from seven up and wrap to two rows; from thirteen the tally is the server's
sentence alone. **Nobody in** — the two dashed seats and today's line.

Motion: seat pop 420 · seat ribbon 500 · time ribbon 900, once a second ·
votes-are-in stars 380 apart · tie-break 9 jumps over 1.8 s · drop 600 ·
burst 1700 · tally stars 90 apart · Something else 260.

## Wrapped on the TV — the decision: yes

**Decision: build it.** Reasons:

1. It is the feature elia named ("aurora wrapped"), and today the TV has none.
2. The TV is where it belongs: a year in review is watched *together*, on the
   big screen, the way a slideshow is. A story of full-screen chapters is the
   most TV-shaped thing in the whole play set.
3. The remote fits it better than it fits a deck: a story needs two keys
   (next, back).
4. It costs little that is new: the server already answers
   (`/api/profiles/:id/wrapped`, the call the phone app makes), and every
   rule — the chapters, the hours lines, the viewer type, the lines, the sky —
   is a pure module, ported and held to the website's answers by a test.
5. What does **not** fit is left out and said: the **share card** (a picture
   to send from a phone) makes no sense on a TV. The finale is the summary
   card with **Watch again** and **Done**.

Way in: Settings → "Your Aurora Wrapped", next to "Swipe your taste".

The story (the same chapters, in the same order, as the website; a chapter
without data is left out by the same rule — `chaptersFor`):

| Chapter | On the screen |
|---|---|
| Opening | "{Name}, your year in Aurora" — the sky of the year: one star per night watched |
| Hours | The number rolls in, huge; under it what it feels like ("That's 5 days and 16 hours, back to back.") |
| Number one | A card face down; it turns over: the poster, the title, the hours |
| The podium | Two to five: second, first, third on steps, the rest as a line |
| Genres | Bars that race to their length, the winner in aurora |
| Your hour | The 24 hours as columns; the peak one lit; "9 pm is your hour" and the day of the week |
| The streak | The year's sky again, the longest run of nights joined into a constellation |
| The longest sitting | One number, one line |
| Your type | A sealed card ("No. 4 of 8") turns over: the viewer type, its constellation, why — **the burst, the one reward of the story** |
| The lines | The server's lines about the year, one after the other (a kids profile gets "The highlights": kind lines only, never a roast) |
| Finale | The summary card: hours, titles, nights, the type. **Watch again** · **Done** |

A progress row at the top: one segment per chapter, the current one filling
(the story moves on by itself — about 7 s a chapter — and holds while a key is
held on it).

Remote:

| Key | Does |
|---|---|
| Right / OK | Next chapter (on the finale: the focused key) |
| Left | The chapter before |
| Play/Pause | Hold / go on |
| Up / Down | Nothing in the story; on the finale: nothing to reach but the two keys |
| Back | Leaves, in one press, from any chapter |

Fallbacks: **calm** — every chapter is complete and still, no auto-advance
(Right / OK moves), no burst. **A new profile (nothing watched)** — one page:
"Your sky is just getting started" and Done. **A short year** — the short
story (the same rule as the website: `chaptersFor`). **Missing posters** — the
tile with the title. **Long / Hebrew titles** — two lines, then cut. **The
request fails** — the app's error state with Try again.

Motion: chapter change 300 (opacity + a small rise) · hours wheels 1100 · flip
600 · bars 700, 90 apart · columns 500, 20 apart · sky stars 30 apart ·
burst 1700.

## What is measured, and how

Per screen, before and after, on the Mi TV: `dumpsys gfxinfo com.auroratv`
(frames, janky frames, the 50th / 90th / 95th / 99th percentile) over the same
script of key presses — and the app's own frame counter. The budget: a play
screen at rest draws nothing (0 frames a second when nothing changes, apart
from the five twinkles); the answer on the deck, the reel's landing and the
burst hold the TV's rate as well as the old screens' plain moves did.

# Pick for me — "The Draw"

The website's AI tab, `#/pick` (public/js/screens/pickforme.js). What it does
stays: the same question box, the same filters, the same examples, the same
request to the server, the same list of picks with their reasons, the same
"comes back as you left it" for the profile that asked. Only the look and the
motion change. Styles: the PICK FOR ME section at the end of
public/css/play.css. Pure logic: public/js/play/reel.js.

## The idea

Today the answer is a grid that appears. A pick should feel **drawn**: a reel
of posters spins while Aurora thinks, slows, and lands on one — presented as
the prize. The rest of the answer is still there, as "the whole hand".

## The screen

```
 AI                                    (the room behind)
 Tell Aurora what you feel like…
 [ Pick together — the ticket ]

 ╭ What are you in the mood for? ───────────────╮
 │ [ a clever heist with a twist     ] [ Draw ] │   <- same field, same button id;
 │ (Film|Series) (Any era)(Classic)… (Short)…   │      the button says what it does today
 ╰──────────────────────────────────────────────╯      ("Find me something")
 (example) (example) (example)                          chips, chunkier

                 ▼
        ╭─────────────────╮      THE STAGE (appears on asking, scrolled into view)
     ▸  │   the reel      │  ◂   a poster-sized window, gold notches at the payline
        │  (posters roll) │      under it: the waiting words, as today
        ╰─────────────────╯

  then →   [poster, won]   TONIGHT'S PICK · 1 of 6
                           Title
                           2019 · Film
                           "the reason, in full"
                           [ ▶ Open ]  [ Another one ↻ ]

 The whole hand · 6 picks for "a clever heist…"     <- today's status line
 [card][card][card][card][card][card]               <- today's cards + reasons
```

## The flow

1. **Asking** (button, Enter, or an example): the stage appears under the
   examples and the page scrolls so it is in view (today, on a phone, pressing
   the button shows nothing: the wait and the results are below the fold).
2. **The wait** (a real request; it may take 1–20 s): the reel spins blank
   card backs — star-marked plates — at a steady speed. The four waiting
   messages rotate under it exactly as today ("Reading your taste…" and so
   on). Nothing else moves.
3. **The answer lands**: the strip becomes the real posters (the picks in a
   loop, the winner last), and the reel **slows for about 1.9 s** — each
   poster that passes the payline is a tick (a tiny buzz on a phone) — and
   settles on the first pick with a small overshoot. A beat of stillness
   (260 ms): the suspense.
4. **The prize**: the window flashes gold, **the meteor burst** (the one
   reward of this flow), and the words rise beside it: "Tonight's pick", the
   title, the line of year · kind, the reason in full, and two buttons —
   **Open** (the same as pressing the card) and **Another one**. Focus goes to
   Open; a screen reader hears "Tonight's pick: Title".
5. **Another one**: the prize card drops out, the reel gives a short spin
   (700 ms) and lands on the next pick — no burst (the reward was given), a
   gold flash only. It walks the server's order and wraps round; the pips
   ("2 of 6") say where you are. With one pick the button is not shown.
6. **The whole hand**: under the stage, today's status line and today's cards
   with their reasons — every pick, in the server's order, the drawn one
   ringed in gold. Nothing the old page showed is lost.
7. **Coming back** to the page (same profile): the prize is there, still, on
   the pick last drawn; the hand under it; no spin, no burst. Another profile
   starts from an empty page, as today.
8. **Nothing came back / an error**: the stage folds away, the same sentence
   or toast as today.

## The chips

Filters, the Film/Series switch and the examples keep their markup, ids and
words; they become chunky game chips: a thick pill with a bottom edge, the
chosen one filled with the aurora and pressed in. The "Pick together" entry
becomes a ticket (same markup). The ask button becomes the gold key.

## Motion table

| What | How | Time |
|---|---|---|
| Stage in | rise | 420 ms |
| Reel, waiting | one strip, translateY, linear loop | 520 ms a card |
| Reel, landing | one tween on translateY, ease-out with a small back | 1900 ms |
| Hold | still | 260 ms |
| Prize | gold flash (opacity), burst 1.7 s, text rises 70 ms apart | about 900 ms |
| Another one | card drops (220 ms), short spin (700 ms), lands | about 1 s |
| Chip press | the kit's press (scale) | 90 / 420 ms |

Only transform and opacity. The reel is one element moving; posters are
decoded before the landing starts. The spin stops when the page is left (the
tween is cancelled, the loop is a CSS animation on an element that is gone).

## Fallbacks

- **Reduced motion**: no reel. While waiting: a still card back and the
  waiting words. The answer: the prize at once, complete. Another one: a
  plain swap. No burst.
- **Missing poster**: the drawn stand-in in the reel and in the prize.
- **Long titles / Hebrew**: the prize title clamps to three lines, `dir="auto"`.
- **320 px**: the reel window is 150 px wide, the prize stacks (poster over
  words), buttons full width. **2560 px**: the stage is capped at 980 px.
- **Keyboard / TV browser**: every chip and button is a button with a white
  focus ring; Open takes the focus when the prize lands.
- **Kids profiles**: the server filters, as today.

## Not changed

The request, the filters' meaning, the remembered answer and who may see it,
the texts of the status line and the errors, `.pfm-pick` cards (one per pick).

---

# As built (2026-11-10)

Everything above was the design on paper. This part says what was built where
it differs, what the three look passes found, what was measured, and what is
still weak.

## Where the build differs from the paper

- **Gold is kept for the prize.** The ask button is an aurora key ("Find me
  something"), not gold. The gold things are the ring round the winning card,
  the "Tonight's pick" line and the Open key.
- **No skeleton cards.** While Aurora thinks, card backs turn in the reel; the
  old grey placeholders are gone.
- **The gold "Tonight's pick" line shows while the reel slows**, so the side
  next to the reel is not empty during the landing. It fades in on every ask.
- **On a phone, asking now shows something.** Before, pressing "Find me
  something" on a phone changed nothing you could see (the wait and the
  answer were below the fold, under the keyboard). Now the keyboard closes and
  the stage is brought into view, clear of the top buttons and the tab bar
  (their sizes are measured where they stand; no height is written down).
- **Focus goes to Open only when the question was asked with the keys**
  (Enter, a remote). A finger or a mouse keeps its place.
- **The whole hand**: the cards fan out from the middle in even rows (6 cards
  = 3 + 3, never 5 + 1; `handCols()` in public/js/play/reel.js). On a phone
  the hand is a list: a small poster and the reason in full.
- **The hand is dealt unseen while the reel turns** and shown at the win, so
  the heavy part is not built in the middle of the prize moment. Unseen means
  unseen: the keys cannot reach a card before it shows.
- **The page column is centred**, and the "Pick together" ticket at the top
  lines up with the question card under it (it used to run edge to edge).
- **Wide screens**: from 1800 px the stage, the prize and the hand grow (the
  paper said "capped at 980 px"; at 1920 and 2560 that looked tiny).
- **A phone on its side and short phones** have their own layout: the reel is
  sized from the height that is left, and the stage settles itself into view.
- **The question box no longer pulls the page up.** The box takes the focus a
  moment after the page shows. A question asked inside that moment had the
  box take the focus back afterwards and the page jumped up, away from the
  draw. Now the box is left alone once a question is asked. A test asks at
  that instant every time.
- Two new controls are in the controls vocabulary: `pick.open`, `pick.another`.
- New words that exist only on the website (the `DRAW` list in pickforme.js):
  "Tonight's pick", "1 of 6", "Open", "Another one", "The whole hand".

## The three look passes

**Pass 1 — the weak list**
1. Tiny at 1920 / 2560 — fixed (wide-screen sizes).
2. A phone on its side: the stage sat under the top bar — fixed.
3. 320 x 640 with a long title: the keys ended behind the tab bar — fixed
   (the reel is sized from the height; the stage settles into view).
4. The hand was 5 cards and 1 orphan — fixed (even rows).
5. An empty side while the reel lands — fixed (the gold line).
6. Dots still animating, unseen, on a still return — fixed (stopped).
7. A hover ring left on a card after "Another one" — the site's own hover; left.
8. The empty page on a phone on its side scrolls to the question box — the
   browser's own behaviour, as before; left.

Checked and fine: a Hebrew title (right to left), a very long title (three
lines, then cut), a missing poster (the drawn tile), one pick only (no
"Another one", no pips), an empty answer, an error, coming back (the prize
still, no burst), reduced motion, the legacy look, a kids profile.

**Pass 2** — the fixes of pass 1 re-shot at every size; nothing new.

**Pass 3** — no overflow, no page errors; after coming back only the site's
own animations run; one burst per question, none on return.

## Measured

A phone-sized window (390 x 844), the processor slowed four times. This PC was
busy, and slowed-down runs of the same code differ by up to two times, so the
numbers are ranges. 60 is perfect.

| Moment | Before the pacing fixes | After (two runs) | Normal speed, after |
|---|---|---|---|
| Thinking (card backs) | 53 | 52 – 55 | 57 |
| The reel lands, prize, burst | 41 | 51 – 55 | 60 |
| Another one | 39 | 37 – 55 | 60 |
| Scrolling the hand | 49 | 60 – 63 | 66 |

After leaving the page: the same number of frame callbacks as before entering
(the site's own loop), no node of the game left, no animation of the game.

## Still weak (accepted, or not mine)

- One long frame when the reel stops on "Another one" (50 – 270 ms slowed four
  times; not seen at normal speed): the new words are laid out at that moment.
- The site's own always-running work (the sky, the measuring of what is behind
  the top bar) takes a visible share of every frame when the processor is
  slowed. It is shared plumbing; not changed here.
- At 320 px the "Try" chips, once scrolled up, peek under the floating top
  buttons; a three-line title at 320 px slides the reel's corner a little
  under them.
- At 2560 px the question box and the chips keep the site's size while the
  prize grows.
- Coming back to the page starts at the top (the router's rule); the prize is
  restored, still.
- The shots use the test catalogue, which has no real posters.

## Shots and recording

docs/play/shots/pickforme/: `before-*` and `after-*` at 375, 768 and 1440 for
empty, waiting, result, result-scrolled; `after-landing-*`, `after-another-*`;
`pickforme.webm` (21 s: the question, the card backs, the landing, the burst,
"Another one" twice, the hand).

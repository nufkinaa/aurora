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

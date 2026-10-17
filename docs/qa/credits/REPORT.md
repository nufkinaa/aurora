# Credits detection from the picture (feat-credits-cv, from 1.6.100)

Done 2026-10-17. The player's "Up next" time comes from the start of the end credits. This branch adds a computer-vision pass that reads the credits off the picture and fuses it with the existing sources (chapters, audio fingerprint, the skip-time databases).

## Accuracy

Errors in seconds against hand labels; 33 labelled tails from the real library, opened read-only. Show names are anonymised (A–F) because the repository is public.

| Set | Answered | Median | p90 | Max | Within 2 s |
|---|---|---|---|---|---|
| Episodes, today, as the player shows Up next (incl. the 30–90 s guess) | 21/21 | 0.4 | **62** | 67 | 13 |
| Episodes, picture alone | 21/21 | 0.1 | 0.2 | 0.4 | 21 |
| Episodes, after fusion | 21/21 | 0.1 | **0.2** | 0.4 | 21 |
| Films, picture alone (films have no Up next) | 6/6 | 0.2 | 0.7 | 0.7 | 6 |
| Held-out episodes (labelled after tuning), today | 6/6 | 61.5 | 66.9 | 66.9 | 3 |
| Held-out episodes, after | 6/6 | 0.3 | 0.5 | 0.5 | 6 |

- Today's sources: chapters covered 2/21 episodes, audio 2/21 (both 2.5 s late), the databases 14/21 (median 0.2 s, max 2.8 s).
- The big fix is show E: no database entry and no audio match, so Up next came about 62–67 s early on every episode. It is now within 0.5 s.
- Smaller fixes: two audio answers that were 2.5 s late, one database answer 2.8 s late.
- False positives: none. All 33 tails cut just before the credits with 15 s of black added (an episode ending on a cliffhanger) — no answer reached confidence 0.3. Ten 400 s mid-programme windows, dark scenes included, gave a maximum confidence of 0.11.
- Caveat: thresholds were tuned on the 27-title set, labelled by the same agent. The 6 held-out episodes are the only independent check, and they come from two of the same shows.

Labelled set: 21 episodes from 6 shows, 6 films, 6 held-out episodes. Label method: contact sheets of the tail at 4 s, then 0.5 s strips around the change; film labels re-checked with exact single-frame seeks. The label is the first frame of the credits, or of the cut or fade to black that opens them. "Today" is the live server's `data/intro-auto.json` resolved the old way. The labels themselves (with real names) are kept outside the repository; `tools/credits-eval/run.js` re-measures against a labels file.

## How it works (`src/media/creditscv.js`)

- Decode: ffmpeg reads only the last 15% of the runtime (4–25 min) at 2 frames a second, in 384×216 grey, skipping frames nothing depends on (`-skip_frame noref`) and the deblocking filter. Each frame is reduced to per-row counts at once.
- Four tests per frame:
  - text rows with every other row empty — what separates credits from night scenes;
  - a steady scroll of the text rows (names rolling over grey clouds);
  - a still card with a cast portrait;
  - the picture shrunk into a box with names beside it (side-by-side).
- Start time: the strongest continuous stretch of credit-like frames, moved back onto the cut or fade to black that opens it, with a confidence.
- Not used: shot-cut rate (card-by-card credits "cut" at every card, so it added nothing) and audio cues.
- Not done: opening credits / cold opens; only the tail is read.

## Fusion (`chooseCredits` in `introdetect.js`)

1. A chapter titled "Credits" always wins, and the picture pass skips those episodes.
2. The picture's time is used when audio or a database agrees within 8 s (picture confidence ≥ 0.3).
3. A confident picture (≥ 0.6) beats a disagreeing audio or database time.
4. A picture answer with nothing else on file is used from confidence 0.5.
5. Otherwise the old order stands.

The API also reports which source won. The website and TV display code is unchanged; they get the better time.

## Scheduling

- Runs after the existing audio pass and database fill, on every library episode, seasons of one included.
- Each episode takes one background place from `cpuwork.js` (kind "credits", weight 1): lowest OS priority, 2 threads, starts only after no viewer has been encoded for during 20 s.
- A viewer encode starting mid-decode kills the decode on every OS; the episode is retried on a later pass.
- Results are cached per file (mtime) under `cv` in `data/intro-auto.json`. A decode that cannot finish is retried after 7 days.

## CPU cost

Measured on an i7-10700K at 20–45% background load; expect roughly 15–20% more on the i5-10400.
- 0.08–0.14 CPU-seconds per second of video decoded: 42–75 CPU-seconds per hour of programme (median about 53).
- About 23–34 s wall-clock per 45-minute episode on a quiet machine; the Node side is about 0.5 ms per frame.
- The skip options cut CPU to 34–59% of a plain decode.
- The current 33 episodes, once: 25–40 CPU-minutes.

## Tests

- `test/creditscv.test.js` (18): synthetic clips with cards, a scrolling roll, dark endings, lamps, a preview after the names, letterbox and pillarbox, names on a light background, a montage, side-by-side, a portrait card, no credits; the fusion rules; one real ffmpeg round trip; a decode stopped mid-way.
- `test/ui/credits.test.js` (Chrome, private instance): the server's own pass reads a generated clip and Up next appears at 30 s instead of the old 50 s guess, with the scrubber tick in the same place. Screenshots: `before-credits-no-upnext.png`, `upnext-at-picture-credits.png`.
- Root `npm test` and the full `npm run test:ui` each green twice in a row; earlier runs had real-ffmpeg timing and page-load timeouts under load that passed alone.

## Files

New `src/media/creditscv.js`; `src/media/introdetect.js` (picture pass, `chooseCredits`, `cv` carried through every record writer); `src/media/cpuwork.js` ("credits" weight); `public/admin.html` (the "credits detected" stat says how many came from the picture); new `test/creditscv.test.js`, `test/ui/credits.test.js`, `tools/credits-eval/run.js`.

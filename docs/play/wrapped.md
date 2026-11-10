# Aurora Wrapped — "your year in the night sky"

Website, 2026-11-10 (agent `play-wrapped`). Code: `public/js/screens/wrapped.js` (the screen and
the share card), `public/js/wrappedrules.js` (pure words and rules), the Aurora Play kit in
`public/js/play/*.js` + `public/css/play.css` (section WRAPPED). Server: `src/telemetry.js`
`wrappedFor`, `src/routes/profiles.js` `/api/profiles/:id/wrapped`. Shots and recordings:
`docs/play/shots/wrapped/`.

## The idea

Wrapped was a grid of six number cards and a list of roasts. The numbers were right; nothing
*happened*. The redesign keeps every number and every joke and turns them into a story told in
Aurora's own world — the night sky:

- **Every night you watched is a star.** The sky you see behind the story is yours: the streak
  chapter lays every night you watched on a calendar of stars and lifts your longest run out of it
  into a constellation.
- **The reward is the viewer type**, a collectible card dealt face down, held for a drum-roll, then
  flipped — with the one meteor burst of the whole story. You can tilt it under the pointer and its
  foil catches the light.
- **The jokes land one at a time.** The intervention deals its lines like cards on a pile; each one
  slams down on top of the last.
- **And it leaves with you**: the finale is a 1080×1920 picture drawn on a canvas, made to be posted.

Why a story and not a nicer grid: Wrapped is read once in a while, start to finish, usually on a
phone. A story gives each number its own moment, lets motion carry the comparison ("136" alone is
a number; the odometer rolling to 136 and *then* "5 days and 16 hours, back to back" is a feeling),
and builds to a payoff. The plain page is still there for anyone who wants the table.

## Flow

`#/wrapped` → the story plays over the page (a fixed overlay, `js/play/story.js`).

- Segments of progress along the top fill like an aurora ribbon; each chapter moves on by itself
  at a calm pace (6–10 s; the intervention takes as long as its lines need; the finale holds).
- **Tap** the right two thirds / swipe left / → for next; **tap** the left third / swipe right / ←
  back; **press and hold** anywhere to pause (the chrome fades while you hold, as in a camera
  roll); Space or K pauses; Home and End jump; Esc / Back / ✕ closes; pull down on a phone closes.
  "Skip to the summary" is always there ("Skip" on a phone).
- Closing the story shows **All the numbers** — every stat as plain text in cards (the old grid,
  restyled), with **Play the story** and **Share the picture**.
- The page under a playing story is **not drawn until it is closed** (a full first layout of the
  page for nobody to see, measured at ~0.5 s on a throttled phone) — the screen holds its name for
  screen readers until then.

## The chapters (each left out when its data is missing — `chaptersFor`)

| # | Chapter | What moves | Needs |
|---|---|---|---|
| 1 | **Opening** — "Maya, your sky is ready." since <date> (the honesty about the window stays), nights · sittings · titles | the words rise in turn; one meteor crosses the sky | — |
| 2 | **Hours** — a gold odometer to "136", "hours watched", then what it feels like (`hoursFelt`: days back to back, London–Sydney flights, feature films…) | the wheels roll, units spinning most, landing left to right; the comparisons arrive after the number lands | — |
| 3 | **Your number one** — a hand of the top five posters | dealt and fanned (1 s), gathered face down, shuffled, then the winner flips back up to the front and glows; the others fall back dim | a top title |
| 4 | **The podium** — 2 · 1 · 3 on pedestals, 4 and 5 below | pedestals grow; posters drop in **third, then second, then first** (suspense) | 3 titles |
| 5 | **Genre DNA** — "Mostly Drama, with a Sci-Fi streak." | the bars **race**: the runners-up lead early, the winner surges at the end and turns gold | 2 genres |
| 6 | **Your night** — "Saturdays, 9 pm." the week as seven columns and the day as a 24-hour dial | columns grow in turn; the dial's spokes sprout round the clock; the winner of each is gold | 3 sittings + the server's hour/weekday totals |
| 7 | **The streak** — "13 nights in a row" | every night you watched fades in as a star on a calendar (one column a week); the streak's nights **fly out of the calendar** into a constellation, then its lines are drawn one by one; the brightest night is gold and labelled | a streak of 2 + the server's nights |
| 8 | **Longest sitting** — "3:41 hours, in one go" | the clock rolls, the ribbon fills against hour ticks, a quip lands ("Your couch would like a word.") | 2 sittings, ≥ 20 min |
| 9 | **Your viewer type** — the collectible | face down, a shimmer passes twice, it wobbles (drum-roll), flips, **meteor burst** + haptic tick; then the verdict in the roast's voice; then the card tilts under the pointer with a foil sheen (and sways by itself on touch) | — |
| 10 | **The intervention** (kids: **The highlights**) | each line slams onto a pile, the earlier ones pushed back | — |
| 11 | **Finale** — the share card and Share / Replay / All the numbers | the card pops in | — |

A one-sitting year runs Opening → Hours → Number one → Viewer type → Intervention → Finale.
Nothing watched: the **teaser** — a face-down card with a "?", "Your sky is still dark, Noa.",
the locked chapters as chips, and "Find something to watch".

## The viewer type (`viewerType`, tested in `test/wrapped-rules.test.js`)

Each rule scores how far past its bar the stats go (1 = just there); the highest wins, a tie goes
to the earlier row; fewer than three sittings is always The Newcomer; nothing past its bar is The
Casual. Deterministic — the same year is always the same card.

| No. | Type | Bar (score = stat ÷ bar) | Verdict |
|---|---|---|---|
| 01 | The Night Owl | 5 sittings after midnight, or 20 % of the hours started 0–5 am | Your bedtime is a rumour. The moon thinks you work together. |
| 02 | The Marathoner | a 5-hour day, or a 3-hour sitting | Breaks are for people with less ambition. |
| 03 | The Loyalist | 40 % of the hours on one title | You found your show and you are not leaving. Ever. |
| 04 | The Creature of Habit | a 9-night streak | Same time, same couch, same you. The couch wants partial custody. |
| 05 | The Finisher | ≥ 3 finished and 60 % of started-or-finished finished | You actually finish things. Suspicious, but impressive. |
| 06 | The Sampler | ≥ 8 titles over ≥ 10 sittings, 35 % titles per sitting | Three episodes and a vibe. Next! |
| 07 | The Genre Hopper | ≥ 4 genres, the top one ≤ 30 % | No genre can hold you. Your taste has a passport. |
| 08 | The Weekend Warrior | 62 % of the hours Friday–Sunday | Monday to Thursday you're a citizen. Friday, a legend. |
| 09 | The Pocket Watcher | 60 % on a phone | There's a big TV in the house and you chose a phone. Iconic. |
| 10 | The Newcomer | < 3 sittings | Every legend starts with a pilot episode. |
| 11 | The Casual | nothing past a bar | A little here, a little there. Very healthy. Slightly boring. |

Each type has its own small constellation (the card's art) and a kinder verdict for kids.

## Kids profiles

Today's Wrapped had no kids rule (a kids profile was roasted like anyone). Now: the same story and
the same types, kinder verdicts, and "The highlights" (`kindWordsFor`) in place of the roasts —
never a roast to a kids profile, whatever the server sends.

## The roasts

`interventionFor`: the server's own `w.roasts` (branch `remarks`: a bank that says something
different each visit, up to four ready lines) used **as sent** when it is a non-empty array; else
the local rules (`roastsFor`, the same sentences as the phone's `wrappedWords.ts`). A 140-character
line fits the card at 375 px (tested).

## The share card

1080×1920, drawn on a canvas (`paintShareCard`, the kit's `sharecard.js` helpers, no libraries):
the night sky with aurora light, "AURORA WRAPPED", the profile's name and "since <month year>",
the hours in gold, the viewer type with its constellation and verdict, the number one with its
poster (same-origin, or a drawn stand-in), three tiles (top genre, best streak, your night), the
mark. Heights flow from the content (two-line names and verdicts are measured). **Only the
profile's own name and its stats** — no other profile, no device, no address, no roasts.
Share: the Web Share sheet with the picture where the browser can share files (phones), else the
picture is downloaded (`aurora-wrapped-<name>.png`) with a toast. Painted once, during the
intervention, so it is ready by the finale without a long task in the middle of a reveal.

## Reduced motion, keyboard, screen readers, TV browsers

- `prefers-reduced-motion`: the page first; "Play the story" plays it **still** — every chapter at
  its final state (the deal shows the winner in front, the odometer the number), no auto-advance,
  no pause button, moved by hand. Nothing animates (tested with `getAnimations()`).
- The story is a `role=dialog` with its own focus scope (the app's `focus.js`): arrows and Back come
  through the app's key hub, so a TV remote in a TV browser works the same; Tab stays inside.
  Visible focus rings; every control is a real button.
- A live region says each chapter in words ("3 of 11. Your number one: Northern Static, 45 hours.").
- Hebrew / long titles: `dir=auto` everywhere a title is shown; titles clamp to two lines; the share
  card wraps and ellipsises by measurement.

## Sizes

320 px phones to 2560 desktops. Short phones and phones on their side: chapters scroll when still,
the podium and genres compact, the viewer-type card goes beside its words. Big screens (≥ 1800×1000,
≥ 2300×1300) multiply the stage by `--play-scale` (1.3 / 1.65) so a TV or a 4K monitor gets a
bigger story, not an emptier one. Both looks: the story brings its own room, so glass and legacy
look the same.

## Performance (390×844, CPU ×4, rAF frame intervals per chapter)

Measured with a frame counter under CDP CPU throttling ×4 on this (busy) PC, legacy look:
p50 17.3–17.5 ms in every chapter (≈ 57–60 fps), p95 17.6–19 ms in 8 of 11 chapters, ~35 ms in the
opening and the streak (the chapter builds). Motion is transform/opacity on the compositor; the
canvas work (stars painted once, the meteor burst, the share card) is bounded. While the story
covers the page, the page holds still and its own room is hidden; after leaving, no animation of
Wrapped remains (`fps.js`/tests check `getAnimations()`).

**Open (outside this lane):** in the glass look the global sky (`aurora-sky.js`) keeps painting
under the story — at CPU ×4 that halves the frame rate (p95 70–120 ms). The sky already sleeps
under the player (`covered()` checks `.player`); one line there to also sleep under `.play-story`
fixes it. Left to the orchestrator, who owns that file this round.

## For the phone and TV ports

The rules are pure and ready to port 1:1 (`wrappedrules.js` → `tv-native/src/phone/wrappedWords.ts`
already holds `roastsFor`): `hoursFelt`, `viewerType` (the table and the constellations),
`kindWordsFor`, `interventionFor`, `chaptersFor`, `skyLayout`. The server fields are shared.
See the final report for a per-chapter parity note.

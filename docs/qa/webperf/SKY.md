# The glass sky while a computer scrolls (2026-11-10)

elia: "when scrolling on desktop the background stops and then comes back (it has falling stars and more things you already know) and it looks not so good".

## Cause

One paint of the full-window sky on a computer costs 12–30 ms. A sky that dear holds its frame for as long as the page is scrolled (the hold in `aurora-sky.js`: a paint must not land in the scroll's own frames). On a phone that hold is a rare 150 ms; on a computer it was every scroll, for the whole scroll.

`node tools/webperf/skywatch.js --instance <state> --label before` — at rest for 4 s, then a six-second wheel scroll:

| window | at rest: paints a second | while scrolled: paints a second | longest wait between two paints | one paint |
|---|---|---|---|---|
| 1440x900 | 11.3 | **0** | 6067 ms | 12.6 ms |
| 1920x1080 | 11.4 | **0.2** | 3827 ms | 15.2 ms |
| 2560x1440 | 11.2 | **0.3** | 4327 ms | 21 ms |
| 3840x2160 | 11.2 | **0.7** | 2798 ms | 30.9 ms |

## Change

The painter and its clock moved, unchanged, to `public/js/aurora-sky-core.js`. `aurora-sky.js` keeps the page's side (is the sky shown, is motion wanted, how big is it) and chooses where the painting happens:

- **a worker** (`aurora-sky-worker.js`) for the glass look's page sky on a computer — `initAuroraSky(canvas, { offMain: true })` in `main.js`, taken only when the device is not a phone, not weak, and the browser can hand a canvas to a worker. No hold there: the paint costs the page's thread nothing.
- **the page's own thread**, exactly as before, everywhere else: phones, the sign-in / reset / install skies, a browser without `OffscreenCanvas`, and any time the worker does not answer (4 s), fails to load or cannot draw — a canvas already handed over is replaced by a copy.

The cadence rule is the same (33 / 50 / 83 ms by what a paint costs), so the sky moves as it did at rest.

## After

`--label after`, the same run (`worker: true` at every size):

| window | at rest: paints a second | while scrolled: paints a second | longest wait between two paints |
|---|---|---|---|
| 1440x900 | 11.3 | **11.4** | 101 ms |
| 1920x1080 | 11.4 | **11.5** | 98 ms |
| 2560x1440 | 11.3 | **11.5** | 99 ms |
| 3840x2160 | 11.3 | **11.2** | 98 ms |

## The same picture

`node tools/webperf/skyproof.js --instance <state>` — one seed, the same moments (two paints, a shooting star in flight; and the reduced-motion still frame), at 1440x900, 1920x1080, 2560x1440 and a 390x844 phone. The canvas's own pixels: old painter = today's on the page = today's core in a worker. What the screen shows: old = page = the app's worker. **Identical everywhere, 0 pixels differ.**

## The scroll's own frames

`node tools/webperf/scrollview.js --bare --line none [--sky page]` (`--sky page` keeps the sky on the page's thread: the behaviour before). 15 scrolls a side at 1440x900, interleaved, **on a PC that was at 100 % CPU from other work the whole time** — so read it as "no large difference", not as a fine measurement:

| | frames later than 20 ms (median of runs) | range | 95th percentile frame |
|---|---|---|---|
| sky on the page (held while scrolling) | 1.3–1.8 % | 0.2–11 % | 18.2 ms |
| sky in the worker (painting through the scroll) | 2.5–3.6 % | 0.7–5 % | 18.8 ms |

The sky now does work during a scroll that it did not do before (12 paints a second on another core, and the compositor shows each one), so a small cost is plausible. To repeat on a quiet machine before release. If it is real and matters, the next step is the paint's cost itself: its per-column loops grow with the window's width although the canvas is capped at 1920 px (30 ms at 4K) — that would change pixels, so it is not done here.

## Tests

`test/ui/webperf.test.js`: the sky's cadence in its worker and on the page's thread; it goes on painting through a three-second scroll on a computer; a worker that fails to start leaves the sky painting on the page; the worker rests in the classic look and wakes when glass is back. 9/9, twice. `test/jsassets.test.js` 16/16. (`test/ui/leaks.test.js` fails its first case on and off on this loaded machine — with this change 2 of 5 runs, without it 2 of 2 that ran.)

A tool that wants to see the sky's paints sets `window.__auroraSkyWatch = true` before the page loads and listens for `aurora-sky-paint` on `window` (`detail: { cost, at }`); a worker's canvas cannot be watched through the page's canvas functions.

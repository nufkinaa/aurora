# The website's pictures while scrolling on a desktop (2026-11-10)

elia: "when scrolling on web desktop the loading is not nice and choppy can you
investigate and fix?"

## What was wrong

The frames were fine (60 a second on Home, before and after). The pictures were not:

1. **Asked for too late.** A poster below the screen is `loading="lazy"`: the browser
   asks for it when its shelf comes within about 1250 px of the screen. A mouse wheel spun
   briskly covers that in a third of a second; a picture from a server 70 ms away takes
   100–250 ms. So the scroll arrived before the pictures did.
2. **Every one of them sharpened in, in view or not.** A poster that took more than
   120 ms to arrive played its 0.4 s blur-up (or its fade) — also when it arrived while
   still off screen. A card then scrolled into view half-way through its effect, and a
   screenful of them did it together: 15–24 posters coming into focus at once is what
   read as "choppy".
3. **A shelf's cards past its right edge were never asked for** until the shelf was
   paged (they are not even built until then), so every press of a shelf's arrow met a
   row of empty tiles.
4. **A layer per poster.** The finished blur-up animation kept `filter: blur(0)` on the
   poster (`animation … both`), and a filter gives an element a compositor layer of its
   own: on this PC's own server 172 layers / 171 MB on Home after one scroll, 47 / 110 MB
   with the filter let go.

## What changed

| | where | what |
|---|---|---|
| a | `public/js/warm.js` (new), `ui.js` posterImg | **Pictures ahead of the scroll.** Once the pictures on screen are in and the browser is idle, the posters the page has built are asked for, four at a time (two while the page is being scrolled), in the order the page built them, at most 240 a screen. Asking = switching that `<img>` from lazy to eager: the browser's own request, the same address, the same cache. |
| b | `ui.js` posterImg `reveal`, `inSight` | **Only a picture that lands in front of the person comes into focus.** One that arrives out of sight (further down, past its shelf's edge, in a shelf the browser is not drawing) is simply there when it is scrolled to. All devices. |
| c | `components.js` `restOnHover`, `fillRowLater` | **A mouse resting on a shelf (150 ms) builds the rest of it,** and those pictures go to the front of the queue — so the shelf's arrow pages onto pictures. A shelf wheeled past under a pointer standing still is not built: cards are not made while the page moves. |
| d | `glass.css` `.img-blurup.img-in` | **No filter left on a finished poster** (no forwards fill). All devices. |

(a) and (c) are for a desktop only — a mouse (`hover: hover` and `pointer: fine`) and a
window at least 900 px wide — and only when it costs nothing a person would miss: not on
a slow line (`net.js lite()`, a 2g/3g hint), not under Data saver, not in a background
tab, not offline, not while a film plays. A phone's own lazy-load already reaches two
screens ahead and its data is not ours to spend; the TV apps are not this code. Phones
and tablets do get (b) and (d).

Nothing is fetched that the page had not already decided to show: the queue only holds
posters that are built and waiting. A screen left behind drops its queue
(`aurora-route-start`).

### One thing kept on purpose: `img-late`

The held `filter: blur(0)` had a second effect nobody chose: a filtered element paints as
a layer of its own in its card's stacking order, so a poster that had sharpened in sat
**over** its card's one-pixel hairline, while a poster that was there at once (from the
cache) sat **under** it. Taking the filter off would have made the hairline appear on
every sharpened poster — a visible change, if a one-pixel one. So a poster that took more
than 120 ms to arrive is marked `img-late` (the same test that decides whether it
sharpens), and `.img-blurup.img-in.img-late { isolation: isolate; }` keeps its place in
the stacking order without the compositor layer. Under `data-fx="lite"` and reduced
motion there was no animation and so no filter before; there `isolation` is `auto`, as it
was. (Whether the hairline should show on all posters or none is a design question left
alone here.)

## Measured

A private Aurora (`tools/mobile-perf/instance.js`: Home with 15 shelves, 272 cards) behind
`tools/webperf/slowproxy.js --rtt 70 --mbit 50` (nufurora.com is about 70 ms from here),
Chrome 154 headless on this PC's GPU, 1440×900, `tools/webperf/scrollview.js`, five runs a
side, medians. "on time" = the poster's picture was fully in when the card came into view.

| scroll | | before | after |
|---|---|---|---|
| first visit, 4 s at the top, then 3000 px/s | on time | 66 % | **100 %** |
| | most posters sharpening at once | 15 | 3 |
| | lateness (p90) | 192 ms | 0 ms |
| | pictures fetched during the scroll | 45 | 0 |
| first visit, 6000 px/s | on time | 87 % | **100 %** |
| | most sharpening / most empty at once | 24 / 10 | 2 / 0 |
| scroll 1.5 s after the page opens, 3000 px/s | on time | 59 % | **100 %** |
| | most sharpening at once, lateness (p90) | 18, 242 ms | 3, 0 ms |
| scroll 0.6 s after the page opens | on time | 51 % | 90 % |
| | most sharpening at once | 17 | 12 |
| wheel notches, 100 px every 40 ms | on time | 100 % | 100 % |
| second visit (pictures in the cache), 3000 px/s | on time | 100 % | 100 % |
| Data saver, 3000 px/s (no pictures ahead: only b) | on time | 65 % | **100 %** |
| | most sharpening at once, lateness (p90) | 14, 190 ms | 3, 0 ms |

Under Data saver the pictures are still fetched during the scroll (52 of them, 45 before) — "on
time" there means they arrive while the card is still below the screen and no longer
replay their effect when it gets there.

Someone who scrolls within half a second of the page opening still outruns the queue
(it waits for the pictures on screen first): 90 % against 51 %, within the noise of
that scenario. Nothing is worse there; it is simply not solved by this.

**Frames** (`--bare`: the frame times alone, without the cost of counting posters every
frame; 3000 px/s, three rounds with the sides alternated, four runs each, 60 Hz):

| | | before | after |
|---|---|---|---|
| first visit | frames over 25 ms (median of a round) | 2 / 1.5 / 1.5 | 0 / 1 / 1 |
| | 99th percentile frame | 26 ms | 18 ms |
| | worst frame of any run | 140 ms | 36 ms |
| second visit | frames over 25 ms, worst frame | 0, 18–19 ms | 0, 18–19 ms |

The old build's first run after its server starts decodes 53 pictures in the middle of
the scroll (8–12 late frames, 52–140 ms); the new one has them decoded before the wheel
moves. With the pictures cached the two are the same to the frame. (An earlier reading of
"more late frames after" on a second visit was the watcher itself: it does more work per
frame the more pictures are in, which is what `--bare` is for.)

Chrome's network emulation (CDP) is not felt by requests that go through a service
worker — which is every picture on this site — so a far server has to be a real proxy:
`slowproxy.js`. `page.mouse.wheel` tops out near 1500 px/s; `--speed` uses Chrome's own
scroll gesture.

## Proofs that nothing looks different

Three, because each sees something the others cannot.

1. **The held filter against nothing held** — `tools/webperf/fillproof.js`. One page of
   the old build, every poster in view sharpened and still holding its filter;
   photographed twice (the noise floor: 10 of 10 shots identical once the four things
   that never stop moving — the two washes of light behind the page, the dot on New, the
   shine on the greeting — are stopped), then the animation is taken off those posters on
   the same page and it is photographed again.
   - with nothing in its place: all 10 shots differ — a one-pixel ring around every poster
     (3,700–62,000 pixels a shot, up to 72–147 of 255). This is the hairline described
     above, and why `img-late` exists.
   - with `isolation: isolate` in its place: 8 of 10 shots have **no** pixel off by more
     than 5 of 255 (the compositor's rounding, invisible); the two phone shots of Home
     have 7 and 9 pixels in one row, the tail of a "y" in a shelf's title that the old
     poster layer clipped by a fraction of a pixel and that is now whole.
2. **The two builds, every poster brought into view** — `tools/webperf/endproof.js`,
   both behind a 200 ms round trip so that every picture is late in both. Home at four
   depths, Movies and Shows at two, desktop and phone: 16 shots a build, twice each. Two
   runs of the old build differ from each other in 13 of the 16 (a chip in the phone's
   top bar that depends on a timer; nothing above 20 pixels on the desktop). Between the
   builds, where the old build agrees with itself: nothing on 3 shots, and on the others
   a few to 300 pixels — the same single row of the title's "y" on the phone, the
   compositor's rounding (up to 16 of 255, single pixels), and the edge of the lettering
   inside one poster's own picture (94–286 pixels, up to 33 of 255, one poster a shot:
   the two test servers encoded that picture's file a hair differently).
   A freshly started server's first run is thrown away: it answers with another encoding
   of every picture until it has made its sizes.
3. **Everything else on the site** — `bash tools/webperf/shots.sh b8ac3d35 WORKTREE
   scrollfix --devices desktop-1440,phone-390 --looks glass,legacy` (pictures held to a
   plain end state, so it says nothing about how they arrive — only that nothing else
   moved): 92 shots a pass, two passes a build. The old build's two passes agree with
   each other on 76 of the 92 (16 differ, none above the anti-aliasing threshold, at
   most 7 of 255). Old against new: 82 of 92 identical, 10 differ, none above the
   threshold — every difference is 1 of 255.
   (`tools/mobile-perf/shots.js` holds every picture to a plain state for this, and had
   to learn the new rule: it stripped the old build's held filter but not the
   `isolation` that replaces it, and so first reported the hairline on 16 shots, up to
   72 of 255. Its hold now sets `isolation: auto` as well.)

And the layers: Home after a scroll through the page, 119 compositor layers / 146 MB
before, 35 / 105 MB after (`LayerTree` over CDP, the same far server).

## Tests

- `test/warm.test.js` — the queue: order, how many at once, the per-screen limit, a slot
  given back by a picture that never answers, a screen left behind, what `first` does.
- `test/ui/scroll-pictures.test.js` — on a desktop the last shelf's posters arrive with
  the page at scroll 0 and are set to be simply there; a mouse at rest builds a shelf's
  tail and its pictures come before it is paged; shelves wheeled past under a still
  pointer are never built while the page moves, the one it stops on is; under Data saver and on a phone nothing
  is asked for ahead; a poster that lands in view sharpens once and is left with no
  animation and no filter, marked `img-late`.
- `test/ui/picture-priority.test.js` — a held poster released late in view still comes
  into focus; one far below is fetched ahead on a desktop and not on a phone.

## Tools (`tools/webperf/`)

- `scrollview.js` — what a person sees while scrolling: posters in view without their
  picture, how many are sharpening at once, how late each was, frames over 25 ms
  (`--bare` for the frame times alone), pictures fetched during the scroll.
- `slowproxy.js` — a real far-away server in front of any instance.
- `fillproof.js` — the pixel proof for (d), on one page: with the held filter, then
  without it (`--with "isolation: isolate;"`).
- `endproof.js` — the pixel proof for the whole change: two builds, every poster brought
  into view, photographed once everything has arrived.

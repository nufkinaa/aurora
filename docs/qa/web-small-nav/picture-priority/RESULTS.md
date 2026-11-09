# Picture priority: the pictures on screen first

Branch `web-small-nav-img`, from master `126fbf40`. elia's ask: the pictures the person can see now, the billboard included, load first; the rows out of view load after, lazily. Invisible work only: nothing may look or behave differently.

## What was wrong (measured on master)

Opening Home cold on a phone (390×844, CPU ×4, fast 3G), the browser asked for **31 posters out of view, 827 KB, at the same moment as the 2–3 pictures on screen**. Three causes:

- Chrome's lazy-load reaches 1250–2500 px past the screen on a 3G line: every poster of the next six or seven shelves started with the first one.
- Home marks the first 3 cards of its first 3 shelves `loading="eager"`. At the top of Home only shelf 1 is on screen on a phone, and none on a 1440×900 desktop (the billboard fills it): 6–8 eager posters out of view.
- On a portrait phone the nav tint's probe downloaded the 780 px landscape backdrop (62–82 KB) that the phone does not show, at the same moment; the classic look's poster card (hidden under 900 px) was downloaded too.

On a desktop on slow 3G, the 200 KB billboard picture shared the line with ~35 posters and arrived after 23–26 s.

## What changed

- `public/js/ui.js` ("the pictures on screen first"): while a screen's first pictures are on their way, `posterImg` creates a poster that this page has not shown yet without its address. A poster known to be in view gets its address at once with `fetchpriority="high"`, and the screen waits for it. "In view" is known three ways: Home says so right after its first shelves are placed (`releaseInView`, same task, as eager cards always were), a ResizeObserver in the first frame that lays the poster out (where the browser's own lazy-load decides), an IntersectionObserver for one that comes into view later. When every picture in view and the billboard's (`pictureWait`) has arrived or failed, every waiting poster gets its address exactly as before: lazy stays lazy (the browser's rule then decides), eager loads at once. The gate closes again for each new screen (`aurora-route-start`). A touch, scroll, wheel or key lets everything go at once, so a person who scrolls meets the same lazy-load as before. With no progress for 15 s (30 s at most) it lets go anyway.
- `public/js/screens/home.js`: the billboard preload counts as a picture on screen; `releaseInView` after the first shelves; the classic look's hero poster card gets its picture after the pictures on screen when the screen is ≤ 900 px wide, where CSS hides it.
- `public/js/artUpgrade.js`: a phone's sharp billboard poster counts as a picture on screen; idle upgrades wait until the pictures on screen are in.
- `public/js/prefetch.js`: the title prefetch's art waits for the pictures on screen. `public/js/glassTone.js`: so does the nav tint's probe, whose result only clears a layer.
- Nothing else: same pictures, sizes, attributes (`fetchpriority="high"` is added to the posters asked for in view), classes, fades and placeholders. A waiting poster shows what a poster on its way always showed.

## Before → after

`tools/webperf/pictures.js`. Private `tools/mobile-perf` instances (400 made-up titles, made-up pictures), master and this branch side by side. Real Chrome (playwright-core, channel chrome), headless, CPU ×4, Chrome's line emulation: fast 3G 3 Mbit/s and 150 ms, slow 3G 400 kbit/s and 400 ms. Cold load of Home each time (no HTTP cache, no service worker), "Full quality" data mode. **5 runs a side, interleaved, medians.** Times are ms from navigation start. Each device and look gets an unmeasured warm-up visit first, so the server has cut every picture already. The billboard does not turn during the measurement (desktop slow 3G was re-run that way). The machine was at 100 % CPU from other agents the whole time, so trust the pairs, not the absolute numbers.

"Every picture in view in" means every `<img>` in the viewport has loaded and `decode()`d, and the billboard's picture has arrived. "From Home's shelves placed" is the same moment counted from Home's own `aurora-home-rows` mark, which leaves out the boot's noise.

| device | look | line | billboard picture in | every picture in view in | …from Home's shelves placed | first out-of-view picture asked for (finished requests) | out-of-view pictures loaded before the view was in (n / KB) | layouts |
|---|---|---|---|---|---|---|---|---|
| phone-390 | glass | fast3g | 2234 → **2259** | 2922 → **2624** | 785 → **412** | 2163 → 2589 | 31 / 827 → **0 / 0** | 84 → 73 |
| phone-390 | glass | slow3g | 9394 → **8575** | 11088 → **9497** | 4770 → **3005** | 6297 → 9369 | 4 / 116 → **0 / 0** | 49 → 46 |
| phone-390 | legacy | fast3g | 2249 → **2258** | 2871 → **2550** | 787 → **384** | 2085 → 2534 | 26 / 663 → **0 / 0** | 75 → 48 |
| phone-390 | legacy | slow3g | 8890 → **8304** | 11412 → **9236** | 5138 → **2817** | 6096 → – | 12 / 317 → **0 / 0** | 58 → 47 |
| phone-360 | glass | fast3g | 2251 → **2236** | 2895 → **2585** | 794 → **411** | 2103 → 2564 | 28 / 745 → **0 / 0** | 78 → 62 |
| phone-360 | glass | slow3g | 9083 → **8634** | 11219 → **9475** | 5031 → **3032** | 6296 → 9337 | 3 / 89 → **0 / 0** | 48 → 46 |
| phone-360 | legacy | fast3g | 2248 → **2244** | 2870 → **2533** | 774 → **376** | 2098 → 2523 | 26 / 663 → **0 / 0** | 76 → 49 |
| phone-360 | legacy | slow3g | 8786 → **8275** | 11349 → **9210** | 5105 → **2807** | 6092 → – | 12 / 317 → **0 / 0** | 59 → 46 |
| desktop-1440 | glass | fast3g | 3652 → **2829** | 3652 → **2829** | 1517 → **585** | 2130 → 3162 | 58 / 987 → **0 / 0** | 105 → 93 |
| desktop-1440 | legacy | fast3g | 3437 → **2885** | 3437 → **2885** | 1312 → **676** | 2125 → 2896 | 56 / 926 → **0 / 0** | 106 → 68 |
| desktop-1440 | glass | slow3g | 25951 → **12117** | 25951 → **12117** | 19624 → **5557** | 6339 → 12127 | 38 / 674 → **0 / 0** | 175 → 54 |
| desktop-1440 | legacy | slow3g | 22957 → **13412** | 22957 → **13412** | 16633 → **6956** | 6327 → 13420 | 34 / 566 → **0 / 0** | 138 → 48 |

- **Pictures in view: 10–12 % sooner on a phone on fast 3G, 14–19 % on slow 3G.** Counted from the shelves being placed they take 37–51 % less time (fast 3G 785 → 412 ms, slow 3G 4770 → 3005 ms, glass, phone 390). On a desktop the billboard arrives 16–23 % sooner on fast 3G and **about 2× sooner on slow 3G** (26.0 → 12.1 s glass, 23.0 → 13.4 s classic).
- **Pictures out of view loaded before the view was in: 26–58 requests (0.6–1 MB) → 0 in every cell.** They now start right after the view is in: the third column moves from ~2.1 s to 2.5–3.2 s on fast 3G, and to 9.3–13.4 s on slow 3G. On slow 3G only finished requests have a Resource Timing entry, so master's counts there undercount (in-flight ones are left out).
- The phone billboard's own picture is the same within noise on fast 3G. It was already preloaded at high priority before any card.
- Layout passes in the window are fewer (84 → 73 on a phone, 175 → 54 on desktop slow 3G), because fewer pictures arrive while the page is still being built. Home's first shelves now cost one layout earlier, in the same task (`releaseInView`, 40–210 ms at ×4 under load, work the first frame would otherwise do). Measured on one instance with each mode: with it, the pictures in view arrived 200–280 ms sooner than with the ResizeObserver alone (`tools/webperf/pictures.js`, 4 runs, phone and desktop), so it stays.
- LCP as the harness cuts it (before the billboard first turns, shelves + 8.5 s) looks worse on desktop slow 3G (9.8 → 12.3 s). That is the cut-off: on master the billboard picture arrives after the cut, so the LCP recorded is the headline text. Its real largest paint is the 26 s picture.

Raw runs (every run, both sides): [`pictures-ab.json`](pictures-ab.json).

## Pixels

`bash tools/webperf/shots.sh 126fbf40 WORKTREE picprio --devices desktop-1440,phone-390,phone-360x800,tablet-820 --looks glass,legacy --extra-wait 4000`: `tools/mobile-perf/shots.js` photographs every route and state at rest (top, one and three screens down, a shelf swiped, Search typed), 4 sizes × 2 looks, **184 screenshots a side**, each side twice. Both sides are served the same picture bytes. `diff.py` counts a pair identical when any run of one side equals any run of the other. Threshold: a pixel differs visibly above 8/255.

| comparison | identical | differ | worst |
|---|---:|---:|---|
| master against master (noise floor, `a1` vs `a2`) | 172 / 184 | 12 | 7/255, desktop poster corners |
| branch against branch (`b1` vs `b2`) | 171 / 184 | 13 | 3/255, desktop poster corners |
| **master against this branch** | **174 / 184** | **10** | **3/255, 0 above threshold** |

Every one of the 10 differing files also differs between two runs of the same version, in the same place: the anti-aliased edge of a rounded poster corner on desktop. Reports: [`diff-master-vs-branch.json`](diff-master-vs-branch.json), [`diff-master-vs-master.json`](diff-master-vs-master.json), [`diff-branch-vs-branch.json`](diff-branch-vs-branch.json). A representative subset of the screenshots, before and after, is in [`shots/`](shots/), downscaled to half size as JPEG to keep the folder small. The proof is the full-size PNG diff above. The same 10 harness states "did not settle" in 25 s on both sides (a phone-360 glass Home scrolled, a swiped shelf); they were photographed the same way on both sides.

The screenshots were taken at `1dc3e917`. The later commit only lengthens the stall timer (6 → 15 s), which has no effect at rest.

## Tests

- New `test/ui/picture-priority.test.js` (3 tests). Desktop and phone: a poster out of view has no address while the one in view (fetchpriority high, its own `loading` kept) is held back by the test's server. It gets its address, still lazy and without a priority of its own, the moment that one arrives. `afterPictures` waits too. A new screen holds again, a touch lets go, and a picture already shown never waits. Desktop Home: no card poster is asked for before the billboard's picture has arrived, judged from the server side. It fails on master's behaviour (checked by switching the holding off).
- Run twice each, green: picture-priority, images, home-fresh, webperf, title, library, kids, leaks, taste, navigation. Title: one run had 1 failure, "a rating given on the title page is kept": the rating read back before it was saved, an existing race. It passed 2/2 rerun alone.
- Whole `npm run test:ui` once under `ui-lock` (ui.js is shared plumbing): **584 pass, 0 fail, 1 skipped**.
- Root tests by the selector (13 files: airdates, avcaps-server, ci-select, household-server, img-ext, jsassets, keeper-server, phoneapp-server, shell-cache, store-recovery-server, tel-contract, tvtuning-server, web-imports): 89/89 twice.

## Not verified

- A real phone on a real radio. Everything above is Chrome's emulation on this desktop. Safari has no `fetchpriority` before 17.2 and its own lazy-load distances. The gate itself only needs IntersectionObserver, which has been there since 12.1, plus ResizeObserver from 13.1. Without either it degrades to the old behaviour.
- HTTP/2 through the public front. These runs talk HTTP/1.1 to the instance. Over h2, master's requests would all be in flight at once and share the line by the server's stream scheduling. This change takes the out-of-view ones off the line entirely, so the gain should be similar or larger.
- On this harness every library cover's cut takes up to 2.5 s server-side: the made-up covers are under 512 bytes, and the server keeps such a cut for 30 s only (`src/lib/imgvariant.js`). `pictures.js` re-asks for them before each run. It is a test-data artefact, not seen with real covers.

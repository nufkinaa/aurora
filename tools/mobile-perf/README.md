# Mobile performance harness

Measures the Aurora website the way a weak phone on a weak line meets it, and proves that a change did not move a pixel. Everything runs against a private, throwaway instance (the UI tests' own — `scripts/ui-test-server.js`): never the live server, never anyone's data, nothing leaves the machine.

```
cd tools/mobile-perf && npm install        # Lighthouse, into this folder only
```

Needs what the UI tests need (Node 20+, Chrome, ffmpeg) plus Python 3 with Pillow (made-up artwork, screenshot diffs) and `openssl` on PATH (a self-signed certificate for the HTTP/2 front; Git for Windows has one).

## The instance

`node instance.js` starts it and leaves it running (the other scripts pick it up from `.cache/instance.json`; without one each script starts and stops its own). It is the UI tests' instance with three additions:

- **A catalogue.** `fixture-preload.js` answers the server's lookups to Cinemeta and its picture host from `catalogue.js` — 400 made-up titles — so Home has a billboard and ~17 shelves / ~290 cards, Movies and Shows have paged grids, title pages have episodes. (The live Home is 10–14 shelves, ~240 cards, ~90 KB of JSON; this one is a little heavier on purpose.) Every other outside host is still refused, as in the tests.
- **Pictures that weigh what real ones weigh.** `make-art.py` draws 240 posters, 48 backdrops and stills with Pillow, tuned so the server's `?w=` WebP sizes land in the range measured on the live server (a phone poster 9–25 KB, a 780 px backdrop ~75 KB). They go through the real `/img/ext` cache, resizer and blur-up placeholders.
- **Two profiles with fixed ids**, "Glass" and "Legacy" (one per look), no password, each with something half-watched, a list, ratings and liked genres. Fixed ids matter: Home's daily sampling is seeded by profile id, so two instances serve the same Home.

`node snapshot.js <git ref>` unpacks another commit beside this one; `node instance.js --repo <that folder> --state .cache/before.json` runs it, and every script takes `--instance .cache/before.json`. That is how "before" and "after" are measured in the same hour on the same machine.

`bash stop.sh` stops by-hand instances (only those).

## The line and the phone

- **HTTP/2, like the public site.** `front.js` is an HTTPS/HTTP-2 reverse proxy in front of the instance (the public site sits behind Caddy; a phone on mobile data talks h2 to it). `--front h1` measures the server bare, as on the home network.
- **A slow line that is really slow.** `tools/throttle-proxy.js` (the repo's own) between browser and front: one shared bandwidth budget and added latency for every byte, the service worker's and the TLS handshake's included. Profiles (`lib.js`): `slow3g` 400 kbit/s · 400 ms, `regular3g` 1.5 Mbit/s · 300 ms, `fast3g` 3 Mbit/s · 150 ms. `--loss 2` drops 2% of connections.
- **A slow phone.** Chrome's CPU throttle, 4× (a Moto G Power-class phone on this desktop) and 6×.
- **Nothing third-party.** Chrome is started with every host name but the loopback unresolvable; a third-party request fails and is reported.

## The scripts

| Script | Answers | Output |
|---|---|---|
| `lighthouse.js` | Lighthouse per route × look × cold/warm, ≥5 runs, medians and spread; the LCP element, shifts, long tasks, bytes by type, unused JS/CSS | `out/<label>/lh/` |
| `net.js` | On a slow line: ms to first paint, to billboard text, to a usable Home, to the billboard's picture, to a complete first screen; requests and bytes before each; the full request log | `out/<label>/net/` |
| `cpu.js` | On a slow phone: main-thread time by kind, long tasks and what ran in them, JS self time by file and function, layouts and forced layouts counted, DOM size, layers | `out/<label>/cpu/` |
| `interact.js` | Gestures on a slow phone — scroll Home, swipe a shelf, open a title, Back, change tab, scroll a grid, type in Search, open the player: late frames, INP, long tasks, script/layout/style time. Then DOM nodes, listeners and heap over four rounds of a ten-screen tour (leaks) | `out/<label>/interact/` |
| `session.js` | Bytes for five minutes of browsing, by kind and by minute, with and without Data saver; which connection tier the app settled on | `out/<label>/session/` |
| `resilience.js` | A request that stalls, one that fails, pictures that fail, offline and back, a lossy line: what is on screen, does a tap still work | `out/<label>/resilience/` |
| `leaks.js` | Which screen is still in memory after it was left: each route visited six times with a forced collection after each | `out/<label>/leaks.json` |
| `correctness.js` | Sideways scroll (portrait, landscape, larger text), tap targets under 44 px, things hidden behind the nav, a shorter viewport, what still moves with "reduce motion" | `out/<label>/correctness/` |
| `shots.js` + `diff.py` | Screenshots of every screen at rest, five viewports × two looks, and their pixel-for-pixel comparison | `out/<label>/shots/`, `out/diff-…/` |

Common flags: `--label <name>` (the folder under `out/`), `--instance <state file>`, `--front h1|h2`, `--looks glass,legacy`, `--device phone-360|phone-390|phone-412|tablet-820|desktop-1440`, `--runs N`.

Cold and warm, everywhere: **cold** is no HTTP cache and no service worker but a remembered profile (a phone after a deploy, or after the browser dropped its cache); **warm** is the visit right after.

### A before/after

`ab.sh` does the whole dance — unpacks both commits, starts an instance of each, runs one script against both **at the same moment** (so whatever else the machine is doing slows both alike), stops them:

```
bash ab.sh <baseline commit> HEAD before after net.js --lines slow3g,regular3g,fast3g --runs 5
bash ab.sh <baseline commit> HEAD before after lighthouse.js --full
bash ab.sh <baseline commit> HEAD before after cpu.js --routes home,movies,film
bash ab.sh <baseline commit> HEAD before after interact.js --cpu 4
bash ab.sh <baseline commit> WORKTREE before after shots.js        # WORKTREE = the files as they are now
node summary.js before after                                       # the report's tables, as Markdown
python diff.py out/before/shots out/after/shots --out out/diff-before-after
```

(`bash stop.sh` stops EVERY by-hand instance, `ab.sh`'s included — not while a comparison is running.)

Run one comparison at a time, on as quiet a machine as can be had; where it cannot (this harness was built on one running at 100%), trust the pair, not the absolute number.

## Reading the numbers

- **Lighthouse `mobile`** is Lighthouse's own preset with *simulated* throttling — the number the Lighthouse panel or PageSpeed gives. Its simulation knows nothing of a service worker's own traffic, so its warm numbers flatter; `net.js` is the honest one for a slow line.
- **`usable`** in `net.js` = the billboard's title and the first shelf's cards are on the page. **`viewport`** = every picture in the first screenful has arrived.
- The CPU throttle scales this desktop's speed; treat ×4 as "a mid-range Android phone of a few years ago" and ×6 as "a cheap one", and compare before with after rather than reading absolutes.

## How the screenshots are made comparable

A page that is alive never shows the same pixels twice. `shots.js` holds still everything that moves by itself, identically for every version, so what is left to differ is the site:

- the clock is pinned (the greeting, "NEW" tags), `Math.random` is seeded;
- CSS animations and transitions jump to their end state;
- the two living canvases (`#glass-sky`, `#nav-aurora`) show a fixed gradient and the app's painter draws on a canvas of its own off the page — so the sky's *placement and blending* are compared, its animation is not;
- the billboard's 9-second rotation is not started;
- pictures are held to their plain end state: on the live site a poster ends either with no filter or with a no-op `filter: blur(0px)` (ui.js `posterImg`, by whether it arrived within 120 ms), and the two do not rasterise identically;
- "Full quality" data mode, so the connection tier (1× or 2× pictures) is not decided by this machine's mood;
- software rasterisation (`--disable-gpu`): with Chrome's GPU rasteriser the same picture bytes in the same box came out two ways, a few levels of colour apart, about one picture in ten per load;
- both sides photographed on the same day: Home's shelves and billboard are sampled per profile per day, and two sets taken either side of midnight differ for that reason alone;
- a first, unphotographed pass per device, so the server has cut every picture to that device's sizes and drawn its placeholders.

Even so, a handful of screenshots keep a few pixels that fall one of two ways between two runs of the SAME version (a rounded corner's edge, by one to three levels). So each side is photographed twice and `diff.py a1,a2 b1,b2` counts a file identical when any run of one side equals any run of the other.

`diff.py` reports, per screenshot, the pixels that differ at all (`exact`), those that differ by more than 8/255 in a channel (`visible`) and the largest difference, and writes a side-by-side with the differing pixels in red for anything non-zero. Two runs of the *same* version must come out all-identical before a before/after comparison means anything — run that check first (`node shots.js --label a; node shots.js --label b; python diff.py out/a/shots out/b/shots`).

## What this cannot measure

Chromium only: no Safari, no real radio, no real low-end SoC (thermal throttling, slow flash, small caches, a GPU that is not this one). `docs/qa/mobile-perf/REPORT.md` has the checklist for a real phone.

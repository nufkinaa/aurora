# Testing Aurora

Two suites, both on Node's own test runner (`node:test`). No second framework.

| | Command | What it is | Time |
|---|---|---|---|
| Unit | `npm test` | `test/*.test.js` — pure logic, no server, no browser | seconds |
| Browser | `npm run test:ui` | `test/ui/*.test.js` — the real web app in the Chrome (or Edge) already on the machine, against a private server | about 3½ minutes |

`npm test` never picks up the browser tests (its glob is `test/*.test.js`, they live one folder down), and it does not need Chrome or ffmpeg.

## Running the browser tests

```
npm run test:ui                                  # everything, headless
node --test test/ui/player.test.js               # one file
node --test --test-name-pattern="Up next" test/ui/player-episodes.test.js
HEADED=1 node --test test/ui/wall.test.js        # watch it in a real window
UI_VERBOSE=1 node --test test/ui/live.test.js    # with the private server's log
UI_BROWSER=msedge npm run test:ui                # force Edge (default: Chrome, then Edge)
```

(The `VAR=1 command` form is Git Bash; in PowerShell: `$env:HEADED = "1"; node --test test/ui/wall.test.js`.)

Needs: Node 20+, `npm install` (brings `playwright-core`, the library only — no browser is downloaded), Chrome or Edge installed, and `ffmpeg` on `PATH` (or `FFMPEG_PATH`) with libx264, aac and ac3 — the same ffmpeg Aurora itself uses.

When a test fails, `test/ui/artifacts/<file>--<test>.png` and `.log` are written: a screenshot, the page's console and failed requests, the `<video>` element's state if a player was up, and the last 200 lines of the private server's log. That folder and the media cache (`test/ui/.cache/`) are git-ignored.

A test fails on **any** uncaught page error or `console.error`, unless the text is on an explicit allow-list: the one in `helpers.js` (`OFFLINE` — the browser's "Failed to load resource" line for routes that need the internet, which the private server does not have) or the test's own `allow: [...]`.

## The private instance

The tests never touch the real server on port 4000, the real `config.json`, `.env` or `data/`. `scripts/ui-test-server.js` builds a throwaway copy for every test file:

```
<tmp>/aurora-ui-XXXXXX/
  ui-instance.js        server.js, copied under another name
  ui-preload.js         test/ui/support/server-preload.js
  src/  public/         copied from the working tree as it is right now (the TV APK left out)
  node_modules          a junction / symlink to the repo's
  config.json           a free port, this library, a made-up admin password,
                        onlineMetadata / skipDatabases / prewarmStreams / autoOcr off
  data/                 empty, plus what the test seeds (IMDb ids, age ratings)
  media/movies, shows   the generated library
  tmp/                  the instance's TEMP
```

Why a copy and not an env var: `src/config.js` resolves `config.json`, `.env` and `data/` from the folder the code sits in and has no override, so the code is given a different folder instead. (If `AURORA_PORT` / `AURORA_DATA_DIR` / `AURORA_CONFIG` are ever added to `src/config.js`, the copying of `src/` and `public/` can go — `server.js` also needs to take its avatars folder from `config.DATA_DIR`.)

The process is started as `node -r ./ui-preload.js ui-instance.js` from inside that folder. The preload does two things and changes nothing else:

- **No network.** Every outbound TCP connection to another host is refused at once (TMDB, Cinemeta, Torrentio, trackers, push services), and UDP is dropped. Browser-side, anything not addressed to the private instance is answered with an empty 404 by Playwright. The suite behaves the same with the cable out, and cannot start a real torrent or download.
- **No orphans.** If the test process disappears, the server ends itself and its ffmpeg children within about three seconds. Folders a killed run left behind are removed by the next run.

The command line deliberately contains neither `server.js` nor `aurora`: restarting the live server with "stop every node whose command line mentions server.js" killed private instances mid-test before it was renamed. `node scripts/ui-test-server.js` (below) still has such a name — expect a by-hand instance to die when someone does that.

### The library

Made with ffmpeg the first time (about 15 s), kept in `test/ui/.cache/media-<recipe>/` and copied into each instance. Bump `MEDIA_VERSION` in the script when a recipe changes.

| Title | File | Why |
|---|---|---|
| Test Film One (2020) | MP4, H.264 + AAC, 60 s, English + Hebrew `.srt` sidecars, `cover.jpg` | plays as the file itself ("direct") |
| Test Film Two (2021) | MKV, H.264, **two AC-3 audio tracks** (eng, heb), two embedded subtitle tracks | Chrome cannot decode AC-3, so the server repackages it ("jit": video copied, audio → AAC) and hls.js plays it — the path seeking restarts, audio switching and stall recovery live on |
| Test Show S01E01–E03 | MP4, 45 s each, sidecar subtitles; **E03 is 1080p** | Next episode, Up next (appears 15 s in, counts down 15 s), Still watching; an episode card plays directly only at 1080p or better |
| Test Film Three (2022) | MP4, 12 s — kept aside in `extras/` | dropped into a running instance by the live-data test |

The titles have made-up IMDb ids (`tt9000001`…), seeded into `data/imdb-map.json`, so title pages offer X-Ray and Follow without a lookup. `certificatesSeed({ film1: 0, show: 7, film2: 18 })` seeds `data/cache/certificates.json` for the kids tests.

### By hand

```
node scripts/ui-test-server.js            # prints the address and that instance's admin password
node scripts/ui-test-server.js --verbose  # with the server's log
```

CTRL-C stops it and removes the folder. Handy for reproducing a failure in your own browser against the same library.

## Adding a test

```js
// test/ui/something.test.js
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const ui = suite();        // boots a private server and a browser for this file

ui.test("the film page offers Play", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());            // a new, empty profile: this test's own
  await goto(`#/movie/${lib.film1.id}`);         // waits for the screen to paint
  assert.equal((await page.textContent(".detail-actions > .btn-primary")).trim(), "Play");
});

ui.run({ concurrency: 3 }); // last line: how many of this file's tests may run at once
```

What a test is handed: `page`, `context`, `srv` (url, `adminPassword`, `library` paths, `log()`), `api` (calls to the instance: `createProfile`, `setProgress`, `state`, `profile`, `rescan`, `adminPost`…), `lib` (`film1`, `film2`, `show`, `e1`–`e3`), `profiles` (what `setup` created), `signIn(profile)`, `freshProfile()`, `goto(hash)`, `problems`, `t` (node:test's context, for `t.skip`).

Rules that keep the suite reliable:

- **Wait for a condition, not for time.** `page.waitForFunction`, `locator.waitFor`, `player.playing()`, `player.waitClock()`. `waitForTimeout` is only for "nothing must happen during this".
- **One profile per test** (`freshProfile()`), so tests in a file can run side by side and in any order. Tests that share something else — the library on disk (`live.test.js`), the admin's queue (`admin.test.js`) — set `concurrency: 1`.
- **Select by what is stable**: `aria-label`s, roles, `data-*`, long-lived class names. The player's controls are `player.ctrl("Subtitles")` → `.pbtn[aria-label="Subtitles"]`.
- **Position in a film** is read from the clock printed beside the timeline (`player.clock`) — on a repackaged stream the `<video>` element's own clock restarts at 0 after some seeks.
- **`player.jump()`** moves the film without input (it sets `currentTime`); use it to get near the end of an episode without ending a "Still watching?" run, which any key or click does.
- **Open the player from a screen** (`player.open` does): leaving a film is `history.back()`.
- **An application bug is not fixed in a test.** Write the test for the right behaviour, mark it `{ todo: "app bug: …" }` with a comment saying where the cause is, and report it. It runs every time and turns green by itself when the bug is fixed (then remove the `todo`).
- A file that declares tests and never calls `ui.run()` fails loudly.

## What is covered

| File | Covers |
|---|---|
| `wall.test.js` | profile wall, wrong / right password, what the password sheet says for a rate limit / a locked profile / no server, reload keeps the unlock, the one-time "new look" note, Switch profile |
| `navigation.test.js` | every `route()` in `main.js` at 1280×720 and 390×844: renders, no console errors, no sideways scroll, no skeleton left; deep links; Back / Forward / Escape; unknown routes. Fails when `main.js` gains a route the table does not have |
| `library.test.js` | Movies / Shows grids, Unwatched, category pills, the in-page search box, Search, My List add / remove / reload / sort / filter; the add's toast for each answer of My List downloads (stubbed answer) |
| `title.test.js` | film Play / Resume / Start over / watched; show episode list and card states; X-Ray with no network; Follow; rating |
| `player.test.js` | direct play: transport, ±10 s, keys, timeline, speed, subtitles (+ saved to the profile, carried to the next title), settings menu, resume, leaving, Media Session, PiP / AirPlay, mute, playing to the end, 10 quiet seconds after leaving; watch history that cannot be read (plays, saves nothing, the resume point on the server survives) |
| `player-episodes.test.js` | Next episode, Up next + countdown + auto-advance, Play now / Dismiss, autoplay off, Still watching?, subtitle carried to the next episode, resume, leaving |
| `player-hls.test.js` | the repackaged path: hls.js, seeking, embedded subtitles, audio switch + remembered language, resume; **stall recovery** (nudge → one rebuild at the same position; refused server → "Playback stopped" → Try again; pause and hidden tab do not trigger it) |
| `settings.test.js` | every section, More settings, every switch across navigation and reload, subtitle language, look, notifications refused; every Settings place a What's new card names exists under that name |
| `live.test.js` | a film added to / removed from the library reaches open grids and Home without a reload, filter kept |
| `images.test.js` | blur-up placeholders give way to sharp posters (desktop + phone); a broken poster falls back to the titled tile |
| `kids.test.js` | a kids profile's grids / Home / Search, blocked title and its streams (403), leaving needs the PIN, a normal profile is unaffected (skips if the server has no kids routes) |
| `admin.test.js` | admin gate, People tab, approve / reject a request (arrives live), kids controls, every tab opens; Downloads → "Downloads at once" (set, reload, out-of-range refused) and the second-source line under a job (stubbed queue); My List downloads → the settings (set, reload, refused values), the tag on a job, the stale mark on disk and the stale copy leading "Suggest what to delete" (stubbed answers) |
| `downloads.test.js` | My downloads: a job trying a second source keeps its one card and gains one note (stubbed queue); a My List download on hold says so with its progress bar, one that has not started says it waits for the others; a download that finished while the socket was down is caught up on reconnect (the test closes the page's socket) |
| `pair.test.js` | signing a TV in from a phone: `/link` with no code opens the code field, a typed code goes on to the confirm screen the QR opens, approval hands the TV a session once; not signed in asks for the sign-in first; an expired code |
| `signin.test.js` | the sign-in modes, one test at a time (the mode is one switch for the whole instance; each test sets it and puts "open" back): a forced password reset asked for after signing in to a server that requires sign-in, and at the wall; "Sign out everywhere else" from another device and from this tab; the server starting to require sign-in under an open tab |
| `push.test.js` | Web Push follows the profile: entering a profile files the browser's subscription under it, a switch moves it, signing out withdraws it (the browser's push objects are stand-ins; nothing is sent) |
| `ai.test.js` | the AI page keeps its last answer for the profile that asked and for nobody else (stubbed answer) |
| `person.test.js` | the person sheet: X-Ray → a person → their titles by department → a press puts one on My List, a second takes it off (toast, Undo, the "downloading" wording with a stubbed answer); Details (button, the I key, right-click) and Back from it; photos enlarge; the title page's cast line; someone the server cannot look up; a phone (sheet over X-Ray's sheet, Back closes the top layer only); over a film and over a fullscreen film; a kids profile. The people are seeded into the server's own cache (`test/ui/support/person-seed.js`), so `/api/person` is the real route — only pictures are answered by the browser |
| `downloads.test.js` | My downloads: a job trying a second source keeps its one card and gains one note (stubbed queue) |
| `telemetry.test.js` | usage stats beyond events (`docs/analytics.md`): a thrown error and seven failed pictures arrive as one counted report each, reduced (no title, id, address or token); `console.warn` and a refused request are reported by their shape; a tagged control is counted and screens are timed; a profile with usage stats off sends nothing and the server refuses a batch for it anyway (`X-Usage: off`); the admin's App health page — errors (new / spiking / ignored, mark known, ignore), timings against the previous version, most used, the alert rules, Copy — from stubbed data; the admin endpoints themselves |

### How stall recovery is tested

The ladder watches the media clock. A buffered stream cannot be frozen from outside with hls.js idle — holding or failing requests keeps the loader busy, and the ladder rightly leaves a busy loader alone — so the freeze is made on the element: `playbackRate = 0`. The clock stops; the element is not paused, ended or in error; the buffer is full. A rebuild resets the element, which puts the rate back to 1. The thresholds are real time (nudge after 6 s of stall once the 15 s start-up grace is over, rebuild at 20 s), so these tests take 40–45 s each and run side by side.

### The download queue without a torrent

`test/dlrace-queue.test.js` (part of `npm test`) plays the queue out against a fake engine: "Downloads at once", the hold while people watch, and the second-source race end to end (slow original → challenger → one file in the library, the loser cancelled and purged; both finishing in one tick; a cancel and a restart mid-race). It uses the same trick as the private instance, in-process: `src/` is copied to a temp root with its own `config.json`, `data/` and library and required from there, the engine is swapped through `downloads._internals.setEngine`, and the clock, timers, "who is watching" and the source lookup are `downloads._internals.seams`. No aria2 process, no network. The rules themselves are pure and pinned in `test/dlrace.test.js`.

### My List downloads without a download

`test/mylist-priority.test.js` pins where My List downloads stand in the queue (`src/media/dlslots.js` `plan()`): last behind every other kind, put on hold — bytes kept — while anything else needs to be downloaded (`myListYield`: `always` / `slots`), first to give way to viewers, carried on after a quiet minute. The rule is tested as plain data, then the queue is played against a fake engine: a hold and its resume, two My List jobs and one request, a restart mid-hold, cancel and the admin's "Start now" on a held job, the healer / second-source race / stall clock all leaving a held job alone, the 14 / 21-day clock starting at the landing, and the API shape older clients read (`status` stays `approved`; `held`, `heldReason`, `heldAt` are added).

`test/mylistdl.test.js` runs the feature (`src/media/mylistdl.js`) over fakes it is handed — a queue, a library, a clock — so the trigger, the 14 / 21-day clock and every refusal are pinned without anything real. `test/mylistdl-queue.test.js` is the wiring, in the same private root as the queue test above: the watchlist route's answer, the job's tag, "by hand" taking a job over, the admin routes, and a real file leaving a temp library at 21 days. Its engine accepts a job and never moves it; the source lookup is the feature's own seam (`_internals.use`).

## Known gaps

Not covered, because they cannot be exercised deterministically offline — nothing is faked to look like a pass:

- torrent sources, streaming from a torrent, downloads to the server, smart downloads
- trailers (YouTube), catalogue shelves and catalogue title pages (`#/discover/...` is only checked for failing politely)
- real metadata: synopsis, genres, cast, X-Ray content (only its "nothing known" state)
- Web Push delivery and the notifications switch's "allowed" path; anything that needs the service worker (it is blocked in tests): offline copies, the Saved screen's contents, the installed-app badge
- sign-in modes "transition" and "closed": claiming at the wall, requesting access, Google (`signin.test.js` covers the login screen, a forced reset, "Sign out everywhere else" and the wall going up; the older test for that button in `settings.test.js` still skips in mode "open")
- watch parties, AI picks, reports, Wrapped's numbers, avatar upload
- the stall ladder's own "+45 s" card (reached only when a rebuilt stream neither loads nor fails; see the bug list in the report), torrent-bound and party-bound stand-downs, native HLS (iPhone)
- AirPlay and Safari / iOS behaviour in general: the suite runs Chromium only
- real fullscreen and real Picture-in-Picture windows (the buttons are checked, the OS surfaces are not)
- the TV app (`tv-native/`)

## CI

`.github/workflows/ci.yml` runs `npm test` only. The browser suite is **not** wired into CI: it has only been run on Windows, and a GitHub runner needs things that were not verified here (an ffmpeg with libx264 + ac3, Chrome's H.264/AAC decoding in the runner's headless mode, the symlinked `node_modules`). A job to start from, non-blocking, once someone has tried it on a runner:

```yaml
  ui:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - run: npm ci
      - run: npm run test:ui
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: ui-artifacts, path: test/ui/artifacts }
```

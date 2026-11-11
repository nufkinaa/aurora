# CI: run only the tests a change can reach

`.github/workflows/ci.yml` runs the root suite (`node --test test/*.test.js`) on Node 22 only (elia, 2026-11-04),
and, when `tv-native/` changed, the apps' logic tests and type check (see "The tv-native job").
Pushes and pull requests now run **only the test files a change can reach**. Everything runs
whenever there is any doubt, every night, on a run started by hand, and on `server-*-stable` tags.

## How others do it, and what fits here

| Approach | How it decides | Why it does or doesn't fit Aurora |
|---|---|---|
| Jest `--changedSince` / `--findRelatedTests` | static import graph (`require`/`import`) | Our root tests are `node:test`, and many of them read files with `fs`: parity and contract tests read `tv-native/src/**`, `docs/analytics.md`, `CHANGELOG.md`, `public/*.apk`, the version json files. No static graph sees those. |
| Nx / Turborepo "affected" | a project graph of declared packages | Aurora is one package with one suite. We'd have to invent the projects and keep their dependencies up to date by hand. |
| Bazel | every input declared per target, hermetic | Exact, but it means rewriting the build. Far too heavy for this repo. |
| GitHub `paths` / `dorny/paths-filter` | glob rules written by hand | Simple, but a hand-written filter goes stale the day a test starts reading a new file. That's the classic false "green". Fine for coarse gates (e.g. a future tv-native job), not for picking tests. |
| Test-impact analysis (coverage or runtime tracing; Microsoft TIA, Launchable, pytest-testmon, Datadog ITR) | record what each test *actually touched* in a full run; later run the tests whose recorded files changed | Sees `fs` reads as well as `require`. Needs no hand upkeep. Fails safe if the record is missing or stale. **This is what we use.** |

We do runtime tracing, without coverage. We don't need line-level detail: one file-level record
per test file is enough, and it costs much less.

## The pieces (all in `tools/ci/`)

- **`trace-preload.cjs`**: loaded with `NODE_OPTIONS=--require …` only while CI runs the tests.
  For each test file's process, and for everything that process spawns, it writes down every
  repo file that is:
  - loaded by `require` or `import` (`import` through `trace-esm-hooks.mjs`, via `module.register`);
  - read, opened, stat'ed, checked with `exists`/`access`, or copied with `fs`;
  - listed with `readdir`/`opendir` (recursive listings are kept apart);
  - copied whole with `fs.cp`. The private test server copies all of `src/` and `public/` this way, so it depends on all of them;
  - named as a script or an argument of a child process.

  It also notes non-node programs (ffmpeg, where…) and how long each file took. It only
  observes: every hook calls the original function unchanged. Proof: the suite gives the same
  counts with and without it (see "Proof" below).
- **`build-test-map.js`** turns the logs into `test-map.json`. Each test file gets its repo files,
  folder listings, folders copied whole, programs and time. Paths are repo-relative, with
  forward slashes on every OS. Only git-tracked paths are kept, so `node_modules`, temp
  folders and generated files never appear.
- **`select-tests.js`** holds the rules (pure; pinned by `test/ci-select.test.js`).
- **`ci-tests.js`** finds the range to compare, calls the rules, and reports. `select` is the
  CI step; `simulate` replays history (see below).

## Which tests run

The changed files are `git diff --name-status --no-renames <base> HEAD`. The base is:

- **on a push:** the commit of the **last green run** of this workflow on the branch, found through
  the Actions API with the default token's `actions: read`. A cancelled or red run therefore
  never hides a change: its commits stay in the next run's range until a run passes. This is
  why superseded pushes can be cancelled safely.
- **on a pull request:** the base branch, i.e. the first parent of the PR's merge commit.

For each changed file:

- a changed or new `test/*.test.js` runs itself;
- a file some test read, loaded, stat'ed or copied runs those tests;
- an added or removed file runs the tests that listed its folder. If it creates or empties a
  folder, the tests that listed that folder's parent run too, and so on up. A recursive
  listing counts at any depth;
- an added file also runs the tests that once looked for that path and didn't find it (`absent` in the map);
- whenever anything runs, two more kinds of test run with it:
  - a test file that isn't in the map yet;
  - a test that starts a node child the tracer can't see into, unless it copies the folder that child runs from.

**The map's commit bounds the range.** The map describes the commit it was last updated at
(M). The base therefore becomes `merge-base(base, M)`: a dependency added after M came with a
change to a file the test already read, so that change must be in the range. If M isn't in
HEAD's history (a PR that restored master's newer map), the files changed between their
common ancestor and M are added too. If M isn't in the clone at all, everything runs.

### Run everything when

- `package.json` or `package-lock.json` changed, *unless only `"version"` changed* (a release
  bump: then the tests that read `package.json` run);
- `.npmrc`, `.nvmrc` or `.node-version` changed;
- anything under `.github/` changed;
- anything under `tools/ci/` changed (the tracer or the selector itself);
- `tools/patch-webtorrent.js` changed (the postinstall);
- a shared test helper changed (any `.js` under `test/` that isn't a `*.test.js`, outside `test/ui/`);
- a changed file appears in **no** map entry and is not on the safe list below. A file no test
  reads may still be read in a way the tracer can't see, so we don't guess;
- there is no map, or it has another format, or it was traced on another Node major, or its last
  full trace is more than 7 days old;
- the range can't be worked out: no earlier green run, the API failed, or the base isn't an ancestor;
- a commit message in the range contains **`[ci full]`**;
- the run is nightly, started by hand, a `server-*-stable` tag, or a re-run (attempt 2+);
- the chooser itself crashes.

### The safe list (only when no test reads the file)

A file here that no map entry names needs no tests. If a test *does* read it (for example
`docs/analytics.md` or `tv-native/src/screens/WhatsNew.tsx`), that test runs as usual.

- `docs/**`
- `*.md`
- images and video (`png jpg jpeg gif webp avif bmp ico mp4 webm mov pdf`), except under
  `src/`, `public/`, `scripts/` and `test/`, where a reader the tracer can't see (ffmpeg, the
  served site) is possible
- `test/ui/**` (the browser suite; CI doesn't run it)
- `tv-native/**` (the TV and phone apps; root tests read only the files the map lists)
- `tools/**`, except `tools/ci/**` and `tools/patch-webtorrent.js` (hand-run dev rigs)
- `LICENSE` and `.gitignore`

If every change is on this list (screenshots, docs, an untested TV-only file), nothing runs.
The job still passes, and its summary says "No affected tests".

## What the tracer cannot see, and how that is covered

- **A node child started with its own env, without `NODE_OPTIONS`.** The private test server
  (`scripts/ui-test-server.js`) and `watch-journal-crash` do this on purpose. The map marks
  them `untracedChild`. Their children run *copies* of `src/` and `public/`, made with `fs.cp`,
  and the copy is recorded as "depends on everything under `src/`" (and `public/`). A test
  marked `untracedChild` that copies nothing runs whenever anything runs.
- **Non-node programs** (ffmpeg, ffprobe) see only the arguments they are given. Arguments that
  name repo files are recorded.
- **Anything else** shows up as "a changed file no map entry names", and that runs everything.
  The nightly full run puts a one-day limit on any blind spot.

## The map's lifetime

- Every run traces the tests it runs. That costs little; see "Proof".
- A full run that **passed** replaces the map. Anything else only **adds** to it: a partial run,
  or a run with failures (whose tests may have stopped early). So the map can't forget a file
  because one run crashed early.
- It lives in the Actions cache. Each Node version keeps its own map, saved as
  `test-map-v1-node<major>-<day>-<run id>-<attempt>` and restored by the prefix
  `test-map-v1-node<major>-`, so the newest one is used. Nothing is committed.
- The nightly run (02:23 UTC) refreshes it.

## Checkout: the other half of the time

The run before this change spent about **250 s in `actions/checkout`** against about **140 s in `npm test`**.
The tree is about 640 MB, and about 520 MB of that is QA screenshots in `docs/qa/` and `docs/android-phone/`.
The workflow now does a sparse checkout without those two folders. No test reads them: if one
ever does, it fails loudly with ENOENT and isn't silently skipped. The checkout fetches the
whole history as commits and trees only (checkout v6 adds `blob:none` to a sparse checkout),
which is what the "last green run" comparison needs.

## Visibility

The "Choose the tests" step prints the same report to three places: the log, the job summary,
and a `notice` annotation (readable from the public API, like the failure annotations). The
report gives:

- the mode and the reason;
- the range compared;
- the map's age;
- every chosen test with the changed files that reach it;
- the list of changed files.

The "Say what failed" annotations are unchanged.

## Proof (2026-11-04, Windows, Node 22.13, at 5de6d274 + this change)

- **The tracer changes nothing.** Root `npm test` ran three times with the tracer and three
  times without it. Every run was green, with the same counts (2290 tests, 2257 pass, 33 skipped).
- **It costs little.** Wall times with / without the tracer: 115 / 116 s, 115 / 116 s, and
  120 / 111 s. The machine was shared with other agents, so the third pair is load noise.
- **The map makes sense.** For example:
  - `whatsnew-parity` reads `public/js/screens/whatsnew.js`, `tv-native/src/screens/WhatsNew.tsx` and `public/js/main.js`;
  - `phoneapp` reads `public/aurora-phone.apk`, `public/aurora-tv.apk` and both version json files;
  - the 17 tests that copy all of `src/` into a private instance depend on all of it (and the 6 that also copy `public/`, on that).
- **Replay of history.** With the same map:
  - **the last 30 master commits, one at a time:** 869 test-file runs instead of 7410 (12%),
    or about 18% of the test time;
  - **the 30 real CI pushes, each compared with the last green run:** 26% of the test files,
    about 39% of the test time. Release pushes still run about 30 files, because the server
    tests read `CHANGELOG.md` and `package.json`.
- **Every past break is caught.** The commits that turned CI red would all have selected their failing files:

  | Run | Failing file |
  |---|---|
  | 420ccf90 | `dl-landing` |
  | 38150b89 | `tonemap`, `ladder-facts-disk` |
  | 78922b1f | `scanner-walk` |
  | 5c9a6d74 | `prod-log-2026-10-11` |

  The red docs-only run (66381959) was a `scanner-walk` flake, and it would now run nothing.

## The tv-native job

A second job, `tv-native logic + tsc (node 22)`, checks the TV and phone apps:
`npx jest -c jest.logic.config.js` (the logic tests, plain node, no React Native runtime)
and `npx tsc --noEmit -p .`, both in `tv-native/`, after `npm ci --legacy-peer-deps`
(its postinstall applies `tv-native/patches`). npm's download cache (`~/.npm`) is kept in
the Actions cache, keyed on `tv-native/package-lock.json`.

It runs only when something under `tv-native/` or `.github/workflows/` changed, or one of
the few files outside `tv-native/` that its tests read (the website/server parity checks:
`public/js/screens/player.js`, `src/media/household.js`, `docs/qa/household-recs/` and
others), in the same range the root tests compare: `node tools/ci/ci-tests.js changed
--match tv-native/ --match …` writes `run=true|false`, and every later step is skipped on
`false` (the job stays green, like "No affected tests"). `test/ci-changed.test.js` scans
the TV tests for such reads and fails when one is missing from the list, or left out of
the job's sparse checkout (it keeps `docs/qa/household-recs/*.md`, not the screenshots).

- **push:** since the last green run of this workflow. The workflow is green only when both
  jobs are, so a red or cancelled TV run keeps its changes in the next range.
- **pull request:** the base branch.
- **nightly:** also since the last green run (an unchanged app is not rerun every night).
- **always runs:** a run by hand, a `server-*-stable` tag, a re-run, no green run to compare
  with, a range git can't compare, or the check itself failing.

Measured 2026-11-06 on Windows: 78 suites / 937 tests in about 30 s, tsc about 13 s;
`npm ci` in `tv-native/` about 25 s with a warm cache.

## The browser tests on GitHub (`.github/workflows/ui.yml`)

The website's browser suite (`test/ui/*.test.js`, `npm run test:ui` locally: about an hour
one file at a time on the home PC) runs on GitHub in **8 parallel shards**, each a
4-vCPU ubuntu-24.04 runner running its files one after another, each file with its own
private instance and Chrome, exactly as at home. Wall time: about 10 minutes (first green
run 2026-11-11: 9.7 min, shards 6.7–9.5 min; 110 files, ~64 min of test time).

- **When:** every push to `master`, `rel-*` and `ui-*` branches; by hand (Actions → UI →
  Run workflow) with an optional `files` input (`party wall`, comma or space separated)
  and `shards`. A branch with another name gets a run by pushing it under a `ui-` name:
  `git push origin HEAD:ui-<branch>`.
- **Reading the result without signing in:** `tools/ci-ui.sh <branch> [--sha <commit>]
  [--wait]` prints the run and each shard, and for a red one each failing test with its
  error and the test-file line (from the run's annotations — the job log itself needs a
  sign-in). Without a token GitHub allows 60 API calls an hour per address: `--wait`
  polls every 120 s (2 calls a poll).
- **The pieces:** `tools/ci/ui-shards.js` splits the files longest-first by
  `test/ui/durations.json` (the runners' own seconds; a new file counts as the median);
  `tools/ci/ui-shard-run.js` runs a shard: per file its own `node --test`, a second try
  for a failing file (a pass then is reported as **flaky**, a warning, never silently),
  8 minutes at most per file, a step summary, and annotations: the failures, the skips,
  the seconds per file ("UI shard timings": save those as JSON and run
  `node tools/ci/ui-shards.js --update <files>` to rebalance). Screenshots and logs of
  failures are uploaded as the `ui-artifacts-<n>` artifact (7 days).
- **The machine is made to look like the home PC**, so the same tests hold:
  `TZ=Asia/Jerusalem`; Chrome in en-GB (`LANGUAGE`, 24-hour times on the page) and node
  in he-IL (`LC_ALL`, the server's house clock), with those locales generated (without
  them Chrome could not open a file with a Hebrew name); Google Chrome from the image
  (the open-source Chromium cannot play the H.264/AAC test films); ffmpeg/ffprobe **6.0**
  as at home (the static build, cached; apt hung for 20+ minutes in two runs, and an
  8.1 build left a shard hanging); **Selawik**, Microsoft's open, metric-compatible
  stand-in for Segoe UI, answering for the Segoe UI names, with its line height set to
  Segoe UI's Windows one (`tools/ci/patch-hhea.js`) — without it the 320-px "nothing is
  cut" tests failed on the font alone. An "UI environment" notice on every shard says
  what the page saw (locale, clock, the font and size of a line of the tab bar's words).
- **No secrets.** The instances make up their own admin password; nothing leaves them.

What had to change in the tests for Linux, each with its reason in the code:
`scripts/ui-test-server.js` drops `INVOCATION_ID` from the instance's environment (a
runner is a systemd unit: the server read as "supervised by systemd"); `iphone-home`
allows its tab bar half a pixel more on Linux (whole-pixel font metrics); `telemetry`
waits for the Movies paint time as well as the counts; `scrub-preview` accepts a server
that made no pictures itself when the test had to make them (Linux holds the idle run
back while the one-minute load is high); `airplay-iphone` sets the admin's fixed limit
of 2 encodes on a machine of 4 threads or fewer.

## Local use

```sh
# the tests a range would run (needs a map; build one first)
AURORA_TRACE_DIR=/tmp/trace NODE_OPTIONS="--require $PWD/tools/ci/trace-preload.cjs" npm test
node tools/ci/build-test-map.js --trace /tmp/trace --out /tmp/test-map.json --full --passed
node tools/ci/ci-tests.js select --map /tmp/test-map.json --base HEAD~3 --head HEAD
# replay the last 30 first-parent commits
node tools/ci/ci-tests.js simulate --map /tmp/test-map.json --count 30 --full-ms 140000
```

## Decisions for elia

- **Node 20: decided 2026-11-04, elia: "only test 22".** CI runs Node 22 alone, and `engines` says `>=22`. (The "Node.js 20 is deprecated" warning came from checkout/setup-node v4; they are v6 now.) If nufurora.com still runs Node 20, `npm ci` there only warns, but it should move to Node 22 since nothing tests 20 any more.
- **Browser tests (`npm run test:ui`)**: on GitHub since 2026-11-11 (elia: "yes"), in their
  own workflow, see "The browser tests on GitHub" above. Not part of `ci.yml`.
- **tv-native jest**: done 2026-11-06, see "The tv-native job" above.

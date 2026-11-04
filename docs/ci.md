# CI: run only the tests a change can reach

`.github/workflows/ci.yml` runs the root suite (`node --test test/*.test.js`) on Node 20 and 22.
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
- It lives in the Actions cache. Each leg (Node 20, Node 22) keeps its own map, saved as
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

- **Node 20** is past end of life. The "Node.js 20 is deprecated" warning on every run came from
  `actions/checkout@v4` and `actions/setup-node@v4` running on Node 20. They are now v6 (Node 24),
  so that warning goes away. The **test matrix still runs Node 20**, because `engines` says `>=20`
  and we don't know which Node nufurora.com runs. Options:
  1. keep both (as now);
  2. **Node 22 only on pushes and PRs, Node 20 in the nightly run only.** This halves push minutes.
     Change the matrix to `node: ${{ github.event_name == 'schedule' && fromJSON('[20,22]') || fromJSON('[22]') }}`;
  3. drop Node 20 after checking `node -v` on nufurora.com, and set `engines` to `>=22`.
- **Browser tests (`npm run test:ui`)**: not in CI. They need Chrome and ffmpeg, take minutes,
  and flake under load. A nightly-only job is possible later. Not worth it per push.
- **tv-native jest (`jest.logic.config.js`)**: cheap to run, but `npm ci --legacy-peer-deps` plus
  `patch-package` in `tv-native` costs a minute or two. It's worth a separate job gated on
  `tv-native/**` changes (the same diff the chooser uses), when TV work picks up again.

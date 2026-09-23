// Smart cleanup: every rule that decides whether a smart-downloaded episode
// may leave the disk, pinned on the pure decide() — no library, store or disk.
const test = require("node:test");
const assert = require("node:assert");

const { decide, before, STARTED_S } = require("../src/media/smartclean")._internals;

const ALICE = { id: "p-alice", name: "Alice", prefs: {} };
const job = (over = {}) => ({
  smart: true,
  status: "done",
  destPath: "D:/Shows/Show/Season 1/Show S01E03.mkv",
  profile: "p-alice",
  imdbId: "tt0903747",
  season: 1,
  episode: 3,
  ...over,
});
// Alice finished S1E3 and is 5 minutes into S1E4.
const base = (over = {}) => ({
  job: job(),
  requester: ALICE,
  now: { imdbId: "tt0903747", season: 1, episode: 4, position: 300, duration: 2700 },
  finished: new Set(["1:3"]),
  others: [],
  manualShare: false,
  ...over,
});

test("the happy path: finished it, well into the next one → clean", () => {
  assert.deepEqual(decide(base()), { clean: true, why: "watched and moved on" });
});

test("episode ordering spans seasons", () => {
  assert.equal(before({ season: 1, episode: 10 }, { season: 2, episode: 1 }), true);
  assert.equal(before({ season: 2, episode: 1 }, { season: 1, episode: 10 }), false);
  assert.equal(before({ season: 1, episode: 3 }, { season: 1, episode: 3 }), false, "same episode is not behind");
  // S1 finale cleaned once S2E1 is under way
  const r = decide(base({
    job: job({ season: 1, episode: 10 }),
    now: { imdbId: "tt0903747", season: 2, episode: 1, position: 120, duration: 2700 },
    finished: new Set(["1:10"]),
  }));
  assert.equal(r.clean, true);
});

test("only files smart downloads created, and only when fully downloaded", () => {
  assert.equal(decide(base({ job: job({ smart: false }) })).clean, false, "hand-requested download");
  assert.equal(decide(base({ job: job({ status: "downloading" }) })).clean, false);
  assert.equal(decide(base({ job: job({ destPath: null }) })).clean, false);
});

test("only the person it was fetched for can trigger it (by id or legacy name)", () => {
  const bob = { id: "p-bob", name: "Bob", prefs: {} };
  assert.equal(decide(base({ requester: bob })).why, "fetched for someone else");
  assert.equal(decide(base({ job: job({ profile: "Alice" }) })).clean, true, "older jobs stored the name");
});

test("switched off in Preferences → never", () => {
  const off = { ...ALICE, prefs: { smartCleanup: false } };
  assert.equal(decide(base({ requester: off })).why, "switched off");
});

test("must be the same show and a LATER episode", () => {
  assert.equal(decide(base({ now: { imdbId: "tt9999999", season: 1, episode: 4, position: 300 } })).why, "different show");
  assert.equal(
    decide(base({ now: { imdbId: "tt0903747", season: 1, episode: 3, position: 300 } })).why,
    "not behind the episode being watched",
    "re-watching the same episode keeps it",
  );
  assert.equal(
    decide(base({ now: { imdbId: "tt0903747", season: 1, episode: 2, position: 300 } })).clean,
    false,
    "going BACK to an earlier episode keeps it",
  );
});

test("an autoplay blip into the next episode is not 'started'", () => {
  const blip = { imdbId: "tt0903747", season: 1, episode: 4, position: STARTED_S - 1, duration: 2700 };
  assert.equal(decide(base({ now: blip })).why, "next episode barely started");
});

test("skipped past without finishing → keep it for later", () => {
  assert.equal(decide(base({ finished: new Set(["1:1", "1:2"]) })).why, "not finished");
  assert.equal(decide(base({ finished: new Set() })).clean, false);
});

test("someone else part-way through the same file → keep it", () => {
  const r = decide(base({ others: [{ position: 900, finished: false }] }));
  assert.equal(r.why, "someone else is part-way through it");
  // …but someone who merely peeked, or already finished it, doesn't block
  assert.equal(decide(base({ others: [{ position: 5, finished: false }] })).clean, true);
  assert.equal(decide(base({ others: [{ position: 2600, finished: true }] })).clean, true);
});

test("a hand-requested download of the same file wins", () => {
  assert.equal(decide(base({ manualShare: true })).why, "someone asked for it by hand");
});

// ---------- end to end, on a real (temporary) disk ----------
// Every store is swapped for an in-memory fake with a no-op save BEFORE
// anything runs, and the library root is a temp dir — so this exercises the
// real delete path (libfiles, sidecars, empty-folder pruning, job pruning)
// without any chance of touching live data or the real library.
test("end to end: the watched episode + its subtitles leave the disk; everything else stays", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const config = require("../src/config");
  const scanner = require("../src/media/scanner");
  const downloads = require("../src/media/downloads");
  const profiles = require("../src/profiles");
  const smartclean = require("../src/media/smartclean");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-clean-"));
  const s1 = path.join(root, "Breaking Bad", "Season 1");
  fs.mkdirSync(s1, { recursive: true });
  const ep3 = path.join(s1, "Breaking Bad S01E03.mkv");
  const ep3sub = path.join(s1, "Breaking Bad S01E03.he.srt");
  const ep2 = path.join(s1, "Breaking Bad S01E02.mkv"); // hand-downloaded
  for (const f of [ep3, ep3sub, ep2]) fs.writeFileSync(f, "x".repeat(1024));

  config.LIBRARIES.shows = [root];
  config.LIBRARIES.movies = [];
  scanner.scan = () => {}; // the real scan would re-index the live library roots

  const dstore = downloads._internals.store;
  dstore.save = () => {};
  dstore.data = [
    { id: "j3", smart: true, status: "done", destPath: ep3, profile: "p-alice", imdbId: "tt0903747", season: 1, episode: 3, label: "Breaking Bad · S1 E3" },
    { id: "j2", smart: false, status: "done", destPath: ep2, profile: "p-alice", imdbId: "tt0903747", season: 1, episode: 2 },
  ];
  const pstore = profiles._internals.store;
  pstore.save = () => {};
  pstore.data = {
    profiles: [{ id: "p-alice", name: "Alice", prefs: {} }],
    state: {
      "p-alice": {
        // finished S1E2 and S1E3 — E3 via a torrent stream, before the file even existed
        progress: {
          "torrent|aaa|0": { position: 2600, duration: 2700, finished: true, updatedAt: 1 },
          "torrent|bbb|0": { position: 2650, duration: 2700, finished: true, updatedAt: 2 },
        },
        streamItems: {
          "torrent|aaa|0": { imdbId: "tt0903747", season: 1, episode: 2 },
          "torrent|bbb|0": { imdbId: "tt0903747", season: 1, episode: 3 },
        },
      },
    },
    pending: [],
    access: {},
  };
  smartclean._internals.lastRun.clear();

  // barely into E4: nothing happens yet
  let r = await smartclean.onProgress("p-alice", "torrent|ccc|0", 20, 2700, { imdbId: "tt0903747", season: 1, episode: 4 });
  assert.deepEqual(r.cleaned, []);
  assert.ok(fs.existsSync(ep3));

  // properly into E4 (after the throttle window)
  smartclean._internals.lastRun.clear();
  r = await smartclean.onProgress("p-alice", "torrent|ccc|0", 300, 2700, { imdbId: "tt0903747", season: 1, episode: 4 });
  assert.equal(r.cleaned.length, 1);
  assert.equal(r.cleaned[0].job, "j3");
  assert.equal(fs.existsSync(ep3), false, "the smart episode is gone");
  assert.equal(fs.existsSync(ep3sub), false, "its sidecar subtitle went with it");
  assert.equal(fs.existsSync(ep2), true, "the hand-downloaded episode is untouched");
  assert.equal(fs.existsSync(s1), true, "the season folder stays while it still holds files");
  assert.deepEqual(dstore.data.map((j) => j.id), ["j2"], "the cleaned job dropped off the downloads list");

  fs.rmSync(root, { recursive: true, force: true });
});

// Where a profile stands with a title.
//
// Every "Unwatched" filter in the app used to ask `progress[item.id]`, which only
// ever answers for a downloaded FILM. A series files its history under each
// EPISODE's own id; a streamed film files it under the torrent file it played
// from; a streamed episode lives in a separate map keyed by show. So the lookup
// came back empty for all three, and the filter offered you the series you
// finished last week.
const test = require("node:test");
const assert = require("node:assert");

let mod;
test.before(async () => {
  mod = await import("../public/js/state.js");
});

const NOW = Date.parse("2026-07-28T12:00:00Z");
const done = (at = NOW) => ({ position: 100, duration: 100, finished: true, updatedAt: at });
const partway = (at = NOW) => ({ position: 30, duration: 100, finished: false, updatedAt: at });

// The client's whole view of history, replaced per test.
const history = ({ progress = {}, episodeProgress = {}, streamProgress = {} } = {}) => {
  Object.assign(mod.state, { progress, episodeProgress, streamProgress });
};

const show = (id, episodeIds, extra = {}) => ({
  id,
  type: "show",
  title: "A Series",
  seasons: [{ number: 1, episodes: episodeIds.map((epId, at) => ({ id: epId, episode: at + 1 })) }],
  ...extra,
});

// ---------- downloaded films ----------

test("a finished film is finished, an unstarted one is untouched", () => {
  history({ progress: { m1: done() } });
  assert.deepStrictEqual(mod.watchState({ id: "m1", type: "movie" }), {
    started: true,
    finished: true,
    at: NOW,
  });
  const fresh = mod.watchState({ id: "m2", type: "movie" });
  assert.strictEqual(fresh.started, false);
  assert.strictEqual(fresh.finished, false);
});

test("a film left half-watched is started but not finished", () => {
  history({ progress: { m1: partway() } });
  const s = mod.watchState({ id: "m1", type: "movie" });
  assert.strictEqual(s.started, true);
  assert.strictEqual(s.finished, false);
});

// ---------- streamed films ----------

test("a streamed film played from a torrent counts as watched", () => {
  // The progress key names the torrent file, so only the by-IMDb map can connect
  // it to the card. This is the case the old filter could never see.
  history({
    progress: { "torrent|abc123|0": done() },
    streamProgress: { tt99: done() },
  });
  const s = mod.watchState({ id: "disc:tt99", imdbId: "tt99", type: "movie" });
  assert.strictEqual(s.finished, true);
  assert.strictEqual(s.at, NOW);
});

test("a streamed film ticked off by hand counts as watched", () => {
  history({ progress: { "stream|tt77": done() } });
  assert.strictEqual(mod.watchState({ id: "disc:tt77", imdbId: "tt77", type: "movie" }).finished, true);
});

// ---------- series ----------

test("a series is finished only once every episode is", () => {
  history({ progress: { e1: done(NOW - 5000), e2: done(NOW) } });
  const all = mod.watchState(show("s1", ["e1", "e2"]));
  assert.strictEqual(all.finished, true);
  assert.strictEqual(all.at, NOW, "reports the most recent episode watched");

  history({ progress: { e1: done() } });
  const some = mod.watchState(show("s1", ["e1", "e2"]));
  assert.strictEqual(some.started, true);
  assert.strictEqual(some.finished, false);
});

test("a series nobody has touched is untouched", () => {
  history();
  const s = mod.watchState(show("s1", ["e1", "e2"]));
  assert.strictEqual(s.started, false);
  assert.strictEqual(s.finished, false);
  assert.strictEqual(s.at, 0);
});

test("streamed episodes count towards the series that owns them", () => {
  history({ episodeProgress: { "tt55:1:1": done(), "tt55:1:2": partway(), "tt66:1:1": done() } });
  const s = mod.watchState({ id: "disc:tt55", imdbId: "tt55", type: "show" });
  assert.strictEqual(s.started, true);
  // Without an episode list there is no way to know the run is complete, so a
  // streamable series stays in progress rather than claiming to be done.
  assert.strictEqual(s.finished, false);
});

test("a series with no episode list never claims to be finished", () => {
  history({ episodeProgress: { "tt55:1:1": done() } });
  assert.strictEqual(mod.watchState({ imdbId: "tt55", type: "show" }).finished, false);
});

test("nothing at all is safe to ask about", () => {
  history();
  assert.deepStrictEqual(mod.watchState(null), { started: false, finished: false, at: 0 });
});

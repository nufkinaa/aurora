// Downloads ahead and what the night prepares, for whom (src/media/smartdl.js
// ahead, src/media/overnight.js gatherWants): a person in the middle of a
// show gets the next episode in the "Next episode" class and the one after
// in "Background"; nothing on disk or on its way is asked again; the
// person's own switch is obeyed; films are never fetched ahead. The night's
// plan picks the next episodes, the top of Continue watching and what was
// asked for — and only what a device of THESE people cannot play as it is.
// Every module the two talk to is a stand-in here (no torrents, no network,
// no data/).
const test = require("node:test");
const assert = require("node:assert/strict");

const smartdl = require("../src/media/smartdl");
const overnight = require("../src/media/overnight");
const dlprio = require("../src/media/dlprio");
const identity = require("../src/media/identity");
const discover = require("../src/media/discover");
const torrent = require("../src/media/torrent");
const downloads = require("../src/media/downloads");
const torrentgate = require("../src/lib/torrentgate");
const profiles = require("../src/profiles");
const scanner = require("../src/media/scanner");
const avcaps = require("../src/media/avcaps");
const prepared = require("../src/media/prepared");

const HOUR = 3600e3;
const NOW = Date.now();
const SHOW = "tt7000001";
const META = {
  title: "Night Show", year: 2024, poster: null,
  seasons: [{ number: 1, episodes: [1, 2, 3, 4, 5].map((e) => ({ season: 1, episode: e, title: `E${e}`, released: "2024-01-0" + e })) }],
};
const SOURCES = (s, e) => [
  { infoHash: `${String(e).repeat(40)}`.slice(0, 40), fileIdx: 0, quality: "1080p", seeders: 50, sizeBytes: 9e8, provider: "test", recommended: true, release: `Night.Show.S0${s}E0${e}.1080p` },
];

const saved = [];
const patch = (obj, name, fn) => { saved.push([obj, name, obj[name]]); obj[name] = fn; };
let onDisk = new Set();
let queue = [];
let created = [];
test.before(() => {
  patch(torrentgate, "enabled", () => true);
  patch(discover, "meta", async (kind, id) => (id === SHOW ? META : null));
  patch(discover, "metaCached", () => null);
  patch(identity, "findLibraryPlayable", (w) => (w.imdbId === SHOW && onDisk.has(`${w.season}:${w.episode}`) ? { id: `lib-${w.season}-${w.episode}`, showId: "show1" } : null));
  patch(identity, "ensureStamped", () => {});
  patch(identity, "imdbIdFor", () => SHOW);
  patch(torrent, "getSources", async (kind, id, year, s, e) => ({ streams: SOURCES(s, e) }));
  patch(downloads, "list", () => queue);
  patch(downloads, "create", (f) => { created.push(f); const job = { id: `job${created.length}`, ...f, status: "approved" }; queue.push(job); return { job }; });
});
test.after(() => { for (const [obj, name, fn] of saved.reverse()) obj[name] = fn; });
test.beforeEach(() => { onDisk = new Set(); queue = []; created = []; smartdl._internals.tried.clear?.(); });

const ME = { id: "p1", name: "Pat", prefs: {} };

test("ahead: finished E2 → E3 as the next episode, E4 as the one after — the queue's classes", async () => {
  onDisk = new Set(["1:1", "1:2"]);
  const r = await smartdl.ahead(ME, { imdbId: SHOW, anchor: { season: 1, episode: 2, finished: true, quality: "1080p" }, depth: 2, now: NOW });
  assert.deepEqual(r.episodes.map((e) => [e.episode, e.state]), [[3, "queued"], [4, "queued"]]);
  assert.deepEqual(created.map((c) => [c.episode, c.auto, c.smart, c.profile]), [[3, "next", true, "p1"], [4, "ahead", true, "p1"]]);
  assert.equal(dlprio.baseClass({ smart: true, auto: "next" }, NOW), dlprio.AUTO, "Next episode");
  assert.equal(dlprio.baseClass({ smart: true, auto: "ahead" }, NOW), dlprio.BACKGROUND, "Background");
});

test("ahead: an unfinished streamed episode is fetched itself first; on disk or on its way is never asked again", async () => {
  onDisk = new Set(["1:4"]);
  queue = [{ id: "old", imdbId: SHOW, season: 1, episode: 3, status: "downloading" }];
  const r = await smartdl.ahead(ME, { imdbId: SHOW, anchor: { season: 1, episode: 2, finished: false, quality: "720p" }, depth: 2, now: NOW });
  assert.deepEqual(r.episodes.map((e) => [e.episode, e.state]), [[2, "queued"], [3, "in-queue"]]);
  assert.equal(created.length, 1);
  assert.equal(created[0].episode, 2);
  assert.equal(created[0].auto, "next");
  const again = await smartdl.ahead(ME, { imdbId: SHOW, anchor: { season: 1, episode: 3, finished: true }, depth: 2, now: NOW });
  assert.deepEqual(again.episodes.map((e) => [e.episode, e.state]), [[4, "on-disk"], [5, "queued"]]);
});

test("ahead: one try per episode per six hours; the person's switch and the torrent switch are obeyed; depth 0 is nothing", async () => {
  torrent.getSources = async () => ({ streams: [] }); // nobody shares it
  const r1 = await smartdl.ahead(ME, { imdbId: SHOW, anchor: { season: 1, episode: 1, finished: true }, depth: 1, now: NOW });
  assert.equal(r1.episodes[0].state, "no-source");
  const r2 = await smartdl.ahead(ME, { imdbId: SHOW, anchor: { season: 1, episode: 1, finished: true }, depth: 1, now: NOW + HOUR });
  assert.equal(r2.episodes[0].state, "tried-lately");
  torrent.getSources = async (kind, id, year, s, e) => ({ streams: SOURCES(s, e) });
  assert.match((await smartdl.ahead({ ...ME, prefs: { smartDownloads: false } }, { imdbId: SHOW, anchor: { season: 1, episode: 1, finished: true }, depth: 2 })).skipped, /smart downloads are off/);
  assert.match((await smartdl.ahead(ME, { imdbId: SHOW, anchor: { season: 1, episode: 1, finished: true }, depth: 0 })).skipped, /nothing ahead/);
  torrentgate.enabled = () => false;
  assert.match((await smartdl.ahead(ME, { imdbId: SHOW, anchor: { season: 1, episode: 1, finished: true }, depth: 2 })).skipped, /torrents are off/);
  torrentgate.enabled = () => true;
  assert.equal(created.length, 0);
});

// ---------------------------------------------------------------- the night's plan
const CHROME = avcaps.normalize({ client: "web", model: "Chrome", video: { h264: { profiles: ["main", "high"] } }, audio: { decode: ["aac", "opus"] }, containers: { mp4: ["h264"] } });
const TV = avcaps.normalize({ client: "tv", model: "TV", video: { h264: { profiles: ["high"] }, hevc: { profiles: ["main", "main10"] } }, audio: { decode: ["aac", "ac3", "eac3"] }, containers: { mp4: true, mkv: true } });
const CHROME_ID = avcaps.idOf(CHROME);
const TV_ID = avcaps.idOf(TV);
const lib = (id, over = {}) => ({ id, videoUrl: `/stream/video/${id}`, container: "mkv", width: 1920, height: 1080, duration: 2700, sizeBytes: 1.2e9,
  video: { codec: "hevc", bitDepth: 10, profile: "Main 10" }, audio: { codec: "eac3", channels: 6 }, ...over });
const ITEMS = {
  "lib-1-3": lib("lib-1-3", { showId: "show1", season: 1, episode: 3 }),
  "lib-1-4": lib("lib-1-4", { showId: "show1", season: 1, episode: 4, video: { codec: "h264", bitDepth: 8, profile: "High" }, container: "mp4", audio: { codec: "aac", channels: 2 } }),
  film1: lib("film1", { title: "A Film", container: "mkv", video: { codec: "h264", bitDepth: 8, profile: "High" }, audio: { codec: "ac3", channels: 6 } }),
  film2: lib("film2", { title: "Asked Film" }),
  show1: { id: "show1", type: "show", title: "Night Show", imdbId: SHOW },
};

test("the plan: the next episodes, the top of Continue watching, what was asked for — and only where these people's devices need it", async () => {
  onDisk = new Set(["1:3", "1:4"]);
  const stub = [
    [profiles, "list", () => [{ id: "p1", name: "Pat", prefs: {} }, { id: "p2", name: "Sam", prefs: {} }]],
    [profiles, "getProgressView", (pid) => (pid === "p1" ? { "lib-1-2": { position: 2700, duration: 2700, finished: true, updatedAt: NOW - HOUR } } : {})],
    [profiles, "getStreamItems", () => ({})],
    [profiles, "continueWatching", (pid) => (pid === "p2" ? [{ ...ITEMS.film1, progress: { position: 600, updatedAt: NOW - 2 * HOUR } }] : [])],
    [scanner, "findById", (id) => ITEMS[id] || (id === "lib-1-2" ? lib("lib-1-2", { showId: "show1", season: 1, episode: 2 }) : null)],
    [scanner, "idForPath", (p) => (p === "/lib/asked.mkv" ? "film2" : null)],
    [downloads, "rawJobs", () => [{ id: "j", status: "done", smart: false, destPath: "/lib/asked.mkv", doneAt: new Date(NOW - 3 * HOUR).toISOString(), profile: "p2", label: "Asked Film", type: "movie" }]],
    [avcaps, "lookup", (id) => (id === CHROME_ID ? CHROME : id === TV_ID ? TV : null)],
    [avcaps, "recent", () => [{ id: TV_ID, caps: TV, at: NOW }, { id: CHROME_ID, caps: CHROME, at: NOW }]],
    [prepared, "sourceOf", (id) => ({ path: `/lib/${id}`, mtime: 1, size: 1.2e9 })],
  ];
  const back = stub.map(([o, n, f]) => { const was = o[n]; o[n] = f; return [o, n, was]; });
  const store = overnight._internals.theState;
  overnight._internals.setState({ data: { devices: { p1: { [CHROME_ID]: NOW - HOUR }, p2: { [TV_ID]: NOW - HOUR } }, ahead: [], runs: [] }, save() {} });
  try {
    const g = await overnight.gatherWants(NOW);
    const by = Object.fromEntries(g.wants.map((w) => [w.key, w]));
    // Pat finished E2 and plays on Chrome: E3 (HEVC 10-bit) needs the h264 one; E4 is plain MP4
    assert.ok(by["lib-1-3|h264"], JSON.stringify(Object.keys(by)));
    assert.equal(by["lib-1-3|h264"].reason, "next");
    assert.deepEqual(by["lib-1-3|h264"].persons, ["p1"]);
    assert.ok(!Object.keys(by).some((k) => k.startsWith("lib-1-4|")), "a file Chrome plays as it is needs nothing");
    // Sam is on the TV, which plays the MKV / AC-3 film as it is: nothing for them
    assert.ok(!Object.keys(by).some((k) => k.startsWith("film1|")));
    assert.ok(!Object.keys(by).some((k) => k.startsWith("film2|")), "the TV decodes HEVC in MKV with E-AC-3");
    assert.ok(g.notes.some((n) => n.id === "film1" && /plays it as it is/.test(n.why)));
    const reasons = Object.fromEntries(g.considered.map((c) => [c.id, c.reason]));
    assert.deepEqual(reasons, { "lib-1-3": "next", "lib-1-4": "next", film1: "continue", film2: "landed" });
    // with nothing known of Sam's devices, the whole house counts: Chrome needs the film's copy
    overnight._internals.setState({ data: { devices: {}, ahead: [], runs: [] }, save() {} });
    const g2 = await overnight.gatherWants(NOW);
    assert.ok(g2.wants.some((w) => w.key === "film1|copy"), JSON.stringify(g2.wants.map((w) => w.key)));
  } finally {
    for (const [o, n, was] of back) o[n] = was;
    overnight._internals.setState(null);
    void store;
  }
});

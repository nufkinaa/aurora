// The overnight preparation's rules (media/overnightplan.js), pinned on the
// pure functions: who is watching which show and what comes next, what each
// device needs, the disk budget, the clean-up, the runner's decisions (pause
// the moment somebody watches), and the admin's line.
const test = require("node:test");
const assert = require("node:assert/strict");
const plan = require("../src/media/overnightplan");
const avcaps = require("../src/media/avcaps");
const playpath = require("../src/media/playpath");

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

// ---------- devices, as their reports read once normalized ----------
const CHROME = avcaps.normalize({
  client: "web", model: "Chrome",
  video: { h264: { profiles: ["baseline", "main", "high"] }, vp9: { profiles: ["0"] }, av1: { profiles: ["main"] } },
  audio: { decode: ["aac", "mp3", "opus", "flac", "vorbis"] },
  containers: { mp4: ["h264", "av1", "vp9"], webm: ["vp9", "av1"] },
});
const SAFARI = avcaps.normalize({
  client: "web", model: "iPhone",
  video: { h264: { profiles: ["baseline", "main", "high"] }, hevc: { profiles: ["main", "main10"] } },
  hdr: ["hdr10", "hlg", "dv"], dv: [5, 8],
  audio: { decode: ["aac", "mp3", "ac3", "eac3", "flac", "alac"] },
  containers: { mp4: ["h264", "hevc"], mov: ["h264", "hevc"] },
});
const TV_HDR = avcaps.normalize({
  client: "tv", model: "MiTV",
  video: { h264: { profiles: ["high"] }, hevc: { profiles: ["main", "main10"], maxW: 3840, maxH: 2160 } },
  hdr: ["hdr10", "hlg"],
  audio: { decode: ["aac", "ac3", "eac3", "mp3", "opus", "flac"], passthrough: ["ac3", "eac3"] },
  containers: { mp4: true, mkv: true, ts: true, webm: true },
});
const TV_SDR = avcaps.normalize({
  client: "tv", model: "Old TV",
  video: { h264: { profiles: ["high"] }, hevc: { profiles: ["main", "main10"] } },
  hdr: [],
  audio: { decode: ["aac", "ac3", "eac3"], passthrough: [] },
  containers: { mp4: true, mkv: true },
});
const dev = (id, caps) => ({ id, caps });

// ---------- files, in playpath's facts ----------
const facts = (over = {}) => ({
  container: "mkv", width: 1920, height: 1080,
  video: { codec: "hevc", bitDepth: 10, hdr: null, fps: 23.976, profile: "Main 10", dvProfile: null, dvCompat: null },
  audio: [{ index: 0, codec: "eac3", channels: 6, profile: null, atmos: false }],
  ...over,
});
const H264_AC3_MKV = facts({ video: { codec: "h264", bitDepth: 8, hdr: null, fps: 25, profile: "High" }, audio: [{ index: 0, codec: "ac3", channels: 6 }] });
const HEVC_HDR_4K = facts({ width: 3840, height: 2160, video: { codec: "hevc", bitDepth: 10, hdr: "hdr10", fps: 23.976, profile: "Main 10" }, audio: [{ index: 0, codec: "dts", channels: 6 }] });
const MP4_PLAIN = facts({ container: "mp4", video: { codec: "h264", bitDepth: 8, hdr: null, fps: 25, profile: "High" }, audio: [{ index: 0, codec: "aac", channels: 2 }] });

// ================================================================ settings
test("settings: defaults on, 02:00–07:00, 10% of the free space, two episodes ahead; odd values read as the default", () => {
  assert.deepEqual(plan.settingsOf(undefined), { on: true, from: "02:00", to: "07:00", budgetPct: 10, aheadEpisodes: 2 });
  assert.deepEqual(plan.settingsOf({ on: false, from: "1:30", to: "06:15", budgetPct: 25, aheadEpisodes: 1 }), { on: false, from: "01:30", to: "06:15", budgetPct: 25, aheadEpisodes: 1 });
  const odd = plan.settingsOf({ from: "25:00", to: "nope", budgetPct: 900, aheadEpisodes: 7 });
  assert.equal(odd.from, "02:00");
  assert.equal(odd.to, "07:00");
  assert.equal(odd.budgetPct, 50); // clamped to the most it may be
  assert.equal(odd.aheadEpisodes, 2);
  assert.equal(plan.settingsOf({ budgetPct: 0 }).budgetPct, 1);
  // a window with no length is no setting
  assert.deepEqual([plan.settingsOf({ from: "03:00", to: "03:00" }).from, plan.settingsOf({ from: "03:00", to: "03:00" }).to], ["02:00", "07:00"]);
  assert.equal(plan.settingsOf({ aheadEpisodes: 0 }).aheadEpisodes, 0);
});

test("timing: config.json may override by name, nothing else", () => {
  const t = plan.timingOf({ quietStartMs: 1000, nonsense: 5, tickMs: -3 });
  assert.equal(t.quietStartMs, 1000);
  assert.equal(t.tickMs, plan.TIMING.tickMs);
  assert.equal(t.nonsense, undefined);
});

// ================================================================ the hours
const at = (h, m = 0, day = 10) => new Date(2026, 10, day, h, m, 0, 0).getTime();
test("quiet hours: inside / outside, and a window that wraps past midnight", () => {
  const s = plan.settingsOf({});
  assert.equal(plan.inWindow(at(1, 59), s), false);
  assert.equal(plan.inWindow(at(2, 0), s), true);
  assert.equal(plan.inWindow(at(6, 59), s), true);
  assert.equal(plan.inWindow(at(7, 0), s), false);
  const wrap = plan.settingsOf({ from: "23:30", to: "05:00" });
  assert.equal(plan.inWindow(at(23, 45), wrap), true);
  assert.equal(plan.inWindow(at(0, 30), wrap), true);
  assert.equal(plan.inWindow(at(5, 0), wrap), false);
  assert.equal(plan.inWindow(at(12, 0), wrap), false);
});

test("next run: today's start when it is still ahead, else tomorrow's; the end of the window", () => {
  const s = plan.settingsOf({});
  assert.equal(plan.nextStart(at(1, 0), s), at(2, 0));
  assert.equal(plan.nextStart(at(3, 0), s), at(2, 0, 11));
  assert.equal(plan.nextStart(at(20, 0), s), at(2, 0, 11));
  assert.equal(plan.windowEnd(at(3, 0), s), at(7, 0));
  assert.equal(plan.clockOf(at(2, 0)), "02:00");
});

// ================================================================ who watches what
const NOW = at(21, 0);
const row = (imdbId, season, episode, over = {}) => ({ itemId: `lib-${imdbId}-${season}-${episode}`, ep: { imdbId, season, episode, quality: "1080p" }, position: 1200, duration: 2700, finished: false, updatedAt: NOW - HOUR, ...over });

test("active shows: one per show, the latest episode its anchor; older than two weeks or a peek does not count", () => {
  const rows = [
    row("tt1", 1, 3, { finished: true, updatedAt: NOW - 2 * DAY }),
    row("tt1", 1, 4, { position: 600, updatedAt: NOW - HOUR }), // the latest of tt1
    row("tt2", 2, 1, { updatedAt: NOW - 15 * DAY }),            // too long ago
    row("tt3", 1, 1, { position: 20, updatedAt: NOW - HOUR }),  // a peek
    row("tt4", 1, 9, { position: 2600, duration: 2700, finished: false, updatedAt: NOW - 3 * HOUR }), // all but the credits
    { itemId: "film", ep: null, position: 3000, updatedAt: NOW },
  ];
  const shows = plan.activeShows(rows, { now: NOW });
  assert.deepEqual(shows.map((s) => s.imdbId), ["tt1", "tt4"]);
  assert.deepEqual([shows[0].anchor.season, shows[0].anchor.episode, shows[0].anchor.finished], [1, 4, false]);
  assert.equal(shows[1].anchor.finished, true, "within the last tenth counts as finished");
});

const SEASONS = [
  { number: 0, episodes: [{ season: 0, episode: 1 }] },
  { number: 1, episodes: [1, 2, 3].map((e) => ({ season: 1, episode: e, released: "2020-01-0" + e })) },
  { number: 2, episodes: [{ season: 2, episode: 1, released: "2021-01-01" }, { season: 2, episode: 2, released: "2999-01-01" }] },
];
test("upcoming: the unfinished episode itself first, then what follows across seasons; never one not aired", () => {
  assert.deepEqual(plan.upcoming(SEASONS, { season: 1, episode: 2, finished: true }, 2, NOW).map((e) => `${e.season}x${e.episode}`), ["1x3", "2x1"]);
  assert.deepEqual(plan.upcoming(SEASONS, { season: 1, episode: 2, finished: false }, 2, NOW).map((e) => `${e.season}x${e.episode}`), ["1x2", "1x3"]);
  assert.deepEqual(plan.upcoming(SEASONS, { season: 2, episode: 1, finished: true }, 2, NOW), [], "the next has not aired");
  assert.deepEqual(plan.upcoming(SEASONS, { season: 1, episode: 3, finished: true }, 1, NOW).map((e) => e.nth), [0]);
  assert.deepEqual(plan.upcoming(SEASONS, { season: 9, episode: 9, finished: true }, 2, NOW), [], "an episode the catalogue does not know");
  assert.deepEqual(plan.upcoming(SEASONS, { season: 1, episode: 1, finished: true }, 0, NOW), []);
});

test("how many ahead: the setting, less when the disk forecast is short", () => {
  assert.equal(plan.aheadDepth({ setting: 2, forecast: null }).depth, 2);
  assert.equal(plan.aheadDepth({ setting: 2, forecast: { state: "flat" } }).depth, 2);
  assert.equal(plan.aheadDepth({ setting: 2, forecast: { state: "filling", daysLeft: 90, short: "about 3 months until full" } }).depth, 2);
  const one = plan.aheadDepth({ setting: 2, forecast: { state: "filling", daysLeft: 20, short: "about 20 days until full" } });
  assert.equal(one.depth, 1);
  assert.match(one.why, /only the next episode/);
  const none = plan.aheadDepth({ setting: 2, forecast: { state: "filling", daysLeft: 4, short: "about 4 days until full" } });
  assert.equal(none.depth, 0);
  assert.match(none.why, /nothing is downloaded ahead/);
  assert.equal(plan.aheadDepth({ setting: 0 }).depth, 0);
  assert.equal(plan.aheadDepth({ setting: 1, forecast: { state: "filling", daysLeft: 20 } }).depth, 1);
});

// ================================================================ what each device needs
test("needs: a file every device plays as it is needs nothing", () => {
  const n = plan.needsOf(MP4_PLAIN, [dev("c", CHROME), dev("t", TV_HDR), dev("s", SAFARI)]);
  assert.equal(n.kinds.size, 0);
  assert.ok(n.rows.every((r) => r.mode === "direct"));
});

test("needs: H.264 + AC-3 in MKV — Chrome gets the copy (picture copied, AAC), the TV plays it as it is", () => {
  const n = plan.needsOf(H264_AC3_MKV, [dev("c", CHROME), dev("t", TV_HDR)]);
  assert.deepEqual([...n.kinds], ["copy"]);
  assert.equal(n.rows.find((r) => r.id === "c").mode, "remux");
  assert.equal(n.rows.find((r) => r.id === "t").kind, null);
  // and the copy really does play directly in Chrome
  assert.equal(playpath.decide(plan.copyFacts(H264_AC3_MKV), CHROME).mode, "direct");
});

test("needs: 10-bit HEVC — Chrome cannot decode it (the h264), Safari only needs the container and sound (the copy)", () => {
  const n = plan.needsOf(facts(), [dev("c", CHROME), dev("s", SAFARI)]);
  assert.deepEqual([...n.kinds].sort(), ["copy", "h264"]);
  assert.equal(n.rows.find((r) => r.id === "c").kind, "h264");
  assert.equal(n.rows.find((r) => r.id === "s").kind, "copy");
});

test("needs: 4K HDR with DTS — the HDR TV is never handed a 1080p H.264 (it only needs the sound fixed)", () => {
  const n = plan.needsOf(HEVC_HDR_4K, [dev("t", TV_HDR)]);
  assert.deepEqual([...n.kinds], ["copy"]);
  // …and an SDR TV, where the picture is the problem, gets the tone-mapped H.264
  const sdr = plan.needsOf(HEVC_HDR_4K, [dev("o", TV_SDR)]);
  assert.deepEqual([...sdr.kinds], ["h264"]);
  assert.equal(plan.h264Facts(HEVC_HDR_4K).height, 1080);
  assert.equal(plan.h264Facts(HEVC_HDR_4K).width, 1920);
  assert.equal(plan.h264Facts(HEVC_HDR_4K).video.hdr, null);
});

test("needs: no tone mapping here — no h264 of an HDR file (grey is worse than live); Dolby Vision profile 5 never", () => {
  assert.equal(plan.needsOf(HEVC_HDR_4K, [dev("o", TV_SDR)], { tonemap: false }).kinds.size, 0);
  const dv5 = facts({ video: { codec: "hevc", bitDepth: 10, hdr: "dolby-vision", dvProfile: 5, dvCompat: 0, fps: 24, profile: "Main 10" } });
  assert.equal(plan.h264Facts(dv5), null);
  assert.equal(plan.copyFacts(dv5), null, "DV is not repackaged either");
});

test("needs: a picture nothing copies (MPEG-2) — the h264 one for a browser, never a copy", () => {
  const mpeg2 = facts({ video: { codec: "mpeg2", bitDepth: 8, hdr: null, fps: 25, profile: "Main" }, audio: [{ index: 0, codec: "ac3", channels: 2 }] });
  assert.equal(plan.copyFacts(mpeg2), null);
  assert.deepEqual([...plan.needsOf(mpeg2, [dev("c", CHROME)]).kinds], ["h264"]);
});

test("needs: never upscaled — a 720p source makes a 720p H.264", () => {
  const f = facts({ width: 1280, height: 720 });
  assert.equal(plan.h264Facts(f).height, 720);
  assert.equal(plan.h264Facts(f).width, 1280);
});

test("pickReady: the copy first, the h264 only where the file itself would be encoded live, and only when it plays directly", () => {
  const ready = [
    { kind: "copy", facts: plan.copyFacts(facts()), audioIndex: 0 },
    { kind: "h264", facts: plan.h264Facts(facts()), audioIndex: 0 },
  ];
  const onChrome = plan.pickReady(ready, CHROME, playpath.decide(facts(), CHROME));
  assert.equal(onChrome.kind, "h264", "Chrome cannot decode the HEVC copy");
  const onSafari = plan.pickReady(ready, SAFARI, playpath.decide(facts(), SAFARI));
  assert.equal(onSafari.kind, "copy");
  assert.equal(onSafari.play.mode, "direct");
  // the HDR TV that only lacked DTS: never the 1080p one
  const hdrReady = [{ kind: "h264", facts: plan.h264Facts(HEVC_HDR_4K) }];
  assert.equal(plan.pickReady(hdrReady, TV_HDR, playpath.decide(HEVC_HDR_4K, TV_HDR)), null);
  // a file that plays directly: nothing to swap
  assert.equal(plan.pickReady(ready, TV_HDR, playpath.decide(MP4_PLAIN, TV_HDR)), null);
  assert.equal(plan.pickReady(ready, null, { mode: "transcode" }), null);
});

// ================================================================ sizes and the budget
test("estimates: the copy weighs the file, the h264 its length at ~5.4 Mbit/s (1080p)", () => {
  assert.equal(plan.estimateBytes("copy", { sizeBytes: 1.2e9 }), 1.2e9);
  const h = plan.estimateBytes("h264", { duration: 2700, height: 2160 });
  assert.ok(h > 1.7e9 && h < 2e9, String(h));
  assert.ok(plan.estimateBytes("h264", { duration: 2700, height: 720 }) < h);
});

test("budget: 10% of what the prepared files could have, never past the headroom, 0 when the disk can't be read", () => {
  assert.equal(plan.budgetBytes({ freeBytes: 100 * GB, preparedBytes: 0, pct: 10 }), 10 * GB);
  assert.equal(plan.budgetBytes({ freeBytes: 90 * GB, preparedBytes: 10 * GB, pct: 10 }), 10 * GB, "what is prepared counts: the budget does not shrink as it fills");
  assert.equal(plan.budgetBytes({ freeBytes: 6 * GB, preparedBytes: 0, pct: 50, headroomBytes: 5 * GB }), 1 * GB);
  assert.equal(plan.budgetBytes({ freeBytes: 2 * GB, preparedBytes: 0, pct: 50, headroomBytes: 5 * GB }), 0);
  assert.equal(plan.budgetBytes({ freeBytes: null }), 0);
});

const want = (id, kind, reason, bytes, at = NOW) => ({ key: `${id}|${kind}`, id, kind, reason, bytes, at, label: id, persons: ["p1"] });
test("fit: the next episodes first, the h264 before the copy, inside the budget; the rest skipped with why", () => {
  const wants = [
    want("cw", "copy", "continue", 3 * GB),
    want("e2", "copy", "next", 1 * GB, NOW - HOUR),
    want("e1", "h264", "next", 2 * GB),
    want("landed", "h264", "landed", 2 * GB),
  ];
  const f = plan.fit({ wants, have: new Map(), budget: 5 * GB });
  // (a smaller one further down still fills the room a bigger one could not)
  assert.deepEqual(f.make.map((w) => w.key), ["e1|h264", "e2|copy", "landed|h264"]);
  assert.deepEqual(f.skip.map((w) => w.key), ["cw|copy"]);
  assert.equal(f.skip[0].why, "over the disk budget");
  assert.equal(f.usedBytes, 5 * GB);
  assert.deepEqual(plan.fit({ wants, have: new Map(), budget: 3 * GB }).make.map((w) => w.key), ["e1|h264", "e2|copy"]);
});

test("fit: what is on disk and still wanted stays (not made again); what nobody wants goes when room is short", () => {
  const have = new Map([["e1|h264", { bytes: 2 * GB, madeAt: NOW - DAY }], ["old|copy", { bytes: 3 * GB, madeAt: NOW - 3 * DAY }]]);
  const f = plan.fit({ wants: [want("e1", "h264", "next", 2 * GB), want("e2", "h264", "next", 2 * GB)], have, budget: 5 * GB });
  assert.deepEqual(f.keep, ["e1|h264"]);
  assert.deepEqual(f.make.map((w) => w.key), ["e2|h264"]);
  assert.deepEqual(f.evict.map((e) => e.key), ["old|copy"]);
  // with room for everything, the unwanted one is left for the clean-up rules
  assert.deepEqual(plan.fit({ wants: [want("e1", "h264", "next", 2 * GB)], have, budget: 50 * GB }).evict, []);
});

test("fit: a budget too small for what is on disk evicts the least wanted first", () => {
  const have = new Map([["a|h264", { bytes: 2 * GB }], ["b|h264", { bytes: 2 * GB }]]);
  const f = plan.fit({ wants: [want("a", "h264", "next", 2 * GB), want("b", "h264", "landed", 2 * GB)], have, budget: 3 * GB });
  assert.deepEqual(f.keep, ["a|h264"]);
  assert.deepEqual(f.evict.map((e) => e.key), ["b|h264"]);
});

// ================================================================ the clean-up
test("clean-up: gone from the library, replaced, watched by everyone, not needed for a week — never while it plays", () => {
  const items = [
    { key: "gone|copy", id: "gone", persons: ["a"], madeAt: NOW - HOUR, srcMtime: 1 },
    { key: "repl|copy", id: "repl", persons: ["a"], madeAt: NOW - HOUR, srcMtime: 1 },
    { key: "seen|h264", id: "seen", persons: ["a", "b"], madeAt: NOW - HOUR, srcMtime: 1 },
    { key: "half|h264", id: "half", persons: ["a", "b"], madeAt: NOW - HOUR, srcMtime: 1 },
    { key: "stale|copy", id: "stale", persons: ["a"], madeAt: NOW - 8 * DAY, usedAt: NOW - 8 * DAY, srcMtime: 1 },
    { key: "used|copy", id: "used", persons: ["a"], madeAt: NOW - 8 * DAY, usedAt: NOW - DAY, srcMtime: 1 },
    { key: "wanted|copy", id: "wanted", persons: ["a"], madeAt: NOW - 9 * DAY, srcMtime: 1 },
    { key: "playing|copy", id: "playing", persons: ["a"], madeAt: NOW - 9 * DAY, srcMtime: 1 },
  ];
  const f = {
    mtimeOf: (id) => (id === "gone" ? null : id === "repl" ? 2 : 1),
    finished: (id, p) => id === "seen" || (id === "half" && p === "a"),
    partWay: () => false,
    playing: (id) => id === "playing",
    wanted: new Set(["wanted|copy"]),
  };
  const out = plan.cleanup(items, f, { now: NOW });
  assert.deepEqual(out.map((x) => x.key), ["gone|copy", "repl|copy", "seen|h264", "stale|copy"]);
  assert.match(out[2].why, /watched by everyone/);
  assert.match(out[3].why, /7 days/);
});

test("clean-up: watched by everyone it was made for, but someone else is part-way through: it stays", () => {
  const items = [{ key: "x|copy", id: "x", persons: ["a"], madeAt: NOW - HOUR, srcMtime: 1 }];
  const f = { mtimeOf: () => 1, finished: () => true, partWay: () => true, playing: () => false, wanted: new Set() };
  assert.deepEqual(plan.cleanup(items, f, { now: NOW }), []);
});

// ================================================================ the runner: pause the moment somebody watches
const T = plan.TIMING;
test("runner: starts only inside the hours, with something to do, after ten quiet minutes", () => {
  assert.equal(plan.step({ inWindow: false, pending: true, quietMs: Infinity }), "idle");
  assert.equal(plan.step({ inWindow: true, pending: false, quietMs: Infinity }), "idle");
  assert.equal(plan.step({ inWindow: true, pending: true, quietMs: 5 * MIN }), "wait");
  assert.equal(plan.step({ inWindow: true, pending: true, busy: true }), "wait");
  assert.equal(plan.step({ inWindow: true, pending: true, quietMs: T.quietStartMs }), "start");
  assert.equal(plan.step({ on: false, inWindow: true, pending: true }), "idle");
  // Run now: outside the hours too — but never while somebody watches
  assert.equal(plan.step({ forced: true, pending: true, quietMs: Infinity }), "start");
  assert.equal(plan.step({ forced: true, pending: true, busy: true }), "wait");
});

test("runner: somebody starts watching → paused at once; quiet again → goes on; paused too long or the hours over → stopped", () => {
  const job = (paused = false, pausedMs = 0) => ({ running: true, paused, pausedMs });
  assert.equal(plan.step({ inWindow: true, busy: true, job: job() }), "pause");
  assert.equal(plan.step({ inWindow: true, busy: true, job: job(true, MIN) }), "hold");
  assert.equal(plan.step({ inWindow: true, busy: false, quietMs: MIN, job: job(true, 2 * MIN) }), "hold");
  assert.equal(plan.step({ inWindow: true, busy: false, quietMs: T.resumeQuietMs, job: job(true, 5 * MIN) }), "resume");
  assert.equal(plan.step({ inWindow: true, busy: true, job: job(true, T.maxPauseMs) }), "stop");
  assert.equal(plan.step({ inWindow: false, job: job() }), "stop");
  assert.equal(plan.step({ on: false, inWindow: true, job: job() }), "stop");
  assert.equal(plan.step({ inWindow: true, job: job() }), "go-on");
});

// ================================================================ the line
test("the admin's line", () => {
  const two = at(2, 0, 11);
  assert.equal(plan.statusLine({ prepared: { episodes: 6, films: 0 }, ahead: 3, nextRunAt: two }), "Overnight: 6 episodes prepared, 3 downloaded ahead · next run 02:00");
  assert.equal(plan.statusLine({ prepared: { episodes: 1, films: 0 }, ahead: 0, nextRunAt: two }), "Overnight: 1 episode prepared · next run 02:00");
  assert.equal(plan.statusLine({ prepared: { episodes: 2, films: 1 }, ahead: 1, nextRunAt: two }), "Overnight: 3 titles prepared, 1 downloaded ahead · next run 02:00");
  assert.equal(plan.statusLine({ prepared: { episodes: 0, films: 0 }, nextRunAt: two }), "Overnight: nothing prepared yet · next run 02:00");
  assert.equal(plan.statusLine({ prepared: { episodes: 4, films: 0 }, state: "running", making: "5 of 7" }), "Overnight: 4 episodes prepared · preparing 5 of 7 now");
  assert.equal(plan.statusLine({ prepared: { episodes: 4, films: 0 }, state: "paused" }), "Overnight: 4 episodes prepared · paused while someone watches");
  assert.equal(plan.statusLine({ on: false }), "Overnight: off");
});

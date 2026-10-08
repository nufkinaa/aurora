// Every decision of "Downloads at once" (media/dlslots.js) and the
// second-source race (media/dlrace.js), as the pure functions they are. The
// queue that acts on them is played out in test/dlrace-queue.test.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const slots = require("../src/media/dlslots");
const race = require("../src/media/dlrace");

const cfg = race.resolveConfig(undefined);
const MIN = 60 * 1000;
const MIB = 1024 * 1024;
const GB = 1e9;
const T0 = 1_760_000_000_000;
const H = (c) => String(c).repeat(40);

// ---------- downloads at once ----------

test("the setting: whole numbers 1–6, anything else refused; an unreadable saved value is the default 4", () => {
  for (const v of [1, 2, 3, 4, 5, 6, "1", "6", " 3 "]) assert.equal(slots.parseMaxActive(v), Number(v), String(v));
  for (const v of [0, 7, -1, 2.5, "2.5", "", "six", null, undefined, NaN, Infinity, true, [], {}, "1e1", "0x2"]) {
    assert.equal(slots.parseMaxActive(v), null, `refused: ${String(v)}`);
  }
  assert.equal(slots.effectiveMaxActive(undefined), 4);
  assert.equal(slots.effectiveMaxActive(99), 4);
  assert.equal(slots.effectiveMaxActive(6), 6);
  assert.equal(slots.DEFAULT_ACTIVE, 4);
});

test("hold while people watch: never more than two started, and only when the setting is higher", () => {
  assert.deepEqual(slots.startCap({ maxActive: 4, watching: 0 }), { cap: 4, holding: false });
  assert.deepEqual(slots.startCap({ maxActive: 4, watching: 1 }), { cap: 2, holding: true });
  assert.deepEqual(slots.startCap({ maxActive: 6, watching: 3 }), { cap: 2, holding: true });
  assert.deepEqual(slots.startCap({ maxActive: 2, watching: 1 }), { cap: 2, holding: false }, "the setting already is two");
  assert.deepEqual(slots.startCap({ maxActive: 1, watching: 5 }), { cap: 1, holding: false }, "never RAISES a lower setting");
  assert.deepEqual(slots.startCap({ maxActive: undefined, watching: 0 }), { cap: 4, holding: false });
});

test("the engine plan: room for the setting plus a race plus metadata, fewer peers per torrent as more run", () => {
  assert.deepEqual(slots.enginePlan(2, 1), { maxConcurrent: 5, btMaxPeers: 100 });
  assert.deepEqual(slots.enginePlan(4, 1), { maxConcurrent: 7, btMaxPeers: 90 });
  assert.deepEqual(slots.enginePlan(6, 1), { maxConcurrent: 9, btMaxPeers: 60 }, "about 60 at six");
  assert.deepEqual(slots.enginePlan(6, 0), { maxConcurrent: 8, btMaxPeers: 60 });
  for (let n = 1; n <= 6; n++) {
    const p = slots.enginePlan(n, 1);
    assert.ok(p.maxConcurrent > n + 1, "the setting and a challenger always fit");
    assert.ok(p.btMaxPeers * n <= 360, `total connections stay sane at ${n}`);
  }
});

// ---------- the config object ----------

test('config: unset is on with defaults, false is off, an object overrides single thresholds', () => {
  assert.equal(cfg.enabled, true);
  assert.equal(race.resolveConfig(true).enabled, true);
  assert.equal(race.resolveConfig(false).enabled, false);
  assert.equal(race.resolveConfig({ enabled: false }).enabled, false);
  const c = race.resolveConfig({ episodeBudgetMin: 1, maxRaces: 2, probeSec: "soon", knockoutRatio: -1, nonsense: 5 });
  assert.equal(c.episodeBudgetMin, 1);
  assert.equal(c.maxRaces, 2);
  assert.equal(c.probeSec, race.DEFAULTS.probeSec, "a value that is not a number is ignored");
  assert.equal(c.knockoutRatio, race.DEFAULTS.knockoutRatio, "…and so is a negative one");
  assert.equal(c.nonsense, undefined);
  assert.equal(c.filmBudgetMin, race.DEFAULTS.filmBudgetMin);
  assert.equal(race.resolveConfig({ maxRaces: 0 }).enabled, false, "no races allowed = off");
});

// ---------- speed and time ----------

test("the smoothed speed follows a change over about a minute, whatever the sampling beat", () => {
  assert.equal(race.ewma(0, 500, 0, 60000), 500, "the first sample is taken as it is");
  let v = 1000;
  for (let i = 0; i < 60; i++) v = race.ewma(v, 0, 1000, 60000);
  assert.ok(v > 330 && v < 400, `after one time constant ≈ 37% is left (${v})`);
  let w = 1000;
  for (let i = 0; i < 6; i++) w = race.ewma(w, 0, 10000, 60000);
  assert.ok(Math.abs(v - w) < 1, "ten-second samples land in the same place");
  assert.equal(race.etaSec(1000, 10), 100);
  assert.equal(race.etaSec(1000, 0), Infinity);
  assert.equal(race.etaSec(0, 0), 0);
  assert.equal(race.parseRate("5M"), 5 * MIB);
  assert.equal(race.parseRate("500k"), 512000);
  assert.equal(race.parseRate("0"), 0);
  assert.equal(race.parseRate("junk"), 0);
});

test("the budget: 45 minutes for an episode, two hours for a film, longer for very large files", () => {
  assert.equal(race.budgetSec("show", 1 * GB, cfg), 45 * 60);
  assert.equal(race.budgetSec("movie", 4 * GB, cfg), 120 * 60);
  const remux = race.budgetSec("movie", 60 * GB, cfg);
  assert.ok(remux > 10 * 3600 && remux < 11 * 3600, "a 60 GB remux is given ~10.6 h");
  assert.ok(race.budgetSec("show", 8 * GB, cfg) > 45 * 60, "a 4K episode gets more than the flat 45 min");
});

// ---------- 1. slow detection, with grace ----------

const attempt = (over = {}) => ({
  type: "show", sizeBytes: 1 * GB, startedAt: T0, metaAt: T0 + 5000, connectedAt: T0 + 8000,
  speed: 100 * 1024, fraction: 0.05, remainingBytes: 0.95 * GB, ...over,
});

test("slow: no torrent details after two minutes — not before", () => {
  const a = attempt({ metaAt: 0, connectedAt: 0, speed: 0, fraction: 0, remainingBytes: GB });
  assert.equal(race.slowReason(a, T0 + 119e3, cfg), null);
  assert.match(race.slowReason(a, T0 + 121e3, cfg), /no torrent details/);
});

test("slow: details but no seeder or peer after three minutes — not before", () => {
  const a = attempt({ connectedAt: 0, speed: 0, fraction: 0, remainingBytes: GB });
  assert.equal(race.slowReason(a, T0 + 170e3, cfg), null);
  assert.match(race.slowReason(a, T0 + 181e3, cfg), /no seeders or peers/);
});

test("slow: by time remaining, only after the grace, and only once the speed has settled", () => {
  // 0.95 GB at 100 KiB/s ≈ 2.6 h — far beyond an episode's 45 minutes
  const a = attempt();
  assert.equal(race.slowReason(a, T0 + 4 * MIN, cfg), null, "inside the five-minute grace");
  assert.match(race.slowReason(a, T0 + 6 * MIN, cfg), /projected to take 2\.\d h more .* under 45 min/);
  const lateStart = attempt({ connectedAt: T0 + 5.5 * MIN });
  assert.equal(race.slowReason(lateStart, T0 + 6 * MIN, cfg), null, "the first peer was 30 s ago: the average is not settled");
  // the same speed is FINE for a small file: it is time remaining, not raw speed
  assert.equal(race.slowReason(attempt({ sizeBytes: 150e6, remainingBytes: 140e6 }), T0 + 6 * MIN, cfg), null);
  // and a healthy download is never slow
  assert.equal(race.slowReason(attempt({ speed: 3 * MIB }), T0 + 30 * MIN, cfg), null);
  // connected but nothing arriving
  assert.match(race.slowReason(attempt({ speed: 0 }), T0 + 10 * MIN, cfg), /no bytes are arriving/);
  // a film gets two hours: 3.8 GB at 600 KiB/s ≈ 1.8 h is not slow, at 300 KiB/s it is
  const film = attempt({ type: "movie", sizeBytes: 4 * GB, remainingBytes: 3.8 * GB, speed: 600 * 1024 });
  assert.equal(race.slowReason(film, T0 + 10 * MIN, cfg), null);
  assert.ok(race.slowReason({ ...film, speed: 300 * 1024 }, T0 + 10 * MIN, cfg));
});

// ---------- 2. whose fault ----------

test("the line is the bottleneck only when everything together is near the recent best AND others are using it", () => {
  const peak = 10 * MIB;
  assert.equal(race.lineBound({ ownBps: 0.2 * MIB, totalBps: 9 * MIB, peakBps: peak }, cfg), true, "another download fills the line");
  assert.equal(race.lineBound({ ownBps: 0.2 * MIB, totalBps: 3 * MIB, peakBps: peak }, cfg), false, "the line has room: it is the source");
  assert.equal(race.lineBound({ ownBps: 9 * MIB, totalBps: 9 * MIB, peakBps: 9 * MIB }, cfg), false, "alone, its own speed says nothing about the line");
  assert.equal(race.lineBound({ ownBps: 40e3, totalBps: 80e3, peakBps: 80e3 }, cfg), false, "two dying downloads do not make a line");
  assert.equal(race.lineBound({ ownBps: 0, totalBps: 0, peakBps: peak }, cfg), false);
});

test("the high-water mark rises at once and fades by half every fifteen minutes", () => {
  let p = race.updatePeak(null, 8 * MIB, T0, cfg);
  assert.equal(p.bps, 8 * MIB);
  p = race.updatePeak(p, 2 * MIB, T0 + 15 * MIN, cfg);
  assert.ok(Math.abs(p.bps - 4 * MIB) < 1000, "halved, still above the current total");
  p = race.updatePeak(p, 6 * MIB, T0 + 16 * MIN, cfg);
  assert.equal(p.bps, 6 * MIB, "a new best replaces it");
  p = race.updatePeak(p, 0, T0 + 5 * 60 * MIN, cfg);
  assert.ok(p.bps < 1000, "hours later it is gone");
});

test("the speed cap: running near it means the cap sets the pace, not the source", () => {
  assert.equal(race.capBound({ capBps: 1 * MIB, totalBps: 0.9 * MIB }, cfg), true);
  assert.equal(race.capBound({ capBps: 1 * MIB, totalBps: 0.3 * MIB }, cfg), false);
  assert.equal(race.capBound({ capBps: 0, totalBps: 50 * MIB }, cfg), false, "0 = no cap");
});

// ---------- 3. nearly done ----------

test("nearly done: past 70 %, or under ten minutes to go", () => {
  assert.equal(race.nearlyDone(attempt({ fraction: 0.71 }), cfg), true);
  assert.equal(race.nearlyDone(attempt({ fraction: 0.5, remainingBytes: 50 * MIB, speed: 100 * 1024 }), cfg), true, "≈ 8.5 min left");
  assert.equal(race.nearlyDone(attempt(), cfg), false);
});

// ---------- the verdict, and the limits ----------

const env = (over = {}) => ({
  torrentsOn: true, engineHealthy: true, watching: 0, streamActive: false,
  capBps: 0, totalBps: 100 * 1024, peakBps: 100 * 1024, racesRunning: 0, ...over,
});
const cand = (over = {}) => ({ ...attempt(), searchable: true, challengersStarted: 0, retryAt: 0, racing: false, ...over });
const NOW = T0 + 10 * MIN;
const verdict = (a = {}, e = {}, c = cfg) => race.shouldRace(cand(a), env(e), c, NOW);

test("shouldRace: a slow, searchable job on a quiet server races", () => {
  const v = verdict();
  assert.equal(v.race, true);
  assert.match(v.slow, /projected/);
  assert.equal(v.blocked, null);
});

test("shouldRace: every safeguard says no, each with its own reason", () => {
  const no = (a, e, code, c) => {
    const v = verdict(a, e, c);
    assert.equal(v.race, false, code);
    assert.equal(v.blocked && v.blocked.code, code);
    assert.ok(v.blocked.text);
  };
  no({}, {}, "off", race.resolveConfig(false));
  no({}, { torrentsOn: false }, "torrents-off");
  no({}, { engineHealthy: false }, "engine");
  no({ searchable: false }, {}, "unsearchable");
  no({ challengersStarted: 2 }, {}, "limit");
  no({ fraction: 0.8, remainingBytes: 0.2 * GB, speed: 50 * 1024 }, { totalBps: 50 * 1024 }, "nearly-done");
  no({ retryAt: NOW + 1000 }, {}, "cooldown");
  no({}, { watching: 1 }, "watching");
  no({}, { streamActive: true }, "stream");
  no({}, { capBps: 110 * 1024 }, "cap");
  no({}, { totalBps: 5 * MIB, peakBps: 5.5 * MIB }, "line");
  no({}, { racesRunning: 1 }, "busy");
  assert.equal(verdict({}, { racesRunning: 1 }, race.resolveConfig({ maxRaces: 2 })).race, true, "the server-wide cap is the config's");
  assert.equal(verdict({ challengersStarted: 1 }).race, true, "a second challenger is allowed, a third is not");
});

test("shouldRace: a job that is not slow, or already racing, is not a candidate at all", () => {
  const fine = verdict({ speed: 5 * MIB });
  assert.deepEqual([fine.race, fine.slow, fine.blocked], [false, null, null]);
  const racing = verdict({ racing: true });
  assert.deepEqual([racing.race, racing.slow], [false, null]);
});

test("a manual request's race comes before an automatic download's", () => {
  const picked = race.pickJobToRace([
    { id: "smart-old", smart: true, startedAt: 1 },
    { id: "manual-new", smart: false, startedAt: 9 },
    { id: "manual-old", smart: false, startedAt: 5 },
  ]);
  assert.equal(picked.id, "manual-old");
  assert.equal(race.pickJobToRace([]), null);
});

test("only a job that says how it was found can be raced", () => {
  assert.equal(race.searchable({ type: "movie", imdbId: "tt0111161" }), true);
  assert.equal(race.searchable({ type: "show", imdbId: "tt0903747", season: 2, episode: 5 }), true);
  assert.equal(race.searchable({ type: "show", imdbId: "tt0903747" }), false, "an episode without its numbers");
  assert.equal(race.searchable({ type: "movie", imdbId: null }), false, "an old job without an id is never raced");
  assert.equal(race.titleKey({ type: "show", imdbId: "TT0903747", season: 2, episode: 5 }), "tt0903747:2:5");
  assert.equal(race.titleKey({ type: "movie", imdbId: "tt0111161" }), "tt0111161");
  assert.equal(race.titleKey({ type: "movie" }), null);
});

// ---------- 4. the challenger ----------

const src = (c, over = {}) => ({
  infoHash: H(c), fileIdx: 0, quality: "1080p", sizeBytes: 1 * GB, seeders: 100,
  cam: false, dubbed: false, pack: false, ...over,
});
const job = (over = {}) => ({ type: "show", imdbId: "tt1", season: 1, episode: 3, infoHash: H("a"), fileIdx: 0, quality: "1080p", sizeBytes: 1 * GB, ...over });
const choose = (streams, over = {}) => race.chooseChallenger({ job: job(over.job), streams, history: over.history, live: over.live, cfg, now: NOW });

test("challenger: the next best of the same resolution, a different torrent", () => {
  const r = choose([src("a"), src("b", { quality: "2160p" }), src("c", { quality: "720p" }), src("d"), src("e")]);
  assert.equal(r.source.infoHash, H("d"), "not the original, not 4K, not 720p — the first 1080p in ranking order");
  assert.equal(r.resolution, "1080p");
  assert.equal(choose([src("a"), src("A".repeat(1) + "a".repeat(39))]).source, null, "the same torrent in another letter case is not a second source");
});

test("challenger: size within 0.4×–2.5× of the original; an unknown size is never picked", () => {
  const list = [src("a"), src("b", { sizeBytes: 0.39 * GB }), src("c", { sizeBytes: 2.6 * GB }), src("d", { sizeBytes: 0 }), src("e", { sizeBytes: 2.4 * GB })];
  assert.equal(choose(list).source.infoHash, H("e"));
  assert.equal(choose(list.slice(0, 4)).source, null);
  assert.equal(choose([src("a"), src("b", { sizeBytes: 9 * GB })], { job: { sizeBytes: 0 } }).source, null, "the original's size comes from the list when the job has none");
});

test("challenger: never a source this title already failed, stalled or lost on — until that memory expires", () => {
  const list = [src("a"), src("b"), src("c"), src("d"), src("e"), src("f")];
  const at = NOW - 86400e3;
  const history = { [H("b")]: { o: "stalled", at }, [H("c")]: { o: "probe", at }, [H("d")]: { o: "lost", at }, [H("e")]: { o: "failed", at } };
  assert.equal(choose(list, { history }).source.infoHash, H("f"));
  assert.equal(choose(list, { history: { ...history, [H("f")]: { o: "won", at } } }).source.infoHash, H("f"), "a source that WON here is welcome");
  const old = Object.fromEntries(Object.entries(history).map(([k, v]) => [k, { ...v, at: NOW - 50 * 86400e3 }]));
  assert.equal(choose(list, { history: old }).source.infoHash, H("b"), "after six weeks it gets another chance");
});

test("challenger: packs are allowed, and one already downloading for a sibling episode goes first", () => {
  const pack = src("p", { fileIdx: 4, pack: true });
  const list = [src("a"), src("b"), pack];
  assert.equal(choose(list).source.infoHash, H("b"), "by ranking when nothing is running");
  const warm = choose(list, { live: [{ infoHash: H("p"), fileIdx: 5, running: true }] });
  assert.equal(warm.source.infoHash, H("p"));
  assert.equal(warm.source.fileIdx, 4, "the wanted episode's file, not the sibling's");
  assert.equal(warm.warm, true);
  const queued = choose(list, { live: [{ infoHash: H("p"), fileIdx: 5, running: false }] });
  assert.equal(queued.source.infoHash, H("b"), "a pack that is only queued is not 'already downloading'");
  const same = choose([src("a"), pack], { live: [{ infoHash: H("p"), fileIdx: 4, running: true }] });
  assert.equal(same.source, null, "the very file another download is fetching is not a second source");
  assert.equal(choose([src("a"), src("b", { pack: true, fileIdx: 3 })], { job: { type: "movie", season: null, episode: null } }).source, null, "a film inside a collection is not used");
});

test("challenger: never a cinema recording, never a dub unless the original was one", () => {
  assert.equal(choose([src("a"), src("b", { cam: true }), src("c", { dubbed: true })]).source, null);
  assert.equal(choose([src("a", { dubbed: true }), src("c", { dubbed: true })]).source.infoHash, H("c"));
});

test("challenger: when nothing qualifies it says why, and whether the resolution is exhausted", () => {
  const none = choose([src("a"), src("b", { quality: "720p" })]);
  assert.equal(none.source, null);
  assert.equal(none.exhausted, true);
  assert.match(none.reason, /no other source at 1080p/);
  const bad = choose([src("a"), src("b"), src("c", { sizeBytes: 9 * GB })], { history: { [H("b")]: { o: "stalled", at: NOW } } });
  assert.equal(bad.exhausted, true);
  assert.match(bad.reason, /1 let this title down before, 1 the wrong size/);
  assert.equal(race.exhaustedNote(bad.resolution), "No healthy source was found at 1080p — still trying the original.");
  const unknown = choose([src("b")], { job: { quality: "WEB" } });
  assert.equal(unknown.source, null);
  assert.equal(unknown.exhausted, false);
  assert.equal(race.resolutionOf("4K HDR"), "2160p");
  assert.equal(race.resolutionOf("SD"), null);
});

// ---------- 5. the probe ----------

test("probe: passes on details + a real seeder, fails when the window closes without them", () => {
  const ch = { startedAt: T0, metaAt: 0, seededAt: 0 };
  assert.equal(race.probeVerdict(ch, T0 + 30e3, cfg), "wait");
  assert.equal(race.probeVerdict({ ...ch, metaAt: T0 + 10e3 }, T0 + 60e3, cfg), "wait", "details alone are not a connection");
  assert.equal(race.probeVerdict({ ...ch, metaAt: T0 + 10e3, seededAt: T0 + 20e3 }, T0 + 21e3, cfg), "pass");
  assert.equal(race.probeVerdict(ch, T0 + 76e3, cfg), "fail");
  assert.equal(race.probeVerdict({ ...ch, metaAt: T0 + 10e3 }, T0 + 76e3, cfg), "fail");
  assert.equal(race.probeVerdict({ ...ch, metaAt: T0 + 70e3, seededAt: T0 + 74e3 }, T0 + 200e3, cfg), "pass", "one that connected carries on");
});

// ---------- 8. knockout ----------

test("knockout: under a third of the other's time remaining, held for two minutes", () => {
  let k = race.knockout({ etaMain: 6000, etaCh: 1500, prev: null, now: T0 }, cfg);
  assert.deepEqual(k, { state: { lead: "ch", since: T0 }, drop: null });
  k = race.knockout({ etaMain: 6000, etaCh: 1500, prev: k.state, now: T0 + 119e3 }, cfg);
  assert.equal(k.drop, null);
  k = race.knockout({ etaMain: 6000, etaCh: 1500, prev: k.state, now: T0 + 121e3 }, cfg);
  assert.equal(k.drop, "main", "the original is cancelled early");
  // the lead must HOLD: a dip resets the clock
  let s = race.knockout({ etaMain: 6000, etaCh: 1500, prev: null, now: T0 }, cfg).state;
  s = race.knockout({ etaMain: 6000, etaCh: 2500, prev: s, now: T0 + 60e3 }, cfg).state;
  assert.equal(s, null);
  s = race.knockout({ etaMain: 6000, etaCh: 1500, prev: s, now: T0 + 90e3 }, cfg);
  assert.equal(s.drop, null);
  assert.equal(s.state.since, T0 + 90e3);
});

test("knockout: on time REMAINING — the original is credited for what it already has", () => {
  // the challenger is twice as fast, but the original is 90 % done
  const etaMain = race.etaSec(0.1 * GB, 1 * MIB);
  const etaCh = race.etaSec(1 * GB, 2 * MIB);
  const prev = { lead: "main", since: T0 - 10 * MIN };
  assert.equal(race.knockout({ etaMain, etaCh, prev, now: T0 }, cfg).drop, "ch", "the faster source loses: it has further to go");
  assert.deepEqual(race.knockout({ etaMain: Infinity, etaCh: Infinity, prev: null, now: T0 }, cfg), { state: null, drop: null });
  assert.equal(race.knockout({ etaMain: Infinity, etaCh: 900, prev: { lead: "ch", since: T0 - 3 * MIN }, now: T0 }, cfg).drop, "main", "a dead original loses to a moving challenger");
});

test("no gain: a race that adds nothing — and would not beat the original alone — is stopped", () => {
  const base = { preRaceBps: 1 * MIB, mainBps: 0.5 * MIB, chBps: 0.5 * MIB, racingMs: 4 * MIN, remainingMain: 2 * GB, etaCh: race.etaSec(4 * GB, 0.5 * MIB) };
  assert.equal(race.noGain(base, cfg), true, "the two share what one had: the line is the limit");
  assert.equal(race.noGain({ ...base, racingMs: 2 * MIN }, cfg), false, "not judged in the first three minutes");
  assert.equal(race.noGain({ ...base, chBps: 2 * MIB }, cfg), false, "together they are faster: the race is helping");
  assert.equal(race.noGain({ ...base, etaCh: 600 }, cfg), false, "the challenger will finish before the original could alone");
  assert.equal(race.noGain({ ...base, preRaceBps: 0 }, cfg), false, "a dead original is never 'the line'");
});

// ---------- 6. one card ----------

test("the card shows the leading attempt, and the lead does not flicker", () => {
  assert.equal(race.leader({ etaMain: 1000, etaCh: 900 }, "main"), "main", "a small difference changes nothing");
  assert.equal(race.leader({ etaMain: 1000, etaCh: 700 }, "main"), "ch");
  assert.equal(race.leader({ etaMain: 650, etaCh: 700 }, "ch"), "ch");
  assert.equal(race.leader({ etaMain: 500, etaCh: 700 }, "ch"), "main");
  assert.equal(race.leader({ etaMain: Infinity, etaCh: 5000 }, "main"), "ch");
  assert.equal(race.leader({ etaMain: Infinity, etaCh: Infinity, fracMain: 0.3, fracCh: 0.1 }, "main"), "main");
  assert.equal(race.leader({ etaMain: Infinity, etaCh: Infinity, fracMain: 0.1, fracCh: 0.3 }, undefined), "ch");
});

// ---------- restart ----------

test("restart mid-race: more bytes wins, a tie keeps the original", () => {
  assert.equal(race.settleOnRestart([{ bytes: 500 }, { bytes: 900 }]), 1);
  assert.equal(race.settleOnRestart([{ bytes: 900 }, { bytes: 500 }]), 0);
  assert.equal(race.settleOnRestart([{ bytes: 0 }, { bytes: 0 }]), 0);
  assert.equal(race.settleOnRestart([{ bytes: 5 }]), 0);
  assert.equal(race.settleOnRestart(undefined), 0);
});

// ---------- 9. memory ----------

test("memory: bad outcomes exclude, the ranking nudge is zero without history, entries expire", () => {
  const at = NOW - 86400e3;
  const hist = { [H("b")]: { o: "stalled", at }, [H("c")]: { o: "won", at }, [H("d")]: { o: "probe", at: NOW - 60 * 86400e3 } };
  assert.deepEqual([...race.badSources(hist, NOW, cfg)], [H("b")]);
  assert.equal(race.scoreAdjust(hist, H("zz"), NOW, cfg), 0, "no history: the score is untouched");
  assert.equal(race.scoreAdjust(null, H("b"), NOW, cfg), 0);
  assert.ok(race.scoreAdjust(hist, H("b"), NOW, cfg) < 0);
  assert.ok(race.scoreAdjust(hist, H("B"), NOW, cfg) < 0, "letter case does not matter");
  assert.ok(race.scoreAdjust(hist, H("c"), NOW, cfg) > 0);
  assert.equal(race.scoreAdjust(hist, H("d"), NOW, cfg), 0, "expired");
  assert.ok(Math.abs(race.scoreAdjust(hist, H("b"), NOW, cfg)) <= 20, "small beside the 30-point gap between resolutions");

  const pruned = race.pruneMemory({ tt1: hist, tt2: { [H("x")]: { o: "lost", at: NOW - 99 * 86400e3 } }, tt3: { [H("y")]: { o: "bogus", at } } }, NOW, cfg);
  assert.deepEqual(Object.keys(pruned), ["tt1"], "titles with nothing fresh are dropped");
  assert.deepEqual(Object.keys(pruned.tt1).sort(), [H("b"), H("c")].sort());
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`tt${i}`, { [H("a")]: { o: "won", at: NOW - i * 1000 } }]));
  assert.equal(Object.keys(race.pruneMemory(many, NOW, cfg, 10)).length, 10, "the store is capped, newest titles kept");
});

test("the note after the limit says another source was tried", () => {
  assert.match(race.limitNote(1, "1080p"), /^Another source was tried at 1080p/);
  assert.match(race.limitNote(2, "720p"), /^2 other sources were tried at 720p/);
});

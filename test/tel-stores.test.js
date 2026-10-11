// The three telemetry stores (src/lib/tel): the error book, the timing
// histograms and the control counts — what they keep, how they are bounded,
// what rotates out, and what the admin reads back. Synthetic data only;
// nothing here touches the disk except the two tests that say so (a temp dir).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tel = require("../src/lib/tel");
const { errors, timings, controls } = tel;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const env = (o = {}) => ({ app: "tv", v: "5.1.31", device: "tv", model: "Acme Box 2", os: "android 30", net: "ok", auth: "open", flags: [], ...o });
const img401 = (n = 1) => ({ k: "img", l: "error", m: "http://10.0.0.5:4000/img/3f9a2c1b7d4e?w=256", n, r: "tv:home", c: { status: 401 } });

// ------------------------------------------------------------ errors

test("errors: forty pictures refused on three boxes are ONE line that says so", () => {
  tel._reset();
  const now = Date.now();
  errors.record([img401(37)], env({ auth: "closed" }), "boxaaaaaaaaaaaa1", now);
  errors.record([img401(2)], env({ auth: "closed" }), "boxaaaaaaaaaaaa2", now);
  errors.record([{ ...img401(1), m: "http://other.host/img/aa11bb22cc33?w=256" }], env({ auth: "closed", model: "Other TV" }), "boxaaaaaaaaaaaa3", now);
  const s = errors.summary({}, now);
  assert.equal(s.total, 1);
  const r = s.top[0];
  assert.equal(r.message, "image /img/:id?w=256 → 401");
  assert.equal(r.n, 40);
  assert.equal(r.devices, 3);
  assert.deepEqual(r.auth, { closed: 40 }, "the sign-in mode the clients saw — this alone explains a wall of 401s");
  assert.deepEqual(r.ctx.status, { 401: 40 });
  assert.deepEqual(r.screens, { "tv:home": 40 });
  assert.equal(r.firstVersion, "5.1.31");
  assert.equal(r.models["Acme Box 2"], 39);
  assert.ok(r.isNew && r.state === "open");
  assert.match(errors.text(now), /ERROR tv img {2}40× on 3 devices · image \/img\/:id\?w=256 → 401/);
  assert.match(errors.text(now), /sign-in: closed 40 · status: 401 40/);
});

test("errors: a report is cleaned — unknown kinds drop, counts and times are capped, context is whitelisted", () => {
  tel._reset();
  const now = Date.now();
  assert.equal(errors.clean({ k: "nope", m: "x" }, env(), now), null);
  assert.equal(errors.clean({ k: "js", m: "" }, env(), now), null);
  assert.equal(errors.clean("garbage", env(), now), null);
  const r = errors.clean({ k: "js", l: "whatever", m: "boom at http://h/x?token=abc", s: "http://h/js/a.js?v=1:f:1:2", r: "/movie/tt0133093", n: 1e9, t0: 5, t1: now + 9 * DAY, c: { status: 500, secret: 1, code: "x", ms: 12.7 } }, env({ app: "web" }), now);
  assert.equal(r.level, "error");
  assert.equal(r.msg, "boom at <url>");
  assert.equal(r.loc, "a.js:f");
  assert.equal(r.screen, "", "a screen with an id in it is not a screen pattern");
  assert.equal(r.n, errors.LIMITS.MAX_COUNT_PER_REPORT);
  assert.equal(r.t0, now);
  assert.equal(r.t1, now);
  assert.deepEqual(r.ctx, { status: 500, ms: 13 });
  // an http report is rebuilt from its parts: the client's own wording is not kept
  const h = errors.clean({ k: "http", l: "warn", m: "POST /api/item/9af3c2d1e0b4?profile=anna&q=secret words", c: { status: 404 } }, env(), now);
  assert.equal(h.msg, "POST /api/item/:id?profile&q → 404");
  assert.equal(errors.clean({ k: "http", m: "GET /api/home", c: { status: 0 } }, env(), now).msg, "GET /api/home → no answer");
});

test("errors: versions, the first version, and \"new in the newest version\"", () => {
  tel._reset();
  const t0 = Date.now() - 10 * DAY;
  const old = { k: "js", m: "old fault" };
  errors.record([old], env({ v: "5.1.30" }), "boxaaaaaaaaaaaa1", t0);
  errors.record([old], env({ v: "5.1.31" }), "boxaaaaaaaaaaaa1", t0 + DAY);
  const now = t0 + 10 * DAY;
  errors.record([{ k: "js", m: "fresh fault" }], env({ v: "5.1.31" }), "boxaaaaaaaaaaaa2", now - 5 * DAY);
  errors.noteVersion("tv", "5.1.31");
  const s = errors.summary({}, now);
  const byMsg = Object.fromEntries([...s.top].map((r) => [r.message, r]));
  assert.equal(byMsg["old fault"].firstVersion, "5.1.30");
  assert.deepEqual(byMsg["old fault"].versions, { "5.1.30": 1, "5.1.31": 1 });
  assert.equal(byMsg["old fault"].isNew, false);
  assert.equal(byMsg["fresh fault"].newInLatest, true);
  assert.equal(byMsg["fresh fault"].isNew, true, "five days old, but only the newest version has ever had it");
  assert.deepEqual(s.fresh.map((r) => r.message), ["fresh fault"]);
  assert.deepEqual(s.latest, { tv: "5.1.31" });
  // filters
  assert.equal(errors.summary({ version: "5.1.30" }, now).top.length, 1);
  assert.equal(errors.summary({ app: "web" }, now).top.length, 0);
  assert.equal(errors.summary({ level: "warn" }, now).top.length, 0);
  assert.equal(errors.summary({ model: "Acme Box 2" }, now).top.length, 2);
});

test("errors: spiking is a kind against its own usual hour", () => {
  tel._reset();
  const now = Date.UTC(2026, 5, 15, 12, 30);
  const e = { k: "http", m: "GET /api/home", c: { status: 503 } };
  // a steady two an hour for three days…
  for (let h = 72; h >= 2; h--) errors.record([{ ...e, n: 2 }], env(), "boxaaaaaaaaaaaa1", now - h * HOUR);
  let f = errors.list()[0];
  let sp = errors.spikeOf(f, now);
  assert.ok(sp.base > 1.5 && sp.base < 2.5, `usual ≈ 2/h, got ${sp.base}`);
  assert.equal(errors.summary({}, now).spiking.length, 0);
  // …then sixty in this hour
  errors.record([{ ...e, n: 60 }], env(), "boxaaaaaaaaaaaa2", now);
  f = errors.list()[0];
  sp = errors.spikeOf(f, now);
  assert.ok(sp.cur >= 60 && sp.factor >= 20, JSON.stringify(sp));
  assert.equal(errors.summary({}, now, { spikeMin: 20, spikeFactor: 5 }).spiking.length, 1);
  // a kind under a day old has no "usual" yet
  tel._reset();
  errors.record([{ ...e, n: 500 }], env(), "boxaaaaaaaaaaaa1", now);
  assert.equal(errors.spikeOf(errors.list()[0], now).base, null);
});

test("errors: known and ignored are remembered; benign noise is born ignored", () => {
  tel._reset();
  const now = Date.now();
  errors.record([{ k: "js", m: "ResizeObserver loop completed with undelivered notifications." }, { k: "js", m: "Script error." }, { k: "promise", m: "AbortError: The user aborted a request." }, { k: "js", m: "real one" }], env({ app: "web" }), "tabaaaaaaaaaaaa1", now);
  const s = errors.summary({}, now);
  assert.deepEqual(s.top.map((r) => r.message), ["real one"]);
  assert.equal(s.ignored.length, 3);
  assert.match(s.ignored[0].note, /\w/);
  const fp = s.top[0].fp;
  assert.equal(errors.setState(fp, "known", "the Tuesday thing"), true);
  assert.equal(errors.summary({}, now).top[0].state, "known");
  assert.equal(errors.summary({}, now).fresh.length, 0, "a known kind is not listed as new");
  assert.equal(errors.setState(fp, "ignored"), true);
  assert.equal(errors.summary({}, now).top.length, 0);
  assert.equal(errors.setState(fp, "open"), true);
  assert.equal(errors.summary({}, now).top.length, 1);
  assert.equal(errors.setState("not-a-fingerprint", "ignored"), false);
  assert.equal(errors.setState(fp, "whatever"), false);
  // a seeded ignore can be undone, and stays undone when the report comes again
  const benign = s.ignored[0].fp;
  errors.setState(benign, "open");
  errors.record([{ k: "js", m: "ResizeObserver loop completed with undelivered notifications." }], env({ app: "web" }), "tabaaaaaaaaaaaa1", now);
  assert.ok(errors.summary({}, now).top.some((r) => r.fp === benign));
});

test("errors: bounded — fingerprints, device ids a day, facets, days and hours kept", () => {
  tel._reset();
  const L = errors.LIMITS;
  const t0 = Date.now() - 2 * DAY;
  for (let i = 0; i < L.MAX_FPS + 50; i++) errors.record([{ k: "js", m: `fault number ${"x".repeat(1 + (i % 7))} ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i / 26) | 0) % 26)}${String.fromCharCode(97 + ((i / 676) | 0) % 26)}` }], env(), "boxaaaaaaaaaaaa1", t0 + i * 1000);
  assert.equal(errors.list().length, L.MAX_FPS, "the stalest fingerprints made room");
  tel._reset();
  const now = Date.now();
  for (let i = 0; i < 100; i++) errors.record([{ k: "js", m: "same" }], env({ v: `1.0.${i}`, model: `Box ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i / 26) | 0))}` }), `box${String(i).padStart(13, "0")}`, now);
  const f = errors.list()[0];
  assert.equal(Object.values(f.days)[0].ids.length, L.MAX_IDS_PER_DAY);
  assert.ok(Object.keys(f.versions).length <= L.MAX_FACETS + 1 && f.versions.other > 0, "the 13th version onward is \"other\"");
  assert.ok(Object.keys(f.models).length <= L.MAX_FACETS + 1);
  // the stored id is not the one that was sent
  assert.ok(!JSON.stringify(f).includes("box0000000000001"));
  // old days and hours rotate out as new reports arrive
  tel._reset();
  const start = Date.now() - 45 * DAY;
  for (let d = 0; d <= 45; d++) errors.record([{ k: "js", m: "daily" }], env(), "boxaaaaaaaaaaaa1", start + d * DAY);
  const g = errors.list()[0];
  assert.ok(Object.keys(g.days).length <= L.KEEP_DAYS + 1, `${Object.keys(g.days).length} days kept`);
  assert.ok(Object.keys(g.hours).length <= 3);
  assert.equal(g.n, 46, "the total is not forgotten");
});

test("errors: the book survives a restart, and a fingerprint unseen for 30 days does not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-tel-"));
  try {
    const file = path.join(dir, "tel-errors.json");
    const now = Date.now();
    errors.boot(file, now);
    errors.record([{ k: "js", m: "kept" }], env(), "boxaaaaaaaaaaaa1", now);
    errors.record([{ k: "js", m: "stale" }], env(), "boxaaaaaaaaaaaa1", now - 40 * DAY);
    errors.setState(errors.list().find((f) => f.msg === "kept").fp, "known");
    errors.saveNow();
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes("boxaaaaaaaaaaaa1"), "the install id is hashed before it reaches the disk");
    errors.boot(file, now);
    assert.deepEqual(errors.list().map((f) => f.msg), ["kept"]);
    assert.equal(errors.stateOf(errors.list()[0].fp), "known");
    // a broken file is a fresh book, not a crash
    fs.writeFileSync(file, "{not json");
    errors.boot(file, now);
    assert.equal(errors.list().length, 0);
  } finally {
    tel._reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ timings

test("timings: a percentile read from the histogram is within 8% of the true one", () => {
  tel._reset();
  const who = { app: "web", v: "1.6.86", device: "phone", net: "ok" };
  const vals = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 5000; i++) { const v = Math.round(200 * Math.exp(rnd() * 3)); vals.push(v); timings.observe("play_first_frame", v, "direct", who); }
  vals.sort((a, b) => a - b);
  const row = timings.summary().rows[0];
  assert.equal(row.n, 5000);
  for (const [p, key] of [[50, "p50"], [90, "p90"], [99, "p99"]]) {
    const truth = vals[Math.floor((p / 100) * vals.length)];
    assert.ok(Math.abs(row[key] - truth) / truth < 0.08, `${key}: ${row[key]} vs ${truth}`);
  }
  // however many values, a histogram is at most BUCKETS numbers
  const h = Object.values(timings._internals.hists)[0];
  assert.ok(Object.keys(h.b).length <= timings.LIMITS.BUCKETS);
});

test("timings: only the vocabulary — unknown names, wild values, foreign dimensions and the server's own metrics are refused", () => {
  tel._reset();
  const who = { app: "tv", v: "5.1.31", device: "tv", net: "fast" };
  assert.equal(timings.record([
    ["play_first_frame", 1200, "direct"],
    ["play_first_frame", 900, "The Example Film"], // not a path: counted under "other"
    ["nav_paint", 300, "tv:home"],
    ["nav_paint", 300, "/movie/tt0133093"], // an id in a "screen": counted under "?"
    ["made_up_metric", 5],
    ["play_first_frame", -1, "direct"],
    ["play_first_frame", 1e12, "direct"],
    ["play_first_frame", "soon", "direct"],
    ["srv_home", 3], // the server's own: a client cannot write it
    "garbage",
  ], who), 4);
  const dims = timings.summary().rows.map((r) => `${r.metric}|${r.dim}`).sort();
  assert.deepEqual(dims, ["nav_paint|?", "nav_paint|tv:home", "play_first_frame|direct", "play_first_frame|other"]);
  assert.equal(timings.record(new Array(500).fill(["nav_paint", 10, "tv:home"]), who), timings.LIMITS.MAX_PER_BATCH);
});

test("timings: the change against the previous version, and the splits by device class and connection", () => {
  tel._reset();
  for (let i = 0; i < 40; i++) {
    timings.observe("app_start_home", 1000 + i, undefined, { app: "tv", v: "5.1.30", device: "tv", net: "ok" });
    timings.observe("app_start_home", 1500 + i, undefined, { app: "tv", v: "5.1.31", device: "tv", net: i % 2 ? "slow" : "fast" });
  }
  const row = timings.summary().rows[0];
  assert.equal(row.version, "5.1.31");
  assert.equal(row.prevVersion, "5.1.30");
  assert.ok(row.changeP50 >= 35 && row.changeP50 <= 65, `a release that made it ~50% slower shows as such: ${row.changeP50}%`);
  assert.equal(row.byNet.slow.n, 20);
  assert.equal(row.byDevice.tv.n, 40);
  assert.deepEqual(row.versions.map((v) => v.v), ["5.1.31", "5.1.30"]);
  assert.match(timings.text(), /app_start_home {2}tv {2}v5\.1\.31 {2}40 · .* · \+\d+% vs v5\.1\.30/);
  // too few on either side: no verdict
  tel._reset();
  timings.observe("app_start_home", 1000, undefined, { app: "tv", v: "5.1.30", device: "tv", net: "ok" });
  timings.observe("app_start_home", 9000, undefined, { app: "tv", v: "5.1.31", device: "tv", net: "ok" });
  assert.equal(timings.summary().rows[0].changeP50, null);
  // 10.0.0 is newer than 9.9.9 (compared as numbers, not text)
  tel._reset();
  timings.observe("app_start_home", 1, undefined, { app: "tv", v: "9.9.9", device: "tv", net: "ok" });
  timings.observe("app_start_home", 1, undefined, { app: "tv", v: "10.0.0", device: "tv", net: "ok" });
  assert.equal(timings.summary().rows[0].version, "10.0.0");
});

test("timings: bounded — four versions per app, untouched histograms age out", () => {
  tel._reset();
  const now = Date.now();
  for (let i = 1; i <= 7; i++) timings.observe("nav_paint", 100, "tv:home", { app: "tv", v: `5.1.${i}`, device: "tv", net: "ok" }, now);
  timings.prune(now);
  assert.deepEqual(timings.summary().rows[0].versions.map((v) => v.v), ["5.1.7", "5.1.6", "5.1.5", "5.1.4"]);
  timings.prune(now + timings.LIMITS.KEEP_MS + DAY);
  assert.equal(timings.summary().rows.length, 0);
});

test("timings: the server measures its own heavy endpoints, and nothing else", () => {
  tel._reset();
  const call = (p, status = 200, query = {}) => {
    const handlers = {};
    const res = { statusCode: status, once: (ev, fn) => { handlers[ev] = fn; } };
    let nexted = false;
    timings.middleware({ path: p, query }, res, () => { nexted = true; });
    assert.ok(nexted, "the request always goes on");
    if (handlers.finish) handlers.finish();
    return !!handlers.finish;
  };
  assert.equal(call("/api/home"), true);
  assert.equal(call("/api/item/abc"), true);
  assert.equal(call("/img/abc", 200, { w: "256" }), true);
  assert.equal(call("/img/abc"), true);
  assert.equal(call("/api/home", 401), true, "a refusal is watched but not counted");
  assert.equal(call("/api/profiles"), false);
  assert.equal(call("/stream/abc"), false);
  assert.equal(call("/"), false);
  const rows = timings.summary().rows.map((r) => `${r.metric}|${r.app}|${r.dim}|${r.n}`).sort();
  assert.deepEqual(rows, ["srv_home|server|-|1", "srv_img|server|original|1", "srv_img|server|variant|1", "srv_item|server|-|1"]);
});

test("timings: a download's wait and transfer come from the job's own timestamps", () => {
  tel._reset();
  const t = Date.UTC(2026, 5, 1, 10, 0, 0);
  const job = { id: "j1", at: new Date(t).toISOString(), approvedAt: new Date(t + 5 * MIN).toISOString(), autoApproved: false };
  timings.downloadStarted(job, t + 7 * MIN);
  timings.downloadDone(job, t + 37 * MIN);
  const by = Object.fromEntries(timings.summary().rows.map((r) => [r.metric, r]));
  const near = (v, want) => Math.abs(v - want) / want < 0.08;
  assert.ok(near(by.dl_wait_approval.p50, 5 * MIN) && by.dl_wait_approval.dim === "asked");
  assert.ok(near(by.dl_wait_slot.p50, 2 * MIN));
  assert.ok(near(by.dl_transfer.p50, 30 * MIN));
  assert.ok(near(by.dl_total.p50, 37 * MIN));
  // a job this process never saw start (a restart mid-download) gives no transfer time, and never throws
  timings.downloadDone({ id: "unknown" }, t);
  timings.downloadStarted(null);
  assert.equal(timings.summary().rows.find((r) => r.metric === "dl_transfer").n, 1);
});

// ------------------------------------------------------------ controls

test("controls: counts per control, share of sessions, where and how — and what nobody pressed", () => {
  tel._reset();
  const now = Date.now();
  // session one: its first batch, then a later one
  controls.record([["tv:home", "card.open", "remote", 3, 1], ["tv:detail", "detail.play", "remote", 1, 1]], "tv", true, now);
  controls.record([["tv:browse/movie", "card.open", "remote", 2]], "tv", false, now);
  // session two
  controls.record([["tv:home", "card.open", "remote", 1, 1]], "tv", true, now);
  // session three pressed nothing that is tagged
  controls.record([], "tv", true, now);
  const r = controls.rank("tv", 30, now);
  assert.equal(r.sessions, 3);
  assert.equal(r.presses, 7);
  assert.deepEqual(r.used.map((u) => [u.id, u.n, u.share]), [["card.open", 6, 67], ["detail.play", 1, 33]]);
  assert.deepEqual(r.used[0].by, { "tv:home": 4, "tv:browse/movie": 2 });
  assert.deepEqual(r.screens["tv:home"], [{ id: "card.open", n: 4 }]);
  assert.ok(r.never.includes("player.skipintro") && !r.never.includes("card.open"));
  assert.ok(!r.never.includes("search.clear"), "a control the TV does not have is not \"never used on the TV\"");
  assert.match(controls.text(now), /card\.open {2}6 · 67% of sessions · mostly on tv:home · remote 6/);
  assert.match(controls.text(now), /never used in 30 days \(\d+\): /);
});

test("controls: only ids on the list, only for an app that has them; screens with ids in them are not screens", () => {
  tel._reset();
  const now = Date.now();
  assert.equal(controls.record([
    ["/movie/:id", "detail.play", "mouse", 2, 1],
    ["/movie/tt0133093", "detail.play", "touch", 1],
    ["/", "Watch The Example Film", "mouse", 1],
    ["/", "search.clear", "mouse", 1],
    ["/", "detail.play", "telepathy", 1],
    ["/", "detail.play", "mouse", -4],
    ["/", "detail.play", "mouse", 1e9],
    "garbage",
  ], "web", true, now), 5);
  const r = controls.rank("web", 30, now);
  const play = r.used.find((u) => u.id === "detail.play");
  assert.deepEqual(play.by, { "/movie/:id": 2, "?": 1, "/": 1 + controls.LIMITS.MAX_PRESSES_PER_ENTRY });
  assert.equal(play.in.other, 1);
  assert.ok(!JSON.stringify(controls._internals.days).includes("Example"));
  // the TV has no search.clear: the same id from the TV is dropped
  assert.equal(controls.record([["tv:search", "search.clear", "remote", 1]], "tv", false, now), 0);
});

test("controls: web against TV, and days that rotate out", () => {
  tel._reset();
  const now = Date.now();
  controls.record([["/", "card.open", "touch", 5, 1]], "web", true, now);
  controls.record([["tv:home", "card.open", "remote", 9, 1]], "tv", true, now);
  controls.record([["tv:home", "card.open", "remote", 100, 1]], "tv", true, now - 40 * DAY);
  const s = controls.summary(now);
  assert.deepEqual(s.compare.find((c) => c.id === "card.open"), { id: "card.open", web: 5, webShare: 100, tv: 9, tvShare: 100 });
  controls.prune(now);
  assert.equal(Object.keys(controls._internals.days).length, 1, "the forty-day-old tally is gone");
});

test("the three stores write to the folder they are given, and nowhere when given none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-tel-"));
  try {
    tel.boot(dir);
    tel.record({ profile: "p1", sid: "abc", device: "tv", look: "tv", app: "tv", v: "5.1.31", iid: "boxaaaaaaaaaaaa1", tel: { s: 1, e: [{ k: "js", m: "x" }], t: [["nav_paint", 10, "tv:home"]], u: [["tv:home", "card.open", "remote", 1, 1]] } });
    tel.flush();
    assert.deepEqual(fs.readdirSync(dir).sort(), ["tel-controls.json", "tel-errors.json", "tel-timings.json"]);
    tel.boot(dir);
    assert.equal(errors.list().length, 1);
    assert.equal(timings.summary().rows.length, 1);
    assert.equal(controls.rank("tv").presses, 1);
  } finally {
    tel._reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

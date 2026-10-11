// The gate in front of the telemetry stores (src/lib/tel/index.js) and the
// alert on top of them (src/lib/healer-checks/clients.js): the profile's
// switch is enforced on the server, a device has a daily allowance, and a
// new or spiking error raises ONE alert — through the healer's own alert
// path, with `send` stubbed. Nothing here can reach a phone.
const test = require("node:test");
const assert = require("node:assert/strict");
const tel = require("../src/lib/tel");
const clients = require("../src/lib/healer-checks/clients");
const healer = require("../src/lib/healer");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const PROFILES = [
  { id: "p-in", name: "In", prefs: {} },
  { id: "p-out", name: "Out", prefs: { usageStats: false } },
  { id: "p-plain", name: "Plain" },
];
const batch = (o = {}) => ({
  profile: "p-in", sid: "abcd1234", device: "tv", look: "tv", iid: "boxaaaaaaaaaaaa1", app: "tv", v: "5.1.31", model: "Acme Box 2", os: "android 30", net: "ok", auth: "closed", flags: ["lite"],
  events: [], tel: { s: 1, e: [{ k: "http", l: "warn", m: "GET /img/abc123def456?w=256", n: 12, r: "tv:home", c: { status: 401 } }], t: [["nav_paint", 250, "tv:home"]], u: [["tv:home", "card.open", "remote", 2, 1]] },
  ...o,
});

// ------------------------------------------------------------ consent

test("the switch is the profile's own, read on the server", () => {
  assert.equal(tel.allowed("p-in", PROFILES), true);
  assert.equal(tel.allowed("p-plain", PROFILES), true, "no prefs at all: the default is on");
  assert.equal(tel.allowed("p-out", PROFILES), false);
  assert.equal(tel.allowed("nobody", PROFILES), false, "a profile the server does not know cannot have agreed");
  assert.equal(tel.allowed("", PROFILES), false);
  assert.equal(tel.allowed(undefined, PROFILES), false);
});

test("what the route does with a batch: all of it, its errors only, or nothing", () => {
  const v = (body, o = {}) => tel.verdict(body, { profiles: PROFILES, mode: "open", session: null, admin: false, ...o });
  assert.equal(v(batch()), "all");
  assert.equal(v(batch({ profile: "p-out" })), "drop", "an opted-out profile's batch is dropped whatever the client believed");
  assert.equal(v(batch({ profile: "nobody" })), "drop");
  assert.equal(v(null), "drop");
  assert.equal(v("x"), "drop");
  // sign-in required
  const session = (id) => ({ profile: PROFILES.find((p) => p.id === id) });
  assert.equal(v(batch(), { mode: "closed", session: session("p-in") }), "all");
  assert.equal(v(batch(), { mode: "closed", session: session("p-out") }), "drop", "the signed-in person said no, whatever profile id the batch names");
  assert.equal(v(batch({ profile: "p-out" }), { mode: "closed", session: session("p-in") }), "drop");
  assert.equal(v(batch(), { mode: "closed", session: null }), "errors", "no session behind the wall: only its error reports — the device the wall refuses is the one worth hearing from");
  assert.equal(v(batch({ profile: "p-out" }), { mode: "closed", session: null }), "drop");
  assert.equal(v(batch(), { mode: "transition", session: null }), "all");
});

test("a batch is counted into the three stores; \"errors only\" keeps the rest out", () => {
  tel._reset();
  assert.deepEqual(tel.record(batch()), { errors: 1, timings: 1, controls: 1 });
  let s = tel.summary();
  assert.equal(s.errors.top[0].message, "GET /img/:id?w=256 → 401");
  assert.deepEqual(s.errors.top[0].auth, { closed: 12 });
  assert.deepEqual(s.errors.top[0].flags, { lite: 12 });
  assert.equal(s.timings.rows[0].metric, "nav_paint");
  assert.equal(s.controls.tv.sessions, 1);
  tel._reset();
  assert.deepEqual(tel.record(batch(), { only: ["e"] }), { errors: 1, timings: 0, controls: 0 });
  s = tel.summary();
  assert.equal(s.timings.rows.length, 0);
  assert.equal(s.controls.tv.sessions, 0);
  // a batch with no telemetry in it is nothing
  assert.deepEqual(tel.record({ profile: "p-in", events: [] }), { errors: 0, timings: 0, controls: 0 });
  assert.deepEqual(tel.record(null), { errors: 0, timings: 0, controls: 0 });
  tel._reset();
});

test("the envelope is cleaned: labels only, known words only, an older build's defaults", () => {
  const e = tel.envelope({ app: "tv", v: "5.1.31", device: "tv", model: "Acme <b>Box</b> 2\n", os: "android 30", net: "warp", auth: "wide-open", flags: ["lite", "Has Space", "x".repeat(40), 7, "exp:rail2"] });
  assert.deepEqual(e, { app: "tv", v: "5.1.31", device: "tv", model: "Acme bBox/b 2", os: "android 30", net: "", auth: "", flags: ["lite", "exp:rail2"] });
  assert.equal(tel.envelope({ device: "tv", look: "tv" }).app, "tv", "the TV app before it said so");
  assert.equal(tel.envelope({ device: "phone", look: "glass" }).app, "web");
  assert.equal(tel.envelope({ v: "../../etc" }).v, "?");
  assert.equal(tel.envelope({ model: "anna@example.com" }).model, "", "a model that is somebody's address is no model");
  assert.equal(tel.installId({ iid: "boxaaaaaaaaaaaa1" }), "boxaaaaaaaaaaaa1");
  assert.equal(tel.installId({ iid: "../x", sid: "ab-12" }), "sidab12");
  assert.equal(tel.installId({}), "none");
});

test("a device has a daily allowance; past it, its batches are dropped", () => {
  tel._reset();
  const now = Date.UTC(2026, 5, 1, 12);
  const cap = tel.PER_DEVICE_DAY.errors;
  let kept = 0;
  for (let i = 0; i < cap + 50; i++) {
    kept += tel.record(batch({ tel: { e: [{ k: "js", m: `fault ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i / 26) | 0) % 26)}` }] } }), {}, now).errors;
  }
  assert.equal(kept, cap);
  // another device is not affected, and the allowance is new the next day
  assert.equal(tel.record(batch({ iid: "boxaaaaaaaaaaaa2", tel: { e: [{ k: "js", m: "other box" }] } }), {}, now).errors, 1);
  assert.equal(tel.record(batch({ tel: { e: [{ k: "js", m: "next day" }] } }), {}, now + DAY).errors, 1);
  tel._reset();
});

// ------------------------------------------------------------ alerts

const DEF = tel.ALERT_DEFAULTS;
const row = (o = {}) => ({ fp: "aaaaaaaaaa", app: "tv", kind: "http", level: "error", msg: "GET /img/:id?w=256 → 401", first: Date.now() - 10 * MIN, state: "open", alerted: {}, recent: { n: 1, devices: 1 }, spike: { cur: 0, base: null, factor: null }, versions: { "5.1.31": 1 }, models: {}, screens: {}, auth: {}, ctx: {}, ...o });

test("alert rule: a NEW kind on two devices, or twenty times, within the window", () => {
  const now = Date.now();
  const q = (r) => clients.qualifying([r], DEF, now).map((x) => x.why);
  assert.deepEqual(q(row()), [], "once, on one box: not yet");
  assert.deepEqual(q(row({ recent: { n: 2, devices: 2 } })), ["new"]);
  assert.deepEqual(q(row({ recent: { n: 20, devices: 1 } })), ["new"], "one box in a loop");
  assert.deepEqual(q(row({ recent: { n: 19, devices: 1 } })), []);
  assert.deepEqual(q(row({ recent: { n: 50, devices: 9 }, state: "ignored" })), []);
  assert.deepEqual(q(row({ recent: { n: 50, devices: 9 }, state: "known" })), [], "marked known: never announced as new");
  assert.deepEqual(q(row({ recent: { n: 50, devices: 9 }, alerted: { new: now - HOUR } })), [], "announced once");
  // older than a day: no longer "new", only a spike can raise it
  assert.deepEqual(q(row({ first: now - 2 * DAY, recent: { n: 50, devices: 9 } })), []);
});

test("alert rule: a known kind SPIKING at five times its usual hour and at least twenty", () => {
  const now = Date.now();
  const old = (o) => row({ first: now - 5 * DAY, ...o });
  const q = (r) => clients.qualifying([r], DEF, now).map((x) => x.why);
  assert.deepEqual(q(old({ spike: { cur: 60, base: 2, factor: 30 } })), ["spike"]);
  assert.deepEqual(q(old({ spike: { cur: 60, base: 20, factor: 3 } })), [], "three times usual is a busy evening");
  assert.deepEqual(q(old({ spike: { cur: 10, base: 0.5, factor: 20 } })), [], "ten in an hour is not worth a phone");
  assert.deepEqual(q(old({ spike: { cur: 25, base: 0, factor: Infinity } })), ["spike"], "quiet for a week, then twenty-five");
  assert.deepEqual(q(old({ spike: { cur: 60, base: 2, factor: 30 }, state: "known" })), ["spike"], "known kinds still spike");
  assert.deepEqual(q(old({ spike: { cur: 60, base: 2, factor: 30 }, state: "ignored" })), []);
  assert.deepEqual(q(old({ spike: { cur: 60, base: 2, factor: 30 }, alerted: { spike: now - HOUR } })), [], "at most every six hours per kind");
  assert.deepEqual(q(old({ spike: { cur: 60, base: 2, factor: 30 }, alerted: { spike: now - 7 * HOUR } })), ["spike"]);
});

test("alert rule: the cooldown, the daily limit and the off switch", () => {
  const now = Date.UTC(2026, 5, 1, 12);
  const day = "2026-06-01";
  assert.equal(clients.maySend({ lastAt: 0 }, DEF, now), null);
  assert.equal(clients.maySend({ lastAt: now - 10 * MIN }, DEF, now), "cooldown");
  assert.equal(clients.maySend({ lastAt: now - 31 * MIN }, DEF, now), null);
  assert.equal(clients.maySend({ lastAt: now - 2 * HOUR, day, sentToday: DEF.maxPerDay }, DEF, now), "daily-limit");
  assert.equal(clients.maySend({ lastAt: now - 2 * HOUR, day: "2026-05-31", sentToday: 99 }, DEF, now), null);
  assert.equal(clients.maySend({ lastAt: 0 }, { ...DEF, alert: false }, now), "off");
});

test("the 401 wall: three TVs, one evening — ONE alert, once", () => {
  tel._reset();
  const now = Date.now();
  for (const [i, box] of ["boxaaaaaaaaaaaa1", "boxaaaaaaaaaaaa2", "boxaaaaaaaaaaaa3"].entries()) tel.record(batch({ iid: box }), {}, now - (3 - i) * MIN);
  const r1 = clients.round(now);
  assert.equal(r1.hits.length, 1);
  assert.ok(r1.sent, "an alert is due");
  assert.match(r1.sent.title, /a new error on people's devices/);
  assert.match(r1.sent.body, /NEW on TV 5\.1\.31: GET \/img\/:id\?w=256 → 401/);
  assert.match(r1.sent.body, /36× on 3 devices in the last 30 min/);
  assert.match(r1.sent.body, /sign-in closed/);
  assert.match(r1.sent.body, /status 401/);
  // the next minute, and the next hour with more of the same: nothing more
  tel.record(batch({ iid: "boxaaaaaaaaaaaa4" }), {}, now + MIN);
  assert.equal(clients.round(now + 2 * MIN).sent, null);
  assert.equal(clients.round(now + HOUR).sent, null);
  tel._reset();
});

test("two problems inside the cooldown go out together, later — never two alerts", () => {
  tel._reset();
  const now = Date.now();
  const twoBoxes = (m, at) => { for (const box of ["boxaaaaaaaaaaaa1", "boxaaaaaaaaaaaa2"]) tel.record(batch({ iid: box, tel: { e: [{ k: "js", m }] } }), {}, at); };
  twoBoxes("first fault", now);
  assert.ok(clients.round(now).sent);
  twoBoxes("second fault", now + 5 * MIN);
  twoBoxes("third fault", now + 6 * MIN);
  const during = clients.round(now + 7 * MIN);
  assert.equal(during.hits.length, 2);
  assert.equal(during.sent, null, "inside the cooldown: held");
  const after = clients.round(now + 31 * MIN);
  assert.ok(after.sent, "what was owed goes out when the cooldown ends");
  assert.equal(after.sent.items, 2);
  assert.match(after.sent.title, /2 problems on people's devices/);
  assert.match(after.sent.body, /second fault[\s\S]*third fault|third fault[\s\S]*second fault/);
  assert.equal(clients.round(now + 62 * MIN).sent, null);
  tel._reset();
});

test("the healer sends the alert down its own path — and only when the check hands one over", async () => {
  tel._reset();
  const now = Date.now();
  for (const box of ["boxaaaaaaaaaaaa1", "boxaaaaaaaaaaaa2"]) tel.record(batch({ iid: box }), {}, now - MIN);
  const sent = [];
  const send = (title, body) => sent.push({ title, body });
  healer._internals.state.running = false;
  const report = await healer.run({ checks: [["clienterrors", "Errors on people's devices", "Logs", clients.checkClientErrors]], send });
  const check = report.checks[0];
  assert.equal(check.status, "warn", "never \"fail\": the healer's own check-failed alert must not double this one");
  assert.equal(check.quiet, true);
  assert.equal(check.alert, undefined, "the alert is not kept in the round's report");
  assert.match(check.summary, /1 kind of error from devices in the last day \(1 new\)/);
  assert.equal(check.findings.length, 1);
  assert.match(check.findings[0].text, /GET \/img\/:id\?w=256 → 401/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /^Aurora: a new error on people's devices$/);
  // the next round has nothing to add
  await healer.run({ checks: [["clienterrors", "Errors on people's devices", "Logs", clients.checkClientErrors]], send });
  assert.equal(sent.length, 1);
  tel._reset();
});

test("a quiet fleet is ok, and the check is on the healer's list", async () => {
  tel._reset();
  const r = await clients.checkClientErrors({});
  assert.deepEqual({ status: r.status, summary: r.summary, alert: r.alert }, { status: "ok", summary: "no errors reported by devices", alert: undefined });
  assert.ok(healer._internals.CHECKS.some((c) => c[0] === "clienterrors" && c[3] === clients.checkClientErrors));
  // and it never calls notify itself (the repo's rule: one alert path)
  const src = require("fs").readFileSync(require.resolve("../src/lib/healer-checks/clients"), "utf8");
  assert.doesNotMatch(src, /notify"\)\.send\(|notify\.send\(/);
});

test("the thresholds are settings, with defaults for a household", () => {
  assert.deepEqual(tel.ALERT_DEFAULTS, { alert: true, newDevices: 2, newCount: 20, windowMin: 30, spikeFactor: 5, spikeMin: 20, cooldownMin: 30, maxPerDay: 6 });
  const s = tel.alertSettings();
  for (const k of Object.keys(tel.ALERT_DEFAULTS)) assert.equal(typeof s[k], typeof tel.ALERT_DEFAULTS[k], k);
});

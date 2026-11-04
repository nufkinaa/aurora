// Real watch time (docs/watch-time.md, src/lib/watchtime.js, src/telemetry.js).
// Every test drives the server's clock by hand and feeds the reports a player
// sends ("activity" over the socket) into the real handler, the way a web tab,
// a TV or a phone would — new clients with `played`/`state`, old ones (TV
// 5.8.3, phone 1.0.3, a tab opened before the update) with only the position.
const test = require("node:test");
const assert = require("node:assert/strict");

const telemetry = require("../src/telemetry");
const realtime = require("../src/realtime");
const watchtime = require("../src/lib/watchtime");
const js = require("../src/lib/jsonstore");

const { clock } = telemetry._internals;
const realNow = clock.now;
const T0 = Date.parse("2026-11-01T18:00:00.000Z");
let t = T0;

const reset = () => {
  for (const id of [...telemetry._internals.liveByClient.keys()]) telemetry.closeSession(id);
  telemetry._internals.banks.clear();
  telemetry._internals.pausedOut.clear();
  telemetry.sessions.data.length = 0;
  t = T0;
  clock.now = () => t;
};
test.beforeEach(reset);
test.after(() => { clock.now = realNow; telemetry.sessions.data.length = 0; js.flushAll(); });

let n = 0;
const makeClient = (profile = "Ann", device = "TV", extra = {}) => {
  const ws = { authed: true, profileId: `pid-${profile}`, send() {}, readyState: 1, close() {}, terminate() {} };
  return { id: `wt-${++n}`, ip: "10.1.1.1", device: { device }, profile, profileId: `pid-${profile}`, activity: "Browsing", ws, ...extra };
};
const send = (c, msg) => realtime._internals.handleMessage(c, msg, c.ws);
// an OLD client's report: title, position, duration — nothing else
const oldReport = (c, title, position, duration) => send(c, { type: "activity", action: "Watching", details: title, position, duration });
// a NEW client's report: what it played since its last one, and its state
const newReport = (c, title, position, duration, played, state = "playing", extra = {}) =>
  send(c, { type: "activity", action: "Watching", details: title, position, duration, played, state, ...extra });
const step = (sec) => { t += sec * 1000; };
const sessionsOf = (title) => telemetry.sessions.data.filter((s) => s.content === title);
const totalOf = (title) => sessionsOf(title).reduce((a, s) => a + (s.watchedSec || 0), 0);

// How the accounting worked before 2026-11-04 (src/telemetry.js at 1.15.10):
// a session's watch time was the wall clock from its first report to its last.
const legacyWatchedSec = (s) => Math.round((Date.parse(s.updatedAt) - Date.parse(s.startedAt)) / 1000);

test("THE 71 HOURS: one 40-minute episode, played once, then left paused on the TV for three days", () => {
  const tv = makeClient("Dor-test", "TV");
  const EP = "Only Murders in the Building S2E10";
  const DUR = 2400;
  // an old TV build (5.8.3): it reports every 5 s, paused or not
  let pos = 0;
  oldReport(tv, EP, pos, DUR);
  for (let i = 0; i < DUR / 5; i++) { step(5); pos += 5; oldReport(tv, EP, pos, DUR); telemetry.sweep(t); }
  // …and then it stands paused, still saying "Watching", for 70 h 20 min
  const firstSession = sessionsOf(EP)[0];
  const pausedUntil = t + (70 * 3600 + 20 * 60) * 1000;
  while (t < pausedUntil) { step(5); oldReport(tv, EP, pos, DUR); if ((t / 1000) % 60 === 0) telemetry.sweep(t); }

  // the old rule: the whole time the screen said "Watching"
  const wall = Math.round((t - T0) / 1000);
  assert.equal(Math.round(wall / 3600), 71, "71 hours of reports");
  assert.equal(Math.round(legacyWatchedSec({ startedAt: firstSession.startedAt, updatedAt: new Date(t).toISOString() }) / 3600), 71,
    "the old accounting made this 71 hours");

  // the new one: what played
  const total = totalOf(EP);
  assert.ok(Math.abs(total - DUR) <= 10, `about 40 minutes, got ${total} s`);
  assert.equal(sessionsOf(EP).length, 1, "one viewing — standing paused did not start new ones");
  const s = sessionsOf(EP)[0];
  assert.equal(s.live, false, "closed once it had stood paused for 30 minutes");
  assert.equal(s.endReason, "paused");
  assert.equal(Date.parse(s.endedAt), T0 + DUR * 1000, "it ended when it last played");
  assert.equal(telemetry.todayWatchSec("Dor-test") <= DUR + 10, true);
});

test("pause: only the playing parts count (new and old clients alike)", () => {
  for (const kind of ["new", "old"]) {
    reset();
    const c = makeClient("Ann", "Desktop");
    const F = `A film (${kind})`;
    let pos = 100;
    const r = (played, state) => (kind === "new" ? newReport(c, F, pos, 7200, played, state) : oldReport(c, F, pos, 7200));
    r(0, "playing");
    for (let i = 0; i < 12; i++) { step(5); pos += 5; r(5, "playing"); } // 60 s playing
    for (let i = 0; i < 120; i++) { step(5); r(0, "paused"); } // 10 min paused
    for (let i = 0; i < 12; i++) { step(5); pos += 5; r(5, "playing"); } // 60 s more
    const total = totalOf(F);
    assert.ok(total >= 115 && total <= 121, `${kind}: 2 minutes, got ${total}`);
    const s = sessionsOf(F)[0];
    assert.equal(s.state, "playing");
    assert.equal(s.live, true);
  }
});

test("a laptop closed mid-film: the sleep never counts, the session closes at its last report", () => {
  const c = makeClient("Ann", "Desktop");
  const F = "Sleepy film";
  let pos = 0;
  newReport(c, F, pos, 7200, 0);
  for (let i = 0; i < 24; i++) { step(5); pos += 5; newReport(c, F, pos, 7200, 5); }
  const lastReport = t;
  // the lid closes: nothing arrives; the server's sweep notices
  step(46);
  telemetry.sweep(t);
  const s = sessionsOf(F)[0];
  assert.equal(s.live, false);
  assert.equal(s.endReason, "silent");
  assert.equal(s.watchedSec, 120);
  assert.equal(Date.parse(s.endedAt), lastReport, "ended at the last report, not when it was noticed");
  // hours later the lid opens and the same tab goes on (an old client whose socket survived):
  // the position moved 5 s in 8 hours of wall time
  step(8 * 3600);
  const old = makeClient("Ann", "Desktop");
  oldReport(old, F, pos, 7200);
  step(8 * 3600);
  oldReport(old, F, pos + 5, 7200);
  assert.ok(totalOf(F) <= 125 + 1, `the 8 hours did not count (${totalOf(F)})`);
});

test("old client, gap inside one session (no sweep ran): credits only what the position moved, at most the bank", () => {
  const st = { lastAt: T0, lastPos: 600, credited: 0 };
  const bank = watchtime.newBank(T0);
  const r = watchtime.credit(st, bank, { position: 605 }, T0 + 10 * 3600 * 1000);
  assert.equal(r.credit, 5);
  const r2 = watchtime.credit(st, bank, { position: 605 + 3000 }, T0 + 10 * 3600 * 1000 + 5000);
  assert.equal(r2.credit, 0, "a 50-minute jump in 5 s is a seek");
  assert.equal(r2.seek, true);
});

test("a background tab: hidden with the film paused counts nothing; hidden while still playing (sound) counts", () => {
  const c = makeClient("Ann", "Desktop");
  const F = "Background film";
  let pos = 0;
  newReport(c, F, pos, 7200, 0, "playing", { visible: true });
  for (let i = 0; i < 12; i++) { step(5); pos += 5; newReport(c, F, pos, 7200, 5, "playing", { visible: true }); }
  // hidden; Chrome throttles the tab — a report a minute — and the film is paused
  for (let i = 0; i < 30; i++) { step(60); newReport(c, F, pos, 7200, 0, "paused", { visible: false }); }
  assert.equal(totalOf(F), 60);
  assert.equal(c.visible, false);
  // the film plays on while hidden (someone listening, or Chrome holding the
  // tab to a timer a minute): counted, a minute per report
  for (let i = 0; i < 5; i++) { step(60); pos += 60; newReport(c, F, pos, 7200, 60, "playing", { visible: false }); }
  assert.equal(totalOf(F), 60 + 5 * 60);
  // a report two minutes late claiming two minutes: held to the bank
  step(120); pos += 120; newReport(c, F, pos, 7200, 120, "playing", { visible: false });
  assert.equal(totalOf(F), 60 + 5 * 60 + watchtime.BANK_MAX_SEC);
});

test("buffering and seeking count nothing", () => {
  const c = makeClient("Ann", "TV");
  const F = "Stalling film";
  let pos = 0;
  newReport(c, F, pos, 7200, 0);
  for (let i = 0; i < 6; i++) { step(5); pos += 5; newReport(c, F, pos, 7200, 5); }
  for (let i = 0; i < 12; i++) { step(5); newReport(c, F, pos, 7200, 0, "buffering"); }
  assert.equal(totalOf(F), 30);
  assert.equal(sessionsOf(F)[0].state, "buffering");
  // old clients: a seek forward of ten minutes, then back
  const o = makeClient("Bob", "TV");
  const G = "Seeking film";
  oldReport(o, G, 0, 7200);
  step(5); oldReport(o, G, 5, 7200);
  step(5); oldReport(o, G, 605, 7200);
  step(5); oldReport(o, G, 300, 7200);
  step(5); oldReport(o, G, 305, 7200);
  assert.equal(totalOf(G), 10, "the two 5-second plays only");
});

test("2x speed: someone's time, not the film's — 10 minutes at 2x is 10 minutes", () => {
  const c = makeClient("Ann", "Desktop");
  const F = "Fast film";
  let pos = 0;
  newReport(c, F, pos, 7200, 0, "playing", { rate: 2 });
  // the new client divides by the speed itself: 10 s of film in 5 s → played 5
  for (let i = 0; i < 120; i++) { step(5); pos += 10; newReport(c, F, pos, 7200, 5, "playing", { rate: 2 }); }
  assert.equal(totalOf(F), 600);
  assert.equal(sessionsOf(F)[0].rate, 2);
  // an old client at 2x: the position runs twice as fast; the wall clock holds it to real time
  const o = makeClient("Bob", "Desktop");
  const G = "Fast film, old tab";
  let p = 0;
  oldReport(o, G, p, 7200);
  for (let i = 0; i < 120; i++) { step(5); p += 10; oldReport(o, G, p, 7200); }
  assert.ok(Math.abs(totalOf(G) - 600) <= 30, `about 10 minutes (${totalOf(G)})`);
});

test("two screens of one person on the same episode count it once; two people count twice", () => {
  const tv = makeClient("Ann", "TV");
  const phone = makeClient("Ann", "Mobile");
  const kid = makeClient("Kim", "TV");
  const E = "Show S1E1";
  let pos = 0;
  for (const c of [tv, phone, kid]) newReport(c, E, pos, 2700, 0);
  for (let i = 0; i < 60; i++) {
    step(2.5); newReport(tv, E, pos + 2.5, 2700, 2.5);
    step(2.5); pos += 5; newReport(phone, E, pos, 2700, 5); newReport(kid, E, pos, 2700, 5);
  }
  const ann = sessionsOf(E).filter((s) => s.profile === "Ann").reduce((a, s) => a + s.watchedSec, 0);
  const kim = sessionsOf(E).filter((s) => s.profile === "Kim").reduce((a, s) => a + s.watchedSec, 0);
  assert.ok(ann >= 295 && ann <= 302, `Ann: 5 minutes once, not twice (got ${ann})`);
  assert.equal(kim, 300);
  // two tabs of one browser, same person, same film, old clients: also once
  reset();
  const a = makeClient("Ann", "Desktop");
  const b = makeClient("Ann", "Desktop");
  const F = "Two tabs";
  oldReport(a, F, 0, 7200); oldReport(b, F, 0, 7200);
  for (let i = 1; i <= 60; i++) { step(5); oldReport(a, F, i * 5, 7200); oldReport(b, F, i * 5, 7200); }
  assert.ok(totalOf(F) <= 302, `two tabs: once (${totalOf(F)})`);
});

test("reports that arrive bunched up (a frozen socket catching up) still credit what played, never more than the wall", () => {
  const c = makeClient("Ann", "Mobile");
  const F = "Bunched film";
  let pos = 0;
  newReport(c, F, pos, 7200, 0);
  step(5); pos += 5; newReport(c, F, pos, 7200, 5);
  step(20); // nothing arrives for 20 s, then four reports at once
  for (let i = 0; i < 4; i++) { pos += 5; newReport(c, F, pos, 7200, 5); }
  assert.equal(totalOf(F), 25);
  // a lying client: played 30 every report, 5 s apart → held to the wall clock
  for (let i = 0; i < 10; i++) { step(5); pos += 5; newReport(c, F, pos, 7200, 30); }
  assert.ok(totalOf(F) <= 25 + 50 + watchtime.BANK_MAX_SEC, `held to the wall (${totalOf(F)})`);
});

test("a session is clamped to the media's length (x2 + 5 min)", () => {
  const c = makeClient("Ann", "Desktop");
  const F = "Short clip";
  newReport(c, F, 0, 60, 0);
  let pos = 0;
  for (let i = 0; i < 200; i++) { step(5); pos = (pos + 5) % 60; newReport(c, F, pos, 60, 5); }
  assert.equal(totalOf(F), 60 * 2 + 300);
});

test("Browsing ends the viewing; the end screen of an old client counts nothing", () => {
  const c = makeClient("Ann", "Mobile");
  const E = "Show S1E2";
  oldReport(c, E, 2690, 2700);
  step(5); oldReport(c, E, 2695, 2700);
  step(5); oldReport(c, E, 2700, 2700);
  for (let i = 0; i < 100; i++) { step(5); oldReport(c, E, 2700, 2700); }
  const s = sessionsOf(E)[0];
  assert.equal(s.watchedSec, 10);
  assert.equal(s.state, "ended");
  send(c, { type: "activity", action: "Browsing" });
  assert.equal(s.live, false);
  assert.equal(Date.parse(s.endedAt), T0 + 10000, "ended at the last moment it played");
});

test("paused out, then played again: a new sitting starts; paused reports alone never open one", () => {
  const c = makeClient("Ann", "TV");
  const F = "Long pause film";
  let pos = 0;
  newReport(c, F, pos, 7200, 0);
  for (let i = 0; i < 12; i++) { step(5); pos += 5; newReport(c, F, pos, 7200, 5); }
  for (let i = 0; i < 400; i++) { step(5); newReport(c, F, pos, 7200, 0, "paused"); if (i % 3 === 0) telemetry.sweep(t); }
  assert.equal(sessionsOf(F).length, 1);
  assert.equal(sessionsOf(F)[0].live, false);
  assert.equal(c.playState, "paused", "the admin still sees a paused player");
  for (let i = 0; i < 12; i++) { step(5); pos += 5; newReport(c, F, pos, 7200, 5); }
  assert.equal(sessionsOf(F).length, 2, "playing again is a new sitting");
  assert.ok(Math.abs(totalOf(F) - 115) <= 5, `${totalOf(F)}`);
});

test("a switch of profile on the same screen ends the first person's viewing", () => {
  const c = makeClient("Ann", "TV");
  const F = "Shared film";
  newReport(c, F, 0, 7200, 0);
  for (let i = 1; i <= 6; i++) { step(5); newReport(c, F, i * 5, 7200, 5); }
  send(c, { type: "hello", profile: "Bob", profileId: "pid-Bob" });
  const s = sessionsOf(F)[0];
  assert.equal(s.live, false);
  assert.equal(s.profile, "Ann");
  assert.equal(s.watchedSec, 30);
  assert.equal(c.activity, "Browsing");
});

test("the server's clock, never the device's: a report's own times are not read", () => {
  const c = makeClient("Ann", "Mobile");
  const F = "Skewed film";
  newReport(c, F, 0, 7200, 0, "playing", { at: T0 + 86400000 * 3 });
  step(5);
  newReport(c, F, 5, 7200, 5, "playing", { at: T0 - 86400000 * 3 });
  const s = sessionsOf(F)[0];
  assert.equal(Date.parse(s.startedAt), T0);
  assert.equal(s.watchedSec, 5);
});

test("the phone's offline queue: real played time, bounded, dated by the phone but never in the future, counted once", () => {
  const ok = telemetry.addOfflinePlay({ reportId: "off-abc123", content: "Saved film", played: 1800, duration: 5400, position: 1900,
    firstAt: T0 - 3600 * 1000, lastAt: T0 - 1700 * 1000, profile: "Ann", profileId: "pid-Ann" });
  assert.equal(ok.ok, true);
  assert.equal(ok.session.watchedSec, 1800);
  assert.equal(ok.session.offline, true);
  assert.equal(ok.session.live, false);
  assert.deepEqual(telemetry.addOfflinePlay({ reportId: "off-abc123", content: "Saved film", played: 1800, firstAt: T0 - 3600 * 1000, lastAt: T0 }), { ok: true, duplicate: true });
  // more played than the phone's own clock let pass → the span (+ the bank)
  const lie = telemetry.addOfflinePlay({ reportId: "off-lie001", content: "Saved film 2", played: 9000, duration: 5400, firstAt: T0 - 600 * 1000, lastAt: T0 - 100 * 1000 });
  assert.equal(lie.session.watchedSec, 500 + watchtime.BANK_MAX_SEC);
  // a phone whose clock is a day ahead: dated now, not tomorrow
  const fut = telemetry.addOfflinePlay({ reportId: "off-fut001", content: "Saved film 3", played: 600, firstAt: T0 + 86400000, lastAt: T0 + 86400000 + 600000 });
  assert.equal(Date.parse(fut.session.startedAt), T0);
  assert.ok(fut.session.watchedSec <= watchtime.BANK_MAX_SEC, "no span measurable from a clock in the future");
  assert.equal(telemetry.addOfflinePlay({ reportId: "x", content: "Bad", played: 5 }).error, "bad report");
  assert.equal(telemetry.addOfflinePlay({ reportId: "off-neg001", content: "Bad", played: -5 }).error, "bad report");
  assert.equal(telemetry.sessions.data.filter((s) => s.offline).length, 3);
});

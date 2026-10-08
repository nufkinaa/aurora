// The healer reading the log (src/lib/healer-checks/logs.js): known problems
// by name, a never-seen error reported once, the file that keeps failing
// named, and "more errors than usual for this hour". Pure decisions, plus
// the checks run against a fake log buffer and a store that lives in memory —
// nothing here reads the real log or writes to the data folder.
const test = require("node:test");
const assert = require("node:assert");
const logs = require("../src/lib/healer-checks/logs");
const store = require("../src/lib/healer-checks/store");
const { normalizeMessage, hourKey } = require("../src/lib/healer-checks/util");
const L = logs._internals;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 8, 14, 30, 0).getTime(); // a Thursday afternoon, local time

// a fake lib/logbuffer.js
const bufferOf = (rows) => {
  const all = rows.map((r, i) => ({ id: i + 1, t: r.t, level: r.level || "error", msg: r.msg }));
  return { read: ({ sinceId = 0 } = {}) => all.filter((r) => r.id > sinceId && (r.level === "warn" || r.level === "error")).reverse(), push: (r) => all.push({ id: all.length + 1, level: "error", ...r }) };
};
const fresh = (rows) => {
  L._reset();
  const st = store.useMemory();
  const logbuffer = bufferOf(rows);
  return { st, logbuffer, ctx: (over = {}) => ({ now: NOW, store: st, logbuffer, force: true, byKey: () => new Map(), explain: async () => null, ...over }) };
};

test("fingerprints: paths, addresses, ids, numbers and names collapse; only the first line counts", () => {
  const a = normalizeMessage("[xray] could not read C:\\elia\\aurora\\data\\cache\\xray\\tt1234567.json from 192.168.1.20 after 3 tries\n    at foo (bar.js:1:2)");
  const b = normalizeMessage("[xray] could not read C:\\elia\\aurora\\data\\cache\\xray\\tt7654321.json from 10.0.0.9 after 12 tries");
  assert.equal(a, b);
  assert.doesNotMatch(a, /elia|192|bar\.js/);
  assert.equal(normalizeMessage("failed for /mnt/media/Movies/A Film (2020)/a.mkv: 5"), normalizeMessage("failed for /mnt/media/Shows/B/b.mkv: 71"));
  assert.notEqual(normalizeMessage("[xray] cast came back empty"), normalizeMessage("[xray] crew came back empty"));
});

test("known problems: a signature is a finding once it reaches its minimum, worst first, with the newest line as evidence", () => {
  const ev = [
    { t: NOW - 2 * MIN, level: "error", msg: "Remux failed for D:\\a.mkv: boom" },
    { t: NOW - 1 * MIN, level: "error", msg: "[jit] producer exited 1 (0a1b2c3d4e5f-1 @seg3): bad" },
    { t: NOW - 3 * MIN, level: "error", msg: "Failed to save C:\\x\\profiles.json: EBUSY" },
    { t: NOW - 4 * MIN, level: "warn", msg: "[webrtc] 2 web peer(s) dropped mid-handshake (benign)" },
  ].map(L.digest);
  let k = L.knownFindings(ev, NOW);
  assert.deepEqual(k.map((x) => x.sig.id), ["store-save"], "two converter failures are below the line of three");
  ev.push(L.digest({ t: NOW - 30 * 1000, level: "error", msg: "[offline] failed 0a1b2c3d4e5f at 720: ffmpeg exited 1" }));
  k = L.knownFindings(ev, NOW);
  assert.deepEqual(k.map((x) => x.sig.id), ["store-save", "ffmpeg-failed"]);
  assert.equal(k[1].n, 3);
  assert.match(k[1].sample, /\[offline\] failed/, "the newest line is the sample");
  // outside the window it is history
  assert.deepEqual(L.knownFindings(ev, NOW + 20 * MIN), []);
});

test("a new error is reported ONCE, the first time it repeats three times; afterwards it is only counted", () => {
  const fps = {};
  const mk = (t, msg = "[xray] the cast list came back in an unexpected shape for tt1234567") => L.digest({ t, level: "error", msg });
  let events = [mk(NOW - 2 * MIN), mk(NOW - MIN)];
  assert.deepEqual(L.noteFingerprints(fps, events, events, NOW), [], "twice is not yet a pattern");
  const third = [mk(NOW)];
  events = events.concat(third);
  const news = L.noteFingerprints(fps, third, events, NOW);
  assert.equal(news.length, 1);
  assert.equal(news[0].n, 3);
  assert.match(news[0].sample, /cast list/);
  const fp = news[0].fp;
  assert.ok(fps[fp].reported);
  // more of the same, minutes later: counted, never reported again
  const more = [mk(NOW + MIN), mk(NOW + 2 * MIN), mk(NOW + 3 * MIN)];
  events = events.concat(more);
  assert.deepEqual(L.noteFingerprints(fps, more, events, NOW + 3 * MIN), []);
  assert.equal(fps[fp].n, 6);
  // a known signature never becomes a "new error"
  const known = [1, 2, 3].map((i) => L.digest({ t: NOW + i, level: "error", msg: "[aria2] daemon exited (code 1)" }));
  assert.deepEqual(L.noteFingerprints(fps, known, known, NOW + 5), []);
  assert.equal(Object.keys(fps).length, 1);
});

test("fingerprints expire after four weeks, and the table is capped", () => {
  const fps = { old: { first: NOW - 40 * DAY, last: NOW - 29 * DAY, n: 9, reported: NOW - 40 * DAY }, recent: { first: NOW - 40 * DAY, last: NOW - 2 * DAY, n: 3, reported: NOW - 40 * DAY } };
  assert.equal(L.expireFingerprints(fps, NOW), 1);
  assert.deepEqual(Object.keys(fps), ["recent"]);
  // …so the same error coming back after a long silence would be "new" again
  const big = {};
  for (let i = 0; i < L.FP_MAX + 30; i++) big[`fp${i}`] = { first: NOW, last: NOW - i * 1000, n: 1 };
  L.expireFingerprints(big, NOW);
  assert.equal(Object.keys(big).length, L.FP_MAX);
  assert.ok(big.fp0 && !big[`fp${L.FP_MAX + 29}`], "the least recently seen go first");
});

test("repeat offenders: the FILE is named, not the error repeated", () => {
  const ev = [
    "[jit] producer exited 1 (0a1b2c3d4e5f-1760000000000 @seg42): Invalid data",
    "[jit] producer exited 1 (0a1b2c3d4e5f-1760000000000-h264 @seg43): Invalid data",
    "[jit] 0a1b2c3d4e5f-1760000000000: keyframe is not where the index says — declining this file",
    "Remux failed for D:\\Movies\\Other (2019)\\Other.mkv: Conversion failed!",
    "ffmpeg failed extracting track 2 from D:\\Movies\\Other (2019)\\Other.mkv: (no stderr)",
    "[aria2] daemon exited (code 1)",
  ].map((msg, i) => L.digest({ t: NOW - i * MIN, level: "error", msg }));
  assert.deepEqual(L.subjectOf("Remux failed for D:\\Movies\\Other (2019)\\Other.mkv: Conversion failed!"), { kind: "path", value: "D:\\Movies\\Other (2019)\\Other.mkv", doing: "converting" });
  assert.equal(L.subjectOf("[aria2] daemon exited (code 1)"), null);
  const nameOf = (kind, v) => (kind === "id" && v === "0a1b2c3d4e5f" ? "Broken Film (2021).mkv" : null);
  const list = L.offenders(ev, { "0a1b2c3d4e5f": 2, ffffffffffff: 1 }, nameOf, NOW);
  assert.equal(list.length, 1, "Other.mkv failed twice — below the line; the unknown id once");
  assert.equal(list[0].name, "Broken Film (2021).mkv");
  assert.equal(list[0].n, 5);
  assert.match(list[0].doing, /converting ×3, playing ×2/);
  // a path's own file name is the fallback
  const two = L.offenders(ev.concat(L.digest({ t: NOW, level: "error", msg: "Remux failed for D:\\Movies\\Other (2019)\\Other.mkv: again" })), {}, () => null, NOW);
  assert.ok(two.some((o) => o.name === "Other.mkv" && o.n === 3));
});

test("trend: a spike is this hour against the SAME hour on earlier days; a steady background rate is not a finding", () => {
  const hours = {};
  for (let d = 1; d <= 6; d++) hours[hourKey(NOW - d * DAY)] = 8; // every day at this hour: 8
  for (let d = 1; d <= 6; d++) hours[hourKey(NOW - d * DAY - 5 * HOUR)] = 1;
  hours[hourKey(NOW)] = 9;
  let s = L.spike(hours, NOW);
  assert.equal(s.usual, 8);
  assert.equal(s.spike, false, "nine against a usual eight is the background");
  hours[hourKey(NOW)] = 40;
  s = L.spike(hours, NOW);
  assert.equal(s.spike, true);
  assert.match(s.basis, /this hour on earlier days/);
  // a quiet hour of the day has a baseline of zero: ten or more is a spike there, six is not
  const quiet = { [hourKey(NOW - 5 * DAY)]: 0, [hourKey(NOW - 4 * DAY - 3 * HOUR)]: 2 };
  quiet[hourKey(NOW)] = 6;
  assert.equal(L.spike(quiet, NOW).spike, false);
  quiet[hourKey(NOW)] = 12;
  assert.equal(L.spike(quiet, NOW).spike, true);
});

test("trend: with almost no history nothing is called a spike; with a day of it, an ordinary hour is the yardstick", () => {
  const young = { [hourKey(NOW - 2 * HOUR)]: 1, [hourKey(NOW)]: 60 };
  const a = L.spike(young, NOW);
  assert.equal(a.spike, false);
  assert.equal(a.usual, null);
  const day = {};
  for (let h = 1; h <= 20; h++) day[hourKey(NOW - h * HOUR)] = 2;
  day[hourKey(NOW)] = 30;
  const b = L.spike(day, NOW);
  assert.equal(b.usual, 2);
  assert.equal(b.spike, true);
  // old hours are dropped from the store
  const old = { [hourKey(NOW - 20 * DAY)]: 3, [hourKey(NOW - DAY)]: 3 };
  L.pruneHours(old, NOW);
  assert.deepEqual(Object.keys(old), [hourKey(NOW - DAY)]);
});

test("the errors check: names the known problem, says what to press, and tries the safe repair for a full disk", async () => {
  const f = fresh([
    { t: NOW - 3 * MIN, msg: "Failed to save C:\\elia\\aurora\\data\\profiles.json: ENOSPC: no space left on device, write" },
    { t: NOW - 2 * MIN, level: "warn", msg: "[notify] ntfy failed: fetch failed" },
    { t: NOW - 2 * MIN, level: "warn", msg: "[webrtc] 3 web peer(s) dropped mid-handshake (benign)" },
    { t: NOW - 1 * MIN, level: "info", msg: "[play] 0a1b2c3d4e5f +120ms mount" },
  ]);
  const asked = [];
  const r = await logs.checkErrors(f.ctx({ repair: (name, o) => { asked.push([name, o.subject]); return { ran: true, state: "ran", sentence: "ran “Tidy stream leftovers” (1 of 4 today)", press: { action: "sweep-streams", label: "Server → Actions → Tidy stream leftovers" } }; } }));
  assert.equal(r.status, "fail");
  assert.match(r.summary, /1 error, 1 warning in the last 15 min · 2 known problems/, "the routine line is not counted as a problem");
  const full = r.findings.find((x) => x.title === "A drive is full");
  assert.ok(full, "ENOSPC wins over the store-save wording: the cause, not the symptom");
  assert.match(full.text, /drive is full/);
  assert.match(full.evidence, /1 line in 15 min — last: Failed to save/);
  assert.equal(full.did, "ran “Tidy stream leftovers” (1 of 4 today)");
  assert.deepEqual(asked, [["sweep-streams", "disk-full"]]);
  const al = r.findings.find((x) => x.title === "Alerts are not being delivered");
  assert.equal(al.press.action, "notify-test", "a person is pointed at the test alert — it is never sent from here");
  assert.match(al.press.label, /^Server → Actions → Send a test alert$/);
});

test("the errors check: when the repair has hit its limit the finding says so and names the button", async () => {
  const f = fresh([{ t: NOW - MIN, msg: "[download] pump failed: ENOSPC: no space left on device" }]);
  const r = await logs.checkErrors(f.ctx({ repair: () => ({ ran: false, state: "limit", tried: 4, sentence: "tried 4 times today, needs you — Server → Actions → Tidy stream leftovers", press: { action: "sweep-streams", label: "Server → Actions → Tidy stream leftovers" } }) }));
  assert.match(r.findings[0].did, /tried 4 times today, needs you/);
  assert.equal(r.findings[0].press.action, "sweep-streams");
});

test("the errors check: counted problems (no log line) are findings too; a quiet log is ok and keeps its old one-liner", async () => {
  const f = fresh([{ t: NOW - MIN, level: "warn", msg: "[xray] odd thing one" }, { t: NOW - MIN, level: "warn", msg: "[xray] odd thing two" }]);
  const byKey = (kind) => (kind === "auth-fail" ? new Map([["203.0.113.9", 12]]) : new Map());
  const r = await logs.checkErrors(f.ctx({ byKey }));
  assert.equal(r.status, "warn");
  assert.match(r.findings[0].text, /203\.0\.113\.9 was refused 12 times/);
  assert.match(r.findings[0].setting, /Ban/);
  const g = fresh([{ t: NOW - MIN, level: "warn", msg: "[xray] odd thing one" }]);
  const quiet = await logs.checkErrors(g.ctx());
  assert.equal(quiet.status, "ok");
  assert.match(quiet.detail, /Most repeated: 1× \[xray\] odd thing one/);
  assert.deepEqual(quiet.findings, []);
});

test("the new-errors check: one note, one finding with message and count; the next round says nothing new; a day later it is off the card", async () => {
  const rows = [0, 1, 2, 3].map((i) => ({ t: NOW - i * MIN, msg: `[xray] the cast list came back in an unexpected shape for tt123456${i}` }));
  const f = fresh(rows);
  const notes = [];
  const explained = [];
  const ctx = (over) => f.ctx({ note: (k, d) => notes.push([k, d]), explain: async (fp) => { explained.push(fp); return null; }, ...over });
  const r1 = await logs.checkNewErrors(ctx());
  assert.equal(r1.status, "warn");
  assert.match(r1.summary, /1 new kind of error in the last day · 1 kind on record/);
  assert.equal(r1.findings.length, 1);
  assert.match(r1.findings[0].text, /cast list came back in an unexpected shape/);
  assert.match(r1.findings[0].evidence, /4 times in 15 min when first noticed, 4 in all/);
  assert.equal(notes.length, 1);
  assert.equal(notes[0][0], "new error");
  assert.equal(explained.length, 1, "the explanation is asked for once");
  assert.doesNotMatch(explained[0], /tt\d|\d{3}/, "what would be sent is the normalized message");
  // two more arrive: counted only — no second note, no second question
  f.logbuffer.push({ t: NOW + MIN, msg: "[xray] the cast list came back in an unexpected shape for tt9999999" });
  f.logbuffer.push({ t: NOW + MIN, msg: "[xray] the cast list came back in an unexpected shape for tt8888888" });
  const r2 = await logs.checkNewErrors(ctx({ now: NOW + 2 * MIN }));
  assert.equal(notes.length, 1);
  assert.equal(explained.length, 1);
  assert.match(r2.findings[0].evidence, /6 in all/);
  // after its first hour it no longer colours the check; after a day it leaves the card
  assert.equal((await logs.checkNewErrors(ctx({ now: NOW + 2 * HOUR }))).status, "ok");
  const later = await logs.checkNewErrors(ctx({ now: NOW + 25 * HOUR }));
  assert.equal(later.findings.length, 0);
  assert.match(later.summary, /no new kind of error · 1 kind seen before and only counted/);
});

test("the new-errors check shows a model's explanation beside the error, and its suggested action only as a button", async () => {
  const rows = [0, 1, 2].map((i) => ({ t: NOW - i * MIN, msg: "[xray] something entirely new went wrong" }));
  const f = fresh(rows);
  await logs.checkNewErrors(f.ctx({ explain: async () => ({ text: "The cast service answered in a shape Aurora did not expect. It usually clears by itself.", action: "clear-meta" }) }));
  await new Promise((r) => setImmediate(r));
  const r = await logs.checkNewErrors(f.ctx({ now: NOW + MIN }));
  assert.match(r.findings[0].ai, /usually clears by itself/);
  assert.equal(r.findings[0].press.action, "clear-meta");
});

test("the offenders and trend checks phrase what the pure parts found", async () => {
  const rows = [0, 1, 2].map((i) => ({ t: NOW - i * MIN, msg: `[jit] producer exited 1 (0a1b2c3d4e5f-1760000000000 @seg${i}): Invalid data` }));
  const f = fresh(rows);
  const pm = { list: () => [], summarize: () => ({ failuresByTitle: {} }) };
  const r = await logs.checkOffenders(f.ctx({ playmarks: pm, nameOf: () => "Broken Film (2021).mkv" }));
  assert.equal(r.status, "warn");
  assert.match(r.summary, /1 file keeps failing: “Broken Film \(2021\)\.mkv”/);
  assert.match(r.findings[0].text, /has failed 3 times/);
  assert.equal(r.findings[0].press.action, "jit-forget-changed");
  const none = fresh([]);
  assert.equal((await logs.checkOffenders(none.ctx({ playmarks: pm }))).summary, "no file or title keeps failing");
  // trend: hours on record in the store, a burst now
  const t = fresh([]);
  for (let d = 1; d <= 5; d++) t.st.data.errHours[hourKey(NOW - d * DAY)] = 2;
  t.st.data.errHours[hourKey(NOW)] = 50;
  const tr = await logs.checkErrorTrend(t.ctx());
  assert.equal(tr.status, "warn");
  assert.match(tr.summary, /50 problem lines this hour · usual: 2/);
  t.st.data.errHours[hourKey(NOW)] = 3;
  assert.equal((await logs.checkErrorTrend(t.ctx())).status, "ok");
});

test("the pass reads the log once per line, files problem lines under their hour, and leaves routine lines out", () => {
  const f = fresh([
    { t: NOW - 2 * HOUR, msg: "[aria2] daemon exited (code 1)" },
    { t: NOW - MIN, msg: "[aria2] daemon exited (code 1)" },
    { t: NOW - MIN, level: "warn", msg: "[webrtc] 1 web peer(s) dropped mid-handshake (benign)" },
  ]);
  const p = L.pass(f.ctx());
  assert.equal(p.events.length, 2, "the line from two hours ago is not kept in memory");
  assert.equal(f.st.data.errHours[hourKey(NOW - 2 * HOUR)], 1, "…but its hour was counted");
  assert.equal(f.st.data.errHours[hourKey(NOW - MIN)], 1, "the benign line is not a problem line");
  L.pass(f.ctx());
  assert.equal(f.st.data.errHours[hourKey(NOW - MIN)], 1, "a second pass does not count the same lines again");
});

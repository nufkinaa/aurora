// What the healer may do by itself, and the proof of what it may not.
//
//   • the allow-list in lib/adminactions.js (a `healer: true` flag, and a
//     never-list that beats the flag)
//   • the circuit breaker per (repair, subject), persisted
//   • a whole healer round with injected fakes: a flagged repair runs once,
//     is recorded as "by the healer", is not repeated inside the cooldown,
//     and a non-flagged action is refused
//   • alerts: one path, with a cooldown and a "recovered" — notify is a stub
//     here; nothing in this file can send a real notification
//
// Nothing real is repaired: the only real action started is
// "jit-forget-changed" for a key that does not exist, which reads a list and
// forgets nothing.
const test = require("node:test");
const assert = require("node:assert");
const actions = require("../src/lib/adminactions");
const repairs = require("../src/lib/healer-checks/repairs");
const store = require("../src/lib/healer-checks/store");
const healer = require("../src/lib/healer");
const { ACTIONS, NEVER_BY_HEALER, staleDeclined } = actions._internals;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const waitFor = async (id, ms = 20000) => {
  const until = Date.now() + ms;
  for (;;) {
    const r = actions.getRun(id);
    if (r && r.status !== "running") return r;
    if (Date.now() > until) throw new Error("the run did not finish");
    await new Promise((res) => setTimeout(res, 20));
  }
};

// A stand-in for lib/adminactions.js that records what it was asked.
const fakeActions = () => {
  const calls = [];
  return {
    calls,
    start: (id, opts = {}) => {
      // the real gate, so a fake can never be more permissive than the real thing
      if (opts.by === "healer" && !actions.mayHealerRun(id)) return { status: 403, error: "The healer is not allowed to run that." };
      const run = { id: `run-${calls.length + 1}`, action: id, title: (ACTIONS.find((a) => a.id === id) || {}).title || id, status: "running", by: opts.by, why: opts.why };
      calls.push({ id, by: opts.by, why: opts.why, subject: opts.subject, onDone: opts.onDone, run });
      return { run };
    },
  };
};
const wire = (over = {}) => {
  const st = store.useMemory();
  const fake = fakeActions();
  const clock = { now: over.now || 1e12 };
  const notes = [];
  repairs._setDeps({ actions: () => over.actions || fake, store: () => st, config: () => ({ HEALER: over.healer || {} }), now: () => clock.now, note: (k, d) => notes.push([k, d]) });
  return { st, fake, clock, notes };
};
const unwire = () => repairs._setDeps({ actions: () => require("../src/lib/adminactions"), store: () => require("../src/lib/healer-checks/store").get(), config: () => require("../src/config"), now: () => Date.now(), note: () => {} });

// ------------------------------------------------------------ the allow-list

test("exactly five actions are the healer's to run; the dangerous ones are never, whatever a flag says", () => {
  const may = ACTIONS.filter((a) => actions.mayHealerRun(a.id)).map((a) => a.id).sort();
  assert.deepEqual(may, ["backup-now", "jit-forget-changed", "patch-webtorrent", "rescan", "sweep-streams"]);
  for (const id of ["update-all", "git-pull", "npm-install", "restart", "self-test", "subs-backfill", "notify-test", "clear-images", "clear-meta"]) {
    assert.ok(NEVER_BY_HEALER.has(id), `${id} must be on the never-list`);
    assert.equal(actions.mayHealerRun(id), false, id);
    assert.notEqual(ACTIONS.find((a) => a.id === id).healer, true, `${id} must not carry the flag`);
  }
  assert.equal(actions.mayHealerRun("no-such-action"), false);
  // what the page is told agrees
  assert.deepEqual(actions.list().actions.filter((a) => a.healer).map((a) => a.id).sort(), may);
  // every repair the healer knows presses an action it is allowed to press
  for (const [name, spec] of Object.entries(repairs.REPAIRS)) assert.ok(actions.mayHealerRun(spec.action), `${name} → ${spec.action}`);
});

test("the healer CANNOT start an action that is not flagged: every one of them is refused, and nothing runs", () => {
  const before = actions.list().runs.length;
  const total = actions._internals.runs.length;
  for (const a of ACTIONS) {
    if (actions.mayHealerRun(a.id)) continue;
    const r = actions.start(a.id, { by: "healer", why: "a test trying its luck" });
    assert.equal(r.status, 403, `${a.id} must be refused`);
    assert.match(r.error, /The healer is not allowed to run/);
    assert.ok(!r.run, `${a.id} produced a run`);
  }
  assert.equal(actions._internals.runs.length, total, "no run was created");
  assert.equal(actions.list().runs.length, before);
});

test("the never-list beats the flag: a flag added by mistake still does not let the healer restart the server", () => {
  const restart = ACTIONS.find((a) => a.id === "restart");
  restart.healer = true; // somebody's mistake
  try {
    assert.equal(actions.mayHealerRun("restart"), false);
    const r = actions.start("restart", { by: "healer", why: "flagged by mistake" });
    assert.equal(r.status, 403);
    assert.ok(!r.run);
  } finally {
    delete restart.healer;
  }
});

test("the route hands start() the id alone, so a browser cannot claim to be the healer", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "routes", "admin.js"), "utf8");
  assert.match(src, /require\("\.\.\/lib\/adminactions"\)\.start\(req\.params\.id\);/);
  assert.doesNotMatch(src, /by:\s*"healer"/);
});

test("a run the healer starts is recorded as the healer's, with the reason — and an admin's run is not", async () => {
  const key = "000000000000-1"; // no such declined entry: the action reads the list and forgets nothing
  let finished = null;
  const r = actions.start("jit-forget-changed", { by: "healer", why: "“Some Film.mkv” changed on disk since it was declined", subject: key, onDone: (run) => { finished = run; } });
  assert.ok(r.run, JSON.stringify(r));
  assert.equal(r.run.by, "healer");
  const done = await waitFor(r.run.id);
  assert.equal(done.status, "ok");
  assert.equal(done.by, "healer");
  assert.equal(done.why, "“Some Film.mkv” changed on disk since it was declined");
  assert.match(done.output, /^\(started by the healer — “Some Film\.mkv” changed on disk/);
  assert.match(done.output, /nothing was forgotten/);
  assert.equal(finished && finished.id, r.run.id, "onDone was called with the finished run");
  const listed = actions.list().runs.find((x) => x.id === r.run.id);
  assert.deepEqual([listed.by, listed.why], ["healer", done.why]);
  // an admin's press of the same button: no "by", and a `by` smuggled in as anything else is ignored
  const mine = actions.start("jit-forget-changed", { by: "someone", why: "ignored" });
  const mineDone = await waitFor(mine.run.id);
  assert.deepEqual([mineDone.by, mineDone.why], ["admin", null]);
});

test("declined files: only an entry whose file CHANGED is stale — a file that cannot be seen is not", () => {
  const list = [
    { key: "0a1b2c3d4e5f-1000", why: "bad index", at: 1 },
    { key: "0a1b2c3d4e5f-1000|enc", why: "encoder failed", at: 2 },
    { key: "111111111111-2000", why: "bad index", at: 3 },
    { key: "222222222222-3000", why: "bad index", at: 4 },
    { key: "a-torrent-key-of-another-shape", why: "x", at: 5 },
  ];
  const mtimeOf = (id) => ({ "0a1b2c3d4e5f": 1500, "111111111111": 2000 })[id] ?? null; // the third file's drive is unplugged
  assert.deepEqual(staleDeclined(list, mtimeOf).map((s) => s.key), ["0a1b2c3d4e5f-1000", "0a1b2c3d4e5f-1000|enc"]);
  assert.deepEqual(staleDeclined([], mtimeOf), []);
});

// ------------------------------------------------------------ the circuit breaker

test("breaker: never twice inside the cooldown, at most N a day, and yesterday's runs do not count", () => {
  const spec = { perDay: 3, cooldownMs: 30 * MIN };
  const now = 1e12;
  assert.deepEqual(repairs.breaker([], now, spec), { allow: true, tried: 0, lastAt: 0 });
  const cool = repairs.breaker([now - 10 * MIN], now, spec);
  assert.deepEqual([cool.allow, cool.why, cool.tried], [false, "cooldown", 1]);
  assert.equal(cool.waitMs, 20 * MIN);
  assert.equal(repairs.breaker([now - 40 * MIN], now, spec).allow, true);
  const lim = repairs.breaker([now - 5 * HOUR, now - 3 * HOUR, now - 1 * HOUR], now, spec);
  assert.deepEqual([lim.allow, lim.why, lim.tried], [false, "limit", 3]);
  assert.equal(repairs.breaker([now - 30 * HOUR, now - 26 * HOUR, now - 25 * HOUR], now, spec).allow, true, "a new day");
  assert.equal(repairs.breaker(undefined, now, spec).allow, true);
});

test("attempt: runs, counts per (repair, subject), waits out the cooldown, then says 'tried N times, needs you' and names the button", () => {
  const w = wire();
  const go = () => repairs.attempt("sweep-streams", { subject: "stuck helpers", why: "2 converters with no viewer" });
  const first = go();
  assert.deepEqual([first.ran, first.state, first.tried], [true, "ran", 1]);
  assert.match(first.sentence, /ran “Tidy stream leftovers” \(1 of 4 today\)/);
  assert.deepEqual(w.fake.calls.map((c) => [c.id, c.by, c.why, c.subject]), [["sweep-streams", "healer", "2 converters with no viewer", "stuck helpers"]]);
  assert.equal(w.notes.length, 1);
  // a minute later: cooldown — nothing is started
  w.clock.now += MIN;
  const second = go();
  assert.deepEqual([second.ran, second.state], [false, "cooldown"]);
  assert.match(second.sentence, /repaired 1 min ago \(1 of 4 today\) — giving it time/);
  assert.equal(w.fake.calls.length, 1);
  // another SUBJECT has its own counter
  assert.equal(repairs.attempt("sweep-streams", { subject: "disk-full", why: "a drive is full" }).ran, true);
  // three more, each after the cooldown: the fourth is the last
  for (let i = 0; i < 3; i++) { w.clock.now += 31 * MIN; assert.equal(go().ran, true, `run ${i + 2}`); }
  w.clock.now += 31 * MIN;
  const over = go();
  assert.deepEqual([over.ran, over.state, over.tried], [false, "limit", 4]);
  assert.equal(over.sentence, "tried 4 times today, needs you — Server → Actions → Tidy stream leftovers");
  assert.deepEqual(over.press, { action: "sweep-streams", label: "Server → Actions → Tidy stream leftovers" });
  assert.equal(w.fake.calls.filter((c) => c.subject === "stuck helpers").length, 4);
  // the counters are in the store (so a restart does not reset them)…
  assert.equal(w.st.data.repairs["sweep-streams|stuck helpers"].length, 4);
  // …and a day later the allowance is back
  w.clock.now += DAY;
  assert.equal(go().ran, true);
  unwire();
});

test("attempt: the outcome of each run is written into the 'what the healer did' list", () => {
  const w = wire();
  repairs.attempt("rescan", { subject: "D:/Movies", why: "D:/Movies came back after 3 h" });
  let log = repairs.recent();
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].repair, log[0].action, log[0].subject, log[0].outcome, log[0].title], ["rescan", "rescan", "D:/Movies", "running", "Rescan the library"]);
  w.fake.calls[0].onDone({ status: "ok", output: "(started by the healer — D:/Movies came back after 3 h)\nScanned. 120 items in the library.\n" });
  log = repairs.recent();
  assert.deepEqual([log[0].outcome, log[0].said], ["ok", "Scanned. 120 items in the library."]);
  // a failure is kept as a failure
  w.clock.now += HOUR;
  repairs.attempt("backup-now", { subject: "stale", why: "the newest working backup is 3 d old" });
  w.fake.calls[1].onDone({ status: "failed", output: "the backup folder is not reachable\n" });
  log = repairs.recent();
  assert.equal(log[0].action, "backup-now", "newest first");
  assert.deepEqual([log[0].outcome, log[0].said], ["failed", "the backup folder is not reachable"]);
  // a run cut off by a restart is "unknown" hours later, and the list keeps twenty
  w.clock.now += HOUR;
  repairs.attempt("rescan", { subject: "E:/Shows", why: "came back" });
  w.clock.now += 3 * HOUR;
  assert.equal(repairs.recent()[0].outcome, "unknown");
  for (let i = 0; i < 30; i++) { w.clock.now += 20 * MIN; repairs.attempt("rescan", { subject: `F:/dir${i}`, why: "came back" }); }
  assert.equal(repairs.recent().length, 20);
  unwire();
});

test("config: \"healer\": { \"autoRepair\": false } switches every automatic repair off; \"off\" lists single ones", () => {
  let w = wire({ healer: { autoRepair: false } });
  const r = repairs.attempt("backup-now", { subject: "stale", why: "old" });
  assert.deepEqual([r.ran, r.state], [false, "off"]);
  assert.match(r.sentence, /automatic repair is switched off in config\.json — press Server → Actions → Back up now/);
  assert.equal(w.fake.calls.length, 0);
  w = wire({ healer: { off: ["backup-now"] } });
  assert.equal(repairs.attempt("backup-now", { subject: "stale", why: "old" }).state, "off");
  assert.equal(repairs.attempt("rescan", { subject: "D:/Movies", why: "back" }).ran, true, "the others still run");
  assert.deepEqual(repairs.settings({ HEALER: {} }), { auto: true, off: new Set() });
  assert.equal(repairs.settings({}).auto, true, "on by default");
  assert.equal(repairs.attempt("no-such-repair", {}).state, "refused");
  unwire();
});

test("attempt: when a long action is already running nothing is counted, and it is tried again next round", () => {
  const w = wire({ actions: { start: () => ({ status: 409, error: "“npm install” is still running" }) } });
  const r = repairs.attempt("patch-webtorrent", { subject: "missing", why: "the patch is missing" });
  assert.deepEqual([r.ran, r.state], [false, "busy"]);
  assert.deepEqual(w.st.data.repairs, {});
  assert.equal(repairs.recent().length, 0);
  unwire();
});

// ------------------------------------------------------------ a whole round

test("a healer round: the flagged repair runs once, is recorded as 'by the healer', is not repeated inside the cooldown — and a non-flagged action is refused", async () => {
  const w = wire();
  const sent = [];
  const send = (title, body) => sent.push([title, body]);
  let helpersStuck = true;
  // a check that finds a converter left running, and one that (wrongly) tries to restart the server
  const checks = [
    ["helpers", "Helper processes", "Process & memory", async (ctx) => {
      if (!helpersStuck) return { status: "ok", summary: "no helper processes running" };
      const r = ctx.repair("sweep-streams", { subject: "stuck helpers", why: "1 converter running with no viewer for 40 min" });
      return { status: "warn", summary: "1 converter running, 1 with nobody watching", findings: [{ level: "warn", title: "Converters left running", text: "…", did: r.sentence, press: r.ran ? undefined : r.press }], healed: r.ran ? "stopped converters nobody was watching" : null };
    }],
    ["rogue", "A check that oversteps", "Process & memory", async () => {
      const r = actions.start("restart", { by: "healer", why: "memory is climbing" });
      return { status: "warn", summary: r.error || "it restarted the server?!", refused: r.status === 403 && !r.run };
    }],
  ];
  // the real healer's repair hand goes through repairs.attempt → the fake Actions list
  const r1 = await healer.run({ checks, send });
  assert.equal(r1.checks.length, 2);
  assert.equal(w.fake.calls.length, 1, "the repair ran");
  assert.deepEqual([w.fake.calls[0].id, w.fake.calls[0].by], ["sweep-streams", "healer"]);
  assert.equal(w.fake.calls[0].why, "1 converter running with no viewer for 40 min");
  assert.match(r1.checks[0].findings[0].did, /ran “Tidy stream leftovers” \(1 of 4 today\)/);
  assert.equal(r1.checks[1].refused, true, "restart was refused");
  assert.match(r1.checks[1].summary, /The healer is not allowed to run "Restart Aurora"/);
  assert.equal(repairs.recent().length, 1);
  assert.equal(repairs.recent()[0].action, "sweep-streams");

  // the next minute's round: the problem is still there, the repair is NOT run again
  w.clock.now += MIN;
  const r2 = await healer.run({ checks, send });
  assert.equal(w.fake.calls.length, 1, "inside the cooldown");
  assert.match(r2.checks[0].findings[0].did, /giving it time before trying again/);
  // the status the admin page reads carries the list
  const st = healer.status();
  assert.equal(st.repairs.length, 1);
  assert.deepEqual(st.autoRepair.may.slice().sort(), ["backup-now", "jit-forget-changed", "patch-webtorrent", "rescan", "sweep-streams"]);
  assert.deepEqual(st.groups, healer._internals.GROUPS);
  assert.deepEqual(sent, [], "a warning pages nobody");
  unwire();
});

test("with autoRepair off the checks still run and the finding names the button instead", async () => {
  const w = wire({ healer: { autoRepair: false } });
  const checks = [["helpers", "Helper processes", "Process & memory", async (ctx) => {
    const r = ctx.repair("sweep-streams", { subject: "stuck helpers", why: "…" });
    return { status: "warn", summary: "1 with nobody watching", findings: [{ level: "warn", title: "t", text: "…", did: r.sentence, press: r.press }] };
  }]];
  const r = await healer.run({ checks, send: () => {} });
  assert.equal(w.fake.calls.length, 0);
  assert.equal(r.checks[0].status, "warn", "the check ran");
  assert.equal(r.checks[0].findings[0].press.label, "Server → Actions → Tidy stream leftovers");
  assert.equal(healer.status().autoRepair.on, true, "status() reads the real config, where repairs are on by default");
  unwire();
});

// ------------------------------------------------------------ alerts (stubbed: nothing is sent)

test("alerts: a new finding class pages at most once per cooldown, sends 'recovered', and a 'quiet' check is left to the health alerts", async () => {
  wire();
  const state = healer._internals.state;
  state.notified.clear();
  const sent = [];
  const send = (title, body) => sent.push([title, body]);
  let status = "fail";
  let quiet = false;
  const checks = [["clock", "Clock", "Updates & delivery", async () => ({
    status, quiet, summary: status === "fail" ? "the server's clock is 3 minutes behind" : "within 1 s of the outside world",
    findings: status === "fail" ? [{ level: "fail", title: "The server's clock is wrong", text: "This machine's clock is 3 minutes behind of the real time.", setting: "Windows: Settings → Time & language → Sync now." }] : [],
  })]];
  await healer.run({ checks, send });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "Aurora healer: Clock");
  assert.match(sent[0][1], /3 minutes behind\nThis machine's clock is 3 minutes behind of the real time\.\nWindows: Settings/);
  await healer.run({ checks, send });
  await healer.run({ checks, send });
  assert.equal(sent.length, 1, "still failing: said once");
  status = "ok";
  await healer.run({ checks, send });
  assert.deepEqual(sent[1], ["Aurora healer: Clock recovered", "within 1 s of the outside world"]);
  // it flaps straight back: inside the cooldown nobody is paged again
  status = "fail";
  await healer.run({ checks, send });
  assert.equal(sent.length, 2, "flapping inside the cooldown is not announced again");
  // a check whose subject the health alerts already announce never sends from here
  state.notified.clear();
  quiet = true;
  await healer.run({ checks, send });
  assert.equal(sent.length, 2);
  state.notified.clear();
  unwire();
});

test("the alert names what the healer did and the exact button", () => {
  const body = healer._internals.alertBody({
    status: "fail", summary: "1 error, 0 warnings in the last 15 min · 1 known problem",
    findings: [{ level: "fail", title: "A drive is full", text: "A drive is full: Aurora could not write a file.", did: "tried 4 times today, needs you — Server → Actions → Tidy stream leftovers", press: { action: "sweep-streams", label: "Server → Actions → Tidy stream leftovers" } }],
  });
  assert.match(body, /1 known problem\nA drive is full: Aurora could not write a file\.\nDid: tried 4 times today, needs you — Server → Actions → Tidy stream leftovers\nPress: Server → Actions → Tidy stream leftovers/);
});

test("there is one alert path: the new checks never call notify themselves", () => {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "src", "lib", "healer-checks");
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(src, /notify"\)\.send\(|notify\.send\(/, `${f} sends a notification of its own`);
  }
});

test("the registry: about thirty checks, each in one of the seven groups, ids unique", () => {
  const { CHECKS, GROUPS } = healer._internals;
  assert.ok(CHECKS.length >= 28 && CHECKS.length <= 34, `${CHECKS.length} checks`);
  assert.equal(GROUPS.length, 7);
  const ids = new Set();
  for (const [id, name, group, fn] of CHECKS) {
    assert.ok(!ids.has(id), `duplicate ${id}`);
    ids.add(id);
    assert.ok(name && GROUPS.includes(group), `${id} is in an unknown group: ${group}`);
    assert.equal(typeof fn, "function", id);
  }
  for (const g of GROUPS) assert.ok(CHECKS.some((c) => c[2] === g), `no check in ${g}`);
  for (const id of ["process", "errors", "downloads", "aria2", "disk", "staging", "temp", "encoding", "data", "tvapp", "upstream", "scanner", "streaming", "realtime"]) assert.ok(ids.has(id), `the original check ${id} is gone`);
});

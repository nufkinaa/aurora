// lib/health.js: the hysteresis / dedup rule (step) and each check's decision
// function, all with injected inputs — no disk is filled and nobody is paged.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const health = require("../src/lib/health");
const { step, freshState, thresholds, diskLevel, decideDisk, decideTools, decideDownloader, decideBackup, decideRestarts, decideProcess, applyResults, validPingUrl, DEFAULTS } = health._internals;

const GB = 1024 ** 3;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T = thresholds({});
const sp = (freeGb, totalGb) => ({ free: freeGb * GB, total: totalGb * GB, freePct: (freeGb / totalGb) * 100 });

// Feed a sequence of levels, one a minute, and collect what was said.
const play = (levels, opts = {}, start = 1e12) => {
  let state;
  const said = [];
  levels.forEach((level, i) => {
    const now = start + i * (opts.everyMs || MIN);
    const r = step(state, { level, message: `it is ${level}` }, now, opts);
    state = r.state;
    if (r.action) said.push(`${i}:${r.action.type}:${r.action.level}`);
  });
  return { said, state };
};

test("step: a problem must be seen twice before it is announced; one bad reading says nothing", () => {
  assert.deepEqual(play(["ok", "warn", "ok", "warn", "ok", "ok"]).said, []);
  assert.deepEqual(play(["ok", "warn", "warn", "warn", "warn"]).said, ["2:alert:warn"]);
  assert.deepEqual(play(["warn", "warn"]).said, ["1:alert:warn"]); // from a cold start too
  assert.deepEqual(play(["critical"], { confirm: 1 }).said, ["0:alert:critical"]);
  assert.deepEqual(play(["warn", "warn", "warn"], { confirm: 3 }).said, ["2:alert:warn"]);
});

test("step: it is said once, not every round — and again only after the repeat window", () => {
  const day = Array(60 * 13).fill("warn"); // 13 hours of minutes
  const { said } = play(day, { repeatMs: 12 * HOUR });
  assert.deepEqual(said, ["1:alert:warn", `${1 + 12 * 60}:reminder:warn`]);
  assert.equal(play(Array(600).fill("critical"), { repeatMs: 12 * HOUR }).said.length, 1);
});

test("step: recovery needs two clear rounds, is said once, and only if the problem was announced", () => {
  assert.deepEqual(play(["warn", "warn", "ok", "warn", "ok", "ok", "ok"]).said, ["1:alert:warn", "5:recovered:ok"]);
  // never announced (one bad reading) -> no "recovered" either
  assert.deepEqual(play(["warn", "ok", "ok", "ok"]).said, []);
  const { state } = play(["warn", "warn", "ok", "ok"]);
  assert.equal(state.level, "ok");
  assert.equal(state.alerted, false);
  assert.ok(state.lastRecoveredAt > 0);
});

test("step: a warning that turns critical is announced at once (after confirming); easing back to warn is not news", () => {
  assert.deepEqual(play(["warn", "warn", "critical", "critical", "critical"]).said, ["1:alert:warn", "3:alert:critical"]);
  assert.deepEqual(play(["critical", "critical", "warn", "warn", "critical", "critical"]).said, ["1:alert:critical"]);
  const { said, state } = play(["critical", "critical", "warn", "warn", "ok", "ok"]);
  assert.deepEqual(said, ["1:alert:critical", "5:recovered:ok"]);
  assert.equal(state.level, "ok");
});

test("step: a problem that flaps is announced once per window, however often it comes and goes", () => {
  const flap = [];
  for (let i = 0; i < 40; i++) flap.push("warn", "warn", "warn", "ok", "ok", "ok");
  const { said } = play(flap, { repeatMs: 12 * HOUR });
  assert.deepEqual(said, ["1:alert:warn", "4:recovered:ok"]); // the later rounds of the same flap stay quiet both ways
  // …but if it comes back WORSE inside the window, that is said
  const worse = play(["warn", "warn", "ok", "ok", "critical", "critical"], { repeatMs: 12 * HOUR });
  assert.deepEqual(worse.said, ["1:alert:warn", "3:recovered:ok", "5:alert:critical"]);
  // …and once the window has passed, a returning problem is announced afresh
  const later = play(["warn", "warn", "ok", "ok", "warn", "warn"], { repeatMs: 3 * MIN });
  assert.deepEqual(later.said, ["1:alert:warn", "3:recovered:ok", "5:alert:warn"]);
});

test("step: a problem that came back too soon to announce is still said if it outlasts the window", () => {
  const seq = ["warn", "warn", "ok", "ok", ...Array(20).fill("warn")];
  const { said } = play(seq, { repeatMs: 10 * MIN });
  assert.deepEqual(said, ["1:alert:warn", "3:recovered:ok", "11:alert:warn", "21:reminder:warn"]);
});

test("step: state survives a restart — an announced problem is not announced again on boot", () => {
  const first = play(["critical", "critical"]);
  const saved = JSON.parse(JSON.stringify(first.state)); // what data/health.json holds
  const r = step(saved, { level: "critical", message: "still" }, 1e12 + 30 * MIN, {});
  assert.equal(r.action, null);
  const r2 = step(JSON.parse(JSON.stringify(r.state)), { level: "critical", message: "still" }, 1e12 + 13 * HOUR, {});
  assert.equal(r2.action.type, "reminder");
  assert.deepEqual(step(undefined, { level: "ok" }, 1, {}).state.level, "ok");
  assert.equal(step(undefined, { level: "nonsense" }, 1, {}).state.level, "ok");
  assert.equal(freshState().level, "ok");
});

test("applyResults: each check keeps its own state; the recovered sentence comes from the check", () => {
  const states = {};
  const sent = [];
  const send = (r, a) => sent.push(`${r.id}:${a.type}:${a.message}`);
  const round = (now, a, b) => applyResults([
    { id: "a", name: "A", level: a, message: `a ${a}`, recovered: "a is fine again" },
    { id: "b", name: "B", level: b, message: `b ${b}`, confirm: 1, clearAfter: 1 },
  ], now, { states, repeatMs: 12 * HOUR, send });
  round(1e12, "warn", "critical");
  round(1e12 + MIN, "warn", "critical");
  round(1e12 + 2 * MIN, "ok", "ok");
  round(1e12 + 3 * MIN, "ok", "ok");
  assert.deepEqual(sent, ["b:alert:b critical", "a:alert:a warn", "b:recovered:B is fine again.", "a:recovered:a is fine again"]);
  assert.deepEqual(Object.keys(states).sort(), ["a", "b"]);
});

test("thresholds: config overrides the defaults; nonsense is ignored", () => {
  assert.deepEqual(thresholds(undefined), DEFAULTS);
  assert.deepEqual(thresholds(false), DEFAULTS);
  const t = thresholds({ diskWarnPercent: 15, diskWarnGb: "50", diskCriticalGb: -1, backupMaxAgeHours: "soon", unknown: 3, repeatHours: 0 });
  assert.equal(t.diskWarnPercent, 15);
  assert.equal(t.diskWarnGb, 50);
  assert.equal(t.diskCriticalGb, DEFAULTS.diskCriticalGb);
  assert.equal(t.backupMaxAgeHours, DEFAULTS.backupMaxAgeHours);
  assert.equal(t.repeatHours, 0);
  assert.equal("unknown" in t, false);
});

test("disk: warn under 10% or 20 GB, critical under 5% or 5 GB, unreachable is critical", () => {
  assert.equal(diskLevel(sp(500, 1000), T), "ok");
  assert.equal(diskLevel(sp(99, 1000), T), "warn"); // 9.9%, plenty of GB
  assert.equal(diskLevel(sp(19, 100), T), "warn"); // 19%, but under 20 GB
  assert.equal(diskLevel(sp(21, 100), T), "ok");
  assert.equal(diskLevel(sp(49, 1000), T), "critical"); // 4.9%
  assert.equal(diskLevel(sp(4.9, 50), T), "critical"); // 9.8% but under 5 GB
  assert.equal(diskLevel(sp(6, 50), T), "warn");
  assert.equal(diskLevel(null, T), "critical");
  assert.equal(diskLevel({ free: 300 * GB, total: 0, freePct: null }, T), "ok"); // no percentage known: GB alone decides
  const loose = thresholds({ diskWarnPercent: 0, diskWarnGb: 0, diskCriticalPercent: 0, diskCriticalGb: 0 });
  assert.equal(diskLevel(sp(0.1, 1000), loose), "ok"); // switched off by config
});

test("disk: a drive hovering at the line does not flip — leaving a level takes 10% more room", () => {
  assert.equal(diskLevel(sp(101, 1000), T, "ok"), "ok");
  assert.equal(diskLevel(sp(101, 1000), T, "warn"), "warn"); // 10.1%: not yet out
  assert.equal(diskLevel(sp(111, 1000), T, "warn"), "ok"); // 11.1%: out
  assert.equal(diskLevel(sp(51, 1000), T, "critical"), "critical"); // 5.1%: not yet out of critical
  assert.equal(diskLevel(sp(56, 1000), T, "critical"), "warn");
  // fed through step(): a week of wobbling around 10% is one message
  let state;
  let level = "ok";
  const said = [];
  for (let i = 0; i < 2000; i++) {
    // two low readings, then it wobbles either side of 10% for a day and more
    level = diskLevel(sp(i < 2 || i % 2 ? 99.5 : 100.5, 1000), T, state ? state.level : "ok");
    const r = step(state, { level, message: "m" }, 1e12 + i * MIN, { repeatMs: 1e15 });
    state = r.state;
    if (r.action) said.push(r.action.type);
  }
  assert.deepEqual(said, ["alert"]);
  assert.equal(state.level, "warn");
});

test("disk: the sentence names the drive's job, the numbers and what will happen", () => {
  const vols = [
    { id: "disk:E:\\Movies", roles: ["media"], dir: "E:\\Movies", space: sp(12, 400) },
    { id: "disk:C:\\aurora\\data", roles: ["data", "backups"], dir: "C:\\aurora\\data", space: sp(15, 1000) },
    { id: "disk:F:\\Shows", roles: ["media"], dir: "F:\\Shows", space: null },
    { id: "disk:G:\\ok", roles: ["media"], dir: "G:\\ok", space: sp(700, 1000) },
  ];
  const [media, data, gone, fine] = decideDisk(vols, T, {});
  assert.equal(media.level, "critical");
  assert.equal(media.message, "The media drive has 3% free (12 GB). Downloads will start failing.");
  assert.equal(data.level, "warn");
  assert.match(data.message, /^The drive holding Aurora's own data and the backups has 1\.5% free \(15 GB\)\. Free some space/);
  // a drive without the media library on it is judged in gigabytes only: 9% of a big system disk is not a problem
  assert.equal(decideDisk([{ id: "c", roles: ["data", "backups"], dir: "C:\\d", space: sp(90, 1000) }], T, {})[0].level, "ok");
  assert.equal(decideDisk([{ id: "c", roles: ["data", "media"], dir: "C:\\d", space: sp(90, 1000) }], T, {})[0].level, "warn");
  assert.equal(decideDisk([{ id: "c", roles: ["data"], dir: "C:\\d", space: sp(4, 1000) }], T, {})[0].level, "critical");
  assert.equal(diskLevel(sp(90, 1000), T, "ok", { byPercent: false }), "ok");
  assert.equal(gone.level, "critical");
  assert.match(gone.message, /cannot be reached \(F:\\Shows\)/);
  assert.match(gone.recovered, /reachable again/);
  assert.equal(fine.level, "ok");
  assert.match(media.recovered, /has room again/);
  assert.deepEqual([media.id, data.id], ["disk:E:\\Movies", "disk:C:\\aurora\\data"]); // stable ids
  // the level it was at is honoured per volume
  assert.equal(decideDisk([{ id: "x", roles: ["media"], dir: "/d", space: sp(105, 1000) }], T, { x: "warn" })[0].level, "warn");
  assert.equal(decideDisk([{ id: "x", roles: ["media"], dir: "/d", space: sp(105, 1000) }], T, {})[0].level, "ok");
  assert.match(decideDisk([{ id: "x", roles: ["backups"], dir: "/b", space: sp(1, 1000) }], T, {})[0].message, /Backups will start failing/);
});

test("tools: missing is a warning, installed-but-broken is critical", () => {
  assert.equal(decideTools({ ffmpegPath: "/usr/bin/ffmpeg", ffprobePath: "/usr/bin/ffprobe", ffmpegRuns: true, ffprobeRuns: true }).level, "ok");
  assert.equal(decideTools({ ffmpegPath: "/usr/bin/ffmpeg", ffprobePath: "/usr/bin/ffprobe", ffmpegRuns: null, ffprobeRuns: null }).level, "ok"); // not tried yet
  const none = decideTools({ ffmpegPath: null, ffprobePath: null });
  assert.equal(none.level, "warn");
  assert.match(none.message, /^ffmpeg and ffprobe are not installed/);
  const one = decideTools({ ffmpegPath: "/x/ffmpeg", ffprobePath: null, ffmpegRuns: true });
  assert.match(one.message, /^ffprobe is not installed/);
  const broken = decideTools({ ffmpegPath: "/x/ffmpeg", ffprobePath: "/x/ffprobe", ffmpegRuns: false, ffprobeRuns: true });
  assert.equal(broken.level, "critical");
  assert.match(broken.message, /^ffmpeg is installed but will not start/);
  assert.equal(broken.id, "tools");
});

test("downloader: only a problem when downloads are actually waiting", () => {
  assert.equal(decideDownloader({ available: true, running: false, waiting: 0 }).level, "ok"); // idle engine is normal
  assert.equal(decideDownloader({ available: false, running: false, waiting: 0 }).level, "ok");
  assert.equal(decideDownloader({ available: true, running: true, answering: true, waiting: 2 }).level, "ok");
  const notInstalled = decideDownloader({ available: false, running: false, waiting: 1 });
  assert.equal(notInstalled.level, "warn");
  assert.match(notInstalled.message, /^1 download is waiting, but the download engine \(aria2\) is not installed/);
  const dead = decideDownloader({ available: true, running: false, waiting: 3 });
  assert.equal(dead.level, "critical");
  assert.match(dead.message, /has stopped and 3 downloads are waiting/);
  const deaf = decideDownloader({ available: true, running: true, answering: false, waiting: 1 });
  assert.equal(deaf.level, "critical");
  assert.match(deaf.message, /not responding/);
  assert.equal(decideDownloader({ available: true, running: true, answering: null, waiting: 1 }).level, "ok"); // not asked
});

test("backup freshness: 48 hours is the line; a new install gets 48 hours of grace; off is off", () => {
  const now = 1e12;
  const ok = decideBackup({ enabled: true, newestAt: now - 20 * HOUR, firstSeenAt: now - 900 * HOUR }, now, T);
  assert.equal(ok.level, "ok");
  assert.equal(decideBackup({ enabled: true, newestAt: now - 47 * HOUR }, now, T).level, "ok");
  const stale = decideBackup({ enabled: true, newestAt: now - 50 * HOUR, lastError: "ENOSPC" }, now, T);
  assert.equal(stale.level, "warn");
  assert.match(stale.message, /no working backup for 50 hours .*The last attempt said: ENOSPC\./);
  const dead = decideBackup({ enabled: true, newestAt: now - 8 * 24 * HOUR }, now, T);
  assert.equal(dead.level, "critical");
  assert.match(dead.message, /8 days old/);
  assert.equal(decideBackup({ enabled: true, newestAt: null, firstSeenAt: now - 2 * HOUR }, now, T).level, "ok"); // first one pending
  assert.equal(decideBackup({ enabled: true, newestAt: null }, now, T).level, "ok"); // no firstSeen yet: grace
  const never = decideBackup({ enabled: true, newestAt: null, firstSeenAt: now - 60 * HOUR }, now, T);
  assert.equal(never.level, "critical");
  assert.match(never.message, /no working backup at all/);
  assert.equal(decideBackup({ enabled: false, newestAt: null, firstSeenAt: 1 }, now, T).level, "ok");
  assert.equal(decideBackup({ enabled: true, newestAt: now - 30 * HOUR }, now, thresholds({ backupMaxAgeHours: 24 })).level, "warn");
});

test("restarts: three boots in ten minutes is a crash loop; older boots do not count", () => {
  const now = 1e12;
  assert.equal(decideRestarts({ boots: [now], crashes: 0 }, now, T).level, "ok");
  assert.equal(decideRestarts({ boots: [now - 9 * MIN, now], crashes: 0 }, now, T).level, "ok");
  const loop = decideRestarts({ boots: [now - 9 * MIN, now - 4 * MIN, now], crashes: 0 }, now, T);
  assert.equal(loop.level, "critical");
  assert.match(loop.message, /^Aurora has started 3 times in the last 10 minutes/);
  assert.equal(decideRestarts({ boots: [now - 3 * HOUR, now - 2 * HOUR, now - 11 * MIN, now], crashes: 0 }, now, T).level, "ok");
  assert.equal(decideRestarts({ boots: [now - 9 * MIN, now - 4 * MIN, now], crashes: 0 }, now + 7 * MIN, T).level, "ok"); // it stayed up: clears
  assert.equal(decideRestarts({ boots: [now + HOUR, now + 2 * HOUR, now + 3 * HOUR], crashes: 0 }, now, T).level, "ok"); // clock went back
  assert.equal(decideRestarts({ boots: undefined, crashes: 4 }, now, T).level, "ok");
  const errs = decideRestarts({ boots: [now - HOUR], crashes: 5 }, now, T);
  assert.equal(errs.level, "warn");
  assert.match(errs.message, /5 unexpected errors in the last 15 minutes/);
  assert.equal(decideRestarts({ boots: [now - MIN, now], crashes: 0 }, now, thresholds({ bootLoopCount: 2 })).level, "critical");
});

test("process: reads the watchdog's numbers and events, measures nothing", () => {
  const now = 1e12;
  const th = { softRss: 1000 * 1048576, hardRss: 1300 * 1048576, softLagMs: 1500, hardLagMs: 6000 };
  const w = (rssMb, lagMs, events = []) => ({ now: { rss: rssMb * 1048576, lagMs }, thresholds: th, events });
  assert.equal(decideProcess(w(200, 3), now).level, "ok");
  assert.equal(decideProcess(w(1100, 2000), now).level, "ok"); // soft: the watchdog's own business
  assert.equal(decideProcess(w(1400, 3), now).level, "warn");
  assert.equal(decideProcess(w(200, 7000), now).level, "warn");
  const loop = decideProcess(w(200, 3, [{ at: now - 5 * MIN, kind: "restart loop suspected" }]), now);
  assert.equal(loop.level, "critical");
  const noPm2 = decideProcess(w(200, 3, [{ at: now - 5 * MIN, kind: "hard heal skipped" }]), now);
  assert.equal(noPm2.level, "critical");
  assert.match(noPm2.message, /not running under pm2/);
  assert.equal(decideProcess(w(200, 3, [{ at: now - 45 * MIN, kind: "restart loop suspected" }]), now).level, "ok"); // old news
  assert.equal(decideProcess(w(200, 3, [{ at: now - MIN, kind: "soft heal" }]), now).level, "ok");
  assert.equal(decideProcess(null, now).level, "ok");
});

test("raise / clear (how backup.js reports a failed snapshot): said once, cleared once, no nagging", () => {
  const live = health._internals.live;
  const sent = [];
  live.deliver = (check, action) => sent.push(`${check.id}:${action.type}:${action.level}`);
  const before = JSON.stringify(live.mem);
  try {
    assert.equal(live.started, false); // nothing here ever starts the real thing
    health.clear("t-backup", "fine"); // clearing what was never raised says nothing
    health.raise("t-backup", "critical", "The backup could not be made.", "Backups");
    health.raise("t-backup", "critical", "The backup could not be made."); // the hourly retry failing again
    health.raise("t-backup", "critical", "The backup could not be made.");
    health.clear("t-backup", "Backups are working again.");
    health.clear("t-backup", "Backups are working again.");
    assert.deepEqual(sent, ["t-backup:alert:critical", "t-backup:recovered:ok"]);
    const st = health.status();
    const row = st.checks.find((c) => c.id === "t-backup");
    assert.equal(row.level, "ok");
    assert.equal(row.name, "Backups");
    assert.ok(row.lastAlertAt && row.lastRecoveredAt);
    assert.equal(st.events[0].type, "recovered"); // newest first
    assert.equal(st.delivery.webPush, false);
    assert.equal(typeof st.delivery.warning === "string" || st.delivery.warning === null, true);
    assert.equal(st.delivery.channels.length === 0, st.delivery.warning !== null); // no channel -> says so
    assert.equal(st.healthz, "/healthz");
  } finally {
    live.deliver = null;
    Object.assign(live.mem, JSON.parse(before));
    live.latest.delete("t-backup");
  }
});

test("/healthz answers ok, uptime and version — and nothing else", () => {
  let body = null;
  const headers = {};
  health.healthz({}, { setHeader: (k, v) => { headers[k] = v; }, json: (b) => { body = b; } });
  assert.deepEqual(Object.keys(body).sort(), ["ok", "uptime", "version"]);
  assert.equal(body.ok, true);
  assert.equal(Number.isInteger(body.uptime), true);
  assert.equal(body.version, require("../package.json").version);
  assert.equal(headers["Cache-Control"], "no-store");
});

test("the ping URL must be http(s); requiring the module starts no timers", () => {
  assert.equal(validPingUrl("https://hc-ping.com/abc"), true);
  assert.equal(validPingUrl("http://10.0.0.5:8000/ping/abc"), true);
  for (const bad of ["", "hc-ping.com/abc", "file:///etc/passwd", "javascript:alert(1)", null]) assert.equal(validPingUrl(bad), false, String(bad));
  const live = health._internals.live;
  assert.equal(live.timer, null);
  assert.equal(live.pingTimer, null);
  assert.equal(live.store, null); // data/health.json is only opened by start()
});

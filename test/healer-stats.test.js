// The healer's statistics (src/lib/healer-checks/stats.js) and the play marks
// they are built from (src/lib/playmarks.js): each threshold as a pure
// decision — numbers in, verdict out.
const test = require("node:test");
const assert = require("node:assert");
const playmarks = require("../src/lib/playmarks");
const stats = require("../src/lib/healer-checks/stats");
const store = require("../src/lib/healer-checks/store");
const { dayKey } = require("../src/lib/healer-checks/util");
const S = stats._internals;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 8, 21, 0, 0).getTime();
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

// ------------------------------------------------------------ play marks

test("play marks fold into one record per play: path, first frame, stalls, errors, device", () => {
  playmarks._reset();
  const t = NOW - HOUR;
  const web = { id: "aaaaaaaaaaaa", ip: "10.0.0.2", ua: CHROME };
  playmarks.record({ ...web, name: "mount", ms: 0, now: t });
  playmarks.record({ ...web, name: "path", ms: 40, extra: { path: "jit" }, now: t + 40 });
  playmarks.record({ ...web, name: "first-frame", ms: 1800, extra: { transcode: "true", jit: "true" }, now: t + 1800 });
  playmarks.record({ ...web, name: "stall", ms: 60000, extra: { stage: "nudge", position: "58" }, now: t + 60000 });
  playmarks.record({ ...web, name: "stall", ms: 63000, extra: { stage: "rebuild" }, now: t + 63000 }); // the SAME stall, next stage
  const p = playmarks.list()[0];
  assert.equal(p.path, "jit");
  assert.equal(p.ffMs, 1800);
  assert.equal(p.stalls, 1, "the stages of one stall are one stall");
  assert.equal(p.device, "desktop");
  // the TV app says so itself
  const tv = { id: "bbbbbbbbbbbb", ip: "10.0.0.3", ua: "okhttp/4.12" };
  playmarks.record({ ...tv, name: "mount", extra: { app: "tv" }, now: t });
  playmarks.record({ ...tv, name: "first-frame", ms: 900, extra: { app: "tv", v: "direct" }, now: t + 900 });
  playmarks.record({ ...tv, name: "stall", ms: 5000, extra: { app: "tv", at: "4" }, now: t + 5000 });
  playmarks.record({ ...tv, name: "stall-end", ms: 9000, extra: { app: "tv", lasted: "4000" }, now: t + 9000 });
  playmarks.record({ ...tv, name: "error", ms: 20000, extra: { app: "tv", m: "decoder gave up" }, now: t + 20000 });
  const q = playmarks.list()[1];
  assert.deepEqual([q.device, q.path, q.ffMs, q.stalls, q.errors, q.errMsg], ["tv", "tv", 900, 1, 1, "decoder gave up"]);
  // a phone that mounted and never showed a picture
  playmarks.record({ id: "cccccccccccc", ip: "10.0.0.4", ua: IPHONE, name: "mount", now: t });
  const s = playmarks.summarize(playmarks.list(), NOW, DAY);
  assert.equal(s.plays, 3);
  assert.equal(s.started, 2);
  assert.equal(s.startFailures, 1);
  assert.equal(s.stalls, 2);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.byPath.jit, { n: 1, p50: 1800, p90: 1800 });
  assert.deepEqual(s.byPath.tv, { n: 1, p50: 900, p90: 900 });
  assert.equal(s.byDevice.phone.startFailures, 1);
  assert.deepEqual(s.failuresByTitle, { bbbbbbbbbbbb: 1, cccccccccccc: 1 });
  playmarks._reset();
});

test("a start failure needs a sane wait: a mount seconds ago is not one yet; a second mount is a second play", () => {
  playmarks._reset();
  const a = { id: "aaaaaaaaaaaa", ip: "10.0.0.2", ua: CHROME };
  playmarks.record({ ...a, name: "mount", now: NOW - 20 * 1000 });
  assert.equal(playmarks.summarize(playmarks.list(), NOW).startFailures, 0);
  assert.equal(playmarks.summarize(playmarks.list(), NOW + 2 * MIN).startFailures, 1);
  playmarks.record({ ...a, name: "mount", now: NOW + 3 * MIN });
  playmarks.record({ ...a, name: "first-frame", ms: 700, extra: { transcode: "false" }, now: NOW + 3 * MIN + 700 });
  const s = playmarks.summarize(playmarks.list(), NOW + 10 * MIN);
  assert.equal(s.plays, 2);
  assert.equal(s.byPath.direct.n, 1);
  // a "card" (playback stopped) is an error; the window drops old plays
  playmarks.record({ ...a, name: "stall", extra: { stage: "card" }, now: NOW + 5 * MIN });
  assert.equal(playmarks.summarize(playmarks.list(), NOW + 10 * MIN).errors, 1);
  assert.equal(playmarks.summarize(playmarks.list(), NOW + 3 * DAY, DAY).plays, 0);
  playmarks._reset();
});

test("troubledJustNow: a stall that never ended, or an error, moments before a session closed", () => {
  playmarks._reset();
  const a = { id: "aaaaaaaaaaaa", ip: "10.0.0.2", ua: CHROME };
  playmarks.record({ ...a, name: "mount", now: NOW - 10 * MIN });
  playmarks.record({ ...a, name: "first-frame", ms: 500, now: NOW - 10 * MIN + 500 });
  assert.equal(playmarks.troubledJustNow("10.0.0.2", NOW), false);
  playmarks.record({ ...a, name: "stall", extra: { stage: "nudge" }, now: NOW - 30 * 1000 });
  assert.equal(playmarks.troubledJustNow("10.0.0.2", NOW), true);
  assert.equal(playmarks.troubledJustNow("10.0.0.99", NOW), false, "somebody else's stall");
  assert.equal(playmarks.troubledJustNow("10.0.0.2", NOW + 10 * MIN), false, "ten minutes later it is not 'just before'");
  const tv = { id: "bbbbbbbbbbbb", ip: "10.0.0.3", ua: "okhttp" };
  playmarks.record({ ...tv, name: "mount", extra: { app: "tv" }, now: NOW - MIN });
  playmarks.record({ ...tv, name: "stall", extra: { app: "tv" }, now: NOW - 40 * 1000 });
  playmarks.record({ ...tv, name: "stall-end", extra: { app: "tv" }, now: NOW - 30 * 1000 });
  assert.equal(playmarks.troubledJustNow("10.0.0.3", NOW), false, "the stall ended: an ordinary stop");
  playmarks._reset();
});

test("the play-mark route feeds the store and still writes its log line", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "routes", "api.js"), "utf8");
  assert.match(src, /console\.log\(`\[play\] \$\{tidy\(req\.params\.id, 12\)\} \+\$\{ms\}ms \$\{name\}/, "the log line is as it was");
  assert.match(src, /require\("\.\.\/lib\/playmarks"\)\.record\(/);
});

// ------------------------------------------------------------ playback

const day = (o = {}) => ({ plays: 20, started: 20, startFailures: 0, stalls: 2, errors: 0, ttffP50: 1200, watchSec: 10 * 3600, ...o });
const today = (o = {}) => ({ plays: 20, started: 20, startFailures: 0, stalls: 2, errors: 0, ttff: { p50: 1300, p90: 3000 }, byPath: { direct: { n: 12, p50: 800, p90: 1500 }, jit: { n: 8, p50: 2100, p90: 4000 } }, byDevice: { tv: { plays: 10, startFailures: 0, stalls: 1, errors: 0 }, desktop: { plays: 10, startFailures: 0, stalls: 1, errors: 0 } }, failuresByTitle: {}, watchSec: 10 * 3600, ...o });
const week = Array.from({ length: 7 }, () => day());

test("playback: an ordinary day is no finding", () => {
  assert.deepEqual(S.judgePlayback(today(), week), []);
  assert.deepEqual(S.judgePlayback(today(), []), [], "nor without a baseline");
});

test("playback: start failures well above their own baseline are a finding; a normally flaky house is not", () => {
  const bad = today({ startFailures: 7, started: 13 });
  const f = S.judgePlayback(bad, week);
  assert.equal(f.length, 1);
  assert.match(f[0].text, /7 of the last 20 plays never showed a first frame/);
  assert.match(f[0].evidence, /35% failed to start \(usual: 0%\)/);
  // 2 of 20 is under the line; and a house whose baseline is already 30% is not alarmed by 35%
  assert.deepEqual(S.judgePlayback(today({ startFailures: 2 }), week), []);
  const flaky = Array.from({ length: 7 }, () => day({ startFailures: 6 }));
  assert.deepEqual(S.judgePlayback(bad, flaky), []);
  // with too few plays nothing is concluded
  assert.deepEqual(S.judgePlayback(today({ plays: 3, startFailures: 3, started: 0, ttff: { p50: null, p90: null } }), week), []);
});

test("playback: slow starts are judged against the house's own median, and name the slowest path", () => {
  const slow = today({ ttff: { p50: 5200, p90: 14000 }, byPath: { direct: { n: 12, p50: 900, p90: 1500 }, jit: { n: 8, p50: 9000, p90: 15000 } } });
  const f = S.judgePlayback(slow, week);
  assert.equal(f.length, 1);
  assert.match(f[0].text, /the slowest path is “jit” at 9\.0 s/);
  assert.match(f[0].evidence, /5\.2 s median, 14\.0 s p90 \(usual: 1\.2 s\)/);
  assert.deepEqual(S.judgePlayback(today({ ttff: { p50: 2300, p90: 5000 } }), week), [], "under 4 s and under twice the usual");
  // no baseline yet: only a generous absolute line
  assert.deepEqual(S.judgePlayback(today({ ttff: { p50: 5200, p90: 9000 } }), []), []);
  assert.equal(S.judgePlayback(today({ ttff: { p50: 9000, p90: 20000 } }), []).length, 1);
});

test("playback: stalls per hour watched, and errors per play", () => {
  const stally = today({ stalls: 45 }); // 4.5 an hour against a usual 0.2
  const f = S.judgePlayback(stally, week);
  assert.equal(f.length, 1);
  assert.match(f[0].evidence, /4\.5 stalls per hour watched \(usual: 0\.2\)/);
  assert.deepEqual(S.judgePlayback(today({ stalls: 12 }), week), [], "1.2 an hour is not three");
  const errs = S.judgePlayback(today({ errors: 6, failuresByTitle: { a: 2, b: 2, c: 2 } }), week);
  assert.equal(errs.length, 1);
  assert.match(errs[0].evidence, /0\.30 errors per play/);
});

test("playback: when ONE title is most of the failures it is named", () => {
  const f = S.judgePlayback(today({ errors: 5, failuresByTitle: { "0a1b2c3d4e5f": 5, ffffffffffff: 1 } }), week, (id) => (id === "0a1b2c3d4e5f" ? "Broken Film" : id));
  const one = f.find((x) => x.title === "One title is behind most failures");
  assert.ok(one);
  assert.match(one.text, /“Broken Film” accounts for 5 of the 6 playback failures/);
  assert.equal(one.press.action, "jit-forget-changed");
  // spread over many titles: nobody is named
  const spread = S.judgePlayback(today({ errors: 6, failuresByTitle: { a: 2, b: 2, c: 2 } }), week);
  assert.ok(!spread.some((x) => /One title/.test(x.title)));
});

test("playback: failures almost all on one kind of device are pointed out", () => {
  const f = S.judgePlayback(today({ errors: 5, failuresByTitle: { a: 2, b: 2, c: 1 }, byDevice: { tv: { plays: 10, startFailures: 0, stalls: 0, errors: 5 }, desktop: { plays: 10, startFailures: 0, stalls: 0, errors: 0 } } }), week);
  assert.ok(f.some((x) => /5 of 5 failures were on the TV app/.test(x.text)));
});

test("the playback check saves the day's numbers as tomorrow's baseline and phrases the summary", async () => {
  playmarks._reset();
  const st = store.useMemory();
  for (let i = 0; i < 6; i++) {
    const p = { id: "aaaaaaaaaaaa", ip: `10.0.0.${i}`, ua: CHROME };
    playmarks.record({ ...p, name: "mount", now: NOW - HOUR });
    playmarks.record({ ...p, name: "path", extra: { path: "direct" }, now: NOW - HOUR + 10 });
    playmarks.record({ ...p, name: "first-frame", ms: 600 + i * 100, now: NOW - HOUR + 700 });
  }
  const sessions = [{ startedAt: new Date(NOW - 2 * HOUR).toISOString(), watchedSec: 7200 }];
  const r = await stats.checkPlayback({ now: NOW, store: st, sessions, nameOf: (id) => id });
  assert.equal(r.status, "ok");
  assert.match(r.summary, /6 plays in 24 h · first frame 900 ms median, 1\.1 s p90 · 0 failed to start · 0\.0 stalls per hour watched/);
  assert.match(r.detail, /By path \(median\/p90, plays\): direct 900 ms\/1\.1 s \(6\)/);
  assert.match(r.detail, /By device: desktop 6/);
  assert.equal(st.data.days[dayKey(NOW)].plays, 6);
  assert.equal(st.data.days[dayKey(NOW)].watchSec, 7200);
  playmarks._reset();
  assert.match((await stats.checkPlayback({ now: NOW, store: store.useMemory(), sessions: [] })).summary, /nothing has been played/);
});

// ------------------------------------------------------------ sessions

test("sessions: abnormal ends are a rate, and a finding only when it jumps", () => {
  assert.deepEqual(S.judgeSessions({ ended: 20, abnormal: 1 }, { ended: 100, abnormal: 4 }), []);
  assert.deepEqual(S.judgeSessions({ ended: 4, abnormal: 2 }, { ended: 100, abnormal: 4 }), [], "two is not a pattern");
  const f = S.judgeSessions({ ended: 20, abnormal: 7 }, { ended: 100, abnormal: 4 });
  assert.equal(f.length, 1);
  assert.match(f[0].text, /7 of the last 20 viewings ended in the middle of the film right after a stall or an error/);
  assert.match(f[0].evidence, /35% ended abnormally \(usual: 4%\)/);
  // a house where a quarter always end that way is not alarmed by 30%
  assert.deepEqual(S.judgeSessions({ ended: 20, abnormal: 6 }, { ended: 100, abnormal: 25 }), []);
});

test("the sessions check reads viewers now and today's peak from the telemetry ring, and counts abnormal ends", async () => {
  const midnight = new Date(NOW); midnight.setHours(0, 0, 0, 0);
  const ring = [
    { t: midnight.getTime() - HOUR, watching: 9, clients: 9 }, // yesterday's peak does not count
    { t: NOW - 3 * HOUR, watching: 4, clients: 6 },
    { t: NOW - 30 * 1000, watching: 2, clients: 3 },
  ];
  const ended = (agoMs, abnormal) => ({ live: false, endedAt: new Date(NOW - agoMs).toISOString(), abnormal });
  const telemetry = { ring, sessions: { data: [{ live: true }, ended(HOUR, true), ended(2 * HOUR), ended(3 * DAY, true), ended(9 * DAY, true)] } };
  const r = await stats.checkSessions({ now: NOW, telemetry });
  assert.match(r.summary, /2 viewers now · peak today 4 · 2 viewings ended in 24 h, 1 of them abnormally/);
  assert.equal(r.status, "ok");
});

test("telemetry marks a session that ended in trouble (and only an unfinished one)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "telemetry.js"), "utf8");
  assert.match(src, /troubledJustNow\(s\.ip\)\) s\.abnormal = true/);
  assert.match(src, /s\.position \/ s\.duration > 0\.93/);
});

// ------------------------------------------------------------ transcoding

test("transcoding: refusals for lack of an encoder, slow segments, newly declined files", () => {
  const calm = { refused15: 2, refused24: 9, segSlow: 1, segAll: 200, newDeclined: [], slots: { active: 1, max: 2 }, producers: 1 };
  assert.deepEqual(S.judgeTranscoding(calm), []);
  const busy = S.judgeTranscoding({ ...calm, refused15: 8, slots: { active: 2, max: 2 } });
  assert.equal(busy.length, 1);
  assert.match(busy[0].text, /8 requests for a converted stream were refused/);
  assert.match(busy[0].evidence, /8 in 15 min, 9 in 24 h · 2 of 2 encoders in use/);
  const slow = S.judgeTranscoding({ ...calm, segSlow: 30, segAll: 100 });
  assert.match(slow[0].title, /slow to arrive/);
  assert.deepEqual(S.judgeTranscoding({ ...calm, segSlow: 4, segAll: 10 }), [], "too few to say");
  const dec = S.judgeTranscoding({ ...calm, newDeclined: ["A.mkv", "B.mkv"] });
  assert.equal(dec[0].level, "info");
  assert.match(dec[0].text, /“A\.mkv”, “B\.mkv” could not be repackaged the fast way since yesterday/);
  assert.equal(dec[0].press.action, "jit-forget-changed");
});

test("the transcoding check retries ONE declined file whose file changed, through the repair, and counts the rest", async () => {
  const signals = require("../src/lib/signals");
  signals._reset();
  for (let i = 0; i < 6; i++) signals.hit("no-encoder", "rendition", NOW - MIN);
  const jit = { declinedList: () => [{ key: "0a1b2c3d4e5f-1000", why: "bad index", at: NOW - 5 * DAY }, { key: "111111111111-2000", why: "bad index", at: NOW - HOUR }, { key: "111111111111-2000|enc", why: "x", at: NOW - HOUR }], liveCount: () => 2 };
  const remux = { encodeLoad: () => ({ active: 2, max: 2 }) };
  const asked = [];
  const r = await stats.checkTranscoding({
    now: NOW, force: true, signals, jit, remux,
    nameOf: (id) => (id === "0a1b2c3d4e5f" ? "Replaced.mkv" : "Fresh.mkv"),
    mtimeOf: (id) => (id === "0a1b2c3d4e5f" ? 9999 : 2000), // the first file is not the file that was declined
    repair: (name, o) => { asked.push([name, o.subject]); return { ran: true, state: "ran", sentence: "ran it" }; },
  });
  assert.deepEqual(asked, [["jit-forget-changed", "0a1b2c3d4e5f-1000"]], "one entry, by its key — never the whole list");
  assert.match(r.healed, /retrying “Replaced\.mkv” on the fast path/);
  assert.equal(r.status, "warn");
  assert.match(r.summary, /2 repackagers running · 2 of 2 encoders in use · 6 refused for lack of an encoder in 24 h · 2 files on the slow path/);
  assert.ok(r.findings.some((f) => /“Fresh\.mkv”/.test(f.text)), "the file declined in the last day is named");
  signals._reset();
});

// ------------------------------------------------------------ downloads

const iso = (ms) => new Date(ms).toISOString();
test("downloads: success and failure over the last days, time to finish, second sources, approvals waiting", () => {
  const jobs = [
    { status: "done", at: iso(NOW - 3 * DAY), approvedAt: iso(NOW - 3 * DAY), doneAt: iso(NOW - 3 * DAY + 40 * MIN) },
    { status: "done", at: iso(NOW - 2 * DAY), approvedAt: iso(NOW - 2 * DAY), doneAt: iso(NOW - 2 * DAY + 20 * MIN), raceCount: 1, secondSourceWon: true },
    { status: "done", at: iso(NOW - DAY), approvedAt: iso(NOW - DAY), doneAt: iso(NOW - DAY + 60 * MIN), raceCount: 1 },
    { status: "done", at: iso(NOW - 30 * DAY), doneAt: iso(NOW - 30 * DAY + MIN) }, // outside the window
    { status: "error", at: iso(NOW - DAY), resolvedAt: iso(NOW - DAY), error: "no seeders" },
    { status: "pending", at: iso(NOW - 3 * DAY) },
    { status: "pending", at: iso(NOW - HOUR) },
  ];
  const n = S.downloadNumbers(jobs, NOW);
  assert.deepEqual([n.done, n.failed, n.raced, n.secondWon, n.pending, n.pendingOld], [3, 1, 2, 1, 2, 1]);
  assert.equal(n.medianMs, 40 * MIN);
  const f = S.judgeDownloads(n);
  assert.equal(f.length, 1, "one failure in four is not a finding; the three-day-old request is");
  assert.match(f[0].text, /1 download request has been waiting more than a day for your approval; the oldest for 3 d/);
  assert.match(f[0].setting, /Downloads tab → Approve or Decline/);
  const bad = S.judgeDownloads({ ...n, failed: 4, pendingOld: 0, lastError: "no seeders" });
  assert.match(bad[0].text, /4 of the last 7 downloads failed — the most recent said: no seeders/);
});

test("the download-results check phrases the numbers", async () => {
  const jobs = [
    { status: "done", at: iso(NOW - DAY), approvedAt: iso(NOW - DAY), doneAt: iso(NOW - DAY + 30 * MIN), raceCount: 1, secondSourceWon: true },
    { status: "done", at: iso(NOW - DAY), approvedAt: iso(NOW - DAY), doneAt: iso(NOW - DAY + 50 * MIN) },
  ];
  const r = await stats.checkDownloadStats({ now: NOW, jobs, force: true });
  assert.equal(r.status, "ok");
  assert.match(r.summary, /7 days: 2 finished, 0 failed \(100% succeeded\) · 50 min median to finish · 1 needed a second source, which won 1 time/);
  assert.match((await stats.checkDownloadStats({ now: NOW, jobs: [], force: true })).summary, /no downloads finished or failed in 7 days/);
});

// ------------------------------------------------------------ memory trend

const line = (fromMB, perHour, hours, everyMin = 5) => {
  const pts = [];
  for (let m = hours * 60; m >= 0; m -= everyMin) pts.push({ t: NOW - m * MIN, memMB: Math.round(fromMB + perHour * (hours - m / 60)) });
  return pts;
};

test("memory trend: a steady climb that will reach the restart line within hours is a leak; a flat or sawtooth line is not", () => {
  const leak = S.memTrend(line(600, 80, 6), 1300, NOW);
  assert.equal(leak.leak, true);
  assert.ok(Math.abs(leak.slopeMBh - 80) < 2, `slope ${leak.slopeMBh}`);
  assert.ok(leak.etaH > 2 && leak.etaH < 3.5, `eta ${leak.etaH}`); // 1080 MB now, 220 to go at 80/h
  assert.equal(S.memTrend(line(600, 0, 6), 1300, NOW).leak, false);
  assert.equal(S.memTrend(line(300, 15, 6), 1300, NOW).leak, false, "climbing, but the line is days away");
  const saw = line(600, 0, 6).map((p, i) => ({ ...p, memMB: 600 + (i % 12) * 20 }));
  assert.equal(S.memTrend(saw, 1300, NOW).leak, false);
  // under two hours of samples there is no trend to speak of
  const young = S.memTrend(line(600, 300, 1), 1300, NOW);
  assert.deepEqual([young.leak, young.slopeMBh], [false, null]);
});

test("the memory-trend check reads the telemetry ring and the watchdog's own samples — it measures nothing itself", async () => {
  const watchdog = { thresholds: { hardRss: 1300 * 1048576, softLagMs: 1500 } };
  const history = Array.from({ length: 60 }, (_, i) => ({ lagMs: i % 10 === 0 ? 2000 : 30, ffmpeg: i < 30 ? 1 : 3 }));
  const r = await stats.checkMemTrend({ now: NOW, watchdog, ring: line(600, 80, 6), history });
  assert.equal(r.status, "warn");
  assert.match(r.summary, /memory \+80(\.\d)? MB\/h over the last hours · lag p95 2\.0 s in the last hour · ffmpeg 2\.0 on average, 3 at most/);
  assert.ok(r.findings.some((f) => /will reach the line where it restarts itself in roughly/.test(f.text) && f.press.action === "restart"));
  assert.ok(r.findings.some((f) => /sluggish/.test(f.title)));
  const calm = await stats.checkMemTrend({ now: NOW, watchdog, ring: line(400, 0, 6), history: history.map(() => ({ lagMs: 20, ffmpeg: 0 })) });
  assert.equal(calm.status, "ok");
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "lib", "healer-checks", "stats.js"), "utf8");
  assert.doesNotMatch(src, /setInterval|process\.memoryUsage/, "no second sampler");
});

// ------------------------------------------------------------ stuck helpers

test("helpers: a converter nobody has asked for anything in a quarter hour is stuck; a watched one is not", async () => {
  const helpers = [
    { kind: "jit", name: "aaaaaaaaaaaa-1", startedAt: NOW - 3 * HOUR, idleMs: 20 * 1000 }, // being watched
    { kind: "remux", name: "bbbbbbbbbbbb-1-h264-0", startedAt: NOW - 2 * HOUR, idleMs: 40 * MIN }, // the reaper missed it
    { kind: "jit", name: "cccccccccccc-1", startedAt: NOW - 7 * HOUR, idleMs: 6 * MIN }, // ancient and idle
    { kind: "jit", name: "dddddddddddd-1", startedAt: NOW - 7 * HOUR, idleMs: 30 * 1000 }, // ancient, but a long film being watched
  ];
  assert.deepEqual(S.stuckHelpers(helpers, NOW).map((h) => h.name), ["bbbbbbbbbbbb-1-h264-0", "cccccccccccc-1"]);
  const asked = [];
  const r = await stats.checkHelpers({ now: NOW, helpers, orphanDownloads: 0, repair: (name, o) => { asked.push([name, o.subject]); return { ran: true, state: "ran", sentence: "ran “Tidy stream leftovers” (1 of 4 today)" }; } });
  assert.equal(r.status, "warn");
  assert.deepEqual(asked, [["sweep-streams", "stuck helpers"]]);
  assert.match(r.findings[0].text, /2 ffmpeg processes have been running with nobody watching — the longest for 40 min/);
  assert.equal(r.findings[0].did, "ran “Tidy stream leftovers” (1 of 4 today)");
  const fine = await stats.checkHelpers({ now: NOW, helpers: helpers.slice(0, 1), orphanDownloads: 0 });
  assert.equal(fine.status, "ok");
  assert.match(fine.summary, /1 converter running, all with a viewer/);
  const orphan = await stats.checkHelpers({ now: NOW, helpers: [], orphanDownloads: 2 });
  assert.match(orphan.findings[0].text, /busy with 2 downloads that no job in the queue owns/);
});

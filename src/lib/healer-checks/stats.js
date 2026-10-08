// The healer looking at STATISTICS, not log lines: how playback is really
// going, who is watching, what the encoders are doing, how downloads end,
// where memory is heading, and whether a helper process has been left behind.
//
// Every `judge…` function is pure — numbers in, verdict out — and is what the
// unit tests exercise. The `check…` functions gather the numbers from the
// modules that already keep them (lib/playmarks.js, telemetry.js, the
// watchdog's samples, lib/signals.js, the download queue) and phrase the
// result. Nothing here starts a sampler of its own.
"use strict";
const path = require("path");
const { fmtAge, fmtMs, plural, median, pct, dayKey, pressFor } = require("./util");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DAYS_KEPT = 21;

const rate = (a, b) => (b > 0 ? a / b : 0);
const pc = (r) => `${Math.round(r * 100)}%`;

// ------------------------------------------------------------ playback

// today: playmarks.summarize() over 24 h, plus watchHours.
// base:  earlier days' saved numbers [{ plays, started, startFailures, stalls, errors, ttffP50, watchSec }]
// Findings when a number is well outside ITS OWN recent baseline (or, with no
// baseline yet, outside a generous absolute line), or one title is most of it.
const judgePlayback = (today, base = [], nameOf = (id) => id) => {
  const findings = [];
  const days = base.filter((d) => d && d.plays >= 5);
  const have = days.length >= 3;
  const sum = (k) => days.reduce((n, d) => n + (d[k] || 0), 0);
  const bFail = have ? rate(sum("startFailures"), sum("plays")) : 0.05;
  const bErr = have ? rate(sum("errors"), sum("plays")) : 0.05;
  const bStall = have ? rate(sum("stalls"), sum("watchSec") / 3600) : 1;
  const bTtff = have ? median(days.map((d) => d.ttffP50).filter((v) => v > 0)) : null;
  const versus = (v) => (have ? ` (usual: ${v})` : " (no baseline yet)");

  const failRate = rate(today.startFailures, today.plays);
  if (today.plays >= 5 && today.startFailures >= 3 && failRate >= Math.max(0.25, 2 * bFail + 0.1)) {
    findings.push({ level: "warn", title: "Films are failing to start", text: `${today.startFailures} of the last ${today.plays} plays never showed a first frame — people pressed Play and got nothing.`, evidence: `${pc(failRate)} failed to start${versus(pc(bFail))}` });
  }
  const p50 = today.ttff && today.ttff.p50;
  if (today.started >= 5 && p50 != null && p50 >= (bTtff ? Math.max(4000, 2 * bTtff) : 8000)) {
    const slowest = Object.entries(today.byPath || {}).filter(([, v]) => v.n >= 2).sort((a, b) => b[1].p50 - a[1].p50)[0];
    findings.push({ level: "warn", title: "Films are slow to start", text: `Half of all plays now take ${fmtMs(p50)} or more to show a picture${slowest ? `; the slowest path is “${slowest[0]}” at ${fmtMs(slowest[1].p50)}` : ""}.`, evidence: `first frame: ${fmtMs(p50)} median, ${fmtMs(today.ttff.p90)} p90${versus(bTtff ? fmtMs(bTtff) : "–")}` });
  }
  const hours = (today.watchSec || 0) / 3600;
  const stallRate = rate(today.stalls, Math.max(hours, 0.5));
  if (today.stalls >= 5 && stallRate >= Math.max(3, 2 * bStall + 1)) {
    findings.push({ level: "warn", title: "Playback keeps stalling", text: `${today.stalls} stalls in ${hours.toFixed(1)} hours of watching — the picture is freezing more than it should.`, evidence: `${stallRate.toFixed(1)} stalls per hour watched${versus(bStall.toFixed(1))}` });
  }
  const errRate = rate(today.errors, today.plays);
  if (today.errors >= 3 && today.plays >= 3 && errRate >= Math.max(0.2, 2 * bErr + 0.1)) {
    findings.push({ level: "warn", title: "Playback errors", text: `${today.errors} playback errors in the last ${today.plays} plays.`, evidence: `${errRate.toFixed(2)} errors per play${versus(bErr.toFixed(2))}` });
  }
  // one title behind most of it: name it — the file, not the server
  const fails = Object.entries(today.failuresByTitle || {}).sort((a, b) => b[1] - a[1]);
  const total = fails.reduce((n, [, c]) => n + c, 0);
  if (total >= 4 && fails[0][1] / total >= 0.6) {
    findings.push({ level: "warn", title: "One title is behind most failures", text: `“${nameOf(fails[0][0])}” accounts for ${fails[0][1]} of the ${total} playback failures in the last day. The file is the likely cause, not the server.`, evidence: `${pc(fails[0][1] / total)} of all failures`, setting: "Replace the file with another copy.", press: pressFor("jit-forget-changed") });
  }
  // one kind of device behind most of it
  const devs = Object.entries(today.byDevice || {});
  if (devs.length > 1 && total >= 4) {
    const bad = devs.map(([k, v]) => [k, v.startFailures + v.errors]).sort((a, b) => b[1] - a[1])[0];
    const all = devs.reduce((n, [, v]) => n + v.startFailures + v.errors, 0);
    if (all >= 4 && bad[1] / all >= 0.8) findings.push({ level: "info", title: "Mostly one kind of device", text: `${bad[1]} of ${all} failures were on ${bad[0] === "tv" ? "the TV app" : bad[0] === "phone" ? "phones" : "desktop browsers"}.`, evidence: devs.map(([k, v]) => `${k}: ${v.plays} plays, ${v.startFailures + v.errors} failed`).join(" · ") });
  }
  return findings;
};

const PATH_ORDER = ["direct", "jit", "ladder", "transcode", "tv"];
const pathLine = (byPath) =>
  Object.entries(byPath || {})
    .sort((a, b) => (PATH_ORDER.indexOf(a[0]) + 99) % 99 - (PATH_ORDER.indexOf(b[0]) + 99) % 99)
    .map(([k, v]) => `${k} ${fmtMs(v.p50)}/${fmtMs(v.p90)} (${v.n})`)
    .join(" · ");

// Seconds watched by sessions that started inside the window.
const watchSecIn = (sessions, now, windowMs) => {
  let sec = 0;
  for (const s of sessions || []) {
    const at = Date.parse(s.startedAt);
    if (now - at > windowMs) break; // newest first
    sec += s.watchedSec || 0;
  }
  return sec;
};

const baselineDays = (days, today) => Object.entries(days || {}).filter(([k]) => k < today).sort().slice(-14).map(([, v]) => v);
const pruneDays = (days, now) => {
  const cutoff = dayKey(now - DAYS_KEPT * DAY);
  for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
};

const nameOfId = (id) => {
  try {
    const scanner = require("../../media/scanner");
    const it = scanner.findById(id);
    if (it) return it.showTitle ? `${it.showTitle} S${it.season}E${it.episode}` : it.title;
    const e = scanner.resolve(id);
    if (e) return path.basename(e.path);
  } catch {}
  return id;
};

const checkPlayback = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const pm = ctx.playmarks || require("../playmarks");
  const st = ctx.store || require("./store").get();
  const sessions = ctx.sessions || require("../../telemetry").sessions.data;
  const today = pm.summarize(pm.list(), now, DAY);
  today.watchSec = watchSecIn(sessions, now, DAY);
  // today's numbers, saved under today's date: tomorrow they are baseline
  const key = dayKey(now);
  const days = st.data.days;
  const prev = days[key] || {};
  const next = { ...prev, plays: today.plays, started: today.started, startFailures: today.startFailures, stalls: today.stalls, errors: today.errors, ttffP50: today.ttff.p50, watchSec: today.watchSec };
  if (JSON.stringify(prev) !== JSON.stringify(next)) { days[key] = next; pruneDays(days, now); st.save(); }
  if (!today.plays && !today.stalls && !today.errors) return { status: "ok", summary: "nothing has been played in the last day" };
  const findings = judgePlayback(today, baselineDays(days, key), ctx.nameOf || nameOfId);
  const hours = today.watchSec / 3600;
  const bits = [
    `${plural(today.plays, "play")} in 24 h`,
    today.ttff.p50 != null ? `first frame ${fmtMs(today.ttff.p50)} median, ${fmtMs(today.ttff.p90)} p90` : null,
    `${today.startFailures} failed to start`,
    `${rate(today.stalls, Math.max(hours, 0.5)).toFixed(1)} stalls per hour watched`,
    today.errors ? plural(today.errors, "error") : null,
  ].filter(Boolean);
  const devs = Object.entries(today.byDevice).map(([k, v]) => `${k} ${v.plays}`).join(", ");
  return {
    status: findings.some((f) => f.level === "warn") ? "warn" : "ok",
    summary: bits.join(" · "),
    detail: [pathLine(today.byPath) && `By path (median/p90, plays): ${pathLine(today.byPath)}`, devs && `By device: ${devs}`].filter(Boolean).join(" ‖ ") || null,
    findings,
  };
};

// ------------------------------------------------------------ sessions

// recent / base: { ended, abnormal } — sessions that ended in the last day,
// and in the week before it.
const judgeSessions = (recent, base) => {
  const r = rate(recent.abnormal, recent.ended);
  const b = base && base.ended >= 10 ? rate(base.abnormal, base.ended) : 0.05;
  if (recent.abnormal >= 3 && r >= Math.max(0.2, 2 * b + 0.1)) {
    return [{ level: "warn", title: "Viewers are being cut off", text: `${recent.abnormal} of the last ${recent.ended} viewings ended in the middle of the film right after a stall or an error — people gave up, or the player did.`, evidence: `${pc(r)} ended abnormally (usual: ${base && base.ended >= 10 ? pc(b) : "no baseline yet"})`, setting: "The Playback line and Server → Logs (filter: play) say which titles." }];
  }
  return [];
};

const checkSessions = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const telemetry = ctx.telemetry || require("../../telemetry");
  const ring = telemetry.ring || [];
  const last = ring[ring.length - 1] || { watching: 0, clients: 0 };
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  let peak = 0;
  for (let i = ring.length - 1; i >= 0 && ring[i].t >= midnight.getTime(); i--) peak = Math.max(peak, ring[i].watching || 0);
  const recent = { ended: 0, abnormal: 0 };
  const base = { ended: 0, abnormal: 0 };
  for (const s of telemetry.sessions.data) {
    if (s.live || !s.endedAt) continue;
    const age = now - Date.parse(s.endedAt);
    if (age > 8 * DAY) break; // newest first
    const bucket = age <= DAY ? recent : base;
    bucket.ended++;
    if (s.abnormal) bucket.abnormal++;
  }
  const findings = judgeSessions(recent, base);
  return {
    status: findings.length ? "warn" : "ok",
    summary: `${plural(last.watching || 0, "viewer")} now · peak today ${peak} · ${plural(recent.ended, "viewing")} ended in 24 h, ${recent.abnormal} of them abnormally`,
    findings,
  };
};

// ------------------------------------------------------------ transcoding

// x: { refused15, refused24, segSlow, segAll, newDeclined: [names], slots: { active, max }, producers }
const judgeTranscoding = (x) => {
  const findings = [];
  if (x.refused15 >= 5) {
    findings.push({ level: "warn", title: "Viewers are being refused", text: `${x.refused15} requests for a converted stream were refused in the last 15 minutes because every encoder was busy. Those viewers were moved to another quality or told the server is busy.`, evidence: `${x.refused15} in 15 min, ${x.refused24} in 24 h · ${x.slots.active} of ${x.slots.max} encoders in use`, setting: "It clears when a converting viewer stops. If it happens daily, more people are converting at once than this machine can serve." });
  }
  if (x.segAll >= 20 && x.segSlow >= 10 && x.segSlow / x.segAll >= 0.2) {
    findings.push({ level: "warn", title: "Stream pieces are slow to arrive", text: `${x.segSlow} of the last ${x.segAll} pieces of repackaged video took over four seconds to hand to the player. That is what a spinning wheel in the middle of a film is.`, evidence: `${pc(x.segSlow / x.segAll)} slow in 15 min`, setting: "Usually a busy or sleeping disk, or the CPU taken by encoders — see the Process and Disk lines." });
  }
  if (x.newDeclined && x.newDeclined.length) {
    findings.push({ level: "info", title: "Files newly sent down the slow path", text: `${x.newDeclined.slice(0, 5).map((n) => `“${n}”`).join(", ")}${x.newDeclined.length > 5 ? ` and ${x.newDeclined.length - 5} more` : ""} could not be repackaged the fast way since yesterday and now play through the slower stream.`, evidence: `${plural(x.newDeclined.length, "file")} in 24 h`, setting: "A damaged copy does this. Replace the file; the healer retries it by itself once the file has changed.", press: pressFor("jit-forget-changed") });
  }
  return findings;
};

const checkTranscoding = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const config = require("../../config");
  if (!config.ffmpegAvailable && !ctx.force) return { status: "info", summary: "no ffmpeg — nothing is repackaged or converted" };
  const signals = ctx.signals || require("../signals");
  const jit = ctx.jit || require("../../media/jit");
  const remux = ctx.remux || require("../../media/remux");
  const seg = signals.byKey("seg-wait", 15 * MIN, now);
  const declined = jit.declinedList();
  const fresh = declined.filter((d) => now - d.at < DAY && !/\|enc$/.test(d.key));
  const nameOf = ctx.nameOf || nameOfId;
  const x = {
    refused15: signals.count("no-encoder", 15 * MIN, now),
    refused24: signals.count("no-encoder", DAY, now),
    segSlow: (seg.get("slow") || 0) + (seg.get("none") || 0),
    segAll: [...seg.values()].reduce((a, b) => a + b, 0),
    newDeclined: fresh.map((d) => nameOf(d.key.slice(0, 12))),
    slots: remux.encodeLoad(),
    producers: jit.liveCount(),
  };
  const findings = judgeTranscoding(x);
  // a declined file that has since been replaced: forget that ONE entry
  let healed = null;
  try {
    const actions = ctx.actions || require("../adminactions");
    const scanner = require("../../media/scanner");
    const fs = require("fs");
    const stale = actions._internals.staleDeclined(declined, ctx.mtimeOf || ((id) => {
      const e = scanner.resolve(id);
      if (!e) return null;
      try { return Math.floor(fs.statSync(e.path).mtimeMs); } catch { return null; }
    }));
    const done = [];
    for (const s of stale.slice(0, 3)) {
      if (!ctx.repair) break;
      const r = ctx.repair("jit-forget-changed", { subject: s.key, why: `“${nameOf(s.id)}” changed on disk since it was declined` });
      if (r.ran) done.push(`retrying “${nameOf(s.id)}” on the fast path (its file changed)`);
      else if (r.state === "limit") findings.push({ level: "warn", title: "A replaced file is still declined", text: `“${nameOf(s.id)}” was replaced but is still marked unplayable on the fast path.`, did: r.sentence, press: r.press });
    }
    healed = done.join("; ") || null;
  } catch {}
  const segLine = x.segAll ? ` · ${x.segSlow} of ${x.segAll} pieces slow in 15 min` : "";
  return {
    status: findings.some((f) => f.level === "warn") ? "warn" : "ok",
    summary: `${plural(x.producers, "repackager")} running · ${x.slots.active} of ${x.slots.max} encoders in use · ${x.refused24} refused for lack of an encoder in 24 h${segLine} · ${plural(declined.filter((d) => !/\|enc$/.test(d.key)).length, "file")} on the slow path`,
    findings, healed,
  };
};

// ------------------------------------------------------------ downloads

// Jobs (downloads.rawJobs()) -> the numbers for the last `days`.
const downloadNumbers = (jobs, now, days = 7) => {
  const win = days * DAY;
  const t = (v) => Date.parse(v) || 0;
  const out = { done: 0, failed: 0, took: [], raced: 0, secondWon: 0, pending: 0, pendingOld: 0, oldestPendingMs: 0, lastError: null };
  for (const j of jobs || []) {
    if (j.status === "done" && now - t(j.doneAt) <= win) {
      out.done++;
      const from = t(j.approvedAt) || t(j.at);
      if (from && t(j.doneAt) > from) out.took.push(t(j.doneAt) - from);
      if ((j.raceCount || 0) > 0) out.raced++;
      if (j.secondSourceWon) out.secondWon++;
    } else if (j.status === "error" && now - t(j.resolvedAt || j.at) <= win) {
      out.failed++;
      if (!out.lastError && j.error) out.lastError = String(j.error).slice(0, 120);
    } else if (j.status === "pending") {
      out.pending++;
      const age = now - t(j.at);
      if (age > DAY) out.pendingOld++;
      out.oldestPendingMs = Math.max(out.oldestPendingMs, age);
    }
  }
  out.medianMs = median(out.took);
  return out;
};

const judgeDownloads = (n) => {
  const findings = [];
  const all = n.done + n.failed;
  if (n.failed >= 3 && n.failed / all >= 0.4) {
    findings.push({ level: "warn", title: "Many downloads are failing", text: `${n.failed} of the last ${all} downloads failed${n.lastError ? ` — the most recent said: ${n.lastError}` : ""}.`, evidence: `${pc(n.failed / all)} failed over 7 days`, setting: "Downloads tab: the failed ones say why; “Try again” picks another source." });
  }
  if (n.pendingOld > 0) {
    findings.push({ level: "warn", title: "Requests are waiting for you", text: `${plural(n.pendingOld, "download request has", "download requests have")} been waiting more than a day for your approval; the oldest for ${fmtAge(n.oldestPendingMs)}.`, evidence: `${n.pending} waiting in all`, setting: "Downloads tab → Approve or Decline." });
  }
  return findings;
};

const checkDownloadStats = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  if (!ctx.force && !require("../torrentgate").enabled()) return { status: "info", summary: "switched off in config.json (torrents: false)" };
  const jobs = ctx.jobs || require("../../media/downloads").rawJobs();
  const n = downloadNumbers(jobs, now);
  const findings = judgeDownloads(n);
  const all = n.done + n.failed;
  return {
    status: findings.length ? "warn" : "ok",
    summary: all
      ? `7 days: ${n.done} finished, ${n.failed} failed${all ? ` (${pc(n.done / all)} succeeded)` : ""}${n.medianMs ? ` · ${fmtAge(n.medianMs)} median to finish` : ""} · ${n.raced} needed a second source${n.raced ? `, which won ${n.secondWon} time${n.secondWon === 1 ? "" : "s"}` : ""}${n.pending ? ` · ${n.pending} waiting for approval` : ""}`
      : `no downloads finished or failed in 7 days${n.pending ? ` · ${n.pending} waiting for approval` : ""}`,
    findings,
  };
};

// ------------------------------------------------------------ memory and load

// points: [{ t, memMB }] (telemetry's ring). Least-squares slope over the last
// `spanMs`; a leak is a steady climb that would reach `hardMB` within
// `withinH` hours. Needs two hours of samples; a sawtooth (GC, cache drops)
// has a flat slope and says nothing.
const memTrend = (points, hardMB, now, { spanMs = 6 * HOUR, minSpanMs = 2 * HOUR, withinH = 12 } = {}) => {
  const p = (points || []).filter((x) => now - x.t <= spanMs && x.memMB > 0);
  if (p.length < 20 || p[p.length - 1].t - p[0].t < minSpanMs) return { slopeMBh: null, etaH: null, leak: false };
  const n = p.length;
  const t0 = p[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const x of p) { const h = (x.t - t0) / HOUR; sx += h; sy += x.memMB; sxx += h * h; sxy += h * x.memMB; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const third = Math.max(1, Math.floor(n / 3));
  const head = median(p.slice(0, third).map((x) => x.memMB));
  const tail = median(p.slice(-third).map((x) => x.memMB));
  const nowMB = p[n - 1].memMB;
  const etaH = slope > 0 ? (hardMB - nowMB) / slope : null;
  const leak = slope >= 10 && tail - head >= 40 && etaH != null && etaH <= withinH && etaH >= 0;
  return { slopeMBh: Math.round(slope * 10) / 10, etaH: etaH == null ? null : Math.round(etaH * 10) / 10, leak, nowMB, head, tail };
};

const checkMemTrend = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const w = ctx.watchdog || require("../watchdog").status();
  const ring = ctx.ring || require("../../telemetry").ring;
  const hist = ctx.history || require("../watchdog")._internals.history;
  const hardMB = Math.round(w.thresholds.hardRss / 1048576);
  const m = memTrend(ring, hardMB, now);
  const lags = hist.map((h) => h.lagMs);
  const lag95 = pct(lags, 95);
  const ff = hist.map((h) => h.ffmpeg);
  const ffMax = ff.length ? Math.max(...ff) : 0;
  const ffAvg = ff.length ? ff.reduce((a, b) => a + b, 0) / ff.length : 0;
  const findings = [];
  if (m.leak) {
    findings.push({ level: "warn", title: "Memory is climbing steadily", text: `Aurora's memory has been rising by about ${m.slopeMBh} MB an hour and will reach the line where it restarts itself in roughly ${m.etaH} hours. Nothing is wrong yet; a restart at a quiet moment resets it.`, evidence: `${m.head} MB → ${m.tail} MB over the last hours · restart line ${hardMB} MB`, press: pressFor("restart") });
  }
  if (lags.length >= 30 && lag95 != null && lag95 >= w.thresholds.softLagMs) {
    findings.push({ level: "warn", title: "The server has been sluggish for a while", text: `In the last hour Aurora was more than ${fmtMs(lag95)} behind on one check in twenty. Pages and seeks feel slow when that happens.`, evidence: `event-loop lag p95 ${fmtMs(lag95)} over ${lags.length} samples`, press: pressFor("sweep-streams") });
  }
  const slope = m.slopeMBh == null ? "not enough history for a trend yet" : `${m.slopeMBh >= 0 ? "+" : ""}${m.slopeMBh} MB/h over the last hours`;
  return {
    status: findings.length ? "warn" : "ok",
    summary: `memory ${slope} · lag p95 ${lag95 == null ? "–" : fmtMs(lag95)} in the last hour · ffmpeg ${ffAvg.toFixed(1)} on average, ${ffMax} at most`,
    findings,
  };
};

// ------------------------------------------------------------ stuck helpers

// helpers: [{ kind, name, startedAt, idleMs }] from jit.helpers() / remux.helpers().
// The idle reapers stop a converter 2½ minutes after its last reader; one
// still alive long after that has been left behind.
const stuckHelpers = (helpers, now, { idleMs = 15 * MIN, oldMs = 6 * HOUR } = {}) =>
  (helpers || []).filter((h) => h.idleMs >= idleMs || (h.startedAt && now - h.startedAt >= oldMs && h.idleMs >= 5 * MIN));

const checkHelpers = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  let helpers = ctx.helpers;
  if (!helpers) {
    helpers = [];
    try { helpers.push(...require("../../media/jit").helpers(now)); } catch {}
    try { helpers.push(...require("../../media/remux").helpers(now)); } catch {}
  }
  const stuck = stuckHelpers(helpers, now);
  const findings = [];
  let healed = null;
  if (stuck.length) {
    const oldest = stuck.reduce((m, h) => Math.max(m, h.idleMs), 0);
    const f = { level: "warn", title: "Converters left running", text: `${plural(stuck.length, "ffmpeg process has", "ffmpeg processes have")} been running with nobody watching — the longest for ${fmtAge(oldest)}. They use CPU and hold an encoder slot.`, evidence: stuck.slice(0, 4).map((h) => `${h.kind} ${h.name} idle ${fmtAge(h.idleMs)}`).join(" · ") };
    if (ctx.repair) {
      const r = ctx.repair("sweep-streams", { subject: "stuck helpers", why: `${plural(stuck.length, "converter")} running with no viewer for ${fmtAge(oldest)}` });
      f.did = r.sentence;
      if (r.ran) healed = "stopped converters nobody was watching";
      else f.press = r.press;
    } else f.press = pressFor("sweep-streams");
    findings.push(f);
  }
  // a download the engine is working on that no job owns
  let orphans = ctx.orphanDownloads;
  if (orphans == null && ctx.slowly) {
    orphans = await ctx.slowly("orphan-downloads", async () => {
      try {
        if (!require("../torrentgate").enabled()) return 0;
        const aria2 = require("../../media/aria2");
        if (!aria2.available() || !aria2.running()) return 0;
        const owned = require("../../media/downloads").liveInfoHashes();
        const active = await Promise.race([aria2.activeDownloads(), new Promise((r) => setTimeout(() => r([]), 4000))]);
        return (active || []).filter((d) => d.infoHash && !owned.has(String(d.infoHash).toLowerCase())).length;
      } catch { return 0; }
    });
  }
  if (orphans == null) orphans = 0;
  if (orphans > 0) findings.push({ level: "warn", title: "The download engine has work nobody asked for", text: `The download engine is busy with ${plural(orphans, "download")} that no job in the queue owns. Their staging folders are purged by the Staging check after an hour.`, evidence: `${orphans} unowned`, setting: "If they stay: Server → Actions → Restart Aurora." });
  return {
    status: findings.length ? "warn" : "ok",
    summary: helpers.length ? `${plural(helpers.length, "converter")} running, ${stuck.length ? `${stuck.length} with nobody watching` : "all with a viewer"}` : "no helper processes running",
    findings, healed,
  };
};

module.exports = {
  checkPlayback, checkSessions, checkTranscoding, checkDownloadStats, checkMemTrend, checkHelpers,
  _internals: { judgePlayback, judgeSessions, judgeTranscoding, downloadNumbers, judgeDownloads, memTrend, stuckHelpers, watchSecIn, baselineDays, pruneDays, pathLine },
};

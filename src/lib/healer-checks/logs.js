// Understanding the log, instead of counting it. Four checks share one pass
// over the warning and error lines (read incrementally from lib/logbuffer.js,
// never the whole buffer twice):
//
//   errors     the KNOWN problems (signatures.js): what each means, how many,
//              and what to press. Also the counted ones that leave no line.
//   newerrors  a kind of error never seen before — reported ONCE, the first
//              time it repeats; afterwards it is "seen" and only counted.
//   offenders  the same file or title failing again and again: named.
//   errtrend   errors this hour against what is usual for this hour of day.
//
// Everything that decides is a pure function (lines / counts in, verdict
// out) and is exported for the tests; the check functions at the bottom only
// gather and phrase.
"use strict";
const path = require("path");
const { normalizeMessage, topMessages, plural, hourKey, pressFor, median } = require("./util");
const sigs = require("./signatures");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WINDOW_MS = 15 * MIN; // "now", for the known problems
const KEEP_MS = HOUR; // lines kept in memory for the offenders check
const NEW_REPEATS = 3; // an unknown error is reported when it has repeated this often in the window
const FP_TTL_MS = 28 * DAY; // a fingerprint not seen for four weeks is forgotten (and would be "new" again)
const FP_MAX = 400;
const HOURS_KEPT = 14 * 24;
const NEW_SHOWN_MS = DAY; // a new error stays listed for a day
const NEW_WARN_MS = HOUR; // …and colours the check for its first hour

// ------------------------------------------------------------ pure parts

// Which file or title a failing line is about: [pattern, kind of subject, what was being done].
const SUBJECTS = [
  [/^\[jit\] producer exited \d+ \(([0-9a-f]{12})-/, "id", "converting"], // media/jit.js
  [/^\[jit\] ([0-9a-f]{12})-\d+[^:]*: /, "id", "converting"], // media/jit.js failJob
  [/^Remux failed for (.+?):(?:\s|$)/, "path", "converting"], // media/remux.js
  [/^ffmpeg failed extracting track \d+ from (.+?):(?:\s|$)/, "path", "reading subtitles"], // media/subtitles.js
  [/^\[offline\] failed ([0-9a-f]{12})\b/, "id", "making a phone copy"], // media/offline.js
  [/^\[preconvert\] ([0-9a-f]{12}): /, "id", "making a play-ready copy"], // media/preconvert.js
  [/^Auto-OCR failed for (.+?):(?:\s|$)/, "name", "reading picture subtitles"], // media/ocr.js
  [/^\[intro\] (.+? S\d+E\d+): /, "name", "finding the intro"], // media/introdetect.js
];
const subjectOf = (msg) => {
  const text = String(msg || "");
  for (const [re, kind, doing] of SUBJECTS) {
    const m = re.exec(text);
    if (m) return { kind, value: m[1], doing };
  }
  return null;
};

// One raw log row -> what the checks need. Info lines are not kept.
const digest = (row) => {
  if (!row || (row.level !== "warn" && row.level !== "error")) return null;
  const sig = sigs.classify(row.msg);
  return { t: row.t, level: row.level, sig: sig ? sig.id : null, quiet: !!sig && sig.level === "quiet", fp: sig ? null : normalizeMessage(row.msg), subj: subjectOf(row.msg), msg: String(row.msg).split(/\r?\n/)[0].slice(0, 220) };
};

// The known problems in a window of digested lines: one entry per signature
// that reached its `min`, worst first.
const knownFindings = (events, now, windowMs = WINDOW_MS) => {
  const tally = new Map();
  for (const e of events) {
    if (!e.sig || e.quiet || now - e.t > windowMs) continue;
    const cur = tally.get(e.sig) || { n: 0, sample: e.msg, last: 0 };
    cur.n++;
    if (e.t >= cur.last) { cur.last = e.t; cur.sample = e.msg; }
    tally.set(e.sig, cur);
  }
  const out = [];
  for (const [id, c] of tally) {
    const sig = sigs.byId.get(id);
    if (!sig || c.n < (sig.min || 1)) continue;
    out.push({ sig, n: c.n, sample: c.sample });
  }
  const rank = { fail: 0, warn: 1 };
  return out.sort((a, b) => rank[a.sig.level] - rank[b.sig.level] || b.n - a.n);
};

// Unknown errors. `fps` is the persisted table (mutated); `fresh` the lines
// digested since the last round; `events` everything in memory.
// Returns the fingerprints reported for the first time by THIS call.
const noteFingerprints = (fps, fresh, events, now, { repeats = NEW_REPEATS, windowMs = WINDOW_MS } = {}) => {
  for (const e of fresh) {
    if (!e.fp) continue;
    const cur = fps[e.fp] || (fps[e.fp] = { first: e.t, last: e.t, n: 0, sample: e.msg, reported: 0 });
    cur.n++;
    cur.last = Math.max(cur.last || 0, e.t);
  }
  const inWindow = new Map();
  for (const e of events) if (e.fp && now - e.t <= windowMs) inWindow.set(e.fp, (inWindow.get(e.fp) || 0) + 1);
  const news = [];
  for (const [fp, n] of inWindow) {
    const cur = fps[fp];
    if (!cur || cur.reported || n < repeats) continue;
    cur.reported = now;
    cur.countAtReport = n;
    news.push({ fp, n, sample: cur.sample });
  }
  return news;
};

// Forget fingerprints not seen for weeks; keep the table small.
const expireFingerprints = (fps, now, { ttlMs = FP_TTL_MS, max = FP_MAX } = {}) => {
  let dropped = 0;
  for (const [fp, v] of Object.entries(fps)) if (now - (v.last || v.first || 0) > ttlMs) { delete fps[fp]; dropped++; }
  const keys = Object.keys(fps);
  if (keys.length > max) {
    keys.sort((a, b) => (fps[a].last || 0) - (fps[b].last || 0));
    for (const k of keys.slice(0, keys.length - max)) { delete fps[k]; dropped++; }
  }
  return dropped;
};

// Repeat offenders. `events`: digested log lines; `playFailures`: { id: n }
// from the play marks; `nameOf(kind, value)`: a file or title name, or null.
// One entry per subject that failed `min` times or more, worst first.
const offenders = (events, playFailures, nameOf, now, { windowMs = KEEP_MS, min = 3 } = {}) => {
  const by = new Map();
  const add = (key, name, doing, n) => {
    const cur = by.get(key) || { name, n: 0, doing: {} };
    cur.n += n;
    cur.doing[doing] = (cur.doing[doing] || 0) + n;
    by.set(key, cur);
  };
  for (const e of events) {
    if (!e.subj || now - e.t > windowMs) continue;
    const name = nameOf(e.subj.kind, e.subj.value) || (e.subj.kind === "path" ? path.basename(e.subj.value) : e.subj.value);
    add(name, name, e.subj.doing, 1);
  }
  for (const [id, n] of Object.entries(playFailures || {})) {
    const name = nameOf("id", id) || id;
    add(name, name, "playing", n);
  }
  return [...by.values()]
    .filter((o) => o.n >= min)
    .sort((a, b) => b.n - a.n)
    .map((o) => ({ name: o.name, n: o.n, doing: Object.entries(o.doing).sort((a, b) => b[1] - a[1]).map(([d, c]) => `${d} ×${c}`).join(", ") }));
};

// Is this hour's count a spike? `hours` is { "YYYY-MM-DDTHH": n } (local
// time). The baseline is the same hour of day on earlier days; with fewer
// than three such days, every earlier hour on record; with less than half a
// day of history there is no baseline and nothing is called a spike.
//   spike = count >= max(floor, 3 × usual + 5)
const spike = (hours, now, { floor = 10 } = {}) => {
  const key = hourKey(now);
  const count = hours[key] || 0;
  const hh = key.slice(-2);
  const earlier = Object.keys(hours).filter((k) => k < key);
  const same = earlier.filter((k) => k.slice(-2) === hh).map((k) => hours[k]);
  let basis = "this hour on earlier days";
  let sample = same;
  // the store only has hours in which something happened; a missing hour is a zero
  const firstDay = earlier.sort()[0];
  const daysOnRecord = firstDay ? Math.floor((now - new Date(`${firstDay.slice(0, 10)}T00:00:00`).getTime()) / DAY) : 0;
  if (daysOnRecord >= 3) {
    sample = same.concat(Array(Math.max(0, daysOnRecord - same.length)).fill(0));
  } else {
    const hoursOnRecord = firstDay ? Math.floor((now - new Date(`${firstDay.slice(0, 13)}:00:00`).getTime()) / HOUR) : 0;
    if (hoursOnRecord < 12) return { count, usual: null, spike: false, basis: "not enough history yet" };
    basis = "an ordinary hour so far";
    sample = earlier.map((k) => hours[k]).concat(Array(Math.max(0, hoursOnRecord - earlier.length)).fill(0));
  }
  const usual = median(sample) || 0;
  return { count, usual, spike: count >= Math.max(floor, 3 * usual + 5), basis };
};

const pruneHours = (hours, now, kept = HOURS_KEPT) => {
  const cutoff = hourKey(now - kept * HOUR);
  for (const k of Object.keys(hours)) if (k < cutoff) delete hours[k];
};

// ------------------------------------------------------------ the pass

const live = { cursor: 0, events: [], fresh: [], roundAt: 0, news: [] };

// Read what is new in the log buffer, once per round (the four checks of a
// round share it). `o`: { logbuffer, store, now } — seams for the tests.
const pass = (o = {}) => {
  const now = o.now || Date.now();
  if (!o.force && live.roundAt && now - live.roundAt < 5000) return live;
  const logbuffer = o.logbuffer || require("../logbuffer");
  const st = o.store || require("./store").get();
  const rows = logbuffer.read({ level: "warn", sinceId: live.cursor, limit: 1500 }); // newest first
  if (rows.length) live.cursor = Math.max(live.cursor, rows[0].id);
  const fresh = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = digest(rows[i]);
    if (e) fresh.push(e);
  }
  live.events.push(...fresh);
  let drop = 0;
  while (drop < live.events.length && (now - live.events[drop].t > KEEP_MS || live.events.length - drop > 3000)) drop++;
  if (drop) live.events.splice(0, drop);
  // per-hour totals of the lines that are problems (not the routine ones)
  const hours = st.data.errHours;
  for (const e of fresh) if (!e.quiet) hours[hourKey(e.t)] = (hours[hourKey(e.t)] || 0) + 1;
  pruneHours(hours, now);
  live.news = noteFingerprints(st.data.fingerprints, fresh, live.events, now);
  expireFingerprints(st.data.fingerprints, now);
  if (fresh.length) st.save();
  live.fresh = fresh;
  live.roundAt = now;
  return live;
};

// ------------------------------------------------------------ the checks

const LEVEL_STATUS = { fail: "fail", warn: "warn" };

// Known problems. `ctx.repair(name, { subject, why })` is the healer's hand.
const checkErrors = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const p = pass(ctx);
  const recent = p.events.filter((e) => now - e.t <= WINDOW_MS && !e.quiet);
  const errors = recent.filter((e) => e.level === "error").length;
  const warns = recent.length - errors;
  const known = knownFindings(p.events, now);
  let counted = [];
  try { counted = sigs.signalHits(ctx.byKey || ((kind, ms) => require("../signals").byKey(kind, ms, now))); } catch {}
  const findings = [];
  let status = "ok";
  const raise = (lvl) => { if (lvl === "fail" || (lvl === "warn" && status === "ok")) status = lvl; };
  for (const k of known) {
    const f = { level: k.sig.level, title: k.sig.title, text: sigs.sentence(k.sig, k), evidence: `${plural(k.n, "line")} in 15 min — last: ${k.sample}` };
    if (k.sig.repair && ctx.repair) {
      const r = ctx.repair(k.sig.repair, { subject: k.sig.id, why: `the log says: ${k.sig.title.toLowerCase()}` });
      f.did = r.sentence;
      if (r.state === "limit" || r.state === "off" || r.state === "refused") f.press = r.press;
    } else if (k.sig.press) f.press = pressFor(k.sig.press);
    if (k.sig.setting) f.setting = k.sig.setting;
    findings.push(f);
    raise(LEVEL_STATUS[k.sig.level]);
  }
  for (const h of counted) {
    const f = { level: h.sig.level, title: h.sig.title, text: sigs.sentence(h.sig, h), evidence: `counted ${h.n}${h.keys && h.keys.length && !h.sig.signal.perKey ? ` (${h.keys.slice(0, 4).join(", ")})` : ""}` };
    if (h.sig.press) f.press = pressFor(h.sig.press);
    if (h.sig.setting) f.setting = h.sig.setting;
    findings.push(f);
    raise(LEVEL_STATUS[h.sig.level]);
  }
  const n = findings.length;
  const summary = `${plural(errors, "error")}, ${plural(warns, "warning")} in the last 15 min` + (n ? ` · ${plural(n, "known problem")}` : " · nothing Aurora recognises as a problem");
  // lines that are neither known nor yet reported as new still deserve their old one-line mention
  const rest = recent.filter((e) => !e.sig);
  const top = n ? [] : topMessages(rest, 3);
  return { status, summary, detail: top.length ? "Most repeated: " + top.map((t) => `${t.n}× ${t.sample}`).join(" ‖ ") : null, findings };
};

const checkNewErrors = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const p = pass(ctx);
  const st = ctx.store || require("./store").get();
  const fps = st.data.fingerprints;
  // a new kind of error: say it once in the event list, and (if allowed) ask for an explanation, once
  for (const nw of p.news) {
    if (ctx.note) ctx.note("new error", `${nw.n}× ${nw.sample}`);
    const explain = ctx.explain || require("./ai").explain;
    Promise.resolve(explain(nw.fp, { store: st, now })).then((a) => {
      if (a && fps[nw.fp]) { fps[nw.fp].ai = { text: a.text, action: a.action, at: Date.now() }; st.save(); }
    }).catch(() => {});
  }
  p.news = [];
  const all = Object.entries(fps);
  const shown = all.filter(([, v]) => v.reported && now - v.reported < NEW_SHOWN_MS).sort((a, b) => b[1].reported - a[1].reported);
  const hot = shown.filter(([, v]) => now - v.reported < NEW_WARN_MS);
  const findings = shown.slice(0, 6).map(([, v]) => {
    const f = {
      level: now - v.reported < NEW_WARN_MS ? "warn" : "info",
      title: "Never seen before",
      text: v.sample,
      evidence: `${plural(v.countAtReport || NEW_REPEATS, "time")} in 15 min when first noticed, ${v.n} in all`,
    };
    if (v.ai && v.ai.text) {
      f.ai = v.ai.text; // a model's guess — displayed, never acted on
      if (v.ai.action) f.press = pressFor(v.ai.action);
    }
    return f;
  });
  return {
    status: hot.length ? "warn" : "ok",
    summary: shown.length
      ? `${plural(shown.length, "new kind")} of error in the last day · ${plural(all.length, "kind")} on record`
      : `no new kind of error · ${plural(all.length, "kind")} seen before and only counted`,
    detail: shown.length ? "Each is reported once, the first time it repeats; after that it is only counted. Server → Logs has the full lines." : null,
    findings,
  };
};

const checkOffenders = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const p = pass(ctx);
  let playFailures = {};
  try {
    const pm = ctx.playmarks || require("../playmarks");
    playFailures = pm.summarize(pm.list(), now, 6 * HOUR).failuresByTitle;
  } catch {}
  const nameOf = ctx.nameOf || ((kind, value) => {
    try {
      if (kind === "path") return path.basename(value);
      if (kind !== "id") return value;
      const scanner = require("../../media/scanner");
      const e = scanner.resolve(value);
      if (e && e.path) return path.basename(e.path);
      const it = scanner.findById(value);
      return it ? it.showTitle ? `${it.showTitle} S${it.season}E${it.episode}` : it.title : null;
    } catch { return null; }
  });
  const list = offenders(p.events, playFailures, nameOf, now);
  if (!list.length) return { status: "ok", summary: "no file or title keeps failing" };
  return {
    status: "warn",
    summary: `${plural(list.length, "file keeps", "files keep")} failing: ${list.slice(0, 3).map((o) => `“${o.name}”`).join(", ")}`,
    findings: list.slice(0, 6).map((o) => ({
      level: "warn", title: o.name,
      text: `“${o.name}” has failed ${o.n} times. When one file fails again and again the file is usually the problem, not the server.`,
      evidence: o.doing,
      setting: "Replace the file with another copy (Downloads → request it again, or copy a good one into the library).",
      press: pressFor("jit-forget-changed"),
    })),
  };
};

const checkErrorTrend = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  pass(ctx);
  const st = ctx.store || require("./store").get();
  const s = spike(st.data.errHours, now);
  const summary = s.usual == null
    ? `${plural(s.count, "problem line")} this hour · ${s.basis}`
    : `${plural(s.count, "problem line")} this hour · usual: ${s.usual} (${s.basis})`;
  if (!s.spike) return { status: "ok", summary };
  return {
    status: "warn", summary,
    findings: [{ level: "warn", title: "More errors than usual", text: `The log has ${s.count} warnings and errors this hour; ${s.usual} is usual. Something changed in the last hour — the “Errors in the log” line above says what kind.`, evidence: `${s.count} now against ${s.usual} (${s.basis})`, setting: "Server → Logs, filtered to warnings." }],
  };
};

const _reset = () => { live.cursor = 0; live.events = []; live.fresh = []; live.roundAt = 0; live.news = []; };

module.exports = {
  checkErrors, checkNewErrors, checkOffenders, checkErrorTrend,
  _internals: { digest, subjectOf, knownFindings, noteFingerprints, expireFingerprints, offenders, spike, pruneHours, pass, live, _reset, WINDOW_MS, NEW_REPEATS, FP_TTL_MS, FP_MAX },
};

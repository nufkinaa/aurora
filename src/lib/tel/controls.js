// Which controls get used: counts per control, per screen, per app, per day.
//
// A client counts presses in memory and sends the totals when it is idle —
// "detail.play was pressed twice on /movie/:id with the remote" — never one
// event per press and never WHAT was played. The control ids come from one
// fixed list (lib/tel/vocab.js CONTROLS); an id that is not on it is dropped.
//
// Kept: 30 days of per-day tallies. Per day and app:
//   sessions            how many sessions sent anything
//   c[control]          { n: presses, s: sessions that used it, by: { screen: n }, in: { input: n } }
// Bounded by the vocabulary itself (a few hundred ids × a dozen screens).
"use strict";
const fs = require("fs");
const path = require("path");
const { CONTROLS, INPUTS, SCREEN_RE } = require("./vocab");

const DAY = 24 * 3600 * 1000;
const KEEP_DAYS = 30;
const MAX_PER_BATCH = 80;
const MAX_SCREENS_PER_CONTROL = 16;
const MAX_PRESSES_PER_ENTRY = 2000;
const SAVE_EVERY_MS = 60 * 1000;

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

let days = {}; // day -> { web: { sessions, c: {} }, tv: { … } }
let file = null;
let saveTimer = null;
let dirty = false;

const appliesTo = (id, app) => {
  const where = CONTROLS[id];
  return !!where && where.includes(app === "tv" ? "t" : "w");
};

// One batch's counts: [[screen, control, input, presses, firstInSession?], …].
// `newSession` is the client saying "this is my first batch of this session".
const record = (list, app, newSession, now = Date.now()) => {
  app = app === "tv" ? "tv" : "web";
  const day = (days[dayOf(now)] = days[dayOf(now)] || {});
  const a = (day[app] = day[app] || { sessions: 0, c: {} });
  let kept = 0;
  if (newSession) { a.sessions++; dirty = true; }
  if (Array.isArray(list)) {
    for (const e of list.slice(0, MAX_PER_BATCH)) {
      if (!Array.isArray(e)) continue;
      const [screen, id, input, count, first] = e;
      if (typeof id !== "string" || !appliesTo(id, app)) continue;
      let n = Math.floor(Number(count));
      if (!Number.isFinite(n) || n < 1) continue;
      n = Math.min(n, MAX_PRESSES_PER_ENTRY);
      const c = (a.c[id] = a.c[id] || { n: 0, s: 0, by: {}, in: {} });
      c.n += n;
      if (first) c.s++;
      let scr = typeof screen === "string" && SCREEN_RE.test(screen) ? screen : "?";
      if (!(scr in c.by) && Object.keys(c.by).length >= MAX_SCREENS_PER_CONTROL) scr = "other";
      c.by[scr] = (c.by[scr] || 0) + n;
      const inp = INPUTS.has(input) ? input : "other";
      c.in[inp] = (c.in[inp] || 0) + n;
      kept++;
    }
  }
  if (kept || newSession) { dirty = true; prune(now); schedule(); }
  return kept;
};

const prune = (now = Date.now()) => {
  const min = dayOf(now - KEEP_DAYS * DAY);
  for (const d of Object.keys(days)) if (d < min) { delete days[d]; dirty = true; }
};

// ---------- reading ----------
// The ranked list for one app over the last `span` days: every control with
// its presses, the share of sessions that used it, where and how — and the
// ones on the list that nobody used at all.
const rank = (app, span = KEEP_DAYS, now = Date.now()) => {
  const min = dayOf(now - span * DAY);
  let sessions = 0;
  const tot = {};
  for (const [d, v] of Object.entries(days)) {
    if (d < min || !v[app]) continue;
    sessions += v[app].sessions;
    for (const [id, c] of Object.entries(v[app].c)) {
      const t = (tot[id] = tot[id] || { id, n: 0, s: 0, by: {}, in: {} });
      t.n += c.n;
      t.s += c.s;
      for (const [k, n] of Object.entries(c.by)) t.by[k] = (t.by[k] || 0) + n;
      for (const [k, n] of Object.entries(c.in)) t.in[k] = (t.in[k] || 0) + n;
    }
  }
  const used = Object.values(tot).sort((a, b) => b.n - a.n).map((t) => ({
    ...t,
    // a session that used a control in two batches is still one session; the
    // client marks the first — but never trust it past 100 %
    share: sessions ? Math.min(100, Math.round((100 * t.s) / sessions)) : null,
    feature: t.id.split(".").slice(0, -1).join(".") || t.id,
  }));
  const never = Object.keys(CONTROLS).filter((id) => appliesTo(id, app) && !tot[id]).sort();
  // by screen: the screen's controls with their counts (the "heat list")
  const screens = {};
  for (const t of used) for (const [scr, n] of Object.entries(t.by)) (screens[scr] = screens[scr] || []).push({ id: t.id, n });
  for (const list of Object.values(screens)) list.sort((a, b) => b.n - a.n);
  // by feature: the first parts of the id ("player.subtitles")
  const features = {};
  for (const t of used) features[t.feature] = (features[t.feature] || 0) + t.n;
  return {
    app, days: span, sessions, presses: used.reduce((s, t) => s + t.n, 0), used, never, screens,
    features: Object.entries(features).sort((a, b) => b[1] - a[1]).map(([feature, n]) => ({ feature, n })),
  };
};

// Web against TV, control by control (only ids both apps have).
const compare = (web, tv) => {
  const w = Object.fromEntries(web.used.map((t) => [t.id, t]));
  const t = Object.fromEntries(tv.used.map((x) => [x.id, x]));
  return Object.keys(CONTROLS).filter((id) => CONTROLS[id].includes("w") && CONTROLS[id].includes("t") && (w[id] || t[id])).map((id) => ({
    id, web: w[id] ? w[id].n : 0, webShare: w[id] ? w[id].share : 0, tv: t[id] ? t[id].n : 0, tvShare: t[id] ? t[id].share : 0,
  })).sort((a, b) => b.web + b.tv - (a.web + a.tv));
};

const summary = (now = Date.now()) => {
  const web = rank("web", KEEP_DAYS, now);
  const tv = rank("tv", KEEP_DAYS, now);
  return { web, tv, compare: compare(web, tv), vocabulary: Object.keys(CONTROLS).length };
};

const text = (now = Date.now()) => {
  const s = summary(now);
  const lines = [];
  for (const a of [s.web, s.tv]) {
    lines.push(`Most used — ${a.app} (last ${a.days} days · ${a.sessions} sessions · ${a.presses} presses)`);
    for (const t of a.used.slice(0, 40)) {
      const top = Object.entries(t.by).sort((x, y) => y[1] - x[1])[0];
      lines.push(`  ${t.id}  ${t.n} · ${t.share == null ? "–" : `${t.share}% of sessions`}${top ? ` · mostly on ${top[0]}` : ""} · ${Object.entries(t.in).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    }
    if (!a.used.length) lines.push("  nothing yet");
    if (a.never.length) lines.push(`  never used in ${a.days} days (${a.never.length}): ${a.never.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
};

// ---------- persistence ----------
const schedule = () => {
  if (!file || saveTimer) return;
  saveTimer = setTimeout(saveNow, SAVE_EVERY_MS);
  saveTimer.unref?.();
};
const saveNow = () => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!file || !dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, days }));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn("[telemetry] could not save the control counts:", e && e.message);
  }
};
const boot = (filePath, now = Date.now()) => {
  file = filePath || null;
  days = {};
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && raw.v === 1 && raw.days && typeof raw.days === "object") days = raw.days;
  } catch {}
  prune(now);
};
const _reset = () => { days = {}; file = null; dirty = false; if (saveTimer) clearTimeout(saveTimer); saveTimer = null; };

module.exports = {
  record, rank, compare, summary, text, prune, boot, saveNow, _reset,
  LIMITS: { KEEP_DAYS, MAX_PER_BATCH, MAX_SCREENS_PER_CONTROL, MAX_PRESSES_PER_ENTRY },
  _internals: { get days() { return days; } },
};

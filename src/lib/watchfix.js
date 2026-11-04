// The one-off repair of watch time recorded before 2026-11-04 (docs/watch-time.md).
//
// Until then a viewing's watch time was the wall clock from its first report
// to its last, paused or not — so an episode left paused on a TV for three
// days recorded 71 hours. What really played was never stored, so it cannot
// be recomputed; what CAN be said for sure is what a viewing could not have
// exceeded. Each old viewing (no `acct: 2`) is held to:
//   1. its own wall span (first report → end)
//   2. the media's length + 10 % when the length is known (a whole film once,
//      with a little rewinding), else FIX_NO_DUR_SEC (3 h)
//   3. per person, per title, per day: 1.5 x the media's length in all — the
//      same episode reopened and left paused again and again in one day; the
//      day's viewings are scaled down together
// A viewing that already fits is left exactly as it is. The value before is
// kept on the record (`watchedSecRaw`), and the repair always starts from it,
// so running it twice changes nothing the second time (idempotent).
//
// plan() is pure (test/watch-fix.test.js); scripts/fix-watch-time.js runs it
// by hand (a dry run unless --apply); telemetry.js runs it once at startup
// (VERSION in data/watch-time-fix.json), after a backup of the file.
"use strict";

const watchtime = require("./watchtime");

const VERSION = 1;

const dayOf = (iso) => new Date(iso).toLocaleDateString("sv"); // local YYYY-MM-DD

// sessions: the stored list (not changed). Returns { changes: [{ i, before,
// after, why }], before, after } — totals in seconds.
const plan = (sessions = []) => {
  const out = new Map(); // index -> { after, why }
  const groups = new Map();
  let before = 0;
  sessions.forEach((s, i) => {
    const raw = typeof s.watchedSecRaw === "number" ? s.watchedSecRaw : s.watchedSec || 0;
    before += raw;
    if (s.acct === 2 || s.live) return; // counted the honest way, or still open
    const span = Math.max(0, (Date.parse(s.endedAt || s.updatedAt || s.startedAt) - Date.parse(s.startedAt)) / 1000) || 0;
    const dur = s.duration > 0 ? s.duration : null;
    const cap = dur ? dur * watchtime.FIX_SESSION_FACTOR : watchtime.FIX_NO_DUR_SEC;
    let v = Math.min(raw, span || raw, cap);
    let why = v < raw ? (span && span < raw && span <= cap ? "longer than its own span" : dur ? "longer than the title" : "over 3 h with no known length") : null;
    v = Math.round(v);
    out.set(i, { raw, after: v, why });
    if (dur) {
      const key = `${s.profile || s.ip || "?"}|${s.content}|${dayOf(s.startedAt)}`;
      const g = groups.get(key) || { dur, idx: [] };
      g.dur = Math.max(g.dur, dur);
      g.idx.push(i);
      groups.set(key, g);
    }
  });
  for (const g of groups.values()) {
    const cap = g.dur * watchtime.FIX_DAY_FACTOR;
    const sum = g.idx.reduce((a, i) => a + out.get(i).after, 0);
    if (sum <= cap) continue;
    const k = cap / sum;
    for (const i of g.idx) {
      const o = out.get(i);
      const v = Math.round(o.after * k);
      if (v < o.after) { o.after = v; o.why = o.why || "the same title, the same day, many times over"; }
    }
  }
  const changes = [];
  let after = 0;
  sessions.forEach((s, i) => {
    const o = out.get(i);
    const raw = typeof s.watchedSecRaw === "number" ? s.watchedSecRaw : s.watchedSec || 0;
    if (!o) { after += s.watchedSec || 0; return; }
    after += o.after;
    if (o.after !== (s.watchedSec || 0) || (o.after !== raw && s.wtfix !== VERSION)) changes.push({ i, before: raw, after: o.after, why: o.why || "" });
  });
  return { changes, before: Math.round(before), after: Math.round(after) };
};

// Apply a plan to the list in place. Returns how many records changed.
const apply = (sessions, p = plan(sessions)) => {
  for (const c of p.changes) {
    const s = sessions[c.i];
    if (typeof s.watchedSecRaw !== "number") s.watchedSecRaw = s.watchedSec || 0;
    s.watchedSec = c.after;
    s.wtfix = VERSION;
  }
  return p.changes.length;
};

const fmtH = (sec) => (sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : `${Math.round(sec / 60)} min`);

// A plain-text summary of a plan, for the dry run and the log.
const summary = (sessions, p = plan(sessions), top = 15) => {
  const lines = [];
  lines.push(`${sessions.length} viewings on record; ${p.changes.length} would change.`);
  lines.push(`Watch time on record: ${fmtH(p.before)} → ${fmtH(p.after)} (${fmtH(p.before - p.after)} that never played).`);
  const per = new Map();
  for (const c of p.changes) {
    const s = sessions[c.i];
    const k = s.profile || "(no profile)";
    const x = per.get(k) || { before: 0, after: 0, n: 0 };
    x.before += c.before; x.after += c.after; x.n++;
    per.set(k, x);
  }
  if (per.size) {
    lines.push("", "By person (only the viewings that change):");
    for (const [k, x] of [...per].sort((a, b) => b[1].before - b[1].after - (a[1].before - a[1].after))) lines.push(`  ${k}: ${x.n} ${x.n === 1 ? "viewing" : "viewings"}, ${fmtH(x.before)} → ${fmtH(x.after)}`);
  }
  const biggest = [...p.changes].sort((a, b) => b.before - b.after - (a.before - a.after)).slice(0, top);
  if (biggest.length) {
    lines.push("", `The biggest corrections:`);
    for (const c of biggest) {
      const s = sessions[c.i];
      lines.push(`  ${dayOf(s.startedAt)}  ${s.profile || "—"}  ${s.content}${s.duration ? ` (${fmtH(s.duration)} long)` : ""}: ${fmtH(c.before)} → ${fmtH(c.after)} — ${c.why}`);
    }
  }
  return lines.join("\n");
};

module.exports = { plan, apply, summary, VERSION };

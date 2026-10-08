// The healer's hands: the few Actions it may press by itself, and the
// circuit breaker that stops it pressing them over and over.
//
// A check never runs an action directly. It calls attempt(repair, { subject,
// why }) and gets back what happened, in words for the finding:
//   ran        the action was started — recorded as "by the healer", with why
//   cooldown   it ran for this very subject a short while ago; wait
//   limit      it has run N times today for this subject and the problem is
//              still there: "tried N times, needs you" + the button's name
//   off        automatic repairs are switched off in config.json
//   refused    the Actions list would not let the healer run it (not flagged)
//   busy       another long action is running; nothing was counted
//
// The counters are per (repair, subject) and are kept in data/healer.json, so
// a restart does not hand the healer a fresh allowance.
"use strict";
const { fmtAge, pressFor } = require("./util");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOG_KEPT = 20;

// repair -> the action it presses, how often a day at most, and the gap
// between two runs for the same subject.
const REPAIRS = {
  "sweep-streams": { action: "sweep-streams", perDay: 4, cooldownMs: 30 * MIN },
  "patch-webtorrent": { action: "patch-webtorrent", perDay: 2, cooldownMs: 6 * HOUR },
  rescan: { action: "rescan", perDay: 6, cooldownMs: 10 * MIN },
  "backup-now": { action: "backup-now", perDay: 2, cooldownMs: 6 * HOUR },
  "jit-forget-changed": { action: "jit-forget-changed", perDay: 3, cooldownMs: HOUR },
};

// PURE. `history` is the times this repair ran for this subject.
const breaker = (history, now, { perDay, cooldownMs }) => {
  const today = (history || []).filter((t) => now - t < DAY && t <= now).sort((a, b) => a - b);
  const last = today.length ? today[today.length - 1] : 0;
  if (last && now - last < cooldownMs) return { allow: false, why: "cooldown", tried: today.length, lastAt: last, waitMs: cooldownMs - (now - last) };
  if (today.length >= perDay) return { allow: false, why: "limit", tried: today.length, lastAt: last };
  return { allow: true, tried: today.length, lastAt: last };
};

// config.json "healer": { "autoRepair": false, "off": ["backup-now"] }
const settings = (config) => {
  const h = (config && config.HEALER) || {};
  return { auto: h.autoRepair !== false, off: new Set(Array.isArray(h.off) ? h.off.map(String) : []) };
};

// Seams (tests swap them): the Actions list, the store, config, the clock,
// and where a one-line note of what was done goes (the healer's event list).
const deps = {
  actions: () => require("../adminactions"),
  store: () => require("./store").get(),
  config: () => require("../../config"),
  now: () => Date.now(),
  note: () => {},
};
const _setDeps = (over) => Object.assign(deps, over);

const attempt = (repair, { subject = "", why = "" } = {}) => {
  const spec = REPAIRS[repair];
  const press = spec ? pressFor(spec.action) : null;
  if (!spec) return { ran: false, state: "refused", tried: 0, press: null, sentence: `no such repair (${repair})` };
  const now = deps.now();
  const st = deps.store();
  const d = st.data;
  const key = `${repair}|${subject}`;
  const set = settings(deps.config());
  if (!set.auto || set.off.has(repair)) {
    return { ran: false, state: "off", tried: 0, press, sentence: `automatic repair is switched off in config.json — press ${press.label}` };
  }
  const b = breaker(d.repairs[key], now, spec);
  if (!b.allow) {
    return b.why === "limit"
      ? { ran: false, state: "limit", tried: b.tried, press, sentence: `tried ${b.tried} time${b.tried === 1 ? "" : "s"} today, needs you — ${press.label}` }
      : { ran: false, state: "cooldown", tried: b.tried, press, sentence: `repaired ${fmtAge(now - b.lastAt)} ago (${b.tried} of ${spec.perDay} today) — giving it time before trying again` };
  }
  const entry = { at: now, repair, action: spec.action, subject: String(subject).slice(0, 200), why: String(why).slice(0, 300), runId: null, outcome: "running", said: null };
  const r = deps.actions().start(spec.action, {
    by: "healer", why, subject: subject || null,
    onDone: (run) => {
      entry.outcome = run.status === "ok" ? "ok" : "failed";
      entry.said = String(run.output || "").trim().split(/\r?\n/).filter((l) => l && !/^\(started by the healer/.test(l)).pop() || null;
      if (entry.said) entry.said = entry.said.slice(0, 200);
      st.save();
    },
  });
  if (!r || r.error || !r.run) {
    const busy = r && r.status === 409;
    return { ran: false, state: busy ? "busy" : "refused", tried: b.tried, press, sentence: busy ? "another long action is running; will try again next round" : `not allowed to run it (${(r && r.error) || "refused"}) — press ${press.label}` };
  }
  entry.runId = r.run.id;
  entry.title = r.run.title;
  d.repairs[key] = [...(d.repairs[key] || []).filter((t) => now - t < DAY), now];
  d.repairLog.push(entry);
  while (d.repairLog.length > LOG_KEPT) d.repairLog.shift();
  // counters for subjects nobody has needed for a day are dropped
  for (const k of Object.keys(d.repairs)) if (!d.repairs[k].some((t) => now - t < DAY)) delete d.repairs[k];
  st.save();
  try { deps.note("repair", `ran “${r.run.title}”${subject ? ` for ${subject}` : ""} — ${why}`); } catch {}
  return { ran: true, state: "ran", tried: b.tried + 1, press, runId: r.run.id, sentence: `ran “${r.run.title}” (${b.tried + 1} of ${spec.perDay} today)` };
};

// The last automatic repairs, newest first, for the admin page.
const recent = () => {
  let log = [];
  try { log = deps.store().data.repairLog || []; } catch {}
  // a run still "running" hours later was cut off by a restart: its outcome is not known
  const now = deps.now();
  return log.slice(-LOG_KEPT).reverse().map((e) => ({ ...e, outcome: e.outcome === "running" && now - e.at > 2 * HOUR ? "unknown" : e.outcome }));
};

module.exports = { attempt, recent, breaker, settings, REPAIRS, _setDeps, _deps: deps };

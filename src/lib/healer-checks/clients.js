// Errors on people's devices — the one healer check that looks OUTSIDE the
// server. The site and the TV app report what went wrong on them (lib/tel/
// errors.js keeps the counts); this turns two patterns into one sentence and,
// when it is worth waking somebody, one alert:
//
//   NEW      a kind of error first seen in the last day, not marked known or
//            ignored, that in the last `windowMin` (30) minutes showed up on
//            `newDevices` (2) different devices or `newCount` (20) times.
//   SPIKING  a kind that has been around for more than a day and is at
//            `spikeFactor` (5) times its own usual hour, and at least
//            `spikeMin` (20) in the hour.
//
// The numbers are for a household: five to thirty devices. Two devices with
// the same brand-new error inside half an hour is a release that broke
// something, not a coincidence; one device repeating itself twenty times is
// a loop. (Every TV picture answering 401 for two releases would have been
// both, inside the first evening.)
//
// One alert carries everything that qualified since the last one. Never more
// than one per `cooldownMin` (30) or `maxPerDay` (6); a kind is announced as
// new once, and as spiking at most every six hours. What had to wait is kept
// (in the error book's file) and goes with the next alert. Like every check
// this one sends nothing itself: it hands the healer the finished alert
// (`alert: { title, body }` on its result) and the healer sends it down its
// one alert path. It only ever answers ok or warn and `quiet`, so the
// healer's own "a check failed" alert never doubles this one. Switch: "healer": { "clientErrors":
// { "alert": false } } in config.json, or the admin's Errors view.
"use strict";
const tel = require("../tel");
const { plural } = require("./util");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RESPIKE_MS = 6 * HOUR;
const PENDING_MAX = 20;
const PENDING_KEEP_MS = 6 * HOUR;

// PURE. The fingerprints that qualify right now.
//   rows: [{ fp, app, kind, level, msg, loc, first, state, alerted, recent: { n, devices }, spike: { cur, base, factor }, … }]
const qualifying = (rows, s, now = Date.now()) => {
  const out = [];
  for (const r of rows) {
    if (r.state === "ignored") continue;
    const isNew = now - r.first < DAY;
    if (isNew) {
      if (r.state === "known" || (r.alerted && r.alerted.new)) continue;
      if (r.recent.devices >= s.newDevices || r.recent.n >= s.newCount) out.push({ ...r, why: "new" });
    } else {
      if (r.alerted && r.alerted.spike && now - r.alerted.spike < RESPIKE_MS) continue;
      const sp = r.spike;
      if (sp.base != null && sp.cur >= s.spikeMin && (sp.factor === Infinity || sp.factor >= s.spikeFactor)) out.push({ ...r, why: "spike" });
    }
  }
  // the widest first: devices, then occurrences
  return out.sort((a, b) => b.recent.devices - a.recent.devices || b.recent.n - a.recent.n);
};

// PURE. May an alert go out now? `a` is the kept state { lastAt, day, sentToday }.
const maySend = (a, s, now = Date.now()) => {
  if (!s.alert) return "off";
  if (now - (a.lastAt || 0) < s.cooldownMin * MIN) return "cooldown";
  const day = new Date(now).toISOString().slice(0, 10);
  if (a.day === day && (a.sentToday || 0) >= s.maxPerDay) return "daily-limit";
  return null;
};

const top = (o) => Object.entries(o || {}).sort((x, y) => y[1] - x[1]).map(([k]) => k)[0] || "";
const sentence = (r, s) => {
  const where = top(r.screens);
  const auth = top(r.auth);
  const status = r.ctx && r.ctx.status ? top(r.ctx.status) : "";
  const head = r.why === "new"
    ? `NEW on ${r.app === "tv" ? "TV" : "the site"} ${top(r.versions)}: ${r.msg}`
    : `SPIKING on ${r.app === "tv" ? "TV" : "the site"}: ${r.msg}`;
  const count = r.why === "new"
    ? `${r.recent.n}× on ${plural(r.recent.devices, "device")} in the last ${s.windowMin} min`
    : `${r.spike.cur} this hour, usually ${r.spike.base}`;
  const facts = [count, where && where !== "?" ? `on ${where}` : "", top(r.models) && top(r.models) !== "?" ? top(r.models) : "", auth && auth !== "?" ? `sign-in ${auth}` : "", status ? `status ${status}` : ""].filter(Boolean);
  return `${head}\n  ${facts.join(" · ")}`;
};
const alertBody = (items, s) => {
  const lines = items.slice(0, 5).map((r) => sentence(r, s));
  if (items.length > 5) lines.push(`…and ${items.length - 5} more`);
  lines.push("Admin → Insights → App health → Errors");
  return lines.join("\n").slice(0, 1200);
};

const gather = (s, now) => tel.errors.list().map((f) => ({
  fp: f.fp, app: f.app, kind: f.kind, level: f.level, msg: f.msg, loc: f.loc, first: f.first, last: f.last, n: f.n,
  versions: f.versions, models: f.models, screens: f.screens, auth: f.auth, ctx: f.ctx, alerted: f.alerted || {},
  state: tel.errors.stateOf(f.fp),
  recent: tel.errors.recentOf(f.fp, s.windowMin * MIN, now),
  spike: tel.errors.spikeOf(f, now),
}));

// One round: what qualifies, and the alert that is due (if any). Exported
// for the tests, which hand it their own clock.
const round = (now = Date.now()) => {
  const s = tel.alertSettings();
  const rows = gather(s, now);
  const hits = qualifying(rows, s, now);
  const a = tel.errors.alertState();
  // what qualified earlier and could not go out is still owed
  a.pending = (a.pending || []).filter((p) => now - p.at < PENDING_KEEP_MS);
  for (const h of hits) {
    if (!a.pending.some((p) => p.fp === h.fp && p.why === h.why) && a.pending.length < PENDING_MAX) a.pending.push({ fp: h.fp, why: h.why, at: now, snap: { ...h, alerted: undefined } });
    tel.errors.markAlerted(h.fp, h.why, now); // announced (or queued) once
  }
  let sent = null;
  if (a.pending.length) {
    const blocked = maySend(a, s, now);
    if (!blocked) {
      const items = a.pending.map((p) => p.snap);
      // decided here, sent by the healer (lib/healer.js run → `alert`)
      sent = { title: items.length === 1 ? `Aurora: ${items[0].why === "new" ? "a new error on people's devices" : "an error is spiking on people's devices"}` : `Aurora: ${items.length} problems on people's devices`, body: alertBody(items, s), items: items.length };
      const day = new Date(now).toISOString().slice(0, 10);
      a.sentToday = a.day === day ? (a.sentToday || 0) + 1 : 1;
      a.day = day;
      a.lastAt = now;
      a.pending = [];
    } else if (blocked === "off") a.pending = []; // nobody is to be told: nothing is owed
    tel.errors.touch();
  }
  return { settings: s, rows, hits, sent };
};

const checkClientErrors = async (ctx) => {
  const now = Date.now();
  const r = round(now);
  const open = r.rows.filter((x) => x.state !== "ignored");
  const lastDay = open.filter((x) => now - x.last < DAY);
  const fresh = open.filter((x) => now - x.first < DAY && x.state === "open");
  const lastHour = open.filter((x) => now - x.last < HOUR);
  const findings = [];
  for (const h of r.hits.slice(0, 5)) {
    findings.push({
      level: "warn",
      title: h.why === "new" ? "A new kind of error on people's devices" : "An error on people's devices is spiking",
      text: sentence(h, r.settings).replace(/\n\s*/, " — "),
      evidence: `fingerprint ${h.fp} · ${h.kind}${h.loc ? ` · ${h.loc}` : ""}`,
      did: r.sent ? "one alert" : r.settings.alert ? "queued for the next alert" : "alerts for this are switched off",
      setting: "Admin → Insights → App health → Errors (mark it known or ignore it there)",
    });
  }
  if (r.sent && ctx && ctx.note) ctx.note("client-errors", `alert sent: ${r.sent.items} kind${r.sent.items === 1 ? "" : "s"}`);
  const status = r.hits.length || fresh.some((x) => now - x.first < HOUR) ? "warn" : "ok";
  const summary = !open.length
    ? "no errors reported by devices"
    : `${plural(lastDay.length, "kind")} of error from devices in the last day (${fresh.length} new), ${lastHour.length} in the last hour`;
  return { status, summary, findings, quiet: true, ...(r.sent ? { alert: { title: r.sent.title, body: r.sent.body } } : {}) };
};

module.exports = { checkClientErrors, round, qualifying, maySend, alertBody, sentence, RESPIKE_MS };

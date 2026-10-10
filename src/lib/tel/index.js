// The richer half of the usage stats (docs/analytics.md): error and warning
// reports, timings, and which controls get used. A client sends them in the
// SAME batch as its usage events (POST /api/usage), under `tel`, with a few
// facts about itself beside the old fields:
//
//   { profile, sid, device, look, events,            ← as before (lib/usage.js)
//     iid, app, v, model, os, net, auth, flags,      ← who is reporting (no person)
//     tel: { s: 1, e: [reports], t: [timings], u: [control counts] } }
//
// This file is the gate in front of the three stores: it decides whether a
// batch may be counted at all (the profile's own usage-stats switch, checked
// HERE whatever the client believed), cleans the envelope, holds every
// device to a daily allowance, and hands the parts on.
"use strict";
const path = require("path");
const scrub = require("./scrub");
const errors = require("./errors");
const timings = require("./timings");
const controls = require("./controls");
const { DEVICES, NET_TIERS, AUTH_MODES, FLAG_RE } = require("./vocab");

// What one install may add in a day. A household device that is working
// sends a few dozen of each; the allowance is there for the one that is not.
const PER_DEVICE_DAY = { batches: 3000, errors: 400, timings: 3000, controls: 4000 };
const MAX_DEVICES_TRACKED = 5000;

let dayKey = "";
let spent = new Map(); // iid -> { batches, errors, timings, controls }
const allowance = (iid, now) => {
  const d = new Date(now).toISOString().slice(0, 10);
  if (d !== dayKey) { dayKey = d; spent = new Map(); }
  let s = spent.get(iid);
  if (!s) {
    if (spent.size >= MAX_DEVICES_TRACKED) return null;
    spent.set(iid, (s = { batches: 0, errors: 0, timings: 0, controls: 0 }));
  }
  return s;
};

// ---------- consent ----------
// May this profile's batches be counted? Only a profile that exists and has
// not switched usage stats off. An id the server does not know is refused:
// there is nobody whose choice could be read.
const allowed = (profileId, list) => {
  const id = String(profileId || "");
  if (!id) return false;
  let all = list;
  if (!all) { try { all = require("../../profiles").list(); } catch { return false; } }
  const p = all.find((x) => x.id === id);
  if (!p) return false;
  return !(p.prefs && p.prefs.usageStats === false);
};

// PURE (the profiles, the sign-in mode and the session are handed in): what
// the route does with a batch.
//   "drop"    the profile said no, or nobody can be asked
//   "errors"  no session while sign-in is required: error reports only — a
//             device the wall is refusing is exactly the one worth hearing
//             from, and exactly the one that cannot sign in to say so
//   "all"
const verdict = (body, { profiles, mode, session, admin }) => {
  if (!body || typeof body !== "object") return "drop";
  if (!allowed(body.profile, profiles)) return "drop";
  if (mode === "closed") {
    if (session) return allowed(session.profile.id, profiles) ? "all" : "drop";
    if (!admin) return "errors";
  }
  return "all";
};

// ---------- the envelope ----------
const envelope = (body) => {
  const app = body.app === "tv" || (body.app == null && body.device === "tv" && body.look === "tv") ? "tv" : "web";
  const flags = [];
  if (Array.isArray(body.flags)) for (const f of body.flags.slice(0, 6)) if (typeof f === "string" && FLAG_RE.test(f)) flags.push(f);
  return {
    app,
    v: /^[A-Za-z0-9._-]{1,16}$/.test(String(body.v || "")) ? String(body.v) : "?",
    device: DEVICES.has(body.device) ? body.device : app === "tv" ? "tv" : "desktop",
    model: scrub.label(body.model, 32),
    os: scrub.label(body.os, 24),
    net: NET_TIERS.has(body.net) ? body.net : "",
    auth: AUTH_MODES.has(body.auth) ? body.auth : "",
    flags,
  };
};
const installId = (body) => {
  const iid = String(body.iid || "");
  if (/^[A-Za-z0-9]{8,32}$/.test(iid)) return iid;
  // an older build: its tab/run id stands in, so its errors still count as "a device"
  const sid = String(body.sid || "").replace(/[^a-z0-9]/gi, "").slice(0, 16);
  return sid ? `sid${sid}` : "none";
};

// One batch. `opts.only`: ["e"] keeps the error reports and nothing else
// (a batch that arrived without a session while sign-in is required).
// Returns { errors, timings, controls } kept — all zero when refused.
const record = (body, opts = {}, now = Date.now()) => {
  const out = { errors: 0, timings: 0, controls: 0 };
  if (!body || typeof body !== "object" || !body.tel || typeof body.tel !== "object") return out;
  const env = envelope(body);
  const iid = installId(body);
  const a = allowance(iid, now);
  if (!a || a.batches >= PER_DEVICE_DAY.batches) return out;
  a.batches++;
  errors.noteVersion(env.app, env.v);
  const tel = body.tel;
  const only = opts.only || null;
  if (a.errors < PER_DEVICE_DAY.errors) {
    out.errors = errors.record(tel.e, env, iid, now);
    a.errors += out.errors;
  }
  if (!only && a.timings < PER_DEVICE_DAY.timings) {
    out.timings = timings.record(tel.t, env, now);
    a.timings += out.timings;
  }
  if (!only && a.controls < PER_DEVICE_DAY.controls) {
    out.controls = controls.record(tel.u, env.app, tel.s === 1 || tel.s === true, now);
    a.controls += out.controls;
  }
  return out;
};

// ---------- the alert rules (read by healer-checks/clients.js) ----------
const ALERT_DEFAULTS = {
  alert: true, // false: findings still show in the admin, nothing is sent
  newDevices: 2, // a NEW kind of error on this many devices …
  newCount: 20, // … or this many times …
  windowMin: 30, // … within this many minutes
  spikeFactor: 5, // a KNOWN kind at this many times its own usual hour …
  spikeMin: 20, // … and at least this many in the hour
  cooldownMin: 30, // at most one alert per this long
  maxPerDay: 6, // and this many a day
};
const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : dflt; };
const alertSettings = () => {
  let fromConfig = {};
  let fromAdmin = {};
  try { fromConfig = (require("../../config").HEALER || {}).clientErrors || {}; } catch {}
  try { fromAdmin = require("../settings").data.clientErrorAlerts || {}; } catch {}
  const s = { ...ALERT_DEFAULTS };
  for (const src of [fromConfig, fromAdmin]) {
    if (!src || typeof src !== "object") continue;
    if (typeof src.alert === "boolean") s.alert = src.alert;
    s.newDevices = num(src.newDevices, 1, 1000, s.newDevices);
    s.newCount = num(src.newCount, 1, 100000, s.newCount);
    s.windowMin = num(src.windowMin, 1, 120, s.windowMin);
    s.spikeFactor = num(src.spikeFactor, 2, 1000, s.spikeFactor);
    s.spikeMin = num(src.spikeMin, 1, 100000, s.spikeMin);
    s.cooldownMin = num(src.cooldownMin, 1, 1440, s.cooldownMin);
    s.maxPerDay = num(src.maxPerDay, 1, 100, s.maxPerDay);
  }
  return s;
};
// The admin's own numbers (data/settings.json). Unknown keys are ignored.
const saveAlertSettings = (patch) => {
  const settings = require("../settings");
  const cur = settings.data.clientErrorAlerts && typeof settings.data.clientErrorAlerts === "object" ? settings.data.clientErrorAlerts : {};
  const next = { ...cur };
  for (const k of Object.keys(ALERT_DEFAULTS)) {
    if (!(k in (patch || {}))) continue;
    if (k === "alert") { if (typeof patch.alert === "boolean") next.alert = patch.alert; }
    else if (Number.isFinite(Number(patch[k]))) next[k] = Number(patch[k]);
  }
  settings.data.clientErrorAlerts = next;
  settings.save();
  return alertSettings();
};

// ---------- everything, for the admin ----------
const summary = (q = {}, now = Date.now()) => {
  const a = alertSettings();
  return {
    errors: errors.summary(q, now, { spikeMin: a.spikeMin, spikeFactor: a.spikeFactor }),
    timings: timings.summary({ device: q.device, net: q.net }),
    controls: controls.summary(now),
    alertRules: a,
  };
};
const text = (now = Date.now()) => {
  const a = alertSettings();
  return [errors.text(now, { spikeMin: a.spikeMin, spikeFactor: a.spikeFactor }), "", timings.text(), "", controls.text(now)].join("\n");
};

const boot = (dir) => {
  errors.boot(dir ? path.join(dir, "tel-errors.json") : null);
  timings.boot(dir ? path.join(dir, "tel-timings.json") : null);
  controls.boot(dir ? path.join(dir, "tel-controls.json") : null);
};
const flush = () => { errors.saveNow(); timings.saveNow(); controls.saveNow(); };
const _reset = () => { errors._reset(); timings._reset(); controls._reset(); spent = new Map(); dayKey = ""; };

module.exports = {
  record, allowed, verdict, envelope, installId, summary, text, boot, flush, alertSettings, saveAlertSettings,
  errors, timings, controls, scrub, ALERT_DEFAULTS, PER_DEVICE_DAY, _reset,
};

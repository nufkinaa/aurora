// The TV player's start-up tuning, served to the app (GET /api/tv/tuning).
//
// A few numbers decide how long a film takes to start on a TV, and the right
// values can only be found on the device, on real lines. So they are not
// baked into the APK: the app asks this server once, and what it gets is
// config.json's "tvPlayer" — checked and clamped here, over DEFAULT_PLAYER.
//
// DEFAULT_PLAYER is what the Mi TV measured best (2026-10-17, the device pass:
// thin lines remux -2.7..-4.8 s and resume -1.7..-2.7 s to the first frame, a
// LAN within noise, never an added stall), so a server whose config.json says
// nothing tells every TV these. config.json still wins key by key: a key it
// sets (inside its range) replaces the default; to go back to what the app was
// built with, set its own values (startBufferMs 2000, rebufferMs 8000,
// resumeAtSource false).
//
//   "tvPlayer": {
//     "startBufferMs": 1000,     // film buffered before the first frame is shown
//                                // (ExoPlayer bufferForPlaybackMs; the app's own: 2000)
//     "rebufferMs": 5000,        // …and before playback resumes after a stall
//                                // (bufferForPlaybackAfterRebufferMs; the app's own: 8000)
//     "resumeAtSource": true     // a library file that plays as itself opens AT the
//                                // resume point, instead of opening at 0:00 and seeking
//   }
//
// Anything else in the object is dropped; a value out of range is dropped
// (not clamped to an edge nobody chose). docs/qa/ttff/REPORT.md has the
// measurement plan these exist for.
//
// THE RENDERING SWITCHES ride on the same answer, as `tvRender` — config.json's
// "tvRender" (docs/qa/native-port/DEVICE-PLAN.md). The native lab rebuilt five
// drawing components natively and found a few render fixes; the TV runs each
// one only when told to, so they can be turned on per TV without a new APK.
// Every key is true / false; anything not named is off. A TV keeps what it was
// told for its NEXT launch (they are read once at startup).
//
//   "tvRender": {
//     "recommended": true,        // the set the lab measured best (below)
//     "pool": false,              // …minus one switch
//     "models": {                 // per TV model (the app's Build.MODEL):
//       "MiTV-AFMU0": { "recommended": true }   // these keys win over the ones above
//     }
//   }
//
// The switches: focusable, card, row, hero, rail (native components);
// cardlayer, cull, shadowcache, unstuff, unstuffq, pool (render fixes);
// keyrate, cardtext, ringshare, herotext (the deeper options, docs/qa/native-deep/DEVICE-PLAN.md —
// not in the preset).
// "recommended" = the five components + cardlayer, cull, shadowcache, unstuff,
// pool. Unknown keys and non-boolean values are dropped; no "tvRender", or one
// that names nothing, adds nothing to the answer.
"use strict";

const RANGES = {
  startBufferMs: [250, 5000],
  rebufferMs: [1000, 20000],
};
const FLAGS = ["resumeAtSource"];

// PURE: whatever config.json holds -> what the app is told.
const sanitize = (raw) => {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    const v = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;
    if (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi) out[key] = Math.round(v);
  }
  for (const key of FLAGS) if (Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] === "boolean") out[key] = raw[key];
  // a film must be allowed to start with no more buffered than it resumes with
  if (out.startBufferMs != null && out.rebufferMs != null && out.rebufferMs < out.startBufferMs) delete out.rebufferMs;
  return out;
};

const RENDER_KEYS = [
  "recommended",
  "focusable", "card", "row", "hero", "rail",
  "cardlayer", "cull", "shadowcache", "unstuff", "unstuffq", "pool",
  "keyrate", "cardtext", "ringshare", "herotext",
];

const switchesOf = (raw) => {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of RENDER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] === "boolean") out[key] = raw[key];
  }
  return out;
};

// PURE: config.json's "tvRender" + the asking TV's model -> the switches it is
// told ({} = none). The model's own entry wins key by key over the shared ones.
const renderFor = (raw, model) => {
  const out = switchesOf(raw);
  const models = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.models : null;
  const m = typeof model === "string" ? model.trim().slice(0, 40) : "";
  if (m && models && typeof models === "object" && !Array.isArray(models) && Object.prototype.hasOwnProperty.call(models, m)) {
    Object.assign(out, switchesOf(models[m]));
  }
  return out;
};

// The measured start-up (see the top). Frozen: callers get copies.
const DEFAULT_PLAYER = Object.freeze({ startBufferMs: 1000, rebufferMs: 5000, resumeAtSource: true });

// PURE: config.json's "tvPlayer" -> what the app is told: the defaults, with
// every valid key config.json sets in their place.
const playerFor = (raw) => {
  const out = { ...DEFAULT_PLAYER, ...sanitize(raw) };
  // the same rule as sanitize's: never resume on less than a start needs
  if (out.rebufferMs < out.startBufferMs) delete out.rebufferMs;
  return out;
};

const current = (model) => {
  const cfg = require("../config");
  const out = playerFor(cfg.TV_PLAYER);
  const render = renderFor(cfg.TV_RENDER, model);
  if (Object.keys(render).length) out.tvRender = render;
  return out;
};

module.exports = { sanitize, playerFor, current, renderFor, DEFAULT_PLAYER, RANGES, FLAGS, RENDER_KEYS };

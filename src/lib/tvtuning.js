// The TV player's start-up tuning, served to the app (GET /api/tv/tuning).
//
// A few numbers decide how long a film takes to start on a TV, and the right
// values can only be found on the device, on real lines. So they are not
// baked into the APK: the app asks this server once, and what it gets is
// config.json's "tvPlayer" — checked and clamped here. An empty answer (the
// default) changes nothing: every key left out keeps the behaviour the app
// was built with.
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

const current = () => sanitize(require("../config").TV_PLAYER);

module.exports = { sanitize, current, RANGES, FLAGS };

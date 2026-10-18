// The credits picture's analysis (media/creditscv.js features + estimate) on
// a thread of its own: for a feature's 25-minute tail that is 3,000 samples
// and about half a second of solid CPU on a fast desktop — two on an old
// two-core box — which used to run on the event loop in one piece, once per
// episode (server round, 2026-10-18).
//   workerData: { packed (creditscv pack()), duration } -> postMessage({ est } | { error })
"use strict";
const { parentPort, workerData } = require("worker_threads");
const creditscv = require("./creditscv");

try {
  const feats = creditscv.features(creditscv._internals.unpack(workerData.packed));
  const est = creditscv.estimate(feats, workerData.duration);
  parentPort.postMessage({ est: est || null });
} catch (e) {
  parentPort.postMessage({ error: (e && e.message) || String(e) });
}

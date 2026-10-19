// A device's report of what it can play (media/avcaps.js), and the decision
// it buys (media/playpath.js) — TV round 2026-10-19, "direct play".
//
//   POST /api/caps            { client: "tv"|"web", video, audio, hdr, … }
//                             → { id }   the name to send as ?caps= on the
//                             reads that ask how a title plays
//   GET  /api/caps/:id        the report as it was kept (the device checks
//                             read it; 404 when it is not known)
//   GET  /api/caps/:id/play/:itemId    the decision for one library title,
//                             with every line of `why` (the device checks)
//
// /api/item/:id?caps=<id> and /api/torrents/sources?caps=<id> carry the
// decision as `play` (decisionFor below); without ?caps= they answer exactly
// as before.
"use strict";
const express = require("express");
const avcaps = require("../media/avcaps");
const playpath = require("../media/playpath");

const router = express.Router();

router.post("/api/caps", (req, res) => {
  const kept = avcaps.remember(req.body);
  if (!kept) return res.status(400).json({ error: "not a capability report" });
  res.json({ id: kept.id });
});

router.get("/api/caps/:id", (req, res) => {
  const caps = avcaps.lookup(req.params.id);
  if (!caps) return res.status(404).json({ error: "unknown report" });
  res.json(caps);
});

// The person's sound choice ("Surround sound: Auto / Stereo only"), from the
// profile the read names — what decides passthrough.
const prefsFor = (profileId) => {
  if (!profileId) return {};
  try {
    const p = require("../profiles").list().find((x) => x.id === profileId);
    const prefs = (p && p.prefs) || {};
    return { surround: prefs.surround === "stereo" ? "stereo" : "auto" };
  } catch {
    return {};
  }
};

// One line in the server's log per title and device, at most every ten
// minutes — what the device checks read ("[play] … → direct").
const said = new Map();
const SAY_EVERY_MS = 10 * 60 * 1000;
const say = (key, label, d) => {
  const now = Date.now();
  if (now - (said.get(key) || 0) < SAY_EVERY_MS) return;
  if (said.size > 2000) said.clear();
  said.set(key, now);
  console.log(`[play] ${String(label || "").slice(0, 60)} → ${d.mode}${d.form ? ` (${d.form})` : ""} · ${d.why.join(" · ")}`);
};

/** The decision for `facts` on the device a request names (?caps=), or
 *  null when it names none / one the server does not know. */
const decisionFor = (req, facts, { label = "", key = "", track = null } = {}) => {
  const capsId = req.query && req.query.caps;
  const caps = capsId ? avcaps.lookup(String(capsId)) : null;
  if (!caps || !facts) return null;
  try {
    const d = playpath.decide(facts, caps, { prefs: prefsFor(req.query.profile ? String(req.query.profile) : ""), track });
    if (d && key) say(`${capsId}|${key}`, label, d);
    return d;
  } catch (e) {
    console.warn(`[play] decision failed: ${(e && e.message) || e}`);
    return null;
  }
};

router.get("/api/caps/:id/play/:itemId", (req, res) => {
  const caps = avcaps.lookup(req.params.id);
  if (!caps) return res.status(404).json({ error: "unknown report" });
  const item = require("../media/scanner").findById(req.params.itemId);
  if (!item || !item.videoUrl) return res.status(404).json({ error: "Not found" });
  const facts = playpath.factsOfItem(item);
  res.json({ facts, play: playpath.decide(facts, caps, { prefs: prefsFor(req.query.profile ? String(req.query.profile) : "") }) });
});

router.decisionFor = decisionFor;
router._internals = { prefsFor };
module.exports = router;

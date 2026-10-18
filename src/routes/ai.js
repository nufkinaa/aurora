// AI recommender route. Entirely additive: when no key is configured
// /api/ai/status reports off, the client hides the tab, and nothing else in the
// app changes behaviour.
const express = require("express");
const ai = require("../media/ai");

const router = express.Router();

// Cheap poll the client uses to decide whether the tab exists at all.
router.get("/api/ai/status", (req, res) => {
  res.json({ enabled: ai.enabled() });
});

// A budget per DEVICE. This spends real money, so an accidental loop (or a
// bored household member holding Enter) must not run up a bill. Keyed the
// way lib/ratelimit.js keys a client — the device's session, else its
// address with X-Forwarded-For believed only from a trusted proxy. It was
// req.ip: behind the site's reverse proxy that is the proxy itself, so every
// visitor of nufurora.com shared ONE budget of ten a minute.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 10;
const hits = new Map(); // ip -> number[] timestamps

const overBudget = (ip) => {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  // Keep the map from growing forever on a busy LAN.
  if (hits.size > 200) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  }
  return list.length > MAX_PER_WINDOW;
};

router.post("/api/ai/recommend", async (req, res) => {
  if (!ai.enabled()) return res.status(503).json({ error: "The recommender isn't set up on this server." });
  let who;
  try { who = require("../lib/ratelimit")._internals.clientOf(req).key; } catch { who = String((req.socket && req.socket.remoteAddress) || "?"); }
  if (overBudget(who)) {
    return res.status(429).json({ error: "Easy. Give it a minute before asking again." });
  }
  const { vibe, mix, era, length, fresh } = req.body || {};
  try {
    const result = await ai.recommend(vibe, mix, era, length, { fresh: fresh === true });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    // Never leak a stack to the page; the log has it.
    console.error("[ai] recommend failed:", err && err.message);
    res.status(502).json({ error: "The recommender fell over. Try again shortly." });
  }
});

module.exports = router;

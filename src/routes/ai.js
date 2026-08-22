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

// A crude per-IP budget. This spends real money, so an accidental loop (or a
// bored household member holding Enter) must not run up a bill.
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
  const ip = (req.ip || "").replace("::ffff:", "");
  if (overBudget(ip)) {
    return res.status(429).json({ error: "Easy. Give it a minute before asking again." });
  }
  const { vibe, mix, era, length } = req.body || {};
  try {
    const result = await ai.recommend(vibe, mix, era, length);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    // Never leak a stack to the page; the log has it.
    console.error("[ai] recommend failed:", err && err.message);
    res.status(502).json({ error: "The recommender fell over. Try again shortly." });
  }
});

module.exports = router;

// Usage stats: the app posts small batches (public/js/usage.js), the admin
// reads the aggregate (lib/usage.js). The POST is deliberately forgiving —
// it answers 204 to anything malformed rather than making a client log
// errors about its own telemetry.
const express = require("express");
const usage = require("../lib/usage");
const realtime = require("../realtime");

const router = express.Router();
usage.boot();

router.post("/api/usage", (req, res) => {
  try {
    usage.record(req.body);
  } catch {}
  res.status(204).end();
});

router.get("/api/admin/usage", (req, res) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  res.setHeader("Cache-Control", "no-store");
  res.json({ summary: usage.summary(), text: usage.text() });
});

module.exports = router;

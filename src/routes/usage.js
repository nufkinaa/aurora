// Usage stats: the app posts small batches (public/js/usage.js), the admin
// reads the aggregate (lib/usage.js). The POST is deliberately forgiving —
// it answers 204 to anything malformed rather than making a client log
// errors about its own telemetry.
const express = require("express");
const usage = require("../lib/usage");
const realtime = require("../realtime");
const profiles = require("../profiles");

const router = express.Router();
usage.boot();

// THE OPT-OUT IS ENFORCED HERE, not left to each client: a batch that names a
// profile whose "usage stats" switch is off is dropped whole, whatever sent it
// (the TV app kept a per-box switch of its own for a long time, so a person
// who had opted out on the website was still reported from the TV). The
// answer is the same 204 either way.
const accepts = (body) =>
  !(body && typeof body === "object" && profiles.usageOptedOut(String(body.profile || "")));

router.post("/api/usage", (req, res) => {
  try {
    if (accepts(req.body)) usage.record(req.body);
  } catch {}
  res.status(204).end();
});

router.get("/api/admin/usage", (req, res) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  res.setHeader("Cache-Control", "no-store");
  res.json({ summary: usage.summary(), text: usage.text() });
});

router._internals = { accepts };

module.exports = router;

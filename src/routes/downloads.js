// Download-to-server routes. Viewers create a download request; admins approve
// (or decline/cancel) it. The heavy lifting lives in media/downloads.js.
const express = require("express");
const downloads = require("../media/downloads");
const realtime = require("../realtime");

const router = express.Router();

const adminOnly = (req, res, next) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  next();
};

// Anyone on the LAN can see the queue (so the Discover page can show state).
router.get("/api/downloads", (req, res) => {
  res.json(downloads.list());
});

// Create a download request (pending admin approval).
router.post("/api/downloads", (req, res) => {
  const result = downloads.create(req.body || {});
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// What the engine says about every live download: bytes per selected file,
// speed, connections and seeders. Answers "is this stuck, or just short of
// peers?" without reading logs.
router.get("/api/admin/downloads/stats", adminOnly, async (req, res) => {
  res.json(await downloads.stats());
});

// ---------- admin actions ----------
router.post("/api/admin/downloads/:id/approve", adminOnly, (req, res) => {
  const r = downloads.approve(req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

router.post("/api/admin/downloads/:id/decline", adminOnly, (req, res) => {
  const r = downloads.decline(req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

router.post("/api/admin/downloads/:id/cancel", adminOnly, (req, res) => {
  const r = downloads.cancel(req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

router.delete("/api/admin/downloads/:id", adminOnly, (req, res) => {
  const r = downloads.remove(req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

module.exports = router;

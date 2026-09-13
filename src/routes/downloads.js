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

// Who is asking: the session's profile in closed mode, else the profile id
// the client says it is (open mode trusts that everywhere). The name comes
// along so jobs from before ids were stored still match.
const viewerFor = (req, profileId) => {
  const authz = require("../lib/authz");
  const profiles = require("../profiles");
  const sess = authz.sessionFor(req);
  const id = sess ? sess.profile.id : String(profileId || "").slice(0, 24) || null;
  const p = id ? profiles.list().find((x) => x.id === id) : null;
  return { id: p ? p.id : id, name: p ? p.name : null };
};

// Anyone on the LAN can see the queue (so the Discover page can show state);
// each job says whether it is the asker's own ("mine"), never who asked.
router.get("/api/downloads", (req, res) => {
  res.json(downloads.listFor(viewerFor(req, req.query.profile)));
});

// Create a download request (pending admin approval).
router.post("/api/downloads", (req, res) => {
  const result = downloads.create(req.body || {});
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// The requester opened a finished download (played it, or opened its page):
// clears the "ready to play" nudge for that job. In closed mode the session
// must own the profile; in open mode the profile id in the body is trusted,
// same as every other per-profile write.
router.post("/api/downloads/:id/seen", (req, res) => {
  const profile = String((req.body || {}).profile || "");
  if (!profile || !require("../lib/authz").profileAllowed(req, profile)) {
    return res.status(403).json({ error: "not your download" });
  }
  const r = downloads.markSeen(req.params.id, viewerFor(req, profile));
  if (r.error) return res.status(r.error === "no such download" ? 404 : 403).json(r);
  res.json(r);
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

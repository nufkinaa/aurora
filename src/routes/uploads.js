// Admin → Downloads → "Add your own file" (media/uploads.js): uploads from
// the admin's device in chunks, and downloads from a Drive / Dropbox / direct
// link. Admin only — every route below checks the admin password itself
// (routes/admin.js guards /api/admin too; this does not lean on the order
// the routers are mounted in).
const express = require("express");
const realtime = require("../realtime");
const uploads = require("../media/uploads");

const router = express.Router();

const adminOnly = (req, res, next) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  next();
};
const answer = (res, r) => {
  const { status = 200, ...body } = r || {};
  res.status(status).json(body);
};
const fenced = (fn) => async (req, res) => {
  try {
    answer(res, await fn(req));
  } catch (e) {
    console.warn(`[upload] ${req.method} ${req.path}: ${(e && e.message) || e}`);
    if (!res.headersSent) res.status(500).json({ error: (e && e.message) || "failed" });
  }
};

router.get("/api/admin/uploads", adminOnly, (req, res) => res.json(uploads.list()));
router.post("/api/admin/uploads", adminOnly, fenced((req) => uploads.createUpload(req.body || {})));
router.post("/api/admin/uploads/link", adminOnly, fenced((req) => uploads.createLink(req.body || {})));
router.get("/api/admin/uploads/:id", adminOnly, (req, res) => {
  const job = uploads.get(req.params.id);
  if (!job) return res.status(404).json({ error: "No such upload." });
  res.json({ job });
});
// The body is the raw bytes (application/octet-stream — express.json leaves it alone).
router.put("/api/admin/uploads/:id/chunk", adminOnly, fenced((req) => {
  const part = parseInt(req.query.part, 10) || 0;
  const offset = Number(req.query.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) return { status: 400, error: "offset missing" };
  return uploads.writeChunk(req.params.id, part, offset, req);
}));
router.post("/api/admin/uploads/:id/cancel", adminOnly, fenced((req) => uploads.cancel(req.params.id)));
router.post("/api/admin/uploads/:id/retry", adminOnly, fenced((req) => uploads.retry(req.params.id)));
router.post("/api/admin/uploads/:id/dismiss", adminOnly, fenced((req) => uploads.dismiss(req.params.id)));

module.exports = router;

// "Report a problem" — one form in the app, one list for the admin.
//
// A report is the viewer's words plus what the client knew at the time:
// the screen, the title being played, the look, the browser, the last few
// client-side errors, the app version. Stored in data/reports.json, pushed
// to the admin's phone (notify) and to the admin panel live.
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");
const realtime = require("../realtime");
const notify = require("../lib/notify");

const store = new JsonStore(path.join(config.DATA_DIR, "reports.json"), { reports: [] });
const MAX = 500;
const router = express.Router();

const adminOnly = (req, res, next) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  next();
};

const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

router.post("/api/reports", (req, res) => {
  const b = req.body || {};
  const text = clean(b.text, 2000);
  if (!text) return res.status(400).json({ error: "say what went wrong" });
  const ctx = b.context && typeof b.context === "object" ? b.context : {};
  const report = {
    id: crypto.randomBytes(6).toString("hex"),
    at: Date.now(),
    status: "open",
    text,
    profile: clean(b.profile, 40) || null,
    context: {
      route: clean(ctx.route, 200),
      title: clean(ctx.title, 200) || null,
      itemId: clean(ctx.itemId, 80) || null,
      look: clean(ctx.look, 20) || null,
      ua: clean(ctx.ua, 300),
      viewport: clean(ctx.viewport, 40),
      online: ctx.online !== false,
      version: clean(ctx.version, 20),
      errors: Array.isArray(ctx.errors) ? ctx.errors.slice(-20).map((e) => clean(e, 400)) : [],
      playMarks: Array.isArray(ctx.playMarks) ? ctx.playMarks.slice(-30) : [],
    },
    ip: req.ip,
  };
  store.data.reports.unshift(report);
  if (store.data.reports.length > MAX) store.data.reports.length = MAX;
  store.save();
  console.log(`[report] ${report.profile || "someone"} on ${report.context.route}: ${text.slice(0, 120)}`);
  notify.send("Aurora: problem reported", `${report.profile || "Someone"}: ${text.slice(0, 200)}${report.context.title ? ` (${report.context.title})` : ""}`);
  realtime.broadcastAdmins({ type: "report_new", report });
  res.json({ ok: true, id: report.id });
});

router.get("/api/admin/reports", adminOnly, (req, res) => {
  res.json({ reports: store.data.reports });
});
router.post("/api/admin/reports/:id/status", adminOnly, (req, res) => {
  const r = store.data.reports.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  r.status = (req.body || {}).status === "closed" ? "closed" : "open";
  store.save();
  res.json({ ok: true, report: r });
});
router.delete("/api/admin/reports/:id", adminOnly, (req, res) => {
  const i = store.data.reports.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "not found" });
  store.data.reports.splice(i, 1);
  store.save();
  res.json({ ok: true });
});

const openCount = () => store.data.reports.filter((r) => r.status === "open").length;

module.exports = router;
module.exports.openCount = openCount;

// Admin → Server → "Network for streaming" (lib/nettune.js,
// docs/network-for-streaming.md).
//   GET  /api/admin/net         what is in force, data resent lately, the helper
//   POST /api/admin/net/apply   BBR + fq + no slow start after a pause
//   POST /api/admin/net/undo    what was there before
//   POST /api/admin/net/http2   Caddy: HTTP/1.1 + HTTP/2 only (BBR then steers all video)
//   POST /api/admin/net/http3   Caddy: back to its default (HTTP/3 too)
"use strict";
const express = require("express");
const realtime = require("../realtime");
const nettune = require("../lib/nettune");

const router = express.Router();
const adminOnly = (req, res, next) => (realtime.isAdmin(req) ? next() : res.status(403).json({ error: "Admin access required" }));

nettune.start();

router.get("/api/admin/net", adminOnly, async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await nettune.status());
});
for (const verb of ["apply", "undo", "http2", "http3"]) {
  router.post(`/api/admin/net/${verb}`, adminOnly, async (req, res) => {
    const r = await nettune.run(verb);
    if (r.error) return res.status(r.setup ? 409 : 400).json(r);
    res.json(r);
  });
}

module.exports = router;

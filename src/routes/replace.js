// "Problem with this copy? → Get another version" — the routes. The rules
// are media/replace.js; this only says who is asking.
//
//   GET  /api/replace/:id?profile=     what the sheet needs: the copy, the reasons, a replacement on its way
//   GET  /api/replace/:id/sources?profile=   the title's other sources (the copy being replaced left out)
//   POST /api/replace/:id              { profile, reason, note, source: { infoHash, fileIdx }, context }
//   POST /api/replace/:id/cancel       { profile }
//   GET  /api/admin/replacements       every request, newest first (admin)
const express = require("express");
const replace = require("../media/replace");
const realtime = require("../realtime");

const router = express.Router();

// Who is asking: the session's profile in closed mode, else the profile id
// the client names (open mode trusts that everywhere) — and, in closed mode,
// a profile the session is not is refused.
const viewerFor = (req, profileId) => {
  const authz = require("../lib/authz");
  const profiles = require("../profiles");
  const named = String(profileId || "").slice(0, 24);
  if (named && !authz.profileAllowed(req, named)) return { refused: true };
  const sess = authz.sessionFor(req);
  const id = sess ? sess.profile.id : named || null;
  const p = id ? profiles.list().find((x) => x.id === id) : null;
  return { id: p ? p.id : null, name: p ? p.name : null };
};
// Is this request made as a kids profile (a kids lock on the browser, a kids
// session or token)? Those may not replace anything.
const kidsOf = (req) => {
  try { return require("./api")._internals.kidsFor(req) || null; } catch { return null; }
};
const notYours = (res) => res.status(403).json({ error: "That isn't your profile.", code: "profile" });

router.get("/api/replace/:id", (req, res) => {
  res.set("Cache-Control", "no-store");
  const viewer = viewerFor(req, req.query.profile);
  if (viewer.refused) return notYours(res);
  const r = replace.view(req.params.id, viewer, { kids: kidsOf(req) });
  res.status(r.status).json(r.body);
});

router.get("/api/replace/:id/sources", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const viewer = viewerFor(req, req.query.profile);
  if (viewer.refused) return notYours(res);
  const r = await replace.sources(req.params.id, viewer, { kids: kidsOf(req) });
  res.status(r.status).json(r.body);
});

router.post("/api/replace/:id", async (req, res) => {
  const b = req.body || {};
  const viewer = viewerFor(req, b.profile);
  if (viewer.refused) return notYours(res);
  const r = await replace.request(req.params.id, viewer, {
    reason: b.reason, note: b.note, source: b.source, context: b.context,
    ip: realtime.clientIp(req), kids: kidsOf(req),
  });
  res.status(r.status).json(r.body);
});

router.post("/api/replace/:id/cancel", (req, res) => {
  const b = req.body || {};
  const admin = realtime.isAdmin(req);
  const viewer = viewerFor(req, b.profile);
  if (viewer.refused && !admin) return notYours(res);
  const r = replace.cancel(req.params.id, viewer, { admin });
  res.status(r.status).json(r.body);
});

router.get("/api/admin/replacements", (req, res) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  res.json({ replacements: replace.adminList() });
});

module.exports = router;

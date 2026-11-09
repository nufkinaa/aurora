// Franchise order (2026-11-09) — media/franchises has the list, the rules and
// why. One set of answers for the website, the TV and the phone:
//   GET  /api/franchises/for/:imdbId?profile=&type=&tmdbId=   the title page's line
//        → { franchise: { id, name, the, line, action, position, total, optional, order } | null, others: [...] }
//   GET  /api/franchises/next/:imdbId?profile=                 the end card's next title
//        → { next: { franchise, kicker, order, position, total, entry } | null }
//   GET  /api/franchises/:id?profile=&order=                   the franchise page
//   POST /api/franchises/:id/order  { profile, order }          the person's order switch
// Decoration on the title page and the player: a failure answers "nothing",
// never an error the page would have to show.
"use strict";
const express = require("express");
const service = require("../media/franchises/service");

const router = express.Router();
const IMDB = /^tt\d{4,12}$/;

// Whose watching may shape the answer: the profile the request names, when
// it would be allowed that profile's home screen (the rule of
// routes/requests.js personalFor) — otherwise nobody's.
const personFor = (req, id) => {
  if (!id || typeof id !== "string" || !/^[\w-]{1,40}$/.test(id)) return null;
  try {
    const profiles = require("../profiles");
    const authz = require("../lib/authz");
    if (!profiles.exists(id) || profiles.isLocked(id) || !authz.profileAllowed(req, id)) return null;
    const s = authz.sessionFor(req);
    const owns = !!s && s.profile.id === id;
    if (!owns && profiles.isProtected(id) && !profiles.tokenValid(id, req.get("X-Profile-Token"))) return null;
    return id;
  } catch {
    return null;
  }
};

router.get("/api/franchises/for/:imdbId", async (req, res) => {
  const imdbId = String(req.params.imdbId || "");
  if (!IMDB.test(imdbId)) return res.json({ franchise: null, others: [] });
  try {
    const type = req.query.type === "series" || req.query.type === "show" ? "series" : "movie";
    res.json(await service.forTitle(imdbId, personFor(req, req.query.profile), { type, tmdbHint: parseInt(req.query.tmdbId, 10) || null }));
  } catch {
    res.json({ franchise: null, others: [] });
  }
});

router.get("/api/franchises/next/:imdbId", async (req, res) => {
  const imdbId = String(req.params.imdbId || "");
  if (!IMDB.test(imdbId)) return res.json({ next: null });
  try {
    res.json(await service.nextFor(imdbId, personFor(req, req.query.profile)));
  } catch {
    res.json({ next: null });
  }
});

router.get("/api/franchises/:id", async (req, res) => {
  try {
    const order = req.query.order === "story" || req.query.order === "release" ? req.query.order : null;
    const out = await service.page(String(req.params.id || ""), personFor(req, req.query.profile), order);
    if (!out) return res.status(404).json({ error: "No such franchise" });
    res.json(out);
  } catch {
    res.status(502).json({ error: "Couldn't load that franchise right now" });
  }
});

router.post("/api/franchises/:id/order", async (req, res) => {
  const body = req.body || {};
  const profileId = personFor(req, body.profile);
  if (!profileId) return res.status(401).json({ error: "Pick your profile first" });
  try {
    const r = await service.setOrder(String(req.params.id || ""), profileId, String(body.order || ""));
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    res.json(r);
  } catch {
    res.status(500).json({ error: "Couldn't save that" });
  }
});

module.exports = router;

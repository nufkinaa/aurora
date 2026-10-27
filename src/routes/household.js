// Recommendations between the people of the household — the routes.
// The rules are media/household.js; the decisions docs/qa/household-recs/DESIGN.md.
//
// Every route acts AS the profile in the address and is guarded exactly like
// that profile's own data (routes/profiles.js `gate`: it must exist, the
// session must own it in "closed", a protected one needs its token, an
// admin-locked one is refused).
//
//   GET  /api/profiles/:id/recommend/people?key=tt…|lib:…&type=movie|show
//        -> { people: [{ id, name, avatar, avatarImage, color, kids, state, line, waitMin, note? }],
//             noteMax, perPerson, perHour }
//   POST /api/profiles/:id/recommend { to: [ids], title: { id } | { imdbId, type, title, … }, note }
//        -> { sent: [{ to, name, updated }], refused: [{ to, name, reason, line, waitMin? }], line }
//   GET  /api/profiles/:id/household?from=<id>&slim=1
//        -> { items: [card + hh], total, people: [{ id, name, n }], unseen }
//   GET  /api/profiles/:id/household/for?key=…   -> { from: [{ id, name, note, at }], dismissed }
//        (the person is looking at the title: what they got for it counts as seen)
//   POST /api/profiles/:id/household/dismiss { key, undo? }  -> { ok }
//   POST /api/profiles/:id/household/seen                     -> { ok }
//   GET  /api/profiles/:id/household/sent?slim=1 -> { items: [card + { to: [{ id, name, status, at, note }] }] }
//   GET  /api/profiles/:id/household/settings    -> { on, people: [{ id, name, …, muted }] }
//   POST /api/profiles/:id/household/settings { on?, muted? } -> the same
"use strict";
const express = require("express");
const scanner = require("../media/scanner");
const identity = require("../media/identity");
const household = require("../media/household");
const lazy = require("../lib/lazy");
const profilesRoutes = lazy(require, "./profiles");
const apiRoutes = lazy(require, "./api");

const router = express.Router();
const gate = (req, res, next) => profilesRoutes()._internals.gate(req, res, next);
const hh = () => household.instance();

// What the client names, as the store keeps it. A library id is looked up
// (an episode stands for its show); a catalogue title is taken as described.
const titleFrom = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id === "string" && raw.id && !raw.id.startsWith("torrent|")) {
    let item = scanner.findById(raw.id);
    if (item && item.showId) item = scanner.findById(item.showId) || null;
    if (item && (item.type === "movie" || item.type === "show")) {
      let imdbId = item.imdbId || null;
      try { imdbId = imdbId || identity.imdbIdFor(item); } catch {}
      return household.cleanTitle({
        id: item.id, imdbId, type: item.type, title: item.title, year: item.year,
        poster: item.cover, genres: item.genres, rating: item.rating,
      });
    }
  }
  if (typeof raw.imdbId === "string") return household.cleanTitle({ ...raw, id: undefined });
  return null;
};
// …and from a key alone (the picker asks about one title by its key).
const titleFromKey = (key, type) => {
  const k = String(key || "");
  if (k.startsWith("lib:")) return titleFrom({ id: k.slice(4) });
  if (/^tt\d{4,12}$/.test(k)) {
    const lib = (() => { try { return identity.findLibraryFor({ imdbId: k, type }); } catch { return null; } })();
    if (lib) return titleFrom({ id: lib.id });
    return household.cleanTitle({ imdbId: k, type: type === "show" ? "show" : "movie", title: k });
  }
  return null;
};

// A key as the store keeps it: a client that names a library title by its id
// ("lib:<id>") gets the IMDb id the server knows for it, when it knows one.
const normKey = (key) => {
  const k = String(key || "").slice(0, 100);
  if (!k.startsWith("lib:")) return k;
  const t = titleFromKey(k);
  return (t && t.key) || k;
};

// The card a recommended title is drawn as: the library copy when the
// server has one (it plays from disk), else the catalogue title.
const cardFor = (title, slim) => {
  let lib = null;
  try {
    if (title.imdbId) lib = identity.findLibraryFor({ imdbId: title.imdbId, type: title.type });
    if (!lib && title.id) lib = scanner.findById(title.id);
  } catch {}
  const strip = slim ? apiRoutes()._internals.tvStrip : apiRoutes()._internals.cardStrip;
  if (lib) return strip({ ...lib });
  return {
    source: "stream",
    imdbId: title.imdbId,
    type: title.type,
    title: title.title,
    cover: title.poster || null,
    poster: title.poster || null,
    year: title.year || null,
    genres: title.genres || [],
    rating: title.rating || null,
  };
};
// One recommended title as a card: who (`meta` is what a card prints under
// its title), the newest note and whose it is, whether it is new.
const recCard = (g, slim) => {
  const card = cardFor(g.title, slim);
  const names = g.from.map((f) => f.name);
  const noted = g.from.find((f) => f.note);
  return {
    ...card,
    meta: household.fromLine(names),
    hh: {
      key: g.key,
      from: g.from.map((f) => ({ id: f.id, name: f.name, note: f.note, at: f.at })),
      count: g.count,
      at: g.at,
      unseen: !!g.unseen,
      ...(noted ? { note: noted.note, noteBy: noted.name } : {}),
    },
  };
};

router.get("/api/profiles/:id/recommend/people", gate, (req, res) => {
  const title = titleFromKey(req.query.key, req.query.type);
  res.json({
    people: hh().peopleFor(req.params.id, title),
    noteMax: household.NOTE_MAX,
    perPerson: household.PAIR_PER_HOUR,
    perHour: household.SENDER_PER_HOUR,
  });
});

router.post("/api/profiles/:id/recommend", gate, (req, res) => {
  const body = req.body || {};
  const title = titleFrom(body.title);
  if (!title) return res.status(400).json({ error: "That title can't be recommended." });
  const r = hh().send(req.params.id, body.to, title, body.note);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  // one line the app can show as it is
  const sentNames = r.sent.map((s) => s.name);
  const line = r.sent.length
    ? `Recommended to ${household.names(sentNames)}`
    : (r.refused[0] && r.refused[0].line) || "Nothing was sent";
  // 200 either way: a refusal is an answer to show, not a failure (the
  // apps read `sent` / `refused`)
  res.json({ ...r, line, key: title.key });
});

router.get("/api/profiles/:id/household", gate, (req, res) => {
  const slim = req.query.slim === "1";
  const from = typeof req.query.from === "string" && req.query.from ? req.query.from : null;
  const r = hh().forRecipient(req.params.id, { from });
  res.json({
    items: r.items.map((g) => recCard(g, slim)),
    total: r.total,
    people: r.people,
    unseen: r.items.filter((g) => g.unseen).length,
  });
});

router.get("/api/profiles/:id/household/for", gate, (req, res) => {
  const key = String(req.query.key || "");
  if (!key) return res.json({ from: [], dismissed: false });
  res.json(hh().forTitle(req.params.id, normKey(key), { seen: true }));
});

router.post("/api/profiles/:id/household/dismiss", gate, (req, res) => {
  const { key, undo } = req.body || {};
  if (typeof key !== "string" || !key || key.length > 100) return res.status(400).json({ error: "key required" });
  res.json(hh().dismiss(req.params.id, normKey(key), undo === true));
});

router.post("/api/profiles/:id/household/seen", gate, (req, res) => {
  res.json(hh().markSeen(req.params.id));
});

router.get("/api/profiles/:id/household/sent", gate, (req, res) => {
  const slim = req.query.slim === "1";
  res.json({
    items: hh().sentBy(req.params.id).map((g) => ({ ...cardFor(g.title, slim), hh: { key: g.key, to: g.to, at: g.at } })),
  });
});

router.get("/api/profiles/:id/household/settings", gate, (req, res) => {
  res.json(hh().settingsFor(req.params.id));
});
router.post("/api/profiles/:id/household/settings", gate, (req, res) => {
  const b = req.body || {};
  res.json(hh().setSettings(req.params.id, {
    ...(typeof b.on === "boolean" ? { off: !b.on } : {}),
    ...(Array.isArray(b.muted) ? { muted: b.muted } : {}),
  }));
});

// Home's row (routes/api.js): up to ROW_MAX cards and how many there are in all.
const homeRow = (profileId, { slim = false } = {}) => {
  const r = hh().forRecipient(profileId);
  if (!r.items.length) return null;
  const unseen = r.items.filter((g) => g.unseen).length;
  return {
    id: "household",
    title: "Recommended by your household",
    ...(unseen ? { sub: unseen === 1 ? "1 new" : `${unseen} new` } : {}),
    items: r.items.slice(0, household.ROW_MAX).map((g) => recCard(g, slim)),
    total: r.total,
    more: r.total > household.ROW_MAX,
  };
};

router._internals = { titleFrom, titleFromKey, normKey, cardFor, recCard, homeRow };
module.exports = router;

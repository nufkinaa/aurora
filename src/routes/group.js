// "What do we watch tonight?" — the routes. The sessions are lib/grouppick.js,
// the deck and the group score media/groupdeck.js, the why docs/group-pick.md.
//
// Every route acts AS the profile in the address and is guarded exactly like
// that profile's own data (routes/profiles.js `gate`: the profile must exist,
// in "closed" the session must own it, a protected one needs its token, an
// admin-locked one is refused) — so only the household takes part, and only
// as themselves. `device` (body or query) tells one device of a person from
// another; `app` is "tv" | "phone" | "web".
//
//   GET  /api/profiles/:id/group/options                 -> { moods, lengths, kinds, limits }
//   POST /api/profiles/:id/group        { settings, device, role, app }  -> { session }   start one
//   POST /api/profiles/:id/group/join   { code, device, role, app }      -> { session }
//   GET  /api/profiles/:id/group/:code?device=                           -> { session }
//   POST /api/profiles/:id/group/:code/settings { device, settings }     -> { session }   host, lobby
//   POST /api/profiles/:id/group/:code/role     { device, role }         -> { session }   "Swipe on the TV too"
//   POST /api/profiles/:id/group/:code/start    { device }               -> { session }   host: deal the deck
//   POST /api/profiles/:id/group/:code/vote     { device, key, verdict } -> { ok, answered, of }
//   GET  /api/profiles/:id/group/:code/search?q=&device=                 -> { results: [card + { inDeck }] }
//   POST /api/profiles/:id/group/:code/add      { device, title }        -> { ok, key, already? }
//   POST /api/profiles/:id/group/:code/finish   { device }               -> { session }   host: result now
//   POST /api/profiles/:id/group/:code/extend   { device }               -> { session }   host: one more minute
//   POST /api/profiles/:id/group/:code/pick     { device, index }        -> { session }   "Something else"
//   POST /api/profiles/:id/group/:code/again    { device }               -> { session }   host: another round
//   POST /api/profiles/:id/group/:code/choose   { device, key }          -> { session }   Play was pressed
//   POST /api/profiles/:id/group/:code/leave    { device }               -> { ok }
//   POST /api/profiles/:id/group/:code/end      { device }               -> { ok }        host
//
// A session is in memory only. The live socket says when it changed
// (`group_update { code, rev }`, realtime.js); clients then ask again.
"use strict";
const express = require("express");
const profiles = require("../profiles");
const scanner = require("../media/scanner");
const grouppick = require("../lib/grouppick");
const groupdeck = require("../media/groupdeck");
const tax = require("../media/recs/taxonomy");
const lazy = require("../lib/lazy");
const profilesRoutes = lazy(require, "./profiles");
const apiRoutes = lazy(require, "./api");
const recsLib = lazy(require, "../media/recs");
const rankLib = lazy(require, "../media/recs/rank");
const identityLib = lazy(require, "../media/identity");
const wellknownLib = lazy(require, "../media/wellknown");
const tastedeckLib = lazy(require, "../media/tastedeck");
const searchLib = lazy(require, "../media/search");
const watchedLib = lazy(require, "../media/watched");
const kidsLib = lazy(require, "../lib/kids");

const router = express.Router();
const gate = (req, res, next) => profilesRoutes()._internals.gate(req, res, next);

const actorOf = (req) => {
  const p = profiles.list().find((x) => x.id === req.params.id);
  return { profileId: req.params.id, name: (p && p.name) || "Someone", avatar: (p && p.avatar) || null, avatarImage: (p && p.avatarImage) || null };
};
const deviceOf = (req) => String((req.body && req.body.device) || req.query.device || "").slice(0, 40);
const send = (res, r) => {
  if (r && r.error) return res.status(r.status || 400).json({ error: r.error });
  res.json(r);
};

// ---------- the candidates ----------
const firstSentence = (t) => {
  try { return tastedeckLib()._internals.firstSentence(t); } catch { return String(t || "").slice(0, 140); }
};
const runtimeOf = (item) => (item && item.duration > 0 ? Math.round(item.duration / 60) : null);

// The library as candidates: always in (it plays now).
const libraryCands = (entries) => {
  const out = [];
  let identity = null;
  try { identity = identityLib(); } catch {}
  for (const it of scanner.allItems()) {
    if (!it || !it.id || !it.title) continue;
    let imdbId = it.imdbId || null;
    try { imdbId = imdbId || (identity && identity.imdbIdFor(it)) || null; } catch {}
    const e = imdbId && entries ? entries.get(imdbId) : null;
    out.push({
      key: `lib:${it.id}`,
      id: it.id,
      ...(imdbId ? { imdbId } : {}),
      type: it.type === "show" ? "show" : "movie",
      title: it.title,
      year: it.year || null,
      poster: it.cover || null,
      backdrop: it.backdrop || null,
      genres: tax.canonGenres(it.genres || []).slice(0, 3),
      themes: e && e.v ? e.v.themes : null,
      runtime: it.type === "show" ? (e && e.rec.rt) || null : runtimeOf(it) || (e && e.rec.rt) || null,
      rating: it.rating || (e && e.rec.va) || null,
      line: firstSentence(it.synopsis || (e && e.rec.ov) || ""),
      certificate: it.certificate || null,
      lib: true,
      pop: 0.5,
    });
  }
  return out;
};

// The recommender's index (when it is in memory) and the well-known list.
const catalogueCands = (entries) => {
  const out = [];
  const recs = recsLib();
  if (recs.ready()) {
    let list = [];
    try { list = recs._internals.candidatesFor(Date.now(), null); } catch {}
    for (const e of list) {
      const r = e.rec;
      if (!r || !r.poster || !r.title) continue;
      out.push({
        key: r.id, imdbId: r.id, type: r.k === "tv" ? "show" : "movie", title: r.title, year: r.year || null,
        poster: r.poster, backdrop: r.backdrop || null, genres: tax.canonGenres(r.g || []).slice(0, 3),
        themes: e.v ? e.v.themes : null, runtime: r.rt || null, rating: r.va ? Math.round(r.va * 10) / 10 : null,
        line: firstSentence(r.ov || ""), lib: false,
        pop: Math.max(0, Math.min(1, Math.log10(1 + (r.vc || 0)) / 5)),
        ...(r.cert ? { certificate: r.cert } : {}),
      });
    }
  }
  // the "Swipe your taste" pool: the catalogue's best-known titles
  try {
    const known = wellknownLib().all();
    for (const k of known) {
      if (!k || !/^tt\d{4,12}$/.test(k.imdbId || "") || !k.poster || !k.title) continue;
      const type = k.type === "show" || k.type === "series" ? "show" : "movie";
      const depth = type === "show" ? 1000 : 1500;
      if (!(k.k < depth)) continue;
      const e = entries ? entries.get(k.imdbId) : null;
      out.push({
        key: k.imdbId, imdbId: k.imdbId, type, title: k.title, year: k.year || null, poster: k.poster,
        genres: tax.canonGenres(k.genres || []).slice(0, 3), themes: e && e.v ? e.v.themes : null,
        runtime: (e && e.rec.rt) || null, rating: k.rating || null, lib: false, pop: 1 - k.k / depth,
        line: firstSentence((e && e.rec.ov) || ""),
      });
    }
  } catch {}
  return out;
};

// Who has seen what: finished films, finished or rated titles, what the
// recommender counts as consumed.
const CONSUMED = /^(finished|rewatch|mostly|devoted|binge|marked|rated\d)$/;
const seenOf = (pid) => {
  const out = new Set();
  const st = profiles.stateOf(pid) || {};
  try {
    const w = watchedLib().watchedIndex({ progress: st.progress || {}, streamItems: st.streamItems || {} });
    for (const k of w.movies) out.add(k);
  } catch {}
  for (const k of Object.keys(st.ratings || {})) out.add(k);
  try {
    const recs = recsLib();
    if (recs.ready()) {
      for (const t of recs._internals.eventsFor(pid).titles.values()) if ([...t.kinds].some((k) => CONSUMED.test(k))) out.add(t.id);
    }
  } catch {}
  return out;
};

// Each voter's fit for each candidate. A person the recommender knows: its
// own score (rank.scoreAll — taste, nearest liked titles, dislikes). Someone
// it does not know yet: the genres they said they like and loved titles' genres.
const fitsFor = (pid, cands) => {
  const fits = new Map();
  const recs = recsLib();
  let warm = false;
  if (recs.ready()) {
    try {
      const model = recs._internals.modelFor(pid);
      if (model && model.mass >= rankLib().COLD_MASS) {
        warm = true;
        const entries = recs._internals.state.entries;
        const list = [];
        const listed = new Set();
        for (const c of cands) {
          const e = c.imdbId ? entries.get(c.imdbId) : null;
          if (e && !listed.has(e.id)) { list.push(e); listed.add(e.id); }
        }
        const byImdb = new Map();
        for (const c of cands) if (c.imdbId) { if (!byImdb.has(c.imdbId)) byImdb.set(c.imdbId, []); byImdb.get(c.imdbId).push(c); }
        for (const s of rankLib().scoreAll(model, list, {})) for (const c of byImdb.get(s.id) || []) fits.set(c.key, s.fit);
      }
    } catch {}
  }
  if (!warm) {
    const liked = new Map();
    for (const g of profiles.getLikedGenres(pid) || []) for (const cg of tax.canonGenres([g])) liked.set(cg, (liked.get(cg) || 0) + 1);
    const disliked = new Map();
    const lib = new Map(scanner.allItems().map((it) => [it.id, it]));
    for (const t of profiles.getLikedTitles(pid) || []) {
      const it = t.id ? lib.get(t.id) : null;
      for (const g of tax.canonGenres((it && it.genres) || t.genres || [])) liked.set(g, (liked.get(g) || 0) + 0.5);
    }
    for (const t of profiles.getDislikedTitles(pid) || []) for (const g of tax.canonGenres(t.genres || [])) disliked.set(g, (disliked.get(g) || 0) + 0.5);
    if (liked.size || disliked.size) {
      for (const c of cands) {
        const gs = c.genres || [];
        if (!gs.length) continue;
        let v = 0;
        for (const g of gs) v += (liked.get(g) || 0) - (disliked.get(g) || 0);
        fits.set(c.key, v / gs.length);
      }
    }
  }
  return fits;
};

// The strictest kids limit in the room: a kids profile among the voters, or
// the asking device's own kids lock.
const allowFor = (req, voters) => {
  const ages = [];
  for (const pid of voters) { const k = profiles.kidsOf(pid); if (k && typeof k.maxAge === "number") ages.push(k.maxAge); }
  if (req.kids && typeof req.kids.maxAge === "number") ages.push(req.kids.maxAge);
  if (!ages.length) return null;
  const maxAge = Math.min(...ages);
  const certOf = apiRoutes()._internals.kidsCertOf;
  const kids = kidsLib();
  return (c) => {
    const item = c.id ? scanner.findById(c.id) || c : { imdbId: c.imdbId, type: c.type, title: c.title, year: c.year, certificate: c.certificate || null };
    return kids.allowed(item, maxAge, certOf);
  };
};

const cardOut = (c) => ({
  key: c.key,
  ...(c.id ? { id: c.id } : {}),
  ...(c.imdbId ? { imdbId: c.imdbId } : {}),
  type: c.type,
  title: c.title,
  year: c.year || null,
  poster: c.poster || null,
  ...(c.backdrop ? { backdrop: c.backdrop } : {}),
  genres: c.genres || [],
  ...(c.runtime ? { runtime: c.runtime } : {}),
  ...(c.rating ? { rating: c.rating } : {}),
  line: c.line || "",
  lib: !!c.lib,
  groupFit: c.groupFit || 0,
  seenBy: c.seenBy || [],
});

// The deck for the people in this session right now.
const dealFor = (req, code, { exclude = new Set() } = {}) => {
  const voters = grouppick.votersOf(code);
  const settings = grouppick.settingsOf(code) || {};
  let entries = null;
  try { const recs = recsLib(); if (recs.ready()) entries = recs._internals.state.entries; } catch {}
  const allow = allowFor(req, voters);
  // filter first (cheap), then ask each person's fit only for what is left
  const all = [...libraryCands(entries), ...catalogueCands(entries)];
  const seenKeys = new Set();
  const pool = [];
  for (const c of all) {
    if (seenKeys.has(c.key)) continue;
    seenKeys.add(c.key);
    if (!(settings.kind === "both" || c.type === settings.kind)) continue;
    if (!groupdeck.moodMatch(c, settings.mood) || !groupdeck.lengthOk(c, settings.length)) continue;
    pool.push(c);
  }
  const allowed = allow ? pool.filter(allow) : pool;
  const fits = new Map(voters.map((pid) => [pid, fitsFor(pid, allowed)]));
  const seen = new Map(voters.map((pid) => [pid, seenOf(pid)]));
  const cards = groupdeck.buildDeck({
    pool: allowed,
    voters,
    fitOf: (pid, c) => (fits.get(pid) && fits.get(pid).has(c.key) ? fits.get(pid).get(c.key) : null),
    seenOf: (pid) => seen.get(pid),
    settings,
    exclude,
    seed: `${code}|${Math.floor(Date.now() / 60000)}`,
  });
  return cards.map(cardOut);
};

// A title someone asked to add, as a card: a library id is looked up, a
// catalogue title is taken from the search's own records — never the
// client's words as they came.
const titleCard = (raw, req, voters) => {
  if (!raw || typeof raw !== "object") return null;
  let card = null;
  if (typeof raw.id === "string" && raw.id && !raw.id.startsWith("torrent|")) {
    let item = scanner.findById(raw.id);
    if (item && item.showId) item = scanner.findById(item.showId) || item; // an episode stands for its show
    if (!item || (item.type !== "movie" && item.type !== "show")) return null;
    card = libraryCands(null).find((c) => c.id === item.id) || null;
  } else if (/^tt\d{4,12}$/.test(String(raw.imdbId || ""))) {
    const imdbId = String(raw.imdbId);
    const lib = libraryCands(null).find((c) => c.imdbId === imdbId);
    if (lib) card = lib;
    else {
      let entries = null;
      try { const recs = recsLib(); if (recs.ready()) entries = recs._internals.state.entries; } catch {}
      card = catalogueCands(entries).find((c) => c.imdbId === imdbId) || null;
      if (!card) {
        // a title the search found that neither list holds: what the search knows of it
        const type = raw.type === "show" ? "show" : "movie";
        const title = String(raw.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
        if (!title) return null;
        const poster = typeof raw.poster === "string" && /^(https:\/\/|\/img\/)/.test(raw.poster) ? raw.poster.slice(0, 400) : null;
        card = { key: imdbId, imdbId, type, title, year: parseInt(raw.year, 10) || null, poster, genres: tax.canonGenres(Array.isArray(raw.genres) ? raw.genres.slice(0, 6).map(String) : []).slice(0, 3), lib: false, line: "" };
      }
    }
  }
  if (!card) return null;
  const allow = allowFor(req, voters);
  if (allow && !allow(card)) return { refused: true };
  const seenBy = voters.filter((pid) => { const s = seenOf(pid); return s.has(card.imdbId) || (card.id && s.has(card.id)); });
  return cardOut({ ...card, seenBy });
};

// ---------- the routes ----------
router.get("/api/profiles/:id/group/options", gate, (req, res) => {
  res.json({
    moods: groupdeck.MOODS.map((m) => ({ id: m.id, label: m.label })),
    lengths: groupdeck.LENGTHS.map((l) => ({ id: l.id, label: l.label })),
    kinds: groupdeck.KINDS,
    limits: grouppick.LIMITS,
  });
});

router.post("/api/profiles/:id/group", gate, (req, res) => {
  const b = req.body || {};
  send(res, grouppick.create(actorOf(req), b.settings || {}, { device: deviceOf(req), role: b.role, app: b.app }));
});

router.post("/api/profiles/:id/group/join", gate, (req, res) => {
  const b = req.body || {};
  send(res, grouppick.join(actorOf(req), b.code, { device: deviceOf(req), role: b.role, app: b.app }));
});

router.get("/api/profiles/:id/group/:code", gate, (req, res) => {
  send(res, grouppick.get(req.params.code, actorOf(req), deviceOf(req)));
});

router.post("/api/profiles/:id/group/:code/settings", gate, (req, res) => {
  send(res, grouppick.setSettings(req.params.code, actorOf(req), deviceOf(req), (req.body && req.body.settings) || {}));
});

router.post("/api/profiles/:id/group/:code/role", gate, (req, res) => {
  send(res, grouppick.setRole(req.params.code, actorOf(req), deviceOf(req), req.body && req.body.role));
});

// Dealing asks every voter's taste: only the host may, only from the lobby
// (grouppick.start says no otherwise — asked first, so a refused start costs nothing).
const canDeal = (req, phase) => {
  const r = grouppick.get(req.params.code, actorOf(req), deviceOf(req));
  if (r.error) return r;
  if (!r.session.you.host) return { status: 403, error: "Only the person who started it can do that" };
  if (r.session.phase !== phase) return { status: 409, error: phase === "lobby" ? "The deck is already dealt" : "Not now" };
  return null;
};
router.post("/api/profiles/:id/group/:code/start", gate, (req, res) => {
  const no = canDeal(req, "lobby");
  if (no) return send(res, no);
  let cards = [];
  try { cards = dealFor(req, req.params.code); } catch {}
  send(res, grouppick.start(req.params.code, actorOf(req), deviceOf(req), cards));
});

router.post("/api/profiles/:id/group/:code/again", gate, (req, res) => {
  const no = canDeal(req, "result");
  if (no) return send(res, no);
  let cards = [];
  try { cards = dealFor(req, req.params.code, { exclude: grouppick.shownOf(req.params.code) }); } catch {}
  send(res, grouppick.again(req.params.code, actorOf(req), deviceOf(req), cards));
});

router.post("/api/profiles/:id/group/:code/vote", gate, (req, res) => {
  const b = req.body || {};
  const verdict = b.verdict == null ? null : String(b.verdict);
  send(res, grouppick.vote(req.params.code, actorOf(req), deviceOf(req), String(b.key || ""), verdict));
});

router.get("/api/profiles/:id/group/:code/search", gate, (req, res) => {
  const r = grouppick.get(req.params.code, actorOf(req), deviceOf(req));
  if (r.error) return send(res, r);
  const q = String(req.query.q || "").slice(0, 80);
  if (!q.trim()) return res.json({ results: [] });
  const voters = grouppick.votersOf(req.params.code);
  const allow = allowFor(req, voters);
  let found = [];
  try { found = searchLib().suggest(q, { limit: 10 }).filter((x) => x.kind === "title"); } catch {}
  const s = r.session;
  const inDeck = new Set([...s.deck.map((c) => c.key), ...s.deck.map((c) => c.imdbId).filter(Boolean), ...s.added.map((a) => a.key)]);
  const results = [];
  const libs = found.some((x) => x.id) ? new Map(libraryCands(null).map((c) => [c.id, c])) : new Map();
  for (const x of found) {
    const card = x.id ? libs.get(x.id) || null : null;
    const c = card || { key: x.imdbId, imdbId: x.imdbId, type: x.type === "show" ? "show" : "movie", title: x.title, year: x.year || null, poster: x.cover || null, lib: false, genres: [] };
    if (!c.key) continue;
    if (allow && !allow(c)) continue;
    results.push({ key: c.key, ...(c.id ? { id: c.id } : {}), ...(c.imdbId ? { imdbId: c.imdbId } : {}), type: c.type, title: c.title, year: c.year, poster: c.poster, lib: !!c.lib, inDeck: inDeck.has(c.key) || (c.imdbId ? inDeck.has(c.imdbId) : false) });
    if (results.length >= 8) break;
  }
  res.json({ results });
});

router.post("/api/profiles/:id/group/:code/add", gate, (req, res) => {
  const r = grouppick.get(req.params.code, actorOf(req), deviceOf(req));
  if (r.error) return send(res, r);
  const card = titleCard((req.body || {}).title, req, grouppick.votersOf(req.params.code));
  if (!card) return res.status(400).json({ error: "Which title?" });
  if (card.refused) return res.status(403).json({ error: "Not for everyone's age in this group" });
  send(res, grouppick.add(req.params.code, actorOf(req), deviceOf(req), card));
});

router.post("/api/profiles/:id/group/:code/finish", gate, (req, res) => {
  send(res, grouppick.finish(req.params.code, actorOf(req), deviceOf(req)));
});
router.post("/api/profiles/:id/group/:code/extend", gate, (req, res) => {
  send(res, grouppick.extend(req.params.code, actorOf(req), deviceOf(req)));
});
router.post("/api/profiles/:id/group/:code/pick", gate, (req, res) => {
  send(res, grouppick.pickAt(req.params.code, actorOf(req), deviceOf(req), (req.body || {}).index));
});
router.post("/api/profiles/:id/group/:code/choose", gate, (req, res) => {
  send(res, grouppick.choose(req.params.code, actorOf(req), deviceOf(req), (req.body || {}).key ? String(req.body.key) : null));
});
router.post("/api/profiles/:id/group/:code/leave", gate, (req, res) => {
  send(res, grouppick.leave(req.params.code, actorOf(req), deviceOf(req)));
});
router.post("/api/profiles/:id/group/:code/end", gate, (req, res) => {
  send(res, grouppick.end(req.params.code, actorOf(req), deviceOf(req)));
});

grouppick.startTicker();

router._internals = { dealFor, titleCard, seenOf, fitsFor, allowFor, libraryCands, catalogueCands };
module.exports = router;

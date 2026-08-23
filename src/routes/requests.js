// Content requests: viewers ask for titles, admins fulfill them.
// When a scan finds a matching title, the request auto-resolves.
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const config = require("../config");
const scanner = require("../media/scanner");
const realtime = require("../realtime");
const { JsonStore } = require("../lib/jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "requests.json"), []);
const router = express.Router();

// Guard our own /api/admin endpoints. admin.js applies the same gate, but
// relying on it would make this router's security depend on mount order.
router.use("/api/admin", (req, res, next) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  next();
});
const discover = require("../media/discover");
const imdb = require("../media/imdb");

// Browsable catalogs for the Requests storefront
router.get("/api/discover", async (req, res) => {
  try {
    res.json(await discover.trending());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get("/api/discover/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ movies: [], shows: [] });
  try {
    res.json(await discover.search(q));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// What Browse runs on: one page of one category, optionally narrowed to a genre.
// Paged on purpose — the old page loaded a fixed 200 titles and filtered them in
// the browser, which left a niche genre with three results and made "load more"
// a lie. `page` is 0-based; `hasMore` says whether asking again is worth it.
router.get("/api/catalog", async (req, res) => {
  try {
    const out = await discover.catalog({
      type: req.query.type === "show" || req.query.type === "series" ? "show" : "movie",
      category: String(req.query.category || "trending"),
      genre: req.query.genre ? String(req.query.genre) : null,
      page: Math.max(0, Math.min(40, parseInt(req.query.page, 10) || 0)),
    });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// The genres the catalog can actually serve, so the UI never offers one that
// comes back empty.
router.get("/api/catalog/genres", async (req, res) => {
  try {
    res.json({ genres: await discover.genres(req.query.type === "show" ? "show" : "movie") });
  } catch {
    res.json({ genres: [] });
  }
});

// Resolve a LIBRARY title to its IMDb id, so the one detail page can show both
// the local copy and the stream sources (which are all keyed by IMDb id). The
// resolving and its on-disk cache live in media/imdb.js, shared with the
// subtitle backfill tool.
router.get("/api/imdb-for", async (req, res) => {
  const title = String(req.query.title || "").trim();
  if (!title) return res.status(400).json({ error: "title is required" });
  const imdbId = await imdb.resolve(
    title,
    req.query.type === "show" ? "show" : "movie",
    parseInt(req.query.year, 10) || null
  );
  res.json({ imdbId });
});

// Full metadata (backdrop, cast, episodes) for the Discover detail page
router.get("/api/discover/meta/:type/:id", async (req, res) => {
  try {
    res.json(await discover.meta(req.params.type, req.params.id));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// "More like this" for the detail page. Decoration on a page that must
// render regardless — failures answer an empty row, never a 5xx.
router.get("/api/discover/similar/:type/:id", async (req, res) => {
  try {
    const type =
      req.params.type === "series" || req.params.type === "show"
        ? "series"
        : "movie";
    const id = String(req.params.id || "");
    if (!/^tt\d{4,12}$/.test(id)) return res.json({ items: [] });
    const similar = require("../media/similar");
    res.json(await similar.similar(type, id, parseInt(req.query.tmdbId, 10) || null));
  } catch {
    res.json({ items: [] });
  }
});

const normalize = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

router.get("/api/requests", (req, res) => {
  res.json(store.data);
});

router.post("/api/requests", (req, res) => {
  const { title, type, note, profile } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: "title required" });
  }

  const clean = String(title).trim().slice(0, 80);

  // Already in the library?
  const existing = scanner
    .allItems()
    .find((i) => normalize(i.title) === normalize(clean));
  if (existing) {
    return res.json({ alreadyAvailable: existing });
  }

  // Duplicate pending request?
  const dupe = store.data.find(
    (r) => r.status === "pending" && normalize(r.title) === normalize(clean)
  );
  if (dupe) return res.json({ request: dupe, duplicate: true });

  const request = {
    id: crypto.randomBytes(5).toString("hex"),
    title: clean,
    type: type === "show" ? "show" : "movie",
    note: note ? String(note).slice(0, 200) : "",
    profile: profile ? String(profile).slice(0, 24) : null,
    status: "pending",
    at: new Date().toISOString(),
  };
  store.data.unshift(request);
  if (store.data.length > 200) store.data.pop();
  store.save();

  realtime.broadcastAdmins({ type: "request_new", request });
  res.json({ request });
});

// Admin: change request status
router.post("/api/admin/requests/:id/status", (req, res) => {
  const request = store.data.find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "Not found" });

  const { status } = req.body || {};
  if (!["pending", "added", "declined"].includes(status)) {
    return res.status(400).json({ error: "bad status" });
  }
  request.status = status;
  request.resolvedAt = new Date().toISOString();
  store.save();

  realtime.broadcastAll({ type: "request_update", request });
  res.json({ request });
});

router.delete("/api/admin/requests/:id", (req, res) => {
  const i = store.data.findIndex((r) => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Not found" });
  store.data.splice(i, 1);
  store.save();
  res.json({ ok: true });
});

// After every scan, auto-resolve pending requests that now exist
scanner.events.on("scanned", () => {
  let changed = false;
  for (const r of store.data) {
    if (r.status !== "pending") continue;
    const hit = scanner
      .allItems()
      .find((i) => normalize(i.title) === normalize(r.title));
    if (hit) {
      r.status = "added";
      r.resolvedAt = new Date().toISOString();
      changed = true;
      realtime.broadcastAll({ type: "request_update", request: r });
    }
  }
  if (changed) store.save();
});

// How many title requests still need an answer (the admin tab badge).
router.pendingCount = () =>
  store.data.filter((r) => r.status === "pending").length;

module.exports = router;

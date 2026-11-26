// The Clipwave Media Server API, v1 (2026-11-26) — what Clipwave (an app that
// cuts short clips out of films and episodes) reads the library through.
// The contract is docs/clipwave-api.md: search the library, read an item's
// facts and subtitles, and pull only the parts of a file it needs.
//
//   GET /clipwave/v1/ping                          health + optional endpoints offered
//   GET /clipwave/v1/search?q=&type=&limit=&offset=
//   GET /clipwave/v1/library?type=&sort=&order=&limit=&offset=
//   GET /clipwave/v1/shows/:showId/episodes?season=
//   GET /clipwave/v1/items/:id                     a film or an episode, in full
//   GET /clipwave/v1/items/:id/subtitles/:subId    SRT
//   GET /clipwave/v1/items/:id/file                the original file, with Range
//   GET /clipwave/v1/items/:id/poster?w=
//   GET /clipwave/v1/items/:id/clip?start=&end=&audioTrack=   (capability "clip")
//   GET /clipwave/v1/items/:id/audio?audioTrack=              (capability "audio")
//
// WHO: every request carries `Authorization: Bearer <key>`, a key the admin
// made in the admin panel (lib/clipwavetokens.js). Nothing else opens it —
// not a session, not the admin password — and a key opens nothing else.
// /clipwave is outside the sign-in wall's paths (server.js GATED): this
// router is its own wall.
//
// READ ONLY: nothing here changes the library, a profile or a download.
// (The torrent streaming pipeline is not part of this: library files only.)
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const config = require("../config");
const scanner = require("../media/scanner");
const tokens = require("../lib/clipwavetokens");
const lazy = require("../lib/lazy");
const realtime = require("../realtime");

const identityLib = lazy(require, "../media/identity");
const xrayLib = lazy(require, "../media/xray");
const onlineLib = lazy(require, "../media/online");
const subtitlesLib = lazy(require, "../media/subtitles");
const subsyncLib = lazy(require, "../media/subsync");
const metadataLib = lazy(require, "../media/metadata");
const rangeserve = require("../lib/rangeserve");
const langLib = lazy(require, "../lib/lang");

const router = express.Router();
const BASE = "/clipwave/v1";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CLIP_S = 600;

// ---------- errors: { error: { code, message } } ----------
const STATUS = { unauthorized: 401, not_found: 404, bad_request: 400, range_not_satisfiable: 416, busy: 503, internal: 500 };
const fail = (res, code, message, extra = {}) => {
  if (res.headersSent) { try { res.destroy(); } catch {} return; }
  if (extra.retryAfter) res.setHeader("Retry-After", String(extra.retryAfter));
  res.status(STATUS[code] || 500).json({ error: { code, message } });
};

// ---------- the wall: a key, or nothing ----------
const saidBadKey = require("../lib/sayonce").sayOnce({ max: 200, windowMs: 10 * 60 * 1000 });
router.use("/clipwave", (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  const key = tokens.bearerOf(req);
  const who = key ? tokens.check(key) : null;
  if (!who) {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (saidBadKey(ip)) console.warn(`[clipwave] 401 ${key ? "wrong key" : "no key"} from ${ip}`);
    return fail(res, "unauthorized", key ? "This access key is not valid (it may have been removed in Aurora's admin panel)." : "An access key is required: Authorization: Bearer <key>.");
  }
  req.clipwave = who;
  next();
});
router.use(BASE, (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return fail(res, "bad_request", "Only GET is supported.");
  next();
});

// ---------- small helpers ----------
const intIn = (v, def, min, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const pageOf = (q) => ({ limit: intIn(q.limit, 50, 1, 200), offset: intIn(q.offset, 0, 0, 1e9) });
const page = (list, q) => {
  const { limit, offset } = pageOf(q);
  return { total: list.length, items: list.slice(offset, offset + limit) };
};
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v) * 1000) / 1000 : 0);
const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const iso1 = (code) => {
  if (!code) return null;
  try { return langLib().iso1(code) || String(code); } catch { return String(code); }
};

const imdbOf = (item) => {
  if (!item) return null;
  if (item.imdbId) return item.imdbId;
  try { return identityLib().imdbIdFor(item) || null; } catch { return null; }
};
const creditsOf = (item) => {
  const imdbId = imdbOf(item);
  if (!imdbId) return { directors: [], studios: [] };
  try { return xrayLib().cachedCredits(item.type === "show" ? "series" : "movie", imdbId) || { directors: [], studios: [] }; } catch { return { directors: [], studios: [] }; }
};
// The first time an item's details are asked for, its credits are looked up
// (X-Ray's sources, kept on disk for a month): waited for a few seconds at
// most, so a slow source never holds the answer.
const CREDITS_WAIT_MS = 4000;
const creditsFresh = async (item) => {
  const have = creditsOf(item);
  if (have.directors.length || have.studios.length) return have;
  const imdbId = imdbOf(item);
  if (!imdbId) return have;
  const look = xrayLib().get({ type: item.type === "show" ? "series" : "movie", imdbId }).catch(() => null);
  await Promise.race([look, new Promise((r) => setTimeout(r, CREDITS_WAIT_MS).unref())]);
  return creditsOf(item);
};

const EMPTY_EP = { showId: null, showTitle: null, season: null, episode: null, episodeTitle: null };

const summaryOfMovie = (m, credits = creditsOf(m)) => ({
  id: m.id,
  type: "movie",
  title: m.title,
  originalTitle: null,
  year: m.year || null,
  durationS: num(m.duration),
  genres: m.genres || [],
  studios: credits.studios,
  directors: credits.directors,
  imdbId: imdbOf(m),
  tmdbId: null,
  posterPath: m.cover ? `/v1/items/${m.id}/poster` : null,
  ...EMPTY_EP,
});
const episodesOfShow = (s) => (s.seasons || []).flatMap((se) => (se && se.episodes) || []);
const summaryOfShow = (s, credits = creditsOf(s)) => ({
  id: s.id,
  type: "show",
  title: s.title,
  originalTitle: null,
  year: s.year || null,
  durationS: null,
  genres: s.genres || [],
  studios: credits.studios,
  directors: credits.directors,
  imdbId: imdbOf(s),
  tmdbId: null,
  posterPath: s.cover ? `/v1/items/${s.id}/poster` : null,
  ...EMPTY_EP,
  seasonCount: (s.seasons || []).length,
  episodeCount: episodesOfShow(s).length,
});
const summaryOfEpisode = (ep, s, credits = creditsOf(s)) => ({
  id: ep.id,
  type: "episode",
  title: ep.title,
  originalTitle: null,
  year: s.year || null,
  durationS: num(ep.duration),
  genres: s.genres || [],
  studios: credits.studios,
  directors: credits.directors,
  imdbId: null,
  tmdbId: null,
  posterPath: s.cover ? `/v1/items/${ep.id}/poster` : null,
  showId: s.id,
  showTitle: s.title,
  season: ep.season,
  episode: ep.episode,
  episodeTitle: ep.title,
});

// id -> { kind: "movie"|"show"|"episode", item, show? } | null
const find = (id) => {
  if (!ID_RE.test(String(id || ""))) return null;
  try { identityLib().ensureStamped(); } catch {}
  const hit = scanner.findById(id);
  if (!hit) return null;
  if (hit.type === "show") return { kind: "show", item: hit };
  if (hit.showId) {
    const show = scanner.findById(hit.showId);
    if (!show) return null;
    const ep = episodesOfShow(show).find((e) => e.id === id) || hit;
    return { kind: "episode", item: ep, show };
  }
  if (hit.type === "movie") return { kind: "movie", item: hit };
  return null;
};
const fileOf = (id) => {
  const entry = scanner.resolve(id);
  return entry && entry.kind === "video" ? entry.path : null;
};
// a file on a network drive that is not answering: said at once, not waited on
const driveDown = (file) => {
  try { return require("../lib/drives").unavailableFor(file); } catch { return null; }
};

// ---------- 1. ping ----------
let opusKnown = null; // does this ffmpeg have libopus? (asked once)
const hasOpus = () => {
  if (opusKnown !== null) return Promise.resolve(opusKnown);
  if (!config.ffmpegAvailable) return Promise.resolve((opusKnown = false));
  return require("../lib/spawner")
    .run(config.FFMPEG, ["-hide_banner", "-encoders"], { timeoutMs: 15000, maxBuffer: 2 * 1024 * 1024, name: "clipwave-encoders" })
    .then((r) => (opusKnown = /\blibopus\b/.test(String(r.stdout || ""))), () => false);
};
const capabilities = async () => {
  const caps = [];
  if (config.ffmpegAvailable) caps.push("clip");
  if (await hasOpus()) caps.push("audio");
  return caps;
};
router.get(`${BASE}/ping`, async (req, res) => {
  let version = "0";
  try { version = require("../../package.json").version; } catch {}
  res.json({
    name: `${config.ADMIN_NAME && config.ADMIN_NAME !== "the admin" ? `${config.ADMIN_NAME}'s ` : ""}Aurora`,
    apiVersion: 1,
    serverVersion: version,
    capabilities: await capabilities(),
  });
});

// ---------- 2. search ----------
// How well `text` (and its year) answers the query; 0 = not at all.
const scoreOf = (text, year, qn, tokensQ, yearQ) => {
  const t = norm(text);
  if (!t) return 0;
  let s = 0;
  if (t === qn) s = 100;
  else if (t.startsWith(qn)) s = 80;
  else if (` ${t} `.includes(` ${qn} `)) s = 70;
  else if (t.includes(qn)) s = 60;
  else {
    const hay = `${t} ${year || ""}`;
    if (tokensQ.length && tokensQ.every((w) => hay.includes(w))) s = 40;
  }
  if (s && yearQ && Number(year) === yearQ) s += 5;
  return s;
};
const GENERIC_EP = /^episode \d+$/i;
const search = (q, type) => {
  const raw = String(q || "").trim();
  const sxe = /\bs(\d{1,2})\s*e(\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b/i.exec(raw);
  const wantS = sxe ? parseInt(sxe[1] || sxe[3], 10) : null;
  const wantE = sxe ? parseInt(sxe[2] || sxe[4], 10) : null;
  const qn = norm(sxe ? raw.replace(sxe[0], " ") : raw);
  const yearM = /\b(19\d{2}|20\d{2})\b/.exec(qn);
  const yearQ = yearM ? parseInt(yearM[1], 10) : null;
  const tokensQ = qn.split(" ").filter(Boolean);
  const qNoYear = yearQ ? norm(qn.replace(yearM[0], " ")) : qn;
  const out = [];
  if (!qn && wantS == null) return out;
  const score = (text, year) => Math.max(scoreOf(text, year, qn, tokensQ, yearQ), yearQ && qNoYear ? scoreOf(text, year, qNoYear, qNoYear.split(" "), yearQ) : 0);
  if ((type === "all" || type === "movie") && wantS == null) {
    for (const m of scanner.index.movies) {
      const s = score(m.title, m.year);
      if (s) out.push({ s, title: m.title, sum: () => summaryOfMovie(m) });
    }
  }
  for (const show of scanner.index.shows) {
    const showScore = qn ? score(show.title, show.year) : 0;
    if ((type === "all" || type === "show") && showScore && wantS == null) out.push({ s: showScore, title: show.title, sum: () => summaryOfShow(show) });
    if (type !== "all" && type !== "episode") continue;
    for (const ep of episodesOfShow(show)) {
      if (wantS != null) {
        // "haven s03e07": that episode of the shows the rest of the query names
        if (ep.season === wantS && ep.episode === wantE && (showScore || !qn)) out.push({ s: (showScore || 50) + 1, title: show.title, sum: () => summaryOfEpisode(ep, show) });
        continue;
      }
      const own = !GENERIC_EP.test(ep.title || "") ? scoreOf(ep.title, null, qn, tokensQ, null) : 0;
      // type=episode: the episodes of a show the query names count too
      const s = own >= 60 ? own : type === "episode" && showScore ? showScore - 10 : 0;
      if (s > 0) out.push({ s, title: `${show.title} ${String(ep.season).padStart(3, "0")} ${String(ep.episode).padStart(4, "0")}`, sum: () => summaryOfEpisode(ep, show) });
    }
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  out.sort((a, b) => b.s - a.s || collator.compare(a.title, b.title));
  return out;
};
router.get(`${BASE}/search`, (req, res) => {
  const type = String(req.query.type || "all").toLowerCase();
  if (!["all", "movie", "show", "episode"].includes(type)) return fail(res, "bad_request", "type must be all, movie, show or episode.");
  const q = String(req.query.q || "");
  if (!q.trim()) return fail(res, "bad_request", "q is required.");
  if (q.length > 200) return fail(res, "bad_request", "q is too long.");
  const hits = search(q, type);
  const { limit, offset } = pageOf(req.query);
  res.json({ total: hits.length, items: hits.slice(offset, offset + limit).map((h) => h.sum()) });
});

// ---------- 3. library ----------
router.get(`${BASE}/library`, (req, res) => {
  const type = req.query.type ? String(req.query.type).toLowerCase() : "all";
  if (!["all", "movie", "show"].includes(type)) return fail(res, "bad_request", "type must be movie or show.");
  const sort = String(req.query.sort || "title").toLowerCase();
  if (!["title", "year", "added"].includes(sort)) return fail(res, "bad_request", "sort must be title, year or added.");
  const order = String(req.query.order || (sort === "added" ? "desc" : "asc")).toLowerCase();
  if (!["asc", "desc"].includes(order)) return fail(res, "bad_request", "order must be asc or desc.");
  try { identityLib().ensureStamped(); } catch {}
  const rows = [];
  if (type !== "show") for (const m of scanner.index.movies) rows.push({ it: m, sum: () => summaryOfMovie(m) });
  if (type !== "movie") for (const s of scanner.index.shows) rows.push({ it: s, sum: () => summaryOfShow(s) });
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const byTitle = (a, b) => collator.compare(a.it.title || "", b.it.title || "");
  const key = sort === "year" ? (r) => r.it.year || 0 : sort === "added" ? (r) => r.it.addedAt || 0 : null;
  rows.sort((a, b) => (key ? key(a) - key(b) : 0) || byTitle(a, b));
  if (order === "desc") rows.reverse();
  const { limit, offset } = pageOf(req.query);
  res.json({ total: rows.length, items: rows.slice(offset, offset + limit).map((r) => r.sum()) });
});

// ---------- 4. a show's episodes ----------
router.get(`${BASE}/shows/:showId/episodes`, (req, res) => {
  const hit = find(req.params.showId);
  if (!hit || hit.kind !== "show") return fail(res, "not_found", `No show with id ${String(req.params.showId).slice(0, 64)}`);
  const show = hit.item;
  let eps = episodesOfShow(show);
  if (req.query.season != null && req.query.season !== "") {
    const n = parseInt(req.query.season, 10);
    if (!Number.isFinite(n)) return fail(res, "bad_request", "season must be a number.");
    eps = eps.filter((e) => e.season === n);
  }
  const credits = creditsOf(show);
  const all = eps.map((e) => summaryOfEpisode(e, show, credits));
  // (paged like every list; the default page is enough for any one season)
  const { limit, offset } = { limit: intIn(req.query.limit, 200, 1, 200), offset: intIn(req.query.offset, 0, 0, 1e9) };
  res.json({ total: all.length, items: all.slice(offset, offset + limit) });
});

// ---------- 5. an item in full ----------
const SUB_FORMAT = { subrip: "srt", srt: "srt", ass: "ass", ssa: "ssa", webvtt: "vtt", mov_text: "mov_text", text: "txt" };
// An item's text subtitle tracks, with ids this API answers to:
//   x_<library id of the file>  a file beside the video
//   e_<n>                       the video's own n-th subtitle track (image tracks are never listed)
const subtitleTracksOf = (item, meta) => {
  const out = [];
  for (const t of item.subtitles || []) {
    const ext = /^\/stream\/subtitle\/([A-Za-z0-9_-]+)$/.exec(t.url || "");
    const emb = /^\/stream\/embedded\/[A-Za-z0-9_-]+\/(\d+)$/.exec(t.url || "");
    if (ext) {
      const entry = scanner.resolve(ext[1]);
      if (!entry || entry.kind !== "subtitle") continue;
      const fext = path.extname(entry.path).slice(1).toLowerCase();
      out.push({ id: `x_${ext[1]}`, language: t.lang || null, label: t.label || null, format: SUB_FORMAT[fext] || fext || "srt", forced: !!t.forced, sdh: !!t.sdh, source: "external", _path: entry.path });
    } else if (emb) {
      const n = parseInt(emb[1], 10);
      const s = meta && (meta.subtitleStreams || []).find((x) => x.index === n);
      if (s && !s.text) continue;
      out.push({ id: `e_${n}`, language: t.lang || iso1(s && s.language), label: t.label || null, format: (s && SUB_FORMAT[s.codec]) || (s && s.codec) || "srt", forced: !!t.forced, sdh: !!t.sdh, source: "embedded", _index: n });
    }
  }
  return out;
};
const publicSub = ({ _path, _index, ...t }) => t;
const audioTracksOfMeta = (meta) =>
  ((meta && meta.audioStreams) || []).map((a, i) => ({
    index: i,
    language: iso1(a.language),
    title: a.title || null,
    codec: a.codec || null,
    channels: a.channels || 2,
    default: i === 0,
  }));
const metaOf = (file) => { try { return metadataLib().getCached(file); } catch { return null; } };

router.get(`${BASE}/items/:id`, async (req, res) => {
  const hit = find(req.params.id);
  if (!hit) return fail(res, "not_found", `No item with id ${String(req.params.id).slice(0, 64)}`);
  if (hit.kind === "show") return fail(res, "bad_request", "That id is a show — list its episodes with /v1/shows/{showId}/episodes.");
  const file = fileOf(hit.item.id);
  if (!file) return fail(res, "not_found", "This item has no file.");
  const titleItem = hit.kind === "episode" ? hit.show : hit.item;
  const credits = await creditsFresh(titleItem);
  const base = hit.kind === "episode" ? summaryOfEpisode(hit.item, hit.show, credits) : summaryOfMovie(hit.item, credits);
  const meta = metaOf(file);
  const st = rangeserve.statOf(file);
  const it = hit.item;
  res.json({
    ...base,
    overview: (titleItem.synopsis || "") || null,
    video: {
      container: it.container || path.extname(file).slice(1).toLowerCase(),
      codec: (it.video && it.video.codec) || (meta && meta.video && meta.video.codec) || null,
      width: it.width || (meta && meta.width) || null,
      height: it.height || (meta && meta.height) || null,
      fps: (it.video && it.video.fps) || (meta && meta.video && meta.video.fps) || null,
      sizeBytes: st ? st.size : it.sizeBytes || null,
      fileName: path.basename(file),
    },
    audioTracks: audioTracksOfMeta(meta),
    subtitles: subtitleTracksOf(it, meta).map(publicSub),
    chapters: [],
  });
});

// ---------- 6. subtitle text (SRT) ----------
router.get(`${BASE}/items/:id/subtitles/:subId`, async (req, res) => {
  const hit = find(req.params.id);
  if (!hit || hit.kind === "show") return fail(res, "not_found", `No item with id ${String(req.params.id).slice(0, 64)}`);
  const file = fileOf(hit.item.id);
  const track = file && subtitleTracksOf(hit.item, metaOf(file)).find((t) => t.id === req.params.subId);
  if (!track) return fail(res, "not_found", `No subtitle ${String(req.params.subId).slice(0, 64)} on this item`);
  if (track.source === "embedded" && driveDown(file)) return fail(res, "busy", "The drive this file is on is not answering right now.", { retryAfter: 60 });
  let vtt = null;
  try {
    vtt = track.source === "external"
      ? await subtitlesLib().vttText({ subPath: track._path })
      : await subtitlesLib().vttText({ videoPath: file, trackIndex: track._index });
  } catch { vtt = null; }
  if (vtt == null) return fail(res, "internal", "The subtitle could not be read.");
  const cues = subsyncLib().parse(vtt);
  if (!cues.length) {
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    return res.send(vtt);
  }
  res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
  res.send(subsyncLib().toSrt(cues));
});

// ---------- 7. the file, with Range ----------
const MIME = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo", ".mov": "video/quicktime", ".ts": "video/mp2t", ".m2ts": "video/mp2t", ".wmv": "video/x-ms-wmv", ".mpg": "video/mpeg", ".mpeg": "video/mpeg" };
router.get(`${BASE}/items/:id/file`, (req, res) => {
  const hit = find(req.params.id);
  if (!hit || hit.kind === "show") return fail(res, "not_found", `No item with id ${String(req.params.id).slice(0, 64)}`);
  const file = fileOf(hit.item.id);
  if (!file) return fail(res, "not_found", "This item has no file.");
  if (driveDown(file)) return fail(res, "busy", "The drive this file is on is not answering right now.", { retryAfter: 60 });
  const st = rangeserve.statOf(file);
  if (!st) return fail(res, "not_found", "The file is not on disk.");
  try { require("../lib/inuse").touch(hit.item.id); } catch {}
  const total = st.size;
  const etag = rangeserve.etagOf(st);
  const lastModified = rangeserve.lastModifiedOf(st);
  const common = {
    "Accept-Ranges": "bytes",
    "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    ETag: etag,
    "Last-Modified": lastModified,
    "Cache-Control": "private, no-store",
  };
  let range = rangeserve.parseRange(req.headers.range, total);
  if (!range.none && !rangeserve.ifRangeOk(req.headers, etag, lastModified)) range = { none: true };
  if (range.unsatisfiable) {
    res.setHeader("Content-Range", `bytes */${total}`);
    res.setHeader("Accept-Ranges", "bytes");
    return fail(res, "range_not_satisfiable", `The file is ${total} bytes long.`);
  }
  const start = range.none ? 0 : range.start;
  const end = range.none ? total - 1 : range.end;
  if (range.none) res.writeHead(200, { ...common, "Content-Length": total });
  else res.writeHead(206, { ...common, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": end - start + 1 });
  if (req.method === "HEAD" || total === 0) return res.end();
  rangeserve.watch(res);
  const s = fs.createReadStream(file, { start, end, highWaterMark: 1024 * 1024 });
  s.on("error", () => { rangeserve.forgetStat(file); res.destroy(); });
  s.pipe(res);
  res.on("close", () => s.destroy());
});

// ---------- 8. poster ----------
const posterFileOf = (cover) => {
  if (!cover) return null;
  let m = /^\/img\/meta\/([^/?#]+)/.exec(cover);
  if (m) { try { return onlineLib().posterFile(decodeURIComponent(m[1])); } catch { return null; } }
  m = /^\/img\/([A-Za-z0-9_-]+)$/.exec(cover);
  if (m) {
    const entry = scanner.resolve(m[1]);
    return entry && entry.kind === "image" ? entry.path : null;
  }
  return null;
};
const IMG_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif" };
router.get(`${BASE}/items/:id/poster`, async (req, res) => {
  const hit = find(req.params.id);
  if (!hit) return fail(res, "not_found", `No item with id ${String(req.params.id).slice(0, 64)}`);
  const cover = hit.kind === "episode" ? hit.show.cover : hit.item.cover;
  const src = posterFileOf(cover);
  if (!src || !fs.existsSync(src)) return fail(res, "not_found", "No poster for this item.");
  let out = src;
  const w = parseInt(req.query.w, 10);
  if (w > 0) {
    try { out = (await require("../lib/imgvariant").variant(src, Math.min(w, 2000), {})) || src; } catch { out = src; }
  }
  const type = IMG_MIME[path.extname(out).toLowerCase()];
  if (!type || out.endsWith(".avif")) out = src; // JPEG/PNG/WebP only
  res.setHeader("Content-Type", IMG_MIME[path.extname(out).toLowerCase()] || "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(out, (err) => { if (err && !res.headersSent) fail(res, "not_found", "No poster for this item."); });
});

// ---------- O1 / O2: ffmpeg cuts ----------
// A few at a time (they are light — the video is copied, only the sound is
// converted — but each reads a stretch of a file), below normal priority so
// a cut never takes the CPU from somebody's film.
const MAX_JOBS = 3;
let jobs = 0;
const audioIndexOf = (req, meta) => {
  const n = req.query.audioTrack == null || req.query.audioTrack === "" ? 0 : parseInt(req.query.audioTrack, 10);
  const count = ((meta && meta.audioStreams) || []).length;
  if (!Number.isFinite(n) || n < 0) return { error: "audioTrack must be a track index from /v1/items/{id}." };
  if (meta && count && n >= count) return { error: `This item has ${count} audio track${count === 1 ? "" : "s"} (0–${count - 1}).` };
  return { n, none: !!meta && count === 0 };
};
const runCut = (req, res, args, type, label) => {
  if (!config.ffmpegAvailable) return fail(res, "internal", "ffmpeg is not available on this server.");
  if (jobs >= MAX_JOBS) return fail(res, "busy", "The server is already cutting other parts — try again in a moment.", { retryAfter: 5 });
  // HEAD: the type is the answer — nothing is cut
  if (req.method === "HEAD") { res.writeHead(200, { "Content-Type": type, "Cache-Control": "private, no-store" }); return res.end(); }
  jobs++;
  let done = false;
  const finish = () => { if (!done) { done = true; jobs--; } };
  let proc;
  try {
    proc = spawn(config.FFMPEG, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    finish();
    return fail(res, "internal", "ffmpeg could not be started.");
  }
  try { require("../lib/children").track(proc, `clipwave-${label}`); } catch {}
  try { if (proc.pid) require("os").setPriority(proc.pid, require("os").constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  let err = "";
  proc.stderr.on("data", (d) => { err = (err + d.toString()).slice(-2000); });
  let started = false;
  proc.stdout.once("data", () => {
    started = true;
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "private, no-store" });
  });
  proc.stdout.on("data", (d) => { if (!res.write(d)) { proc.stdout.pause(); res.once("drain", () => proc.stdout.resume()); } });
  proc.on("error", () => { finish(); if (!started) fail(res, "internal", "ffmpeg failed."); else res.destroy(); });
  proc.on("close", (code) => {
    finish();
    if (!started) {
      console.warn(`[clipwave] ${label} failed (${code}): ${err.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
      return fail(res, "internal", "The cut could not be made from this file.");
    }
    if (code === 0) res.end(); else res.destroy();
  });
  res.on("close", () => {
    if (proc.exitCode == null && proc.signalCode == null) { try { require("../lib/children").killNow(proc); } catch { try { proc.kill("SIGKILL"); } catch {} } }
  });
};

router.get(`${BASE}/items/:id/clip`, (req, res) => {
  const hit = find(req.params.id);
  if (!hit || hit.kind === "show") return fail(res, "not_found", `No item with id ${String(req.params.id).slice(0, 64)}`);
  const file = fileOf(hit.item.id);
  if (!file || !rangeserve.statOf(file)) return fail(res, "not_found", "This item has no file.");
  if (driveDown(file)) return fail(res, "busy", "The drive this file is on is not answering right now.", { retryAfter: 60 });
  const start = Number(req.query.start);
  const end = Number(req.query.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return fail(res, "bad_request", "start and end are seconds, with end after start.");
  if (end - start > MAX_CLIP_S) return fail(res, "bad_request", `A clip is at most ${MAX_CLIP_S} seconds.`);
  const meta = metaOf(file);
  if (meta && meta.duration > 0 && start >= meta.duration) return fail(res, "bad_request", `start is past the end (${Math.floor(meta.duration)} s).`);
  const a = audioIndexOf(req, meta);
  if (a.error) return fail(res, "bad_request", a.error);
  try { require("../lib/inuse").touch(hit.item.id); } catch {}
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-ss", String(start), "-i", file, "-t", String(Math.round((end - start) * 1000) / 1000),
    "-map", "0:v:0", ...(a.none ? [] : ["-map", `0:a:${a.n}?`]),
    "-c:v", "copy", ...(a.none ? [] : ["-c:a", "aac", "-ac", "2", "-b:a", "192k"]),
    "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "pipe:1",
  ];
  runCut(req, res, args, "video/mp4", "clip");
});

router.get(`${BASE}/items/:id/audio`, async (req, res) => {
  const hit = find(req.params.id);
  if (!hit || hit.kind === "show") return fail(res, "not_found", `No item with id ${String(req.params.id).slice(0, 64)}`);
  const file = fileOf(hit.item.id);
  if (!file || !rangeserve.statOf(file)) return fail(res, "not_found", "This item has no file.");
  if (!(await hasOpus())) return fail(res, "not_found", "This server's ffmpeg cannot make Opus audio — use /file with Range instead.");
  if (driveDown(file)) return fail(res, "busy", "The drive this file is on is not answering right now.", { retryAfter: 60 });
  const meta = metaOf(file);
  const a = audioIndexOf(req, meta);
  if (a.error) return fail(res, "bad_request", a.error);
  if (a.none) return fail(res, "bad_request", "This item has no audio track.");
  try { require("../lib/inuse").touch(hit.item.id); } catch {}
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", file, "-map", `0:a:${a.n}`, "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-application", "voip",
    "-map_metadata", "-1", "-f", "ogg", "pipe:1",
  ];
  runCut(req, res, args, "audio/ogg", "audio");
});

// anything else under /clipwave: the same error shape
router.use("/clipwave", (req, res) => fail(res, "not_found", `No such endpoint: ${req.method} ${req.path.slice(0, 100)}`));

// ---------- the admin's keys (admin panel → Server → Clipwave access) ----------
const adminOnly = (req, res, next) => (realtime.isAdmin(req) ? next() : res.status(403).json({ error: "Admin access required" }));
router.get("/api/admin/clipwave/tokens", adminOnly, (req, res) => {
  res.json({ tokens: tokens.list(), max: tokens.MAX_TOKENS, path: "/clipwave", publicUrl: config.PUBLIC_URL || null });
});
router.post("/api/admin/clipwave/tokens", adminOnly, (req, res) => {
  const r = tokens.create(req.body && req.body.name);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ token: r.token, entry: r.entry });
});
router.delete("/api/admin/clipwave/tokens/:id", adminOnly, (req, res) => {
  if (!tokens.remove(req.params.id)) return res.status(404).json({ error: "No such key" });
  res.json({ ok: true });
});

router._internals = { search, norm, scoreOf, subtitleTracksOf, audioTracksOfMeta, find, jobs: () => jobs, resetOpus: (v = null) => { opusKnown = v; } };
module.exports = router;

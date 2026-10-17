// More than one copy of the same title (elia 2026-10-17: "if we have multiple
// downloads of the same movie/episode we should show that to the admin and
// give him the ability to delete specific ones").
//
// A title can be on the server twice in two ways, and the admin sees both:
//   • as FILES: a 720p and a 1080p of one film in its folder (the scanner
//     indexes only the first video of a movie folder — the other one is
//     invisible everywhere else), two folders that are the same film, or two
//     files of one episode (a show's folders are merged by the scanner, so
//     "S01E03" can be listed twice in one season);
//   • as DOWNLOAD JOBS: a second download of something already on disk, or
//     two jobs that wrote the same file one over the other.
//
// "The same title" is the identity watch history already uses
// (identity.titleKeyFor): the IMDb id for a film, IMDb id + season + episode
// for an episode — and, for a title whose id is not known, the film's
// normalized name + year, or the library show + season + episode.
//
// group() is pure (tests feed it plain rows); collect() reads the live
// library, the downloads queue, every profile's progress and lib/inuse.js.
// Deleting is resolve() + the route in routes/admin.js; the rules for which
// copy may go live in deletable() so they can be pinned by tests.
const fs = require("fs");
const path = require("path");

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const LIVE = ["pending", "approved", "downloading", "done"];

// Paths compare the way the file system does: case-blind on Windows.
const samePath = (a, b) => {
  if (!a || !b) return false;
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

// "1080p" from what the file really is (its probed height), else from its
// name, else from what the download said it was.
const qualityOf = (height, name, fallback) => {
  const h = Number(height) || 0;
  if (h >= 1600) return "2160p";
  if (h >= 900) return "1080p";
  if (h >= 650) return "720p";
  if (h >= 520) return "576p";
  if (h > 0) return "480p";
  const m = /(2160|1440|1080|720|576|480)p/i.exec(String(name || ""));
  if (m) return `${m[1]}p`;
  if (/\b4k\b|uhd/i.test(String(name || ""))) return "2160p";
  return fallback || null;
};

// ---------- the pure part ----------

// files: [{ key, kind: "movie"|"episode", title, year, showTitle, season,
//           episode, cover, abs, ref, display, fileName, sizeBytes, addedAt,
//           libraryId, indexed, quality, streaming, midway, watched }]
// jobs:  [{ key, id, status, destPath, by, quality, release, provider,
//           sizeBytes, at, doneAt, label, title, type, season, episode, poster }]
// → the groups with more than one copy or more than one download, biggest
//   wasted space first. A job that wrote a file still on disk rides on that
//   file's row (`jobs`); one that has not (yet) is listed on its own.
const group = (files, jobs) => {
  const byKey = new Map();
  const g = (key, seed) => {
    let x = byKey.get(key);
    if (!x) {
      x = {
        key,
        kind: seed.kind,
        title: seed.kind === "episode" ? seed.showTitle || seed.title : seed.title,
        year: seed.year || null,
        season: seed.kind === "episode" ? seed.season : null,
        episode: seed.kind === "episode" ? seed.episode : null,
        episodeTitle: seed.kind === "episode" ? seed.title || null : null,
        cover: seed.cover || null,
        copies: [],
        downloads: [],
      };
      byKey.set(key, x);
    }
    return x;
  };
  for (const f of files) g(f.key, f).copies.push({ ...f, jobs: [] });
  for (const j of jobs) {
    if (!LIVE.includes(j.status)) continue;
    // A finished job belongs to the file it wrote.
    if (j.status === "done" && j.destPath) {
      let home = null;
      for (const x of byKey.values()) {
        home = x.copies.find((c) => samePath(c.abs, j.destPath));
        if (home) break;
      }
      if (home) { home.jobs.push(j); continue; }
      // (a finished job whose file is gone is history the queue prunes itself)
      continue;
    }
    if (!j.key) continue;
    const x = byKey.get(j.key) || g(j.key, {
      kind: j.type === "show" ? "episode" : "movie",
      title: j.type === "show" ? null : j.title,
      showTitle: j.title, year: j.year, season: j.season, episode: j.episode, cover: j.poster,
    });
    x.downloads.push(j);
  }
  const out = [];
  for (const x of byKey.values()) {
    const nJobs = x.copies.reduce((n, c) => n + c.jobs.length, 0) + x.downloads.length;
    // More than one copy: files plus downloads that have not written one
    // (yet) — or one file that two finished downloads wrote over each other.
    if (x.copies.length + x.downloads.length < 2 && !x.copies.some((c) => c.jobs.length > 1)) continue;
    // Two files of one episode can carry two different names ("Pilot" and
    // "Show 1080p WEB", from the file names): only a name they agree on is shown.
    if (x.kind === "episode" && new Set(x.copies.map((c) => c.title)).size > 1) x.episodeTitle = null;
    x.files = x.copies.length;
    x.jobs = nJobs;
    x.sizeBytes = x.copies.reduce((n, c) => n + (c.sizeBytes || 0), 0);
    // The space a tidy-up could give back: everything but the biggest copy.
    x.spareBytes = x.copies.length > 1 ? x.sizeBytes - Math.max(...x.copies.map((c) => c.sizeBytes || 0)) : 0;
    x.copies.sort((a, b) => (b.indexed ? 1 : 0) - (a.indexed ? 1 : 0) || (b.sizeBytes || 0) - (a.sizeBytes || 0));
    out.push(x);
  }
  out.sort((a, b) => b.spareBytes - a.spareBytes || b.files - a.files || String(a.title).localeCompare(String(b.title)));
  return out;
};

// May this copy go? { ok } or { ok: false, code, error } — the rules:
//   • someone is playing it right now: never (409 "streaming");
//   • it is the LAST copy on disk of its title: only with confirmLast
//     (409 "last-copy" without it — the page then asks the stronger question).
const deletable = (grp, copy, { confirmLast = false } = {}) => {
  if (copy.streaming) {
    return { ok: false, code: "streaming", error: "Someone is playing this copy right now — try again when they have stopped." };
  }
  if (grp.files <= 1 && !confirmLast) {
    return { ok: false, code: "last-copy", error: "This is the only copy of this title on disk. Deleting it removes the title from the library." };
  }
  return { ok: true };
};

// ---------- refs: how the page names a file ----------
// "<movies|shows>:<root index>:<path inside that root>". Only ever turned back
// into a path by resolveRef, which refuses anything that is not a video file
// strictly inside that library root — after following links.
const refOf = (kind, rootIndex, root, abs) => `${kind}:${rootIndex}:${path.relative(root, abs).split(path.sep).join("/")}`;

const inside = (root, abs) => {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

// → { abs, root, kind } or { error }. `libraries` is config.LIBRARIES.
const resolveRef = (ref, libraries, videoExts) => {
  const m = /^(movies|shows):(\d{1,3}):(.+)$/s.exec(String(ref || ""));
  if (!m) return { error: "bad ref" };
  const [, kind, idx, relRaw] = m;
  const root = ((libraries && libraries[kind]) || [])[Number(idx)];
  if (!root) return { error: "no such library folder" };
  if (relRaw.includes("\0") || path.isAbsolute(relRaw) || /^[a-z]:/i.test(relRaw)) return { error: "Refusing a path outside the library" };
  const parts = relRaw.split(/[\\/]/);
  if (parts.some((p) => p === ".." || p === "." || p === "")) return { error: "Refusing a path outside the library" };
  const abs = path.resolve(root, ...parts);
  if (!inside(root, abs)) return { error: "Refusing a path outside the library" };
  if (!(videoExts || []).includes(path.extname(abs).toLowerCase())) return { error: "Not a video file" };
  let real;
  try { real = fs.realpathSync(abs); } catch { return { error: "File not found", notFound: true }; }
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return { error: "The library folder cannot be read" }; }
  if (!inside(realRoot, real)) return { error: "Refusing a path outside the library" };
  return { abs, root, kind };
};

// ---------- the live part ----------
const collect = () => {
  const config = require("../config");
  const scanner = require("./scanner");
  const identity = require("./identity");
  const metadata = require("./metadata");
  const profiles = require("../profiles");
  const inuse = require("../lib/inuse");
  const downloads = require("./downloads");

  const keys = identity.ensureStamped();
  const movieKey = (m) => keys.get(m.id) || `m:${norm(m.title)}:${m.year || ""}`;
  const epKey = (show, ep) => keys.get(ep.id) || (show.imdbId ? `${show.imdbId}:${Number(ep.season)}:${Number(ep.episode)}` : `e:${show.id}:${Number(ep.season)}:${Number(ep.episode)}`);

  // per library id: profiles part-way / finished
  const midway = new Map();
  const watched = new Map();
  for (const p of profiles.list()) {
    const prog = profiles.getProgress(p.id) || {};
    for (const [id, pr] of Object.entries(prog)) {
      if (!pr) continue;
      if (pr.finished) watched.set(id, (watched.get(id) || 0) + 1);
      else if ((pr.position || 0) > 60) midway.set(id, (midway.get(id) || 0) + 1);
    }
  }
  const rootOf = (abs) => {
    for (const kind of ["movies", "shows"]) {
      const roots = config.LIBRARIES[kind] || [];
      for (let i = 0; i < roots.length; i++) if (inside(roots[i], abs)) return { kind, i, root: roots[i] };
    }
    return null;
  };
  // Sizes and dates come from the scan for indexed files (no I/O per file —
  // a household library is thousands of them); only the unindexed extra
  // videos of a movie folder are stat'ed.
  const fileRow = (abs, base, known) => {
    const r = rootOf(abs);
    if (!r) return null;
    let size = known ? known.sizeBytes : 0;
    let addedAt = known ? known.addedAt : 0;
    if (!known) {
      try { const st = fs.statSync(abs); size = st.size; addedAt = st.mtimeMs; } catch { return null; }
    }
    const libraryId = known ? known.id : null;
    const meta = metadata.getCached(abs);
    return {
      ...base,
      abs,
      ref: refOf(r.kind, r.i, r.root, abs),
      display: path.relative(r.root, abs).split(path.sep).join("/"),
      fileName: path.basename(abs),
      sizeBytes: size || 0,
      addedAt: addedAt || 0,
      libraryId,
      indexed: !!libraryId,
      quality: qualityOf(known ? known.height : meta && meta.height, path.basename(abs), null),
      streaming: libraryId ? inuse.streamingNow(libraryId) : false,
      lastPlayedAt: libraryId ? inuse.lastAt(libraryId) || null : null,
      midway: libraryId ? midway.get(libraryId) || 0 : 0,
      watched: libraryId ? watched.get(libraryId) || 0 : 0,
    };
  };

  const files = [];
  for (const m of scanner.index.movies) {
    const entry = scanner.resolve(m.id);
    if (!entry) continue;
    const base = { key: movieKey(m), kind: "movie", title: m.title, year: m.year || null, cover: m.cover || null };
    const row = fileRow(entry.path, base, m);
    if (row) files.push(row);
    for (const other of scanner.otherVideosOf(m.id)) {
      const extra = fileRow(other, base, null);
      if (extra) files.push(extra);
    }
  }
  for (const s of scanner.index.shows) {
    for (const se of s.seasons || []) {
      for (const ep of se.episodes || []) {
        const entry = scanner.resolve(ep.id);
        if (!entry) continue;
        const row = fileRow(entry.path, {
          key: epKey(s, ep), kind: "episode", title: ep.title, showTitle: s.title, year: s.year || null,
          season: ep.season, episode: ep.episode, cover: s.cover || null,
        }, ep);
        if (row) files.push(row);
      }
    }
  }

  const jobs = [];
  for (const j of downloads.rawJobs()) {
    if (!LIVE.includes(j.status)) continue;
    let key = null;
    if (!(j.status === "done" && j.destPath)) {
      const lib = identity.findLibraryFor({ imdbId: j.imdbId, type: j.type, title: j.title, year: j.year });
      if (j.type === "show") {
        const s = Number(j.season) || 1;
        const e = Number(j.episode) || 1;
        key = lib && lib.type === "show"
          ? (lib.imdbId ? `${lib.imdbId}:${s}:${e}` : `e:${lib.id}:${s}:${e}`)
          : j.imdbId ? `${j.imdbId}:${s}:${e}` : `e:n:${norm(j.title)}:${s}:${e}`;
      } else {
        key = lib && lib.type === "movie" ? movieKey(lib) : j.imdbId || `m:${norm(j.title)}:${j.year || ""}`;
      }
    }
    const pj = downloads.publicJob(j);
    jobs.push({
      key, id: j.id, status: j.status, destPath: j.destPath || null, type: j.type,
      title: j.title, label: j.label || null, year: j.year || null, season: j.season || null, episode: j.episode || null,
      poster: j.poster || null, by: pj.by || null, quality: j.quality || null, release: j.release || null,
      provider: j.provider || null, sizeBytes: j.sizeBytes || 0, progress: j.progress || 0,
      at: j.at || null, doneAt: j.doneAt || null, smart: !!j.smart, auto: j.auto || null,
    });
  }
  return { files, jobs };
};

// The groups for the admin page: paths stay server-side (each copy carries
// its `ref` and a display path relative to its library folder instead).
const view = () => {
  const { files, jobs } = collect();
  return group(files, jobs).map((x) => ({
    ...x,
    copies: x.copies.map(({ abs, key, ...c }) => ({ ...c, jobs: c.jobs.map(({ destPath, key: _k, ...j }) => j) })),
    downloads: x.downloads.map(({ destPath, key: _k, ...j }) => j),
  }));
};

// The live group + copy a ref names, or null when that file is no longer one
// of a title's copies.
const findCopy = (abs) => {
  const { files, jobs } = collect();
  for (const grp of group(files, jobs)) {
    const copy = grp.copies.find((c) => samePath(c.abs, abs));
    if (copy) return { grp, copy };
  }
  return null;
};

module.exports = { view, collect, group, deletable, resolveRef, findCopy, refOf, qualityOf, samePath, _internals: { norm, inside } };

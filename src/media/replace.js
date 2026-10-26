// "Problem with this copy? → Get another version" (elia, 2026-10-26: "weird
// burned-in subtitles came up, and I could not download any other version,
// and I could not delete the movie and download another version because
// that would require me to use admin").
//
// A person — any grown-up profile, no admin — says what is wrong with the
// copy in the library (one tap: burned-in subtitles, bad picture, bad sound,
// wrong language, other), picks another source of the SAME title, and that
// download REPLACES the copy:
//
//   * until the new file is complete, the old copy is untouched and plays;
//   * once it is, the old file (and its sidecar subtitles) is removed and the
//     new one put in its place under the old file's name — and under the old
//     LIBRARY ID (media/idpins.js), so watch progress, My List, ratings, Up
//     Next and every link to the title carry on as they were;
//   * while somebody is playing the old copy, the swap waits (the new file
//     sits finished beside it, hidden) and frees its download slot meanwhile;
//   * Cancel at any point leaves everything as it was;
//   * a failed download leaves the old copy where it is.
//
// The safety rules, all here:
//   * only ever a REPLACEMENT: the old file is removed in the same step that
//     puts a complete, size-checked new file in its place — a person can
//     never delete a title this way;
//   * the new source must be one the source list offers for THIS title (the
//     server looks it up again; a client cannot slip another film in), and
//     never the release that is being replaced;
//   * kids profiles cannot; a profile must be named (and, with sign-in
//     closed, be the session's own); torrents must be on;
//   * one replacement at a time per title (per episode);
//   * it is a person's download like any other: the disk gate, the queue and
//     the per-account limit ("3 at once") apply unchanged.
//
// What the admin sees: every request in data/replacements.json (who, what,
// why, from which release to which, how it ended) — the Inbox's "Replaced
// copies", the person's sheet, the download row ("Another version ·
// Burned-in subtitles"), and a line in "Problem reports" with the reason.
// The reason is also remembered against the old release (media/badreleases.js),
// so nothing automatic picks it again.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");
const scanner = require("./scanner");
const badreleases = require("./badreleases");
const idpins = require("./idpins");
const lazy = require("../lib/lazy");
const downloadsLib = lazy(require, "./downloads");
const torrentLib = lazy(require, "./torrent");
const identityLib = lazy(require, "./identity");
const dlraceLib = lazy(require, "./dlrace");

const log = new JsonStore(path.join(config.DATA_DIR, "replacements.json"), { list: [] });
const MAX_LOG = 400;
const LIVE = ["pending", "approved", "downloading"];

// What a test replaces (never a running server).
const seams = {
  inUse: (p) => require("../lib/fileinuse").fileInUse(p),
  sources: (s) => torrentLib().getSources(s.type === "show" ? "series" : "movie", s.imdbId, s.year, s.season, s.episode),
  waitMs: 15 * 1000,     // while somebody plays the old copy: look again this often
  busyMs: 250,           // Windows: a file the server's own readers hold — tried again this soon…
  busyTries: 40,         // …this many times, then it counts as "in use" and waits its turn
  clock: () => Date.now(),
};
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (ms > 1000) t.unref?.(); });

const entries = () => {
  if (!log.data || !Array.isArray(log.data.list)) log.data = { list: [] };
  return log.data.list;
};
const entryById = (id) => entries().find((e) => e.id === id) || null;

const samePath = (a, b) => idpins.norm(a) === idpins.norm(b);
const roots = () => [...(config.LIBRARIES.movies || []), ...(config.LIBRARIES.shows || [])];
const insideRoots = (p) => roots().some((r) => {
  const rel = path.relative(path.resolve(r), path.resolve(p));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
});
const qualityOf = (h) => (h >= 2000 ? "2160p" : h >= 1000 ? "1080p" : h >= 700 ? "720p" : h >= 460 ? "480p" : h > 0 ? "SD" : null);

// ---------- what is being replaced ----------
// A library id → the file, the title it is and the identity its sources are
// looked up by. { error, code, status } when it cannot be replaced at all.
const subjectOf = (libraryId) => {
  const id = String(libraryId || "");
  const entry = id ? scanner.resolve(id) : null;
  const item = entry && entry.kind === "video" ? scanner.findById(id) : null;
  if (!item || !entry.path) return { error: "That title isn't in the library any more.", code: "gone", status: 404 };
  if (!insideRoots(entry.path)) return { error: "That file isn't inside a library folder.", code: "outside", status: 400 };
  try { identityLib().ensureStamped(); } catch {}
  if (item.showId) {
    const show = scanner.findById(item.showId);
    if (!show) return { error: "That title isn't in the library any more.", code: "gone", status: 404 };
    return {
      libraryId: id, path: entry.path, item, type: "show", imdbId: show.imdbId || null, title: show.title, year: show.year || null,
      season: item.season, episode: item.episode, showId: show.id, cover: show.cover || null,
      display: `${show.title} · S${item.season} E${item.episode}`,
    };
  }
  return { libraryId: id, path: entry.path, item, type: "movie", imdbId: item.imdbId || null, title: item.title, year: item.year || null, season: null, episode: null, cover: item.cover || null, display: item.title };
};

const titleKeyOf = (s) => {
  try { return dlraceLib().titleKey({ imdbId: s.imdbId, type: s.type, season: s.season, episode: s.episode }); } catch { return null; }
};

// The copy in the library now: the download that wrote this file, when one
// did (its source and release name), and what the file itself says.
const currentOf = (s) => {
  let job = null;
  try {
    job = downloadsLib().rawJobs()
      .filter((j) => j.status === "done" && j.destPath && samePath(j.destPath, s.path))
      .sort((a, b) => String(b.doneAt || "").localeCompare(String(a.doneAt || "")))[0] || null;
  } catch {}
  return {
    infoHash: job && job.infoHash ? String(job.infoHash).toLowerCase() : null,
    release: (job && job.release) || null,
    provider: (job && job.provider) || null,
    quality: (job && job.quality) || qualityOf(s.item.height || 0),
    sizeBytes: s.item.sizeBytes || 0,
    fileName: path.basename(s.path),
    jobId: job ? job.id : null,
  };
};
const isCurrent = (cur, src) => {
  if (!cur || !src) return false;
  if (cur.infoHash && String(src.infoHash || "").toLowerCase() === cur.infoHash) return true;
  const rk = badreleases._internals.relKey;
  return !!(cur.release && src.release && rk(cur.release) === rk(src.release));
};

const liveJobFor = (libraryId) => {
  try {
    return downloadsLib().rawJobs().find((j) => j.replaces && j.replaces.libraryId === libraryId && LIVE.includes(j.status)) || null;
  } catch { return null; }
};

// The replacement as the apps see it (who asked stays a name; "mine" per viewer).
const publicOf = (e, job, viewer) => {
  if (!e && !job) return null;
  const r = (job && job.replaces) || {};
  const status = job ? job.status : e.status;
  return {
    id: (e && e.id) || r.id || null,
    libraryId: (e && e.libraryId) || r.libraryId || null,
    reason: (e && e.reason) || r.reason || "other",
    reasonLabel: badreleases.reasonLabel((e && e.reason) || r.reason),
    status,
    phase: job ? job.phase || null : null,
    progress: job ? job.progress || 0 : status === "done" ? 1 : 0,
    // finished, and waiting for nobody to be playing the old copy
    waiting: !!(job && job.replaceWait),
    jobId: (job && job.id) || (e && e.jobId) || null,
    by: (e && e.byName) || r.byName || null,
    mine: !!(viewer && viewer.id && ((e && e.by === viewer.id) || r.by === viewer.id)),
    at: (e && e.at) || null,
    quality: (job && job.quality) || (e && e.new && e.new.quality) || null,
    sizeBytes: (job && job.sizeBytes) || (e && e.new && e.new.sizeBytes) || 0,
    release: (job && job.release) || (e && e.new && e.new.release) || null,
  };
};

// ---------- who may ----------
// → null when this viewer may replace this title's copy, else { error, code, status }.
const refusal = (viewer, s, { kids = null } = {}) => {
  const profiles = require("../profiles");
  if (!viewer || !viewer.id || !profiles.list().some((p) => p.id === viewer.id)) {
    return { error: "Pick a profile first.", code: "profile", status: 403 };
  }
  if (kids || profiles.kidsOf(viewer.id)) return { error: "A kids profile can't replace a copy.", code: "kids", status: 403 };
  const gate = require("../lib/torrentgate");
  if (!gate.enabled()) return { error: gate.MESSAGE, code: "torrents-off", status: 403 };
  if (s.error) return s;
  if (!titleKeyOf(s)) {
    return { error: "This title isn't matched to a catalogue entry, so other versions can't be looked up.", code: "unmatched", status: 409 };
  }
  return null;
};

// GET: what the sheet needs before anything is chosen.
const view = (libraryId, viewer, opts = {}) => {
  const s = subjectOf(libraryId);
  if (s.error) return { status: s.status, body: { error: s.error, code: s.code } };
  const job = liveJobFor(s.libraryId);
  const e = job && job.replaces ? entryById(job.replaces.id) : null;
  const no = refusal(viewer, s, opts);
  return {
    status: 200,
    body: {
      item: { id: s.libraryId, type: s.type === "show" ? "episode" : "movie", title: s.title, display: s.display, season: s.season, episode: s.episode, showId: s.showId || null, imdbId: s.imdbId },
      current: (({ jobId, ...c }) => c)(currentOf(s)),
      active: job ? publicOf(e, job, viewer) : null,
      can: !no && !job,
      why: no ? no.error : job ? "Another version of this is already on its way." : null,
      code: no ? no.code : job ? "busy" : null,
      reasons: badreleases.REASONS,
    },
  };
};

// GET …/sources: the title's sources in the usual order (★ BEST and all —
// torrent.getSources ranks them, the history and the bad releases nudge
// them), the copy being replaced left out.
const sources = async (libraryId, viewer, opts = {}) => {
  const s = subjectOf(libraryId);
  const no = refusal(viewer, s, opts);
  if (no) return { status: no.status, body: { error: no.error, code: no.code } };
  const cur = currentOf(s);
  let found;
  try { found = await seams.sources(s); } catch (e) {
    return { status: 502, body: { error: (e && e.message) || "Couldn't reach the source provider.", code: "provider" } };
  }
  let streams = ((found && found.streams) || []).filter((x) => x && x.infoHash && !isCurrent(cur, x));
  // dead torrents out, but only when the provider reports seeders at all
  if (streams.some((x) => x.seeders > 0)) streams = streams.filter((x) => x.seeders > 0);
  // (the ★ pick may have been the copy being replaced: it moves to the next
  // good one — the same rule as torrent.js markBest: never a pre-release copy
  // or a dub (media/releasekind.js), never a release reported bad here, a
  // clean copy before one with burned-in subtitles; none at all when every
  // copy left is a cinema recording)
  if (!streams.some((x) => x.recommended)) {
    const ok = (x) => require("./releasekind").pickable(x) && !x.badHere;
    const best = streams.find((x) => ok(x) && !x.hardsub) || streams.find(ok);
    if (best) streams = streams.map((x) => (x === best ? { ...x, recommended: true } : x));
  }
  return { status: 200, body: { streams, current: (({ jobId, ...c }) => c)(cur) } };
};

// POST: ask for it. body { reason, note, source: { infoHash, fileIdx } }.
const request = async (libraryId, viewer, { reason, note, source, context, ip, kids = null } = {}) => {
  const s = subjectOf(libraryId);
  const no = refusal(viewer, s, { kids });
  if (no) return { status: no.status, body: { error: no.error, code: no.code } };
  if (liveJobFor(s.libraryId)) return { status: 409, body: { error: "Another version of this is already on its way.", code: "busy" } };
  if (!badreleases.validReason(reason)) return { status: 400, body: { error: "Say what's wrong with this copy.", code: "reason" } };
  const hash = String((source && source.infoHash) || "").toLowerCase();
  if (!/^[a-z0-9]{32,40}$/.test(hash)) return { status: 400, body: { error: "Pick a version to get.", code: "source" } };
  const fileIdx = Number((source && source.fileIdx) || 0) || 0;
  const cur = currentOf(s);
  // The source is looked up again: it has to be one THIS title offers.
  let found;
  try { found = await seams.sources(s); } catch (e) {
    return { status: 502, body: { error: (e && e.message) || "Couldn't reach the source provider.", code: "provider" } };
  }
  const src = ((found && found.streams) || []).find((x) => String(x.infoHash || "").toLowerCase() === hash && (x.fileIdx || 0) === fileIdx);
  if (!src) return { status: 400, body: { error: "That version isn't one of this title's sources any more — pick again.", code: "source" } };
  if (isCurrent(cur, src)) return { status: 400, body: { error: "That is the copy you have now — pick another one.", code: "same" } };
  // (re-checked after the lookup: two presses in a row, two devices)
  if (liveJobFor(s.libraryId)) return { status: 409, body: { error: "Another version of this is already on its way.", code: "busy" } };

  const id = crypto.randomBytes(6).toString("hex");
  const label = badreleases.reasonLabel(reason);
  const cleanNote = String(note || "").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  const key = titleKeyOf(s);
  const r = downloadsLib().create({
    infoHash: src.infoHash, fileIdx: src.fileIdx || 0, type: s.type, imdbId: s.imdbId, title: s.title, year: s.year,
    season: s.season, episode: s.episode, poster: null, quality: src.quality, sizeBytes: src.sizeBytes,
    provider: src.provider, seeders: src.seeders, release: src.release,
    label: `${s.display} — another version`,
    profile: viewer.id, profileName: viewer.name,
    replaces: {
      id, libraryId: s.libraryId, path: s.path, reason, reasonLabel: label, by: viewer.id, byName: viewer.name || null,
      oldRelease: cur.release, oldInfoHash: cur.infoHash, titleKey: key,
    },
  });
  if (!r || r.error || !r.job) {
    return { status: 400, body: { error: (r && r.error) || "Couldn't start the download.", code: "download" } };
  }
  const job = downloadsLib().rawJobs().find((j) => j.id === r.job.id);
  const e = {
    id, at: seams.clock(), by: viewer.id, byName: viewer.name || null,
    libraryId: s.libraryId, type: s.type, title: s.title, season: s.season, episode: s.episode, display: s.display,
    reason, note: cleanNote,
    old: { release: cur.release, infoHash: cur.infoHash, quality: cur.quality, sizeBytes: cur.sizeBytes, fileName: cur.fileName, provider: cur.provider },
    new: { release: src.release || null, infoHash: hash, quality: src.quality || null, sizeBytes: src.sizeBytes || 0, provider: src.provider || null },
    status: r.job.status === "pending" ? "pending" : "queued",
    jobId: r.job.id, reportId: null, endedAt: null, error: null,
  };
  entries().unshift(e);
  if (entries().length > MAX_LOG) entries().length = MAX_LOG;
  // nothing automatic picks the old release again
  if (key && (cur.infoHash || cur.release)) {
    badreleases.record(key, { infoHash: cur.infoHash, release: cur.release, reason, by: viewer.id, byName: viewer.name, rid: id }, seams.clock());
  }
  // …and it lands in "Problem reports", with the reason
  try {
    const gb = (n) => (n > 0 ? ` · ${(n / 1e9).toFixed(1)} GB` : "");
    const report = require("../routes/reports").add({
      text: `Problem with this copy: ${label}${cleanNote ? ` — ${cleanNote}` : ""}\n` +
        `Getting another version: ${src.release || src.provider || hash.slice(0, 8)}${src.quality ? ` (${src.quality}${gb(src.sizeBytes)})` : ""}` +
        `${cur.release ? `\nReplacing: ${cur.release}` : ""}`,
      profile: viewer.name || viewer.id,
      context: { ...(context && typeof context === "object" ? context : {}), title: s.display, itemId: s.libraryId },
      ip,
      extra: { kind: "replace", replace: { id, reason, libraryId: s.libraryId } },
      // (the download's own notification already says who asked, and why)
      quiet: true,
    });
    e.reportId = report.id;
  } catch (err) {
    console.warn("[replace] could not file the report:", err && err.message);
  }
  log.save();
  console.log(`[replace] ${viewer.name || viewer.id} asked for another version of "${s.display}" (${label}${cleanNote ? `: ${cleanNote}` : ""}) — ${cur.release || cur.fileName} → ${src.release || hash.slice(0, 8)}`);
  return { status: 200, body: { ok: true, replacement: publicOf(e, job, viewer), job: r.job } };
};

// Cancel: the person who asked, or the admin. Everything stays as it was.
const cancel = (libraryId, viewer, { admin = false } = {}) => {
  const job = liveJobFor(String(libraryId || ""));
  if (!job) return { status: 404, body: { error: "No other version is on its way for this title.", code: "none" } };
  if (!admin && !(viewer && viewer.id && job.replaces.by === viewer.id)) {
    return { status: 403, body: { error: `Only ${job.replaces.byName || "the person who asked"} can cancel this.`, code: "not-yours" } };
  }
  downloadsLib().cancel(job.id);
  return { status: 200, body: { ok: true } };
};

// ---------- the queue tells us how a replacement's download ended ----------
const onJob = (job) => {
  const r = job && job.replaces;
  if (!r) return;
  const e = entryById(r.id);
  if (!e) return;
  const was = e.status;
  const now = seams.clock();
  if (job.status === "done") e.status = "done";
  else if (job.status === "canceled" || job.status === "removed") e.status = "canceled";
  else if (job.status === "declined") e.status = "declined";
  else if (job.status === "error") { e.status = "failed"; e.error = job.error || null; }
  else if (job.status === "downloading") e.status = job.replaceWait ? "waiting" : "downloading";
  else e.status = job.status === "pending" ? "pending" : "queued";
  if (["done", "canceled", "declined", "failed"].includes(e.status)) e.endedAt = e.endedAt || now;
  if (e.status === was) return;
  // a cancelled replacement takes its "bad release" mark back
  if (e.status === "canceled" && r.titleKey) badreleases.unrecord(r.titleKey, r.id);
  log.save();
  const how = { done: "replaced", canceled: "cancelled — the old copy stays", declined: "declined — the old copy stays", failed: `failed (${e.error || "download failed"}) — the old copy stays` }[e.status];
  if (how) console.log(`[replace] "${e.display || e.title}": ${how}`);
};

// ---------- THE SWAP ----------
// Called by the queue (downloads.completeJob) with the new file complete and
// size-checked at `tmp`, a hidden name in the old copy's folder. Resolves to
// the path the new file now has — or null when the replacement was cancelled
// meanwhile (the caller then removes `tmp` and nothing has changed).
//   ctx: { tmp, ext, dir, base, stillWanted() → bool, waiting(on) , releaseSlot() }
const land = async (job, ctx) => {
  const r = job.replaces;
  const old = r.path;
  const libfiles = require("../lib/libfiles");
  const subExts = config.SUBTITLE_EXTENSIONS;
  const vidExts = config.VIDEO_EXTENSIONS;
  let busy = 0;
  let waited = false;
  for (;;) {
    if (!ctx.stillWanted()) return null;
    if (!fs.existsSync(old)) break; // gone already (the admin deleted it): the new one simply goes in
    if (seams.inUse(old) || busy >= seams.busyTries) {
      // Somebody is playing the old copy: it stays theirs until they stop.
      // The new file waits, finished and hidden, and gives its slot back.
      if (!waited) {
        waited = true;
        ctx.waiting(true);
        ctx.releaseSlot();
        console.log(`[replace] "${job.label || job.title}" is ready — waiting for nobody to be playing the old copy`);
      }
      busy = 0;
      await sleep(seams.waitMs);
      continue;
    }
    try {
      libfiles.deleteVideoFile(old, roots(), subExts, vidExts);
      break;
    } catch (e) {
      // the video itself went, a sidecar did not: the swap goes on
      if (!fs.existsSync(old)) break;
      if (e && /^(EBUSY|EPERM|EACCES)$/.test(e.code || "")) { busy++; await sleep(seams.busyMs); continue; }
      throw e; // a refusal or a real failure: nothing was removed, the old copy stays
    }
  }
  if (waited) ctx.waiting(false);
  // From here on the old copy is gone and the new one goes in NOW, in one
  // synchronous step (no await until it has a name).
  const want = path.join(ctx.dir, `${ctx.base}${ctx.ext}`);
  let dest = null;
  const D = downloadsLib()._internals;
  if (!D.nameTakenAny(ctx.dir, ctx.base, ctx.ext) && D.placeNoClobber(ctx.tmp, want)) dest = want;
  else {
    for (let tries = 0; tries < 99 && !dest; tries++) {
      const pick = D.landingName(ctx.dir, ctx.base, ctx.ext, { movie: false });
      if (D.placeNoClobber(ctx.tmp, pick.path)) dest = pick.path;
    }
    if (!dest) throw new Error(`could not find a free name for "${ctx.base}"`);
  }
  // The title keeps its library id: the new path is pinned to it when the
  // path (and so the id) would otherwise differ.
  const root = roots().find((rt) => {
    const rel = path.relative(path.resolve(rt), path.resolve(dest));
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  const natural = root ? scanner.makeId("video", path.relative(root, dest)) : null;
  if (natural !== r.libraryId) idpins.pin(dest, r.libraryId, old, seams.clock());
  else idpins.unpinId(r.libraryId);
  // The jobs that wrote the old file are history about a file that is gone
  // (the same rule as the admin's copy delete).
  try {
    for (const j of downloadsLib().rawJobs()) {
      if (j.id !== job.id && j.status === "done" && j.destPath && samePath(j.destPath, old)) downloadsLib().remove(j.id);
    }
  } catch {}
  // What the server knew about the old copy's intro and credits was measured
  // on the old file; the new one is measured afresh.
  try { require("./introdetect").forget(r.libraryId); } catch {}
  console.log(`[replace] "${job.label || job.title}": ${path.basename(old)} → ${path.basename(dest)} (${r.reasonLabel || r.reason}; asked by ${r.byName || r.by})`);
  return dest;
};

// ---------- for the admin ----------
const statusById = () => new Map(entries().map((e) => [e.id, { status: e.status, endedAt: e.endedAt || null, error: e.error || null }]));
const adminList = () => {
  let jobs = [];
  try { jobs = downloadsLib().rawJobs(); } catch {}
  return entries().map((e) => {
    const job = jobs.find((j) => j.id === e.jobId);
    // a replacement still on its way: where its download is NOW
    const live = job && LIVE.includes(job.status)
      ? (job.replaceWait ? "waiting" : job.status === "downloading" ? "downloading" : job.status === "pending" ? "pending" : "queued")
      : null;
    return { ...e, status: live || e.status, reasonLabel: badreleases.reasonLabel(e.reason), progress: job ? job.progress || 0 : e.status === "done" ? 1 : 0, waiting: !!(job && job.replaceWait) };
  });
};
const forProfile = (profileId) => adminList().filter((e) => e.by === profileId);

module.exports = { view, sources, request, cancel, onJob, land, statusById, adminList, forProfile, liveJobFor, subjectOf, _internals: { seams, log, entries, currentOf, isCurrent } };

// "Save it to this device too" — before the server has it (elia, 2026-11-10:
// "if we can somehow maybe schedule download to phone before it downloaded to
// the server").
//
// A WISH is one device's standing request for one title the library does not
// hold yet: a film, an episode, or "every episode of season N as it lands".
// It is keyed the way a download is keyed before a library item exists — the
// IMDb id (+ season / episode), and the download job's id when there is one.
// When the awaited download lands (downloads.js finish() → landed()), the
// wish is linked to the new library item, the copy is prepared on the server
// at the wanted quality ahead of time (as a person's request in the copy
// lane; an encode waits for its place like any other — viewers are never
// pushed aside), and the profile's devices are told (WebSocket
// "offline_wish"; web push to the one browser that asked, when it has push
// on). The device fetches its wishes whenever it is open or comes back, saves
// every ready one by itself, and says so (POST …/saved), which ends the wish.
//
// The contract (routes, shapes, states) is docs/offline-wishes.md — the
// website and the phone app build on it; change it only by adding.
//
// Rules elia set: no cap on downloads; nothing is deleted automatically. The
// store has a safety bound (MAX_PER_PROFILE, far beyond any person) only so a
// runaway client cannot grow the file without end; a failed wish stays until
// the person dismisses it (or the bound pushes the oldest failed one out).
"use strict";

const QUALITIES = ["original", "1080", "720", "480"];
const SCOPES = ["title", "season", "show"]; // "show": every new episode of the show (2026-11-10 round 2)
const DEVICE_RE = /^[A-Za-z0-9_-]{8,48}$/;
const IMDB_RE = /^tt\d{5,10}$/;
const MAX_PER_PROFILE = 500;
const KEEP_COPY_MS = 3 * 24 * 3600 * 1000; // the prepared copy waits this long for the device
const LAND_WAIT_MS = 3 * 60 * 1000; // a landed file is looked for (indexed + probed) this long
const LAND_POLL_MS = 2000;

let deps = null; // the server's wiring (realDeps), replaceable by the tests

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const newId = () => require("crypto").randomBytes(6).toString("hex");

const data = () => {
  const s = deps.store.data;
  if (!Array.isArray(s.wishes)) s.wishes = [];
  return s.wishes;
};
const save = () => deps.store.save();

// What a client sees: the wish, plus how far the server's copy is when it is
// ready (the copy's own status — a client may poll /api/offline/status too).
const publicWish = (w) => {
  const out = {
    id: w.id, profileId: w.profileId, deviceId: w.deviceId, deviceName: w.deviceName || null,
    scope: w.scope, type: w.type, imdbId: w.imdbId || null, jobId: w.jobId || null,
    season: w.season ?? null, episode: w.episode ?? null,
    title: w.title || null, showTitle: w.showTitle || null, poster: w.poster || null,
    quality: w.quality, hevc: !!w.hevc,
    state: w.state, libraryId: w.libraryId || null, readyQuality: w.readyQuality || null,
    note: w.note || null, error: w.error || null, parentId: w.parentId || null,
    createdAt: w.createdAt, updatedAt: w.updatedAt, readyAt: w.readyAt || null,
  };
  if (w.state === "ready" && w.libraryId) {
    try {
      const st = deps.offline.status(w.libraryId, w.readyQuality || w.quality, { hevc: !!w.hevc });
      out.copy = { state: st.state, progress: st.progress || (st.state === "ready" ? 1 : 0), sizeBytes: st.sizeBytes || null, error: st.error || null };
    } catch {}
  }
  return out;
};

// Every socket of this profile hears it; each device keeps only its own.
const tell = (w, removed = false) => {
  try {
    deps.broadcast(w.profileId, removed ? { type: "offline_wish_removed", id: w.id, deviceId: w.deviceId } : { type: "offline_wish", wish: publicWish(w) });
  } catch {}
};

const normScope = (b) => (b.scope === "season" || b.scope === "show" ? b.scope : "title");

// ---------- the person's side: add / list / remove ----------
const validate = (b) => {
  const type = b.type === "show" ? "show" : b.type === "movie" ? "movie" : null;
  if (!type) return "type must be movie or show";
  if (!DEVICE_RE.test(String(b.deviceId || ""))) return "bad device id";
  if (!QUALITIES.includes(String(b.quality))) return "quality must be original, 1080, 720 or 480";
  const imdbId = b.imdbId ? String(b.imdbId) : null;
  if (imdbId && !IMDB_RE.test(imdbId)) return "bad title id";
  if (!imdbId && !b.jobId) return "a title id or a download id is needed";
  if (b.jobId && !/^[a-f0-9]{6,32}$/i.test(String(b.jobId))) return "bad download id";
  const scope = normScope(b);
  if (scope === "show") {
    if (type !== "show") return "only a show has episodes";
    if (!imdbId) return "a whole show needs its title id";
  } else if (type === "show") {
    if (num(b.season) == null) return "an episode needs its season";
    if (scope === "title" && num(b.episode) == null) return "an episode needs its number";
  } else if (scope === "season") return "only a show has seasons";
  return null;
};

// The same device asking again for the same thing is ONE wish (its quality
// and the rest are updated) — never two.
const sameTarget = (w, b) =>
  w.deviceId === b.deviceId && w.type === b.type && w.scope === normScope(b) && !w.parentId &&
  ((b.imdbId && w.imdbId === b.imdbId) || (!b.imdbId && b.jobId && w.jobId === b.jobId)) &&
  (b.type !== "show" || normScope(b) === "show" || (Number(w.season) === Number(b.season) && (normScope(b) === "season" || Number(w.episode) === Number(b.episode))));

const add = (profileId, body = {}) => {
  const b = { ...body };
  const bad = validate(b);
  if (bad) return { error: bad };
  b.type = b.type === "show" ? "show" : "movie";
  b.scope = normScope(b);
  const list = data();
  const now = deps.now();
  let w = list.find((x) => x.profileId === profileId && sameTarget(x, b));
  const fresh = !w;
  if (!w) {
    if (list.filter((x) => x.profileId === profileId).length >= MAX_PER_PROFILE) {
      // the bound: the oldest FAILED wish of this person makes room; a live one never does
      const i = list.findIndex((x) => x.profileId === profileId && x.state === "failed");
      if (i < 0) return { error: `${MAX_PER_PROFILE} titles are already waiting for this person` };
      list.splice(i, 1);
    }
    w = { id: newId(), profileId, createdAt: now };
    list.push(w);
  }
  Object.assign(w, {
    deviceId: String(b.deviceId), deviceName: clip(b.deviceName, 60),
    scope: b.scope, type: b.type, imdbId: b.imdbId ? String(b.imdbId) : w.imdbId || null,
    jobId: b.jobId ? String(b.jobId) : w.jobId || null,
    season: b.type === "show" && b.scope !== "show" ? num(b.season) : null,
    episode: b.type === "show" && b.scope === "title" ? num(b.episode) : null,
    title: clip(b.title, 160) || w.title || null, showTitle: clip(b.showTitle, 160) || w.showTitle || null,
    poster: clip(b.poster, 500) || w.poster || null,
    quality: String(b.quality), hevc: !!b.hevc,
    pushKey: /^[a-f0-9]{64}$/.test(String(b.pushKey || "")) ? String(b.pushKey) : null,
    updatedAt: now,
  });
  if (fresh || w.state === "failed") { w.state = "waiting"; w.error = null; w.note = null; }
  // Already in the library (it landed between the page drawing and the press,
  // or the season has episodes waiting): ready at once.
  if (w.scope === "title" && w.state === "waiting") {
    const lib = findInLibrary(w);
    if (lib) makeReady(w, lib.id, { quiet: true });
  }
  save();
  deps.log(`[offline-wish] ${fresh ? "new" : "updated"} ${w.id} ${describe(w)} at ${w.quality} for device ${w.deviceId.slice(0, 12)}${w.state === "ready" ? " — already in the library" : ""}`);
  tell(w);
  return { wish: publicWish(w) };
};

const list = (profileId, deviceId = null) =>
  data().filter((w) => w.profileId === profileId && (!deviceId || w.deviceId === deviceId)).map(publicWish);

const findOwn = (profileId, id) => data().find((w) => w.id === id && w.profileId === profileId) || null;

// Cancel / Dismiss. A copy the server was preparing only for this wish stops
// (offline.cancel counts the people waiting for it). A season wish takes its
// unsaved episodes with it.
const remove = (profileId, id, { saved = false } = {}) => {
  const w = findOwn(profileId, id);
  if (!w) return { error: "not found" };
  const gone = [w, ...(saved ? [] : data().filter((x) => x.parentId === w.id))];
  for (const x of gone) {
    if (!saved && x.asked && x.libraryId) {
      try { deps.offline.cancel(x.libraryId, x.readyQuality || x.quality); } catch {}
    }
  }
  const ids = new Set(gone.map((x) => x.id));
  deps.store.data.wishes = data().filter((x) => !ids.has(x.id));
  save();
  for (const x of gone) tell(x, true);
  deps.log(`[offline-wish] ${saved ? "saved on the device" : "removed"}: ${w.id} ${describe(w)}`);
  return { ok: true };
};

// ---------- the server's side: a download landed / died ----------
const describe = (w) =>
  `${w.type === "show" ? (w.scope === "show" ? `${w.showTitle || w.title || w.imdbId} (every new episode)` : `${w.showTitle || w.title || w.imdbId} S${w.season}${w.scope === "title" ? `E${w.episode}` : " (whole season)"}`) : w.title || w.imdbId || w.jobId}`;

const findInLibrary = (w) => {
  try {
    const hit = deps.findLibraryPlayable({ imdbId: w.imdbId, type: w.type, title: w.showTitle || w.title, season: w.season, episode: w.episode });
    return hit && hit.id ? hit : null;
  } catch { return null; }
};

// Does a wish wait for this job? By the job's id, or by the title.
const awaits = (w, job) => {
  if (w.parentId || w.type !== (job.type === "show" ? "show" : "movie")) return false;
  if (w.jobId && w.jobId === job.id) return true;
  if (!w.imdbId || !job.imdbId || String(w.imdbId).toLowerCase() !== String(job.imdbId).toLowerCase()) return false;
  if (w.type === "movie") return true;
  if (w.scope === "show") return job.season != null && job.episode != null; // every episode of it
  if (Number(w.season) !== Number(job.season)) return false;
  return w.scope === "season" || Number(w.episode) === Number(job.episode);
};

// The quality the server prepares: the one asked for, or — when this device
// cannot play the original's picture — the best re-encode the file offers.
const qualityFor = (w, libId) => {
  let opts = [];
  try { opts = (deps.offline.options(libId, { hevc: !!w.hevc }).options || []).map((o) => o.quality); } catch {}
  if (!opts.length || opts.includes(w.quality)) return { q: w.quality, note: null };
  const order = ["1080", "720", "480"];
  const want = w.quality === "original" ? 0 : order.indexOf(w.quality);
  const q = order.slice(Math.max(0, want)).find((x) => opts.includes(x)) || opts[opts.length - 1];
  return {
    q,
    note: w.quality === "original"
      ? `This device can't play the original's picture — it is saved at ${q === "original" ? "the original" : `${q}p`}.`
      : `Saved at ${q === "original" ? "the original quality" : `${q}p`} — the file has no ${w.quality}p.`,
  };
};

const makeReady = (w, libId, { quiet = false } = {}) => {
  const { q, note } = qualityFor(w, libId);
  w.state = "ready";
  w.libraryId = libId;
  w.readyQuality = q;
  w.note = note;
  w.error = null;
  w.readyAt = w.readyAt || deps.now();
  w.updatedAt = deps.now();
  // the copy, ahead of the device: a person's request (it goes before the
  // play-ready copies made ahead of time) that the copy folder keeps for a
  // few days, in case the phone only comes back tomorrow
  try {
    const st = deps.offline.prepare(libId, q, { hevc: !!w.hevc }, { keepMs: KEEP_COPY_MS, person: true });
    w.asked = st && (st.state === "queued" || st.state === "working");
    if (st && st.state === "error") w.note = [w.note, `The server could not prepare it yet: ${st.error}.`].filter(Boolean).join(" ");
    else if (st && st.state === "ready") pushReady(w);
  } catch (e) { deps.warn(`[offline-wish] could not start the copy for ${w.id}: ${e && e.message}`); }
  if (!quiet) deps.log(`[offline-wish] ${w.id} ${describe(w)} is in the library (${libId}) — copy at ${q} ${w.asked ? "being prepared" : "ready"}`);
};

// A season wish: each episode that lands is a wish of its own (parentId),
// ready at once; the season wish keeps waiting for the next one.
const childFor = (parent, libItem, job) => {
  let c = data().find((x) => x.parentId === parent.id && Number(x.season) === Number(job.season) && Number(x.episode) === Number(job.episode));
  if (c && c.state === "ready" && c.libraryId === libItem.id) return null; // told already
  if (!c) {
    c = { id: newId(), profileId: parent.profileId, createdAt: deps.now(), parentId: parent.id };
    data().push(c);
  }
  Object.assign(c, {
    deviceId: parent.deviceId, deviceName: parent.deviceName, scope: "title", type: "show",
    imdbId: parent.imdbId, jobId: job.id, season: Number(job.season), episode: Number(job.episode),
    title: libItem.title || `Episode ${job.episode}`, showTitle: parent.showTitle || parent.title,
    poster: parent.poster, quality: parent.quality, hevc: parent.hevc, pushKey: parent.pushKey, updatedAt: deps.now(),
  });
  return c;
};

// downloads.js finish(): the file is in the library. The scan has run, the
// probe may not have (a remux needs to know the codecs): looked for until the
// library knows it, for a few minutes.
const pendingLand = new Map(); // job id -> timer
const landed = (job, destPath) => {
  if (!job || !deps) return;
  const waiting = data().filter((w) => (w.state === "waiting" || w.state === "failed") && awaits(w, job));
  if (!waiting.length) return;
  const started = deps.now();
  const look = () => {
    pendingLand.delete(job.id);
    const libId = destPath ? deps.idForPath(destPath) : null;
    const probe = (() => { try { return libId && deps.probed(libId); } catch { return false; } })();
    const lib = libId ? { id: libId, title: job.title } : null;
    if ((!lib || !probe) && deps.now() - started < LAND_WAIT_MS) {
      const t = deps.setTimeout(look, LAND_POLL_MS);
      pendingLand.set(job.id, t);
      return;
    }
    // (never found by its path: by its title, as a person would look)
    const byTitle = lib || (() => {
      const hit = findInLibrary({ imdbId: job.imdbId, type: job.type === "show" ? "show" : "movie", title: job.title, season: job.season, episode: job.episode });
      return hit ? { id: hit.id, title: hit.title } : null;
    })();
    for (const w of data().filter((x) => (x.state === "waiting" || x.state === "failed") && awaits(x, job))) {
      if (!byTitle) {
        w.state = "failed";
        w.error = "The download finished, but the server could not find it in the library.";
        w.updatedAt = deps.now();
        tell(w);
        continue;
      }
      if (w.scope === "season" || w.scope === "show") {
        const c = childFor(w, byTitle, job);
        if (!c) continue;
        c.landedJobId = job.id;
        makeReady(c, byTitle.id);
        if (w.state === "failed") { w.state = "waiting"; w.error = null; }
        w.updatedAt = deps.now();
        tell(c);
        tell(w);
      } else {
        w.landedJobId = job.id;
        makeReady(w, byTitle.id);
        tell(w);
      }
    }
    save();
  };
  look();
};

// downloads.js fail / cancel / decline / remove: a title wish waiting for
// THIS download says why it will not come — unless another download of the
// same title is still on its way. A season wish carries on (other episodes).
const ended = (job, how) => {
  if (!job || !deps) return;
  const why = how === "canceled" ? "The download was cancelled — there is nothing to save."
    : how === "declined" ? "The download was declined — there is nothing to save."
      : how === "removed" ? "The download was taken off the list — there is nothing to save."
        : `The download failed${job.error ? ` (${String(job.error).slice(0, 120)})` : ""} — there is nothing to save.`;
  let live = [];
  try { live = deps.liveJobs().filter((j) => j.id !== job.id); } catch {}
  let changed = false;
  for (const w of data()) {
    if (w.state !== "waiting" || w.scope !== "title" || !awaits(w, job)) continue;
    if (live.some((j) => awaits(w, j))) continue; // another copy is still coming
    w.state = "failed";
    w.error = why;
    w.updatedAt = deps.now();
    changed = true;
    tell(w);
    deps.log(`[offline-wish] ${w.id} ${describe(w)}: ${why}`);
  }
  if (changed) save();
};

// The copy the server prepared for a ready wish is done: the browser that
// asked hears it on its lock screen (when it switched push on) — once.
const pushReady = (w) => {
  if (!w.pushKey || w.pushed) return;
  w.pushed = true;
  try {
    deps.push(w.profileId, w.pushKey, {
      title: w.type === "show" && w.season != null && w.episode != null ? `${w.showTitle || w.title} · S${w.season} E${w.episode}` : w.title || "Aurora",
      body: "Ready to save on this device — open Aurora and it saves by itself.",
      url: "/#/saved",
      // the same tag as the download's own "ready to watch" (downloads.js):
      // on this browser the one notification is replaced, not doubled
      tag: w.landedJobId ? `dl-${w.landedJobId}` : `wish-${w.id}`,
    });
  } catch {}
};
const copyReady = (libId, q) => {
  if (!deps) return;
  let changed = false;
  for (const w of data()) {
    if (w.state !== "ready" || w.libraryId !== libId || (w.readyQuality || w.quality) !== String(q)) continue;
    w.asked = false;
    pushReady(w);
    tell(w);
    changed = true;
  }
  if (changed) save();
};

// A profile that no longer exists takes its wishes with it.
const prune = () => {
  if (!deps) return 0;
  const before = data().length;
  deps.store.data.wishes = data().filter((w) => { try { return deps.profileExists(w.profileId); } catch { return true; } });
  const n = before - data().length;
  if (n) { save(); deps.log(`[offline-wish] ${n} wish(es) of profiles that are gone removed`); }
  return n;
};

// ---------- the server's own wiring ----------
const realDeps = () => {
  const path = require("path");
  const config = require("../config");
  const { JsonStore } = require("../lib/jsonstore");
  return {
    store: new JsonStore(path.join(config.DATA_DIR, "offline-wishes.json"), () => ({ wishes: [] })),
    now: () => Date.now(),
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    offline: require("./offline"),
    idForPath: (p) => require("./scanner").idForPath(p),
    probed: (id) => {
      const e = require("./scanner").resolve(id);
      return !!(e && require("./metadata").getCached(e.path));
    },
    findLibraryPlayable: (identity) => require("./identity").findLibraryPlayable(identity),
    liveJobs: () => require("./downloads").list().filter((j) => ["pending", "approved", "downloading"].includes(j.status)),
    broadcast: (profileId, msg) => require("../realtime").broadcastEach((c) => (c.profileId === profileId || (c.ws && c.ws.profileId === profileId) ? msg : null)),
    push: (profileId, key, msg) => require("../lib/push").sendToKey(profileId, key, msg),
    profileExists: (id) => require("../profiles").exists(id),
  };
};
const ensure = () => {
  if (!deps) {
    deps = realDeps();
    try { deps.offline.onReady(copyReady); } catch {}
    const t = setInterval(() => { try { prune(); } catch {} }, 6 * 3600 * 1000);
    if (t.unref) t.unref();
  }
  return module.exports;
};

module.exports = {
  add: (...a) => ensure() && add(...a),
  list: (...a) => ensure() && list(...a),
  remove: (...a) => ensure() && remove(...a),
  landed: (...a) => ensure() && landed(...a),
  ended: (...a) => ensure() && ended(...a),
  prune: () => ensure() && prune(),
  QUALITIES, SCOPES, MAX_PER_PROFILE, KEEP_COPY_MS,
  _internals: {
    realDeps,
    setDeps: (d) => { deps = d; try { d.offline.onReady && d.offline.onReady(copyReady); } catch {} },
    copyReady, awaits, qualityFor, publicWish, pendingLand, LAND_WAIT_MS, LAND_POLL_MS,
  },
};

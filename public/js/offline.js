// Offline copies on THIS device: what's saved (IndexedDB), the bytes (the
// service worker's media cache), and watch progress made while offline
// (queued here, flushed to the server when it's back).
//
// Needs a secure context: service workers and the Cache API are only
// available over https or localhost — `available()` says whether this
// address qualifies, and the UI explains when it doesn't.
//
// HOW A COPY IS KEPT (2026-11-10, docs/offline-audit.md). A saved film used to
// be ONE cache entry, written by one long download: any interruption — a
// reload, a closed tab, a phone that froze the page, a few seconds without a
// line, a server restart — threw every byte away, and Chrome then spent
// minutes at "99%" committing a multi-gigabyte entry. Now a copy is PARTS:
//   /offline/part/<id>/<n>     PART_BYTES each (the last one shorter), each a
//                              Range request of the file, put into the cache
//                              only once it is whole
//   /offline/manifest/<id>     { v: 2, size, part, count, type } — written last:
//                              a copy is playable only once every part is in
// The service worker answers /offline/media/<id> (with Range) from the parts,
// or from the one entry of a copy saved before this. A save that stops for
// any reason keeps its parts and carries on from the first missing one:
// by itself when the line comes back, when the page is opened again, when the
// app comes back to the front; a file that changed on the server meanwhile
// (its validator moved) starts again from zero.
import { api } from "./api.js";
import { sameAudio } from "./lang.js";

const DB = "aurora-offline";
const MEDIA = "aurora-media";
// (the browser tests save their short films in many small parts:
// localStorage "aurora-offline-part-bytes", 64 KB at the least)
export const PART_BYTES = (() => {
  try { const n = Number(localStorage.getItem("aurora-offline-part-bytes")); if (n >= 65536) return n; } catch {}
  return 16 * 1024 * 1024;
})();
const PARTS_AT_ONCE = 3; // parts in flight for one save (a far server: several streams fill the line)
const RETRY_FOR_MS = 15 * 60 * 1000; // a save keeps retrying a dead line this long before it pauses
const partKey = (id, n) => `/offline/part/${id}/${n}`;
const manifestKey = (id) => `/offline/manifest/${id}`;
const mediaKey = (id) => `/offline/media/${id}`;

export const available = () =>
  typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "caches" in window && "indexedDB" in window;

const open = () =>
  new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" });
      if (!db.objectStoreNames.contains("progress")) db.createObjectStore("progress", { keyPath: "itemId" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const tx = async (store, mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    // an IDBRequest resolves to its result (undefined for a missing record —
    // never the request object itself, which would read as "found")
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
  });
};
const getAll = (store) => tx(store, "readonly", (s) => s.getAll());

// ---------- whose copies ----------
// Every copy says which profile saved it (and whether that was a kids
// profile). "On this device" shows a kids profile only what it saved itself
// — a child used to be shown, and could play, every film anybody had saved on
// the family tablet. A grown-up sees all of the device's copies. With no
// server in reach the app may not know who is watching: the last profile seen
// here online stands in (WHO_KEY).
const WHO_KEY = "aurora-offline-who";
export const rememberWho = (profile) => {
  if (!profile || !profile.id) return;
  try { localStorage.setItem(WHO_KEY, JSON.stringify({ id: profile.id, name: profile.name || "", kids: !!profile.kids })); } catch {}
};
export const lastWho = () => {
  try { return JSON.parse(localStorage.getItem(WHO_KEY) || "null"); } catch { return null; }
};
const visibleTo = (who) => (it) => !who || !who.kids || it.profileId === who.id;

// (a copy whose parts are still landing is `pending`: not a saved title yet)
export const listSaved = async () => (available() ? (await getAll("items")).filter((it) => !it.pending).sort((a, b) => b.savedAt - a.savedAt) : []);
// What THIS person may see and play (`who`: { id, kids } — the profile, or lastWho()).
export const listSavedFor = async (who) => (await listSaved()).filter(visibleTo(who));
export const getSaved = async (id) => (available() ? tx("items", "readonly", (s) => s.get(id)) : null);
export const isSaved = async (id) => { const it = await getSaved(id); return !!(it && !it.pending); };

// Every piece of a copy: the one entry of an old save, the parts, the
// manifest, the subtitles, the record.
const dropBytes = async (id) => {
  setSaveMeta(id, null);
  await opfsDrop(id).catch(() => {});
  try { navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage({ type: "offline-removed", id }); } catch {}
  const c = await caches.open(MEDIA);
  await c.delete(mediaKey(id)).catch(() => {});
  await c.delete(manifestKey(id)).catch(() => {});
  for (const k of await c.keys().catch(() => [])) {
    const p = new URL(k.url).pathname;
    if (p.startsWith(`/offline/part/${id}/`)) await c.delete(k).catch(() => {});
  }
};
// A save given up on: its parts, and its record if it never became a copy.
const dropUnfinished = async (id) => {
  await dropBytes(id);
  const it = await getSaved(id).catch(() => null);
  if (it && it.pending) {
    const c = await caches.open(MEDIA);
    for (const sub of it.subtitles || []) if (sub.url) await c.delete(sub.url).catch(() => {});
    await tx("items", "readwrite", (s) => s.delete(id)).catch(() => {});
  }
  indexDrop(id);
};
const nameFor = (it) => (it.showTitle && it.season != null ? `${it.showTitle} · S${it.season} E${it.episode}` : it.title || "Aurora");
export const removeSaved = async (id) => {
  await dropBytes(id);
  const it = await getSaved(id);
  const c = await caches.open(MEDIA);
  for (const sub of (it && it.subtitles) || []) if (sub.url) await c.delete(sub.url).catch(() => {});
  await tx("items", "readwrite", (s) => s.delete(id));
  indexDrop(id);
};

// What this browser can take as "original": HEVC in an MP4 plays on Safari
// and on Chrome with a hardware decoder; elsewhere the server offers the
// re-encoded sizes instead.
export const canHevc = () => {
  try {
    return !!document.createElement("video").canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"');
  } catch {
    return false;
  }
};

// The quality to save at: "ask" (the default — a sheet with sizes), or one
// of original / 1080 / 720 / 480 remembered from Preferences or the sheet.
const QUALITY_KEY = "aurora-offline-quality";
export const preferredQuality = () => {
  try { return localStorage.getItem(QUALITY_KEY) || "ask"; } catch { return "ask"; }
};
export const setPreferredQuality = (q) => {
  try { localStorage.setItem(QUALITY_KEY, q); } catch {}
};

// The page must be CONTROLLED by the worker for a saved copy to play (the
// worker is what answers /offline/media/…). A first visit registers it but
// isn't controlled until the worker claims the page — wait for that, briefly.
const workerControls = async () => {
  if (navigator.serviceWorker.controller) return true;
  try { await navigator.serviceWorker.ready; } catch { return false; }
  if (navigator.serviceWorker.controller) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(!!navigator.serviceWorker.controller), 3000);
    navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(t); resolve(true); }, { once: true });
  });
};

// With no server in reach the app boots from the worker's kept answers: the
// profiles and this person's history must be among them, or the player has
// nobody to save progress for and no resume point (audit 2026-11-10: a phone
// that opened Aurora once, saved a film and went offline lost every minute
// watched on the plane). Asked once a copy is saved, through the worker,
// which keeps them (sw.js API_KEEP).
const warmForOffline = async (profileId) => {
  if (!navigator.serviceWorker.controller) return;
  const urls = ["/api/profiles", "/api/server-info", ...(profileId ? [`/api/profiles/${encodeURIComponent(profileId)}/state`] : [])];
  await Promise.all(urls.map((u) => api.warmOffline(u).catch(() => {})));
};

// Kept until the person removes them? Chrome grants it to an installed app or
// a site used a lot; Firefox asks; Safari keeps a Home Screen app's storage.
// Asked on the press that starts a save (a person's gesture), never nagged.
export const persistState = async () => {
  try {
    if (!navigator.storage || !navigator.storage.persisted) return "unknown";
    return (await navigator.storage.persisted()) ? "kept" : "may-clear";
  } catch { return "unknown"; }
};

const fmtGb = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);

// ---------- saves in progress ----------
// Every save to this device, wherever it was started (a title page's button,
// "Save the next 3", a wish the server made ready), is a JOB here:
//   queued      waiting for the save before it (one lands at a time)
//   preparing   the server converts (its own percentage, and why it waits)
//   saving      parts landing, with the speed and the time left
//   retrying    the line or the server went away: it carries on by itself
//   paused      stopped (the page was closed, or the line stayed away) — the
//               parts already here stay; it carries on by itself the next
//               time Aurora is open with a line, or with Resume
//   failed      with the reason in plain words, and Retry
// Kept in localStorage, so every screen and every tab shows the same list.
//   listJobs() / jobFor(id) / onJobs(fn) -> unsubscribe
//   cancelJob(id) · dismissJob(id) · retryJob(id, choose) · queueJob(item) · resumeSaves()
const JOBS_KEY = "aurora-offline-jobs";
const jobs = new Map(); // id -> { id, title, cover, item, quality, state, pct, note, speed, eta, error, at, … }
const jobCtl = new Map(); // id -> the AbortController of a save running in THIS tab
const jobSubs = new Set();
export const ACTIVE_JOB = new Set(["queued", "preparing", "saving", "retrying"]);
const readJobs = () => {
  try { return JSON.parse(localStorage.getItem(JOBS_KEY) || "[]").filter((j) => j && j.id && j.item); } catch { return []; }
};
for (const j of readJobs()) {
  // nothing runs across a page load: what was under way stopped — and its
  // parts are still here, so it is paused, not lost ("interrupted" was the
  // old word for it, from before saves could carry on)
  if (ACTIVE_JOB.has(j.state) || j.state === "interrupted") { j.state = "paused"; j.why = "stopped"; } // (a pause the person chose keeps its why: "user")
  j.speed = 0;
  jobs.set(j.id, j);
}
const jobItem = (item) => ({
  id: item.id, title: item.title, showId: item.showId || null, showTitle: item.showTitle || null,
  season: item.season ?? null, episode: item.episode ?? null, year: item.year || null, cover: item.cover || null,
  duration: item.duration || 0, imdbId: item.imdbId || null,
  subtitles: (item.subtitles || []).filter((t) => t && t.url).slice(0, 64).map((t) => ({ label: t.label, lang: t.lang, url: t.url })),
});
const emitJobs = (store = true) => {
  if (store) { try { localStorage.setItem(JOBS_KEY, JSON.stringify([...jobs.values()])); } catch {} }
  const list = listJobs();
  for (const fn of [...jobSubs]) { try { fn(list); } catch {} }
};
const setJob = (id, fields) => {
  jobs.set(id, { ...(jobs.get(id) || { at: Date.now() }), ...fields, id });
  emitJobs();
};
// Another tab of this browser runs a save: its list arrives here through the
// storage event (the rows on this tab's screens move too). Jobs this tab runs
// itself are its own truth.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== JOBS_KEY) return;
    const theirs = new Map(readJobs().map((j) => [j.id, j]));
    for (const id of [...jobs.keys()]) if (!jobCtl.has(id) && !theirs.has(id)) jobs.delete(id);
    for (const [id, j] of theirs) if (!jobCtl.has(id)) jobs.set(id, j);
    emitJobs(false);
  });
}
export const listJobs = () => [...jobs.values()].sort((a, b) => a.at - b.at);
export const jobFor = (id) => jobs.get(id) || null;
export const onJobs = (fn) => { jobSubs.add(fn); return () => jobSubs.delete(fn); };
export const dismissJob = (id) => { if (jobs.delete(id)) emitJobs(); };
// A save running here stops (its parts go, and its job). One that is paused,
// failed or only queued is taken off the list, and what it had saved goes.
export const cancelJob = (id) => {
  const c = jobCtl.get(id);
  if (c) return c.abort();
  const j = jobs.get(id);
  dismissJob(id);
  if (j && j.state !== "queued") isSaved(id).then((done) => { if (!done) { stopBackground(id).catch(() => {}); dropUnfinished(id).catch(() => {}); } }).catch(() => {});
};
// Pause (2026-11-10 round 2, for the screens): a save stops and KEEPS what it
// has saved — "paused", why "user"; it does not carry on by itself (only
// Resume = retryJob(id) does). A queued one is paused the same way.
const pausing = new Set();
export const pauseJob = (id) => {
  const j = jobs.get(id);
  if (!j) return false;
  const c = jobCtl.get(id);
  if (c) {
    pausing.add(id);
    c.abort();
  } else if (j.state !== "failed") {
    setJob(id, { state: "paused", why: "user", speed: 0, note: "" });
  }
  stopBackground(id).catch(() => {}); // (the browser's own fetch of it, too — what it stored stays)
  return true;
};
// "Waiting for its turn" — the episodes of "Save the next 3" after the first.
export const queueJob = (item) => {
  const j = jobs.get(item.id);
  if (j && ACTIVE_JOB.has(j.state)) return;
  setJob(item.id, { item: jobItem(item), title: item.title, cover: item.cover || null, state: "queued", pct: 0, error: null, speed: 0, at: Date.now() });
};
// Again (or on from where it stopped), at the size picked the first time —
// asked again only when the server can no longer make that one.
export const retryJob = (id, choose = null) => {
  const j = jobs.get(id);
  if (!j) return Promise.resolve(null);
  return saveItem(j.item, () => {}, async (options) => {
    if (Number.isInteger(j.audio)) options.chosenAudio = j.audio; // (the same sound as the first time)
    return options.some((o) => o.quality === j.quality) ? j.quality : choose ? choose(options) : (options[0] || {}).quality;
  });
};

// One save lands at a time (the first episode is watchable sooner than if
// five shared the line); the others wait their turn, saying so.
let landing = Promise.resolve();
let landingNow = 0;
const oneAtATime = (fn, onWait) => {
  if (landingNow > 0 && onWait) onWait();
  landingNow++;
  const run = landing.then(fn, fn).finally(() => { landingNow--; });
  landing = run.catch(() => {});
  return run;
};

// One tab owns a save (Web Locks where the browser has them): two tabs of
// the same browser must not write the same parts.
const withLock = async (id, fn) => {
  if (!(navigator.locks && navigator.locks.request)) return fn();
  let ran = false;
  const out = await navigator.locks.request(`aurora-save-${id}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return null;
    ran = true;
    return fn();
  });
  if (!ran) { const e = new Error("another tab of this browser is saving it"); e.name = "BusyElsewhere"; throw e; }
  return out;
};

// Save one library item — and keep its job (above) up to date.
export const saveItem = async (item, onProgress = () => {}, choose = null, signal = null) => {
  const ctl = new AbortController();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", () => ctl.abort(), { once: true });
  }
  let started = false;
  const pick = async (options) => {
    const q = choose ? await choose(options) : (options.find((o) => o.quality === "720") || options[0]).quality;
    if (q) {
      started = true;
      jobCtl.set(item.id, ctl);
      const was = jobs.get(item.id) || {};
      const audio = Number.isInteger(options.chosenAudio) ? options.chosenAudio : 0;
      setJob(item.id, { item: jobItem(item), title: item.title, cover: item.cover || null, quality: q, audio, state: "preparing", pct: was.quality === q && (was.audio || 0) === audio ? was.pct || 0 : 0, note: "", error: null, speed: 0, eta: 0, why: null, at: was.at || Date.now() });
    }
    return q;
  };
  const progress = (p) => {
    onProgress(p);
    if (started && ["queued", "preparing", "saving", "retrying"].includes(p.phase)) {
      setJob(item.id, { state: p.phase, pct: p.pct || 0, note: p.note || "", speed: p.speed || 0, eta: p.eta || 0, waiting: !!p.waiting, ...(p.size ? { size: p.size } : {}) });
    }
  };
  try {
    const saved = await saveOne(item, progress, pick, ctl.signal);
    if (started) dismissJob(item.id); // done: it is on the Saved list now
    return saved;
  } catch (e) {
    if (started) {
      if (e && e.name === "AbortError" && pausing.has(item.id)) setJob(item.id, { state: "paused", why: "user", speed: 0, note: "", error: null });
      else if (e && e.name === "AbortError") { dismissJob(item.id); stopBackground(item.id).catch(() => {}); dropUnfinished(item.id).catch(() => {}); }
      else if (e && e.name === "BusyElsewhere") { /* the other tab's job is the truth */ }
      else if (e && e.pause) setJob(item.id, { state: "paused", why: e.pause, error: null, speed: 0, note: "" });
      else setJob(item.id, { state: "failed", error: (e && e.message) || String(e), speed: 0 });
    }
    throw e;
  } finally {
    if (jobCtl.get(item.id) === ctl) jobCtl.delete(item.id);
    pausing.delete(item.id);
  }
};

// Every save that stopped (paused, or cut off by a reload) carries on — one
// after another, quietly. Called when Aurora opens, when the line comes back,
// when the app returns to the front and when the socket reconnects (main.js).
// A save running in another tab is left to it (withLock).
let resuming = false;
export const resumeSaves = async () => {
  // (and keep the next episode ready, where that is switched on — below)
  if (available()) Promise.resolve().then(() => smartNext.check()).catch(() => {});
  if (!available() || resuming || (typeof navigator !== "undefined" && navigator.onLine === false)) return 0;
  // (one the person paused waits for their Resume)
  const todo = listJobs().filter((j) => j.state === "paused" && j.why !== "user" && !jobCtl.has(j.id) && j.quality);
  if (!todo.length) return 0;
  resuming = true;
  let n = 0;
  try {
    for (const j of todo) {
      if (!jobs.has(j.id) || jobs.get(j.id).state !== "paused" || jobs.get(j.id).why === "user") continue; // cancelled or paused meanwhile
      try {
        await retryJob(j.id);
        n++;
      } catch (e) {
        if (e && e.pause === "offline") break; // still no line: the next chance will try again
      }
    }
  } finally {
    resuming = false;
  }
  return n;
};

// Words for what went wrong, for a person (never "Failed to execute 'put' on 'Cache'").
const plain = (e) => {
  const m = String((e && e.message) || e || "");
  if (e && e.name === "QuotaExceededError") return "this device ran out of room for it — free some space, or pick a smaller size";
  if (/quota|storage/i.test(m) && /exceed|full|room/i.test(m)) return "this device ran out of room for it — free some space, or pick a smaller size";
  return m || "something went wrong";
};
const isNetError = (e) => e && (e.name === "TypeError" || e.net || e.timeout) && !(e.name === "AbortError");

// The sound a copy is made with when the person does not choose: their own
// language (the dub they pick in the player, which follows the profile),
// else the film's original language, else the file's first.
const defaultSound = async (item, sounds) => {
  let liked = null;
  try {
    const { state } = await import("./state.js");
    liked = (state.profile && state.profile.prefs && state.profile.prefs.audioLang) || null;
  } catch {}
  if (!liked) { try { liked = JSON.parse(localStorage.getItem("aurora-player") || "{}").audioLang || null; } catch {} } // (the player keeps it here too)
  const fit = (t) => t && !t.commentary;
  if (liked) {
    const i = sounds.findIndex((t) => fit(t) && sameAudio(t.language, liked));
    if (i >= 0) return i;
  }
  const orig = ((item && item.audioTracks) || []).find((t) => t && t.original);
  if (orig) {
    const i = sounds.findIndex((t) => fit(t) && sameAudio(t.language, orig.language));
    if (i >= 0) return i;
  }
  return 0;
};
// "English", "Hebrew · 5.1", "Commentary" — a sound, in words.
export const soundLabel = (t) => {
  if (!t) return "";
  let name = "";
  try { if (t.language && t.language !== "und") name = new Intl.DisplayNames(["en"], { type: "language" }).of(t.language) || ""; } catch {}
  if (!name || name === t.language) name = t.title || (t.language ? String(t.language).toUpperCase() : `Sound ${Number(t.index || 0) + 1}`);
  const extra = [t.commentary ? "commentary" : null, t.channels > 2 ? (t.channels === 6 ? "5.1" : t.channels === 8 ? "7.1" : `${t.channels} ch`) : null].filter(Boolean);
  return [name, ...extra].join(" · ");
};

// Save one library item. `onProgress({phase, pct, note, speed, eta})` keeps the
// button honest: "preparing" (the server converts, with its own percentage),
// "saving" (parts landing), "retrying" (no line — it carries on by itself).
// `choose(options)` picks the quality — the server lays out what it can make
// for this file and this device, sizes included; resolve null to stop.
// `signal` cancels at any point; a cancelled save's parts are thrown away.
// (Called through saveItem above.)
const saveOne = async (item, onProgress, choose, signal) => {
  if (!available()) throw new Error("offline copies need a secure (https) address");
  const aborted = () => !!(signal && signal.aborted);
  const bail = () => { const e = new Error("cancelled"); e.name = "AbortError"; throw e; };
  const nap = (ms) => new Promise((r) => {
    const done = () => { clearTimeout(t); if (signal) signal.removeEventListener("abort", done); r(); };
    const t = setTimeout(done, ms);
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
  const hevc = canHevc();
  // 0. what can be made, and which one
  let options;
  let sounds = [];
  try {
    ({ options = [], audio: sounds = [] } = await api.offlineOptions(item.id, hevc));
  } catch (e) {
    // no server right now: a save that was under way waits for the next chance
    if (isNetError(e) || (typeof navigator !== "undefined" && navigator.onLine === false)) throw Object.assign(new Error("no connection"), { pause: "offline" });
    throw e;
  }
  if (!options.length) throw new Error("the server can't make an offline copy of this file (no ffmpeg, and it isn't playable as it is)");
  // ONE sound per copy (2026-11-10 round 2): when the file has several, the
  // size sheet shows them (options.audio) with the person's language picked
  // (options.chosenAudio — the sheet may change it)
  options.audio = sounds && sounds.length > 1 ? sounds : [];
  if (options.audio.length && !Number.isInteger(options.chosenAudio)) options.chosenAudio = await defaultSound(item, options.audio);
  const picked = choose ? await choose(options) : (options.find((o) => o.quality === "720") || options[0]).quality;
  if (!picked) {
    onProgress({ phase: "cancelled", pct: 0 });
    return null;
  }
  const option = options.find((o) => o.quality === picked) || options[0];
  const quality = option.quality;
  const audio = options.audio.length && Number.isInteger(options.chosenAudio) && options.chosenAudio > 0 && options.chosenAudio < options.audio.length ? options.chosenAudio : 0;
  const sound = options.audio.length ? options.audio[audio] : null;
  const variant = audio ? `${quality}~a${audio}` : quality; // (the server's name for this quality with this sound)
  return withLock(item.id, async () => {
    // room for it? (an honest "not enough space" beats a save that dies at 90%)
    const have = await partsHere(item.id);
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const est = await navigator.storage.estimate();
      const free = est && est.quota ? est.quota - (est.usage || 0) : 0;
      const need = Math.max(0, (option.sizeBytes || 0) - have.size * PART_BYTES);
      if (free && need && need * 1.05 > free) {
        throw new Error(`not enough room on this device — this copy needs about ${fmtGb(option.sizeBytes)} and ${fmtGb(free)} is free. Try a smaller size.`);
      }
    } catch (e) {
      if (/not enough room/.test(e.message)) throw e;
    }
    // 1. a playable file at that quality. A copy that has to wait says why;
    // a Cancel tells the server too.
    // (a pause leaves the server's copy being made: Resume finds it further on)
    const stopServer = () => { if (!pausing.has(item.id)) api.offlineCancel(item.id, variant).catch(() => {}); };
    let st;
    for (let misses = 0; ; ) {
      try { st = await api.offlinePrepare(item.id, variant, hevc); break; } catch (e) {
        if (aborted()) bail();
        // the server answered with a reason (a full disk…): that is the answer
        if (!isNetError(e) && navigator.onLine !== false) throw e;
        if (++misses >= 3) throw Object.assign(new Error("can't reach the server"), { pause: "offline" });
        onProgress({ phase: "retrying", pct: 0, note: "can't reach the server — trying again" });
        await nap(3000);
      }
    }
    let misses = 0;
    const repackage = option.instant && option.quality === "original";
    while (st.state === "queued" || st.state === "working") {
      if (aborted()) { stopServer(); bail(); }
      const wait = st.wait || null;
      onProgress({
        phase: "preparing",
        pct: st.progress || 0,
        waiting: st.state === "queued" || !!(wait && wait.reason === "paused"),
        note: (wait && wait.text) || (st.state === "queued" ? "waiting for the server" : repackage ? "repackaging on the server" : "converting on the server"),
      });
      await nap(repackage && st.state === "working" ? 800 : 2000);
      if (aborted()) { stopServer(); bail(); }
      try {
        st = await api.offlineStatus(item.id, variant, hevc);
        misses = 0;
      } catch (e) {
        // a phone on the move loses the line for a moment: the copy goes on
        // on the server; after a while this save pauses and carries on later
        if (++misses >= 8) throw Object.assign(new Error("lost the connection while the server was preparing it"), { pause: "offline" });
        onProgress({ phase: "retrying", pct: st.progress || 0, note: "can't reach the server — still trying" });
      }
    }
    if (aborted()) bail();
    if (st.state !== "ready") throw new Error(st.error || "the server couldn't prepare it");
    // 2. what goes with the picture, while the server is in reach: the
    // subtitles that exist as text tracks (stored under /offline/subs/… —
    // the worker serves that prefix from this cache) and what the player asks
    // the server for while a film runs (see extrasFor). Then the copy's
    // record, marked `pending` until every part is in: a save the browser
    // finishes in the background (Background Fetch, below) is complete on
    // this device even if Aurora is next opened with no line at all.
    const c = await caches.open(MEDIA);
    const had = await getSaved(item.id).catch(() => null);
    let subtitles = had && had.pending && had.quality === quality && (had.audio || 0) === audio ? had.subtitles || [] : null;
    if (!subtitles) {
      subtitles = [];
      let n = 0;
      for (const t of (item.subtitles || []).slice(0, 64)) { // (every text track the title has — a copy kept 6, then 8, and dropped the rest)
        if (!t.url) continue;
        try {
          const res = await fetch(t.url, { cache: "no-store" });
          if (!res.ok) continue;
          const key = `/offline/subs/${item.id}/${n++}`;
          await c.put(key, new Response(await res.blob(), { status: 200, headers: { "Content-Type": res.headers.get("Content-Type") || "text/vtt" } }));
          subtitles.push({ label: t.label, lang: t.lang, url: key });
        } catch {}
      }
    }
    const extras = had && had.pending && had.extrasAt ? {} : await extrasFor(item).catch(() => ({}));
    const who = await whoNow();
    const saved = {
      ...(had && had.pending ? had : {}),
      ...extras,
      id: item.id,
      title: item.title,
      showId: item.showId || null,
      showTitle: item.showTitle || null,
      season: item.season ?? null,
      episode: item.episode ?? null,
      year: item.year || null,
      cover: item.cover || null,
      duration: item.duration || 0,
      sizeBytes: st.sizeBytes || 0,
      direct: !!st.direct,
      quality,
      // the one sound this copy carries (null: the file had only one)
      audio,
      audioLang: sound ? sound.language || null : null,
      audioLabel: sound ? soundLabel(sound) : null,
      format: 2,
      profileId: who ? who.id : null,
      kids: !!(who && who.kids),
      subtitles,
      pending: true,
      savedAt: Date.now(),
    };
    if (!had || had.pending) await tx("items", "readwrite", (s) => s.put(saved));
    // 3. the bytes, in parts (see the top of this file) — one save at a time
    const meta = await oneAtATime(
      () => transfer(item.id, st, onProgress, signal, { title: nameFor(item), quality, variant }),
      () => onProgress({ phase: "queued", pct: 0, note: "after the one saving now", waiting: true }),
    );
    saved.sizeBytes = meta.size || saved.sizeBytes;
    saved.store = meta.store || "cache"; // (where its parts live: "opfs" the file system, "cache" the Cache API)
    saved.pending = false;
    saved.controlled = await workerControls();
    saved.savedAt = Date.now();
    await tx("items", "readwrite", (s) => s.put(saved));
    warmForOffline(who && who.id).catch(() => {});
    indexPut(saved);
    onProgress({ phase: "done", pct: 1 });
    return saved;
  });
};

// Who is saving: the app's profile (state.js), remembered for the offline boot.
const whoNow = async () => {
  try {
    const { state } = await import("./state.js");
    if (state.profile) { rememberWho(state.profile); return { id: state.profile.id, kids: !!state.profile.kids }; }
  } catch {}
  return lastWho();
};

// The part numbers of this copy already here (the faster store and the cache).
const partsHere = async (id) => {
  const out = await opfsParts(id).catch(() => new Set());
  try {
    const c = await caches.open(MEDIA);
    for (const k of await c.keys()) {
      const m = /^\/offline\/part\/([^/]+)\/(\d+)$/.exec(new URL(k.url).pathname);
      if (m && m[1] === id) out.add(Number(m[2]));
    }
  } catch {}
  return out;
};

// ---------- the faster store: the browser's own file system (OPFS) ----------
// Round 2, measured on the 2.7 GB film on this PC (same page, same server,
// twice each): parts into the Cache API 124–138 s (20–22 MB/s); the same
// parts as files of the Origin Private File System 34–52 s (52–80 MB/s) —
// 2.7–3.7× — because the Cache API writes every byte twice. A copy saved this
// way is the same parts (one file each, `aurora-offline/<id>/<n>`, written to
// a temporary name and moved in once whole) with the same manifest in the
// cache saying `store: "opfs"`; the worker serves its Range from those files
// (sw.js). Only for NEW saves, and only where it was proven here: Chromium
// (desktop Chrome, Android Chrome). Safari and Firefox keep the cache. Copies
// saved before stay where they are and keep playing; a save that began in the
// cache carries on in the cache; parts the browser fetched in the background
// (Background Fetch) land in the cache — the worker reads either.
// (localStorage "aurora-offline-opfs": "0" never, "1" always — the tests)
const OPFS_DIR = "aurora-offline";
export const opfsUsed = () => {
  try {
    const k = localStorage.getItem("aurora-offline-opfs");
    if (k === "0") return false;
    const has = typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function" &&
      typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype && "move" in FileSystemFileHandle.prototype;
    if (!has) return false;
    if (k === "1") return true;
    const ua = navigator.userAgent || "";
    return /Chrome\/|Chromium\//.test(ua) && !/Firefox\//.test(ua);
  } catch { return false; }
};
const opfsDir = async (id, create = false) => {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle(OPFS_DIR, { create });
  return base.getDirectoryHandle(String(id), { create });
};
const opfsParts = async (id) => {
  const out = new Set();
  if (typeof navigator === "undefined" || !navigator.storage || typeof navigator.storage.getDirectory !== "function") return out;
  let dir;
  try { dir = await opfsDir(id, false); } catch { return out; }
  for await (const [name] of dir.entries()) if (/^\d+$/.test(name)) out.add(Number(name));
  return out;
};
const opfsDrop = async (id) => {
  if (typeof navigator === "undefined" || !navigator.storage || typeof navigator.storage.getDirectory !== "function") return;
  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(OPFS_DIR);
    await base.removeEntry(String(id), { recursive: true });
  } catch {}
};
// One part into the file system: written under a temporary name, moved to
// its number only once whole — a part is there whole, or not at all.
const opfsPut = async (id, n, body) => {
  const dir = await opfsDir(id, true);
  const tmp = `${n}.tmp`;
  const fh = await dir.getFileHandle(tmp, { create: true });
  const w = await fh.createWritable();
  try {
    await body.pipeTo(w);
  } catch (e) {
    try { await w.abort(); } catch {}
    await dir.removeEntry(tmp).catch(() => {});
    throw e;
  }
  await fh.move(String(n));
};
const opfsDelete = async (id, n) => {
  try { const dir = await opfsDir(id, false); await dir.removeEntry(String(n)).catch(() => {}); await dir.removeEntry(`${n}.tmp`).catch(() => {}); } catch {}
};

// The file's identity, as the server states it: a copy whose identity moved
// (re-made, replaced) is a different file — its old parts are useless.
const validatorOf = (res) => res.headers.get("ETag") || res.headers.get("Last-Modified") || "";
const SAVES_KEY = "aurora-offline-saves"; // id -> { url, size, validator } of a save under way
const savesMeta = () => { try { return JSON.parse(localStorage.getItem(SAVES_KEY) || "{}"); } catch { return {}; } };
const setSaveMeta = (id, m) => {
  const all = savesMeta();
  if (m) all[id] = m; else delete all[id];
  try { localStorage.setItem(SAVES_KEY, JSON.stringify(all)); } catch {}
};

// The parts: a few in flight, each retried while the line is away (it waits
// for the browser's "online" when the device says it has none), the whole
// save paused after RETRY_FOR_MS without a single part landing.
const transfer = async (id, st, onProgress, signal, opts = {}) => {
  if (signal && signal.aborted) { const e = new Error("cancelled"); e.name = "AbortError"; throw e; }
  const c = await caches.open(MEDIA);
  const url = st.url;
  // (one part failing for good stops the others: `inner`)
  const freshSwitch = () => { const x = new AbortController(); if (signal) signal.addEventListener("abort", () => x.abort(), { once: true }); return x; };
  let inner = freshSwitch();
  let fatal = null;
  const aborted = () => !!(signal && signal.aborted);
  const bail = () => { const e = new Error("cancelled"); e.name = "AbortError"; throw e; };
  let handoff = false; // (set below: the page went to the background on a phone)
  let restarting = false; // (the file changed on the server: every part in flight stops, the save starts over)
  const stopped = () => {
    if (aborted()) bail();
    if (fatal) throw fatal;
    if (handoff) throw Object.assign(new Error("handed to the browser"), { handoff: true });
    if (restarting) throw Object.assign(new Error("starting over"), { handoff: true });
  };
  // the size and the identity of the file, from the first part's answer
  // (or the save under way's, when it carries on)
  let meta = savesMeta()[id] || null;
  if (meta && (meta.url !== url || (st.sizeBytes && meta.size !== st.sizeBytes))) { await dropBytes(id); meta = null; }
  let size = meta ? meta.size : st.sizeBytes || 0;
  const done = await partsHere(id);
  if (!meta && done.size) { await dropBytes(id); done.clear(); } // parts with no record of what they are of
  let got = 0; // bytes landed this session (for the speed)
  const t0 = Date.now();
  let lastLanded = Date.now();
  let inflight = new Map(); // n -> bytes so far
  const count = () => (size ? Math.ceil(size / PART_BYTES) : 0);
  const landedBytes = () => [...done].reduce((n, i) => n + Math.min(PART_BYTES, size - i * PART_BYTES), 0);
  let lastTick = 0;
  const tick = (force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < 500) return;
    lastTick = now;
    const have = landedBytes() + [...inflight.values()].reduce((a, b) => a + b, 0);
    const secs = (now - t0) / 1000;
    const speed = secs > 1 ? got / secs : 0;
    onProgress({ phase: "saving", pct: size ? Math.min(0.999, have / size) : 0, note: "downloading to this device", speed, eta: speed > 0 && size ? Math.round((size - have) / speed) : 0, size });
  };
  const changed = async () => {
    // the file on the server is not the one these parts came from: from zero
    await dropBytes(id);
    done.clear();
    setSaveMeta(id, null);
    meta = null;
  };
  const fetchPart = async (n) => {
    const a = n * PART_BYTES;
    const b = size ? Math.min(size, a + PART_BYTES) - 1 : a + PART_BYTES - 1;
    let res;
    try {
      res = await fetch(url, { headers: { Range: `bytes=${a}-${b}` }, cache: "no-store", signal: inner.signal });
    } catch (e) {
      stopped();
      throw Object.assign(e, { net: true });
    }
    if (res.status === 404) throw Object.assign(new Error("the copy is no longer on the server — it is made again"), { gone: true });
    if (res.status === 416) { res.body && res.body.cancel().catch(() => {}); throw Object.assign(new Error("the file changed on the server"), { changed: true }); }
    if (res.status !== 206 && !(res.status === 200 && a === 0)) throw Object.assign(new Error(`the server answered ${res.status}`), { net: res.status >= 500 });
    const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get("Content-Range") || "");
    const total = range ? Number(range[3]) : Number(res.headers.get("Content-Length")) || 0;
    const v = validatorOf(res);
    if (!meta) {
      size = total || size;
      meta = { url, size, validator: v, store: opfsUsed() ? "opfs" : "cache" };
      setSaveMeta(id, meta);
    } else if ((meta.validator && v && meta.validator !== v) || (total && total !== meta.size)) {
      res.body && res.body.cancel().catch(() => {});
      throw Object.assign(new Error("the file changed on the server"), { changed: true });
    }
    // a 200 (a server that ignored the Range) is the whole file in one go:
    // fine for a file of one part, not for more
    if (res.status === 200 && size > PART_BYTES) { res.body && res.body.cancel().catch(() => {}); throw new Error("the server does not send the file in parts"); }
    const want = Math.min(size, a + PART_BYTES) - a;
    let mine = 0;
    inflight.set(n, 0);
    const counted = res.body.pipeThrough(new TransformStream({
      transform(chunk, ctl) {
        mine += chunk.byteLength;
        got += chunk.byteLength;
        inflight.set(n, mine);
        tick();
        ctl.enqueue(chunk);
      },
    }));
    const inFiles = meta && meta.store === "opfs";
    try {
      if (inFiles) await opfsPut(id, n, counted);
      else await c.put(partKey(id, n), new Response(counted, { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(want) } }));
    } catch (e) {
      inflight.delete(n);
      got -= mine;
      if (inFiles) await opfsDelete(id, n); else await c.delete(partKey(id, n)).catch(() => {});
      stopped();
      if (e && e.name === "QuotaExceededError") throw e;
      throw Object.assign(e, { net: true });
    }
    inflight.delete(n);
    if (mine !== want) { // came up short: not a part
      got -= mine;
      if (inFiles) await opfsDelete(id, n); else await c.delete(partKey(id, n)).catch(() => {});
      throw Object.assign(new Error("a part came up short"), { net: true });
    }
    done.add(n);
    lastLanded = Date.now();
    tick(true);
  };
  tick(true); // "saving" from the first moment, not once the first bytes are in
  // the first part answers what the file is (its size, its identity)
  for (;;) {
    if (aborted()) bail();
    try {
      if (!meta || !size) { await withRetry(() => fetchPart(0)); }
      break;
    } catch (e) {
      if (e && e.changed) { await changed(); continue; }
      throw e;
    }
  }
  // A save the browser was finishing by itself (the page went to the
  // background, or was closed): watched to the end, then whatever it could
  // not do is done below.
  const bgMeta = () => ({ url, size, validator: (meta && meta.validator) || "", part: PART_BYTES, title: opts.title || "", signal, onProgress });
  {
    const running = await bgRunning(id);
    if (running) {
      const how = await watchBackground(id, running, bgMeta());
      for (const n of await partsHere(id)) done.add(n);
      if (how === "cancelled") bail();
    }
  }
  // On a phone that has it: Aurora going to the background hands the rest to the browser.
  const onHidden = () => {
    if (document.visibilityState !== "hidden" || handoff || !bgAvailable() || !opts.title) return;
    handoff = true;
    inner.abort(); // (the parts in flight are dropped and handed over with the rest)
  };
  document.addEventListener("visibilitychange", onHidden);
  // then the rest, a few at a time, each retried; the whole save pauses when
  // nothing has landed for RETRY_FOR_MS
  for (let round = 0; ; round++) {
    const todo = [];
    for (let i = 0; i < count(); i++) if (!done.has(i)) todo.push(i);
    if (!todo.length) break;
    let restart = false;
    const worker = async () => {
      while (todo.length && !restart && !fatal) {
        const n = todo.shift();
        try {
          await withRetry(() => fetchPart(n));
        } catch (e) {
          if (e && e.handoff) return;
          if (e && e.changed) { restart = true; restarting = true; inner.abort(); return; }
          if (!fatal) { fatal = e; inner.abort(); }
          throw e;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PARTS_AT_ONCE, todo.length) }, worker));
      if (fatal) throw fatal;
    } catch (e) {
      document.removeEventListener("visibilitychange", onHidden);
      if (e && e.name === "QuotaExceededError") { await dropBytes(id); setSaveMeta(id, null); throw new Error(plain(e)); }
      throw e;
    }
    if (handoff) {
      if (aborted()) bail();
      await new Promise((r) => setTimeout(r, 50)); // (the parts in flight let go of the cache)
      for (const n of await partsHere(id)) done.add(n);
      let bg = null;
      try { bg = await startBackground(id, bgMeta(), done); } catch {}
      if (bg) {
        const how = await watchBackground(id, bg, bgMeta());
        for (const n of await partsHere(id)) done.add(n);
        if (how === "cancelled") { document.removeEventListener("visibilitychange", onHidden); bail(); }
      }
      // (the browser could not take it, or left parts out: the page goes on)
      handoff = false;
      inner = freshSwitch();
      continue;
    }
    if (restart) {
      // (the parts in flight were stopped: a fresh switch for the next round)
      await new Promise((r) => setTimeout(r, 50));
      if (aborted()) bail();
      inner = freshSwitch();
      restarting = false;
    }
    if (restart) { await changed(); if (round > 2) throw new Error("the file keeps changing on the server — try again later"); await withRetry(() => fetchPart(0)).catch((e) => { if (!(e && e.handoff)) throw e; }); }
  }
  document.removeEventListener("visibilitychange", onHidden);
  // all here: the manifest makes it playable
  const store = meta && meta.store === "opfs" ? "opfs" : "cache";
  await c.put(manifestKey(id), new Response(JSON.stringify({ v: 2, size, part: PART_BYTES, count: count(), type: "video/mp4", store }), { headers: { "Content-Type": "application/json" } }));
  await c.delete(mediaKey(id)).catch(() => {}); // an older one-entry copy of the same title
  setSaveMeta(id, null);
  return { size, store };

  // A part's own patience: the line away → wait for it (and say so), the
  // server gone → ask again with a growing pause; a copy swept from the
  // server → prepared again. Gives up (pauses the save) after RETRY_FOR_MS
  // without any part landing.
  async function withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (e) {
        stopped();
        if (e && (e.changed || e.name === "QuotaExceededError")) throw e;
        if (e && e.gone) {
          // the server's copy was cleared (it keeps them half a day): made again
          const again = await api.offlinePrepare(id, opts.variant || st.quality || "720", canHevc()).catch(() => null);
          if (!again || again.state === "error") throw new Error((again && again.error) || "the copy is no longer on the server");
          onProgress({ phase: "preparing", pct: again.progress || 0, note: "the server is making the copy again", waiting: again.state === "queued" });
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        if (!(e && e.net)) throw new Error(plain(e));
        if (Date.now() - lastLanded > RETRY_FOR_MS) throw Object.assign(new Error("no connection for a long while"), { pause: "offline" });
        onProgress({ phase: "retrying", pct: size ? Math.min(0.999, landedBytes() / size) : 0, note: navigator.onLine === false ? "no connection — it carries on by itself when it's back" : "can't reach the server — trying again", speed: 0 });
        await waitForLine(Math.min(30000, 1500 * 2 ** Math.min(attempt, 5)), signal);
      }
    }
  }
};

// ---------- Background Fetch (phones) ----------
// A phone stops a page soon after the screen goes off or another app comes to
// the front. Where the browser has Background Fetch (Android Chrome), the
// moment Aurora goes to the background in the middle of a save, every part
// still missing is handed to the BROWSER, which fetches them with the page
// frozen or closed (its own notification shows the progress; it waits out a
// lost line by itself), and the service worker stores them as they come in
// (sw.js). While Aurora is on screen the page's own loop is used: it is about
// four times faster (the browser holds a background fetch whole before handing
// it over — measured on this PC: 2.7 GB in 13 min against 3 min). A computer
// keeps the page's loop (a reload carries on anyway).
// (A worker may not START a background fetch — Chrome refuses it — so it is
// one fetch for everything that is missing, not batches.)
// The id carries what the worker needs:
//   aurora-save~<item id>~<part bytes>~<size>~<validator hash>~<n>~<url>~<title>
const bgKnob = () => { try { return localStorage.getItem("aurora-offline-bg"); } catch { return null; } };
const bgAvailable = () => {
  if (typeof window === "undefined" || !("BackgroundFetchManager" in window) || !("serviceWorker" in navigator)) return false;
  const k = bgKnob(); // "0" never, "1" always (tests), else phones only
  if (k === "0") return false;
  if (k === "1") return true;
  try { return matchMedia("(pointer: coarse)").matches; } catch { return false; }
};
export const hashOf = (text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
};
const bgPrefix = (id) => `aurora-save~${id}~`;
// The browser's fetch of this save that is running now, if any.
const bgRunning = async (id) => {
  try {
    const reg = await navigator.serviceWorker.ready;
    for (const bid of await reg.backgroundFetch.getIds()) if (bid.startsWith(bgPrefix(id))) return reg.backgroundFetch.get(bid);
  } catch {}
  return null;
};
const startBackground = async (id, m, have) => {
  const reg = await navigator.serviceWorker.ready;
  const count = Math.ceil(m.size / m.part);
  const todo = [];
  for (let n = 0; n < count; n++) if (!have.has(n)) todo.push(n);
  if (!todo.length) return null;
  const total = todo.reduce((t, n) => t + Math.min(m.part, m.size - n * m.part), 0);
  // the browser holds it all until the end: room for it twice, or the page's loop
  try {
    const est = await navigator.storage.estimate();
    if (est && est.quota && est.quota - (est.usage || 0) < total * 2.1) return null;
  } catch {}
  const bid = ["aurora-save", id, m.part, m.size, hashOf(m.validator || ""), Date.now() % 1e9, encodeURIComponent(m.url), encodeURIComponent(String(m.title || "").slice(0, 80))].join("~");
  const reqs = todo.map((n) => new Request(m.url, { headers: { Range: `bytes=${n * m.part}-${Math.min(m.size, (n + 1) * m.part) - 1}` } }));
  return reg.backgroundFetch.fetch(bid, reqs, {
    title: `Saving “${m.title}” to this device`,
    icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    downloadTotal: total,
  });
};
// Stop the browser's own fetch of this save (Cancel).
const stopBackground = async (id) => {
  if (typeof window === "undefined" || !("BackgroundFetchManager" in window)) return;
  const bg = await bgRunning(id);
  if (bg) await bg.abort().catch(() => {});
};
// Watch the browser's fetch: → "complete" (every part in) | "fallback" (it
// failed, or stored only part of it — the page carries on) | "cancelled".
const watchBackground = async (id, bg, m) => {
  const count = Math.ceil(m.size / m.part);
  const t0 = Date.now();
  const landedOf = (have) => [...have].reduce((t, n) => t + Math.min(m.part, m.size - n * m.part), 0);
  const base = landedOf(await partsHere(id));
  let lastCount = -1;
  let still = 0;
  for (;;) {
    if (m.signal && m.signal.aborted) { await bg.abort().catch(() => {}); return "cancelled"; }
    const have = await partsHere(id);
    if (have.size >= count) return "complete";
    const landed = landedOf(have);
    // (its bytes count once, held by the browser or stored by the worker)
    const now = Math.max(landed, base + (bg.downloaded || 0));
    const secs = (Date.now() - t0) / 1000;
    const speed = secs > 2 ? Math.max(0, now - base) / secs : 0;
    m.onProgress({ phase: "saving", pct: Math.min(0.999, now / m.size), note: "the browser is saving it — it carries on with Aurora closed", speed, eta: speed > 0 ? Math.round((m.size - now) / speed) : 0, size: m.size });
    if (bg.result) {
      // finished: the worker is storing the parts — until nothing more comes
      if (have.size === lastCount) still++; else { still = 0; lastCount = have.size; }
      if (still >= 15) return "fallback";
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
};

// A pause before asking again — cut short when the browser says the line is back.
const waitForLine = (ms, signal) => new Promise((resolve) => {
  const done = () => {
    clearTimeout(t);
    window.removeEventListener("online", done);
    if (signal) signal.removeEventListener("abort", done);
    resolve();
  };
  const t = setTimeout(done, navigator.onLine === false ? 10 * 60 * 1000 : ms);
  window.addEventListener("online", done, { once: true });
  if (signal) signal.addEventListener("abort", done, { once: true });
});

// THE EXTRAS. A saved copy used to be the picture, the sound and the
// subtitles — and nothing else: no Skip intro, no Up next at the credits, no
// X-Ray, because the player asks the server for each of those as it starts.
// They are small answers, so they are fetched when the copy is saved and kept
// in its record:
//   segments   the detected intro / recap / credits of this episode
//   introMark  the household's hand-marked intro for the show, if any
//   xray       cast, crew and ratings for this film or this one episode (the
//              text; portraits need the server and fall back to initials)
// Best effort, each on its own: a title with no IMDb match simply has no
// X-Ray. `extrasAt` says it was tried, so backfill doesn't ask forever.
export const extrasFor = async (item) => {
  const out = {};
  const show = !!item.showId;
  if (show) {
    try {
      const r = await api.introAuto(item.id);
      if (r) out.segments = { intro: r.intro || null, recap: r.recap || null, credits: r.credits || null };
    } catch {}
    try {
      const m = await api.intro(`show:${item.showId}`);
      if (m && isFinite(m.start) && isFinite(m.end)) out.introMark = { start: m.start, end: m.end };
    } catch {}
  }
  try {
    let imdbId = (!show && item.imdbId) || null;
    if (!imdbId) {
      const r = await api.imdbFor(show ? "show" : "movie", show ? item.showTitle || item.title : item.title, item.year);
      imdbId = (r && r.imdbId) || null;
    }
    if (imdbId) {
      const x = await api.xray({
        type: show ? "series" : "movie", imdbId, season: item.season, episode: item.episode,
        keys: [item.id, item.showId].filter(Boolean),
      });
      // the episode list is dropped: stepping to another episode needs the server
      if (x && !x.error) out.xray = { imdbId, data: { ...x, episodes: [] } };
    }
  } catch {}
  out.extrasAt = Date.now();
  return out;
};

// Merge fields into a saved record (the player refreshes a copy's extras
// when it finds the server in reach).
export const patchSaved = async (id, fields) => {
  const it = await getSaved(id);
  if (!it) return null;
  const next = { ...it, ...fields };
  await tx("items", "readwrite", (s) => s.put(next));
  return next;
};

// Copies saved before the extras existed get them the next time the server
// answers (main.js calls this beside flushProgress). One at a time, quietly.
let backfilling = false;
export const backfillExtras = async () => {
  if (!available() || backfilling) return 0;
  backfilling = true;
  let n = 0;
  // "nothing known about this title" and "nobody answered" must not look the
  // same, or a copy would be stamped as tried while the server was away
  const serverUp = () => fetch("/api/ping", { cache: "no-store" }).then((r) => r.ok).catch(() => false);
  try {
    for (const it of await listSaved()) {
      if (it.extrasAt) continue;
      if (!(await serverUp())) break;
      await patchSaved(it.id, await extrasFor(it));
      n++;
    }
  } catch {} finally {
    backfilling = false;
  }
  return n;
};

// The episode after this one AMONG THE SAVED COPIES — what Up next offers
// when there is no server to ask what comes next.
export const nextSaved = async (item) => {
  if (!item || !item.showId) return null;
  const eps = (await listSaved())
    .filter((x) => x.showId === item.showId && x.season != null && x.episode != null)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const i = eps.findIndex((x) => x.id === item.id);
  return i >= 0 ? eps[i + 1] || null : null;
};

// Watch progress made offline: queued, then flushed on the next contact.
export const queuedProgress = async () => (available() ? getAll("progress") : []);
export const queueProgress = (profileId, itemId, position, duration) =>
  available() ? tx("progress", "readwrite", (s) => s.put({ itemId, profileId, position, duration, at: Date.now() })) : null;
export const flushProgress = async () => {
  if (!available()) return 0;
  const rows = await getAll("progress");
  let n = 0;
  for (const r of rows) {
    try {
      await api.saveProgress(r.profileId, r.itemId, r.position, r.duration);
      await tx("progress", "readwrite", (s) => s.delete(r.itemId));
      n++;
    } catch {
      break; // still offline — try again next time
    }
  }
  return n;
};

export const storageEstimate = async () => {
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
};

export const registerWorker = () => {
  if (!available()) return;
  navigator.serviceWorker
    .register("/sw.js")
    .then((reg) => {
      // keep the precached shell current with what the server has now
      const ping = () => (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: "precache" });
      if (reg.active) ping();
      else navigator.serviceWorker.addEventListener("controllerchange", ping, { once: true });
    })
    .catch((e) => { import("./telemetry.js").then((t) => t.reportError("sw", `service worker did not register: ${(e && e.name) || "error"}`)).catch(() => {}); }); // [analytics]
};

// ---------- one in-memory index of this device's copies (2026-11-10, round 2) ----------
// Screens ask "is this saved here?" for every card of a shelf: answered from
// memory (a Map kept fresh by every save, removal and the other tabs), never
// an IndexedDB round trip per card.
//   savedNow(id)  → true | false              (sync)
//   stateOf(id)   → "saved" | "queued" | "preparing" | "saving" | "retrying" |
//                   "paused" | "failed" | "waiting" (a wish: not on the server yet) | null   (sync)
//   onIndex(fn)   → unsubscribe; fn() whenever any of that may have changed
const index = new Map(); // id -> a copy's summary (slim below)
let indexReady = false;
const indexSubs = new Set();
const wishStates = new Map(); // library id, or "imdb|season|episode" -> wish state (offlineWish.js tells)
const slim = (it) => ({
  id: it.id, title: it.title, showId: it.showId || null, showTitle: it.showTitle || null, season: it.season ?? null, episode: it.episode ?? null,
  sizeBytes: it.sizeBytes || 0, quality: it.quality || null, audioLang: it.audioLang || null, profileId: it.profileId || null, kids: !!it.kids,
  savedAt: it.savedAt || 0, cover: it.cover || null, duration: it.duration || 0,
});
const tellIndex = () => { for (const fn of [...indexSubs]) { try { fn(); } catch {} } };
// (only in a page: a channel open in Node — the tests that import this file — keeps the process alive)
const channel = (() => {
  try {
    if (typeof window === "undefined" || typeof BroadcastChannel !== "function") return null;
    const ch = new BroadcastChannel("aurora-offline");
    if (typeof ch.unref === "function") ch.unref();
    return ch;
  } catch { return null; }
})();
const indexPut = (it) => {
  if (!it || it.pending) return;
  index.set(it.id, slim(it));
  tellIndex();
  try { if (channel) channel.postMessage({ type: "changed" }); } catch {}
};
const indexDrop = (id) => {
  if (index.delete(id)) tellIndex();
  try { if (channel) channel.postMessage({ type: "changed" }); } catch {}
};
export const refreshIndex = async () => {
  if (!available()) return index;
  try {
    const all = await listSaved();
    index.clear();
    for (const it of all) index.set(it.id, slim(it));
  } catch {}
  indexReady = true;
  tellIndex();
  return index;
};
if (channel) channel.onmessage = () => { refreshIndex().catch(() => {}); };
if (typeof window !== "undefined" && available()) refreshIndex().catch(() => {});
export const savedNow = (id) => index.has(id);
export const stateOf = (id) => {
  const j = jobs.get(id);
  if (j && j.state) return j.state;
  if (index.has(id)) return "saved";
  return wishStates.get(id) || null;
};
export const onIndex = (fn) => { indexSubs.add(fn); return () => indexSubs.delete(fn); };
// The wish state of a title that is not in the library yet (an episode card
// on its way): stateOfTitle({ imdbId, season, episode }) → "waiting" | "failed" | null
export const stateOfTitle = (t) => (t && t.imdbId ? wishStates.get(`${t.imdbId}|${t.season ?? ""}|${t.episode ?? ""}`) || null : null);
// (offlineWish.js tells this device's wishes)
let lastWishes = [];
export const _noteWishList = (list) => {
  lastWishes = list || [];
  wishStates.clear();
  for (const w of lastWishes) {
    const st = w.state === "failed" ? "failed" : "waiting";
    if (w.libraryId) { if (!index.has(w.libraryId)) wishStates.set(w.libraryId, st); }
    if (w.imdbId) wishStates.set(`${w.imdbId}|${w.season ?? ""}|${w.episode ?? ""}`, st);
  }
  tellIndex();
};

// ---------- everything on this device, live ----------
// watchSaves(fn) → unsubscribe. fn(rows) at once and whenever anything moves:
//   rows: [{ id, kind, title, showTitle, season, episode, cover, state, pct, bytes, totalBytes, speed, eta, note, error, quality }]
//   kind "save" (under way or stopped), "copy" (saved here), "wish" (waiting for the server's copy)
//   state as stateOf(); pct 0..1; bytes / totalBytes in bytes (0 while not known); speed bytes/s; eta seconds
const rowsNow = () => {
  const rows = [];
  for (const j of listJobs()) {
    const it = j.item || {};
    const total = j.size || 0;
    rows.push({
      id: j.id, kind: "save", title: j.title || it.title || "", showTitle: it.showTitle || null, season: it.season ?? null, episode: it.episode ?? null, cover: j.cover || it.cover || null,
      state: j.state, pct: j.pct || 0, bytes: total ? Math.round((j.pct || 0) * total) : 0, totalBytes: total, speed: j.speed || 0, eta: j.eta || 0,
      note: j.note || "", error: j.error || null, quality: j.quality || null,
    });
  }
  const busy = new Set(rows.map((r) => r.id));
  for (const it of index.values()) {
    if (busy.has(it.id)) continue;
    rows.push({ id: it.id, kind: "copy", title: it.title, showTitle: it.showTitle, season: it.season, episode: it.episode, cover: it.cover, state: "saved", pct: 1, bytes: it.sizeBytes, totalBytes: it.sizeBytes, speed: 0, eta: 0, note: "", error: null, quality: it.quality, audioLang: it.audioLang, profileId: it.profileId, kids: it.kids });
  }
  for (const w of lastWishes) {
    if (w.state === "ready" && w.libraryId && (busy.has(w.libraryId) || index.has(w.libraryId))) continue;
    rows.push({ id: `wish:${w.id}`, wishId: w.id, kind: "wish", title: w.title || "", showTitle: w.showTitle || null, season: w.season ?? null, episode: w.episode ?? null, cover: w.poster || null, state: w.state === "failed" ? "failed" : "waiting", scope: w.scope, pct: 0, bytes: 0, totalBytes: 0, speed: 0, eta: 0, note: w.note || "", error: w.error || null, quality: w.quality });
  }
  return rows;
};
export const watchSaves = (fn) => {
  let t = null;
  const send = () => { t = null; try { fn(rowsNow()); } catch {} };
  const soon = () => { if (!t) t = setTimeout(send, 0); };
  const a = onJobs(soon);
  const b = onIndex(soon);
  send();
  return () => { a(); b(); if (t) clearTimeout(t); };
};

// Is this copy watched to the end? The server's rule: past 95 %, or marked
// watched — from the app's history, or minutes watched here with no server.
const finishedIn = (progress, queued) => (id) => {
  const q = queued.get(id);
  if (q && q.duration > 0 && q.position / q.duration > 0.95) return true;
  const p = progress[id];
  return !!(p && (p.finished || (p.duration > 0 && p.position / p.duration > 0.95)));
};
const historyNow = async () => {
  let progress = {};
  let me = null;
  try {
    const { state } = await import("./state.js");
    progress = state.progress || {};
    if (state.profile) me = { id: state.profile.id, kids: !!state.profile.kids };
  } catch {}
  const queued = new Map((await queuedProgress().catch(() => [])).map((r) => [r.itemId, r]));
  return { progress, queued, me: me || lastWho() };
};

// Copies watched to the end — for a "Remove watched" button. Nothing is
// removed here: the person decides.  → { copies: [copy], totalBytes }
//   who: { id, kids } (a kids profile sees only its own) — default: the app's profile
export const watchedCopies = async (who = null) => {
  const h = await historyNow();
  const done = finishedIn(h.progress, h.queued);
  const copies = (await listSavedFor(who || h.me)).filter((it) => done(it.id));
  return { copies, totalBytes: copies.reduce((n, it) => n + (it.sizeBytes || 0), 0) };
};

// The storage picture for a screen: Aurora's copies, the room left, whether
// the browser keeps them, and Safari's 7-day rule.
//   → { count, bytes, usage, quota, free, persisted: true | false | null, safariMayClear }
export const storageSummary = async () => {
  const items = available() ? (indexReady ? [...index.values()] : await listSaved().catch(() => [])) : [];
  const est = await storageEstimate();
  let persisted = null;
  try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch {}
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|FxiOS\/|Edg\//.test(ua);
  const standalone = (() => { try { return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; } catch { return false; } })();
  return {
    count: items.length,
    bytes: items.reduce((n, it) => n + (it.sizeBytes || 0), 0),
    usage: (est && est.usage) || 0,
    quota: (est && est.quota) || 0,
    free: est && est.quota ? Math.max(0, est.quota - (est.usage || 0)) : 0,
    persisted,
    safariMayClear: safari && !standalone && persisted !== true,
  };
};

// ---------- keep the next episode ready (2026-11-10, round 2) ----------
// Opt-in, per device, off by default. When an episode saved here has been
// watched to the end (the server's rule: past 95 %), the next episode of the
// show is saved by itself at the same quality — or, when the server does not
// have it yet, wished for (offlineWish.js: saved here by itself when it
// lands). It only ADDS: nothing is ever removed by itself.
//   smartNext.get() → true | false
//   smartNext.set(on)
//   smartNext.on(fn) → unsubscribe; fn({ type, from, next, error?, on? }):
//     "saving"  the next episode is being saved here (next: { id, title, showTitle, season, episode })
//     "saved"   it is here now
//     "wished"  not on the server yet — saved here by itself when it arrives (next: { imdbId, season, episode, title, showTitle })
//     "failed"  it could not be saved (error: the reason)
//     "changed" the setting changed (on)
//   smartNext.check() → looks now (Aurora opening / coming back / reconnecting
//     call it through resumeSaves; leaving the player through hashchange)
// Only episodes finished AFTER it was switched on count — switching it on is
// not a flood of every episode watched before.
const SMART_KEY = "aurora-offline-smartnext";
const SMART_AT_KEY = "aurora-offline-smartnext-at";
const SMART_DONE_KEY = "aurora-offline-smartnext-done";
const smartSubs = new Set();
const smartTell = (e) => { for (const fn of [...smartSubs]) { try { fn(e); } catch {} } };
const smartDone = () => { try { return new Set(JSON.parse(localStorage.getItem(SMART_DONE_KEY) || "[]")); } catch { return new Set(); } };
const smartMark = (id, on = true) => {
  const d = smartDone();
  if (on) d.add(id); else d.delete(id);
  try { localStorage.setItem(SMART_DONE_KEY, JSON.stringify([...d].slice(-400))); } catch {}
};
let smartChecking = false;
export const smartNext = {
  get: () => { try { return localStorage.getItem(SMART_KEY) === "1"; } catch { return false; } },
  set: (on) => {
    try {
      localStorage.setItem(SMART_KEY, on ? "1" : "0");
      if (on) localStorage.setItem(SMART_AT_KEY, String(Date.now()));
    } catch {}
    smartTell({ type: "changed", on: !!on });
    if (on) setTimeout(() => { smartNext.check().catch(() => {}); }, 0);
  },
  on: (fn) => { smartSubs.add(fn); return () => smartSubs.delete(fn); },
  check: async () => {
    if (!smartNext.get() || !available() || smartChecking) return 0;
    smartChecking = true;
    let n = 0;
    try {
      const since = Number(localStorage.getItem(SMART_AT_KEY)) || 0;
      const h = await historyNow();
      const done = smartDone();
      // finished after it was switched on: the history's own date, or minutes watched here offline
      const finishedSince = (id) => {
        const q = h.queued.get(id);
        if (q && q.at >= since && q.duration > 0 && q.position / q.duration > 0.95) return true;
        const p = h.progress[id];
        return !!(p && (p.updatedAt || 0) >= since && (p.finished || (p.duration > 0 && p.position / p.duration > 0.95)));
      };
      for (const it of await listSaved()) {
        if (!it.showId || it.season == null || it.episode == null) continue;
        if (done.has(it.id) || !finishedSince(it.id)) continue;
        smartMark(it.id);
        const r = await smartFor(it).catch(() => false);
        if (r === "offline") { smartMark(it.id, false); break; } // no server: the next chance asks again
        if (r) n++;
      }
    } finally {
      smartChecking = false;
    }
    return n;
  },
};
const qualityLike = (want, options) => {
  if (options.some((o) => o.quality === want)) return want;
  const order = ["original", "1080", "720", "480"];
  const from = Math.max(0, order.indexOf(want));
  return order.slice(from).find((q) => options.some((o) => o.quality === q)) || (options[0] || {}).quality;
};
const smartFor = async (it) => {
  let r;
  try { r = await api.nextEpisode({ id: it.id }); } catch { return "offline"; }
  const next = r && r.next;
  if (!next) return false;
  const showTitle = it.showTitle || null;
  if (next.kind === "library" && next.id) {
    if (index.has(next.id) || ACTIVE_JOB.has((jobs.get(next.id) || {}).state)) return false;
    let item;
    try { item = await api.item(next.id); } catch { return "offline"; }
    if (!item) return false;
    const nx = { ...item, showTitle: item.showTitle || showTitle, showId: item.showId || it.showId };
    const desc = { id: nx.id, title: nx.title, showTitle: nx.showTitle, season: nx.season, episode: nx.episode };
    queueJob(nx);
    smartTell({ type: "saving", from: it.id, next: desc });
    try {
      const saved = await saveItem(nx, () => {}, async (options) => qualityLike(it.quality || "720", options));
      if (saved) smartTell({ type: "saved", from: it.id, next: desc });
      return !!saved;
    } catch (e) {
      smartTell({ type: "failed", from: it.id, next: desc, error: (e && e.message) || String(e) });
      return false;
    }
  }
  if (next.kind === "stream" && next.imdbId) {
    const target = { type: "show", imdbId: next.imdbId, season: next.season, episode: next.episode, title: next.title || `Episode ${next.episode}`, showTitle };
    try {
      const w = await import("./offlineWish.js");
      await w.addWish(target, it.quality || "720");
      smartTell({ type: "wished", from: it.id, next: target });
      return true;
    } catch (e) {
      smartTell({ type: "failed", from: it.id, next: target, error: (e && e.message) || String(e) });
      return false;
    }
  }
  return false;
};
// Leaving the player (any screen change) is the moment an episode may just have been finished.
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => { if (smartNext.get()) setTimeout(() => { smartNext.check().catch(() => {}); }, 1500); });
}

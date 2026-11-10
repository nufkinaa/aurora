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

const DB = "aurora-offline";
const MEDIA = "aurora-media";
export const PART_BYTES = 16 * 1024 * 1024;
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

export const listSaved = async () => (available() ? (await getAll("items")).sort((a, b) => b.savedAt - a.savedAt) : []);
// What THIS person may see and play (`who`: { id, kids } — the profile, or lastWho()).
export const listSavedFor = async (who) => (await listSaved()).filter(visibleTo(who));
export const getSaved = async (id) => (available() ? tx("items", "readonly", (s) => s.get(id)) : null);
export const isSaved = async (id) => !!(await getSaved(id));

// Every piece of a copy: the one entry of an old save, the parts, the
// manifest, the subtitles, the record.
const dropBytes = async (id) => {
  setSaveMeta(id, null);
  try { navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage({ type: "offline-removed", id }); } catch {}
  const c = await caches.open(MEDIA);
  await c.delete(mediaKey(id)).catch(() => {});
  await c.delete(manifestKey(id)).catch(() => {});
  for (const k of await c.keys().catch(() => [])) {
    const p = new URL(k.url).pathname;
    if (p.startsWith(`/offline/part/${id}/`)) await c.delete(k).catch(() => {});
  }
};
export const removeSaved = async (id) => {
  await dropBytes(id);
  const it = await getSaved(id);
  const c = await caches.open(MEDIA);
  for (const sub of (it && it.subtitles) || []) if (sub.url) await c.delete(sub.url).catch(() => {});
  await tx("items", "readwrite", (s) => s.delete(id));
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
  if (ACTIVE_JOB.has(j.state) || j.state === "interrupted") { j.state = "paused"; j.why = "stopped"; }
  j.speed = 0;
  jobs.set(j.id, j);
}
const jobItem = (item) => ({
  id: item.id, title: item.title, showId: item.showId || null, showTitle: item.showTitle || null,
  season: item.season ?? null, episode: item.episode ?? null, year: item.year || null, cover: item.cover || null,
  duration: item.duration || 0, imdbId: item.imdbId || null,
  subtitles: (item.subtitles || []).filter((t) => t && t.url).slice(0, 8).map((t) => ({ label: t.label, lang: t.lang, url: t.url })),
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
  if (j && j.state !== "queued") isSaved(id).then((done) => { if (!done) dropBytes(id).catch(() => {}); }).catch(() => {});
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
  return saveItem(j.item, () => {}, async (options) =>
    options.some((o) => o.quality === j.quality) ? j.quality : choose ? choose(options) : (options[0] || {}).quality);
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
      setJob(item.id, { item: jobItem(item), title: item.title, cover: item.cover || null, quality: q, state: "preparing", pct: was.quality === q ? was.pct || 0 : 0, note: "", error: null, speed: 0, eta: 0, why: null, at: was.at || Date.now() });
    }
    return q;
  };
  const progress = (p) => {
    onProgress(p);
    if (started && ["queued", "preparing", "saving", "retrying"].includes(p.phase)) {
      setJob(item.id, { state: p.phase, pct: p.pct || 0, note: p.note || "", speed: p.speed || 0, eta: p.eta || 0, waiting: !!p.waiting });
    }
  };
  try {
    const saved = await saveOne(item, progress, pick, ctl.signal);
    if (started) dismissJob(item.id); // done: it is on the Saved list now
    return saved;
  } catch (e) {
    if (started) {
      if (e && e.name === "AbortError") { dismissJob(item.id); dropBytes(item.id).catch(() => {}); }
      else if (e && e.name === "BusyElsewhere") { /* the other tab's job is the truth */ }
      else if (e && e.pause) setJob(item.id, { state: "paused", why: e.pause, error: null, speed: 0, note: "" });
      else setJob(item.id, { state: "failed", error: (e && e.message) || String(e), speed: 0 });
    }
    throw e;
  } finally {
    if (jobCtl.get(item.id) === ctl) jobCtl.delete(item.id);
  }
};

// Every save that stopped (paused, or cut off by a reload) carries on — one
// after another, quietly. Called when Aurora opens, when the line comes back,
// when the app returns to the front and when the socket reconnects (main.js).
// A save running in another tab is left to it (withLock).
let resuming = false;
export const resumeSaves = async () => {
  if (!available() || resuming || (typeof navigator !== "undefined" && navigator.onLine === false)) return 0;
  const todo = listJobs().filter((j) => j.state === "paused" && !jobCtl.has(j.id) && j.quality);
  if (!todo.length) return 0;
  resuming = true;
  let n = 0;
  try {
    for (const j of todo) {
      if (!jobs.has(j.id) || jobs.get(j.id).state !== "paused") continue; // cancelled meanwhile
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
const isNetError = (e) => e && (e.name === "TypeError" || e.net) && !(e.name === "AbortError");

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
  try {
    ({ options = [] } = await api.offlineOptions(item.id, hevc));
  } catch (e) {
    // no server right now: a save that was under way waits for the next chance
    if (isNetError(e) || (typeof navigator !== "undefined" && navigator.onLine === false)) throw Object.assign(new Error("no connection"), { pause: "offline" });
    throw e;
  }
  if (!options.length) throw new Error("the server can't make an offline copy of this file (no ffmpeg, and it isn't playable as it is)");
  const picked = choose ? await choose(options) : (options.find((o) => o.quality === "720") || options[0]).quality;
  if (!picked) {
    onProgress({ phase: "cancelled", pct: 0 });
    return null;
  }
  const option = options.find((o) => o.quality === picked) || options[0];
  const quality = option.quality;
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
    const stopServer = () => { api.offlineCancel(item.id, quality).catch(() => {}); };
    let st;
    for (let misses = 0; ; ) {
      try { st = await api.offlinePrepare(item.id, quality, hevc); break; } catch (e) {
        if (aborted()) bail();
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
        st = await api.offlineStatus(item.id, quality, hevc);
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
    // 2. the bytes, in parts (see the top of this file)
    const meta = await oneAtATime(
      () => transfer(item.id, st, onProgress, signal),
      () => onProgress({ phase: "queued", pct: 0, note: "after the one saving now", waiting: true }),
    );
    // 3. subtitles that already exist as text tracks (best effort). Stored
    // under /offline/subs/… — the worker serves that prefix from this cache.
    const c = await caches.open(MEDIA);
    const subtitles = [];
    let n = 0;
    for (const t of (item.subtitles || []).slice(0, 8)) {
      if (!t.url) continue;
      try {
        const res = await fetch(t.url, { cache: "no-store" });
        if (!res.ok) continue;
        const key = `/offline/subs/${item.id}/${n++}`;
        await c.put(key, new Response(await res.blob(), { status: 200, headers: { "Content-Type": res.headers.get("Content-Type") || "text/vtt" } }));
        subtitles.push({ label: t.label, lang: t.lang, url: key });
      } catch {}
    }
    // 4. what the player asks the server for while a film runs — taken along
    // now, because there will be no server to ask (see extrasFor)
    const extras = await extrasFor(item).catch(() => ({}));
    const who = await whoNow();
    const saved = {
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
      sizeBytes: meta.size || st.sizeBytes || 0,
      direct: !!st.direct,
      quality,
      format: 2,
      profileId: who ? who.id : null,
      kids: !!(who && who.kids),
      controlled: await workerControls(),
      subtitles,
      savedAt: Date.now(),
    };
    await tx("items", "readwrite", (s) => s.put(saved));
    warmForOffline(who && who.id).catch(() => {});
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

// The part numbers of this copy already in the cache.
const partsHere = async (id) => {
  const out = new Set();
  try {
    const c = await caches.open(MEDIA);
    for (const k of await c.keys()) {
      const m = /^\/offline\/part\/([^/]+)\/(\d+)$/.exec(new URL(k.url).pathname);
      if (m && m[1] === id) out.add(Number(m[2]));
    }
  } catch {}
  return out;
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
const transfer = async (id, st, onProgress, signal) => {
  if (signal && signal.aborted) { const e = new Error("cancelled"); e.name = "AbortError"; throw e; }
  const c = await caches.open(MEDIA);
  const url = st.url;
  // (one part failing for good stops the others: `inner`)
  const freshSwitch = () => { const x = new AbortController(); if (signal) signal.addEventListener("abort", () => x.abort(), { once: true }); return x; };
  let inner = freshSwitch();
  let fatal = null;
  const aborted = () => !!(signal && signal.aborted);
  const bail = () => { const e = new Error("cancelled"); e.name = "AbortError"; throw e; };
  const stopped = () => { if (aborted()) bail(); if (fatal) throw fatal; };
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
    onProgress({ phase: "saving", pct: size ? Math.min(0.999, have / size) : 0, note: "downloading to this device", speed, eta: speed > 0 && size ? Math.round((size - have) / speed) : 0 });
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
      meta = { url, size, validator: v };
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
    try {
      await c.put(partKey(id, n), new Response(counted, { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(want) } }));
    } catch (e) {
      inflight.delete(n);
      got -= mine;
      await c.delete(partKey(id, n)).catch(() => {});
      stopped();
      if (e && e.name === "QuotaExceededError") throw e;
      throw Object.assign(e, { net: true });
    }
    inflight.delete(n);
    if (mine !== want) { // came up short: not a part
      got -= mine;
      await c.delete(partKey(id, n)).catch(() => {});
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
          if (e && e.changed) { restart = true; inner.abort(); return; }
          if (!fatal) { fatal = e; inner.abort(); }
          throw e;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PARTS_AT_ONCE, todo.length) }, worker));
      if (fatal) throw fatal;
    } catch (e) {
      if (e && e.name === "QuotaExceededError") { await dropBytes(id); setSaveMeta(id, null); throw new Error(plain(e)); }
      throw e;
    }
    if (restart) {
      // (the parts in flight were stopped: a fresh switch for the next round)
      await new Promise((r) => setTimeout(r, 50));
      if (aborted()) bail();
      inner = freshSwitch();
    }
    if (restart) { await changed(); if (round > 2) throw new Error("the file keeps changing on the server — try again later"); await withRetry(() => fetchPart(0)); }
  }
  // all here: the manifest makes it playable
  await c.put(manifestKey(id), new Response(JSON.stringify({ v: 2, size, part: PART_BYTES, count: count(), type: "video/mp4" }), { headers: { "Content-Type": "application/json" } }));
  await c.delete(mediaKey(id)).catch(() => {}); // an older one-entry copy of the same title
  setSaveMeta(id, null);
  return { size };

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
          const again = await api.offlinePrepare(id, st.quality || "720", canHevc()).catch(() => null);
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

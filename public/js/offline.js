// Offline copies on THIS device: what's saved (IndexedDB), the bytes (the
// service worker's media cache), and watch progress made while offline
// (queued here, flushed to the server when it's back).
//
// Needs a secure context: service workers and the Cache API are only
// available over https or localhost — `available()` says whether this
// address qualifies, and the UI explains when it doesn't.
import { api } from "./api.js";

const DB = "aurora-offline";
const MEDIA = "aurora-media";

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

export const listSaved = async () => (available() ? (await getAll("items")).sort((a, b) => b.savedAt - a.savedAt) : []);
export const getSaved = async (id) => (available() ? tx("items", "readonly", (s) => s.get(id)) : null);
export const isSaved = async (id) => !!(await getSaved(id));

export const removeSaved = async (id) => {
  const c = await caches.open(MEDIA);
  await c.delete(`/offline/media/${id}`);
  const it = await getSaved(id);
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

const fmtGb = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);

// ---------- saves in progress ----------
// Every save to this device, wherever it was started (a title page's button,
// "Save the next 3"), is a JOB here: queued, preparing (the server converts),
// saving (bytes landing, with the speed), failed (with the reason, and Retry)
// — so the "On this device" screen and My downloads can show it, and it is
// still there after the screen is left. Kept in localStorage: a save cut off
// by a reload or a closed tab comes back as "interrupted", with Resume (which
// starts the download again — a half-saved copy is never kept).
//   listJobs() / jobFor(id) / onJobs(fn) -> unsubscribe
//   cancelJob(id) · dismissJob(id) · retryJob(id, choose) · queueJob(item)
const JOBS_KEY = "aurora-offline-jobs";
const jobs = new Map(); // id -> { id, title, cover, item, quality, state, pct, note, speed, error, at }
const jobCtl = new Map(); // id -> the AbortController of a save running in THIS tab
const jobSubs = new Set();
export const ACTIVE_JOB = new Set(["queued", "preparing", "saving"]);
try {
  for (const j of JSON.parse(localStorage.getItem(JOBS_KEY) || "[]")) {
    if (!j || !j.id || !j.item) continue;
    // nothing runs across a page load: what was under way was cut off
    if (ACTIVE_JOB.has(j.state)) j.state = "interrupted";
    j.speed = 0;
    jobs.set(j.id, j);
  }
} catch {}
const jobItem = (item) => ({
  id: item.id, title: item.title, showId: item.showId || null, showTitle: item.showTitle || null,
  season: item.season ?? null, episode: item.episode ?? null, year: item.year || null, cover: item.cover || null,
  duration: item.duration || 0, imdbId: item.imdbId || null,
  subtitles: (item.subtitles || []).filter((t) => t && t.url).slice(0, 6).map((t) => ({ label: t.label, lang: t.lang, url: t.url })),
});
const emitJobs = () => {
  try { localStorage.setItem(JOBS_KEY, JSON.stringify([...jobs.values()])); } catch {}
  const list = listJobs();
  for (const fn of [...jobSubs]) { try { fn(list); } catch {} }
};
const setJob = (id, fields) => {
  jobs.set(id, { ...(jobs.get(id) || { at: Date.now() }), ...fields, id });
  emitJobs();
};
export const listJobs = () => [...jobs.values()].sort((a, b) => a.at - b.at);
export const jobFor = (id) => jobs.get(id) || null;
export const onJobs = (fn) => { jobSubs.add(fn); return () => jobSubs.delete(fn); };
export const dismissJob = (id) => { if (jobs.delete(id)) emitJobs(); };
// A save running here stops (and its job goes); one that was cut off, failed
// or only queued is simply taken off the list.
export const cancelJob = (id) => {
  const c = jobCtl.get(id);
  if (c) c.abort();
  else dismissJob(id);
};
// "Waiting for its turn" — the episodes of "Save the next 3" after the first.
export const queueJob = (item) => {
  const j = jobs.get(item.id);
  if (j && ACTIVE_JOB.has(j.state)) return;
  setJob(item.id, { item: jobItem(item), title: item.title, cover: item.cover || null, state: "queued", pct: 0, error: null, speed: 0, at: Date.now() });
};
// Again, at the size picked the first time (asked again only when the server
// can no longer make that one).
export const retryJob = (id, choose = null) => {
  const j = jobs.get(id);
  if (!j) return Promise.resolve(null);
  return saveItem(j.item, () => {}, async (options) =>
    options.some((o) => o.quality === j.quality) ? j.quality : choose ? choose(options) : (options[0] || {}).quality);
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
      setJob(item.id, { item: jobItem(item), title: item.title, cover: item.cover || null, quality: q, state: "preparing", pct: 0, note: "", error: null, speed: 0, at: (jobs.get(item.id) || {}).at || Date.now() });
    }
    return q;
  };
  const progress = (p) => {
    onProgress(p);
    if (started && (p.phase === "preparing" || p.phase === "saving")) setJob(item.id, { state: p.phase, pct: p.pct || 0, note: p.note || "", speed: p.speed || 0, waiting: !!p.waiting });
  };
  try {
    const saved = await saveOne(item, progress, pick, ctl.signal);
    if (started) dismissJob(item.id); // done: it is on the Saved list now
    return saved;
  } catch (e) {
    if (started) {
      if (e && e.name === "AbortError") dismissJob(item.id);
      else setJob(item.id, { state: "failed", error: (e && e.message) || String(e), speed: 0 });
    }
    throw e;
  } finally {
    if (jobCtl.get(item.id) === ctl) jobCtl.delete(item.id);
  }
};

// Save one library item. `onProgress({phase, pct, note})` keeps the button
// honest: "preparing" (the server converts, with its own percentage), then
// "saving" (bytes landing in the cache). `choose(options)` picks the quality
// — the server lays out what it can make for this file and this device,
// sizes included (original as is / repackaged in seconds, or a 1080p / 720p
// / 480p re-encode); resolve null to stop. `signal` (an AbortController's)
// cancels at any point: the poll, the choice, or the download itself — a
// half-saved copy is thrown away. (Called through saveItem above.)
const saveOne = async (item, onProgress, choose, signal) => {
  if (!available()) throw new Error("offline copies need a secure (https) address");
  const aborted = () => !!(signal && signal.aborted);
  const bail = () => { const e = new Error("cancelled"); e.name = "AbortError"; throw e; };
  const hevc = canHevc();
  // 0. what can be made, and which one
  const { options = [] } = await api.offlineOptions(item.id, hevc);
  if (!options.length) throw new Error("the server can't make an offline copy of this file (no ffmpeg, and it isn't playable as it is)");
  const picked = choose ? await choose(options) : (options.find((o) => o.quality === "720") || options[0]).quality;
  if (!picked) {
    onProgress({ phase: "cancelled", pct: 0 });
    return null;
  }
  const option = options.find((o) => o.quality === picked) || options[0];
  const quality = option.quality;
  // room for it? (an honest "not enough space" beats a save that dies at 90%)
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const est = await navigator.storage.estimate();
    const free = est && est.quota ? est.quota - (est.usage || 0) : 0;
    if (free && option.sizeBytes && option.sizeBytes * 1.05 > free) {
      throw new Error(`not enough browser storage here — this copy needs about ${fmtGb(option.sizeBytes)} and ${fmtGb(free)} is free. Try a smaller size.`);
    }
  } catch (e) {
    if (/not enough browser storage/.test(e.message)) throw e;
  }
  // 1. a playable file at that quality. A copy that has to wait says why
  // (the server's `wait`: behind another copy, the server busy with
  // somebody's stream, paused) — it used to say "Preparing" and nothing else
  // for as long as it took (elia's iPhone, 2026-10-20). A Cancel tells the
  // server too, so it does not go on making a copy nobody will fetch.
  const nap = (ms) => new Promise((r) => {
    const done = () => { clearTimeout(t); if (signal) signal.removeEventListener("abort", done); r(); };
    const t = setTimeout(done, ms);
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
  const stopServer = () => { api.offlineCancel(item.id, quality).catch(() => {}); };
  let st = await api.offlinePrepare(item.id, quality, hevc);
  let misses = 0;
  while (st.state === "queued" || st.state === "working") {
    if (aborted()) { stopServer(); bail(); }
    const wait = st.wait || null;
    onProgress({
      phase: "preparing",
      pct: st.progress || 0,
      waiting: st.state === "queued" || !!(wait && wait.reason === "paused"),
      note: (wait && wait.text) || (st.state === "queued" ? "waiting for the server" : option.instant ? "repackaging — a few seconds" : "converting on the server"),
    });
    await nap(option.instant && st.state === "working" ? 800 : 2000);
    if (aborted()) { stopServer(); bail(); }
    try {
      st = await api.offlineStatus(item.id, quality, hevc);
      misses = 0;
    } catch (e) {
      // a phone on the move loses the line for a moment: keep asking for a
      // while before calling it a failure (the copy goes on on the server)
      if (++misses >= 6) throw new Error(`lost touch with the server while it was preparing the copy (${(e && e.message) || "no answer"}) — try again`);
      onProgress({ phase: "preparing", pct: st.progress || 0, waiting: true, note: "can't reach the server — still trying" });
    }
  }
  if (aborted()) bail();
  if (st.state !== "ready") throw new Error(st.error || "the server couldn't prepare it");
  // 2. the bytes, streamed straight into the cache (never through memory).
  // Progress is the bytes that have actually passed through — counted on
  // the way in — against the size the server announced.
  onProgress({ phase: "saving", pct: 0, note: "downloading to this device" });
  const c = await caches.open(MEDIA);
  const key = `/offline/media/${item.id}`;
  try {
    const res = await fetch(st.url, { cache: "no-store", signal: signal || undefined });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const headers = new Headers({ "Content-Type": res.headers.get("Content-Type") || "video/mp4" });
    const len = Number(res.headers.get("Content-Length")) || st.sizeBytes || 0;
    if (len) headers.set("Content-Length", String(len));
    let got = 0;
    let lastTick = 0;
    const tStart = Date.now();
    const counted = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          got += chunk.byteLength;
          const now = Date.now();
          if (now - lastTick > 500) {
            lastTick = now;
            const secs = (now - tStart) / 1000;
            onProgress({ phase: "saving", pct: len ? Math.min(0.99, got / len) : 0, note: "downloading to this device", speed: secs > 0.5 ? got / secs : 0 });
          }
          controller.enqueue(chunk);
        },
      }),
    );
    await c.put(key, new Response(counted, { status: 200, headers }));
    if (aborted()) bail();
    // a copy that came up short is not a copy (a dropped connection used to
    // leave a file that played for ten minutes and stopped)
    if (len && got < len * 0.995) throw new Error("the download was cut short — try again");
  } catch (e) {
    await c.delete(key).catch(() => {}); // never leave half a film behind
    if (e && e.name === "QuotaExceededError") throw new Error("this browser ran out of storage for the copy — try a smaller size");
    throw e;
  }
  // 3. subtitles that already exist as text tracks (best effort). Stored
  // under /offline/subs/… — the worker serves that prefix from this cache;
  // their live /stream/… addresses are never answered offline.
  const subtitles = [];
  let n = 0;
  for (const t of (item.subtitles || []).slice(0, 6)) {
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
    sizeBytes: st.sizeBytes || 0,
    direct: !!st.direct,
    quality,
    controlled: await workerControls(),
    subtitles,
    savedAt: Date.now(),
  };
  await tx("items", "readwrite", (s) => s.put(saved));
  onProgress({ phase: "done", pct: 1 });
  return saved;
};

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

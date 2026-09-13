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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Save one library item. `onProgress({phase, pct, note})` keeps the button
// honest: "preparing" (the server converts, with its own percentage), then
// "saving" (bytes landing in the cache, sized by storage estimates).
// `confirm(status)` (optional) runs once the server knows what it will send
// — the original file, or a 720p copy — and its size; resolve false to stop.
// `signal` (an AbortController's) cancels at any point: the poll, the
// confirm, or the download itself — a half-saved copy is thrown away.
export const saveItem = async (item, onProgress = () => {}, confirm = null, signal = null) => {
  if (!available()) throw new Error("offline copies need a secure (https) address");
  const aborted = () => !!(signal && signal.aborted);
  const bail = () => { const e = new Error("cancelled"); e.name = "AbortError"; throw e; };
  // 1. a phone-playable file
  let st = await api.offlinePrepare(item.id);
  while (st.state === "queued" || st.state === "working") {
    if (aborted()) bail();
    onProgress({ phase: "preparing", pct: st.progress || 0, note: st.state === "queued" ? "waiting for the server" : "converting for this device" });
    await sleep(2000);
    st = await api.offlineStatus(item.id);
  }
  if (aborted()) bail();
  if (st.state !== "ready") throw new Error(st.error || "the server couldn't prepare it");
  if (confirm && !(await confirm(st))) {
    onProgress({ phase: "cancelled", pct: 0 });
    return null;
  }
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
    const counted = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          got += chunk.byteLength;
          const now = Date.now();
          if (now - lastTick > 500) {
            lastTick = now;
            onProgress({ phase: "saving", pct: len ? Math.min(0.99, got / len) : 0, note: "downloading to this device" });
          }
          controller.enqueue(chunk);
        },
      }),
    );
    await c.put(key, new Response(counted, { status: 200, headers }));
    if (aborted()) bail();
  } catch (e) {
    await c.delete(key).catch(() => {}); // never leave half a film behind
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
  const saved = {
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
    subtitles,
    savedAt: Date.now(),
  };
  await tx("items", "readwrite", (s) => s.put(saved));
  onProgress({ phase: "done", pct: 1 });
  return saved;
};

// Watch progress made offline: queued, then flushed on the next contact.
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
    .catch(() => {});
};

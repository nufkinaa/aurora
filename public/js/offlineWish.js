// "Save it to this device too" — before the server has it (elia, 2026-11-10).
// The website's half of docs/offline-wishes.md:
//   addWish(target, quality)   this device waits for a film / an episode / a
//                              whole season still on its way to the library
//   syncWishes()               ask the server for this device's wishes and save
//                              every ready one by itself (one after another),
//                              then tell the server it is saved — called when
//                              Aurora opens, comes back to the front, when the
//                              socket (re)connects and on "offline_wish" (main.js)
//   listWishes() / onWishes(fn) / wishFor(target) / removeWish(id)
//   askWish(target, label)     the size sheet + addWish, for the buttons
// The device is the one "Play on TV" knows (remote.js deviceId()).
import { api } from "./api.js";
import { state } from "./state.js";
import { toast } from "./ui.js";
import * as offline from "./offline.js";
import { deviceId, deviceName } from "./remote.js";
import { pickOfflineQuality } from "./offlinePicker.js";

let wishes = [];
const subs = new Set();
const emit = () => { for (const fn of [...subs]) { try { fn(wishes); } catch {} } };
export const listWishes = () => wishes;
export const onWishes = (fn) => { subs.add(fn); return () => subs.delete(fn); };

// The wish (or the season wish) that covers this title on this device, if any.
//   target: { type, imdbId, season?, episode? }
export const wishFor = (t) => {
  if (!t || !t.imdbId) return null;
  const type = t.type === "show" || t.type === "series" ? "show" : "movie";
  const own = wishes.filter((w) => !w.parentId && w.type === type && w.imdbId === t.imdbId);
  if (type === "movie") return own[0] || null;
  return own.find((w) => w.scope === "title" && Number(w.season) === Number(t.season) && Number(w.episode) === Number(t.episode))
    || own.find((w) => w.scope === "season" && Number(w.season) === Number(t.season)) || null;
};

const mine = (w) => w && w.deviceId === deviceId();
const upsert = (w) => {
  const i = wishes.findIndex((x) => x.id === w.id);
  if (i >= 0) wishes[i] = w; else wishes.push(w);
  emit();
};

// This browser's push subscription, as the server files it (sha256 of the
// endpoint — what sw.js computes): the "ready to save" notice comes to THIS
// browser only. Null when push is off here.
const pushKey = async () => {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (!sub) return null;
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub.endpoint));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
};

export const addWish = async (target, quality) => {
  if (!state.profile) throw new Error("pick a profile first");
  const body = {
    deviceId: deviceId(),
    deviceName: deviceName(),
    scope: target.scope === "season" ? "season" : "title",
    type: target.type === "show" || target.type === "series" ? "show" : "movie",
    imdbId: target.imdbId || undefined,
    jobId: target.jobId || undefined,
    season: target.season ?? undefined,
    episode: target.scope === "season" ? undefined : target.episode ?? undefined,
    title: target.title || undefined,
    showTitle: target.showTitle || undefined,
    poster: target.poster || undefined,
    quality,
    hevc: offline.canHevc(),
    pushKey: (await pushKey()) || undefined,
  };
  const r = await api.offlineWishAdd(state.profile.id, body);
  if (r && r.wish) upsert(r.wish);
  if (r && r.wish && r.wish.state === "ready") syncWishes().catch(() => {});
  return r && r.wish;
};

export const removeWish = async (id) => {
  wishes = wishes.filter((w) => w.id !== id && w.parentId !== id);
  emit();
  if (state.profile) await api.offlineWishRemove(state.profile.id, id).catch(() => {});
};

// The size sheet for a title that is not in the library yet (the server lays
// out the choices: /api/offline/wish-options), then the wish. A standing
// size preference skips the sheet. → the wish, or null when dismissed.
export const askWish = async (target, label = "") => {
  const q = {
    type: target.type === "show" || target.type === "series" ? "show" : "movie",
    imdbId: target.imdbId || "",
    ...(target.season != null ? { season: target.season } : {}),
    ...(target.episode != null ? { episode: target.episode } : {}),
    ...(target.duration ? { duration: Math.round(target.duration) } : {}),
    ...(offline.canHevc() ? { hevc: "1" } : {}),
  };
  let options = [];
  try { options = (await api.offlineWishOptions(q)).options || []; } catch {}
  if (!options.length) options = [{ quality: "720", label: "720p", detail: "", sizeBytes: 0, estimated: true }];
  const quality = await pickOfflineQuality(options, {
    title: label,
    lead: `“${label}” isn't on the server yet. It will be saved inside Aurora on this device as soon as it arrives — by itself, the next time Aurora is open here.`,
  });
  if (!quality) return null;
  const w = await addWish(target, quality);
  toast(target.scope === "season" ? `Every new episode of season ${target.season} will be saved to this device as it arrives` : `“${label}” will be saved to this device when it arrives`, "📱");
  return w;
};

// ---------- acting on them ----------
const saving = new Set();
let syncing = null;
export const syncWishes = () => {
  if (syncing) return syncing;
  syncing = (async () => {
    if (!offline.available() || !state.profile) return 0;
    let r;
    try { r = await api.offlineWishes(state.profile.id, deviceId()); } catch { return 0; }
    wishes = (r && r.wishes) || [];
    emit();
    let n = 0;
    for (const w of wishes.filter((x) => x.state === "ready" && x.libraryId)) {
      if (await saveWish(w)) n++;
    }
    return n;
  })().finally(() => { syncing = null; });
  return syncing;
};

// One ready wish: saved like any title (its job shows on Downloads and On
// this device), at the size the server prepared, then the server is told.
const saveWish = async (w) => {
  if (saving.has(w.id)) return false;
  const pid = state.profile && state.profile.id;
  if (!pid) return false;
  if (await offline.isSaved(w.libraryId).catch(() => false)) {
    await api.offlineWishSaved(pid, w.id).catch(() => {});
    wishes = wishes.filter((x) => x.id !== w.id);
    emit();
    return false;
  }
  const j = offline.jobFor(w.libraryId);
  if (j && offline.ACTIVE_JOB.has(j.state)) return false; // being saved here already
  saving.add(w.id);
  try {
    const item = await api.item(w.libraryId);
    if (!item) return false;
    const it = {
      ...item,
      showTitle: item.showTitle || w.showTitle || null,
      season: item.season ?? w.season ?? null,
      episode: item.episode ?? w.episode ?? null,
      cover: item.cover || w.poster || null,
    };
    offline.queueJob(it);
    const want = w.readyQuality || w.quality;
    const saved = await offline.saveItem(it, () => {}, async (options) =>
      options.some((o) => o.quality === want) ? want : ((options.find((o) => !o.instant) || options[0]) || {}).quality);
    if (!saved) return false;
    await api.offlineWishSaved(pid, w.id).catch(() => {});
    wishes = wishes.filter((x) => x.id !== w.id);
    emit();
    const name = it.showTitle && it.season != null ? `${it.showTitle} S${it.season} E${it.episode}` : it.title;
    toast(`“${name}” arrived and is saved on this device`, "📱", { label: "Open", onClick: () => { location.hash = "#/saved"; } });
    return true;
  } catch {
    return false; // its job row says why, with Retry; the wish stays ready
  } finally {
    saving.delete(w.id);
  }
};

// The socket's word (main.js): only this device's wishes.
export const onWishMessage = (msg) => {
  if (!msg) return;
  if (msg.type === "offline_wish_removed") {
    if (msg.deviceId && msg.deviceId !== deviceId()) return;
    wishes = wishes.filter((x) => x.id !== msg.id);
    emit();
    return;
  }
  const w = msg.wish;
  if (!mine(w)) return;
  upsert(w);
  if (w.state === "ready") syncWishes().catch(() => {});
};

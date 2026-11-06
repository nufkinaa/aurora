// Films and episodes saved ON THIS PHONE (phone/offline/rules.ts has the rules).
//
//   saveOffline(item)   asks the server what it can make (the website's
//                       /api/offline flow), picks the person's quality (or asks),
//                       waits while the server prepares it, then hands the
//                       bytes to Android's DownloadManager (OfflineModule.kt):
//                       background, resumable, Wi-Fi-only when asked, its own
//                       notification. Subtitles are fetched beside the film.
//   cancelOffline(id)   stops it, wherever it is (the server is told too)
//   removeOffline(id)   deletes the copy
//   useOffline()        the list, live; offlineFor(id) one entry
//
// Kept in this phone's storage, one list for the phone, each copy tagged with
// the profile that saved it — a profile is shown its own copies only (a kids
// profile never sees a grown-up's). Progress made while offline is queued and
// sent when the server answers again (flushOfflineProgress).
//
// The storage choices (offline/storage.ts has the rules): where new copies go (this
// phone or its SD card), a space limit (full: offer to remove the oldest watched copy),
// tidy up after watching (a saved episode goes a day after it is finished — off unless
// turned on), and keep-next (offline/keepNext.ts — off unless turned on).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState, NativeModules, Platform} from 'react-native';
import {PHONE_APP_VERSION} from '../../update';
import {useEffect, useState} from 'react';
import {api, getActiveProfile, getBaseUrl, mediaHeaders} from '../../api';
import {showToast} from '../../toast';
import {ACTIVE_STATES, fromNative, JobState, noRoomText, OfflineQuality, Option, pickOption, roomFor} from './rules';
import {dueForTidy, finishedFrom, FINISHED_AT, GB, makeRoom, STORAGE_DEFAULTS, StoragePrefs, Volume} from './storage';

export {OFFLINE_QUALITIES} from './rules';

type Native = {
  start(url: string, headers: Record<string, string>, name: string, title: string, desc: string, wifiOnly: boolean): Promise<{id: number; file: string}>;
  status(ids: number[]): Promise<{id: number; status: string; bytes?: number; total?: number; reason?: number}[]>;
  cancel(id: number): Promise<number>;
  fetchSmall(url: string, headers: Record<string, string>, name: string): Promise<string | null>;
  remove(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  space(): Promise<{free: number; used: number}>;
  network(): Promise<'wifi' | 'cellular' | 'other' | 'none'>;
  volumes?(): Promise<Volume[]>;
  setVolume?(path: string | null): Promise<string | null>;
};
const N = (NativeModules as {AuroraOffline?: Native}).AuroraOffline;

export type SavedSub = {label: string; lang?: string; file: string};
export type Saved = {
  id: string; // the library id of the film / episode
  profileId: string;
  title: string;
  showId?: string | null;
  showTitle?: string | null;
  season?: number | null;
  episode?: number | null;
  year?: number | null;
  cover?: string | null;
  duration: number;
  quality: string;
  sizeBytes: number;
  file: string | null;
  subs: SavedSub[];
  dmId: number | null;
  state: JobState;
  pct: number;
  note?: string | null;
  error?: string | null;
  waitingWifi?: boolean;
  at: number;
  savedAt?: number;
  position?: number; // where it was left, on this phone
  finishedAt?: number | null; // when it was finished (here, or as the server tells it) — tidy-up counts from it
  auto?: boolean; // saved by keep-next, not by a tap
};
export type SaveItem = {
  id: string;
  title: string;
  showId?: string | null;
  showTitle?: string | null;
  season?: number | null;
  episode?: number | null;
  year?: number | null;
  cover?: string | null;
  duration?: number;
  subtitles?: {label: string; lang?: string; url: string}[];
};

const KEY = 'aurora.offline.v1';
const PREFS_KEY = 'aurora.offline.prefs';
const PROGRESS_KEY = 'aurora.offline.progress';

let items: Saved[] = [];
let loaded = false;
const subs = new Set<(l: Saved[]) => void>();
export type OfflinePrefs = {quality: OfflineQuality; wifiOnly: boolean} & StoragePrefs;
let prefs: OfflinePrefs = {quality: 'ask', wifiOnly: false, ...STORAGE_DEFAULTS};
let ticker: ReturnType<typeof setTimeout> | null = null;
let hevc: boolean | null = null;
let space = {free: 0, used: 0};

const emit = () => {
  AsyncStorage.setItem(KEY, JSON.stringify(items)).catch(() => {});
  for (const fn of [...subs]) fn(items);
};
const put = (id: string, fields: Partial<Saved>) => {
  const i = items.findIndex(x => x.id === id && x.profileId === fields.profileId);
  const j = i >= 0 ? i : items.findIndex(x => x.id === id);
  if (j >= 0) items = items.map((x, k) => (k === j ? {...x, ...fields} : x));
  emit();
};
const get = (id: string) => items.find(x => x.id === id && x.profileId === getActiveProfile()) || null;

const ready = (async () => {
  try {
    const [raw, p] = await Promise.all([AsyncStorage.getItem(KEY), AsyncStorage.getItem(PREFS_KEY)]);
    const list = raw ? (JSON.parse(raw) as Saved[]) : [];
    // nothing runs across a restart but DownloadManager: what was preparing is cut off
    items = (Array.isArray(list) ? list : []).map(x => (x.state === 'preparing' || x.state === 'queued' ? {...x, state: 'failed' as JobState, error: 'interrupted — try again'} : x));
    if (p) prefs = {...prefs, ...JSON.parse(p)};
  } catch {}
  loaded = true;
  for (const fn of [...subs]) fn(items);
  if (prefs.volume) N?.setVolume?.(prefs.volume).catch(() => null);
  tick();
  tidyUp();
})();

export const offlineAvailable = () => !!N;
export const offlinePrefs = () => prefs;
export const setOfflinePrefs = (p: Partial<OfflinePrefs>) => {
  const was = prefs;
  prefs = {...prefs, ...p};
  AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs)).catch(() => {});
  if (p.volume !== undefined && p.volume !== was.volume) N?.setVolume?.(prefs.volume).catch(() => null);
  if (p.tidyAfter && !was.tidyAfter) tidyUp();
};
/** Where copies can go (the phone's own storage first, then an SD card), with their room. */
export const listVolumes = async (): Promise<Volume[]> => {
  try {
    return (await N?.volumes?.()) || [];
  } catch {
    return [];
  }
};
const mine = () => items.filter(x => x.profileId === getActiveProfile());
export const listOffline = () => mine();
export const offlineFor = (id: string): Saved | null => get(id);

export function useOffline(): Saved[] {
  const [l, setL] = useState<Saved[]>(mine());
  useEffect(() => {
    const fn = () => setL(mine());
    subs.add(fn);
    fn();
    return () => {
      subs.delete(fn);
    };
  }, []);
  return l;
}
export function useOfflineUsage() {
  const l = useOffline();
  const [sp, setSp] = useState(space);
  useEffect(() => {
    N?.space()
      .then(s => {
        space = s;
        setSp(s);
      })
      .catch(() => {});
  }, [l.length]);
  const done = l.filter(x => x.state === 'done');
  return {count: done.length, bytes: done.reduce((n, x) => n + (x.sizeBytes || 0), 0), free: sp.free, limitGb: prefs.limitGb};
}

// ---- the DownloadManager side ----
async function tick() {
  if (ticker) clearTimeout(ticker);
  ticker = null;
  if (!N) return;
  const saving = items.filter(x => x.state === 'saving' && x.dmId != null);
  if (!saving.length) return;
  try {
    const st = await N.status(saving.map(x => x.dmId!));
    for (const s of st) {
      const it = saving.find(x => x.dmId === s.id);
      if (!it) continue;
      const v = fromNative(s);
      if (v.state === 'done') await finish(it);
      else if (v.state === 'gone') put(it.id, {profileId: it.profileId, state: 'failed', error: 'the download was removed', dmId: null});
      else if (v.state === 'failed') put(it.id, {profileId: it.profileId, state: 'failed', error: v.error, dmId: null});
      else if (Math.abs(v.pct - it.pct) > 0.004 || v.waitingWifi !== !!it.waitingWifi) put(it.id, {profileId: it.profileId, pct: v.pct, waitingWifi: v.waitingWifi});
    }
  } catch {}
  if (items.some(x => x.state === 'saving')) ticker = setTimeout(tick, AppState.currentState === 'active' ? 1500 : 15000);
}
AppState.addEventListener('change', s => {
  if (s === 'active') {
    tick();
    flushOfflineProgress();
    tidyUp();
  }
});

async function finish(it: Saved) {
  const headers = mediaHeaders();
  const base = getBaseUrl();
  const got: SavedSub[] = [];
  let n = 0;
  for (const t of (it.subs as unknown as {label: string; lang?: string; url?: string; file?: string}[]) || []) {
    if (t.file) {
      got.push(t as SavedSub);
      continue;
    }
    if (!t.url || !N) continue;
    const file = await N.fetchSmall(t.url.startsWith('http') ? t.url : base + t.url, headers, `${it.id}-${it.quality}-sub${n++}.vtt`).catch(() => null);
    if (file) got.push({label: t.label, lang: t.lang, file});
  }
  put(it.id, {profileId: it.profileId, state: 'done', pct: 1, subs: got, savedAt: Date.now(), waitingWifi: false});
  // (keep-next's own saves arrive quietly: it is a background helper, the person did not tap)
  if (!it.auto) showToast(`“${label(it)}” is saved on this phone`, '📱');
}
const label = (it: {title: string; showTitle?: string | null; season?: number | null; episode?: number | null}) =>
  it.showTitle && it.season != null && it.episode != null ? `${it.showTitle} · S${it.season} E${it.episode}` : it.title;

const canHevc = async () => {
  if (hevc != null) return hevc;
  try {
    const caps = await (NativeModules as {AuroraAv?: {getCapabilities: () => Promise<{video?: Record<string, unknown>}>}}).AuroraAv?.getCapabilities();
    hevc = !!(caps && caps.video && (caps.video.hevc || caps.video.h265));
  } catch {
    hevc = false;
  }
  return hevc;
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type SaveResult = 'started' | 'already' | 'stopped' | 'full' | 'failed';
export type SaveOpts = {
  /** keep-next: no questions (the quality given, a full limit skips it), Wi-Fi only, no toasts */
  auto?: {quality: OfflineQuality};
  /** one of many (a whole season): no "Saving …" toast of its own */
  quiet?: boolean;
  /** asked when the space limit is full and watched copies could make room: resolve true to
   *  remove them and save, false to stop (choose.ts confirmRoom) */
  confirmRoom?: (remove: Saved[], limitGb: number) => Promise<boolean>;
};

const say = (o: SaveOpts | undefined, text: string, glyph: string) => {
  if (!o?.auto) showToast(text, glyph);
};

/**
 * Save one library item to the phone. `choose` is asked when the person's quality is
 * "Ask each time" (a sheet with the sizes); resolve null to stop.
 */
export async function saveOffline(item: SaveItem, choose: (options: Option[]) => Promise<string | null>, o?: SaveOpts): Promise<SaveResult> {
  await ready;
  const profileId = getActiveProfile();
  if (!N || !profileId) return say(o, 'Saving to this phone needs the Aurora app', '⚠'), 'failed';
  const was = get(item.id);
  if (was && ACTIVE_STATES.includes(was.state)) return say(o, `“${label(was)}” is already on its way to this phone`, '⏳'), 'already';
  if (was && was.state === 'done') return say(o, `“${label(was)}” is already on this phone`, '📱'), 'already';
  const h = await canHevc();
  let options: Option[] = [];
  try {
    options = (await api.offlineOptions(item.id, h)).options || [];
  } catch (e) {
    return say(o, (e as Error)?.message || "Couldn't reach the server", '⚠'), 'failed';
  }
  if (!options.length) return say(o, "The server can't make a copy of this file for the phone", '⚠'), 'failed';
  const picked = pickOption(options, o?.auto ? o.auto.quality : prefs.quality)?.quality || (o?.auto ? null : await choose(options));
  if (!picked) return 'stopped';
  const opt = options.find(x => x.quality === picked) || options[0];
  // the space limit (Settings → Saved on this phone): full, the oldest watched copies may make room
  if (prefs.limitGb > 0) {
    const room = makeRoom(items, profileId, opt.sizeBytes || 0, prefs.limitGb, item.id);
    if (room === null) {
      say(o, `Not saved — it would go over the ${prefs.limitGb} GB you allowed on this phone. Remove something you've watched, or raise the limit in Settings.`, '⚠');
      return 'full';
    }
    if (room.length) {
      if (o?.auto) return 'full'; // keep-next never removes anything to make room
      const yes = o?.confirmRoom ? await o.confirmRoom(room as Saved[], prefs.limitGb) : false;
      if (!yes) return 'stopped';
      for (const c of room) await removeCopy(c as Saved, true);
    }
  }
  const entry: Saved = {
    id: item.id,
    profileId,
    title: item.title,
    showId: item.showId ?? null,
    showTitle: item.showTitle ?? null,
    season: item.season ?? null,
    episode: item.episode ?? null,
    year: item.year ?? null,
    cover: item.cover ?? null,
    duration: item.duration || 0,
    quality: opt.quality,
    sizeBytes: opt.sizeBytes || 0,
    file: null,
    subs: ((item.subtitles || []).filter(t => t && t.url).slice(0, 6) as unknown) as SavedSub[],
    dmId: null,
    state: 'preparing',
    pct: 0,
    at: Date.now(),
    ...(o?.auto ? {auto: true} : {}),
  };
  items = [...items.filter(x => !(x.id === item.id && x.profileId === profileId)), entry];
  emit();
  if (!o?.quiet) say(o, `Saving “${label(entry)}” to this phone · ${opt.label}`, '📱');
  try {
    let st = await api.offlinePrepare(item.id, opt.quality, h);
    let misses = 0;
    while (st.state === 'queued' || st.state === 'working') {
      if (!get(item.id)) return 'stopped'; // cancelled meanwhile
      put(item.id, {profileId, state: 'preparing', pct: st.progress || 0, note: st.wait?.text || (st.state === 'queued' ? 'waiting for the server' : opt.instant ? 'repackaging — a few seconds' : 'converting on the server')});
      await sleep(opt.instant && st.state === 'working' ? 800 : 2000);
      try {
        st = await api.offlineStatus(item.id, opt.quality, h);
        misses = 0;
      } catch {
        if (++misses >= 6) throw new Error(`lost touch with the server while it was preparing the copy — try again`);
      }
    }
    if (!get(item.id)) return 'stopped';
    if (st.state !== 'ready' || !st.url) throw new Error(st.error || "the server couldn't prepare it");
    const sp = await N.space().catch(() => ({free: 0, used: 0}));
    const size = st.sizeBytes || opt.sizeBytes || 0;
    if (!roomFor(size, sp.free)) throw new Error(noRoomText(size, sp.free));
    const net = await N.network().catch(() => 'other');
    const wifi = prefs.wifiOnly || !!o?.auto; // keep-next never uses mobile data
    const {id: dmId, file} = await N.start(
      getBaseUrl() + st.url,
      mediaHeaders(),
      `${item.id}-${opt.quality}.mp4`,
      label(entry),
      'Saving to this phone',
      wifi,
    );
    put(item.id, {profileId, state: 'saving', dmId, file, pct: 0, note: null, sizeBytes: size, waitingWifi: wifi && net !== 'wifi'});
    tick();
    return 'started';
  } catch (e) {
    if (get(item.id)) put(item.id, {profileId, state: 'failed', error: (e as Error)?.message || String(e)});
    say(o, `Couldn't save it — ${(e as Error)?.message || 'try again'}`, '⚠');
    return 'failed';
  }
}

export async function cancelOffline(id: string) {
  const it = get(id);
  if (!it) return;
  if (it.state === 'preparing') api.offlineCancel(id, it.quality).catch(() => {});
  if (it.dmId != null) await N?.cancel(it.dmId).catch(() => 0);
  items = items.filter(x => x !== it);
  emit();
}

export async function removeOffline(id: string) {
  const it = get(id);
  if (it) await removeCopy(it, false);
}
async function removeCopy(it: Saved, quiet: boolean) {
  if (it.dmId != null && it.state !== 'done') await N?.cancel(it.dmId).catch(() => 0);
  if (it.file) await N?.remove(it.file).catch(() => false);
  for (const s of it.subs || []) if (s.file) await N?.remove(s.file).catch(() => false);
  items = items.filter(x => !(x.id === it.id && x.profileId === it.profileId));
  emit();
  if (!quiet) showToast(`Removed “${label(it)}” from this phone`, '🗑');
}

// ---- tidy up after watching (Settings → Saved on this phone; off unless turned on) ----
let playing: string | null = null;
/** The saved copy on screen now (the offline player): never tidied away under the person. */
export const setPlayingOffline = (id: string | null) => {
  playing = id;
};
let tidying = false;
let tidyTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Saved episodes finished a day ago or more leave the phone. "Finished" is what this phone
 * saw (the saved copy played to the end) or what the server says of the profile (watched on
 * the TV, the website, or streamed): the server is asked for the active profile's copies.
 * Runs at start, each time the app comes back, and hourly while it is open.
 */
export async function tidyUp(now = Date.now()) {
  if (tidyTimer) clearTimeout(tidyTimer);
  tidyTimer = null;
  if (!prefs.tidyAfter || tidying) return;
  tidying = true;
  try {
    await ready;
    const profileId = getActiveProfile();
    const open = items.filter(x => x.profileId === profileId && x.state === 'done' && x.showId && !x.finishedAt);
    if (profileId && open.length) {
      try {
        const st = await api.state(profileId);
        const prog = (st.progress || {}) as Record<string, {position?: number; duration?: number; finished?: boolean; updatedAt?: number}>;
        for (const c of open) {
          const at = finishedFrom(prog[c.id], now);
          if (at) put(c.id, {profileId, finishedAt: at});
        }
      } catch {} // no server: what this phone saw is all there is
    }
    const due = dueForTidy(items, now, playing);
    for (const c of due) await removeCopy(c as Saved, true);
    if (due.length) showToast(due.length === 1 ? `Tidied up “${label(due[0] as Saved)}” — you watched it` : `Tidied up ${due.length} episodes you've watched`, '🧹');
  } finally {
    tidying = false;
    if (prefs.tidyAfter) tidyTimer = setTimeout(() => tidyUp(), 60 * 60 * 1000);
  }
}

// ---- watching a saved copy ----
type Pending = {profileId: string; itemId: string; position: number; duration: number; at: number};
export async function noteOfflineProgress(id: string, position: number, duration: number) {
  const it = get(id);
  if (it) put(id, {profileId: it.profileId, position, ...(!it.finishedAt && duration > 0 && position / duration > FINISHED_AT ? {finishedAt: Date.now()} : {})});
  const profileId = getActiveProfile();
  if (!profileId) return;
  try {
    await api.saveProgress(profileId, id, position, duration);
  } catch {
    // no server: kept, and sent when it answers again
    try {
      const raw = await AsyncStorage.getItem(PROGRESS_KEY);
      const list: Pending[] = raw ? JSON.parse(raw) : [];
      const next = [...list.filter(p => !(p.profileId === profileId && p.itemId === id)), {profileId, itemId: id, position, duration, at: Date.now()}];
      await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(next.slice(-50)));
    } catch {}
  }
}
// ---- what a saved copy PLAYED while the server could not hear it ----
// (docs/watch-time.md) The offline player measures real play (watchClock.ts)
// and, while the socket is up, reports it like the streaming player does. With
// no server the seconds are kept here, one entry per sitting (a report id, the
// first and last moment on the phone's own clock), and sent to
// POST /api/profiles/:id/watched when the server answers again — the server
// bounds them like live reports and counts a resent one once.
const PLAYED_KEY = 'aurora.offline.played';
// `sitting`: the player's own key for one sitting; `reportId`: the store's id
// for the part of it not sent yet (a part once sent is never added to — what
// plays after it goes out under a fresh id, so the server's "counted once" holds)
export type PlayedSitting = {sitting: string; reportId: string; profileId: string; label: string; played: number; position: number; duration: number; firstAt: number; lastAt: number};
const newReportId = () => `ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let playedChain: Promise<unknown> = Promise.resolve();
const readPlayed = async (): Promise<PlayedSitting[]> => {
  const raw = await AsyncStorage.getItem(PLAYED_KEY);
  const list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list : [];
};
export function noteOfflinePlayed(s: {sitting: string; profileId: string; label: string; position: number; duration: number}, played: number) {
  if (!(played > 0)) return playedChain;
  // one write at a time: the 5-second reports must not overwrite each other
  playedChain = playedChain.then(async () => {
    try {
      const list = await readPlayed();
      const at = list.findIndex(p => p.sitting === s.sitting);
      const now = Date.now();
      if (at >= 0) list[at] = {...list[at], ...s, played: Math.round((list[at].played + played) * 10) / 10, lastAt: now};
      else list.push({...s, reportId: newReportId(), played: Math.round(played * 10) / 10, firstAt: now - played * 1000, lastAt: now});
      await AsyncStorage.setItem(PLAYED_KEY, JSON.stringify(list.slice(-50)));
    } catch {}
  });
  return playedChain;
}
let flushingPlayed = false;
export async function flushOfflinePlayed(device?: {build?: string; model?: string}) {
  if (flushingPlayed) return;
  flushingPlayed = true;
  try {
    await playedChain;
    const list = await readPlayed();
    if (!list.length) return;
    const sent = new Map<string, PlayedSitting>();
    for (const profileId of [...new Set(list.map(p => p.profileId))]) {
      const mine = list.filter(p => p.profileId === profileId);
      try {
        await api.reportWatched(profileId, mine, device);
        for (const p of mine) sent.set(p.reportId, p);
      } catch {}
    }
    if (!sent.size) return;
    // what was sent leaves; what played while it was on its way stays, as a new part
    await (playedChain = playedChain.then(async () => {
      const cur = await readPlayed();
      const left: PlayedSitting[] = [];
      for (const p of cur) {
        const was = sent.get(p.reportId);
        if (!was) left.push(p);
        else if (p.played > was.played + 0.05) left.push({...p, reportId: newReportId(), played: Math.round((p.played - was.played) * 10) / 10, firstAt: was.lastAt});
      }
      await AsyncStorage.setItem(PLAYED_KEY, JSON.stringify(left));
    }));
  } catch {
  } finally {
    flushingPlayed = false;
  }
}

export async function flushOfflineProgress() {
  // (the device, as the socket's hello names it: the admin's line for these plays)
  const c = (Platform.constants || {}) as {Brand?: string; Manufacturer?: string; Model?: string};
  flushOfflinePlayed({build: `Aurora phone ${PHONE_APP_VERSION}`, model: [c.Brand || c.Manufacturer || '', c.Model].filter(Boolean).join(' ') || undefined});
  try {
    const raw = await AsyncStorage.getItem(PROGRESS_KEY);
    const list: Pending[] = raw ? JSON.parse(raw) : [];
    if (!list.length) return;
    const left: Pending[] = [];
    for (const p of list) {
      try {
        await api.saveProgress(p.profileId, p.itemId, p.position, p.duration);
      } catch {
        left.push(p);
      }
    }
    await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(left));
  } catch {}
}
export const offlineLoaded = () => loaded;
export const limitBytes = () => (prefs.limitGb > 0 ? prefs.limitGb * GB : 0);

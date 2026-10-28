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
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState, NativeModules} from 'react-native';
import {useEffect, useState} from 'react';
import {api, getActiveProfile, getBaseUrl, mediaHeaders} from '../../api';
import {showToast} from '../../toast';
import {ACTIVE_STATES, fromNative, JobState, noRoomText, OfflineQuality, Option, pickOption, roomFor} from './rules';

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
let prefs: {quality: OfflineQuality; wifiOnly: boolean} = {quality: 'ask', wifiOnly: false};
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
  tick();
})();

export const offlineAvailable = () => !!N;
export const offlinePrefs = () => prefs;
export const setOfflinePrefs = (p: {quality: OfflineQuality; wifiOnly: boolean}) => {
  prefs = p;
  AsyncStorage.setItem(PREFS_KEY, JSON.stringify(p)).catch(() => {});
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
  return {count: done.length, bytes: done.reduce((n, x) => n + (x.sizeBytes || 0), 0), free: sp.free};
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
  showToast(`“${label(it)}” is saved on this phone`, '📱');
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

/**
 * Save one library item to the phone. `choose` is asked when the person's quality is
 * "Ask each time" (a sheet with the sizes); resolve null to stop.
 */
export async function saveOffline(item: SaveItem, choose: (options: Option[]) => Promise<string | null>): Promise<void> {
  await ready;
  const profileId = getActiveProfile();
  if (!N || !profileId) return showToast('Saving to this phone needs the Aurora app', '⚠');
  const was = get(item.id);
  if (was && ACTIVE_STATES.includes(was.state)) return showToast(`“${label(was)}” is already on its way to this phone`, '⏳');
  if (was && was.state === 'done') return showToast(`“${label(was)}” is already on this phone`, '📱');
  const h = await canHevc();
  let options: Option[] = [];
  try {
    options = (await api.offlineOptions(item.id, h)).options || [];
  } catch (e) {
    return showToast((e as Error)?.message || "Couldn't reach the server", '⚠');
  }
  if (!options.length) return showToast("The server can't make a copy of this file for the phone", '⚠');
  const picked = pickOption(options, prefs.quality)?.quality || (await choose(options));
  if (!picked) return;
  const opt = options.find(o => o.quality === picked) || options[0];
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
  };
  items = [...items.filter(x => !(x.id === item.id && x.profileId === profileId)), entry];
  emit();
  showToast(`Saving “${label(entry)}” to this phone · ${opt.label}`, '📱');
  try {
    let st = await api.offlinePrepare(item.id, opt.quality, h);
    let misses = 0;
    while (st.state === 'queued' || st.state === 'working') {
      if (!get(item.id)) return; // cancelled meanwhile
      put(item.id, {profileId, state: 'preparing', pct: st.progress || 0, note: st.wait?.text || (st.state === 'queued' ? 'waiting for the server' : opt.instant ? 'repackaging — a few seconds' : 'converting on the server')});
      await sleep(opt.instant && st.state === 'working' ? 800 : 2000);
      try {
        st = await api.offlineStatus(item.id, opt.quality, h);
        misses = 0;
      } catch {
        if (++misses >= 6) throw new Error(`lost touch with the server while it was preparing the copy — try again`);
      }
    }
    if (!get(item.id)) return;
    if (st.state !== 'ready' || !st.url) throw new Error(st.error || "the server couldn't prepare it");
    const sp = await N.space().catch(() => ({free: 0, used: 0}));
    const size = st.sizeBytes || opt.sizeBytes || 0;
    if (!roomFor(size, sp.free)) throw new Error(noRoomText(size, sp.free));
    const net = await N.network().catch(() => 'other');
    const {id: dmId, file} = await N.start(
      getBaseUrl() + st.url,
      mediaHeaders(),
      `${item.id}-${opt.quality}.mp4`,
      label(entry),
      'Saving to this phone',
      prefs.wifiOnly,
    );
    put(item.id, {profileId, state: 'saving', dmId, file, pct: 0, note: null, sizeBytes: size, waitingWifi: prefs.wifiOnly && net !== 'wifi'});
    tick();
  } catch (e) {
    if (get(item.id)) put(item.id, {profileId, state: 'failed', error: (e as Error)?.message || String(e)});
    showToast(`Couldn't save it — ${(e as Error)?.message || 'try again'}`, '⚠');
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
  if (!it) return;
  if (it.dmId != null && it.state !== 'done') await N?.cancel(it.dmId).catch(() => 0);
  if (it.file) await N?.remove(it.file).catch(() => false);
  for (const s of it.subs || []) if (s.file) await N?.remove(s.file).catch(() => false);
  items = items.filter(x => x !== it);
  emit();
  showToast(`Removed “${label(it)}” from this phone`, '🗑');
}

// ---- watching a saved copy ----
type Pending = {profileId: string; itemId: string; position: number; duration: number; at: number};
export async function noteOfflineProgress(id: string, position: number, duration: number) {
  const it = get(id);
  if (it) put(id, {profileId: it.profileId, position});
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
export async function flushOfflineProgress() {
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

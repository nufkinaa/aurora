// Films and episodes saved ON THIS DEVICE — the phone (phone/offline/rules.ts has the rules,
// docs/offline-look.md the words and the look: the place is "On this device").
//
//   saveOffline(item)   asks the server what it can make (the website's /api/offline flow),
//                       picks the person's size and sound (or asks: offline/SizeSheet.tsx),
//                       waits while the server prepares it, then hands the bytes to the
//                       phone's own saver (OfflineSaver.kt): in parts, in the background,
//                       carrying on after a dropped line, Wi-Fi only when asked. Every
//                       subtitle track the title has is fetched beside the film.
//   pauseOffline(id)    what is saved stays; nothing moves until resumeOffline(id)
//   resumeOffline(id)   carries on from where it was (also Retry of one that failed)
//   cancelOffline(id)   stops it, wherever it is (the server is told too); its part goes
//   removeOffline(id)   the person's Remove: the row goes at once, Undo brings it back for
//                       6 s, then the file goes. NOTHING is ever removed by itself.
//   carryOn()           saves cut off by the app closing, the line, or a long outage carry on
//                       by themselves — at start, back to the front, and when the server
//                       answers again (a save the person paused waits for Resume)
//   useOffline()        the list, live; offlineFor(id) one entry
//
// Kept in this phone's storage, one list for the phone, each copy tagged with the profile
// that saved it — a profile is shown its own copies only (a kids profile never sees a
// grown-up's). Progress made while offline is queued and sent when the server answers again
// (flushOfflineProgress).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState, NativeModules, Platform} from 'react-native';
import {PHONE_APP_VERSION} from '../../update';
import {useEffect, useState} from 'react';
import {api, ApiError, getActiveProfile, getBaseUrl, mediaHeaders} from '../../api';
import {showToast} from '../../toast';
import {ACTIVE_STATES, copyName, defaultSound, fmtSize, fromNative, fromSaver, JobState, MOVING_STATES, noRoomText, OfflineQuality, Option, pickOption, roomFor, SaverStatus, Sound, soundLabel} from './rules';
import {FINISHED_AT, STORAGE_DEFAULTS, StoragePrefs, Volume} from './storage';

export {OFFLINE_QUALITIES} from './rules';

type Native = {
  // the phone's own saver (OfflineSaver.kt)
  save?(key: string, url: string, headers: Record<string, string>, name: string, title: string, wifiOnly: boolean): Promise<{key: string; file: string}>;
  pauseSave?(key: string): Promise<boolean>;
  stopSave?(key: string): Promise<boolean>;
  saves?(keys: string[], files: string[]): Promise<SaverStatus[]>;
  // DownloadManager (saves begun by 1.1.2 and older)
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
  /** the file's n-th sound this copy carries (0 = the first) */
  audio?: number;
  audioLabel?: string | null;
  sizeBytes: number;
  file: string | null;
  subs: SavedSub[];
  /** the saver's name for this save (OfflineSaver.kt) */
  key?: string | null;
  /** DownloadManager's id (a save begun by 1.1.2 or older) */
  dmId: number | null;
  state: JobState;
  pct: number;
  note?: string | null;
  error?: string | null;
  waitingWifi?: boolean;
  /** preparing: the server has not started on it yet (it says why in `note`) */
  waiting?: boolean;
  /** paused: 'user' waits for Resume; 'offline' carries on by itself */
  why?: 'user' | 'offline' | null;
  speed?: number;
  eta?: number;
  at: number;
  savedAt?: number;
  position?: number; // where it was left, on this phone
  finishedAt?: number | null; // when it was finished (here, or as the server tells it)
  /** saved by itself (Keep the next episode ready, or a wish that arrived) — "Kept ready" */
  kept?: 'next' | 'wish' | null;
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
  /** the title's own language (the sound picked when the person's is not there) */
  originalLanguage?: string | null;
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
// the saves this run is driving (preparing on the server, or handed to the saver) — by `${profile}|${id}`
const driving = new Set<string>();
// copies the person removed, held for Undo (6 s) before the file goes
const removing = new Map<string, ReturnType<typeof setTimeout>>();

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
const rk = (it: {id: string; profileId: string}) => `${it.profileId}|${it.id}`;
const get = (id: string) => items.find(x => x.id === id && x.profileId === getActiveProfile() && !removing.has(rk(x))) || null;
const getFor = (id: string, profileId: string) => items.find(x => x.id === id && x.profileId === profileId) || null;

const ready = (async () => {
  try {
    const [raw, p] = await Promise.all([AsyncStorage.getItem(KEY), AsyncStorage.getItem(PREFS_KEY)]);
    const list = raw ? (JSON.parse(raw) as Saved[]) : [];
    items = Array.isArray(list) ? list : [];
    if (p) {
      // (1.1.2's space limit and tidy-up are gone: nothing leaves this device by itself)
      const {limitGb: _l, tidyAfter: _t, ...kept} = JSON.parse(p) as OfflinePrefs & {limitGb?: number; tidyAfter?: boolean};
      prefs = {...prefs, ...kept};
    }
  } catch {}
  loaded = true;
  for (const fn of [...subs]) fn(items);
  if (prefs.volume) N?.setVolume?.(prefs.volume).catch(() => null);
  tick();
})();

export const offlineAvailable = () => !!N;
export const offlinePrefs = () => prefs;
export const setOfflinePrefs = (p: Partial<OfflinePrefs>) => {
  const was = prefs;
  prefs = {...prefs, ...p};
  if (p.keepNext && !was.keepNext) prefs.keepNextAt = Date.now();
  AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs)).catch(() => {});
  if (p.volume !== undefined && p.volume !== was.volume) N?.setVolume?.(prefs.volume).catch(() => null);
  for (const fn of [...prefSubs]) fn(prefs);
};
const prefSubs = new Set<(p: OfflinePrefs) => void>();
export const onOfflinePrefs = (fn: (p: OfflinePrefs) => void) => {
  prefSubs.add(fn);
  return () => {
    prefSubs.delete(fn);
  };
};
/** Where copies can go (the phone's own storage first, then an SD card), with their room. */
export const listVolumes = async (): Promise<Volume[]> => {
  try {
    return (await N?.volumes?.()) || [];
  } catch {
    return [];
  }
};
const mine = () => {
  const p = getActiveProfile();
  return items.filter(x => x.profileId === p && !removing.has(rk(x)));
};
export const listOffline = () => mine();
export const offlineFor = (id: string): Saved | null => get(id);
/** Every profile's copies on this phone (the "Can't reach Aurora" screen shows the last profile's). */
export const offlineForProfile = (profileId: string | null) => items.filter(x => x.profileId === profileId && !removing.has(rk(x)));
export const whenOfflineLoaded = () => ready;

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
/** Every copy of one profile, live (the screen with no server, before any profile is in). */
export function useOfflineOf(profileId: string | null): Saved[] {
  const [l, setL] = useState<Saved[]>(offlineForProfile(profileId));
  useEffect(() => {
    const fn = () => setL(offlineForProfile(profileId));
    subs.add(fn);
    ready.then(fn);
    fn();
    return () => {
      subs.delete(fn);
    };
  }, [profileId]);
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

// ---- the saver's side: where each save stands ----
async function tick() {
  if (ticker) clearTimeout(ticker);
  ticker = null;
  if (!N) return;
  // saves begun by 1.1.2 and older (DownloadManager)
  const dm = items.filter(x => (x.state === 'saving' || x.state === 'retrying') && x.dmId != null && !x.key);
  if (dm.length) {
    try {
      const st = await N.status(dm.map(x => x.dmId!));
      for (const s of st) {
        const it = dm.find(x => x.dmId === s.id);
        if (!it) continue;
        const v = fromNative(s);
        if (v.state === 'done') await finish(it);
        else if (v.state === 'gone') put(it.id, {profileId: it.profileId, state: 'failed', error: 'the save was stopped — Retry starts it again', dmId: null});
        else if (v.state === 'failed') put(it.id, {profileId: it.profileId, state: 'failed', error: v.error, dmId: null});
        else if (Math.abs(v.pct - it.pct) > 0.004 || v.waitingWifi !== !!it.waitingWifi || v.state !== it.state) put(it.id, {profileId: it.profileId, state: v.state, pct: v.pct, waitingWifi: v.waitingWifi});
      }
    } catch {}
  }
  // the phone's own saver
  const mineNow = items.filter(x => x.key && (x.state === 'saving' || x.state === 'retrying' || x.state === 'queued') && driving.has(rk(x)));
  if (mineNow.length && N.saves) {
    try {
      const st = await N.saves(
        mineNow.map(x => x.key!),
        mineNow.map(x => x.file || ''),
      );
      for (const s of st) {
        const it = mineNow.find(x => x.key === s.key);
        if (!it) continue;
        const v = fromSaver(s);
        if (v.state === 'done') await finish(it);
        else if (v.state === 'gone') {
          driving.delete(rk(it));
          if (s.whole) await finish(it);
        } else if (v.state === 'failed') {
          driving.delete(rk(it));
          put(it.id, {profileId: it.profileId, state: 'failed', error: v.error, speed: 0});
        } else if (v.state === 'paused') {
          driving.delete(rk(it));
          put(it.id, {profileId: it.profileId, state: 'paused', why: v.why, pct: v.pct, speed: 0});
        } else if (Math.abs(v.pct - it.pct) > 0.002 || v.waitingWifi !== !!it.waitingWifi || v.state !== it.state || Math.abs((v.speed || 0) - (it.speed || 0)) > 50000)
          put(it.id, {profileId: it.profileId, state: v.state, pct: v.pct, waitingWifi: v.waitingWifi, speed: v.speed, eta: v.eta});
      }
    } catch {}
  }
  if (items.some(x => (x.state === 'saving' || x.state === 'retrying' || x.state === 'queued') && (x.dmId != null || driving.has(rk(x)))))
    ticker = setTimeout(tick, AppState.currentState === 'active' ? 1000 : 15000);
}
AppState.addEventListener('change', s => {
  if (s === 'active') {
    tick();
    flushOfflineProgress();
    carryOn();
  }
});

async function finish(it: Saved) {
  driving.delete(rk(it));
  const headers = mediaHeaders();
  const base = getBaseUrl();
  const got: SavedSub[] = [];
  let n = 0;
  // every subtitle track the title has (the website's rule since 1.15.28: up to 64)
  for (const t of (it.subs as unknown as {label: string; lang?: string; url?: string; file?: string}[]) || []) {
    if (t.file) {
      got.push(t as SavedSub);
      continue;
    }
    if (!t.url || !N) continue;
    const file = await N.fetchSmall(t.url.startsWith('http') ? t.url : base + t.url, headers, `${it.id}-${it.quality}${it.audio ? `-a${it.audio}` : ''}-${it.profileId.slice(0, 12)}-sub${n++}.vtt`).catch(() => null);
    if (file) got.push({label: t.label, lang: t.lang, file});
  }
  put(it.id, {profileId: it.profileId, state: 'done', pct: 1, subs: got, savedAt: Date.now(), waitingWifi: false, speed: 0, eta: 0, error: null, note: null, why: null});
  for (const fn of [...landSubs]) fn({...it, state: 'done'});
  // (the site's landing moment: one quiet toast. What was saved by itself says so once, quietly)
  const size = it.sizeBytes ? ` · ${fmtSize(it.sizeBytes)}` : '';
  if (it.kept === 'next') showToast(`Saved by itself: ${copyName(it)}`, '📱');
  else if (it.kept === 'wish') showToast(`“${copyName(it)}” arrived and is saved on this device`, '📱');
  else showToast(`“${copyName(it)}” is on this device${size} — it plays with no connection`, '📱');
}
const landSubs = new Set<(it: Saved) => void>();
/** Told when a save lands (the mark's swell, the Kept-ready line). */
export const onOfflineLanded = (fn: (it: Saved) => void) => {
  landSubs.add(fn);
  return () => {
    landSubs.delete(fn);
  };
};

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
export const phoneHevc = canHevc;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type SaveResult = 'started' | 'already' | 'stopped' | 'failed';
/** What the size sheet decides: a size, and the sound when the file has more than one. */
export type Choice = {quality: string; audio: number};
export type Chooser = (o: {options: Option[]; audio: Sound[]; chosenAudio: number; free: number}) => Promise<Choice | null>;
export type SaveOpts = {
  /** saved by itself (Keep the next episode ready, a wish): no questions, the size given (or the next one down) */
  auto?: {quality: string; kept: 'next' | 'wish'};
  /** one of many (a whole season): no "Saving …" toast of its own */
  quiet?: boolean;
  /** the size already chosen (Choose episodes asks it once for all): no sheet; the next size
   *  down when this file has no such size; the person's own sound */
  quality?: string;
};

const say = (o: SaveOpts | undefined, text: string, glyph: string) => {
  if (!o?.auto) showToast(text, glyph);
};
// the person's own language (the dub the player follows), for the sound picked by default
let likedAudio: () => string | null = () => null;
export const setLikedAudio = (fn: () => string | null) => {
  likedAudio = fn;
};

/**
 * Save one library item to the phone. `choose` is asked when the person's size is "Ask each
 * time" or the file has several sounds (the size sheet); resolve null to stop.
 */
export async function saveOffline(item: SaveItem, choose: Chooser, o?: SaveOpts): Promise<SaveResult> {
  await ready;
  const profileId = getActiveProfile();
  if (!N || !profileId) return say(o, 'Saving to this device needs the Aurora app', '⚠'), 'failed';
  const was = get(item.id);
  if (was && ACTIVE_STATES.includes(was.state)) return say(o, `“${copyName(was)}” is already on its way to this device`, '⏳'), 'already';
  if (was && was.state === 'paused') return resumeOffline(item.id).then(() => 'started' as SaveResult);
  if (was && was.state === 'done') return say(o, `“${copyName(was)}” is already on this device`, '📱'), 'already';
  const h = await canHevc();
  let options: Option[] = [];
  let sounds: Sound[] = [];
  try {
    const r = await api.offlineOptions(item.id, h);
    options = r.options || [];
    sounds = r.audio && r.audio.length > 1 ? r.audio : [];
  } catch (e) {
    return say(o, (e as Error)?.message || "Couldn't reach the server", '⚠'), 'failed';
  }
  if (!options.length) return say(o, "The server can't make a copy of this file for this device", '⚠'), 'failed';
  const chosenAudio = sounds.length ? defaultSound(sounds, likedAudio(), item.originalLanguage) : 0;
  let choice: Choice | null = null;
  if (o?.quality && !o.auto) {
    choice = {quality: pickOption(options, o.quality as OfflineQuality)?.quality || options[0].quality, audio: chosenAudio};
  } else if (o?.auto) {
    const q = pickOption(options, o.auto.quality as OfflineQuality)?.quality || options[0].quality;
    choice = {quality: q, audio: chosenAudio};
  } else {
    const pref = pickOption(options, prefs.quality);
    // (a standing size skips the sheet, as on the website — the sound is then the person's own)
    if (pref) choice = {quality: pref.quality, audio: chosenAudio};
    else {
      const sp = await N.space().catch(() => ({free: 0, used: 0}));
      choice = await choose({options, audio: sounds, chosenAudio, free: sp.free});
    }
  }
  if (!choice) return 'stopped';
  const opt = options.find(x => x.quality === choice!.quality) || options[0];
  const audio = sounds.length && choice.audio > 0 && choice.audio < sounds.length ? choice.audio : 0;
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
    audio,
    audioLabel: sounds.length ? soundName(sounds[audio]) : null,
    sizeBytes: opt.sizeBytes || 0,
    file: null,
    // every text track the title has (the site's 1.15.28 rule: up to 64 — a copy kept 6 before)
    subs: ((item.subtitles || []).filter(t => t && t.url).slice(0, 64) as unknown) as SavedSub[],
    key: null,
    dmId: null,
    state: 'preparing',
    pct: 0,
    at: Date.now(),
    ...(o?.auto ? {kept: o.auto.kept} : {}),
  };
  items = [...items.filter(x => !(x.id === item.id && x.profileId === profileId)), entry];
  emit();
  if (!o?.quiet) say(o, `Saving “${copyName(entry)}” to this device · ${opt.label}`, '📱');
  return drive(entry, o);
}
const soundName = (t: Sound | undefined) => (t ? soundLabel(t) : null);

/**
 * Take one save as far as it goes: the server prepares the copy (or joins one already made),
 * then the phone's saver brings the bytes down — carrying on from what is already here.
 * No server: the save rests (paused, 'offline') and carries on by itself next time.
 */
async function drive(entry: Saved, o?: SaveOpts): Promise<SaveResult> {
  const id = entry.id;
  const profileId = entry.profileId;
  const k = rk(entry);
  if (driving.has(k)) return 'already';
  driving.add(k);
  const alive = () => {
    const cur = getFor(id, profileId);
    return !!cur && cur.state !== 'paused' && !removing.has(k);
  };
  const h = await canHevc();
  const q = entry.quality;
  const a = entry.audio || 0;
  try {
    // (a save carrying on keeps its percent: the server's copy is there already, the part is here)
    put(id, {profileId, state: 'preparing', note: null, error: null, why: null, waiting: false});
    let st = await api.offlinePrepare(id, q, h, a);
    let misses = 0;
    while (st.state === 'queued' || st.state === 'working') {
      if (!alive()) return driving.delete(k), 'stopped';
      const waiting = st.state === 'queued' || !!st.wait;
      put(id, {profileId, state: 'preparing', waiting, pct: st.progress || 0, note: st.wait?.text || (st.state === 'queued' ? 'waiting for the server' : 'converting on the server')});
      await sleep(st.state === 'working' && (st.progress || 0) > 0.8 ? 800 : 2000);
      try {
        st = await api.offlineStatus(id, q, h, a);
        misses = 0;
      } catch (e) {
        if (e instanceof ApiError && e.status > 0) throw e;
        if (++misses >= 6) throw Object.assign(new Error('no connection'), {offline: true});
      }
    }
    if (!alive()) return driving.delete(k), 'stopped';
    if (st.state !== 'ready' || !st.url) throw new Error(st.error || "the server couldn't prepare it");
    const sp = await N!.space().catch(() => ({free: 0, used: 0}));
    const size = st.sizeBytes || entry.sizeBytes || 0;
    const have = Math.round((getFor(id, profileId)?.pct || 0) * size);
    if (!roomFor(size - have, sp.free)) throw new Error(noRoomText(size, sp.free));
    const wifi = !!prefs.wifiOnly;
    // (each profile its own file: a kids profile's copy and a grown-up's are never one file)
    const name = `${id}-${q}${a ? `-a${a}` : ''}-${profileId.slice(0, 12)}.mp4`;
    const keyName = `${profileId}-${id}-${q}${a ? `-a${a}` : ''}`;
    if (N!.save) {
      const r = await N!.save(keyName, getBaseUrl() + st.url, mediaHeaders(), name, copyName(entry), wifi);
      put(id, {profileId, state: 'saving', key: r.key, file: r.file, dmId: null, note: null, sizeBytes: size, waiting: false});
    } else {
      // (a native side without the saver — never in a 1.1.3 build)
      const r = await N!.start(getBaseUrl() + st.url, mediaHeaders(), name, copyName(entry), 'Saving to this device', wifi);
      put(id, {profileId, state: 'saving', dmId: r.id, file: r.file, note: null, sizeBytes: size});
      driving.delete(k);
    }
    tick();
    return 'started';
  } catch (e) {
    driving.delete(k);
    const cur = getFor(id, profileId);
    if (!cur || cur.state === 'paused') return 'stopped';
    const off = (e as {offline?: boolean})?.offline || (e instanceof ApiError && e.status === 0);
    if (off) {
      // no server right now: it rests, and carries on by itself the next time there is one
      put(id, {profileId, state: 'paused', why: 'offline', waiting: false, note: null});
      return 'stopped';
    }
    const msg = (e as Error)?.message || String(e);
    put(id, {profileId, state: 'failed', error: msg, waiting: false});
    say(o, `Didn't save — ${msg}`, '⚠');
    return 'failed';
  }
}

/** Pause: what is saved stays on this device; it carries on only when Resume is pressed. */
export async function pauseOffline(id: string) {
  const it = get(id);
  if (!it || !MOVING_STATES.includes(it.state) || it.state === 'paused') return;
  put(id, {profileId: it.profileId, state: 'paused', why: 'user', speed: 0, eta: 0});
  if (it.key) await N?.pauseSave?.(it.key).catch(() => false);
  driving.delete(rk(it));
}

/** Resume a paused save, or Retry one that failed: it carries on from what is here. */
export async function resumeOffline(id: string) {
  const it = get(id);
  if (!it || (it.state !== 'paused' && it.state !== 'failed')) return;
  if (it.dmId != null && !it.key) {
    // a DownloadManager save cannot carry on: it starts again through the saver
    await N?.cancel(it.dmId).catch(() => 0);
    put(id, {profileId: it.profileId, dmId: null, pct: 0});
  }
  showToast(it.state === 'paused' ? `Carrying on with “${copyName(it)}”` : `Saving “${copyName(it)}” again`, '📱');
  drive({...it, state: 'preparing'});
}

/** Saves that stopped without the person asking (the app closed, the line went, a long outage)
 *  carry on by themselves; a save the person paused waits for Resume. */
let carrying = false;
export async function carryOn() {
  if (carrying || !N) return;
  carrying = true;
  try {
    await ready;
    const profileId = getActiveProfile();
    if (!profileId) return;
    for (const it of items.filter(x => x.profileId === profileId && !removing.has(rk(x)))) {
      if (driving.has(rk(it)) || (it.dmId != null && !it.key)) continue;
      const cut = it.state === 'preparing' || it.state === 'queued' || it.state === 'saving' || it.state === 'retrying';
      if (cut || (it.state === 'paused' && it.why === 'offline')) drive(it);
    }
    tick();
  } finally {
    carrying = false;
  }
}

/** Cancel: the save stops wherever it is, and what it had saved goes. */
export async function cancelOffline(id: string) {
  const it = get(id);
  if (!it) return;
  driving.delete(rk(it));
  items = items.filter(x => x !== it);
  emit();
  if (it.state === 'preparing' || it.state === 'queued') api.offlineCancel(id, it.quality, it.audio || 0).catch(() => {});
  if (it.key) await N?.stopSave?.(it.key).catch(() => false);
  if (it.dmId != null) await N?.cancel(it.dmId).catch(() => 0);
  if (it.file) await N?.remove(it.file).catch(() => false);
}

/** Dismiss a save that didn't make it (the row goes; nothing was saved). */
export const dismissOffline = cancelOffline;

/**
 * The person's Remove (one or many: "Remove watched"): the rows go at once; Undo within 6 s
 * brings them back whole; then the files go. `say`: the toast's words (the default names it).
 */
export function removeOffline(ids: string | string[], words?: string): void {
  const list = (Array.isArray(ids) ? ids : [ids]).map(get).filter(Boolean) as Saved[];
  if (!list.length) return;
  const keys = list.map(rk);
  const gone = () => {
    for (const k of keys) {
      const t = removing.get(k);
      if (t) clearTimeout(t);
      removing.delete(k);
    }
  };
  const timer = setTimeout(async () => {
    gone();
    for (const it of list) await removeCopy(it);
  }, 6000);
  for (const k of keys) removing.set(k, timer);
  for (const fn of [...subs]) fn(items);
  const freed = list.reduce((n, c) => n + (c.sizeBytes || 0), 0);
  const text = words || (list.length === 1 ? `Removed “${copyName(list[0])}” from this device` : `Removed ${list.length} watched titles from this device — ${fmtSize(freed)} freed`);
  showToast(text, '🗑', 6000, {
    label: 'Undo',
    onPress: () => {
      clearTimeout(timer);
      gone();
      for (const fn of [...subs]) fn(items);
    },
  });
}
async function removeCopy(it: Saved) {
  if (it.key && it.state !== 'done') await N?.stopSave?.(it.key).catch(() => false);
  if (it.dmId != null && it.state !== 'done') await N?.cancel(it.dmId).catch(() => 0);
  if (it.file) await N?.remove(it.file).catch(() => false);
  for (const s of it.subs || []) if (s.file) await N?.remove(s.file).catch(() => false);
  items = items.filter(x => !(x.id === it.id && x.profileId === it.profileId));
  emit();
}

/** The saved copy on screen now (the offline player). */
let playing: string | null = null;
export const setPlayingOffline = (id: string | null) => {
  playing = id;
};
export const playingOffline = () => playing;

/** When a copy was finished, as the server says (watched on the TV, the website, or streamed). */
export async function noteFinishedFromServer(progress: Record<string, {position?: number; duration?: number; finished?: boolean; updatedAt?: number}>) {
  const profileId = getActiveProfile();
  let changed = false;
  for (const c of items) {
    if (c.profileId !== profileId || c.state !== 'done' || c.finishedAt) continue;
    const p = progress[c.id];
    if (!p) continue;
    const done = p.finished === true || (!!p.duration && p.duration > 0 && (p.position || 0) / p.duration > FINISHED_AT);
    if (done) {
      c.finishedAt = Math.min(p.updatedAt || Date.now(), Date.now());
      changed = true;
    }
  }
  if (changed) {
    items = [...items];
    emit();
  }
}

// ---- watching a saved copy ----
type Pending = {profileId: string; itemId: string; position: number; duration: number; at: number};
export async function noteOfflineProgress(id: string, position: number, duration: number, owner?: string | null) {
  // (the copy's own profile: with no server reached yet, no profile is "in" — the place the
  // person stopped still belongs to whoever saved the copy)
  const profileId = owner || getActiveProfile();
  if (!profileId) return;
  const it = getFor(id, profileId);
  if (it) put(id, {profileId: it.profileId, position, ...(!it.finishedAt && duration > 0 && position / duration > FINISHED_AT ? {finishedAt: Date.now()} : {})});
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

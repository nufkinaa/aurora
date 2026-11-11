// "Save it to this device as soon as it is on the server" — the phone's half of
// docs/offline-wishes.md (the website's is public/js/offlineWish.js; the rules are wishRules.ts):
//
//   addWish(target, size)    this device waits for it (the size sheet that asks first is
//                            wishAsk.ts: askWish / toggleWish)
//   removeWish(id)           Cancel / Dismiss
//   syncWishes()             ask the server for THIS device's wishes and save every ready one
//                            by itself, one after another; when its copy lands here, tell the
//                            server (the wish ends)
//   useWishes()              the list, live
//
// It runs only while a profile is IN (armWishes, from the phone's Main): a profile switch drops
// the list at once (registerProfileCache) and a read that was in flight for the last profile is
// thrown away when it lands (`gen`) — the next profile's wishes are read once it is in, never
// during the switch (the website's state.switching race, 1.15.28).
import {Platform} from 'react-native';
import {useEffect, useState} from 'react';
import {api, getActiveProfile, OfflineWish} from '../../api';
import {registerProfileCache} from '../../profileScope';
import {loadDevice} from '../../remote/identity';
import {showToast} from '../../toast';
import {listOffline, offlineFor, onOfflineLanded, phoneHevc, saveOffline} from './store';
import {ACTIVE_STATES, copyName} from './rules';
import {wishBody, wishFor, wishMessage, wishName, wishesToSave, WishTarget} from './wishRules';

let wishes: OfflineWish[] = [];
const subs = new Set<(l: OfflineWish[]) => void>();
// the profile the wishes are read for (null: none is in — nothing is read or saved)
let armed: string | null = null;
// bumped by every profile change: an answer that comes back for an older one is dropped
let gen = 0;
// wishes whose copy is being saved here now (wish id → the library item)
const busy = new Map<string, string>();
let syncing: Promise<number> | null = null;

const emit = () => {
  for (const fn of [...subs]) fn(wishes);
};
registerProfileCache('phone/offline/wishes.ts', () => {
  wishes = [];
  armed = null;
  gen++;
  busy.clear();
  syncing = null;
  emit();
});

export const listWishes = () => wishes;
export function useWishes(): OfflineWish[] {
  const [l, setL] = useState(wishes);
  useEffect(() => {
    subs.add(setL);
    setL(wishes);
    return () => {
      subs.delete(setL);
    };
  }, []);
  return l;
}
export const wishOf = (t: Pick<WishTarget, 'type' | 'imdbId' | 'season' | 'episode'>) => wishFor(wishes, t);

const device = async () => {
  const d = await loadDevice();
  const c = (Platform.constants || {}) as {Model?: string};
  return {id: d.id, name: c.Model ? String(c.Model) : 'Android phone'};
};
const upsert = (w: OfflineWish) => {
  const i = wishes.findIndex(x => x.id === w.id);
  wishes = i >= 0 ? wishes.map((x, k) => (k === i ? w : x)) : [...wishes, w];
  emit();
};

/** This device waits for a title still on its way to the library. */
export async function addWish(t: WishTarget, quality: string): Promise<OfflineWish | null> {
  const profileId = getActiveProfile();
  if (!profileId) throw new Error('pick a profile first');
  const [d, h] = await Promise.all([device(), phoneHevc()]);
  const r = await api.offlineWishAdd(profileId, wishBody(t, quality, d, h));
  if (r && r.error) throw new Error(r.error);
  if (r && r.wish && profileId === getActiveProfile()) {
    upsert(r.wish);
    if (r.wish.state === 'ready') syncWishes().catch(() => {});
  }
  return (r && r.wish) || null;
}

/** Cancel (a waiting one) or Dismiss (one that won't arrive): a season's own episode wishes go with it. */
export async function removeWish(id: string) {
  wishes = wishes.filter(w => w.id !== id && w.parentId !== id);
  emit();
  const profileId = getActiveProfile();
  if (profileId) await api.offlineWishRemove(profileId, id).catch(() => {});
}

// ---------- acting on them ----------
const hereState = (libraryId: string): 'done' | 'moving' | null => {
  const c = offlineFor(libraryId);
  return !c ? null : c.state === 'done' ? 'done' : ACTIVE_STATES.includes(c.state) || c.state === 'paused' ? 'moving' : null;
};

/** Ask for this device's wishes and save every ready one by itself (one after another). */
export function syncWishes(): Promise<number> {
  if (syncing) return syncing;
  const run: Promise<number> = (async () => {
    const profileId = armed;
    if (!profileId || profileId !== getActiveProfile()) return 0;
    const g = gen;
    let list: OfflineWish[];
    try {
      const d = await device();
      list = (await api.offlineWishes(profileId, d.id)).wishes || [];
    } catch {
      return 0;
    }
    if (g !== gen || armed !== profileId) return 0; // (the profile changed meanwhile: not this one's)
    wishes = list;
    emit();
    let n = 0;
    for (const w of wishesToSave(list, hereState, new Set(busy.keys()))) {
      if (g !== gen) break;
      if (await saveWish(w, profileId)) n++;
    }
    return n;
  })().finally(() => {
    if (syncing === run) syncing = null; // (a run for the last profile never clears the next one's)
  });
  syncing = run;
  return run;
}

// One ready wish: saved like any title (its row shows on On this device), at the size the
// server prepared; the server is told once the copy is HERE (onOfflineLanded below).
async function saveWish(w: OfflineWish, profileId: string): Promise<boolean> {
  const id = w.libraryId!;
  if (hereState(id) === 'done') {
    await api.offlineWishSaved(profileId, w.id).catch(() => {});
    if (profileId === armed) {
      wishes = wishes.filter(x => x.id !== w.id);
      emit();
    }
    return false;
  }
  busy.set(w.id, id);
  try {
    const item = await api.item(id, profileId);
    if (!item || profileId !== getActiveProfile()) return busy.delete(w.id), false;
    const r = await saveOffline(
      {
        id: item.id,
        title: item.title,
        showId: item.showId || null,
        showTitle: item.showTitle || w.showTitle || null,
        season: item.season ?? w.season ?? null,
        episode: item.episode ?? w.episode ?? null,
        year: item.year ?? null,
        cover: item.cover || item.poster || w.poster || null,
        duration: item.duration,
        subtitles: (item.subtitles || []).filter(t => !!t.url).map(t => ({label: t.label, lang: t.lang, url: t.url as string})),
        originalLanguage: item.originalLanguage || null,
      },
      async () => null,
      {auto: {quality: w.readyQuality || w.quality, kept: 'wish'}, quiet: true},
    );
    if (r !== 'started' && r !== 'already') busy.delete(w.id);
    return r === 'started';
  } catch {
    busy.delete(w.id); // its row says why, with Retry; the wish stays ready
    return false;
  }
}

// a copy a wish asked for is here: the wish ends
onOfflineLanded(it => {
  const ended = new Set<string>();
  for (const [wid, lib] of busy) {
    if (lib !== it.id) continue;
    busy.delete(wid);
    ended.add(wid);
  }
  // (a save that carried on by itself after a restart was not started here: its wish too)
  for (const w of wishes) if (w.state === 'ready' && w.libraryId === it.id) ended.add(w.id);
  if (!armed || it.profileId !== armed || !ended.size) return;
  for (const wid of ended) api.offlineWishSaved(armed, wid).catch(() => {});
  wishes = wishes.filter(x => !ended.has(x.id));
  emit();
});

/** The socket's word: only this device's wishes. */
export async function onWishMessage(msg: {type?: string; wish?: OfflineWish; id?: string; deviceId?: string}) {
  if (!armed) return;
  const g = gen;
  const d = await device();
  if (g !== gen) return;
  const m = wishMessage(msg, d.id);
  if (!m) return;
  if (m.kind === 'remove') {
    wishes = wishes.filter(x => x.id !== m.id);
    emit();
    return;
  }
  if (m.wish.profileId && m.wish.profileId !== armed) return;
  upsert(m.wish);
  if (m.wish.state === 'ready') syncWishes().catch(() => {});
}

/** The wishes run for this profile from now (Main's mount); the returned function stops them. */
export function armWishes(profileId: string): () => void {
  armed = profileId;
  gen++;
  syncWishes().catch(() => {});
  const mine = gen;
  return () => {
    if (gen === mine) {
      armed = null;
      gen++;
    }
  };
}

/** For the rows: the saved copy a ready wish became (by the library id). */
export const wishCopyName = (w: OfflineWish) => {
  const c = w.libraryId ? listOffline().find(x => x.id === w.libraryId) : null;
  return c ? copyName(c) : wishName(w);
};

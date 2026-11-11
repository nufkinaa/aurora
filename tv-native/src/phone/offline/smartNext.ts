// "Keep the next episode ready" (On this device / Settings; OFF unless turned on, per device) —
// the website's smartNext (public/js/offline.js, 1.15.28): when an episode saved here has been
// watched to the end (past 95 %), the next episode of the show is saved by itself at the same
// size — or, when the server does not have it yet, wished for (wishes.ts: saved here by itself
// when it lands). It only ADDS: nothing is ever removed by itself. Only episodes finished AFTER
// it was switched on count — turning it on is not a flood of every episode watched before.
//
// Looked at when Aurora opens, comes back to the front, when the server answers again, and when
// the player of a saved copy closes (lifecycle.ts).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {api, getActiveProfile} from '../../api';
import {listOffline, noteFinishedFromServer, offlineFor, offlinePrefs, saveOffline} from './store';
import {ACTIVE_STATES} from './rules';
import {readNext, smartCandidates} from './storage';
import {addWish} from './wishes';

const DONE_KEY = 'aurora.offline.smartnext.done';
let checking = false;

const readDone = async (): Promise<Set<string>> => {
  try {
    const raw = await AsyncStorage.getItem(DONE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
};
const mark = async (id: string, on = true) => {
  const d = await readDone();
  if (on) d.add(id);
  else d.delete(id);
  AsyncStorage.setItem(DONE_KEY, JSON.stringify([...d].slice(-400))).catch(() => {});
};

/** Look now. → how many next episodes were saved or wished for. Never throws. */
export async function checkSmartNext(): Promise<number> {
  const p = offlinePrefs();
  const profileId = getActiveProfile();
  if (!p.keepNext || !profileId || checking) return 0;
  checking = true;
  let n = 0;
  try {
    let progress: Record<string, {position?: number; duration?: number; finished?: boolean; updatedAt?: number}> = {};
    try {
      progress = ((await api.state(profileId)).progress || {}) as typeof progress;
      noteFinishedFromServer(progress);
    } catch {} // no server: what this phone saw is all there is (and nothing can be saved now anyway)
    const todo = smartCandidates(listOffline(), profileId, p.keepNextAt || 0, await readDone(), progress);
    for (const it of todo) {
      if (getActiveProfile() !== profileId) break;
      await mark(it.id);
      const r = await nextFor(it).catch(() => false as const);
      if (r === 'offline') {
        await mark(it.id, false); // the next chance asks again
        break;
      }
      if (r) n++;
    }
  } finally {
    checking = false;
  }
  return n;
}

async function nextFor(it: ReturnType<typeof listOffline>[number]): Promise<boolean | 'offline'> {
  let r: unknown;
  try {
    r = await api.nextEpisode({id: it.id});
  } catch {
    return 'offline';
  }
  const next = readNext(r);
  if (!next) return false;
  if (next.kind === 'library') {
    const here = offlineFor(next.id);
    if (here && (here.state === 'done' || ACTIVE_STATES.includes(here.state) || here.state === 'paused')) return false;
    let item;
    try {
      item = await api.item(next.id, it.profileId);
    } catch {
      return 'offline';
    }
    if (!item) return false;
    const res = await saveOffline(
      {
        id: item.id,
        title: item.title,
        showId: item.showId || it.showId || null,
        showTitle: item.showTitle || it.showTitle || null,
        season: item.season ?? null,
        episode: item.episode ?? null,
        year: item.year ?? null,
        cover: it.cover || item.cover || item.poster || null,
        duration: item.duration,
        subtitles: (item.subtitles || []).filter(t => !!t.url).map(t => ({label: t.label, lang: t.lang, url: t.url as string})),
        originalLanguage: item.originalLanguage || null,
      },
      async () => null,
      // (the same size as the one watched — or the next one down, when the file has no such size)
      {auto: {quality: it.quality || '720', kept: 'next'}, quiet: true},
    );
    return res === 'started';
  }
  try {
    await addWish({type: 'show', imdbId: next.imdbId, season: next.season, episode: next.episode, title: next.title || `Episode ${next.episode}`, showTitle: it.showTitle || null, poster: it.cover || null}, it.quality || '720');
    return true;
  } catch {
    return false;
  }
}

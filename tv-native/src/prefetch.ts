// Warm what the viewer is about to need, quietly (the site's prefetch.js).
//
//  • After Home paints, the reads the other sections open with — the library,
//    the first catalog page of Movies and Shows, the genre lists — so a nav
//    press lands on data that is already here.
//  • A card that holds focus for a moment gets its Detail data fetched, so the
//    page opens filled instead of assembling itself.
//
// Everything goes through api.ts's memo, so nothing here can make a screen
// show something different from what it would have fetched itself, and a
// warm that is never used costs one small request on an idle connection.
import {api, HeroItem} from './api';

let profileId: string | null = null;
export const setPrefetchProfile = (id: string | null) => {
  profileId = id;
};

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let warmedSections = false;
export const warmSections = () => {
  if (warmedSections || !profileId) return;
  warmedSections = true;
  // Well after Home's own paint, one at a time — never in front of a keypress.
  const steps: (() => Promise<unknown>)[] = [
    () => api.library(),
    () => api.catalog({type: 'movie', category: 'trending', page: 0}),
    () => api.catalog({type: 'show', category: 'trending', page: 0}),
    () => api.catalogGenres('movie'),
    () => api.catalogGenres('show'),
    () => api.changelog(),
  ];
  let i = 0;
  const next = () => {
    if (i >= steps.length) return;
    const step = steps[i++];
    step().catch(() => {}).finally(() => {
      idleTimer = setTimeout(next, 700);
    });
  };
  idleTimer = setTimeout(next, 2500);
};

// A card held under focus for 450ms: fetch what its Detail page opens with.
let dwell: ReturnType<typeof setTimeout> | null = null;
export const warmItem = (item: HeroItem | null) => {
  if (dwell) clearTimeout(dwell);
  dwell = null;
  if (!item) return;
  dwell = setTimeout(() => {
    dwell = null;
    const kind = item.type === 'show' ? 'series' : 'movie';
    if (item.imdbId) api.discoverMeta(kind, item.imdbId).catch(() => {});
    if (item.id && !String(item.id).startsWith('torrent|') && item.source !== 'stream') {
      api.item(item.showId && item.type !== 'show' ? item.showId : item.id, profileId || undefined).catch(() => {});
    }
  }, 450);
};

export const stopPrefetch = () => {
  if (idleTimer) clearTimeout(idleTimer);
  if (dwell) clearTimeout(dwell);
  idleTimer = dwell = null;
};

// Warm what the viewer is about to need, quietly (the site's prefetch.js).
//
//  • After Home paints, the reads the other sections open with — the library,
//    the first catalog page of Movies and Shows, the genre lists — so a nav
//    press lands on data that is already here.
//  • A card that holds focus for a moment gets its Detail data fetched, so the
//    page opens filled instead of assembling itself.
//
// Both wait for the remote to be at rest (settle.ts): a section's read starts
// only when focus has stopped moving, and a card's only after focus has held
// still on it — ANY focus move withdraws it, also one to something that is
// not a card (a hero button, the rail), which used to leave the card just
// left to be read anyway. (The answers are a few KB each; parsing one is far
// under a millisecond, so an answer that lands after the viewer has moved on
// costs nothing that shows.)
//
// Everything goes through api.ts's memo, so nothing here can make a screen
// show something different from what it would have fetched itself, and a
// warm that is never used costs one small request on an idle connection.
import {api, HeroItem} from './api';
import {registerProfileCache} from './profileScope';
import {onMove, whenSettled} from './settle';

let profileId: string | null = null;
export const setPrefetchProfile = (id: string | null) => {
  profileId = id;
};

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let idleRest: (() => void) | null = null;
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
    // (Not the changelog. It was warmed here too: 123 KB of JSON parsed in
    // Home's first seconds, for a list only Settings → What's new shows, and
    // only behind its "Full changelog" button — that screen reads it itself.)
  ];
  let i = 0;
  const next = () => {
    idleRest = null;
    if (i >= steps.length) return;
    const step = steps[i++];
    step().catch(() => {}).finally(() => {
      idleTimer = setTimeout(rested, 700);
    });
  };
  // each read STARTS at rest: the gap has passed AND focus is not moving
  // (the library list is ~90 KB to parse — not something to begin mid-run)
  const rested = () => {
    idleTimer = null;
    idleRest = whenSettled(next);
  };
  idleTimer = setTimeout(rested, 2500);
};

// A card held under focus for 450ms: fetch what its Detail page opens with.
export const DWELL_MS = 450;
let dwell: (() => void) | null = null;
// Focus moved: the card it left is not warmed. (A card's own handler runs
// after this — Focusable notes the move, then reports the focus — and asks
// again for the card it landed on.)
onMove(() => {
  if (dwell) {
    dwell();
    dwell = null;
  }
});
export const warmItem = (item: HeroItem | null) => {
  dwell?.();
  dwell = null;
  if (!item) return;
  dwell = whenSettled(() => {
    dwell = null;
    const kind = item.type === 'show' ? 'series' : 'movie';
    if (item.imdbId) api.discoverMeta(kind, item.imdbId).catch(() => {});
    if (item.id && !String(item.id).startsWith('torrent|') && item.source !== 'stream') {
      api.item(item.showId && item.type !== 'show' ? item.showId : item.id, profileId || undefined).catch(() => {});
    }
  }, DWELL_MS);
};

export const stopPrefetch = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleRest?.();
  dwell?.();
  idleTimer = idleRest = dwell = null;
};

// A profile is left: nothing is warmed for it any more — and the next one
// gets its own warm-up (`warmedSections` used to stay true for the whole run,
// so only the first profile of a run ever had its sections warmed).
registerProfileCache('prefetch', () => {
  stopPrefetch();
  warmedSections = false;
  profileId = null;
});

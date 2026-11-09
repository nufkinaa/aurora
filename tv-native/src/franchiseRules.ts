// FRANCHISE ORDER on the TV and the phone — the rules, and nothing else (pure:
// no React, no network). The server decides what a franchise is, its order,
// what is next and every sentence it prints (src/media/franchises — the same
// answers for the website); this file decides what the screens do with them:
//
//   · the franchise page (screens/Franchise.tsx, phone/screens/Franchise.tsx):
//     one action per entry — Play (a film the server holds), Open (a show it
//     holds), Save & watch (a film it does not: its title page, which presses
//     its own Save & watch once — `save`), Choose episode (a show it does not);
//   · the title page's `save` (navigation.tsx Detail.save): the person's own
//     press carried over from the franchise page — pressed once, for a film
//     not on the server, when the best source is known; never anything else;
//   · the end of a film (playback/FranchiseEnd.tsx): "Next in …" near the
//     credits — Play now with a countdown ONLY for a film on the server, the
//     person's "play the next" setting on, not a party guest and not past
//     "Still watching?"; otherwise nothing starts by itself.
import type {FranchiseEntry, FranchiseNext, HeroItem} from './api';
import {STILL_WATCHING_AFTER, UPNEXT_COUNTDOWN_SEC, upNextWindow} from './playerRules';
import {AUTO_PLAY_GIVE_UP_MS} from './playBest';

/** The words — the website's, exactly. */
export const FR_WORDS = {
  action: 'Watch in order',
  optional: 'Optional',
  series: 'Series',
  watched: 'Watched',
  started: 'Started',
  play: 'Play',
  open: 'Open',
  save: 'Save & watch',
  choose: 'Choose episode',
  playNow: 'Play now',
  dismiss: 'Dismiss',
  row: 'Continue the franchise',
  loadError: "Couldn't load this franchise right now.",
} as const;

// The analytics ids (server: src/lib/tel/controls-vocab.js) are written where the
// controls are, as literals (the contract test reads them there): detail.franchise,
// franchise.order / .entry / .play / .save, player.franchise.play / .save / .open / .dismiss.

const IMDB = /^tt\d{4,12}$/;
/** Whether an id is one the franchise routes take (anything else is not asked). */
export const isImdbId = (id: string | null | undefined): id is string => !!id && IMDB.test(id);

// ------------------------------------------------------- the franchise page
export type EntryActionKind = 'play' | 'open' | 'save' | 'choose';
export type EntryAction = {kind: EntryActionKind; label: string};
/** The one action an entry offers (the website's). */
export const entryAction = (e: Pick<FranchiseEntry, 'type' | 'onServer'>): EntryAction => {
  const show = e.type === 'show';
  if (e.onServer) return show ? {kind: 'open', label: FR_WORDS.open} : {kind: 'play', label: FR_WORDS.play};
  return show ? {kind: 'choose', label: FR_WORDS.choose} : {kind: 'save', label: FR_WORDS.save};
};

/** The small tags beside an entry's title: "Optional", "Series". */
export const entryTags = (e: Pick<FranchiseEntry, 'optional' | 'type'>): string[] => {
  const out: string[] = [];
  if (e.optional) out.push(FR_WORDS.optional);
  if (e.type === 'show') out.push(FR_WORDS.series);
  return out;
};

/** "Watched" / "Started" / nothing. */
export const entryStateWord = (e: Pick<FranchiseEntry, 'state'>): string | null =>
  e.state === 'watched' ? FR_WORDS.watched : e.state === 'started' ? FR_WORDS.started : null;

/** The entry's number ("12"), none for an optional one. */
export const entryNumber = (e: Pick<FranchiseEntry, 'position'>): string | null =>
  e.position != null && e.position > 0 ? String(e.position) : null;

/** The entry's picture, as the website draws it (franchise.js: cover || poster):
 *  the household's own cover when the server holds the title, else the
 *  catalogue poster. (Poster first showed the catalogue's picture for a film on
 *  the server — not the website's — and nothing at all when the server could
 *  not fetch it, Mi TV 2026-11-09.) */
export const entryArt = (e: Pick<FranchiseEntry, 'cover' | 'poster'>): string | null => e.cover || e.poster || null;

/** The entry as a card the title page opens: the library's copy when the
 *  server holds it (Detail reads /api/item), else the catalogue title. */
export const entryItem = (e: FranchiseEntry): HeroItem => {
  const art = entryArt(e);
  if (e.onServer) {
    return {id: e.onServer.id, type: e.onServer.type, title: e.title, year: e.year ?? undefined, imdbId: e.imdbId, cover: art, poster: e.poster || null};
  }
  return {id: '', type: e.type, title: e.title, year: e.year ?? undefined, imdbId: e.imdbId, source: 'stream', cover: art, poster: e.poster || null};
};

/** Where focus starts on the franchise page: the first main entry not watched
 *  (where the person is in it), else the first entry. */
export const firstFocusIndex = (entries: Pick<FranchiseEntry, 'state' | 'optional'>[]): number => {
  const i = entries.findIndex(e => !e.optional && e.state !== 'watched');
  return i >= 0 ? i : 0;
};

/** The order chips: only when there is a choice. */
export const showOrderSwitch = (orders: {id: string}[] | null | undefined) => (orders || []).length > 1;

// ------------------------------------------- the title page's `save` param
export type AutoSaveFacts = {
  /** the page was opened with `save: true` */
  save: boolean;
  /** what the page is: a film is the only thing it is ever pressed for */
  type: 'movie' | 'show' | undefined;
  /** the admin's torrents switch has been read, and its answer */
  torrentsKnown: boolean;
  torrentsOff: boolean;
  /** whether the film is on disk has been settled, and the answer */
  libraryKnown: boolean;
  owned: boolean;
  /** the first read of the downloads list landed, and whether one of this film is on its way */
  jobsKnown: boolean;
  onItsWay: boolean;
  /** is there a best source: null not known yet, false none (CAMs only, nothing) */
  best: boolean | null;
  /** ms since the page opened */
  elapsed: number;
};
/** 'press' Save & watch now, 'wait', or 'drop' (leave the page as it is). */
export const autoSaveStep = (f: AutoSaveFacts): 'press' | 'wait' | 'drop' => {
  if (!f.save || f.type !== 'movie') return 'drop';
  if (f.torrentsKnown && f.torrentsOff) return 'drop';
  if (f.libraryKnown && f.owned) return 'drop'; // on the server: nothing to save
  if (f.jobsKnown && f.onItsWay) return 'drop'; // already coming: never asked twice
  if (f.best === false) return 'drop'; // no copy to pick: the page says why, Save & watch focused
  const ready = f.torrentsKnown && f.libraryKnown && f.jobsKnown && f.best === true;
  if (ready) return 'press';
  return f.elapsed >= AUTO_PLAY_GIVE_UP_MS ? 'drop' : 'wait';
};

// ------------------------------------------------------- the end of a film
/** The end card's line: "Thor · 3 of 34". */
export const nextLine = (n: Pick<FranchiseNext, 'position' | 'total'> & {entry: Pick<FranchiseEntry, 'title'>}) =>
  `${n.entry.title} · ${n.position} of ${n.total}`;

/** The server's answer, read: a usable next or null. */
export const readFranchiseNext = (answer: unknown): FranchiseNext | null => {
  const n = answer && typeof answer === 'object' ? (answer as {next?: unknown}).next : null;
  if (!n || typeof n !== 'object') return null;
  const x = n as FranchiseNext;
  if (!x.entry || typeof x.entry !== 'object' || !x.entry.title || typeof x.kicker !== 'string') return null;
  if (!Number.isFinite(Number(x.position)) || !Number.isFinite(Number(x.total))) return null;
  return x;
};

export type FranchiseEndPlan = {
  kicker: string;
  line: string;
  /** play: Play now (the copy on the server); save: Save & watch (its title
   *  page); open / choose: a show — its title page */
  primary: 'play' | 'save' | 'open' | 'choose';
  primaryLabel: string;
  /** seconds to count down from; null = nothing starts by itself */
  countdown: number | null;
};
/** What the end card is (the rules at the top of this file). */
export const planFranchiseEnd = (o: {
  next: FranchiseNext;
  autoplayPref: boolean;
  inParty: boolean;
  guest: boolean;
  /** titles that started by themselves, in a row, up to and including this one */
  autoRun: number;
}): FranchiseEndPlan => {
  const e = o.next.entry;
  const film = e.type !== 'show';
  const base = {kicker: o.next.kicker, line: nextLine(o.next)};
  if (!film) {
    return e.onServer
      ? {...base, primary: 'open', primaryLabel: FR_WORDS.open, countdown: null}
      : {...base, primary: 'choose', primaryLabel: FR_WORDS.choose, countdown: null};
  }
  if (!e.onServer) return {...base, primary: 'save', primaryLabel: FR_WORDS.save, countdown: null};
  const autoplay = o.autoplayPref && !(o.inParty && o.guest);
  // "Still watching?": after three in a row started by themselves, the next waits to be asked for
  const still = !o.inParty && o.autoRun >= STILL_WATCHING_AFTER;
  return {...base, primary: 'play', primaryLabel: FR_WORDS.playNow, countdown: autoplay && !still ? UPNEXT_COUNTDOWN_SEC : null};
};

/** The window the card lives in — Up next's (playerRules.ts upNextState): the
 *  detected credits, else a runtime-scaled window before the end. */
export const endWindow = (duration: number, creditsStart: number | null) =>
  creditsStart != null && creditsStart > 0 && creditsStart < duration - 5 ? duration - creditsStart : upNextWindow(duration);
/** Ask the server this long before the window opens (s), so the card is ready on time. */
export const ASK_AHEAD_S = 60;
/** 'ask' (once: fetch the next), 'show', 'retract' (seeked back out of it by
 *  more than 15 s: the card goes, armed again) or 'hold'. */
export const franchiseEndStep = (o: {content: number; duration: number; creditsStart: number | null; asked: boolean; shown: boolean; paused: boolean}): 'ask' | 'show' | 'retract' | 'hold' => {
  if (!o.duration || !(o.content > 0)) return 'hold';
  const win = endWindow(o.duration, o.creditsStart);
  const remaining = o.duration - o.content;
  if (o.shown) return remaining > win + 15 ? 'retract' : 'hold';
  if (!o.asked) return remaining <= win + ASK_AHEAD_S ? 'ask' : 'hold';
  return remaining <= win && !o.paused ? 'show' : 'hold';
};

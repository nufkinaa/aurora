// Where each nav section goes, in one place, so the nav behaves the same on
// every screen. Also holds the profile lookup the rail's avatar needs.
import {useEffect, useState} from 'react';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {api, Profile} from './api';
import {loadNewSeen, saveNewSeen} from './storage';
import {APP_VERSION} from './update';
import type {IconName} from './components/Icon';
import {canNavigate} from './navLock';
import type {RootStackParamList} from './navigation';

export type NavSection =
  | 'home'
  | 'movies'
  | 'shows'
  | 'list'
  | 'new'
  | 'ai'
  | 'search'
  | 'settings';

// index.html:56-72, in order. AI (`#nav-pick`) is `display: none` there and
// focus.js:33 never collects it, so it is not here either. The gear and the
// profile pill sit after the spacer and the rail pushes them to the bottom.
export const NAV_SECTIONS: {
  key: NavSection;
  label: string;
  icon?: IconName;
  iconSize?: number;
  foot?: boolean;
}[] = [
  {key: 'search', label: 'Search', icon: 'search', iconSize: 18},
  {key: 'home', label: 'Home'},
  {key: 'movies', label: 'Movies'},
  {key: 'shows', label: 'Shows'},
  {key: 'list', label: 'My List'},
  // AI sits where New was (elia, 2026-10-06); the New page is still under
  // Settings → What's new, and its unseen dot now lives on that row.
  {key: 'ai', label: 'AI'},
  {key: 'settings', label: 'Preferences', icon: 'gear', iconSize: 19, foot: true},
];

// The "New" dot: on until this release's page has been opened on this TV.
let newSeen: string | null | undefined; // undefined = not read yet
const newSubs = new Set<(unseen: boolean) => void>();
const newVersion = () => APP_VERSION;
const unseen = () => newSeen !== undefined && newSeen !== newVersion();
export const useNewUnseen = () => {
  const [v, setV] = useState(unseen());
  useEffect(() => {
    newSubs.add(setV);
    if (newSeen === undefined) {
      loadNewSeen().then(s => {
        newSeen = s || null;
        for (const fn of newSubs) fn(unseen());
      });
    }
    return () => {
      newSubs.delete(setV);
    };
  }, []);
  return v;
};
export const markNewSeen = (_version: string) => {
  newSeen = newVersion();
  saveNewSeen(newSeen);
  for (const fn of newSubs) fn(false);
};

type Nav<R extends keyof RootStackParamList> = NativeStackNavigationProp<
  RootStackParamList,
  R
>;

// The screen each section lives on, to tell "I am on it" from "it is lit".
const SCREEN_FOR: Record<NavSection, keyof RootStackParamList> = {
  home: 'Home',
  movies: 'Browse',
  shows: 'Browse',
  list: 'MyList',
  new: 'WhatsNew',
  search: 'Search',
  settings: 'Settings',
  ai: 'Pick',
};
const onSectionScreen = <R extends keyof RootStackParamList>(nav: Nav<R>, section: NavSection) => {
  try {
    const st = nav.getState();
    const r = st.routes[st.index];
    if (!r || r.name !== SCREEN_FOR[section]) return false;
    if (section === 'movies' || section === 'shows') {
      const kind = (r.params as {kind?: string} | undefined)?.kind;
      return kind === (section === 'movies' ? 'movie' : 'show');
    }
    return true;
  } catch {
    return false;
  }
};

export const goSection = <R extends keyof RootStackParamList>(
  nav: Nav<R>,
  _current: NavSection, // the lit item — kept for the callers, no longer the test
  section: NavSection,
) => {
  // Pressing the section you're already on should do nothing rather than stack a
  // second copy of the same screen behind you. "Already on" is decided by the
  // ROUTE, not by the rail's highlight: a film's Detail page lights Movies up
  // as its section (and Downloads lights Preferences), and with `current`
  // alone a press on that lit item did nothing at all — the rail just closed
  // (Mi TV, 2026-10-06). From a title page, Movies must still take you there.
  if (onSectionScreen(nav, section)) return;
  if (!canNavigate(nav as never)) return;
  // THE RAIL SWITCHES SECTIONS, IT DOES NOT DESCEND INTO THEM. Every case below
  // used to `push`, so Movies -> Shows -> My List -> Movies left four screens
  // stacked on top of Home, all of them still mounted, and Back walked backwards
  // through your own browsing history one section at a time. On the site the nav
  // is a flat switch: whatever you pick REPLACES what you were looking at.
  //
  // popToTop first, then push, so the stack is never deeper than Home + section
  // and Back from any section lands on Home.
  if (section !== 'home') nav.popToTop();
  switch (section) {
    // Home is the stack root, so popping to it IS navigating to it.
    case 'home':
      nav.popToTop();
      return;
    case 'movies':
      nav.push('Browse', {kind: 'movie'});
      return;
    case 'shows':
      nav.push('Browse', {kind: 'show'});
      return;
    case 'list':
      nav.push('MyList');
      return;
    case 'search':
      nav.push('Search');
      return;
    case 'new':
      nav.push('WhatsNew');
      return;
    case 'ai':
      nav.push('Pick');
      return;
    case 'settings':
      nav.push('Settings');
      return;
  }
};

// The active profile's record, for the header avatar. Cached at module scope so
// moving between screens doesn't refetch it on every mount — the header is on
// every screen now, and this would otherwise be a request per navigation.
const cache = new Map<string, Profile | null>();
const cacheAt = new Map<string, number>();
const loading = new Map<string, Promise<Profile | null>>();

// The same record for code that is not a component — the player's remembered
// languages, the Follow button. Answers from the cache while it is younger
// than `maxAgeMs`, else asks the server (one request however many callers),
// and falls back to the stale copy when the server does not answer: something
// the site changed an hour ago is worth a request, but never a failure.
export const loadMe = (profileId: string, maxAgeMs = Infinity): Promise<Profile | null> => {
  const at = cacheAt.get(profileId) || 0;
  if (cache.has(profileId) && Date.now() - at < maxAgeMs) return Promise.resolve(cache.get(profileId) ?? null);
  const busy = loading.get(profileId);
  if (busy) return busy;
  const p = api
    .profiles()
    .then(list => {
      const found = list.find(x => x.id === profileId) || null;
      cache.set(profileId, found);
      cacheAt.set(profileId, Date.now());
      return found;
    })
    .catch(() => cache.get(profileId) ?? null)
    .finally(() => loading.delete(profileId));
  loading.set(profileId, p);
  return p;
};
/** What is known right now, without asking. */
export const peekMe = (profileId: string): Profile | null => cache.get(profileId) ?? null;
/** This device changed the profile (a follow, a remembered language): the
 *  cached record follows at once, so the next reader agrees with the server. */
export const patchMe = (profileId: string, patch: Partial<Profile>) => {
  const cur = cache.get(profileId);
  if (cur) cache.set(profileId, {...cur, ...patch});
};

// ---- what the viewer last picked in the player, on the PROFILE ----
// The site's profilePick / rememberPick (public/js/screens/player.js): the
// dub's language and the subtitle choice ride the profile to every device.
export type PickKey = 'audioLang' | 'subPick';
export const profilePick = (profileId: string, key: PickKey): string | null => {
  const v = cache.get(profileId)?.prefs?.[key];
  return typeof v === 'string' && v ? v : null;
};
// What the server will store (profiles.js update): a short plain string.
const PICK_OK = /^[\w .()\-֐-׿]{1,40}$/;
export const rememberPick = (profileId: string, key: PickKey, value: string | null) => {
  // A value the server would refuse is sent as "nothing remembered" — else the
  // refusal is silent and the profile keeps saying whatever it said before.
  const v = value && PICK_OK.test(value) ? value : null;
  const cur = cache.get(profileId);
  if (cur) {
    const prefs = {...(cur.prefs || {})};
    if (v == null) delete prefs[key];
    else prefs[key] = v;
    cache.set(profileId, {...cur, prefs});
  }
  api
    .updateProfile(profileId, {prefs: {[key]: v}})
    .then(() => console.log('[prefs] profile remembers', key, '=', v))
    .catch(() => {});
};

export const useMe = (profileId: string): Profile | null => {
  const [me, setMe] = useState<Profile | null>(cache.get(profileId) ?? null);
  useEffect(() => {
    if (cache.has(profileId)) {
      setMe(cache.get(profileId) ?? null);
      return;
    }
    let live = true;
    // A missing avatar is not worth surfacing; the header falls back to a
    // popcorn and the name "Profile". (loadMe never rejects.)
    loadMe(profileId).then(found => {
      if (live && found) setMe(found);
    });
    return () => {
      live = false;
    };
  }, [profileId]);
  return me;
};

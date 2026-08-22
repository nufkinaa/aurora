// Where each nav section goes, in one place, so the nav behaves the same on
// every screen. Also holds the profile lookup the rail's avatar needs.
import {useEffect, useState} from 'react';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {api, Profile} from './api';
import type {IconName} from './components/Icon';
import {canNavigate} from './navLock';
import type {RootStackParamList} from './navigation';

export type NavSection =
  | 'home'
  | 'movies'
  | 'shows'
  | 'list'
  | 'search'
  | 'games'
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
  {key: 'games', label: 'Games'},
  {key: 'settings', label: 'Preferences', icon: 'gear', iconSize: 19, foot: true},
];

type Nav<R extends keyof RootStackParamList> = NativeStackNavigationProp<
  RootStackParamList,
  R
>;

export const goSection = <R extends keyof RootStackParamList>(
  nav: Nav<R>,
  current: NavSection,
  section: NavSection,
) => {
  // Pressing the section you're already on should do nothing rather than stack a
  // second copy of the same screen behind you.
  if (section === current) return;
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
    case 'games':
      nav.push('Games');
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

export const useMe = (profileId: string): Profile | null => {
  const [me, setMe] = useState<Profile | null>(cache.get(profileId) ?? null);
  useEffect(() => {
    if (cache.has(profileId)) {
      setMe(cache.get(profileId) ?? null);
      return;
    }
    let live = true;
    api
      .profiles()
      .then(list => {
        const found = list.find(p => p.id === profileId) || null;
        cache.set(profileId, found);
        if (live) setMe(found);
      })
      // A missing avatar is not worth surfacing; the header falls back to a
      // popcorn and the name "Profile".
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profileId]);
  return me;
};

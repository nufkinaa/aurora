// "More" — the tab bar's last word: a sheet with every place that has no tab
// (moreItems.ts has the lines; docs/android-phone/NAV.md the agreed list). A
// phone-only store, like profileMenu.ts (the shared overlay.ts is the TV's too).
import {useSyncExternalStore} from 'react';
import {Linking} from 'react-native';
import {StackActions} from '@react-navigation/native';
import {navRef, pushScreen} from '../rootNav';
import {getBaseUrl} from '../api';
import {openChildMode, openJoinParty, openReport} from '../overlay';
import {pushPhone} from './nav';
import {setTab, type Tab} from './tabs';
import {openProfileMenu} from './profileMenu';
import type {MoreKey} from './moreItems';

let open = false;
const subs = new Set<() => void>();
const set = (v: boolean) => {
  if (v === open) return;
  open = v;
  subs.forEach(f => f());
};
export const openMore = () => set(true);
export const closeMore = () => set(false);
export const useMoreShown = () =>
  useSyncExternalStore(
    f => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => open,
  );

// One of the tabs (Search … My List): back to the tab screen, on that tab.
const toTab = (t: Tab) => {
  if (navRef.isReady() && navRef.canGoBack()) navRef.dispatch(StackActions.popToTop());
  setTab(t);
};

/** Where a line goes (after the sheet has gone). */
export function runMore(key: MoreKey) {
  switch (key) {
    case 'search':
      return toTab('search');
    case 'home':
      return toTab('home');
    case 'movies':
      return toTab('movies');
    case 'shows':
      return toTab('shows');
    case 'list':
      return toTab('list');
    case 'calendar':
      return pushPhone('Calendar');
    case 'profile':
      return openProfileMenu();
    case 'new':
      return pushPhone('WhatsNew');
    case 'saved':
      return pushScreen('Downloads', undefined);
    case 'downloads':
      return pushPhone('Downloads', {section: 'server'});
    case 'remote':
      return pushPhone('Remote');
    case 'household':
      return pushPhone('Household');
    case 'wrapped':
      return pushPhone('Wrapped');
    case 'taste':
      return pushPhone('Taste');
    case 'pick':
      return pushPhone('Pick');
    case 'settings':
      return pushScreen('Settings', undefined);
    case 'apps':
      return Linking.openURL(`${getBaseUrl() || 'https://nufurora.com'}/install`).catch(() => {});
    case 'pair':
      return pushPhone('PairTv', {code: null});
    case 'children':
      return openChildMode();
    case 'party':
      return openJoinParty();
    case 'report':
      return openReport();
  }
}

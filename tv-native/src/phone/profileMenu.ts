// The top bar's profile button: who you are, and where to go from there — the
// website's profile menu (.nav-menu), a glass panel under the avatar (drawn by
// ui/ProfileMenu.tsx, a phone-only store: the shared overlay.ts is the TV's too).
import {useSyncExternalStore} from 'react';
import {pushScreen} from '../rootNav';
import {pushPhone} from './nav';
import {Linking} from 'react-native';
import {getAuthMode, getBaseUrl} from '../api';
import {openChildMode, openJoinParty, openReport} from '../overlay';
import {WORDS} from '../groupPick';

let switchFn: (() => void) | null = null;
let nameOf: () => string = () => '';
let kidsOf: () => boolean = () => false;
/** PhoneMain hands these in once (AppContext lives below the overlays). `kids`: Children mode is on. */
export const wireProfileMenu = (o: {switchProfile: () => void; name: () => string; kids?: () => boolean}) => {
  switchFn = o.switchProfile;
  nameOf = o.name;
  kidsOf = o.kids || (() => false);
};

export type MenuItem = {label: string; uiId: string; onPress: () => void};

/** The menu's lines, in the site's order and words (main.js profile menu); "Your TVs" is the
 *  phone's own, "Get the apps" is the website's /install page (in the browser). */
//  (Children mode, 2026-11-11: its line under the first; while it is on, no
//  Switch profile / Sign out and no downloads — leaving it is the way back.)
export const menuItems = (closed: boolean, kids = false): MenuItem[] => [
  ...(kids ? [] : [{label: closed ? 'Sign out' : 'Switch profile', uiId: 'phone.menu.switch', onPress: () => switchFn?.()}]),
  {label: kids ? 'Leave Children mode' : 'Children mode', uiId: 'child.open', onPress: () => openChildMode()},
  {label: 'Settings', uiId: 'phone.menu.settings', onPress: () => pushScreen('Settings', undefined)},
  ...(kids ? [] : [{label: 'My downloads', uiId: 'phone.menu.downloads', onPress: () => pushScreen('Downloads', undefined)}]),
  {label: 'Your TVs', uiId: 'phone.menu.remote', onPress: () => pushPhone('Remote')},
  {label: 'Calendar', uiId: 'phone.menu.calendar', onPress: () => pushScreen('Calendar', undefined)},
  {label: "What's new", uiId: 'phone.menu.whatsnew', onPress: () => pushPhone('WhatsNew')},
  {label: 'Get the apps', uiId: 'phone.menu.apps', onPress: () => Linking.openURL(`${getBaseUrl() || 'https://nufurora.com'}/install`).catch(() => {})},
  {label: 'Report a problem', uiId: 'phone.menu.report', onPress: () => openReport()},
  {label: 'Join a watch party', uiId: 'phone.menu.party', onPress: () => openJoinParty()},
  {label: WORDS.entry, uiId: 'group.open', onPress: () => pushPhone('GroupPick')},
];

let open = false;
const subs = new Set<() => void>();
const set = (v: boolean) => {
  if (v === open) return;
  open = v;
  subs.forEach(f => f());
};
export const openProfileMenu = () => set(true);
export const closeProfileMenu = () => set(false);
export const useProfileMenu = () => {
  const shown = useSyncExternalStore(
    f => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => open,
  );
  return {shown, name: nameOf() || 'Your profile', items: menuItems(getAuthMode() === 'closed', kidsOf())};
};

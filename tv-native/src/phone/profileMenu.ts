// The top bar's profile button: who you are, and where to go from there — the
// website's profile menu (.nav-menu), a glass panel under the avatar (drawn by
// ui/ProfileMenu.tsx, a phone-only store: the shared overlay.ts is the TV's too).
import {useSyncExternalStore} from 'react';
import {pushScreen} from '../rootNav';
import {pushPhone} from './nav';
import {Linking} from 'react-native';
import {getAuthMode, getBaseUrl} from '../api';
import {openJoinParty, openReport} from '../overlay';

let switchFn: (() => void) | null = null;
let nameOf: () => string = () => '';
/** PhoneMain hands these in once (AppContext lives below the overlays). */
export const wireProfileMenu = (o: {switchProfile: () => void; name: () => string}) => {
  switchFn = o.switchProfile;
  nameOf = o.name;
};

export type MenuItem = {label: string; uiId: string; onPress: () => void};

/** The menu's lines, in the site's order and words (main.js profile menu); "Your TVs" is the
 *  phone's own, "Get the apps" is the website's /install page (in the browser). */
export const menuItems = (closed: boolean): MenuItem[] => [
  {label: closed ? 'Sign out' : 'Switch profile', uiId: 'phone.menu.switch', onPress: () => switchFn?.()},
  {label: 'Settings', uiId: 'phone.menu.settings', onPress: () => pushScreen('Settings', undefined)},
  {label: 'My downloads', uiId: 'phone.menu.downloads', onPress: () => pushScreen('Downloads', undefined)},
  {label: 'Your TVs', uiId: 'phone.menu.remote', onPress: () => pushPhone('Remote')},
  {label: "What's new", uiId: 'phone.menu.whatsnew', onPress: () => pushPhone('WhatsNew')},
  {label: 'Get the apps', uiId: 'phone.menu.apps', onPress: () => Linking.openURL(`${getBaseUrl() || 'https://nufurora.com'}/install`).catch(() => {})},
  {label: 'Report a problem', uiId: 'phone.menu.report', onPress: () => openReport()},
  {label: 'Join a watch party', uiId: 'phone.menu.party', onPress: () => openJoinParty()},
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
  return {shown, name: nameOf() || 'Your profile', items: menuItems(getAuthMode() === 'closed')};
};

// The top bar's profile button: who you are, and where to go from there.
import {openActions} from '../overlay';
import {pushScreen} from '../rootNav';
import {pushPhone} from './nav';
import {getAuthMode} from '../api';

let switchFn: (() => void) | null = null;
let nameOf: () => string = () => '';
/** PhoneMain hands these in once (AppContext lives below the overlays). */
export const wireProfileMenu = (o: {switchProfile: () => void; name: () => string}) => {
  switchFn = o.switchProfile;
  nameOf = o.name;
};

export const openProfileMenu = () => {
  const closed = getAuthMode() === 'closed';
  openActions({
    title: nameOf() || 'Your profile',
    items: [
      {label: 'Settings', onPress: () => pushScreen('Settings', undefined)},
      {label: 'Downloads', onPress: () => pushScreen('Downloads', undefined)},
      {label: 'Your TVs', onPress: () => pushPhone('Remote')},
      {label: closed ? 'Sign out' : 'Switch profile', onPress: () => switchFn?.()},
    ],
  });
};

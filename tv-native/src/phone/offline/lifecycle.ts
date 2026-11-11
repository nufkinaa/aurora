// Saving to this device, kept moving while a profile is in (the phone's Main mounts it, a
// profile switch unmounts it) — the website's main.js "carry on" moments: when Aurora opens,
// comes back to the front, and when the socket (re)connects —
//   · saves that stopped without the person asking carry on by themselves (store.ts carryOn)
//   · this device's wishes the server made ready are saved by themselves (wishes.ts)
//   · "Keep the next episode ready" looks for finished episodes (smartNext.ts)
// plus the socket's word on a wish (`offline_wish` / `offline_wish_removed`).
import {AppState} from 'react-native';
import {getActiveProfile} from '../../api';
import {peekMe} from '../../navSection';
import {onMessage} from '../../realtime';
import {carryOn, onOfflinePrefs, setLikedAudio} from './store';
import {checkSmartNext} from './smartNext';
import {armWishes, onWishMessage, syncWishes} from './wishes';

export function startOfflineLife(profileId: string): () => void {
  // the sound a copy is made with by default: the dub the person last picked (it follows the profile)
  setLikedAudio(() => {
    const v = (peekMe(getActiveProfile() || '')?.prefs || {}) as {audioLang?: string};
    return typeof v.audioLang === 'string' ? v.audioLang : null;
  });
  const disarm = armWishes(profileId);
  const all = () => {
    if (getActiveProfile() !== profileId) return;
    carryOn();
    syncWishes().catch(() => {});
    checkSmartNext().catch(() => 0);
  };
  // (a moment after the first screen: the first screen's own requests go first)
  const first = setTimeout(all, 1500);
  const fg = AppState.addEventListener('change', st => {
    if (st === 'active') all();
  });
  const offs = [
    onMessage('welcome', () => all()),
    onMessage('offline_wish', m => onWishMessage(m as never)),
    onMessage('offline_wish_removed', m => onWishMessage(m as never)),
    // turned on: look now (only episodes finished from now on count)
    onOfflinePrefs(p => {
      if (p.keepNext) checkSmartNext().catch(() => 0);
    }),
  ];
  return () => {
    clearTimeout(first);
    fg.remove();
    for (const off of offs) off();
    disarm();
  };
}

/** Leaving the player of a saved copy: an episode may just have been finished. */
export const afterOfflinePlay = () => setTimeout(() => checkSmartNext().catch(() => 0), 1500);

// The remote's own search / voice key, anywhere in the app: Search opens,
// listening (or an open Search starts listening). Not on the player — a key
// pressed by accident there must not stop the film; Back first, then the key.
// MainActivity passes the key on only while this is wired (VoiceModule
// captureKeys); a TV that keeps the key for its own Assistant never sends it,
// and the on-screen mic on Search is the way in there.
//
// Also the TV's own search (SearchProvider.kt): a search it sends to Aurora
// arrives as `aurora://search?q=<words>` — Search opens on those words.
import {Linking} from 'react-native';
import {captureVoiceKey, onVoiceKey, searchLinkQuery, searchVoiceKey} from './voice';
import {currentRouteName, navRef, pushScreen} from './rootNav';

export const wireVoiceKey = () => {
  const offKey = captureVoiceKey(() => {
    onVoiceKey(currentRouteName(), searchVoiceKey(), () => pushScreen('Search', {voice: true}));
  });
  const open = (url: string | null) => {
    const q = searchLinkQuery(url);
    if (q == null) return;
    // the navigator may not be up yet on a cold start
    let tries = 0;
    const go = () => {
      if (navRef.isReady() && currentRouteName()) return pushScreen('Search', {q});
      if (++tries < 40) setTimeout(go, 250);
    };
    go();
  };
  Linking.getInitialURL().then(open).catch(() => {});
  const sub = Linking.addEventListener('url', e => open(e.url));
  return () => {
    offKey();
    sub.remove();
  };
};

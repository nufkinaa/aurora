// Links into the phone app (what they open: linkParse.ts): the one it was
// started with, and any that arrive while it is open — a notification, a
// nufurora.com address from a chat, the share sheet's link from another phone.
import {useEffect} from 'react';
import {Linking} from 'react-native';
import {StackActions} from '@react-navigation/native';
import {navRef} from '../rootNav';
import {resolvePartyRoute} from '../party';
import {showToast} from '../toast';
import {parsePhoneLink, PhoneLink} from './linkParse';
import {setTab} from './tabs';

let openedInitial: string | null = null;

const push = (name: string, params?: object) => {
  if (!navRef.isReady()) return;
  navRef.dispatch(StackActions.push(name, params));
};

export async function openLink(l: PhoneLink) {
  if (!navRef.isReady()) return;
  switch (l.kind) {
    case 'item': {
      const it = l.item;
      const libraryFilm = it.type === 'movie' && it.source !== 'stream' && !String(it.id).startsWith('torrent|');
      const libraryEpisode = !it.type && (it as {season?: number}).season != null;
      if (l.action === 'play' && (libraryFilm || libraryEpisode)) push('Player', {id: it.id, title: it.title});
      else push('Detail', {item: it});
      return;
    }
    case 'party': {
      const r = await resolvePartyRoute(l.code);
      if (!r) return showToast('That watch party has ended', '👥');
      push('Player', {...r, party: l.code});
      return;
    }
    case 'search':
      push('Search', {q: l.q});
      return;
    case 'screen':
      push(l.name);
      return;
    case 'tab':
      if (navRef.canGoBack()) navRef.dispatch(StackActions.popToTop());
      setTab(l.tab);
      return;
  }
}

/** PhoneNavigator mounts this once. */
export function useLinks() {
  useEffect(() => {
    let on = true;
    Linking.getInitialURL()
      .then(u => {
        if (!u || u === openedInitial) return;
        openedInitial = u;
        const l = parsePhoneLink(u);
        if (l) setTimeout(() => on && openLink(l), 700);
      })
      .catch(() => {});
    const sub = Linking.addEventListener('url', e => {
      const l = parsePhoneLink(e.url);
      if (l) openLink(l);
    });
    return () => {
      on = false;
      sub.remove();
    };
  }, []);
}

// The QA receiver's `nav` command (tools/tv-bench/tv-pixel-diff/PROTOCOL.md §3): steer
// the app to a known route, popping to the root first, and answer once the navigation
// was dispatched (`route=<name>`) — or `err …`. Queued until the navigator is ready (a
// fresh launch), up to 10 s. Only a QA variant (-PqaReceiver=true) listens at all: in
// any other build `useQaNav` does nothing.
import {useEffect} from 'react';
import {DeviceEventEmitter} from 'react-native';
import {StackActions} from '@react-navigation/native';
import type {HeroItem} from './api';
import {navRef} from './rootNav';
import {QA_BUILD, navDone} from './qa';

const QA_NAV_WAIT_MS = 10000;

/** PURE-ish: `home` | `browse:movie|show` | `detail:<id>` | `detail:tt…[:show]` | `mylist` |
 *  `search` | `settings` → the route dispatched, or `err …`. */
export const qaNavigate = (target: string): string => {
  const [kind, rest, extra] = target.split(':');
  const dispatch = (name: string, params?: object) => {
    if ((navRef.getState()?.routes.length || 0) > 1) navRef.dispatch(StackActions.popToTop());
    if (name === 'Home') return;
    navRef.dispatch(StackActions.push(name, params));
  };
  switch (kind) {
    case 'home':
      dispatch('Home');
      return 'Home';
    case 'browse':
      if (rest !== 'movie' && rest !== 'show') return 'err bad kind';
      dispatch('Browse', {kind: rest});
      return `Browse/${rest}`;
    case 'detail':
      if (!rest) return 'err no id';
      // `detail:tt1234567[:show]` opens a CATALOGUE title (a stream card carries only its imdbId)
      if (/^tt\d+$/.test(rest)) {
        dispatch('Detail', {item: {imdbId: rest, title: rest, type: extra === 'show' ? 'show' : 'movie', source: 'stream'} as unknown as HeroItem});
        return 'Detail';
      }
      // a stub item: Detail fetches /api/item for the rest (Overlays.tsx does the same)
      dispatch('Detail', {item: {id: rest, title: rest, type: 'movie'} as HeroItem});
      return 'Detail';
    case 'mylist':
      dispatch('MyList');
      return 'MyList';
    case 'search':
    case 'ai':
      dispatch('Search');
      return 'Search';
    case 'settings':
      dispatch('Settings');
      return 'Settings';
    default:
      return 'err unsupported';
  }
};

function useQaNavReal() {
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('qaNav', (e: {target?: string; rid?: string}) => {
      const rid = String(e?.rid || '');
      const target = String(e?.target || '');
      const started = Date.now();
      const attempt = () => {
        if (!navRef.isReady()) {
          if (Date.now() - started > QA_NAV_WAIT_MS) navDone(rid, 'err not ready');
          else setTimeout(attempt, 100);
          return;
        }
        let route: string;
        try {
          route = qaNavigate(target);
        } catch (err) {
          route = `err ${String((err as Error)?.message || err)}`;
        }
        navDone(rid, route);
      };
      attempt();
    });
    return () => sub.remove();
  }, []);
}

/** Mounted once, in AppNavigator. Chosen at load: nothing at all outside a QA variant. */
export const useQaNav: () => void = QA_BUILD ? useQaNavReal : () => {};

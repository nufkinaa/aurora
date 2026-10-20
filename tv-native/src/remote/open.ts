// "Play on TV" and the Home key, carried out on the app's navigator (rootNav.ts
// navRef — this code lives outside every screen). playItem.ts decides the
// params; this only dispatches them, and brings Aurora to the front first
// when the TV is showing something else.
import {AppState} from 'react-native';
import {StackActions} from '@react-navigation/native';
import {navRef} from '../rootNav';
import {closeOverlay, overlayOpen} from '../overlay';
import {MSG, type Outcome, type PlayItemArgs} from './protocol';
import {playerParams} from './playItem';
import {nativeRemote} from './native';

// How long a start from the background may take to bring the app forward
// before the phone is told it did not (inside the handler's ANSWER_MS).
const FRONT_WAIT_MS = 3000;

// The wait is measured by the clock, not only by the timer: React Native
// pauses JS timers while the app is in the background, so a timer started
// there fires only once Aurora is opened again — minutes later, perhaps.
// Mi TV 2026-10-20: the phone heard "didn't answer" (the 3 s timer never ran)
// and the TV then started that film by itself the next time someone opened
// Aurora. Coming to the front after the window counts as NOT coming forward.
const waitActive = (ms: number) =>
  new Promise<boolean>(resolve => {
    if (AppState.currentState === 'active') return resolve(true);
    const started = Date.now();
    let done = false;
    const end = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      sub.remove();
      resolve(v);
    };
    const sub = AppState.addEventListener('change', s => s === 'active' && end(Date.now() - started <= ms));
    const t = setTimeout(() => end(AppState.currentState === 'active' && Date.now() - started <= ms), ms);
  });

const dispatchPlayer = (a: PlayItemArgs) => {
  if (!navRef.isReady()) return false;
  if (overlayOpen()) closeOverlay();
  const params = playerParams(a);
  // a player on top is replaced (one film at a time); anywhere else the player goes on top
  const top = navRef.getCurrentRoute()?.name;
  navRef.dispatch(top === 'Player' ? StackActions.replace('Player', params) : StackActions.push('Player', params));
  return true;
};

export const playItemOnTv = async (a: PlayItemArgs): Promise<Outcome> => {
  if (!navRef.isReady()) return {ok: false, error: 'not-ready', message: MSG.notReady};
  if (AppState.currentState !== 'active') {
    // Android 10+ lets an app in the background start an activity only in
    // narrow cases (the "display over other apps" permission this app may
    // have been given for its updater is one): the start is asked for, and
    // the answer is whether Aurora really came to the front.
    // (bringToFront answers false at once when Android will refuse the start,
    // so the phone hears "open it there" now, not "didn't answer".)
    const asked = await nativeRemote.bringToFront();
    const front = asked && (await waitActive(FRONT_WAIT_MS));
    if (!front) return {ok: false, error: 'background', message: MSG.background};
    dispatchPlayer(a);
    return {ok: true, message: MSG.openingApp};
  }
  return dispatchPlayer(a) ? {ok: true, message: MSG.opening} : {ok: false, error: 'not-ready', message: MSG.notReady};
};

/** The phone's Home key: back to the app's Home, whatever is on top. */
export const goHomeOnTv = () => {
  if (!navRef.isReady()) return false;
  if (overlayOpen()) closeOverlay();
  if (navRef.canGoBack()) navRef.dispatch(StackActions.popToTop());
  return true;
};

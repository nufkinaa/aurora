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
// before the phone is told it did not (both inside the handler's ANSWER_MS).
// First the screensaver is woken (a dream over Aurora: waking it is all it
// takes), then — still not in front — the start of the activity.
const WAKE_WAIT_MS = 1200;
const FRONT_WAIT_MS = 2800;

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

/** Aurora in front, from wherever the TV is: the screensaver woken (the
 *  screen kept on a moment, which ends a dream — Android's screensaver), and
 *  if that was not enough, the activity started. 'already' / 'woke' /
 *  'started' / false (Android would not let it come forward). */
export const bringAuroraForward = async (): Promise<'already' | 'woke' | 'started' | false> => {
  if (AppState.currentState === 'active') {
    nativeRemote.wake(); // (a dream can sit over an app that still reads as active on some boxes)
    return 'already';
  }
  if ((await nativeRemote.wake()) && (await waitActive(WAKE_WAIT_MS))) return 'woke';
  // Android 10+ lets an app in the background start an activity only in
  // narrow cases (the "display over other apps" permission this app may
  // have been given for its updater is one): the start is asked for, and
  // the answer is whether Aurora really came to the front.
  // (bringToFront answers false at once when Android will refuse the start,
  // so the phone hears "open it there" now, not "didn't answer".)
  const asked = await nativeRemote.bringToFront();
  return asked && (await waitActive(FRONT_WAIT_MS)) ? 'started' : false;
};

export const playItemOnTv = async (a: PlayItemArgs): Promise<Outcome> => {
  if (!navRef.isReady()) return {ok: false, error: 'not-ready', message: MSG.notReady};
  const front = await bringAuroraForward();
  if (!front) return {ok: false, error: 'background', message: MSG.background};
  if (front !== 'already') {
    dispatchPlayer(a);
    return {ok: true, status: 'playing', message: MSG.openingApp};
  }
  return dispatchPlayer(a) ? {ok: true, status: 'playing', message: MSG.opening} : {ok: false, error: 'not-ready', message: MSG.notReady};
};

/** The phone's Home key: back to the app's Home, whatever is on top. */
export const goHomeOnTv = () => {
  if (!navRef.isReady()) return false;
  if (overlayOpen()) closeOverlay();
  if (navRef.canGoBack()) navRef.dispatch(StackActions.popToTop());
  return true;
};

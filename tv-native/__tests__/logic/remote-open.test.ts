// "Play on TV" while Aurora is in the background on the TV (src/remote/open.ts).
// Mi TV 2026-10-20: Android 14 dropped the start (BAL_BLOCK), React Native kept
// the 3 s timer paused while the app was in the background, so the phone heard
// "didn't answer" and the TV then played that film by itself the next time
// someone opened Aurora. Now: a start Android will refuse answers "open it
// there" at once, and coming to the front after the wait is not a yes.
const mockDispatch = jest.fn();
jest.mock('../../src/rootNav', () => ({
  navRef: {isReady: () => true, getCurrentRoute: () => ({name: 'Home'}), dispatch: (a: unknown) => mockDispatch(a), canGoBack: () => false},
}));
jest.mock('@react-navigation/native', () => ({
  StackActions: {push: (n: string, p: unknown) => ({type: 'push', n, p}), replace: (n: string, p: unknown) => ({type: 'replace', n, p}), popToTop: () => ({type: 'popToTop'})},
}));
jest.mock('../../src/remote/playItem', () => ({playerParams: (a: unknown) => a}));
jest.mock('../../src/overlay', () => ({overlayOpen: () => false, closeOverlay: () => {}}));

import {AppState, NativeModules} from 'react-native';
import {playItemOnTv} from '../../src/remote/open';
import {MSG} from '../../src/remote/protocol';

type Listener = (s: string) => void;
const listeners = new Set<Listener>();
const appState = AppState as unknown as {currentState: string; addEventListener: (t: string, fn: Listener) => {remove: () => void}};
const realAdd = appState.addEventListener;
const goActive = () => {
  appState.currentState = 'active';
  for (const fn of [...listeners]) fn('active');
};

let front: boolean;
beforeEach(() => {
  mockDispatch.mockClear();
  listeners.clear();
  appState.currentState = 'background';
  appState.addEventListener = (_t, fn) => {
    listeners.add(fn);
    return {remove: () => listeners.delete(fn)};
  };
  front = true;
  (NativeModules as Record<string, unknown>).AuroraRemote = {pressKey: async () => true, bringToFront: async () => front};
});
afterEach(() => {
  appState.addEventListener = realAdd;
  appState.currentState = 'active';
  jest.useRealTimers();
});

const ARGS = {itemId: 'film1', title: 'Long Night'} as unknown as Parameters<typeof playItemOnTv>[0];
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('a start Android will refuse: "open it there" at once, and nothing plays later', async () => {
  front = false;
  const out = await playItemOnTv(ARGS);
  expect(out).toMatchObject({ok: false, error: 'background', message: MSG.background});
  goActive();
  await flush();
  expect(mockDispatch).not.toHaveBeenCalled();
});

test('Aurora comes to the front within the wait: the film opens', async () => {
  const p = playItemOnTv(ARGS);
  await flush();
  goActive();
  expect(await p).toMatchObject({ok: true, message: MSG.openingApp});
  expect(mockDispatch).toHaveBeenCalledTimes(1);
});

test('the timer was paused in the background and Aurora is opened much later: not a yes, nothing plays', async () => {
  jest.useFakeTimers({doNotFake: ['setTimeout', 'clearTimeout']}); // the clock moves, the timer does not
  jest.setSystemTime(new Date('2026-10-20T06:37:17Z'));
  const p = playItemOnTv(ARGS);
  await flush();
  jest.setSystemTime(new Date('2026-10-20T06:37:44Z')); // 27 s later someone opens Aurora
  goActive();
  expect(await p).toMatchObject({ok: false, error: 'background'});
  expect(mockDispatch).not.toHaveBeenCalled();
});

// "Play on TV" — the TV's side of the handoff round:
//   - a command that reached the TV too late is answered "expired" and NOT
//     carried out (handler.ts expired / answer), by the server's clock as the
//     TV learned it (clock.ts);
//   - the answer carries how it went (status "playing" / "needs-pin" / "needs-password");
//   - a TV on its profile wall (handoff.ts playFromWall): the title waits for the
//     sender's profile, the wall opens it as its own tile would, never past the
//     door — and whoever else comes in does not get the title;
//   - the screensaver is woken first (open.ts bringAuroraForward).
jest.mock('../../src/realtime', () => ({onMessage: () => () => {}}));
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
import {answer, expired, EXPIRY_SLACK_MS, type HandlerCtx} from '../../src/remote/handler';
import {MSG, askToPlay, type Ack, type CommandMsg, type PlayItemArgs} from '../../src/remote/protocol';
import {noteServerNow, serverNow, _resetClock} from '../../src/remote/clock';
import {clearPendingPlay, playFromWall, takePendingPlay, titleOf, wallOutcome, PENDING_MS, _pending, type WallDoor} from '../../src/remote/handoff';
import {bringAuroraForward, playItemOnTv} from '../../src/remote/open';

const ITEM = {id: 'lib-arrival', title: 'Arrival', showTitle: null, epTitle: null, season: null, episode: null, type: 'movie' as const, imdbId: null, poster: null, duration: 6960};
const ARGS: PlayItemArgs = {item: ITEM, position: 1834.5, restart: false, subLang: 'he', audioLang: null};

const ctx = (o: Partial<HandlerCtx> = {}): HandlerCtx & {played: PlayItemArgs[]} => {
  const played: PlayItemArgs[] = [];
  return {
    played,
    player: () => null,
    appState: () => 'active',
    press: null,
    home: () => true,
    volume: null,
    playItem: async a => {
      played.push(a);
      return {ok: true, status: 'playing', message: MSG.opening};
    },
    rename: () => {},
    toast: () => {},
    seen: new Set(),
    ...o,
  };
};
const msg = (o: Partial<CommandMsg> = {}): CommandMsg => ({type: 'remote_command', ref: 'r1', cmd: 'play_item', args: ARGS as unknown as Record<string, unknown>, ...o});

// ---------------------------------------------------------------- expiry
describe('a command that came too late', () => {
  test('expired(): only when it says when it was sent, and the server clock is known', () => {
    expect(expired({}, 10_000)).toBe(false);
    expect(expired({at: 1000, ttl: 6000}, null)).toBe(false);
    expect(expired({at: 1000, ttl: 6000}, 1000 + 6000 + EXPIRY_SLACK_MS)).toBe(false);
    expect(expired({at: 1000, ttl: 6000}, 1000 + 6000 + EXPIRY_SLACK_MS + 1)).toBe(true);
    expect(expired({at: 1000, ttl: 0}, 1e12)).toBe(false);
  });

  test('is answered "expired" and never carried out; one in time plays and says so', async () => {
    const sent: Ack[] = [];
    const c = ctx({serverNow: () => 100_000});
    const late = await answer(msg({at: 100_000 - 60_000, ttl: 6000}), c, a => sent.push(a));
    expect(late).toMatchObject({ok: false, error: 'expired', message: MSG.expired});
    expect(c.played).toHaveLength(0);
    const fresh = await answer(msg({ref: 'r2', at: 100_000 - 500, ttl: 6000}), c, a => sent.push(a));
    expect(fresh).toMatchObject({ok: true, status: 'playing'});
    expect(c.played).toHaveLength(1);
    expect(sent.map(a => a.ref)).toEqual(['r1', 'r2']);
  });

  test('the server clock: learned as an offset from device_ok, so a TV whose own clock is wrong reads it right', () => {
    _resetClock();
    expect(serverNow(5000)).toBeNull();
    noteServerNow(1_000_000, 400_000); // the TV's clock is 600 s behind
    expect(serverNow(410_000)).toBe(1_010_000);
    noteServerNow('nope', 0);
    expect(serverNow(410_000)).toBe(1_010_000);
  });

  test('a refusal carries no status', async () => {
    const out = await answer(msg(), ctx({playItem: async () => ({ok: false, error: 'background', message: MSG.background, status: 'playing'})}), () => {});
    expect(out.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the wall
describe('Play on TV to a TV on its profile wall', () => {
  beforeEach(() => clearPendingPlay());
  const deps = (door: WallDoor, forward = true) => {
    const asks: {profileId: string; title: string; who: string}[] = [];
    return {
      asks,
      open: async (profileId: string, a: {title: string; who: string}) => {
        asks.push({profileId, ...a});
        return door;
      },
      forward: async () => forward,
      who: () => "Elia's Android phone",
      now: () => 1_000_000,
    };
  };
  const FROM = {label: 'Android phone', profileName: 'Elia', profileId: 'pa'};

  test('a profile with no door: straight in, "playing" — and the title waits for exactly that profile', async () => {
    const d = deps('in');
    expect(await playFromWall(ARGS, FROM, d)).toMatchObject({ok: true, status: 'playing'});
    expect(d.asks).toEqual([{profileId: 'pa', title: 'Arrival', who: "Elia's Android phone"}]);
    expect(takePendingPlay('pa', 1_000_500)).toEqual(ARGS);
    expect(takePendingPlay('pa', 1_000_600)).toBeNull(); // taken once
  });

  test('a password or the PIN: the TV asks ("Enter your PIN to play …"), the phone hears needs-pin / needs-password, the title waits', async () => {
    expect(await playFromWall(ARGS, FROM, deps('pin'))).toEqual({ok: true, status: 'needs-pin'});
    expect(_pending()?.profileId).toBe('pa');
    expect(await playFromWall(ARGS, FROM, deps('password'))).toEqual({ok: true, status: 'needs-password'});
    expect(askToPlay('pin', 'Arrival')).toBe('Enter your PIN to play Arrival');
    expect(askToPlay('password', titleOf({title: 'Pilot', showTitle: 'Silo', season: 1, episode: 3}))).toBe('Enter your password to play Silo · S1 E3');
  });

  test('somebody else comes in instead: the title is not theirs — dropped', async () => {
    await playFromWall(ARGS, FROM, deps('pin'));
    expect(takePendingPlay('pb', 1_000_100)).toBeNull();
    expect(takePendingPlay('pa', 1_000_200)).toBeNull();
  });

  test('nobody types the PIN in time: the title is dropped after PENDING_MS', async () => {
    await playFromWall(ARGS, FROM, deps('pin'));
    expect(takePendingPlay('pa', 1_000_000 + PENDING_MS + 1)).toBeNull();
  });

  test('a locked profile, one not on this TV, a door that failed, Aurora not let forward: refused, nothing waits', async () => {
    expect(await playFromWall(ARGS, FROM, deps('locked'))).toEqual({ok: false, error: 'locked', message: MSG.profileLocked});
    expect(_pending()).toBeNull();
    expect(await playFromWall(ARGS, FROM, deps('missing'))).toMatchObject({ok: false, error: 'no-profile'});
    expect(await playFromWall(ARGS, FROM, deps('error'))).toMatchObject({ok: false, error: 'failed', message: MSG.wallFailed});
    const away = deps('in', false);
    expect(await playFromWall(ARGS, FROM, away)).toMatchObject({ok: false, error: 'background'});
    expect(away.asks).toHaveLength(0);
    expect(_pending()).toBeNull();
  });

  test('who asks comes from the server (from.profileId), nothing else: none, no title', async () => {
    const d = deps('in');
    expect(await playFromWall(ARGS, {label: 'Android phone', profileName: 'Elia'}, d)).toMatchObject({ok: false, error: 'bad-command'});
    expect(d.asks).toHaveLength(0);
  });

  test('wallOutcome covers every door', () => {
    expect(['in', 'pin', 'password', 'locked', 'missing', 'error'].map(x => wallOutcome(x as WallDoor).ok)).toEqual([true, true, true, false, false, false]);
  });
});

// ---------------------------------------------------------------- the screensaver
describe('the screensaver is woken first', () => {
  type Listener = (s: string) => void;
  const listeners = new Set<Listener>();
  const appState = AppState as unknown as {currentState: string; addEventListener: (t: string, fn: Listener) => {remove: () => void}};
  const realAdd = appState.addEventListener;
  let calls: string[];
  beforeEach(() => {
    calls = [];
    mockDispatch.mockClear();
    listeners.clear();
    appState.currentState = 'background';
    appState.addEventListener = (_t, fn) => {
      listeners.add(fn);
      return {remove: () => listeners.delete(fn)};
    };
  });
  afterEach(() => {
    appState.addEventListener = realAdd;
    appState.currentState = 'active';
  });
  const native = (wakeWorks: boolean) => {
    (NativeModules as Record<string, unknown>).AuroraRemote = {
      pressKey: async () => true,
      wake: async () => {
        calls.push('wake');
        if (wakeWorks)
          setTimeout(() => {
            appState.currentState = 'active';
            for (const fn of [...listeners]) fn('active');
          }, 5);
        return true;
      },
      bringToFront: async () => {
        calls.push('bringToFront');
        return false;
      },
    };
  };

  test('a dream over Aurora: waking it is enough — the film opens, no activity start', async () => {
    native(true);
    expect(await bringAuroraForward()).toBe('woke');
    expect(calls).toEqual(['wake']);
    appState.currentState = 'background';
    const out = await playItemOnTv(ARGS);
    expect(out).toMatchObject({ok: true, status: 'playing', message: MSG.openingApp});
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('not a dream (another app in front) and Android refuses the start: "open it there", nothing plays', async () => {
    native(false);
    const out = await playItemOnTv(ARGS);
    expect(out).toMatchObject({ok: false, error: 'background'});
    expect(calls).toEqual(['wake', 'bringToFront']);
    expect(mockDispatch).not.toHaveBeenCalled();
  }, 10000);

  test('already in front: plays at once, says "playing"', async () => {
    native(false);
    appState.currentState = 'active';
    expect(await playItemOnTv(ARGS)).toEqual({ok: true, status: 'playing', message: MSG.opening});
  });
});

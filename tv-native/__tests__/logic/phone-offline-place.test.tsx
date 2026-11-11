// "On this device" on the phone (src/phone/offline/Place.tsx, SizeSheet.tsx, RestTitle.tsx) in the
// website's words: a save's row and the buttons its state gives (Pause · Cancel, Resume ·
// Cancel, Retry · Dismiss), a wish's row, the titles (a film a row, a show one group with Next
// up / Watched / Kept ready), the empty state, the size sheet (the sound, the sizes, the
// season / show choice, Always use the size I pick), and a title page resting with no connection.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

jest.mock('react-native', () => {
  const stub = jest.requireActual('./rn-stub.js');
  class V extends stub.Animated.Value {
    stopAnimation() {}
  }
  const anim = () => ({start: (cb?: (r: {finished: boolean}) => void) => cb && cb({finished: true}), stop: () => {}});
  const ease = () => (t: number) => t;
  return {
    ...stub,
    Animated: {...stub.Animated, Value: V, loop: anim, parallel: anim, sequence: anim},
    Easing: {bezier: ease, out: ease, inOut: ease, linear: (t: number) => t, cubic: (t: number) => t},
    ScrollView: 'ScrollView',
    Switch: 'Switch',
    Pressable: 'Pressable',
    Modal: 'Modal',
    AccessibilityInfo: {isReduceMotionEnabled: () => Promise.resolve(true), addEventListener: () => ({remove: () => {}})},
    useWindowDimensions: () => ({width: 412, height: 915}),
  };
});
jest.mock('react-native-svg', () => ({__esModule: true, default: 'Svg', Svg: 'Svg', Circle: 'Circle', G: 'G', Path: 'Path'}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 24, bottom: 24, left: 0, right: 0})}));
jest.mock('../../src/phone/ui/Cards', () => ({artSrc: () => ({src: null})}));
jest.mock('../../src/phone/ui/Icon', () => 'Icon');
jest.mock('../../src/phone/nav', () => ({pushPhone: jest.fn()}));
jest.mock('../../src/phone/offline/store', () => ({
  cancelOffline: jest.fn(),
  dismissOffline: jest.fn(),
  pauseOffline: jest.fn(),
  resumeOffline: jest.fn(),
  removeOffline: jest.fn(),
  setOfflinePrefs: jest.fn(),
  offlinePrefs: () => ({keepNext: true, quality: 'ask'}),
  useOffline: () => [{id: 'L2', profileId: 'p1', title: 'Two', state: 'done', pct: 1}, {id: 'L3', profileId: 'p1', title: 'Three', state: 'saving', pct: 0.4}],
  saveOffline: jest.fn(async () => 'started'),
  onOfflinePrefs: () => () => {},
  onOfflineLanded: () => () => {},
}));
jest.mock('../../src/phone/offline/wishes', () => ({removeWish: jest.fn(), useWishes: () => [], addWish: jest.fn(async () => ({}))}));
jest.mock('../../src/toast', () => ({showToast: jest.fn()}));

import {EmptyPlace, JobRow, RoomBlock, SavedTitles, SmartNextFoot, WishRow} from '../../src/phone/offline/Place';
import SizeSheet, {askSize} from '../../src/phone/offline/SizeSheet';
import RestTitle, {copiesOfTitle} from '../../src/phone/offline/RestTitle';
import ChooseSheet, {openChooser} from '../../src/phone/offline/ChooseSheet';
import {pushPhone} from '../../src/phone/nav';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockStore = require('../../src/phone/offline/store');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockWishes = require('../../src/phone/offline/wishes');

const GB = 1024 ** 3;
const copy = (o: Record<string, unknown>) => ({id: 'c1', profileId: 'p1', title: 'Film', duration: 5400, quality: '720', sizeBytes: GB, file: '/f', subs: [], dmId: null, state: 'done', pct: 1, at: 1, ...o}) as never;
const texts = (r: TestRenderer.ReactTestRenderer) => r.root.findAll(n => (n.type as unknown) === 'Text').map(n => [].concat(n.props.children).join('')).join(' | ');
const press = (r: TestRenderer.ReactTestRenderer, label: string) => {
  const b = r.root.find(n => (n.type as unknown) === 'Pressable' && n.props.accessibilityLabel === label);
  act(() => b.props.onPress());
};
const render = (el: React.ReactElement) => {
  let r: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r!;
};

describe('a save’s row', () => {
  test('saving: Pause and Cancel; the head in the website’s words', () => {
    const r = render(<JobRow c={copy({state: 'saving', pct: 0.42})} />);
    expect(texts(r)).toMatch(/Saving to this device · 42%/);
    press(r, 'Pause');
    expect(mockStore.pauseOffline).toHaveBeenCalledWith('c1');
    press(r, 'Cancel');
    expect(mockStore.cancelOffline).toHaveBeenCalledWith('c1');
  });
  test('paused by the person: Resume and Cancel, and the honest line', () => {
    const r = render(<JobRow c={copy({state: 'paused', why: 'user', pct: 0.42})} />);
    expect(texts(r)).toMatch(/Paused at 42%.*What is saved stays here — press Resume to carry on/);
    expect(() => press(r, 'Pause')).toThrow();
    press(r, 'Resume');
    expect(mockStore.resumeOffline).toHaveBeenCalled();
  });
  test('didn’t save: Retry and Dismiss, with the reason', () => {
    const r = render(<JobRow c={copy({state: 'failed', error: 'the server said no'})} />);
    expect(texts(r)).toMatch(/Didn't save.*the server said no/);
    press(r, 'Retry');
    press(r, 'Dismiss');
    expect(mockStore.dismissOffline).toHaveBeenCalled();
  });
  test('waiting for the connection', () => {
    expect(texts(render(<JobRow c={copy({state: 'retrying', pct: 0.3})} />))).toMatch(/Waiting for the connection · 30%.*it carries on by itself/);
  });
});

describe('a wish’s row', () => {
  test('waiting: Cancel', () => {
    const r = render(<WishRow w={{id: 'w', deviceId: 'd', scope: 'title', type: 'movie', title: 'Later Film', quality: '720', state: 'waiting'}} />);
    expect(texts(r)).toMatch(/Later Film.*Waiting for the server's copy.*It is saved here by itself when it arrives/);
    press(r, 'Cancel');
    expect(mockWishes.removeWish).toHaveBeenCalledWith('w');
  });
  test('won’t arrive: Dismiss, with the server’s sentence', () => {
    const r = render(<WishRow w={{id: 'w2', deviceId: 'd', scope: 'title', type: 'movie', title: 'Gone', quality: '720', state: 'failed', error: 'The download was cancelled — there is nothing to save.'}} />);
    expect(texts(r)).toMatch(/Won't arrive.*The download was cancelled/);
    press(r, 'Dismiss');
  });
  test('a season', () => {
    expect(texts(render(<WishRow w={{id: 'w3', deviceId: 'd', scope: 'season', type: 'show', showTitle: 'Show', season: 2, quality: '720', state: 'waiting'}} />))).toMatch(/Show · S2.*Every new episode of season 2/);
  });
});

describe('the titles', () => {
  test('a film a row; a show one group: Play the next one, Next up, Watched, Kept ready', () => {
    const play = jest.fn();
    const all = [
      copy({id: 'f', title: 'A Film', position: 1500, duration: 5820, quality: 'original', audioLabel: 'English'}),
      copy({id: 'e1', title: 'Pilot', showId: 's', showTitle: 'Show', season: 1, episode: 1, finishedAt: 5}),
      copy({id: 'e2', title: 'Two', showId: 's', showTitle: 'Show', season: 1, episode: 2, kept: 'next'}),
    ];
    const r = render(<SavedTitles copies={all} onPlay={play} />);
    const t = texts(r);
    expect(t).toMatch(/A Film.*1 h 12 min left · 1.0 GB · Original quality · English/);
    expect(t).toMatch(/2 episodes · 2.0 GB · 1 watched/);
    expect(t).toMatch(/Next up/);
    expect(t).toMatch(/✓ Watched/);
    expect(t).toMatch(/Kept ready/);
    press(r, 'Play S1 E2');
    expect(play).toHaveBeenCalledWith(expect.objectContaining({id: 'e2'}));
    press(r, 'Remove Show from this device');
    expect(mockStore.removeOffline).toHaveBeenCalledWith(['e1', 'e2'], 'Removed “Show” from this device');
  });
  test('the room and Remove watched', () => {
    const r = render(<RoomBlock copies={[copy({id: 'a', finishedAt: 1}), copy({id: 'b'})]} free={18 * GB} profileId="p1" />);
    expect(texts(r)).toMatch(/2.0 GB saved here · room for ≈ 18.0 GB more/);
    press(r, 'Remove watched · 1 · 1.0 GB');
    expect(mockStore.removeOffline).toHaveBeenCalledWith(['a']);
  });
  test('empty: the site’s words; something on its way: one quiet line', () => {
    expect(texts(render(<EmptyPlace free={18 * GB} moving={false} />))).toMatch(/Nothing saved for offline yet.*Save to this device.*a flight, a train, the middle of nowhere.*Room on this device: ≈ 18.0 GB/);
    expect(texts(render(<EmptyPlace free={0} moving />))).toBe('Nothing saved for offline yet — what is on its way lands here.');
  });
  test('Keep the next episode ready: the switch and what it did', () => {
    const r = render(<SmartNextFoot copies={[copy({id: 'e2', showTitle: 'Show', season: 1, episode: 2, kept: 'next', savedAt: 9})]} />);
    expect(texts(r)).toMatch(/Keep the next episode ready.*When you finish a saved episode, the next one saves itself. Nothing is removed.*Saved by itself: Show · S1 E2/);
  });
});

describe('the size sheet', () => {
  test('the sound, the sizes (≈ for an estimate), the room, and the answer', async () => {
    const r = render(<SizeSheet />);
    let answer: unknown;
    let p: Promise<unknown>;
    act(() => {
      p = askSize({
        name: 'Test Babel',
        options: [
          {quality: 'original', label: 'Original quality', sizeBytes: 2 * GB, instant: true, detail: '1080p · H264'},
          {quality: '720', label: '720p', sizeBytes: 0.6 * GB, estimated: true, detail: 'good for a phone'},
        ],
        sounds: [{index: 0, language: 'eng', channels: 6}, {index: 1, language: 'heb'}],
        chosenAudio: 1,
        free: 1 * GB,
      }).then(a => (answer = a));
    });
    const t = texts(r);
    expect(t).toMatch(/Save to this device — which size\?/);
    expect(t).toMatch(/“Test Babel”/);
    expect(t).toMatch(/Sound.*English · 5.1.*Hebrew/);
    expect(t).toMatch(/≈ 614 MB/);
    expect(t).toMatch(/more than the room left/); // Original does not fit in 1 GB
    expect(t).toMatch(/Room on this device: ≈ 1.0 GB/);
    // the chosen sound says so twice: the tint and the tick
    const heb = r.root.find(n => (n.type as unknown) === 'Pressable' && n.props.accessibilityLabel === 'Hebrew');
    expect(heb.props.accessibilityState).toEqual({checked: true});
    press(r, 'English · 5.1');
    press(r, 'Always use the size I pick');
    act(() => r.root.find(n => (n.type as unknown) === 'Pressable' && String(n.props.accessibilityLabel).startsWith('720p')).props.onPress());
    await act(async () => {
      await p!;
    });
    expect(answer).toEqual({quality: '720', audio: 0, always: true, scope: null});
  });
  test('a wish: the season / the show, one at most', async () => {
    const r = render(<SizeSheet />);
    let answer: unknown;
    let p: Promise<unknown>;
    act(() => {
      p = askSize({name: 'Show S2 E5', lead: 'x', options: [{quality: '720', label: '720p', sizeBytes: 0}], scopes: [{scope: 'season', label: 'And every new episode of season 2'}, {scope: 'show', label: 'And every new episode of this show'}]}).then(a => (answer = a));
    });
    press(r, 'And every new episode of season 2');
    press(r, 'And every new episode of this show');
    press(r, '720p');
    await act(async () => {
      await p!;
    });
    expect(answer).toEqual({quality: '720', audio: 0, always: false, scope: 'show'});
  });
  test('Not now', async () => {
    const r = render(<SizeSheet />);
    let answer: unknown = 'x';
    let p: Promise<unknown>;
    act(() => {
      p = askSize({name: 'F', options: [{quality: '720', label: '720p', sizeBytes: 0}]}).then(a => (answer = a));
    });
    press(r, 'Not now');
    await act(async () => {
      await p!;
    });
    expect(answer).toBeNull();
  });
});

describe('a title page with no connection rests', () => {
  test('not here: amber, On this device and Try again', () => {
    const retry = jest.fn();
    const r = render(<RestTitle title="Far Film" copies={copiesOfTitle([], {id: 'x'})} onRetry={retry} />);
    expect(texts(r)).toMatch(/NO CONNECTION.*Far Film.*This one isn't on this device, so it waits for the connection./);
    press(r, 'On this device');
    expect(pushPhone).toHaveBeenCalledWith('Downloads');
    press(r, 'Try again');
    expect(retry).toHaveBeenCalled();
  });
  test('episodes here: mint, Play the next one not finished', () => {
    const eps = [copy({id: 'e1', showId: 's', season: 1, episode: 1, finishedAt: 1}), copy({id: 'e2', showId: 's', season: 1, episode: 2})];
    const r = render(<RestTitle title="Show" copies={copiesOfTitle(eps as never, {id: 's'})} onRetry={() => {}} />);
    expect(texts(r)).toMatch(/2 episodes are on this device — they play with no connection./);
    press(r, 'Play S1 E2');
    expect(pushPhone).toHaveBeenCalledWith('OfflinePlayer', {id: 'e2'});
  });
});

describe('Choose episodes', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {api} = require('../../src/api');
  test('saved, on its way, on the server and not yet; the next ones ticked; the total; Save', async () => {
    api.item = jest.fn(async (id: string) => ({id, title: `T ${id}`, duration: 2700, subtitles: []}));
    const r = render(<ChooseSheet />);
    act(() =>
      openChooser({
        title: 'Test Show',
        showId: 's',
        imdbId: 'tt1',
        seasons: [
          {
            number: 1,
            episodes: [
              {season: 1, episode: 1, title: 'One', libId: 'L1', duration: 2700, sizeBytes: GB},
              {season: 1, episode: 2, title: 'Two', libId: 'L2', duration: 2700, sizeBytes: GB},
              {season: 1, episode: 3, title: 'Three', libId: 'L3', duration: 2700, sizeBytes: GB},
              {season: 1, episode: 4, title: 'Four', libId: 'L4', duration: 2700, sizeBytes: GB},
              {season: 1, episode: 5, title: 'Five', libId: null, aired: true},
            ],
          },
          {number: 2, episodes: [{season: 2, episode: 1, title: 'Next year', libId: null, aired: false}]},
        ],
        from: {season: 1, episode: 1},
      }),
    );
    const t = texts(r);
    expect(t).toMatch(/Choose episodes/);
    expect(t).toMatch(/Season 1.*Season 2/);
    expect(t).toMatch(/Two \| E2 +\| 45 min \| Saved on this device/);
    expect(t).toMatch(/Three \| E3 +\| 45 min \| Saving 40%/);
    expect(t).toMatch(/Five \| E5 +\| ≈ 717 MB \| Not on the server yet — saves here when it arrives/);
    // the next three that can be ticked: E1, E4, E5
    const box = (n: string) => r.root.find(x => (x.type as unknown) === 'Pressable' && String(x.props.accessibilityLabel).startsWith(`Episode ${n},`));
    expect(box('1').props.accessibilityState).toEqual({checked: true});
    expect(box('4').props.accessibilityState).toEqual({checked: true});
    expect(box('5').props.accessibilityState).toEqual({checked: true});
    expect(t).toMatch(/3 episodes · ≈ .* · 1 when it arrives/);
    press(r, 'Clear');
    expect(texts(r)).toMatch(/No episodes ticked/);
    press(r, 'Select all');
    expect(texts(r)).toMatch(/3 episodes/); // saved and on-its-way ones are never ticked
    press(r, 'Original');
    act(() => box('5').props.onPress()); // untick the one not on the server
    expect(texts(r)).toMatch(/2 episodes · 2.0 GB/);
    await act(async () => {
      r.root.find(x => (x.type as unknown) === 'Pressable' && x.props.accessibilityLabel === 'Save 2 episodes').props.onPress();
      await new Promise<void>(res => setTimeout(res, 0));
    });
    expect(mockStore.saveOffline).toHaveBeenCalledTimes(2);
    expect((mockStore.saveOffline as jest.Mock).mock.calls[0][2]).toEqual({quality: 'original', quiet: true});
  });
});

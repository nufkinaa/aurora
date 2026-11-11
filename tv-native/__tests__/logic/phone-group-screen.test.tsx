// "What do we watch tonight?" — the phone's screen (phone/screens/GroupPick.tsx),
// driven through its states with the server stood in for: the code field, the
// TV's QR landing straight in (with the first-time explanation), swiping with
// the buttons and Undo (optimistic, and back when the vote never arrived), the
// result's Play (on the TV when the room has one, here when it has none).
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

jest.mock('react-native', () => {
  const stub = jest.requireActual('./rn-stub.js');
  class Value {
    v: number;
    constructor(v: number) {
      this.v = v;
    }
    setValue(v: number) {
      this.v = v;
    }
    stopAnimation(cb?: (v: number) => void) {
      if (cb) cb(this.v);
    }
    interpolate(cfg: unknown) {
      return {interpolated: cfg};
    }
  }
  class ValueXY {
    x: Value;
    y: Value;
    constructor(v: {x: number; y: number} = {x: 0, y: 0}) {
      this.x = new Value(v.x);
      this.y = new Value(v.y);
    }
    setValue(v: {x: number; y: number}) {
      this.x.setValue(v.x);
      this.y.setValue(v.y);
    }
    stopAnimation() {}
  }
  const anim = () => ({
    start: (cb?: (r: {finished: boolean}) => void) => cb && cb({finished: true}),
    stop: () => {},
  });
  return {
    ...stub,
    ActivityIndicator: 'ActivityIndicator',
    ScrollView: 'ScrollView',
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    TextInput: 'TextInput',
    AccessibilityInfo: {isReduceMotionEnabled: () => Promise.resolve(true)},
    PanResponder: {create: () => ({panHandlers: {}})},
    Easing: {
      bezier: () => (t: number) => t,
      out: () => (t: number) => t,
      in: () => (t: number) => t,
      cubic: (t: number) => t,
      quad: (t: number) => t,
    },
    Animated: {
      ...stub.Animated,
      Value,
      ValueXY,
      add: () => 0,
      parallel: anim,
      timing: anim,
      spring: anim,
    },
  };
});
const mockRoute: {params: {code?: string | null} | undefined} = {
  params: undefined,
};
jest.mock('@react-navigation/native', () => ({useRoute: () => mockRoute}));
const mockNav = {push: jest.fn(), goBack: jest.fn(), canGoBack: () => true};
jest.mock('../../src/phone/nav', () => ({usePNav: () => mockNav}));
jest.mock('../../src/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {ApiError, getBaseUrl: () => 'https://nufurora.com'};
});
jest.mock('react-native-qrcode-svg', () => ({__esModule: true, default: 'QRCode'}));
jest.mock('../../src/phone/native', () => ({
  phoneNative: {haptic: () => {}},
}));
jest.mock('../../src/phone/theme', () => ({
  colors: {
    text: '#fff',
    textDim: '#ccc',
    textFaint: '#999',
    chip: '#111',
    chipEdge: '#222',
    bgRaised: '#000',
    surface: '#111',
    owned: '#6fe0b0',
    accent: '#88f',
  },
  GUTTER: 16,
  radius: {s: 8, m: 12, l: 16, xl: 20, pill: 999},
}));
jest.mock('../../src/phone/ui/PageHead', () => ({
  BackBar: () => null,
  useColumn: () => null,
  usePageTop: () => 100,
}));
jest.mock('../../src/phone/ui/TabBar', () => ({useTabBarSpace: () => 80}));
jest.mock('../../src/phone/ui/TopBar', () => ({useBarTop: () => 20}));
jest.mock('../../src/phone/ui/Cards', () => ({
  artSrc: () => ({src: null}),
}));
jest.mock('../../src/phone/ui/Avatar', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../../src/phone/ui/Field', () => {
  const R = jest.requireActual('react');
  return {
    __esModule: true,
    default: (p: Record<string, unknown>) => R.createElement('Field', p),
  };
});
jest.mock('../../src/phone/ui/SearchBox', () => {
  const R = jest.requireActual('react');
  return {
    __esModule: true,
    default: (p: Record<string, unknown>) => R.createElement('SearchBox', p),
  };
});
jest.mock('../../src/phone/ui/Glass', () => {
  const R = jest.requireActual('react');
  return {
    __esModule: true,
    default: (p: Record<string, unknown>) => R.createElement('Glass', p, p.children as never),
  };
});
jest.mock('../../src/phone/ui/Sheet', () => {
  const R = jest.requireActual('react');
  return {
    __esModule: true,
    default: (p: Record<string, unknown>) => (p.visible ? R.createElement('Sheet', p, p.children as never) : null),
  };
});
jest.mock('../../src/phone/ui/Tap', () => {
  const R = jest.requireActual('react');
  return {
    __esModule: true,
    default: (p: Record<string, unknown>) => R.createElement('Tap', p, p.children as never),
  };
});
jest.mock('../../src/phone/ui/Buttons', () => {
  const R = jest.requireActual('react');
  const b = (name: string) => (p: Record<string, unknown>) => R.createElement(name, p);
  return {
    PrimaryButton: b('PrimaryButton'),
    GlassButton: b('GlassButton'),
    ChipButton: b('ChipButton'),
  };
});

type Session = import('../../src/groupPick').GroupSession;
const mockFollow = {
  onSession: null as null | ((s: Session) => void),
  stop: jest.fn(),
  refresh: jest.fn(),
  code: '',
};
const mockApi = {
  options: jest.fn(),
  tutorialSeen: jest.fn(() => Promise.resolve({tutorialSeen: true})),
  create: jest.fn(),
  join: jest.fn(),
  settings: jest.fn(),
  start: jest.fn(),
  vote: jest.fn(),
  search: jest.fn(),
  add: jest.fn(),
  finish: jest.fn(),
  extend: jest.fn(),
  pick: jest.fn(),
  again: jest.fn(),
  choose: jest.fn(),
  leave: jest.fn(() => Promise.resolve({ok: true})),
  end: jest.fn(),
};
jest.mock('../../src/groupPickApi', () => ({
  get groupApi() {
    return mockApi;
  },
  followGroup: (code: string, onSession: (s: Session) => void) => {
    mockFollow.code = code;
    let had: Session | null = null;
    mockFollow.onSession = (s: Session) => {
      if (had && s.rev < had.rev) return;
      had = s;
      onSession(s);
    };
    return {
      stop: mockFollow.stop,
      refresh: mockFollow.refresh,
      take: (s: Session) => mockFollow.onSession!(s),
      receivedAt: () => Date.now(),
    };
  },
  playTarget: (c: {id?: string; imdbId?: string; type: string}) =>
    c.id ? {kind: 'library', id: c.id, type: c.type} : c.imdbId ? {kind: 'discover', imdbId: c.imdbId, type: c.type} : null,
}));

import GroupPick from '../../src/phone/screens/GroupPick';
import {ApiError} from '../../src/api';
import {TUTORIAL, WORDS} from '../../src/groupPick';

const OPTIONS = {
  tutorialSeen: true,
  moods: [
    {id: 'any', label: 'Anything'},
    {id: 'funny', label: 'Funny'},
  ],
  lengths: [{id: 'any', label: 'Any length'}],
  kinds: [
    {id: 'movie', label: 'Films'},
    {id: 'show', label: 'Series'},
  ],
  limits: [120, 180, 300],
};
const member = (o: Partial<Session['members'][number]>): Session['members'][number] => ({
  id: 'x|d',
  profileId: 'x',
  name: 'X',
  role: 'voter',
  app: 'phone',
  host: false,
  away: false,
  answered: 0,
  done: false,
  ...o,
});
const TV = member({
  id: 'elia|tv',
  profileId: 'elia',
  name: 'Elia',
  role: 'screen',
  app: 'tv',
  host: true,
});
const ME = member({id: 'me|1', profileId: 'me', name: 'Dana'});
const session = (o: Partial<Session> = {}): Session =>
  ({
    code: 'K7QM',
    rev: 1,
    phase: 'lobby',
    round: 1,
    now: 1000,
    createdAt: 0,
    expiresAt: 0,
    settings: {kind: 'movie', mood: 'any', length: 'any', limitSec: 180},
    host: {id: 'elia|tv', name: 'Elia', profileId: 'elia'},
    you: {id: 'me|1', profileId: 'me', role: 'voter', host: false},
    members: [TV, ME],
    voters: 1,
    added: [],
    deck: [],
    mine: {},
    deadline: null,
    limitSec: 180,
    ...o,
  } as Session);
const DECK = [
  {
    key: 'lib:a',
    id: 'a',
    title: 'Arrival',
    type: 'movie',
    year: 2016,
    runtime: 116,
    genres: ['Sci-Fi'],
    lib: true,
    seenBy: ['Avi'],
  },
  {
    key: 'tt2',
    imdbId: 'tt2',
    title: 'Brick',
    type: 'movie',
    lib: false,
    addedBy: 'Elia',
  },
] as Session['deck'];

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root
    .findAll(n => (n.type as unknown) === 'Text')
    .map(n =>
      []
        .concat(n.props.children)
        .filter(c => typeof c === 'string' || typeof c === 'number')
        .join(''),
    );
const has = (r: TestRenderer.ReactTestRenderer, t: string) => texts(r).some(x => x.includes(t));
const byUi = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll(n => typeof n.type === 'string' && n.props.uiId === id);
const press = async (r: TestRenderer.ReactTestRenderer, id: string, i = 0) => {
  const n = byUi(r, id)[i];
  if (!n) throw new Error(`no ${id}`);
  await act(async () => {
    n.props.onPress();
  });
  await flush();
};
const push = async (s: Session) => {
  await act(async () => {
    mockFollow.onSession!(s);
  });
  await flush();
};

let r: TestRenderer.ReactTestRenderer;
const open = async () => {
  await act(async () => {
    r = TestRenderer.create(<GroupPick />);
  });
  await flush();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRoute.params = undefined;
  mockApi.options.mockResolvedValue({...OPTIONS});
  mockFollow.onSession = null;
});
afterEach(() => {
  act(() => r?.unmount());
});

test('no session: join with a code (checked here first) or start with the choices', async () => {
  await open();
  expect(has(r, WORDS.feature)).toBe(true);
  expect(byUi(r, 'group.join')).toHaveLength(1);
  const field = r.root.find(n => (n.type as unknown) === 'Field');
  await act(async () => field.props.onChangeText('k7-q'));
  expect(r.root.find(n => (n.type as unknown) === 'Field').props.value).toBe('K7Q');
  await press(r, 'group.join');
  expect(has(r, WORDS.codeWrong)).toBe(true);
  expect(mockApi.join).not.toHaveBeenCalled();
  // Start (the second play card, under Join): the TV's choices as chunky chips, then create as a voter
  const chips = byUi(r, 'group.option');
  expect(chips.map(c => c.props.accessibilityLabel)).toEqual(['Films', 'Series', 'Anything', 'Funny', 'Any length', '2 min', '3 min', '5 min']);
  await act(async () => chips[3].props.onPress());
  mockApi.create.mockResolvedValue({
    session: session({
      you: {id: 'me|1', profileId: 'me', role: 'voter', host: true},
      host: {id: 'me|1', name: 'Dana', profileId: 'me'},
      members: [{...ME, host: true}],
    }),
  });
  await press(r, 'group.start');
  expect(mockApi.create).toHaveBeenCalledWith({kind: 'movie', mood: 'funny', length: 'any', limitSec: 180}, 'voter');
  // the lobby: the code to read out, the starter's Start swiping
  expect(has(r, 'K7QM')).toBe(true);
  // the website's code block: Join in, the code, the QR code another phone reads, the line, the address
  expect(has(r, WORDS.joinTitle)).toBe(true);
  expect(r.root.find(n => (n.type as unknown) === 'QRCode').props.value).toBe('https://nufurora.com/#/group/K7QM');
  expect(has(r, WORDS.joinLine)).toBe(true);
  expect(has(r, 'nufurora.com')).toBe(true);
  expect(byUi(r, 'group.deal')).toHaveLength(1);
  expect(byUi(r, 'group.end')).toHaveLength(1);
});

test("the TV's QR: joined at once, the first-time explanation first, then the lobby", async () => {
  mockRoute.params = {code: 'k7qm'};
  mockApi.options.mockResolvedValue({...OPTIONS, tutorialSeen: false});
  mockApi.join.mockResolvedValue({session: session()});
  await open();
  expect(mockApi.join).toHaveBeenCalledWith('K7QM', 'voter');
  expect(has(r, TUTORIAL[0].title)).toBe(true);
  for (let i = 1; i < TUTORIAL.length; i++) {
    await press(r, 'group.tutorial.next');
    expect(has(r, TUTORIAL[i].title)).toBe(true);
  }
  expect(byUi(r, 'group.tutorial.next')[0].props.label).toBe(WORDS.letsGo);
  expect(byUi(r, 'group.tutorial.skip')).toHaveLength(0);
  await press(r, 'group.tutorial.next');
  expect(mockApi.tutorialSeen).toHaveBeenCalledTimes(1);
  expect(has(r, 'K7QM')).toBe(true);
  expect(has(r, 'Dana is in')).toBe(true);
  expect(has(r, WORDS.onlyHost)).toBe(true);
  expect(byUi(r, 'group.deal')).toHaveLength(0);
  // "How it works" brings it back; Skip closes it (and does not ask the server again)
  await press(r, 'group.howto');
  expect(has(r, TUTORIAL[0].title)).toBe(true);
  await press(r, 'group.tutorial.skip');
  expect(mockApi.tutorialSeen).toHaveBeenCalledTimes(1);
  // Leave
  await press(r, 'group.leave');
  expect(mockApi.leave).toHaveBeenCalledWith('K7QM');
  expect(mockNav.goBack).toHaveBeenCalled();
});

test('swiping: the buttons answer and move on at once; Undo takes it back; a lost vote comes back', async () => {
  mockRoute.params = {code: 'K7QM'};
  mockApi.join.mockResolvedValue({
    session: session({phase: 'swiping', deck: DECK, deadline: 1000 + 151000}),
  });
  mockApi.vote.mockResolvedValue({ok: true, answered: 1, of: 2});
  await open();
  // the stage is measured on screen (onLayout), then the card is drawn at 2:3 inside it
  const stage = r.root.find(n => (n.type as unknown) === 'View' && n.props.testID === 'group-stage');
  await act(async () =>
    stage.props.onLayout({
      nativeEvent: {layout: {width: 328, height: 480}},
    }),
  );
  expect(has(r, 'Arrival')).toBe(true);
  expect(has(r, '2016 · 1 h 56 · Sci-Fi')).toBe(true);
  expect(has(r, 'Avi has seen it')).toBe(true);
  expect(has(r, WORDS.libBadge)).toBe(true);
  expect(texts(r).some(t => /^2:3\d left$/.test(t))).toBe(true);
  await press(r, 'group.yes');
  expect(mockApi.vote).toHaveBeenLastCalledWith('K7QM', 'lib:a', 'yes');
  expect(has(r, 'Brick')).toBe(true);
  expect(has(r, 'Added by Elia')).toBe(true);
  // a slow copy from before the vote does not bring Arrival back
  await push(session({rev: 2, phase: 'swiping', deck: DECK, deadline: 1000 + 151000}));
  expect(texts(r).some(t => t === 'Brick')).toBe(true);
  expect(texts(r).some(t => t === 'Arrival')).toBe(false);
  await press(r, 'group.undo');
  expect(mockApi.vote).toHaveBeenLastCalledWith('K7QM', 'lib:a', null);
  expect(texts(r).some(t => t === 'Arrival')).toBe(true);
  // no connection: the card comes back, said calmly
  mockApi.vote.mockRejectedValueOnce(new ApiError(0, 'Cannot reach server'));
  await press(r, 'group.no');
  expect(texts(r).some(t => t === 'Arrival')).toBe(true);
  expect(has(r, WORDS.noReach)).toBe(true);
  // refused with a reason: the answer stays, the reason is shown
  mockApi.vote.mockRejectedValueOnce(new ApiError(409, 'Time is up for this round'));
  await press(r, 'group.maybe');
  expect(texts(r).some(t => t === 'Brick')).toBe(true);
  expect(has(r, 'Time is up for this round')).toBe(true);
  // the last one: done, waiting for the others
  await press(r, 'group.yes');
  expect(has(r, WORDS.doneWaiting)).toBe(true);
  expect(byUi(r, 'group.extend')).toHaveLength(0); // not the starter
});

test('the starter waiting: one more minute, or the result now', async () => {
  const host = {
    you: {id: 'me|1', profileId: 'me', role: 'voter' as const, host: true},
  };
  mockRoute.params = {code: 'K7QM'};
  mockApi.join.mockResolvedValue({
    session: session({
      ...host,
      phase: 'swiping',
      deck: DECK,
      mine: {'lib:a': 'yes', tt2: 'no'},
      deadline: 99999,
    }),
  });
  mockApi.extend.mockResolvedValue({
    session: session({
      ...host,
      rev: 3,
      phase: 'swiping',
      deck: DECK,
      mine: {'lib:a': 'yes', tt2: 'no'},
      deadline: 200000,
    }),
  });
  mockApi.finish.mockResolvedValue({
    session: session({
      ...host,
      rev: 4,
      phase: 'result',
      result: {method: 'best', index: 0, at: 0, why: 'host', picks: []},
    }),
  });
  await open();
  expect(has(r, WORDS.doneWaiting)).toBe(true);
  await press(r, 'group.extend');
  expect(mockApi.extend).toHaveBeenCalledWith('K7QM');
  await press(r, 'group.finish');
  expect(has(r, WORDS.noMatch)).toBe(true);
  expect(byUi(r, 'group.again')).toHaveLength(1);
});

const pick = (card: Session['deck'][number], why = '2 of 2 said yes') => ({
  key: card.key,
  why,
  yes: 2,
  maybe: 0,
  no: 0,
  missing: 0,
  of: 2,
  everyone: true,
  card,
});
const result = (o: Partial<Session> = {}) =>
  session({
    phase: 'result',
    deck: DECK,
    result: {
      method: 'everyone',
      index: 0,
      at: 0,
      why: 'done',
      picks: [pick(DECK[0]), pick(DECK[1], 'Elia said yes')],
    },
    ...o,
  });

test('the result with a TV in the room: Play on the TV, nothing starts on the phone', async () => {
  mockRoute.params = {code: 'K7QM'};
  mockApi.join.mockResolvedValue({session: result()});
  mockApi.pick.mockResolvedValue({
    session: result({
      rev: 2,
      result: {
        method: 'everyone',
        index: 1,
        at: 0,
        why: 'done',
        picks: [pick(DECK[0]), pick(DECK[1], 'Elia said yes')],
      },
    }),
  });
  mockApi.choose.mockResolvedValue({session: result({rev: 3})});
  await open();
  expect(has(r, WORDS.resultTitle)).toBe(true);
  expect(has(r, '2 of 2 said yes')).toBe(true);
  expect(byUi(r, 'group.play')[0].props.accessibilityLabel).toBe(WORDS.playOnTv);
  expect(byUi(r, 'group.next')[0].props.accessibilityLabel).toBe(WORDS.somethingElse);
  await press(r, 'group.next');
  expect(mockApi.pick).toHaveBeenCalledWith('K7QM', 1);
  expect(has(r, 'Elia said yes')).toBe(true);
  expect(byUi(r, 'group.next')[0].props.accessibilityLabel).toBe(WORDS.firstPick);
  await press(r, 'group.play');
  expect(mockApi.choose).toHaveBeenCalledWith('K7QM', 'tt2');
  expect(mockNav.push).not.toHaveBeenCalled();
  expect(has(r, WORDS.startingOnTv)).toBe(true);
  // chosen (by the TV's person): Enjoy, who pressed Play
  await push(
    result({
      rev: 9,
      phase: 'chosen',
      chosen: {key: 'tt2', by: 'Elia', card: DECK[1]},
    }),
  );
  expect(has(r, WORDS.enjoy)).toBe(true);
  expect(has(r, `Elia ${WORDS.pressedPlay}`)).toBe(true);
});

test('the result with no screen in the room: Play plays a library film on this phone', async () => {
  mockRoute.params = {code: 'K7QM'};
  const alone = {members: [ME] as Session['members']};
  mockApi.join.mockResolvedValue({session: result(alone)});
  mockApi.choose.mockResolvedValue({
    session: result({
      ...alone,
      rev: 3,
      phase: 'chosen',
      chosen: {key: 'lib:a', by: 'Dana', card: DECK[0]},
    }),
  });
  await open();
  expect(byUi(r, 'group.play')[0].props.accessibilityLabel).toBe(WORDS.play);
  await press(r, 'group.play');
  expect(mockNav.push).toHaveBeenCalledWith('Player', {
    id: 'a',
    title: 'Arrival',
  });
});

test('ended: the reason, and Leave goes back', async () => {
  mockRoute.params = {code: 'K7QM'};
  mockApi.join.mockResolvedValue({
    session: session({
      phase: 'ended',
      ended: {reason: 'The host ended it'},
    }),
  });
  await open();
  expect(has(r, WORDS.ended)).toBe(true);
  expect(has(r, 'The host ended it')).toBe(true);
  await press(r, 'group.leave');
  expect(mockApi.leave).not.toHaveBeenCalled();
  expect(mockNav.goBack).toHaveBeenCalled();
});

test('Add a title: the search sheet, the library badge, In the deck', async () => {
  mockRoute.params = {code: 'K7QM'};
  mockApi.join.mockResolvedValue({session: session()});
  mockApi.search.mockResolvedValue({
    results: [
      {
        key: 'lib:z',
        id: 'z',
        type: 'movie',
        title: 'Zodiac',
        year: 2007,
        lib: true,
        inDeck: false,
      },
      {
        key: 'tt9',
        imdbId: 'tt9',
        type: 'movie',
        title: 'Heat',
        year: 1995,
        lib: false,
        inDeck: true,
      },
    ],
  });
  mockApi.add.mockResolvedValue({ok: true, key: 'lib:z'});
  jest.useFakeTimers();
  try {
    await open();
    await press(r, 'group.add');
    expect(has(r, WORDS.addLine) || r.root.findAll(n => (n.type as unknown) === 'Sheet' && n.props.sub === WORDS.addLine).length === 1).toBe(true);
    const box = r.root.find(n => (n.type as unknown) === 'SearchBox');
    await act(async () => box.props.onChangeText('zo'));
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    await flush();
    expect(mockApi.search).toHaveBeenCalledWith('K7QM', 'zo');
    expect(has(r, 'Zodiac')).toBe(true);
    expect(has(r, WORDS.libBadge)).toBe(true);
    expect(has(r, WORDS.inDeck)).toBe(true);
    const row = r.root.findAll(n => (n.type as unknown) === 'Tap' && n.props.accessibilityLabel === 'Zodiac')[0];
    await act(async () => row.props.onPress());
    await flush();
    expect(mockApi.add).toHaveBeenCalledWith('K7QM', {
      id: 'z',
      imdbId: undefined,
      type: 'movie',
      title: 'Zodiac',
      year: 2007,
      poster: undefined,
    });
    expect(mockFollow.refresh).toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

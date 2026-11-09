// "What do we watch tonight?" — the TV screen (src/screens/GroupPick.tsx),
// driven the way the remote drives it: the first-time explanation before the
// start form, Start → the code and the QR code, the live session moving the
// screen on (the others swiping, the pick), Play starting the film once —
// also when a phone pressed it — the TV swiping too, and BACK asking first.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

const mockBack: Array<() => boolean> = [];
jest.mock('react-native', () => ({
  ...jest.requireActual('./rn-stub.js'),
  ActivityIndicator: 'ActivityIndicator',
  TextInput: 'TextInput',
  ScrollView: 'ScrollView',
  BackHandler: {
    addEventListener: (_: string, fn: () => boolean) => {
      mockBack.push(fn);
      return {remove: () => mockBack.splice(mockBack.indexOf(fn), 1)};
    },
  },
}));
jest.mock('react-native-svg', () => ({__esModule: true, default: 'Svg', Svg: 'Svg', Circle: 'Circle', Line: 'Line', Path: 'Path', Rect: 'Rect', Text: 'SvgText'}));
jest.mock('react-native-qrcode-svg', () => ({__esModule: true, default: 'QRCode'}));
const host = (name: string) => () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement(name, p, p.children as never)};
};
jest.mock('../../src/components/Btn', () => host('Btn')());
jest.mock('../../src/components/Chip', () => host('Chip')());
jest.mock('../../src/components/Focusable', () => host('Focusable')());
jest.mock('../../src/components/Icon', () => host('Icon')());
jest.mock('../../src/components/Sheet', () => host('Sheet')());
jest.mock('../../src/components/States', () => {
  const R = jest.requireActual('react');
  return {ErrorState: (p: Record<string, unknown>) => R.createElement('ErrorState', p)};
});
jest.mock('../../src/api', () => ({
  artPath: () => null,
  artPx: () => 480,
  getBaseUrl: () => 'https://nufurora.com',
  imgSrc: (p: string | null) => (p ? {uri: p} : null),
}));
jest.mock('../../src/useRouteShown', () => ({useRouteShown: () => {}}));
jest.mock('../../src/focus', () => ({useFocusFallback: () => {}}));
jest.mock('../../src/theme', () => ({
  __esModule: true,
  useTvMetrics: () => ({width: 960, height: 540, safeBottom: 27}),
  default: {
    colors: {bg: '#000', bgRaised: '#111', text: '#fff', textDim: '#999', textFaint: '#666', accent: '#88f', white: '#fff', surface: '#111', surfaceHover: '#222', line: '#333', star: '#fc0'},
    fontSize: {title: 24, body: 15, small: 13, row: 18},
    radius: {s: 8, m: 12, l: 18, pill: 999},
    spacing: {xs: 4, sm: 8, md: 14, lg: 20, xl: 32, pageX: 48, pageY: 27},
  },
}));

type Fn = jest.Mock;
const mockGroup: Record<string, Fn> = {
  options: jest.fn(),
  tutorialSeen: jest.fn(),
  create: jest.fn(),
  join: jest.fn(),
  settings: jest.fn(),
  role: jest.fn(),
  start: jest.fn(),
  vote: jest.fn(),
  search: jest.fn(),
  add: jest.fn(),
  finish: jest.fn(),
  extend: jest.fn(),
  pick: jest.fn(),
  again: jest.fn(),
  choose: jest.fn(),
  leave: jest.fn(),
  end: jest.fn(),
};
// the live follow, held by the test: `live.push(s)` is the server saying something changed
const live: {code: string | null; push: (s: unknown) => void; lost: (w: {status: number; message: string}) => void; stopped: number} = {
  code: null,
  push: () => {},
  lost: () => {},
  stopped: 0,
};
jest.mock('../../src/groupPickApi', () => ({
  get groupApi() {
    return mockGroup;
  },
  followGroup: (code: string, onSession: (s: unknown) => void, onLost: (w: {status: number; message: string}) => void) => {
    let rev = -1;
    const take = (s: {rev: number}) => {
      if (s.rev < rev) return;
      rev = s.rev;
      onSession(s);
    };
    live.code = code;
    live.push = take as never;
    live.lost = onLost;
    return {stop: () => live.stopped++, refresh: () => {}, take, receivedAt: () => Date.now()};
  },
  playTarget: (c: {id?: string; imdbId?: string; type: string}) =>
    c.id ? {kind: 'library', id: c.id, type: c.type} : c.imdbId ? {kind: 'discover', imdbId: c.imdbId, type: c.type} : null,
}));

import GroupPick from '../../src/screens/GroupPick';
import {TUTORIAL, WORDS} from '../../src/groupPick';
import type {GroupMember, GroupSession} from '../../src/groupPick';

const OPTIONS = {
  tutorialSeen: true,
  moods: [{id: 'any', label: 'Anything'}, {id: 'funny', label: 'Funny'}],
  lengths: [{id: 'any', label: 'Any length'}],
  kinds: [{id: 'movie', label: 'Films'}, {id: 'show', label: 'Series'}],
  limits: [120, 180, 300],
};
const member = (o: Partial<GroupMember>): GroupMember => ({
  id: 'x|d', profileId: 'x', name: 'X', role: 'voter', app: 'phone', host: false, away: false, answered: 0, done: false, ...o,
});
const TV = member({id: 'elia|tv', profileId: 'elia', name: 'Elia', role: 'screen', app: 'tv', host: true});
const DANA = member({id: 'dana|1', profileId: 'dana', name: 'Dana'});
const CARD_A = {key: 'a', title: 'Alpha', type: 'movie' as const, lib: true, id: 'lib-a', year: 2021, runtime: 108, genres: ['Comedy']};
const CARD_B = {key: 'b', title: 'Beta', type: 'show' as const, lib: false, imdbId: 'tt2'};
let rev = 1;
const session = (o: Partial<GroupSession> = {}): GroupSession => ({
  code: 'AB7K', rev: rev++, phase: 'lobby', round: 1, now: 1000000, createdAt: 0, expiresAt: 0,
  settings: {kind: 'movie', mood: 'funny', length: 'any', limitSec: 180},
  host: {id: 'elia|tv', name: 'Elia', profileId: 'elia'},
  you: {id: 'elia|tv', profileId: 'elia', role: 'screen', host: true},
  members: [TV], voters: 0, added: [], deck: [], mine: {}, deadline: null, limitSec: 180,
  ...o,
});
const swiping = (o: Partial<GroupSession> = {}) =>
  session({phase: 'swiping', members: [TV, {...DANA, answered: 1}], voters: 1, deck: [CARD_A, CARD_B], deadline: 1000000 + 150000, ...o});
const resultOf = (o: Partial<GroupSession> = {}) =>
  session({
    phase: 'result', members: [TV, DANA], voters: 1, deck: [CARD_A, CARD_B],
    result: {method: 'best', index: 0, at: 0, why: 'done', picks: [
      {key: 'a', why: '1 of 1 said yes', yes: 1, maybe: 0, no: 0, missing: 0, of: 1, everyone: true, card: CARD_A},
      {key: 'b', why: '1 maybe', yes: 0, maybe: 1, no: 0, missing: 0, of: 1, everyone: false, card: CARD_B},
    ]},
    ...o,
  });

const flush = () => act(async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
});
const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll(n => (n.type as unknown) === 'Text').map(n => [].concat(n.props.children).filter(c => typeof c === 'string').join(''));
const byUi = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll(n => ['Btn', 'Chip', 'Focusable'].includes(n.type as never) && n.props.uiId === id);
const one = (r: TestRenderer.ReactTestRenderer, id: string) => {
  const all = byUi(r, id);
  expect({id, count: all.length}).toEqual({id, count: 1});
  return all[0];
};
const press = (r: TestRenderer.ReactTestRenderer, id: string) => act(async () => one(r, id).props.onPress());
const sheet = (r: TestRenderer.ReactTestRenderer) => r.root.findAll(n => (n.type as unknown) === 'Sheet')[0];

const nav = {isFocused: () => true, replace: jest.fn(), goBack: jest.fn(), push: jest.fn()};
let r: TestRenderer.ReactTestRenderer;
const open = async (params?: {code?: string}) => {
  await act(async () => {
    r = TestRenderer.create(<GroupPick navigation={nav as never} route={{key: 'g', name: 'GroupPick', params} as never} />);
  });
  await flush();
};
const startSession = async (s = session()) => {
  mockGroup.create.mockResolvedValue({session: s});
  await press(r, 'group.start');
  await flush();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockBack.length = 0;
  live.stopped = 0;
  rev = 1;
  mockGroup.options.mockResolvedValue(OPTIONS);
  mockGroup.tutorialSeen.mockResolvedValue({tutorialSeen: true});
  mockGroup.vote.mockResolvedValue({ok: true, answered: 1, of: 2});
  mockGroup.leave.mockResolvedValue({ok: true});
  mockGroup.end.mockResolvedValue({ok: true});
});
afterEach(() => act(() => r?.unmount()));

test('the first time: the four-step explanation, then the start form (and it is remembered)', async () => {
  mockGroup.options.mockResolvedValue({...OPTIONS, tutorialSeen: false});
  await open();
  expect(texts(r)).toContain(TUTORIAL[0].title);
  expect(one(r, 'group.tutorial.next').props.hasTVPreferredFocus).toBe(true);
  for (let i = 1; i < TUTORIAL.length; i++) {
    await press(r, 'group.tutorial.next');
    expect(texts(r)).toContain(TUTORIAL[i].title);
  }
  expect(one(r, 'group.tutorial.next').props.label).toBe(WORDS.letsGo);
  expect(byUi(r, 'group.tutorial.skip')).toHaveLength(0); // the last step: only Let's go
  await press(r, 'group.tutorial.next');
  expect(mockGroup.tutorialSeen).toHaveBeenCalledWith(true);
  expect(one(r, 'group.start').props.hasTVPreferredFocus).toBe(true);
  // How it works opens it again; BACK closes it
  await press(r, 'group.howto');
  expect(texts(r)).toContain(TUTORIAL[0].title);
  await act(async () => {
    expect(mockBack[mockBack.length - 1]()).toBe(true);
  });
  expect(byUi(r, 'group.start')).toHaveLength(1);
  expect(mockGroup.tutorialSeen).toHaveBeenCalledTimes(1);
});

test('Skip ends the explanation too', async () => {
  mockGroup.options.mockResolvedValue({...OPTIONS, tutorialSeen: false});
  await open();
  await press(r, 'group.tutorial.skip');
  expect(mockGroup.tutorialSeen).toHaveBeenCalled();
  expect(byUi(r, 'group.start')).toHaveLength(1);
});

test('Start: the choices go along; the code, the QR code and the address show; Start swiping waits for someone', async () => {
  await open();
  expect(texts(r)).not.toContain(TUTORIAL[0].title); // seen before: straight to the form
  // the choices are chips (Films / Series · moods · lengths · times)
  expect(byUi(r, 'group.option')).toHaveLength(2 + 2 + 1 + 3);
  const funny = byUi(r, 'group.option').find(c => c.props.label === 'Funny')!;
  await act(async () => funny.props.onPress());
  const five = byUi(r, 'group.option').find(c => c.props.label === '5 min')!;
  await act(async () => five.props.onPress());
  await startSession();
  expect(mockGroup.create).toHaveBeenCalledWith({kind: 'movie', mood: 'funny', length: 'any', limitSec: 300}, 'screen');
  expect(live.code).toBe('AB7K');
  expect(texts(r)).toEqual(expect.arrayContaining(['AB7K', WORDS.joinLine, 'nufurora.com', WORDS.waiting, WORDS.needSomeone]));
  expect(r.root.find(n => (n.type as unknown) === 'QRCode').props.value).toBe('https://nufurora.com/#/group/AB7K');
  const deal = one(r, 'group.deal');
  expect(deal.props.hasTVPreferredFocus).toBe(true);
  expect(deal.props.dim).toBe(true);
  await press(r, 'group.deal');
  expect(mockGroup.start).not.toHaveBeenCalled();
  expect(texts(r)).toContain(WORDS.needSomeone);
  // Dana joins on her phone
  await act(async () => live.push(session({members: [TV, DANA], voters: 1})));
  expect(texts(r)).toContain('Dana is in');
  expect(one(r, 'group.deal').props.dim).toBe(false);
  mockGroup.start.mockResolvedValue({session: swiping()});
  await press(r, 'group.deal');
  await flush();
  expect(mockGroup.start).toHaveBeenCalledWith('AB7K');
  // the TV is the screen: the others' progress, the clock, the host's buttons
  expect(texts(r)).toEqual(expect.arrayContaining(['0 of 1 done', '2:30 left', '1 of 2']));
  expect(one(r, 'group.extend').props.hasTVPreferredFocus).toBe(true);
  mockGroup.finish.mockResolvedValue({session: resultOf()});
  await press(r, 'group.finish');
  await flush();
  expect(mockGroup.finish).toHaveBeenCalledWith('AB7K');
  expect(texts(r)).toEqual(expect.arrayContaining(['Alpha', '1 of 1 said yes']));
});

test('the pick: Play chooses it and starts the library film here — once', async () => {
  await open();
  await startSession(resultOf());
  const play = one(r, 'group.play');
  expect(play.props.hasTVPreferredFocus).toBe(true);
  expect(play.props.label).toBe(WORDS.play);
  const chosen = () => session({phase: 'chosen', members: [TV, DANA], chosen: {key: 'a', by: 'Elia', card: CARD_A}});
  mockGroup.choose.mockResolvedValue({session: chosen()});
  await press(r, 'group.play');
  await flush();
  expect(mockGroup.choose).toHaveBeenCalledWith('AB7K', 'a');
  expect(nav.replace).toHaveBeenCalledTimes(1);
  expect(nav.replace).toHaveBeenCalledWith('Player', {id: 'lib-a', title: 'Alpha'});
  await act(async () => live.push(chosen())); // the same choice, again over the socket
  expect(nav.replace).toHaveBeenCalledTimes(1);
});

test('Something else, then back to the first; Swipe another round for the host', async () => {
  await open();
  await startSession(resultOf());
  expect(one(r, 'group.next').props.label).toBe(WORDS.somethingElse);
  const second = resultOf();
  second.result!.index = 1;
  mockGroup.pick.mockResolvedValue({session: second});
  await press(r, 'group.next');
  await flush();
  expect(mockGroup.pick).toHaveBeenCalledWith('AB7K', 1);
  expect(texts(r)).toContain('Beta');
  expect(one(r, 'group.next').props.label).toBe(WORDS.firstPick);
  mockGroup.again.mockResolvedValue({session: swiping()});
  await press(r, 'group.again');
  await flush();
  expect(mockGroup.again).toHaveBeenCalledWith('AB7K');
});

test('a phone pressed Play: the TV, the room\'s screen, opens it by itself (a catalogue series → its page)', async () => {
  await open();
  await startSession(resultOf());
  await act(async () => live.push(session({phase: 'chosen', members: [TV, DANA], chosen: {key: 'b', by: 'Dana', card: CARD_B}})));
  expect(nav.replace).toHaveBeenCalledWith('Detail', {item: expect.objectContaining({id: 'tt2', imdbId: 'tt2', type: 'show', source: 'stream'})});
});

test('no match: the line and another round', async () => {
  await open();
  await startSession(resultOf({result: {method: 'none', index: 0, at: 0, why: 'time', picks: []}}));
  expect(texts(r)).toEqual(expect.arrayContaining([WORDS.noMatch, WORDS.noMatchLine]));
  expect(one(r, 'group.again').props.hasTVPreferredFocus).toBe(true);
});

test('the TV swipes too: one card at a time, Yes moves on at once, Undo brings it back', async () => {
  await open();
  await startSession(session({members: [TV, DANA], voters: 1}));
  const asVoter = (o: Partial<GroupSession> = {}) =>
    swiping({you: {id: 'elia|tv', profileId: 'elia', role: 'voter', host: true}, members: [{...TV, role: 'voter'}, DANA], voters: 2, ...o});
  mockGroup.role.mockResolvedValue({session: session({you: {id: 'elia|tv', profileId: 'elia', role: 'voter', host: true}, members: [{...TV, role: 'voter'}, DANA], voters: 2})});
  await press(r, 'group.screen');
  await flush();
  expect(mockGroup.role).toHaveBeenCalledWith('AB7K', 'voter');
  expect(one(r, 'group.screen').props.label).toBe(WORDS.justShow);
  await act(async () => live.push(asVoter()));
  expect(texts(r)).toEqual(expect.arrayContaining(['Alpha', '2021 · 1 h 48 · Comedy']));
  expect(one(r, 'group.yes').props.hasTVPreferredFocus).toBe(true);
  await press(r, 'group.yes');
  await flush();
  expect(mockGroup.vote).toHaveBeenCalledWith('AB7K', 'a', 'yes');
  expect(texts(r)).toContain('Beta'); // before the server says it back
  await press(r, 'group.undo');
  await flush();
  expect(mockGroup.vote).toHaveBeenLastCalledWith('AB7K', 'a', null);
  expect(texts(r)).toContain('Alpha');
  await press(r, 'group.no');
  await press(r, 'group.maybe');
  await flush();
  expect(mockGroup.vote).toHaveBeenLastCalledWith('AB7K', 'b', 'maybe');
  expect(texts(r)).toContain(WORDS.doneWaiting);
});

test('BACK in a session asks first: Stay, Leave, End for everyone', async () => {
  await open();
  await startSession();
  await act(async () => {
    expect(mockBack[mockBack.length - 1]()).toBe(true);
  });
  expect(sheet(r).props.title).toBe(WORDS.leaveAsk);
  // while the sheet is up its own Back is the one that counts
  expect(mockBack[0]()).toBe(false);
  await press(r, 'group.end');
  await flush();
  expect(mockGroup.end).toHaveBeenCalledWith('AB7K');
  expect(nav.goBack).toHaveBeenCalled();
  expect(live.stopped).toBeGreaterThan(0);
});

test('a session the server no longer knows: ended, with its words', async () => {
  await open();
  await startSession();
  await act(async () => live.lost({status: 404, message: 'That code has expired or is not right'}));
  expect(texts(r)).toEqual(expect.arrayContaining([WORDS.ended, 'That code has expired or is not right']));
  await press(r, 'group.leave');
  expect(nav.goBack).toHaveBeenCalled();
  // BACK there just leaves
  expect(mockBack[mockBack.length - 1]()).toBe(false);
});

test('Join with a code: tidied, checked, joined as the screen; the server says why not', async () => {
  await open();
  await press(r, 'group.join');
  const input = () => r.root.find(n => (n.type as unknown) === 'TextInput');
  await act(async () => input().props.onChangeText('ab-7'));
  expect(input().props.value).toBe('AB7');
  await act(async () => input().props.onSubmitEditing());
  expect(texts(r)).toContain(WORDS.codeWrong);
  expect(mockGroup.join).not.toHaveBeenCalled();
  mockGroup.join.mockRejectedValueOnce(Object.assign(new Error('No session with that code — check it against the screen'), {status: 404}));
  await act(async () => input().props.onChangeText('ab7x'));
  await act(async () => input().props.onSubmitEditing());
  await flush();
  expect(mockGroup.join).toHaveBeenCalledWith('AB7X', 'screen');
  expect(texts(r)).toContain('No session with that code — check it against the screen');
  mockGroup.join.mockResolvedValueOnce({session: session({code: 'AB7X', you: {id: 'elia|tv', profileId: 'elia', role: 'screen', host: false}, host: {id: 'dana|1', name: 'Dana', profileId: 'dana'}})});
  await act(async () => input().props.onSubmitEditing());
  await flush();
  expect(texts(r)).toEqual(expect.arrayContaining(['AB7X', WORDS.onlyHost]));
  expect(byUi(r, 'group.deal')).toHaveLength(0); // only the person who started it deals
});

test('opened with a code: joins it straight away', async () => {
  mockGroup.join.mockResolvedValue({session: session({code: 'QQ22'})});
  await open({code: 'qq22'});
  expect(mockGroup.join).toHaveBeenCalledWith('QQ22', 'screen');
  expect(texts(r)).toContain('QQ22');
});

test('Add a title: search, the On Aurora badge, In the deck, Added', async () => {
  await open();
  await startSession();
  await press(r, 'group.add');
  mockGroup.search.mockResolvedValue({results: [
    {key: 'lib1', id: 'lib1', type: 'movie', title: 'Gamma', year: 2019, lib: true, inDeck: false},
    {key: 'tt9', imdbId: 'tt9', type: 'movie', title: 'Delta', lib: false, inDeck: true},
  ]});
  mockGroup.add.mockResolvedValue({ok: true, key: 'lib1'});
  jest.useFakeTimers();
  try {
    const input = r.root.find(n => (n.type as unknown) === 'TextInput');
    await act(async () => input.props.onChangeText('ga'));
    await act(async () => {
      jest.advanceTimersByTime(450);
    });
  } finally {
    jest.useRealTimers();
  }
  await flush();
  expect(mockGroup.search).toHaveBeenCalledWith('AB7K', 'ga');
  expect(texts(r)).toEqual(expect.arrayContaining([WORDS.libBadge, WORDS.inDeck]));
  const rows = r.root.findAll(n => (n.type as unknown) === 'Focusable' && n.props.accessibilityLabel === 'Gamma');
  await act(async () => rows[0].props.onPress());
  await flush();
  expect(mockGroup.add).toHaveBeenCalledWith('AB7K', expect.objectContaining({id: 'lib1', title: 'Gamma', type: 'movie'}));
  expect(texts(r)).toContain(WORDS.added);
});

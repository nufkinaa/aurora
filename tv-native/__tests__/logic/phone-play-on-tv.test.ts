// The phone app as the SENDER of "Play on TV" / "Continue on this phone"
// (src/phone/remote/playOnTv.ts): one TV is confirmed in a single press, several
// are picked from, a TV on its wall says so; once the TV has it the player
// pauses and the remote for that TV opens; Continue pauses the TV and opens
// this phone's player at the TV's second, with its subtitles and audio.
const mockSheets: {title: string; sub?: string; items: {label: string; tag?: string; onPress: () => void}[]}[] = [];
const mockToasts: string[] = [];
const mockPushed: {name: string; params?: unknown}[] = [];
const mockDispatched: unknown[] = [];
const mockCommands: {deviceId: string; cmd: string; args: Record<string, unknown>}[] = [];
let mockAnswer: Record<string, unknown> = {ok: true, status: 'playing'};

jest.mock('../../src/overlay', () => ({openActions: (o: (typeof mockSheets)[number]) => mockSheets.push(o)}));
jest.mock('../../src/toast', () => ({showToast: (t: string) => mockToasts.push(t)}));
jest.mock('../../src/rootNav', () => ({navRef: {isReady: () => true, dispatch: (a: unknown) => mockDispatched.push(a)}}));
jest.mock('../../src/phone/nav', () => ({pushPhone: (name: string, params?: unknown) => mockPushed.push({name, params})}));
jest.mock('@react-navigation/native', () => ({StackActions: {push: (n: string, p: unknown) => ({type: 'push', n, p})}}));
jest.mock('../../src/phone/remote/controller', () => ({
  wireItem: (it: unknown) => it,
  command: async (deviceId: string, cmd: string, args: Record<string, unknown> = {}) => {
    mockCommands.push({deviceId, cmd, args});
    return {ok: true, error: null, message: null};
  },
  playOn: async (d: {deviceId: string}, item: unknown, o: Record<string, unknown>) => {
    mockCommands.push({deviceId: d.deviceId, cmd: 'play_item', args: {item, ...o}});
    return mockAnswer;
  },
}));

import {continueHere, fromNow, livePosition, sendToTv, tvTag} from '../../src/phone/remote/playOnTv';
import type {Device} from '../../src/phone/remote/controller';
import type {NowState} from '../../src/remote/protocol';

const LIVING: Device = {deviceId: 'tv-living-0000000', name: 'Living room TV', kind: 'tv', mine: true};
const BEDROOM: Device = {deviceId: 'tv-bed-000000000', name: 'Bedroom TV', kind: 'tv', wall: true, mine: false, profile: null};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
beforeEach(() => {
  mockSheets.length = 0;
  mockToasts.length = 0;
  mockPushed.length = 0;
  mockDispatched.length = 0;
  mockCommands.length = 0;
  mockAnswer = {ok: true, status: 'playing'};
});

const NOW: NowState = {
  id: 'lib-ep3', title: 'Machines', showTitle: 'Silo', epTitle: 'Machines', season: 1, episode: 3, poster: '/img/p.jpg', backdrop: null,
  duration: 3000, position: 1200, paused: false, buffering: false, canSeek: true, hasNext: true, nextLabel: 'S1 E4',
  subs: [{id: 'k-he', label: 'Hebrew', lang: 'he'}], sub: 'k-he', audios: [{id: '1', label: 'English', lang: 'en'}], audio: '1', subDelay: 0,
};

test('one TV on: a single press brings a confirmation naming the title and the TV', async () => {
  const after = jest.fn();
  sendToTv([LIVING], {id: 'lib-arrival', title: 'Arrival'}, {position: 1834, after});
  expect(mockSheets).toHaveLength(1);
  expect(mockSheets[0].title).toBe('Play “Arrival” on Living room TV?');
  expect(mockSheets[0].items.map(i => i.label)).toEqual(['Living room TV']);
  mockSheets[0].items[0].onPress();
  await flush();
  expect(mockCommands[0]).toMatchObject({deviceId: LIVING.deviceId, cmd: 'play_item', args: {position: 1834}});
  expect(after).toHaveBeenCalledTimes(1);
  expect(mockPushed).toEqual([{name: 'Remote', params: {deviceId: LIVING.deviceId}}]);
});

test('several TVs: "Play on…", the title under it, a TV on its wall says so', () => {
  sendToTv([LIVING, BEDROOM], {id: 'x', title: 'Pilot', showTitle: 'Silo', season: 1, episode: 1});
  expect(mockSheets[0].title).toBe('Play on…');
  expect(mockSheets[0].sub).toBe('Silo · S1 E1');
  expect(mockSheets[0].items.map(i => i.tag)).toEqual([undefined, 'On “Who\'s watching?”']);
  expect(tvTag({...LIVING, mine: false, profile: {id: 'pb', name: 'Dana'}})).toBe('Dana');
});

test('the TV refused or did not answer: this player keeps playing, no remote', async () => {
  mockAnswer = {ok: false, error: 'timeout'};
  const after = jest.fn();
  sendToTv([LIVING], {id: 'x', title: 'Arrival'}, {after});
  mockSheets[0].items[0].onPress();
  await flush();
  expect(after).not.toHaveBeenCalled();
  expect(mockPushed).toHaveLength(0);
});

test('the TV asks for the PIN: still the remote (the TV comes into the profile there), and the player pauses', async () => {
  mockAnswer = {ok: true, status: 'needs-pin'};
  const after = jest.fn();
  sendToTv([BEDROOM], {id: 'x', title: 'Arrival'}, {after});
  mockSheets[0].items[0].onPress();
  await flush();
  expect(after).toHaveBeenCalled();
  expect(mockPushed[0].params).toEqual({deviceId: BEDROOM.deviceId});
});

test("what the phone's player plays, as it is sent: the episode, its subtitles and audio by language", () => {
  const f = fromNow(NOW);
  expect(f.item).toMatchObject({id: 'lib-ep3', title: 'Machines', showTitle: 'Silo', season: 1, episode: 3});
  expect([f.position, f.subLang, f.audioLang]).toEqual([1200, 'he', 'en']);
  expect(fromNow({...NOW, sub: null}).subLang).toBe('off');
});

test("Continue on this phone: the TV is paused, this phone's player opens at the TV's second (moved on since the report)", async () => {
  const heardAt = Date.now() - 3000;
  expect(Math.round(livePosition(NOW, heardAt))).toBe(1203);
  expect(livePosition({...NOW, paused: true}, heardAt)).toBe(1200);
  expect(await continueHere({...LIVING, heardAt}, NOW)).toBe(true);
  expect(mockCommands.map(c => c.cmd)).toEqual(['pause']);
  const push = mockDispatched[0] as {n: string; p: {id: string; title: string; remote: {position: number; subLang: string; audioLang: string}}};
  expect(push.n).toBe('Player');
  expect(push.p.id).toBe('lib-ep3');
  expect(push.p.title).toBe('Silo · S1 E3');
  expect(Math.round(push.p.remote.position)).toBe(1203);
  expect([push.p.remote.subLang, push.p.remote.audioLang]).toEqual(['he', 'en']);
  expect(mockToasts).toEqual(['Paused on Living room TV — carrying on here']);
});

test('Continue with nothing playing there: says so, opens nothing; a paused TV is not paused again', async () => {
  expect(await continueHere(LIVING, null)).toBe(false);
  expect(mockToasts).toEqual(['Nothing is playing on Living room TV']);
  await continueHere(LIVING, {...NOW, paused: true});
  expect(mockCommands).toHaveLength(0);
  expect(mockDispatched).toHaveLength(1);
});

// The phone app's remote screen (src/phone/screens/Remote.tsx) — every piece the website's remote
// has: the device picker (remembered, else the one playing), the banner, the artwork and the
// episode, the scrub bar's one seek, ±10 / ±30, play / pause at once, Subtitles with their timing,
// Audio, Next, Stop, Continue Watching when nothing plays, the touchpad (and "can't be steered"),
// the D-pad buttons, Back / Play/Pause / Home, the dock's views and volume with its level, More →
// rename / how it works / Sign in a TV, and no device on.
import React from 'react';
import TestRenderer, {act, ReactTestInstance} from 'react-test-renderer';

jest.mock('react-native', () => ({
  ...jest.requireActual('./rn-stub.js'),
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  AccessibilityInfo: {isReduceMotionEnabled: () => Promise.resolve(false)},
  useWindowDimensions: () => mockDims,
}));
let mockDims = {width: 411, height: 915};
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 24, bottom: 16, left: 0, right: 0})}));
const host = (name: string) => () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement(name, p, p.children as never)};
};
jest.mock('../../src/phone/ui/Tap', () => host('Tap')());
jest.mock('../../src/phone/remote/RemoteIcon', () => host('RemoteIcon')());
jest.mock('../../src/phone/remote/RemoteBackdrop', () => host('RemoteBackdrop')());
jest.mock('../../src/phone/remote/Scrub', () => host('Scrub')());
jest.mock('../../src/phone/remote/Touchpad', () => host('Touchpad')());
jest.mock('../../src/phone/ui/Sheet', () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: {visible: boolean; children: React.ReactNode}) => (p.visible ? R.createElement('Sheet', p, p.children) : null)};
});
jest.mock('../../src/phone/ui/Buttons', () => {
  const R = jest.requireActual('react');
  return {PrimaryButton: (p: Record<string, unknown>) => R.createElement('PrimaryButton', p)};
});
jest.mock('@react-navigation/native', () => ({useRoute: () => ({params: mockParams}), StackActions: {pop: () => ({type: 'pop'})}}));
let mockParams: {deviceId?: string} | undefined;
const mockHome = jest.fn();
jest.mock('../../src/api', () => ({api: {home: (id: string) => mockHome(id)}, artSrc: (p: string) => ({src: {uri: p}, sized: false})}));
jest.mock('../../src/AppContext', () => ({useApp: () => ({profileId: 'p1'})}));
jest.mock('../../src/navSection', () => ({useMe: () => ({name: 'Maya'})}));
jest.mock('../../src/rootNav', () => ({navRef: {isReady: () => true, canGoBack: () => true, dispatch: jest.fn()}}));
jest.mock('../../src/realtime', () => ({isOpen: () => mockOnline}));
let mockOnline = true;
const mockToast = jest.fn();
jest.mock('../../src/toast', () => ({showToast: (...a: unknown[]) => mockToast(...a)}));
const mockHit = jest.fn();
jest.mock('../../src/telemetry', () => ({uiHit: (...a: unknown[]) => mockHit(...a)}));
jest.mock('../../src/phone/native', () => ({phoneNative: {haptic: () => {}}}));
const mockPush = jest.fn();
jest.mock('../../src/phone/nav', () => ({pushPhone: (...a: unknown[]) => mockPush(...a)}));
const mockHere = jest.fn();
jest.mock('../../src/phone/remote/playOnTv', () => ({continueHere: (...a: unknown[]) => mockHere(...a)}));
// the controller: a list and a state the test sets, every command recorded and answered
let mockList: Record<string, any>[] = [];
const mockCmd = jest.fn();
const mockPlayOn = jest.fn();
let mockAck: (cmd: string) => Promise<Record<string, unknown>> = () => Promise.resolve({ok: true});
jest.mock('../../src/phone/remote/controller', () => ({
  useDevices: () => mockList,
  getDevices: () => mockList,
  useDeviceState: (id: string | null) => (id ? mockList.find(d => d.deviceId === id)?.state || null : null),
  command: (id: string, cmd: string, args: unknown) => {
    mockCmd(id, cmd, args);
    return mockAck(cmd);
  },
  playOn: (...a: unknown[]) => {
    mockPlayOn(...a);
    return Promise.resolve({ok: true});
  },
  devicesHeard: () => true,
  householdOn: () => false,
}));
import Remote from '../../src/phone/screens/Remote';

const NOW = {
  id: 'e1', title: 'Episode 1', showTitle: 'Test Show', epTitle: 'Episode 1', season: 1, episode: 1, poster: '/img/p.png', backdrop: '/img/b.png',
  duration: 2700, position: 754, paused: false, buffering: false, canSeek: true, hasNext: true, nextLabel: 'S1 E2',
  subs: [{id: 's0', label: 'English', lang: 'en'}, {id: 's1', label: 'Hebrew', lang: 'he'}], sub: 's0', audios: [{id: '0', label: 'English', lang: 'en'}, {id: '1', label: 'Commentary', lang: 'en'}], audio: '0', subDelay: 0,
};
const VOL = {supported: true, level: 0.5, muted: false, scope: 'system'};
const dev = (id: string, o: Record<string, unknown> = {}) => ({deviceId: id, name: id === 'tv1' ? 'Living room TV' : 'Bedroom TV', kind: 'tv', mine: true, caps: {navigate: true, volume: true, playItem: true, tracks: true}, heardAt: Date.now(), state: {screen: 'home', appState: 'active', now: null, volume: VOL}, ...o});

const flush = () => act(async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise<void>(r => setTimeout(r, 0));
});
const texts = (t: TestRenderer.ReactTestRenderer) => t.root.findAll(n => (n.type as unknown) === 'Text').map(n => [].concat(n.props.children).join(''));
const byLabel = (t: TestRenderer.ReactTestRenderer, label: string) => t.root.find(n => (n.type as unknown) === 'Tap' && n.props.accessibilityLabel === label);
const press = async (n: ReactTestInstance) => {
  await act(async () => {
    n.props.onPress();
  });
  await flush();
};
const shown: TestRenderer.ReactTestRenderer[] = [];
async function render() {
  let t: TestRenderer.ReactTestRenderer;
  await act(async () => {
    t = TestRenderer.create(<Remote />);
  });
  await flush();
  shown.push(t!);
  return t!;
}
afterEach(() => {
  // (the clock's ticker and the 2 s line check stop with the screen)
  for (const t of shown.splice(0)) {
    try {
      act(() => t.unmount());
    } catch {}
  }
});

beforeEach(() => {
  jest.useRealTimers();
  ((jest.requireActual('@react-native-async-storage/async-storage') as {__store: Map<string, string>}).__store).clear();
  mockList = [];
  mockParams = undefined;
  mockOnline = true;
  mockDims = {width: 411, height: 915};
  mockAck = () => Promise.resolve({ok: true});
  [mockCmd, mockPlayOn, mockToast, mockPush, mockHere, mockHit, mockHome].forEach(f => f.mockReset());
  mockHome.mockResolvedValue({hero: [], rows: []});
});

test('what plays: the device, the art, "Playing on …", the episode, the clock, the transport and the chips', async () => {
  mockList = [dev('tv1', {state: {screen: 'player', appState: 'active', now: NOW, volume: VOL}})];
  const t = await render();
  const all = texts(t);
  expect(all).toContain('Living room TV');
  expect(all).toContain('PLAYING ON LIVING ROOM TV');
  expect(all).toContain('Test Show');
  expect(all).toContain('S1 E1 · Episode 1');
  for (const l of ['Back 30 seconds', 'Back 10 seconds', 'Pause', 'Forward 10 seconds', 'Forward 30 seconds', 'Subtitles', 'Audio', 'Next episode', 'Stop', 'Continue on this phone', 'Close the remote', 'More']) expect(byLabel(t, l)).toBeTruthy();
  expect(t.root.findByType('RemoteBackdrop' as never).props.pic).toBe('/img/b.png');
  const scrub = t.root.findByType('Scrub' as never);
  expect(scrub.props.duration).toBe(2700);
  expect(scrub.props.position).toBeGreaterThanOrEqual(754);
  // the dock: the two views and the volume, its level drawn
  expect(t.root.findAll(n => (n.type as unknown) === 'Tap' && n.props.accessibilityRole === 'tab').map(n => n.props.accessibilityLabel)).toEqual(['Now playing', 'Touchpad']);
  expect(byLabel(t, 'Volume up')).toBeTruthy();
  expect(byLabel(t, 'Mute')).toBeTruthy();
  // the tab bar's pairing lives in More, and the empty state
  expect(mockHit).not.toHaveBeenCalled();
});

test('the transport: ±30 / ±10, play / pause answering at once, a seek from the scrub bar, Next, Stop, Continue here', async () => {
  mockList = [dev('tv1', {state: {screen: 'player', appState: 'active', now: NOW, volume: VOL}})];
  let release: (v: Record<string, unknown>) => void = () => {};
  const t = await render();
  await press(byLabel(t, 'Back 30 seconds'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'skip', {by: -30});
  await press(byLabel(t, 'Forward 10 seconds'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'skip', {by: 10});
  // the answer is slow: the button turns at once all the same
  mockAck = () => new Promise(r => (release = r));
  act(() => {
    byLabel(t, 'Pause').props.onPress();
  });
  expect(byLabel(t, 'Play')).toBeTruthy();
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'toggle', {});
  await act(async () => release({ok: true}));
  mockAck = () => Promise.resolve({ok: true});
  await act(async () => {
    t.root.findByType('Scrub' as never).props.onSeek(1200.5);
  });
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'seek', {to: 1200.5});
  expect(mockHit).toHaveBeenCalledWith('remote.seek', 'touch');
  await press(byLabel(t, 'Next episode'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'next', {});
  expect(mockToast).toHaveBeenLastCalledWith('Next episode', '📺');
  await press(byLabel(t, 'Stop'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'stop', {});
  await press(byLabel(t, 'Continue on this phone'));
  expect(mockHere).toHaveBeenCalled();
  // a refusal says why
  mockAck = () => Promise.resolve({ok: false, error: 'cannot-seek', message: "This can't be skipped"});
  await press(byLabel(t, 'Back 10 seconds'));
  expect(mockToast).toHaveBeenLastCalledWith("This can't be skipped", '⚠️');
});

test('Subtitles: the tracks with the one on ticked, and its timing −0.5 / +0.5 / Reset; Audio', async () => {
  mockList = [dev('tv1', {state: {screen: 'player', appState: 'active', now: NOW, volume: VOL}})];
  const t = await render();
  await press(byLabel(t, 'Subtitles'));
  const sheet = t.root.findByType('Sheet' as never);
  const rows = sheet.findAll(n => (n.type as unknown) === 'Tap' && n.props.accessibilityRole === 'menuitem');
  expect(rows.map(r => r.props.accessibilityLabel)).toEqual(['Off', 'English, EN', 'Hebrew, HE']);
  expect(rows[1].props.accessibilityState).toEqual({checked: true});
  expect(texts(t)).toContain('SUBTITLES');
  expect(texts(t)).toContain('0.0 s');
  await press(byLabel(t, 'Subtitles later'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'sub_delay', {by: 0.5});
  expect(texts(t)).toContain('+0.5 s');
  await press(byLabel(t, 'Reset the timing'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'sub_delay', {value: 0});
  await press(rows[2]);
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'sub', {id: 's1'});
  expect(mockToast).toHaveBeenLastCalledWith('Subtitles on', '📺');
  await press(byLabel(t, 'Audio'));
  const a = t.root.findByType('Sheet' as never).findAll(n => (n.type as unknown) === 'Tap' && n.props.accessibilityRole === 'menuitem');
  await press(a[1]);
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'audio', {id: '1'});
});

test('the pad: the touchpad presses, the D-pad buttons, Back / Play-Pause / Home; a device that cannot be steered', async () => {
  mockList = [dev('tv1')];
  const t = await render();
  await press(t.root.find(n => (n.type as unknown) === 'Tap' && n.props.accessibilityLabel === 'Touchpad'));
  const pad = t.root.findByType('Touchpad' as never);
  expect(pad.props.steerable).toBe(true);
  await act(async () => pad.props.onPress('left'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'key', {key: 'left'});
  await act(async () => pad.props.onPress('ok'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'key', {key: 'ok'});
  expect(mockHit).toHaveBeenCalledWith('remote.dpad', 'touch');
  await press(byLabel(t, 'Back'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'key', {key: 'back'});
  await press(byLabel(t, 'Home'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'key', {key: 'home'});
  await press(byLabel(t, 'Play or pause'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'toggle', {});
  // Buttons: the round D-pad
  await press(byLabel(t, 'Buttons'));
  await press(byLabel(t, 'Up'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'key', {key: 'up'});
  await press(byLabel(t, 'OK'));
  expect(mockCmd).toHaveBeenLastCalledWith('tv1', 'key', {key: 'ok'});
  // both remembered for next time
  const store = (jest.requireActual('@react-native-async-storage/async-storage') as {__store: Map<string, string>}).__store;
  expect(store.get('aurora.phone.remote.view')).toBe('pad');
  expect(store.get('aurora.phone.remote.pad')).toBe('buttons');
  t.unmount();
  store.set('aurora.phone.remote.pad', 'touch');
  mockList = [dev('tv1', {caps: {navigate: false, volume: false}})];
  const u = await render();
  // a device that cannot be steered: the pad says so (Touchpad.tsx), and no volume in the dock
  expect(u.root.findByType('Touchpad' as never).props.steerable).toBe(false);
  expect(u.root.findAll(n => (n.type as unknown) === 'Tap' && n.props.accessibilityLabel === 'Volume up')).toHaveLength(0);
});

test('nothing playing: Continue Watching, and a tap plays it on the TV from where it was', async () => {
  mockList = [dev('tv1')];
  mockHome.mockResolvedValue({hero: [], rows: [{id: 'continue', title: 'Continue Watching', items: [{id: 'f1', title: 'Arrival', backdrop: '/img/a.png', progress: {position: 90, duration: 600}}]}]});
  const t = await render();
  expect(texts(t)).toContain('Nothing playing on Living room TV');
  expect(texts(t)).toContain('On Home');
  expect(texts(t)).toContain('CONTINUE WATCHING');
  await press(byLabel(t, 'Play Arrival on the TV'));
  expect(mockPlayOn).toHaveBeenCalledWith(expect.objectContaining({deviceId: 'tv1'}), expect.objectContaining({id: 'f1'}), {position: 90});
});

test('the device picker: remembered, else the one playing; the light; the banner; rename and how it works', async () => {
  mockList = [dev('tv1'), dev('tv2', {state: {screen: 'player', appState: 'active', now: NOW, volume: VOL}})];
  let t = await render();
  expect(texts(t)).toContain('Bedroom TV'); // the one playing
  t.unmount();
  (jest.requireActual('@react-native-async-storage/async-storage') as {__store: Map<string, string>}).__store.set('aurora.phone.remote.last', 'tv1');
  t = await render();
  expect(texts(t)).toContain('Living room TV'); // the last one used
  await press(byLabel(t, 'Device: Living room TV. Choose another'));
  const rows = t.root.findByType('Sheet' as never).findAll(n => (n.type as unknown) === 'Tap' && n.props.accessibilityRole === 'menuitem');
  expect(rows.map(r => r.props.accessibilityLabel)).toEqual(['Living room TV, On Home', 'Bedroom TV, Playing · Test Show · S1 E1']);
  expect(texts(t)).toContain('YOUR DEVICES');
  await press(rows[1]);
  expect(texts(t)).toContain('Bedroom TV');
  // More: rename, how it works, Sign in a TV
  await press(byLabel(t, 'More'));
  const more = t.root.findByType('Sheet' as never).findAll(n => (n.type as unknown) === 'Tap' && n.props.accessibilityRole === 'menuitem');
  expect(more.map(r => r.props.accessibilityLabel)).toEqual(['Rename “Bedroom TV”', 'How it works, Your phone controls the devices signed in to your profile', 'Sign in a TV, Type or scan the code on a TV’s screen']);
  await press(more[0]);
  const input = t.root.findByType('TextInput' as never);
  await act(async () => input.props.onChangeText('Kids room'));
  await act(async () => t.root.findByType('PrimaryButton' as never).props.onPress());
  await flush();
  expect(mockCmd).toHaveBeenLastCalledWith('tv2', 'rename', {name: 'Kids room'});
  expect(mockToast).toHaveBeenLastCalledWith('Renamed to Kids room', '✏️');
  // the device's app in the background
  t.unmount();
  mockList = [dev('tv1', {state: {screen: 'home', appState: 'background', now: null, volume: VOL}})];
  t = await render();
  expect(texts(t)).toContain('Aurora is in the background on Living room TV — open it there');
});

test('no device on: how to get one, Sign in a TV; no server: the banner', async () => {
  mockOnline = false;
  const t = await render();
  expect(texts(t)).toContain('No TV is on');
  expect(texts(t)).toContain('Open Aurora on your TV — signed in as Maya — and it shows up here.');
  expect(texts(t)).toContain('Reconnecting to the server…');
  expect(texts(t)).toContain('Your TVs');
  await press(byLabel(t, 'Sign in a TV'));
  expect(mockPush).toHaveBeenCalledWith('PairTv', {code: null});
});

test('sideways: both halves at once, no view switch, the volume alone in the dock', async () => {
  mockDims = {width: 915, height: 411};
  mockList = [dev('tv1', {state: {screen: 'player', appState: 'active', now: NOW, volume: VOL}})];
  const t = await render();
  expect(t.root.findAll(n => (n.type as unknown) === 'Tap' && n.props.accessibilityRole === 'tab')).toHaveLength(0);
  expect(t.root.findByType('Touchpad' as never)).toBeTruthy();
  expect(byLabel(t, 'Pause')).toBeTruthy();
  expect(byLabel(t, 'Volume down')).toBeTruthy();
});

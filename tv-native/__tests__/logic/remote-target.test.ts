// This TV as a target of the phone remote, over a fake socket
// (src/remote/target.ts with the real realtime.ts): it announces itself on
// every open, answers every command once, reports on the cadence the server
// asks for, re-announces a new name, and leaves when the profile is left.
import {setBaseUrl, setToken} from '../../src/api';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 1;
  onopen: null | (() => void) = null;
  onmessage: null | ((e: {data: string}) => void) = null;
  onclose: null | (() => void) = null;
  onerror: null | (() => void) = null;
  sent: Record<string, unknown>[] = [];
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  say(msg: unknown) {
    this.onmessage?.({data: JSON.stringify(msg)});
  }
  of(type: string) {
    return this.sent.filter(m => m.type === type);
  }
}
(globalThis as unknown as {WebSocket: unknown}).WebSocket = FakeSocket;

jest.mock('../../src/rootNav', () => ({currentRouteName: () => 'Home', navRef: {isReady: () => false}}));
const mockPlayItem = jest.fn(async (_a: unknown) => ({ok: true, message: 'Opening'}));
jest.mock('../../src/remote/open', () => ({
  playItemOnTv: (a: unknown) => mockPlayItem(a),
  goHomeOnTv: () => true,
}));

import {NativeModules} from 'react-native';
import {connect, disconnect} from '../../src/realtime';
import {_targetSession, startTarget, stopTarget} from '../../src/remote/target';
import {_resetIdentity, setTvName} from '../../src/remote/identity';
import {registerRemotePlayer} from '../../src/remote/player';
import {clearProfileCaches} from '../../src/profileScope';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
// the fake timers' clock moves; promises in between are let through
const wait = async (ms: number) => {
  for (let t = 0; t < ms; t += 50) {
    jest.advanceTimersByTime(50);
    await flush();
  }
};

const nativeCalls: string[] = [];
const setNative = (on: boolean) => {
  (NativeModules as Record<string, unknown>).AuroraRemote = on
    ? {
        pressKey: async (k: string) => (nativeCalls.push(`press ${k}`), true),
        getVolume: async () => ({supported: true, level: 0.4, muted: false}),
        setVolume: async (l: number) => (nativeCalls.push(`set ${l}`), {supported: true, level: l, muted: false}),
        stepVolume: async (d: number) => (nativeCalls.push(`step ${d}`), {supported: true, level: 0.5, muted: false}),
        setMuted: async (m: boolean) => (nativeCalls.push(`mute ${m}`), {supported: true, level: 0.4, muted: m}),
        deviceName: async () => 'Mi TV',
        bringToFront: async () => true,
      }
    : undefined;
};

beforeEach(async () => {
  jest.useFakeTimers();
  FakeSocket.all = [];
  nativeCalls.length = 0;
  mockPlayItem.mockClear();
  const store = require('@react-native-async-storage/async-storage').__store as Map<string, string>;
  store.clear();
  _resetIdentity();
  setNative(true);
  setBaseUrl('http://tv.test');
  setToken('tok-1');
});
afterEach(() => {
  stopTarget();
  disconnect();
  jest.useRealTimers();
});

const started = async () => {
  connect();
  const sock = FakeSocket.all[0];
  sock.onopen?.();
  startTarget('p1');
  await wait(100);
  return sock;
};

test('announces itself once it knows what it is — kind tv, the profile, its token, its caps, its state', async () => {
  const sock = await started();
  const a = sock.of('device_announce');
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({
    type: 'device_announce',
    kind: 'tv',
    form: 'tv',
    name: 'Mi TV', // the system's own name for the TV
    profileId: 'p1',
    token: 'tok-1',
    caps: {navigate: true, volume: true, playItem: true, tracks: true},
    state: {screen: 'Home', appState: 'active', now: null, volume: {supported: true, level: 0.4, muted: false, scope: 'system'}},
  });
  expect(String(a[0].deviceId)).toMatch(/^[A-Za-z0-9_-]{8,48}$/);
});

test('again on every socket open, with the same id', async () => {
  const sock = await started();
  const id = sock.of('device_announce')[0].deviceId;
  sock.close(); // an outage: the socket comes back by itself
  jest.advanceTimersByTime(1500);
  const again = FakeSocket.all[1];
  again.onopen?.();
  await wait(50);
  expect(again.of('device_announce')).toHaveLength(1);
  expect(again.of('device_announce')[0].deviceId).toBe(id);
});

test('without the native module: no arrows, no volume — "Living room TV"', async () => {
  setNative(false);
  const sock = await started();
  expect(sock.of('device_announce')[0]).toMatchObject({name: 'Living room TV', caps: {navigate: false, volume: false, playItem: true, tracks: true}});
});

test('every command is answered once, with its ref', async () => {
  const sock = await started();
  sock.say({type: 'remote_command', ref: 'r1', cmd: 'pause', args: {}, from: {label: 'iPhone', profileName: 'Elia'}, first: true});
  sock.say({type: 'remote_command', ref: 'r2', cmd: 'key', args: {key: 'left'}, from: {label: 'iPhone', profileName: 'Elia'}, first: false});
  sock.say({type: 'remote_command', ref: 'r3', cmd: 'volume', args: {step: 1}, from: {label: 'iPhone'}, first: false});
  sock.say({type: 'remote_command', ref: 'r4', cmd: 'play_item', args: {item: {id: 'm1', title: 'Dune'}, position: 61}, from: {label: 'iPhone'}, first: false});
  await wait(400);
  const acks = sock.of('remote_ack');
  expect(acks).toHaveLength(4);
  expect(Object.fromEntries(acks.map(a => [a.ref, a]))).toEqual({
    r1: {type: 'remote_ack', ref: 'r1', ok: false, error: 'nothing-playing', message: 'Nothing is playing on the TV'},
    r2: {type: 'remote_ack', ref: 'r2', ok: true},
    r3: {type: 'remote_ack', ref: 'r3', ok: true},
    r4: {type: 'remote_ack', ref: 'r4', ok: true, message: 'Opening'},
  });
  expect(nativeCalls).toEqual(expect.arrayContaining(['press left', 'step 1']));
  expect(mockPlayItem).toHaveBeenCalledWith(expect.objectContaining({position: 61, item: expect.objectContaining({id: 'm1'})}));
});

test('with a player up: the state carries what plays, and a change is reported at once', async () => {
  const sock = await started();
  let paused = false;
  const now = () => ({
    id: 'm1', title: 'Dune', showTitle: null, epTitle: null, season: null, episode: null, poster: '/img/m1.jpg', backdrop: null,
    duration: 6000, position: 12, paused, buffering: false, canSeek: true, hasNext: false, nextLabel: null,
    subs: [], sub: null, audios: [], audio: null, subDelay: 0,
  });
  const off = registerRemotePlayer({
    now, play: () => (paused = false), pause: () => (paused = true), toggle: () => (paused = !paused), stop: () => {},
    position: () => 12, seekTo: () => {}, next: () => false, setSub: () => true, setAudio: () => true, subDelay: () => 0, setSubDelay: () => true,
  });
  await wait(100);
  const states = () => sock.of('device_state').map(m => m.state as {now: {paused: boolean} | null});
  expect(states().pop()?.now).toMatchObject({id: 'm1', paused: false});
  sock.say({type: 'remote_command', ref: 'r1', cmd: 'pause', args: {}, from: {label: 'iPhone'}, first: false});
  await wait(150);
  expect(sock.of('remote_ack')).toEqual([{type: 'remote_ack', ref: 'r1', ok: true}]);
  expect(states().pop()?.now).toMatchObject({paused: true});
  off();
  await wait(100);
  expect(states().pop()?.now).toBeNull();
});

test('remote_watch on: a state every second; off: quiet again', async () => {
  const sock = await started();
  const n0 = sock.of('device_state').length;
  sock.say({type: 'remote_watch', on: true});
  await wait(3000);
  const watched = sock.of('device_state').length - n0;
  expect(watched).toBeGreaterThanOrEqual(3);
  sock.say({type: 'remote_watch', on: false});
  const n1 = sock.of('device_state').length;
  await wait(3000);
  expect(sock.of('device_state').length - n1).toBe(0);
});

test('a new name is announced again', async () => {
  const sock = await started();
  await setTvName('Bedroom TV');
  await wait(50);
  const a = sock.of('device_announce');
  expect(a).toHaveLength(2);
  expect(a[1].name).toBe('Bedroom TV');
  // and `rename` from the phone does the same
  sock.say({type: 'remote_command', ref: 'r1', cmd: 'rename', args: {name: 'Office TV'}, from: {label: 'iPhone'}, first: false});
  await wait(100);
  expect(sock.of('device_announce').pop()?.name).toBe('Office TV');
  expect(sock.of('remote_ack')).toEqual([{type: 'remote_ack', ref: 'r1', ok: true}]);
});

test('the toast names the remote once', async () => {
  const toast = require('../../src/toast');
  const spy = jest.spyOn(toast, 'showToast');
  const sock = await started();
  for (const ref of ['r1', 'r2']) sock.say({type: 'remote_command', ref, cmd: 'toggle', args: {}, from: {label: 'iPhone', profileName: 'Elia'}, first: true});
  await wait(100);
  expect(spy.mock.calls.filter(c => String(c[0]).startsWith('Controlled from'))).toEqual([["Controlled from Elia's iPhone", '📱']]);
  spy.mockRestore();
});

test('leaving the profile: device_leave, and no more answers', async () => {
  const sock = await started();
  clearProfileCaches(); // what App.tsx does on a profile change (target.ts registered stopTarget)
  expect(sock.of('device_leave')).toHaveLength(1);
  expect(_targetSession()).toBeNull();
  sock.say({type: 'remote_command', ref: 'r1', cmd: 'pause', args: {}, from: {label: 'iPhone'}, first: false});
  await wait(100);
  expect(sock.of('remote_ack')).toEqual([]);
});

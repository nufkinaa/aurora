// The app's side of presence (src/realtime.ts): hello promises a heartbeat;
// a beat every minute; an unanswered beat closes the socket and connects again;
// a re-sent activity never repeats what was already played.
import {setBaseUrl} from '../../src/api';

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
}
(globalThis as unknown as {WebSocket: unknown}).WebSocket = FakeSocket;

import {BEAT_MS, connect, disconnect, reportActivity, setIdentity} from '../../src/realtime';

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.all = [];
  setBaseUrl('http://tv.test');
});
afterEach(() => {
  disconnect();
  jest.useRealTimers();
});

const opened = () => {
  connect();
  const s = FakeSocket.all[FakeSocket.all.length - 1];
  s.onopen?.();
  s.say({type: 'welcome', clientId: 'c1', presence: 1});
  return s;
};

test('hello promises a heartbeat; a presence beat goes out every minute and is answered', () => {
  setIdentity({id: 'p1', name: 'Ann'});
  const s = opened();
  const hello = s.sent.find(m => m.type === 'hello')!;
  expect(hello.hb).toBe(BEAT_MS / 1000);
  expect(hello.visible).toBe(true);
  expect(s.sent.filter(m => m.type === 'presence')).toHaveLength(1);
  s.say({type: 'presence_ok'});
  jest.advanceTimersByTime(BEAT_MS);
  expect(s.sent.filter(m => m.type === 'presence')).toHaveLength(2);
  s.say({type: 'presence_ok'});
  jest.advanceTimersByTime(20000);
  expect(s.readyState).toBe(1);
});

test('an unanswered beat: the socket is closed and a new one opens', () => {
  setIdentity({id: 'p1', name: 'Ann'});
  const s = opened();
  jest.advanceTimersByTime(16000); // no presence_ok
  expect(s.readyState).toBe(3);
  jest.advanceTimersByTime(2000);
  expect(FakeSocket.all.length).toBe(2);
});

test('on a new socket the remembered activity is said again — with nothing played', () => {
  setIdentity({id: 'p1', name: 'Ann'});
  const s = opened();
  reportActivity('Watching', 'A film', {position: 100, duration: 7200, played: 5, state: 'playing'});
  expect(s.sent.find(m => m.type === 'activity')!.played).toBe(5);
  s.close();
  jest.advanceTimersByTime(1500);
  const s2 = FakeSocket.all[FakeSocket.all.length - 1];
  s2.onopen?.();
  s2.say({type: 'welcome', clientId: 'c2', presence: 1});
  const again = s2.sent.find(m => m.type === 'activity')!;
  expect(again.details).toBe('A film');
  expect(again.played).toBe(0);
});

test('an older server (no `presence` in its welcome) never answers: the socket is kept', () => {
  setIdentity({id: 'p1', name: 'Ann'});
  connect();
  const s = FakeSocket.all[FakeSocket.all.length - 1];
  s.onopen?.();
  s.say({type: 'welcome', clientId: 'c1'});
  jest.advanceTimersByTime(BEAT_MS * 3);
  expect(s.readyState).toBe(1);
  expect(FakeSocket.all).toHaveLength(1);
});

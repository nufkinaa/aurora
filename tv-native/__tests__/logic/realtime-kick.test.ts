// A socket the server ended on purpose (an admin's kick, a ban) is not
// reconnected by itself; an outage still is.
import {setBaseUrl} from '../../src/api';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 1;
  onopen: null | (() => void) = null;
  onmessage: null | ((e: {data: string}) => void) = null;
  onclose: null | (() => void) = null;
  onerror: null | (() => void) = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
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

import {connect, disconnect, isHalted, onMessage} from '../../src/realtime';

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.all = [];
  setBaseUrl('http://tv.test');
});
afterEach(() => {
  disconnect();
  jest.useRealTimers();
});

test('an outage reconnects (after a second, then backing off)', () => {
  connect();
  expect(FakeSocket.all).toHaveLength(1);
  FakeSocket.all[0].close();
  jest.advanceTimersByTime(1000);
  expect(FakeSocket.all).toHaveLength(2);
});

test('kicked: the listeners hear the reason, and nothing reconnects until connect() is called again', () => {
  const heard: string[] = [];
  const off = onMessage('kicked', d => heard.push(String(d.reason)));
  connect();
  const sock = FakeSocket.all[0];
  sock.say({type: 'kicked', reason: 'Signed out by the admin'});
  sock.close(); // the server closes right after saying it
  expect(heard).toEqual(['Signed out by the admin']);
  expect(isHalted()).toBe(true);
  jest.advanceTimersByTime(120000);
  expect(FakeSocket.all).toHaveLength(1); // no loop
  // the sign-in that follows opens a new one
  connect();
  expect(FakeSocket.all).toHaveLength(2);
  expect(isHalted()).toBe(false);
  off();
});

test('banned: the same - the app is told once and the door is not knocked on again', () => {
  const heard: string[] = [];
  const off = onMessage('banned', d => heard.push(String(d.reason)));
  connect();
  FakeSocket.all[0].say({type: 'banned', reason: 'no'});
  FakeSocket.all[0].close();
  jest.advanceTimersByTime(600000);
  expect(heard).toEqual(['no']);
  expect(FakeSocket.all).toHaveLength(1);
  off();
});

// The socket's side of docs/operations.md "What a client should do":
// library_updated reaches the screens once, after a random wait, and never
// behind a playing film; a restart the server announced is waited out quietly.
jest.mock('../../src/telemetry', () => ({
  ...jest.requireActual('../../src/telemetry'),
  wsDown: jest.fn(),
  wsUp: jest.fn(),
}));
import {setBaseUrl} from '../../src/api';
import {wsDown} from '../../src/telemetry';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 1;
  onopen: null | (() => void) = null;
  onmessage: null | ((e: {data: string}) => void) = null;
  onclose: null | ((e?: {code?: number}) => void) = null;
  onerror: null | (() => void) = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code?: number) {
    this.readyState = 3;
    this.onclose?.(code == null ? undefined : {code});
  }
  say(msg: unknown) {
    this.onmessage?.({data: JSON.stringify(msg)});
  }
}
(globalThis as unknown as {WebSocket: unknown}).WebSocket = FakeSocket;

import {connect, disconnect, holdLibraryRefresh, onMessage, serverRestarting, setHomeOnScreen} from '../../src/realtime';

let rnd: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers();
  rnd = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  FakeSocket.all = [];
  (wsDown as jest.Mock).mockClear();
  setBaseUrl('http://tv.test');
  setHomeOnScreen(false);
});
afterEach(() => {
  disconnect();
  rnd.mockRestore();
  jest.useRealTimers();
});

describe('library_updated', () => {
  test('a burst of messages is one message to the screens, 0.5–5 s later', () => {
    let heard = 0;
    const off = onMessage('library_updated', () => heard++);
    connect();
    for (let i = 0; i < 12; i++) FakeSocket.all[0].say({type: 'library_updated'});
    expect(heard).toBe(0);
    jest.advanceTimersByTime(2749);
    expect(heard).toBe(0);
    jest.advanceTimersByTime(1); // 500 + 0.5 × 4500
    expect(heard).toBe(1);
    jest.advanceTimersByTime(60000);
    expect(heard).toBe(1);
    off();
  });

  test('Home on screen: within 0.3 s', () => {
    let heard = 0;
    const off = onMessage('library_updated', () => heard++);
    connect();
    setHomeOnScreen(true);
    FakeSocket.all[0].say({type: 'library_updated'});
    jest.advanceTimersByTime(150);
    expect(heard).toBe(1);
    off();
  });

  test('while a film plays the screens hear nothing; once, after the player is left', () => {
    let heard = 0;
    const off = onMessage('library_updated', () => heard++);
    connect();
    holdLibraryRefresh('player:1', true);
    FakeSocket.all[0].say({type: 'library_updated'});
    FakeSocket.all[0].say({type: 'library_updated'});
    jest.advanceTimersByTime(600000);
    expect(heard).toBe(0);
    // the next episode is a new player that mounts before the old one goes:
    // the hold does not lapse in between
    holdLibraryRefresh('player:2', true);
    holdLibraryRefresh('player:1', false);
    jest.advanceTimersByTime(600000);
    expect(heard).toBe(0);
    holdLibraryRefresh('player:2', false);
    jest.advanceTimersByTime(2750);
    expect(heard).toBe(1);
    off();
  });

  test('signing out drops a refresh that was pending', () => {
    let heard = 0;
    const off = onMessage('library_updated', () => heard++);
    connect();
    FakeSocket.all[0].say({type: 'library_updated'});
    disconnect();
    jest.advanceTimersByTime(60000);
    expect(heard).toBe(0);
    off();
  });
});

describe('a restart the server announced', () => {
  test('server_restarting then close 1012: the first try waits retryInMs + 0–3 s, and it is not counted as an outage', () => {
    connect();
    const sock = FakeSocket.all[0];
    sock.say({type: 'server_restarting', restart: true, message: 'Restarting', retryInMs: 2000});
    expect(serverRestarting()).toBe(true);
    sock.close(1012);
    expect(wsDown).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3499); // 2000 + 0.5 × 3000
    expect(FakeSocket.all).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    // the server is back: the socket opens and the restart is over
    FakeSocket.all[1].onopen?.();
    expect(serverRestarting()).toBe(false);
  });

  test('the server is still down on the first tries: they stay quiet, with short jittered waits; after them it is an outage', () => {
    connect();
    FakeSocket.all[0].say({type: 'server_restarting', retryInMs: 2000});
    FakeSocket.all[0].close(1012);
    jest.advanceTimersByTime(3500);
    expect(FakeSocket.all).toHaveLength(2);
    // tries 2–4 fail too (the socket closes without ever opening)
    FakeSocket.all[1].close();
    jest.advanceTimersByTime(750); // half to all of 1 s
    FakeSocket.all[2].close();
    jest.advanceTimersByTime(1500); // … of 2 s
    FakeSocket.all[3].close();
    jest.advanceTimersByTime(3000); // … of 4 s
    expect(FakeSocket.all).toHaveLength(5);
    expect(wsDown).not.toHaveBeenCalled();
    // the fifth failure is no longer "the restart"
    FakeSocket.all[4].close();
    expect(wsDown).toHaveBeenCalledTimes(1);
    expect(serverRestarting()).toBe(false);
    jest.advanceTimersByTime(6000); // … of 8 s
    expect(FakeSocket.all).toHaveLength(6);
  });

  test('close code 1012 without the message having arrived is the same', () => {
    connect();
    FakeSocket.all[0].close(1012);
    expect(wsDown).not.toHaveBeenCalled();
    expect(serverRestarting()).toBe(true);
    jest.advanceTimersByTime(3500);
    expect(FakeSocket.all).toHaveLength(2);
  });

  test('an ordinary drop is an outage: counted, and retried after half to all of the step', () => {
    connect();
    FakeSocket.all[0].close();
    expect(wsDown).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(749);
    expect(FakeSocket.all).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
  });
});

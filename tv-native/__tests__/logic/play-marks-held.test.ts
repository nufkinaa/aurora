// Play marks sent while the server cannot be reached are held (bounded) and
// sent when it answers again (api.ts heldMarks) — the device pass found them
// dropped for good, and an outage is when the stall and error marks matter.
import {__resetHeldMarks, api, flushHeldMarks, heldMarkCount, MARKS_HELD_MAX, setBaseUrl} from '../../src/api';
import {queue, resetXhr, sent} from './fake-xhr';

const tick = () => new Promise<void>(r => setTimeout(r, 5));

beforeEach(() => {
  resetXhr();
  __resetHeldMarks();
  setBaseUrl('http://tv.test');
});

test('a mark that cannot reach the server is held, and sent by the next answered request', async () => {
  queue({status: 0, fail: true});
  await expect(api.playMark('m1', {name: 'stall', ms: 1200, at: 30})).rejects.toMatchObject({status: 0});
  expect(heldMarkCount()).toBe(1);
  // the server is back: any answered request sends what was held
  queue({status: 200, body: '[]'}, {status: 200, body: '{"ok":true}'});
  await api.profiles();
  for (let i = 0; i < 10 && heldMarkCount(); i++) await tick();
  expect(heldMarkCount()).toBe(0);
  const tries = sent.filter(x => x.url.endsWith('/api/play-mark/m1'));
  expect(tries.length).toBe(2); // the one that failed, and the one sent later
  const mark = tries[1];
  expect(mark.method).toBe('POST');
  const body = JSON.parse(String(mark.body));
  expect(body).toMatchObject({name: 'stall', ms: 1200, at: 30});
  expect(typeof body.queued).toBe('number');
});

test('bounded: the oldest give way past MARKS_HELD_MAX', async () => {
  for (let i = 0; i < MARKS_HELD_MAX + 5; i++) {
    queue({status: 0, fail: true});
    await api.playMark('m', {name: `n${i}`}).catch(() => {});
  }
  expect(heldMarkCount()).toBe(MARKS_HELD_MAX);
  // still away: a flush keeps them all, in order
  queue({status: 0, fail: true});
  await flushHeldMarks();
  expect(heldMarkCount()).toBe(MARKS_HELD_MAX);
  queue(...Array.from({length: MARKS_HELD_MAX}, () => ({status: 200, body: '{"ok":true}'})));
  const before = sent.length;
  await flushHeldMarks();
  expect(heldMarkCount()).toBe(0);
  const names = sent.slice(before).map(x => JSON.parse(String(x.body)).name);
  expect(names[0]).toBe('n5'); // n0..n4 gave way
  expect(names[names.length - 1]).toBe(`n${MARKS_HELD_MAX + 4}`);
});

test('a mark the server refuses is not held (sending it again changes nothing)', async () => {
  queue({status: 404, body: '{"error":"no such item"}'});
  await expect(api.playMark('gone', {name: 'mount'})).rejects.toMatchObject({status: 404});
  expect(heldMarkCount()).toBe(0);
});

test('one refused while flushing is dropped, the rest still go', async () => {
  for (const n of ['a', 'b']) {
    queue({status: 0, fail: true});
    await api.playMark('m', {name: n}).catch(() => {});
  }
  queue({status: 400, body: '{}'}, {status: 200, body: '{"ok":true}'});
  await flushHeldMarks();
  expect(heldMarkCount()).toBe(0);
});

// api.home keeps its last answer: an unchanged one comes back as THE SAME
// OBJECT (so Home's memoised rows and cards do not re-render on a return to
// Home), and a changed one replaces it.
import {api, setBaseUrl, sameParties, PartySummary} from '../../src/api';
import {blurOf} from '../../src/blur';
import {queue, sent, resetXhr} from './fake-xhr';

const home = (title: string, extra = {}) =>
  JSON.stringify({hero: [{id: 'h1', title}], rows: [{id: 'continue', title: 'Continue', items: [{id: 'a', title}]}], ...extra});

beforeEach(() => {
  resetXhr();
  setBaseUrl('http://tv.test');
});

test('a 304 hands back the same object, and the read was conditional', async () => {
  queue({status: 200, body: home('One'), etag: 'W/"e1"'}, {status: 304});
  const a = await api.home('p304');
  const b = await api.home('p304');
  expect(b).toBe(a);
  expect(sent[0].headers['If-None-Match']).toBeUndefined();
  expect(sent[1].headers['If-None-Match']).toBe('W/"e1"');
  expect(sent[1].url).toBe('http://tv.test/api/home?slim=1&profile=p304');
});

test('a 200 with the same text (no ETag at all) is not parsed into new objects', async () => {
  queue({status: 200, body: home('Same')}, {status: 200, body: home('Same')});
  const a = await api.home('ptext');
  const b = await api.home('ptext');
  expect(b).toBe(a);
  expect(b.rows[0].items[0]).toBe(a.rows[0].items[0]);
  expect(sent[1].headers['If-None-Match']).toBeUndefined();
});

test('a home that really changed is a new object with the new rows, and is what is kept next', async () => {
  queue({status: 200, body: home('Old'), etag: 'W/"old"'}, {status: 200, body: home('New'), etag: 'W/"new"'}, {status: 304});
  const a = await api.home('pchg');
  const b = await api.home('pchg');
  expect(b).not.toBe(a);
  expect(a.rows[0].items[0].title).toBe('Old');
  expect(b.rows[0].items[0].title).toBe('New');
  const c = await api.home('pchg');
  expect(c).toBe(b);
  expect(sent[2].headers['If-None-Match']).toBe('W/"new"');
});

test('another profile never gets the kept answer, and is not asked conditionally', async () => {
  queue({status: 200, body: home('Mine'), etag: 'W/"m"'}, {status: 200, body: home('Mine'), etag: 'W/"m"'});
  const a = await api.home('pa');
  const b = await api.home('pb');
  expect(b).not.toBe(a);
  expect(sent[1].headers['If-None-Match']).toBeUndefined();
});

test('a conditional read that fails on the line is asked again the plain way', async () => {
  queue({status: 200, body: home('A'), etag: 'W/"a"'}, {status: 0, fail: true}, {status: 200, body: home('B'), etag: 'W/"b"'});
  await api.home('pfail');
  const b = await api.home('pfail');
  expect(b.rows[0].items[0].title).toBe('B');
  expect(sent).toHaveLength(3);
  expect(sent[2].headers['If-None-Match']).toBeUndefined();
});

test('a conditional read the server refuses is the answer, not retried', async () => {
  queue({status: 200, body: home('A'), etag: 'W/"a"'}, {status: 401, body: '{"error":"sign in"}'});
  await api.home('p401');
  await expect(api.home('p401')).rejects.toMatchObject({status: 401, message: 'sign in'});
  expect(sent).toHaveLength(2);
});

test('the blur-up pictures beside the answer are still taken, and never reach the screen', async () => {
  queue({status: 200, body: home('Blur', {_blur: {'/img/x': 'data:image/webp;base64,AAAA'}})});
  const a = (await api.home('pblur')) as unknown as {_blur?: unknown};
  expect(a._blur).toBeUndefined();
  expect(blurOf('/img/x')).toBe('data:image/webp;base64,AAAA');
});

test('a 200 that is not JSON is a readable error, not a parser message', async () => {
  queue({status: 200, body: '<html>Sign in to the hotel Wi-Fi</html>'});
  await expect(api.home('phtml')).rejects.toMatchObject({status: 0, message: 'The server sent an answer the app could not read'});
});

test('sameParties: equal by what the hero band draws', () => {
  const p = (o: Partial<PartySummary> = {}): PartySummary => ({code: 'ABCD', host: 'Elia', title: 'Dune', members: 2, ...o});
  expect(sameParties([], [])).toBe(true);
  expect(sameParties([p()], [p()])).toBe(true);
  expect(sameParties([p()], [p({members: 3})])).toBe(false);
  expect(sameParties([p()], [p({title: 'Troy'})])).toBe(false);
  expect(sameParties([p()], [])).toBe(false);
  expect(sameParties([p(), p({code: 'X'})], [p({code: 'X'}), p()])).toBe(false);
});

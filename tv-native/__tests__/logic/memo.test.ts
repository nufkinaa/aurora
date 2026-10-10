// The read cache (api.ts memo): bounded, and a library change forgets only
// what the library decides.
import {api, setBaseUrl, forgetLibraryReads, _memoInternals} from '../../src/api';
import {queue, sent, resetXhr} from './fake-xhr';

const ok = (body: unknown = {}) => ({status: 200, body: JSON.stringify(body)});

beforeEach(() => {
  resetXhr();
  _memoInternals.clear();
  setBaseUrl('http://tv.test');
  jest.restoreAllMocks();
});

test('a memoised read is asked once while it is young', async () => {
  queue(ok({trailers: []}));
  await api.discoverMeta('movie', 'tt1');
  await api.discoverMeta('movie', 'tt1');
  expect(sent).toHaveLength(1);
});

test('the store never holds more than its cap, and the oldest goes first', async () => {
  const n = _memoInternals.max + 25;
  for (let i = 0; i < n; i++) {
    queue(ok({trailers: []}));
    await api.discoverMeta('movie', `tt${i}`);
  }
  const keys = _memoInternals.keys();
  expect(keys).toHaveLength(_memoInternals.max);
  expect(keys).not.toContain('meta:movie:tt0');
  expect(keys).toContain(`meta:movie:tt${n - 1}`);
  // an evicted read is simply asked again
  queue(ok({trailers: ['x']}));
  await expect(api.discoverMeta('movie', 'tt0')).resolves.toEqual({trailers: ['x']});
});

test('expired entries leave when the next one comes in', async () => {
  let now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  queue(ok({id: 'a'}), ok({id: 'b'}));
  await api.item('a'); // 45 s
  await api.item('b');
  expect(_memoInternals.keys()).toEqual(['/api/item/a', '/api/item/b']);
  now += 46_000;
  queue(ok({trailers: []}));
  await api.discoverMeta('movie', 'tt9');
  expect(_memoInternals.keys()).toEqual(['meta:movie:tt9']);
});

test('a key asked again after it expired moves to the young end', async () => {
  let now = 2_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  queue(ok({id: 'a'}), ok({trailers: []}));
  await api.item('a'); // 45 s
  await api.discoverMeta('movie', 'tt1'); // 10 min
  now += 46_000;
  queue(ok({id: 'a'}));
  await api.item('a');
  expect(_memoInternals.keys()).toEqual(['meta:movie:tt1', '/api/item/a']);
});

test('a failed read is not kept', async () => {
  queue({status: 500, body: '{"error":"no"}'});
  await expect(api.item('zz')).rejects.toMatchObject({status: 500});
  expect(_memoInternals.keys()).toEqual([]);
});

test('library_updated forgets the library, its items and the catalogue pages, and nothing else', async () => {
  queue(ok({movies: [], shows: []}), ok({id: 'a'}), ok({items: [], page: 0, hasMore: false}), ok({trailers: []}), ok({genres: []}), ok({source: 'none'}), ok({imdbId: 'tt1'}), ok({versions: []}));
  await api.library();
  await api.item('a', 'p1');
  await api.catalog({type: 'movie', category: 'trending', page: 0});
  await api.discoverMeta('series', 'tt2');
  await api.catalogGenres('movie');
  await api.trailer('tt2', 'show');
  await api.imdbFor('movie', 'Troy', 2004);
  await api.changelog();
  expect(_memoInternals.keys()).toHaveLength(8);
  forgetLibraryReads();
  expect(_memoInternals.keys().sort()).toEqual(
    ['/api/imdb-for?type=movie&title=Troy&year=2004', 'changelog', 'genres:movie', 'meta:series:tt2', 'trailer:show:tt2'].sort(),
  );
});

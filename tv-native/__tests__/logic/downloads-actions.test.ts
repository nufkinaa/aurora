// What one press, and holding, does on a row of My downloads (downloadsLogic.ts).
import {downloadActions, isReady} from '../../src/downloadsLogic';

const job = (o: Record<string, unknown>) => ({status: 'downloading', mine: true, imdbId: 'tt1', infoHash: 'abc', ...o} as never);

test('ready to play: press plays; holding also offers the title page', () => {
  const a = downloadActions(job({status: 'done', libraryId: 'lib1'}), true);
  expect(a).toEqual({press: 'play', all: ['play', 'title'], label: '▶  Play'});
});

test('finished but not in the library yet is not "ready", and its press does nothing', () => {
  const j = job({status: 'done', libraryId: null});
  expect(isReady(j)).toBe(false);
  expect(downloadActions(j, true).press).toBeNull();
});

test('on its way: one press cancels - but past 5% it asks first', () => {
  expect(downloadActions(job({status: 'approved'}), true).press).toBe('cancel');
  expect(downloadActions(job({status: 'pending'}), true).press).toBe('cancel');
  expect(downloadActions(job({status: 'downloading', progress: 0.04}), true).press).toBe('cancel');
  expect(downloadActions(job({status: 'downloading', progress: 0.4}), true).press).toBe('confirmCancel');
});

test('a failed download: Try again, the title page, and Remove - never "cancel" (which left a Canceled row for good)', () => {
  const a = downloadActions(job({status: 'error'}), true);
  expect(a.press).toBe('menu');
  expect(a.all).toEqual(['retry', 'title', 'remove']);
  expect(a.all).not.toContain('cancel');
});

test('declined and cancelled rows can be removed too; a declined one is not asked for again', () => {
  expect(downloadActions(job({status: 'declined'}), true).all).toEqual(['title', 'remove']);
  expect(downloadActions(job({status: 'canceled'}), true).all).toEqual(['retry', 'title', 'remove']);
  expect(downloadActions(job({status: 'canceled', infoHash: null, imdbId: null}), true).all).toEqual(['remove']);
});

test("someone else's download has no action", () => {
  expect(downloadActions(job({status: 'downloading', mine: false}), false)).toEqual({press: null, all: [], label: ''});
});

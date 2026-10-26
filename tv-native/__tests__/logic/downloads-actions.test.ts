// What one press, and holding, does on a row of My downloads (downloadsLogic.ts).
import {downloadActions, isReady, rowStatus, startedBy} from '../../src/downloadsLogic';

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

test('a queued download cancels without asking; a running one past 5% asks first', () => {
  expect(downloadActions(job({status: 'approved', progress: 0.42}), true).press).toBe('cancel');
  expect(downloadActions(job({status: 'downloading', progress: 0.42}), true).press).toBe('confirmCancel');
  expect(downloadActions(job({status: 'downloading', progress: 0.01}), true).press).toBe('cancel');
});

test("someone else's download says who started it, by name - the website's words; your own rows say nothing", () => {
  expect(startedBy(job({mine: false, by: 'Dor'}), false)).toBe('Started by Dor');
  expect(startedBy(job({mine: true, by: 'Dor'}), true)).toBeNull();
  // an older server (no field), or one that could not say
  expect(startedBy(job({mine: false}), false)).toBeNull();
  expect(startedBy(job({mine: false, by: null}), false)).toBeNull();
  expect(startedBy(job({mine: false, by: '  '}), false)).toBeNull();
});

test('the row line: whose first, so a long status cannot cut it off', () => {
  expect(rowStatus({who: 'Started by Dor', kind: null, status: 'Waiting for approval — Low disk space: 63.1 GB free on C:/Users/x', size: null})).toBe(
    'Started by Dor · Waiting for approval — Low disk space: 63.1 GB free on C:/Users/x',
  );
  expect(rowStatus({who: null, kind: 'Next episode, queued for you', status: 'Downloading 40%', size: '1.2 GB'})).toBe('Next episode, queued for you · Downloading 40% · 1.2 GB');
  expect(rowStatus({who: null, kind: null, status: 'Ready', size: null})).toBe('Ready');
});

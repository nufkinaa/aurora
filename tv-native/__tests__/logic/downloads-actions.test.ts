// What one press, and holding, does on a row of My downloads (downloadsLogic.ts).
import {cancelQuestion, countLine, downloadActions, downloadCounts, isReady, rowStatus, startedBy} from '../../src/downloadsLogic';
import {statusLine} from '../../src/downloadsWords';

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

test('on its way: a press always asks first - a stray OK on the remote must not cancel it', () => {
  expect(downloadActions(job({status: 'approved'}), true).press).toBe('confirmCancel');
  expect(downloadActions(job({status: 'approved', progress: 0.42}), true).press).toBe('confirmCancel');
  expect(downloadActions(job({status: 'pending'}), true).press).toBe('confirmCancel');
  expect(downloadActions(job({status: 'downloading', progress: 0}), true).press).toBe('confirmCancel');
  expect(downloadActions(job({status: 'downloading', progress: 0.01}), true).press).toBe('confirmCancel');
  expect(downloadActions(job({status: 'downloading', progress: 0.4}), true).press).toBe('confirmCancel');
  expect(downloadActions(job({status: 'downloading', progress: 0.4}), true).label).toBe('Cancel');
  expect(downloadActions(job({status: 'downloading', progress: 0.4}), true).all).toEqual(['title', 'confirmCancel']);
});

test('the question says what is lost, and that a copy being replaced is safe', () => {
  const q = cancelQuestion({label: 'Film', status: 'downloading', progress: 0.42});
  expect(q.title).toBe('Cancel “Film”?');
  expect(q.body).toBe("It's 42% down. Cancelling throws that away; you can always ask for it again.");
  expect(q.keep).toBe('Keep going');
  expect(q.yes).toBe('Cancel the download');
  expect(cancelQuestion({label: 'Film', status: 'approved', progress: 0.42}).body).toBe('You can always ask for it again.');
  expect(cancelQuestion({label: 'Film', status: 'downloading', progress: 0}).body).toBe('You can always ask for it again.');
  expect(cancelQuestion({label: 'Film', status: 'pending', replaces: {libraryId: 'x'}}).body).toBe('You can always ask for it again. Your copy stays as it was.');
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

test('another version that did not make it: pick another, never the same request again', () => {
  const dead = {replaces: {libraryId: 'lib1'}};
  expect(downloadActions(job({status: 'canceled', ...dead}), true).all).toEqual(['another', 'title', 'remove']);
  expect(downloadActions(job({status: 'error', ...dead}), true).all).toEqual(['another', 'title', 'remove']);
  // a declined one too: the admin said no to that source, not to the copy being replaced
  expect(downloadActions(job({status: 'declined', ...dead}), true).all).toEqual(['another', 'title', 'remove']);
});

test('the amount of downloads: this profile, by where they are - a count, no limit in it', () => {
  const list = [
    job({status: 'downloading'}),
    job({status: 'downloading'}),
    job({status: 'done', libraryId: null}), // still being indexed
    job({status: 'approved'}),
    job({status: 'pending'}),
    job({status: 'done', libraryId: 'a'}),
    job({status: 'done', libraryId: 'b'}),
    job({status: 'error'}),
    job({status: 'canceled'}),
  ];
  const c = downloadCounts(list);
  expect(c).toEqual({downloading: 3, queued: 1, waiting: 1, ready: 2, failed: 2});
  expect(countLine(c)).toBe("3 downloading · 1 queued · 1 waiting for approval · 2 ready · 2 didn't make it");
  expect(countLine(downloadCounts([job({status: 'downloading'}), job({status: 'done', libraryId: 'a'})]))).toBe('1 downloading · 1 ready');
  expect(countLine(downloadCounts([]))).toBe('');
});

test('a cancelled row says who did it; a replacement says the copy is safe', () => {
  const line = (o: Record<string, unknown>) => statusLine(job(o));
  expect(line({status: 'canceled', canceledBy: 'self'})).toBe('Cancelled by you');
  expect(line({status: 'canceled', canceledBy: 'admin'})).toBe('Cancelled by the admin');
  expect(line({status: 'canceled'})).toBe('Canceled');
  const r = {replaces: {libraryId: 'x'}};
  expect(line({status: 'canceled', canceledBy: 'admin', ...r})).toBe('Cancelled by the admin — your copy stays as it was');
  expect(line({status: 'declined', ...r})).toBe('Declined by the admin — your copy stays as it was');
  expect(line({status: 'error', error: 'no peers', ...r})).toBe('Failed, your copy stays as it was — no peers');
  expect(line({status: 'error', error: 'no peers'})).toBe('Failed — no peers');
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

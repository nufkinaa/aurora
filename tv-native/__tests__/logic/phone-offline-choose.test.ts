// "Choose episodes" on the phone (src/phone/offline/chooseRules.ts) — the website's
// public/js/offlineChoose.js rules: where each episode stands, what comes ticked, the sizes
// and the running total, in the same words.
import {firstSize, preTicked, rowWhat, saveWords, sizeAt, standing, tickable, totalLine, typicalSecs, ChooseRow} from '../../src/phone/offline/chooseRules';

const GB = 1024 ** 3;
const row = (e: number, o: Partial<ChooseRow> = {}): ChooseRow => ({key: `1x${e}`, season: 1, episode: e, title: `Ep ${e}`, libId: `L${e}`, duration: 2700, sizeBytes: GB, st: 'ready', ...o});

test('where an episode stands: saved, on its way, wished, on the server, not yet', () => {
  expect(standing({here: true, job: false, wish: false, onServer: true})).toBe('saved');
  expect(standing({here: false, job: true, wish: false, onServer: true})).toBe('saving');
  expect(standing({here: false, job: false, wish: true, onServer: false})).toBe('wished');
  expect(standing({here: false, job: false, wish: false, onServer: true})).toBe('ready');
  expect(standing({here: false, job: false, wish: false, onServer: false})).toBe('later');
  expect(['saved', 'saving', 'wished'].map(s => tickable(s as never))).toEqual([false, false, false]);
  expect(tickable('ready') && tickable('later')).toBe(true);
});

test('the next three unwatched that can be ticked, from the next episode to watch', () => {
  const rows = [row(1), row(2, {st: 'saved'}), row(3), row(4), row(5, {st: 'later', libId: null}), row(6)];
  expect(preTicked(rows, {from: {season: 1, episode: 2}})).toEqual(['1x3', '1x4', '1x5']);
  expect(preTicked(rows, {from: {season: 1, episode: 3}, finished: r => r.episode === 3})).toEqual(['1x4', '1x5', '1x6']);
  expect(preTicked(rows, {})).toEqual(['1x1', '1x3', '1x4']);
});

test('sizes: Original is the file; the others by the running time; an unknown file estimated', () => {
  expect(sizeAt(row(1), 'original')).toEqual({bytes: GB, estimated: false});
  expect(sizeAt(row(1), '720').estimated).toBe(true);
  expect(Math.round(sizeAt(row(1), '720').bytes / 1024 ** 2)).toBe(717); // 2228 kbit/s × 45 min
  expect(sizeAt({duration: 0, sizeBytes: 0}, 'original', 2700).estimated).toBe(true);
  expect(sizeAt({duration: 0}, '480').bytes).toBe(0);
  expect(typicalSecs([{duration: 0}, {duration: 2600}, {duration: 2700}, {duration: 3000}])).toBe(2700);
});

test('the running total and the button, in the website’s words', () => {
  expect(totalLine([], '720')).toBe('No episodes ticked');
  expect(totalLine([row(1), row(2)], 'original')).toBe('2 episodes · 2.0 GB');
  expect(totalLine([row(1), row(5, {st: 'later', libId: null, sizeBytes: 0})], 'original')).toBe('2 episodes · ≈ 2.4 GB · 1 when it arrives');
  expect(saveWords(0)).toBe('Save');
  expect(saveWords(1)).toBe('Save 1 episode');
  expect(saveWords(4)).toBe('Save 4 episodes');
});

test('what a row says', () => {
  expect(rowWhat(row(1, {st: 'saved'}))).toBe('Saved on this device');
  expect(rowWhat(row(1, {st: 'saving', pct: 0.42}))).toBe('Saving 42%');
  expect(rowWhat(row(1, {st: 'saving', paused: true}))).toBe('Paused');
  expect(rowWhat(row(1, {st: 'wished'}))).toBe('Will be saved when it arrives');
  expect(rowWhat(row(1, {st: 'later'}))).toBe('Not on the server yet — saves here when it arrives');
  expect(rowWhat(row(1, {st: 'later', aired: false}))).toBe('Not out yet — saves here when it arrives');
  expect(rowWhat(row(1))).toBeNull();
});

test('the size to start on: the standing one, else the last picked, else 720p', () => {
  expect(firstSize('1080', '480')).toBe('1080');
  expect(firstSize('ask', '480')).toBe('480');
  expect(firstSize('ask', null)).toBe('720');
});

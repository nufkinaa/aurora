// What an empty Movies / Shows grid says (src/browseCopy.ts).
import {emptyGridLine, emptyHomeLine, isFiltered} from '../../src/browseCopy';

const base = {kind: 'movie' as const, category: 'all', genre: '', unwatched: false, kidsAge: null};

test('a kids profile with no filters set is not told to use fewer filters', () => {
  const l = emptyGridLine({...base, kidsAge: 7});
  expect(l.message).toBe('No films for this age here yet.');
  expect(l.message).not.toMatch(/filter/i);
  expect(l.actionLabel).toBe('Try another category');
  expect(emptyGridLine({...base, kind: 'show', kidsAge: 12}).message).toBe('No shows for this age here yet.');
});

test('filters the viewer set are still named as the reason', () => {
  expect(emptyGridLine({...base, unwatched: true}).message).toBe('Nothing matches. Try fewer filters?');
  expect(emptyGridLine({...base, category: 'top', kidsAge: 7}).message).toBe('Nothing matches. Try fewer filters?');
  expect(emptyGridLine({...base, genre: 'Horror'}).message).toBe('Nothing in Horror here. Try another genre?');
  expect(emptyGridLine({...base, genre: 'Horror', kidsAge: 7}).message).toBe('Nothing in Horror for this age here. Try another genre?');
  expect(emptyGridLine({...base, genre: 'Horror'}).actionLabel).toBe('Change filters');
});

test('a grown-up with nothing filtered', () => {
  expect(emptyGridLine(base)).toEqual({message: 'No films here yet.', actionLabel: 'Try another category'});
  expect(isFiltered(base)).toBe(false);
});

test('an empty Home on a kids profile says why, not that the server is warming up', () => {
  // Mi TV 2026-10-18: a kids profile with nothing rated for its age read "it may still be warming up after a restart"
  const k = emptyHomeLine(7);
  expect(k.message).toBe('Nothing for this age here yet.');
  expect(k.detail).toBe('This profile shows titles rated for ages up to 7 — none are in the library yet.');
  expect(k.detail).not.toMatch(/warming|restart/);
  expect(emptyHomeLine(0).detail).toBe('This profile shows titles rated for all ages — none are in the library yet.');
  expect(emptyHomeLine(null).detail).toMatch(/warming up after a restart/);
});

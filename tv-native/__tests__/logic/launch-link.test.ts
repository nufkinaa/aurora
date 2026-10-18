// The launcher's Aurora row opens a title through the link the app is started
// with (homeScreen.ts). Mi TV, 2026-10-18: after Back from Home (the Activity
// ends, the process stays) the next pick in the row came up on Home — the
// once-per-PROCESS flag had already been spent.
import {shouldOpenInitial} from '../../src/homeScreen';

const LINK = 'aurora://open?a=play&d=%7B%22id%22%3A%22a1%22%2C%22title%22%3A%22X%22%7D';

describe('the link the app was opened with', () => {
  test('opened in the run it came with', () => {
    expect(shouldOpenInitial(LINK, {last: null, run: 0}, 1)).toBe(true);
  });
  test('not again when Home mounts again in the same run (a profile switch)', () => {
    expect(shouldOpenInitial(LINK, {last: LINK, run: 1}, 1)).toBe(false);
  });
  test('a new run (Back ended the Activity, the row picked a title): opened, even the same title', () => {
    expect(shouldOpenInitial(LINK, {last: LINK, run: 1}, 2)).toBe(true);
  });
  test('a different link in the same run is opened', () => {
    expect(shouldOpenInitial(LINK + 'x', {last: LINK, run: 1}, 1)).toBe(true);
  });
  test('no link (started from the icon): nothing', () => {
    expect(shouldOpenInitial(null, {last: null, run: 0}, 1)).toBe(false);
  });
});

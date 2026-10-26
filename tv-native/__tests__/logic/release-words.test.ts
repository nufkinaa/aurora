// "Has it really come out, and is this a good copy?" on the TV
// (src/releaseWords.ts): the words are the website's to the letter
// (public/js/screens/discover-detail.js EARLY_CONFIRM), and what may be
// picked for someone is the server's rule (src/media/releasekind.js pickable).
import {EARLY_CONFIRM, heroRelease, isEarly, pickable, sourceBadge} from '../../src/releaseWords';

const fs = require('fs');
const path = require('path');

const WEB = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'js', 'screens', 'discover-detail.js'), 'utf8');

test('the confirm before a pre-release copy downloads or plays: the website\'s words', () => {
  expect(WEB).toContain(`title: "${EARLY_CONFIRM.title}"`);
  expect(WEB).toContain(`download: "${EARLY_CONFIRM.download}"`);
  expect(WEB).toContain(`play: "${EARLY_CONFIRM.play}"`);
  const s = {cam: true, prerelease: 'cam', warning: 'CAM — filmed in a cinema'};
  expect(EARLY_CONFIRM.text(s)).toBe('CAM — filmed in a cinema. Picture and sound are usually poor — a good copy normally follows once the film is out to stream or buy.');
  // the sentence after the warning, as the site builds it
  expect(WEB).toContain('Picture and sound are usually poor — a good copy normally follows once the film is out to stream or buy.');
  expect(EARLY_CONFIRM.text({cam: true})).toMatch(/^A cinema recording\. /);
});

test('early, pickable, badge', () => {
  expect(isEarly({cam: true})).toBe(true);
  expect(isEarly({prerelease: 'screener'})).toBe(true);
  expect(isEarly({hardsub: true})).toBe(false);
  expect(pickable({cam: true})).toBe(false);
  expect(pickable({dubbed: true})).toBe(false);
  expect(pickable({hardsub: true})).toBe(true);
  expect(pickable({})).toBe(true);
  expect(pickable(null)).toBe(false);
  expect(sourceBadge({cam: true, badge: 'TS'})).toBe('TS');
  expect(sourceBadge({cam: true})).toBe('Cam'); // an older server
  expect(sourceBadge({hardsub: true, badge: 'BURNED-IN SUBS'})).toBe('BURNED-IN SUBS');
  expect(sourceBadge({})).toBeNull();
});

test("the title page's line: only when there is something to say", () => {
  expect(heroRelease(null)).toBeNull();
  expect(heroRelease({state: 'good', line: null, note: null})).toBeNull();
  const r = {state: 'early-only' as const, line: 'Not out in good quality yet — only cinema recordings so far', note: 'In cinemas since 3 Oct 2026'};
  expect(heroRelease(r)).toBe(r);
  expect(heroRelease({state: 'not-out', line: 'Not out to watch at home yet', note: null})?.line).toBe('Not out to watch at home yet');
});

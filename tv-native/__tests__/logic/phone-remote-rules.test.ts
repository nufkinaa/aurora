// The phone remote's rules and words (src/phone/remote/remoteRules.ts) — the website's remote
// (public/js/screens/remote.js, public/js/remote.js): the clock, the device picked, the banner,
// the lines, Continue Watching, the touchpad's steps, the scrub bar, the subtitle timing.
import * as R from '../../src/phone/remote/remoteRules';
import type {NowState} from '../../src/remote/protocol';

const now = (o: Partial<NowState> = {}): NowState => ({
  id: 'e1', title: 'Episode 1', showTitle: 'Test Show', epTitle: 'Episode 1', season: 1, episode: 1, poster: null, backdrop: null,
  duration: 2700, position: 754, paused: false, buffering: false, canSeek: true, hasNext: true, nextLabel: 'S1 E2',
  subs: [], sub: null, audios: [], audio: null, subDelay: 0, ...o,
});
const tv = (id: string, o: Partial<R.RDevice> = {}): R.RDevice => ({deviceId: id, name: `TV ${id}`, kind: 'tv', mine: true, caps: {navigate: true, volume: true}, state: {screen: 'home', appState: 'active', now: null, volume: null}, ...o});

test('the clock: as the site writes it, and running on between reports', () => {
  expect(R.fmtClock(7)).toBe('0:07');
  expect(R.fmtClock(757)).toBe('12:37');
  expect(R.fmtClock(3725)).toBe('1:02:05');
  expect(R.fmtClock(-3)).toBe('0:00');
  const v = {position: 100, at: 1000, paused: false, duration: 105};
  expect(R.livePos(v, 3000)).toBe(102);
  expect(R.livePos(v, 60000)).toBe(105); // never past the end
  expect(R.livePos({...v, paused: true}, 9000)).toBe(100);
  expect(R.livePos({...v, buffering: true}, 9000)).toBe(100);
  expect(R.skipTo(20, -30, 100)).toBe(0);
  expect(R.skipTo(90, 30, 100)).toBe(100);
});

test('the device picked: kept while on, else the last used, else the one playing, else the first', () => {
  const a = tv('a');
  const b = tv('b', {state: {screen: 'player', appState: 'active', now: now(), volume: null}});
  const c = tv('c');
  expect(R.autoPick([a, b, c], 'c', 'a')).toBe('c');
  expect(R.autoPick([a, b, c], null, 'c')).toBe('c');
  expect(R.autoPick([a, b, c], null, null)).toBe('b');
  expect(R.autoPick([a, c], null, 'gone')).toBe('a');
  expect(R.autoPick([], 'x', null)).toBe('x'); // a restart: it may come back
  expect(R.autoPick([a], 'x', null)).toBe('a');
  expect(R.autoPick([a], 'x', null, true)).toBe('x'); // asked for by name: the banner says it is gone
  expect(R.autoPick([], null, null)).toBe(null);
});

test('the banner, the light and the screen state, in the site words', () => {
  const a = tv('a');
  expect(R.bannerLine(false, 'a', a, true)).toBe('Reconnecting to the server…');
  expect(R.bannerLine(true, 'x', null, true)).toBe("That device isn't on any more — pick another above");
  expect(R.bannerLine(true, 'a', {...a, state: {screen: 'home', appState: 'background', now: null, volume: null}}, true)).toBe('Aurora is in the background on TV a — open it there');
  expect(R.bannerLine(true, 'a', a, true)).toBe('');
  expect(R.dotOf(false, a)).toBe('off');
  expect(R.dotOf(true, a)).toBe('live');
  expect(R.dotOf(true, null)).toBe('idle');
  expect(R.stateOf(false, null)).toBe('empty');
  expect(R.stateOf(true, null)).toBe('idle');
  expect(R.stateOf(true, now())).toBe('playing');
});

test('the lines: the device, the picker, the idle view, the eyebrow, the episode', () => {
  const p = tv('a', {state: {screen: 'player', appState: 'active', now: now(), volume: null}});
  expect(R.deviceLine(p)).toBe('Playing · Test Show · S1 E1');
  expect(R.deviceLine(tv('a'))).toBe('On Home');
  expect(R.deviceLine(tv('a', {state: {screen: 'search', appState: 'active', now: null, volume: null}}))).toBe('Ready');
  expect(R.deviceLine(tv('a', {wall: true}))).toBe('On “Who\'s watching?”');
  const theirs = tv('h', {mine: false, profile: {id: 'p2', name: 'Dana'}});
  expect(R.pickerSub(theirs)).toBe('Dana · On Home');
  expect(R.pickerSub(tv('a'))).toBe('On Home');
  expect(R.idleSub(theirs)).toBe('On Home · Dana');
  expect(R.eyebrowOf(now({paused: true}), tv('a'))).toBe('Paused on TV a');
  expect(R.subOf(now())).toBe('S1 E1 · Episode 1');
  expect(R.subOf(now({season: null, episode: null, showTitle: null, epTitle: null, title: 'Arrival'}))).toBe('');
  expect(R.deviceKind(tv('a'))).toBe('tv');
  expect(R.deviceKind({deviceId: 'x', name: 'iPad', kind: 'web', form: 'tablet'})).toBe('tablet');
  expect(R.deviceKind({deviceId: 'x', name: 'Chrome', kind: 'web', form: 'computer'})).toBe('computer');
});

test('no device on: looking, then how to get one (and the household line)', () => {
  expect(R.emptyLine(false, true, 'Maya', false)).toBe('Looking for your TVs…');
  expect(R.emptyLine(true, true, 'Maya', false)).toBe('Open Aurora on your TV — signed in as Maya — and it shows up here.');
  expect(R.emptyLine(true, true, 'Maya', true)).toMatch(/TVs of the rest of the household show up too\.$/);
  expect(R.emptyLine(false, false, 'Maya', false)).toMatch(/^Open Aurora/);
});

test('Continue Watching: the profile row, no torrents, twelve at most, where each starts', () => {
  const items = Array.from({length: 14}, (_, i) => ({id: `i${i}`, title: `T${i}`, progress: {position: 30 * i, duration: 600}}));
  const rows = [{id: 'top', title: 'Top', items: []}, {id: 'continue', title: 'Continue Watching', items: [{id: 'torrent|abc', title: 'X'}, ...items]}];
  const got = R.idleItems(rows as never);
  expect(got).toHaveLength(12);
  expect(got[0].id).toBe('i0');
  expect(R.idleItems(null)).toEqual([]);
  expect(R.cwPos({id: 'a', title: 'A', progress: {position: 90, duration: 600}})).toBe(90);
  expect(R.cwPos({id: 'a', title: 'A', progress: {position: 590, duration: 600, finished: true}})).toBe(0);
  expect(R.cwLabel({id: 'e', title: 'Ep', showId: 's', showTitle: 'Silo', season: 3, episode: 5})).toBe('Silo · S3 E5');
  expect(R.cwLabel({id: 'f', title: 'Arrival'})).toBe('Arrival');
});

test('the touchpad: a drag past 28 is an arrow, every 70 more another; a quick still touch is OK', () => {
  const s = R.swipeStart(100, 100, 0);
  expect(R.swipeMove(s, 110, 105)).toBe(null);
  expect(R.swipeMove(s, 135, 104)).toBe('right');
  expect(R.swipeMove(s, 190, 104)).toBe(null);
  expect(R.swipeMove(s, 206, 110)).toBe('right');
  expect(R.swipeMove(s, 260, 110)).toBe(null);
  expect(R.swipeMove(s, 277, 110)).toBe('right');
  expect(R.swipeEnd(s, 300)).toBe(null); // it moved: no OK
  const up = R.swipeStart(100, 300, 0);
  expect(R.swipeMove(up, 98, 260)).toBe('up');
  const t = R.swipeStart(50, 50, 1000);
  expect(R.swipeEnd(t, 1200)).toBe('ok');
  const held = R.swipeStart(50, 50, 1000);
  expect(R.swipeEnd(held, 1700)).toBe(null); // a long press is not a tap
});

test('the scrub bar, the subtitle timing, the volume', () => {
  expect(R.scrubAt(150, 300, 2700)).toBe(1350);
  expect(R.scrubAt(-20, 300, 2700)).toBe(0);
  expect(R.scrubAt(400, 300, 2700)).toBe(2700);
  expect(R.scrubAt(10, 0, 2700)).toBe(0);
  expect(R.share(30, 60)).toBe(0.5);
  expect(R.delayText(0)).toBe('0.0 s');
  expect(R.delayText(0.5)).toBe('+0.5 s');
  expect(R.delayText(-1)).toBe('-1.0 s');
  expect(R.nudged(0.2, 0.5)).toBe(0.7);
  expect(R.nudged(0.1, -0.5)).toBe(-0.4);
  expect(R.volumeScope('system')).toBe("The TV's volume");
  expect(R.volumeScope('player')).toBe("This player's volume");
  expect(R.volumeOk(tv('a', {state: {screen: 'home', appState: 'active', now: null, volume: {supported: true, level: 0.5, muted: false, scope: 'system'}}}))).toBe(true);
  expect(R.volumeOk(tv('a', {caps: {navigate: true, volume: false}, state: {screen: 'home', appState: 'active', now: null, volume: {supported: true, level: 0.5, muted: false, scope: 'system'}}}))).toBe(false);
  expect(R.volumeOk(tv('a'))).toBe(false);
});

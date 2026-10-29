// The phone app's pure rules (docs/android-phone/PLAN.md): what a finger means
// on the player, what a link opens, how a save to the phone is picked and
// described, Home's greeting.
import {decideDrag, deltaLabel, levelAfter, pinchVerdict, seekTarget, zoneOf, SEEK_SPAN_S} from '../../src/phone/player/gestures';
import {parsePhoneLink, shareLink} from '../../src/phone/linkParse';
import {fromNative, nextSaved, noRoomText, pickOption, roomFor, stateLine} from '../../src/phone/offline/rules';
import {greeting} from '../../src/phone/greeting';
import {isWeakPhone} from '../../src/phone/lowEnd';
import {HIDE_AFTER, nextShown, STEP} from '../../src/phone/ui/tabBarShown';
import {progressLine, shouldOffer, SNOOZE_MS} from '../../src/phone/update/rules';

describe('player gestures', () => {
  test('a drag says what it is only past a few px, sideways first', () => {
    expect(decideDrag(5, 3, 100, 400)).toBeNull();
    expect(decideDrag(30, 10, 100, 400)).toBe('seek');
    expect(decideDrag(-30, 29, 100, 400)).toBe('seek');
    expect(decideDrag(4, -40, 100, 400)).toBe('brightness'); // left half
    expect(decideDrag(4, -40, 300, 400)).toBe('volume'); // right half
  });
  test('a full-width scrub moves SEEK_SPAN_S, less for a short film, clamped', () => {
    expect(seekTarget(600, 400, 400, 7200)).toBe(600 + SEEK_SPAN_S);
    expect(seekTarget(30, 400, 400, 60)).toBe(59); // span 30 for a 60 s film, end-1
    expect(seekTarget(10, -400, 400, 7200)).toBe(0);
  });
  test('levels: up is more, clamped to 0..1', () => {
    expect(levelAfter(0.5, -70, 200)).toBeCloseTo(1);
    expect(levelAfter(0.5, 70, 200)).toBeCloseTo(0);
    expect(levelAfter(0.5, 0, 200)).toBe(0.5);
  });
  test('pinch: spread fills, close fits, in between nothing', () => {
    expect(pinchVerdict(100, 120)).toBe('fill');
    expect(pinchVerdict(100, 85)).toBe('fit');
    expect(pinchVerdict(100, 102)).toBeNull();
    expect(pinchVerdict(0, 300)).toBeNull();
  });
  test('zones and the scrub label', () => {
    expect(zoneOf(10, 300)).toBe('left');
    expect(zoneOf(150, 300)).toBe('middle');
    expect(zoneOf(290, 300)).toBe('right');
    expect(deltaLabel(80)).toBe('+1:20');
    expect(deltaLabel(-45)).toBe('−0:45');
    expect(deltaLabel(3725)).toBe('+1:02:05');
  });
});

describe('links into the app', () => {
  test('the website’s own addresses', () => {
    expect(parsePhoneLink('https://nufurora.com/#/movie/ab12cd')).toEqual({kind: 'item', action: 'detail', item: {id: 'ab12cd', title: '', type: 'movie', source: 'downloaded'}});
    expect(parsePhoneLink('https://www.nufurora.com/#/show/xyz')?.kind).toBe('item');
    expect(parsePhoneLink('https://nufurora.com/#/discover/series/tt0944947')).toMatchObject({kind: 'item', item: {imdbId: 'tt0944947', type: 'show', source: 'stream'}});
    expect(parsePhoneLink('https://nufurora.com/#/party/k2x9')).toEqual({kind: 'party', code: 'K2X9'});
    expect(parsePhoneLink('https://nufurora.com/#/search?q=the+bear')).toEqual({kind: 'search', q: 'the bear'});
    expect(parsePhoneLink('https://nufurora.com/#/remote')).toEqual({kind: 'screen', name: 'Remote'});
    expect(parsePhoneLink('https://nufurora.com/')).toBeNull();
    expect(parsePhoneLink('https://nufurora.com/#/')).toEqual({kind: 'tab', tab: 'home'});
  });
  test('another host, junk and bad ids are not opened', () => {
    expect(parsePhoneLink('https://evil.example/#/movie/ab12')).toBeNull();
    expect(parsePhoneLink('https://nufurora.com/#/discover/movie/notanid')).toBeNull();
    expect(parsePhoneLink('https://nufurora.com/#/movie/<script>')).toBeNull();
    expect(parsePhoneLink(null)).toBeNull();
  });
  test('the notification’s item links (the TV’s format) and the app’s own scheme', () => {
    const d = encodeURIComponent(JSON.stringify({id: 'e1', title: 'Pilot', season: 1, episode: 1}));
    expect(parsePhoneLink(`aurora://open?a=play&d=${d}`)).toMatchObject({kind: 'item', action: 'play', item: {id: 'e1'}});
    expect(parsePhoneLink(`aurora-phone://open?a=detail&d=${d}`)).toMatchObject({kind: 'item', action: 'detail'});
    expect(parsePhoneLink('aurora://open?a=play&d=%7Bbroken')).toBeNull();
    expect(parsePhoneLink('aurora-phone://movie/ab12cd')).toMatchObject({kind: 'item', item: {id: 'ab12cd'}});
  });
  test('share links round-trip', () => {
    const film = shareLink('https://nufurora.com', {id: 'ab12cd', type: 'movie', source: 'downloaded'})!;
    expect(film).toBe('https://nufurora.com/#/movie/ab12cd');
    expect(parsePhoneLink(film)).toMatchObject({kind: 'item', item: {id: 'ab12cd'}});
    expect(shareLink('https://nufurora.com/', {imdbId: 'tt1', type: 'show', source: 'stream'})).toBe('https://nufurora.com/#/discover/series/tt1');
    expect(shareLink('', {source: 'stream'})).toBeNull();
  });
});

describe('saving to the phone', () => {
  const options = [
    {quality: 'original', label: 'Original quality', sizeBytes: 4e9, instant: true},
    {quality: '720', label: '720p', sizeBytes: 1e9},
    {quality: '480', label: '480p', sizeBytes: 5e8},
  ];
  test('a remembered quality, the nearest smaller, else the smallest; ask asks', () => {
    expect(pickOption(options, 'ask')).toBeNull();
    expect(pickOption(options, '720')?.quality).toBe('720');
    expect(pickOption(options, '1080')?.quality).toBe('720');
    expect(pickOption(options.slice(1), 'original')?.quality).toBe('720');
    expect(pickOption([{quality: '720', label: '720p', sizeBytes: 1}], '480')?.quality).toBe('720');
    expect(pickOption([], '720')).toBeNull();
  });
  test('room: the size and 5% to spare; unknown free space never blocks', () => {
    expect(roomFor(1000, 2000)).toBe(true);
    expect(roomFor(1000, 1040)).toBe(false);
    expect(roomFor(1000, 0)).toBe(true);
    expect(noRoomText(2 * 1024 ** 3, 512 * 1024 ** 2)).toMatch(/needs about 2\.0 GB and 512 MB is free/);
  });
  test('DownloadManager’s states', () => {
    expect(fromNative({status: 'running', bytes: 50, total: 200})).toEqual({state: 'saving', pct: 0.25, waitingWifi: false});
    expect(fromNative({status: 'paused', bytes: 0, total: 0, reason: 3}).waitingWifi).toBe(true);
    expect(fromNative({status: 'done'}).state).toBe('done');
    expect(fromNative({status: 'failed', reason: 1006}).error).toMatch(/1006/);
    expect(fromNative({status: 'gone'}).state).toBe('gone');
  });
  test('the line a copy shows', () => {
    expect(stateLine({state: 'saving', pct: 0.42, sizeBytes: 1024 ** 3})).toBe('Saving to this phone · 42% of 1.0 GB');
    expect(stateLine({state: 'saving', waitingWifi: true})).toBe('Waiting for Wi-Fi');
    expect(stateLine({state: 'preparing', note: 'repackaging — a few seconds'})).toBe('Preparing on the server — repackaging — a few seconds');
    expect(stateLine({state: 'done', sizeBytes: 300 * 1024 ** 2})).toBe('On this phone · 300 MB');
    expect(stateLine({state: 'failed', error: 'no space'})).toBe("Couldn't save it — no space");
  });
  test('Up next among the saved copies', () => {
    const ep = (s: number, e: number, state = 'done') => ({showId: 'sh', season: s, episode: e, state: state as 'done'});
    const all = [ep(1, 1), ep(1, 3), ep(2, 1), ep(1, 2, 'saving'), {showId: 'other', season: 1, episode: 2, state: 'done' as const}];
    expect(nextSaved(all, all[0])).toBe(all[1]);
    expect(nextSaved(all, all[1])).toBe(all[2]);
    expect(nextSaved(all, all[2])).toBeNull();
    expect(nextSaved(all as {showId: string | null; season: number | null; episode: number | null; state: 'done'}[], {showId: null, season: null, episode: null, state: 'done'})).toBeNull();
  });
});

describe('Home’s greeting (the website’s words)', () => {
  test('the part of the day, and the day’s line', () => {
    expect(greeting('Dana', new Date(2026, 9, 28, 9)).line).toBe('Good morning, Dana');
    expect(greeting('Dana', new Date(2026, 9, 28, 14)).line).toBe('Good afternoon, Dana');
    expect(greeting('Dana', new Date(2026, 9, 28, 21)).line).toBe('Good evening, Dana');
    expect(greeting('Dana', new Date(2026, 9, 28, 2)).line).toBe('Up late, Dana?');
    expect(greeting('Dana', new Date(2026, 9, 30, 20)).sub).toBe('Friday. Movie night is legally required.');
    expect(greeting('Dana', new Date(2026, 9, 31, 12)).sub).toBe('Weekend. A double feature is fully justified.');
  });
});

describe('a weak phone (lowEnd.ts)', () => {
  const GB = 1024 ** 3;
  test('Android or perfTier says low-RAM, under 3.5 GB, or Android 8.1 and older', () => {
    expect(isWeakPhone(true, 8 * GB, 35)).toBe(true);
    expect(isWeakPhone(false, 3 * GB, 35)).toBe(true);
    expect(isWeakPhone(false, 4 * GB, 27)).toBe(true);
    expect(isWeakPhone(false, 4 * GB, 28)).toBe(false);
    expect(isWeakPhone(false, 8 * GB, 35)).toBe(false);
    // nothing known about the memory: not weak on that alone
    expect(isWeakPhone(false, undefined, 35)).toBe(false);
    expect(isWeakPhone(false, 0, 'ios')).toBe(false);
  });
});

describe('the tab bar steps aside while a page scrolls down (ui/tabBarShown.ts)', () => {
  test('down past the top hides it, any real step up brings it back, the top always shows it', () => {
    expect(nextShown(true, 0, 40)).toBe(true); // near the top
    expect(nextShown(true, 200, 260)).toBe(false); // scrolling down, well in
    expect(nextShown(false, 260, 262)).toBe(false); // a finger resting
    expect(nextShown(false, 600, 560)).toBe(true); // up again
    expect(nextShown(false, 300, HIDE_AFTER / 2)).toBe(true); // back at the top
    expect(nextShown(true, 100, 100 + STEP + 1)).toBe(true); // not yet past HIDE_AFTER
  });
});

describe('the phone app’s update offer (phone/update/rules.ts)', () => {
  test('a version is offered unless Later held that same version back, for a day', () => {
    const now = 1_000_000;
    expect(shouldOffer('1.0.1', null, now)).toBe(true);
    expect(shouldOffer('1.0.1', {version: '1.0.1', until: now + 1000}, now)).toBe(false);
    expect(shouldOffer('1.0.1', {version: '1.0.1', until: now - 1}, now)).toBe(true);
    expect(shouldOffer('1.0.2', {version: '1.0.1', until: now + SNOOZE_MS}, now)).toBe(true);
    expect(shouldOffer(null, null, now)).toBe(false);
  });
  test('the progress line', () => {
    expect(progressLine(0, 0)).toBe('Downloading…');
    expect(progressLine(21 * 1024 ** 2, 42 * 1024 ** 2)).toBe('Downloading… 50% of 42.0 MB');
    expect(progressLine(5 * 1024 ** 2, 0)).toBe('Downloading… 5.0 MB');
  });
});

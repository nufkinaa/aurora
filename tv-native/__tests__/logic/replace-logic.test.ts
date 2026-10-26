// "Problem with this copy? → Get another version" on the TV: the words and
// the small decisions (src/replaceLogic.ts), against the server's contract
// (src/media/replace.js, src/media/badreleases.js).
declare const __dirname: string;
import {
  REASONS,
  WORDS,
  reasonsOf,
  replaceFace,
  replaceJobLine,
  replaceOffered,
  replaceReasonText,
  replaceAsksFirst,
  replaceRowText,
  replaceStatusText,
  replaceWho,
  sourcesError,
} from '../../src/replaceLogic';

const fs = require('fs');
const path = require('path');

test('the five reasons are the server\'s, ids and labels letter for letter', () => {
  const src: string = fs.readFileSync(path.join(__dirname, '../../../src/media/badreleases.js'), 'utf8');
  const server = [...src.matchAll(/\{ id: "([a-z]+)", label: "([^"]+)" \}/g)].map(m => ({id: m[1], label: m[2]}));
  expect(server.length).toBe(5);
  expect(REASONS).toEqual(server);
  expect(REASONS.map(r => r.label)).toEqual(['Burned-in subtitles', 'Bad picture', 'Bad sound', 'Wrong language', 'Other']);
});

test('the words are the website\'s', () => {
  expect(WORDS.entry).toBe('Problem with this copy?');
  expect(WORDS.entrySub).toBe('Get another version');
  expect(WORDS.step1).toBe("What's wrong with this copy?");
  expect(WORDS.step1Body).toBe('Pick one. Another version replaces it — your place, My List and ratings stay.');
  expect(WORDS.step2).toBe('Get another version');
  expect(WORDS.step2Body).toBe('Your copy stays playable until the new one is in.');
  expect(WORDS.none).toBe('No other versions found.');
  expect(WORDS.started).toBe("Getting another version — your copy stays playable until it's in.");
  expect(WORDS.activeHeading).toBe('Another version is on its way');
  expect(WORDS.cancel).toBe('Cancel — keep this copy');
  expect(WORDS.cancelled).toBe('Cancelled — your copy stays as it was.');
});

test("a replacement's status line: the website's words, state by state", () => {
  expect(replaceStatusText({status: 'pending'})).toBe('Waiting for approval');
  expect(replaceStatusText({status: 'approved'})).toBe('Queued to download');
  expect(replaceStatusText({status: 'downloading', progress: 0})).toBe('Starting download…');
  expect(replaceStatusText({status: 'downloading'})).toBe('Starting download…');
  expect(replaceStatusText({status: 'downloading', progress: 0.454})).toBe('Downloading · 45%');
  expect(replaceStatusText({status: 'downloading', progress: 0.9, phase: 'copying'})).toBe('Almost there…');
  // finished and held back: says so, whatever the status
  expect(replaceStatusText({status: 'downloading', progress: 1, waiting: true})).toBe('Ready — it takes over once nobody is playing this copy.');
  expect(replaceStatusText({status: 'done'})).toBe('The new version is in.');
  expect(replaceStatusText({status: 'error'})).toBe('The download failed — your copy stays as it was.');
  expect(replaceStatusText({status: 'canceled'})).toBe('Cancelled — your copy stays as it was.');
  expect(replaceStatusText({status: 'declined'})).toBe('Cancelled — your copy stays as it was.');
  expect(replaceStatusText({status: 'something-new'})).toBe('');
  expect(replaceStatusText(null)).toBe('');
});

test("the status words are the website's (public/js/replaceCopy.js)", () => {
  const web: string = fs.readFileSync(path.join(__dirname, '../../../public/js/replaceCopy.js'), 'utf8');
  for (const w of [
    'Ready — it takes over once nobody is playing this copy.',
    'The new version is in.',
    'Waiting for approval',
    'Queued to download',
    'Almost there…',
    'Starting download…',
    'Downloading · ${pct}%',
    'The download failed — your copy stays as it was.',
    'Cancelled — your copy stays as it was.',
  ])
    expect(web).toContain(w);
});

test('the reason line, and who may cancel', () => {
  expect(replaceReasonText({reasonLabel: 'Burned-in subtitles'})).toBe('Reason: Burned-in subtitles');
  expect(replaceReasonText({})).toBe('');
  expect(replaceWho({mine: true, by: 'Dor'})).toEqual({cancel: true, line: null});
  expect(replaceWho({mine: false, by: 'Dor'})).toEqual({cancel: false, line: 'Asked for by Dor'});
  expect(replaceWho({mine: false, by: '  '})).toEqual({cancel: false, line: null});
  expect(replaceWho(null)).toEqual({cancel: false, line: null});
});

test('which face the sheet shows', () => {
  // before the server answers: the reasons (focus lands on the first at once)
  expect(replaceFace(null)).toBe('reasons');
  expect(replaceFace({can: true, active: null})).toBe('reasons');
  expect(replaceFace({can: false, why: "A kids profile can't replace a copy.", code: 'kids', active: null})).toBe('refused');
  // one on its way wins over "can't" (the server says can:false, code busy, then)
  expect(replaceFace({can: false, code: 'busy', active: {status: 'downloading'}})).toBe('active');
});

test("the server's reasons when it sent them, else the five", () => {
  expect(reasonsOf(null)).toBe(REASONS);
  expect(reasonsOf({reasons: []})).toBe(REASONS);
  expect(reasonsOf({reasons: [{id: 'x', label: 'X'}]})).toEqual([{id: 'x', label: 'X'}]);
  expect(reasonsOf({reasons: [null as never, {id: 'y', label: 'Y'}]})).toEqual([{id: 'y', label: 'Y'}]);
});

test('a source row: quality, size, seeders, release; ★ BEST; Reported here', () => {
  const r = replaceRowText({quality: '1080p', sizeString: '2.1 GB', seeders: 45, release: 'Film.2020.1080p.BluRay', recommended: true});
  expect(r).toEqual({quality: '1080p', name: 'Film.2020.1080p.BluRay', meta: '1080p · 2.1 GB · 45 seeders', best: '★ BEST', warn: null, early: null, tags: []});
  const bad = replaceRowText({quality: '720p', sizeBytes: 900 * 1024 ** 2, seeders: 1, release: 'Film.HC', badHere: {reason: 'burned', label: 'Burned-in subtitles'}, cam: true, dubbed: true});
  expect(bad.meta).toBe('720p · 900 MB · 1 seeder');
  expect(bad.best).toBeNull();
  expect(bad.warn).toBe('Reported here: Burned-in subtitles');
  expect(bad.tags).toEqual(['Cam', 'Dub']);
  // the server's marks for what kind of copy it is (releasekind.js): its badge as a tag, its words as a line
  const ts = replaceRowText({quality: '1080p', release: 'Film.2026.HDTS.x264', cam: true, prerelease: 'telesync', badge: 'TS', warning: 'TS — recorded in a cinema', recommended: true});
  expect(ts.tags).toEqual(['TS']);
  expect(ts.early).toBe('TS — recorded in a cinema');
  expect(ts.best).toBeNull(); // never ★ on a pre-release copy, whatever an old server said
  expect(replaceAsksFirst({cam: true})).toBe(true);
  expect(replaceAsksFirst({hardsub: true})).toBe(false);
  expect(replaceAsksFirst({})).toBe(false);
  const hs = {quality: '1080p', release: 'Film.2020.KORSUB.1080p', hardsub: true, badge: 'BURNED-IN SUBS', warning: 'Subtitles burned into the picture', recommended: true};
  expect(replaceRowText(hs).tags).toEqual(['BURNED-IN SUBS']);
  expect(replaceRowText(hs).early).toBe('Subtitles burned into the picture');
  expect(replaceRowText(hs).best).toBe('★ BEST');
  // replacing a copy BECAUSE of burned-in subtitles: another such copy is never the ★
  expect(replaceRowText(hs, 'burned').best).toBeNull();
  expect(replaceRowText(hs, 'picture').best).toBe('★ BEST');
  // nothing known: still a row
  expect(replaceRowText({}).quality).toBe('SD');
  expect(replaceRowText({filename: 'film.mkv'}).name).toBe('film.mkv');
});

test("the source list's failure: the server's words, else the fallback", () => {
  expect(sourcesError(new Error('Torrent sources are off on this server.'))).toBe('Torrent sources are off on this server.');
  expect(sourcesError(new Error('502 /api/replace/abc/sources'))).toBe("Couldn't reach the source provider.");
  expect(sourcesError(null)).toBe("Couldn't reach the source provider.");
  expect(sourcesError(new Error(''))).toBe("Couldn't reach the source provider.");
});

test('offered on a library copy only — never a torrent stream, never a title not on disk', () => {
  expect(replaceOffered({libraryId: 'a1b2c3'})).toBe(true);
  expect(replaceOffered({libraryId: 'a1b2c3', isTorrent: true})).toBe(false);
  expect(replaceOffered({libraryId: 'torrent|abc|0'})).toBe(false);
  expect(replaceOffered({libraryId: null})).toBe(false);
  expect(replaceOffered({libraryId: undefined})).toBe(false);
});

test("hidden for a kids profile and while torrents are off (the website's canOfferReplace)", () => {
  expect(replaceOffered({libraryId: 'a1b2c3', kids: {maxAge: 12}})).toBe(false);
  expect(replaceOffered({libraryId: 'a1b2c3', kids: null})).toBe(true);
  expect(replaceOffered({libraryId: 'a1b2c3', kids: undefined, torrentsOff: false})).toBe(true);
  expect(replaceOffered({libraryId: 'a1b2c3', torrentsOff: true})).toBe(false);
  // all three places pass the gate (the profile's kids, the server's torrents switch)
  const read = (p: string): string => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');
  const detail = read('screens/Detail.tsx');
  expect(detail).toContain('replaceOffered({libraryId: ownedMovieId, ...replaceGate})');
  expect(detail).toContain('replaceOffered({libraryId: ep.epId, ...replaceGateRef.current})');
  expect(detail).toContain('const replaceGate = {kids: me?.kids, torrentsOff};');
  expect(read('playback/Player.tsx')).toContain('isTorrent, kids: me?.kids, torrentsOff})');
});

test('My downloads: a replacement held back says so instead of its phase', () => {
  expect(replaceJobLine({status: 'downloading', replaceWait: true})).toBe('Ready — waiting for nobody to be playing the old copy');
  expect(replaceJobLine({status: 'downloading', replaceWait: false})).toBeNull();
  expect(replaceJobLine({status: 'downloading'})).toBeNull();
  // over (landed, failed, cancelled): its own line again
  expect(replaceJobLine({status: 'done', replaceWait: true})).toBeNull();
  expect(replaceJobLine({status: 'canceled', replaceWait: true})).toBeNull();
});

test('every entry point and the sheet carry the uiIds the server vocabulary knows', () => {
  const read = (p: string): string => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');
  expect(read('screens/Detail.tsx')).toContain('uiId="detail.replace"');
  expect(read('screens/Detail.tsx')).toContain("uiId: 'detail.episode.replace'");
  expect(read('playback/Player.tsx')).toContain('uiId="player.replace"');
  const sheet = read('components/ReplaceSheet.tsx');
  for (const id of ['replace.reason', 'replace.pick', 'replace.cancel']) expect(sheet).toContain(`uiId="${id}"`);
});

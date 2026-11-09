// "Fix timing" and its way back, and the Hebrew track the server translates
// with AI (2026-11-09) — the TV's and the phone's player (the phone uses this
// player as it is): the menu's words, when the file's own timing is offered,
// the toasts, and the translated track arriving mid-film and switching on for
// the viewer who was waiting for Hebrew (playback/resync.ts, subTracks.ts).
import {bestTrackIndex, langOf} from '../../src/lang';
import {autoPick, buildTracks, followPick, PickPrefs} from '../../src/playback/subTracks';
import {
  aiPendingToast,
  foundToast,
  mergeSubInfo,
  ORIGINAL_TIMING,
  resyncMode,
  resyncRowLabel,
  undoable,
  UNDO_LABEL,
} from '../../src/playback/resync';

const P = (o: Partial<PickPrefs> = {}): PickPrefs => ({
  subsDefault: true,
  subLang: 'he',
  lastSubSet: false,
  lastSubLang: null,
  lastSubLabel: null,
  lastSubProfile: null,
  ...o,
});

describe('Fix timing (the website’s words)', () => {
  test('a library track: "Fix timing", "Listening to the film…" while it runs; a stream’s: "Reload subtitles"', () => {
    const lib = resyncMode({isTorrent: false, url: '/stream/subtitle/abc'});
    expect(resyncRowLabel(lib, false)).toBe('⟲  Fix timing');
    expect(resyncRowLabel(lib, true)).toBe('⟲  Listening to the film…');
    expect(resyncRowLabel(resyncMode({isTorrent: true, url: '/stream/torrent/x/0/sub'}), false)).toBe('⟲  Reload subtitles');
    expect(resyncRowLabel(resyncMode({isTorrent: false, url: 'file:///sdcard/x.srt'}), false)).toBe('⟲  Reload subtitles');
  });
  test('the file’s own timing is offered when the track is served moved — by a Fix timing or by the server’s own check', () => {
    expect(undoable('audio', {verdict: 'moved', by: 'audio', resync: true})).toBe(true);
    expect(undoable('audio', {verdict: 'moved', by: 'audio'})).toBe(true); // the background, sure of it
    expect(undoable('audio', {verdict: 'parts', by: 'audio'})).toBe(true);
    expect(undoable('audio', {verdict: 'moved', by: 'track'})).toBe(true);
    for (const v of ['in-time', 'unmatched', 'original']) expect(undoable('audio', {verdict: v})).toBe(false);
    expect(undoable('audio', null)).toBe(false);
    expect(undoable('audio', undefined)).toBe(false);
    expect(undoable('reload', {verdict: 'moved'})).toBe(false);
    expect(UNDO_LABEL).toBe("↺  Use the file's own timing");
  });
  test('after the way back the track reads as the original, and the row goes away', () => {
    expect(ORIGINAL_TIMING.verdict).toBe('original');
    expect(undoable('audio', ORIGINAL_TIMING)).toBe(false);
  });
});

describe('the Hebrew track translated with AI', () => {
  const english = {label: 'English', url: '/stream/subtitle/en', lang: 'en'};
  const ai = {label: 'עברית (AI)', url: '/stream/subtitle/ai', lang: 'he', ai: true};

  test('the fetch’s answer: a toast only while one is being translated', () => {
    expect(aiPendingToast({tracks: [], ai: 'translating'})).toBe('No Hebrew subtitles yet — translating with AI, ready in a few minutes');
    expect(aiPendingToast({tracks: [], ai: 'queued'})).not.toBeNull();
    expect(aiPendingToast({tracks: []})).toBeNull();
    expect(aiPendingToast({tracks: [english], ai: 'translating'})).toBeNull();
    expect(aiPendingToast(null)).toBeNull();
  });
  test('its name is the server’s, the same everywhere, and it IS Hebrew to the auto pick', () => {
    const tracks = buildTracks([english, ai]);
    expect(tracks.map(t => t.label)).toEqual(['English', 'עברית (AI)']);
    expect(langOf(ai)).toBe('he');
    // (an older server without the lang tag: the label alone says Hebrew)
    expect(langOf({label: 'עברית (AI)'})).toBe('he');
  });
  test('it arrives mid-film (subtitle_sync): added at the end, the menu keys unchanged, and the waiting pick switches it on', () => {
    const before = [english];
    const p0 = autoPick(buildTracks(before), P(), 'me');
    // nothing in Hebrew yet: the first track, waiting for Hebrew
    expect(p0.index).toBe(0);
    expect(p0.upgradeTo).toBe('he');
    const merged = mergeSubInfo(before, [english, ai]);
    expect(merged.map(t => t.url)).toEqual(['/stream/subtitle/en', '/stream/subtitle/ai']);
    const tracks = buildTracks(merged);
    expect(tracks[0].key).toBe('English');
    const p1 = autoPick(tracks, P(), 'me');
    expect(tracks[p1.index].label).toBe('עברית (AI)');
    const step = followPick({first: false, cur: 'English', curUsable: true, pickKey: tracks[p1.index].key});
    expect(step).toEqual({change: true, key: 'עברית (AI)', announce: true});
    expect(foundToast(tracks[p1.index], 'Hebrew')).toBe('Hebrew subtitles translated with AI — switched on');
    expect(foundToast({label: 'Hebrew'}, 'Hebrew')).toBe('Hebrew subtitles found — switched on');
    expect(foundToast({label: 'x'}, null)).toBe('Subtitles found — switched on');
  });
  test('a remembered pick of another language, or "off", is not overruled by it', () => {
    const tracks = buildTracks([english, ai]);
    expect(autoPick(tracks, P(), 'me', 'en').index).toBe(0);
    expect(autoPick(tracks, P(), 'me', 'off').index).toBe(-1);
  });
  test('a person’s Hebrew file listed before it is the one picked (the server lists the AI track after them)', () => {
    const he = {label: 'Hebrew', url: '/stream/subtitle/he', lang: 'he'};
    expect(bestTrackIndex([english, he, ai], 'he')).toBe(1);
  });
});

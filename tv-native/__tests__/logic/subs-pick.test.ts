// Which subtitle track switches on by itself, how tracks and dubs are named
// (playback/subTracks.ts), and lang.ts's ranking with the server's flags.
import {bestTrackIndex, trackRank} from '../../src/lang';
import {
  audioLabel,
  audioName,
  audioTitleExtra,
  autoPick,
  buildTracks,
  followPick,
  hasLang,
  langName,
  PickPrefs,
  rememberedPick,
  subLabel,
} from '../../src/playback/subTracks';

const P = (o: Partial<PickPrefs> = {}): PickPrefs => ({
  subsDefault: true,
  subLang: 'any',
  lastSubSet: false,
  lastSubLang: null,
  lastSubLabel: null,
  lastSubProfile: null,
  ...o,
});
const T = (label: string, extra: Record<string, unknown> = {}) => ({label, url: `/s/${label}`, ...extra});

describe('what was last picked by hand', () => {
  test('the profile’s own memory first', () => {
    expect(rememberedPick(P(), 'dor', 'he')).toBe('he');
    expect(rememberedPick(P(), 'dor', 'Hebrew 2')).toBe('he'); // an older build's label
    expect(rememberedPick(P({lastSubSet: true, lastSubLang: 'en', lastSubProfile: 'dor'}), 'dor', 'off')).toBe('off');
  });
  test('this box’s copy only for the person who made it', () => {
    const elias = P({lastSubSet: true, lastSubLang: null, lastSubProfile: 'elia'}); // elia pressed Off on this TV
    expect(rememberedPick(elias, 'elia', null)).toBe('off');
    expect(rememberedPick(elias, 'dor', null)).toBeNull(); // Dor: nothing remembered
    const mine = P({lastSubSet: true, lastSubLang: 'ru', lastSubProfile: 'dor'});
    expect(rememberedPick(mine, 'dor', null)).toBe('ru');
  });
  test('a copy from a build before lastSubProfile names nobody', () => {
    expect(rememberedPick(P({lastSubSet: true, lastSubLang: null, lastSubProfile: null}), 'dor', null)).toBeNull();
    expect(rememberedPick(P({lastSubSet: true, lastSubLang: 'en', lastSubProfile: null}), 'dor', null)).toBeNull();
  });
  test('never set, or unreadable', () => {
    expect(rememberedPick(P(), 'dor', null)).toBeNull();
    expect(rememberedPick(P(), 'dor', 'Track 4')).toBeNull();
    expect(rememberedPick(P({lastSubSet: true, lastSubLang: 'en', lastSubProfile: 'dor'}), null, null)).toBeNull();
  });
});

describe('the auto pick', () => {
  const tracks = [T('English'), T('Hebrew (Forced)'), T('Hebrew'), T('Russian')];

  test('Dor: default language Hebrew, someone else turned subtitles off on this TV', () => {
    const box = P({subLang: 'he', lastSubSet: true, lastSubLang: null, lastSubProfile: 'elia'});
    expect(autoPick(tracks, box, 'dor', null)).toEqual({index: 2, upgradeTo: null, why: 'setting'});
    // …and for elia, who did press Off, it stays off
    expect(autoPick(tracks, box, 'elia', null).index).toBe(-1);
  });

  test('a remembered language wins over Settings; "off" stays off', () => {
    expect(autoPick(tracks, P({subLang: 'he'}), 'dor', 'ru')).toMatchObject({index: 3, why: 'remembered'});
    expect(autoPick(tracks, P({subLang: 'he'}), 'dor', 'off')).toEqual({index: -1, upgradeTo: null, why: 'off'});
  });

  test('a full track before forced, whatever the order (lang.ts bestTrackIndex)', () => {
    expect(autoPick(tracks, P({subLang: 'he'}), 'x').index).toBe(2);
    // the server's flags count too
    const flagged = [T('Hebrew', {lang: 'he', forced: true}), T('Hebrew 2', {lang: 'he', sdh: true}), T('Hebrew 3', {lang: 'he'})];
    expect(autoPick(flagged, P({subLang: 'he'}), 'x').index).toBe(2);
  });

  test('"First available", or a title with nothing in the language: the first track — and wait for the language', () => {
    expect(autoPick(tracks, P(), 'x')).toEqual({index: 0, upgradeTo: null, why: 'first'});
    expect(autoPick([T('English'), T('French')], P({subLang: 'he'}), 'x')).toEqual({index: 0, upgradeTo: 'he', why: 'first'});
  });

  test('a remembered language the title lacks: Settings decide, the remembered one is waited for', () => {
    expect(autoPick([T('English'), T('Hebrew')], P({subLang: 'he'}), 'x', 'ru')).toEqual({index: 1, upgradeTo: 'ru', why: 'setting'});
    expect(autoPick([T('English')], P({subsDefault: false}), 'x', 'he')).toEqual({index: -1, upgradeTo: 'he', why: 'subs-off'});
  });

  test('subtitles not on by themselves', () => {
    expect(autoPick(tracks, P({subsDefault: false, subLang: 'he'}), 'x')).toEqual({index: -1, upgradeTo: null, why: 'subs-off'});
  });

  test('untagged library labels and torrent file names are read as languages', () => {
    const lib = [T('Subtitles'), T('Track 3'), T('Movie.2020.1080p.HEB'), T('ENG SDH')];
    expect(autoPick(lib, P({subLang: 'he'}), 'x').index).toBe(2);
    expect(autoPick(lib, P({subLang: 'en'}), 'x').index).toBe(3);
    expect(hasLang(lib, 'he')).toBe(true);
    expect(hasLang([T('HEB')], 'he')).toBe(true); // the old regex knew only "hebrew"
    expect(hasLang([T('English')], 'he')).toBe(false);
    expect(hasLang(undefined, 'he')).toBe(false);
  });

  test('nothing yet', () => {
    expect(autoPick([], P({subLang: 'he'}), 'x')).toEqual({index: -1, upgradeTo: 'he', why: 'none'});
  });
});

describe('following the tracks as they arrive', () => {
  // the Player's effect, step by step: autoPick on what is there, followPick on what is on
  const run = (batches: {label: string; lang?: string; url?: string}[][], prefs: PickPrefs, failed: string[] = []) => {
    let cur: string | null = null;
    let first = true;
    const said: string[] = [];
    let list: ReturnType<typeof buildTracks> = [];
    const all: {label: string; url: string; lang?: string}[] = [];
    for (const b of batches) {
      for (const t of b) all.push({url: `/s/${t.label}`, ...t});
      list = buildTracks(all);
      const usable = list.filter(t => !failed.includes(t.url));
      const p = autoPick(usable, prefs, 'dor', null);
      const step = followPick({first, cur, curUsable: !!cur && usable.some(t => t.key === cur), pickKey: p.index >= 0 ? usable[p.index].key : null});
      first = false;
      if (step.change) cur = step.key;
      if (step.announce) said.push(`${cur} switched on`);
    }
    return {cur, said};
  };

  test('a stream: the torrent’s English file first, OpenSubtitles’ Hebrew a moment later', () => {
    const r = run([[{label: 'Movie.2019.English'}], [{label: 'Hebrew', lang: 'he'}, {label: 'English 2', lang: 'en'}]], P({subLang: 'he'}));
    expect(r).toEqual({cur: 'Hebrew', said: ['Hebrew switched on']});
  });

  test('the server’s fetch for a missing language lands into a file with no subtitles at all', () => {
    expect(run([[], [{label: 'Hebrew', lang: 'he'}]], P({subLang: 'he'})).cur).toBe('Hebrew');
  });

  test('nothing better comes: the first pick stays, nothing is announced', () => {
    expect(run([[{label: 'English'}], [{label: 'French'}]], P({subLang: 'he'}))).toEqual({cur: 'English', said: []});
  });

  test('never switched OFF by itself', () => {
    expect(followPick({first: false, cur: 'English', curUsable: true, pickKey: null})).toEqual({change: false, key: 'English', announce: false});
    // the first decision can be off
    expect(followPick({first: true, cur: null, curUsable: false, pickKey: null})).toEqual({change: true, key: null, announce: false});
  });

  test('a track that failed to load is passed over, quietly', () => {
    expect(followPick({first: false, cur: 'Hebrew', curUsable: false, pickKey: 'Hebrew (2)'})).toEqual({change: true, key: 'Hebrew (2)', announce: false});
    expect(followPick({first: false, cur: 'Hebrew', curUsable: false, pickKey: null})).toEqual({change: true, key: null, announce: false});
    const r = run([[{label: 'Hebrew', url: '/dead'}, {label: 'Hebrew', url: '/ok'}]], P({subLang: 'he'}), ['/dead']);
    expect(r.cur).toBe('Hebrew (2)');
  });
});

describe('subtitle track names', () => {
  test('the server’s label is kept', () => {
    expect(subLabel(T('English (SDH)', {lang: 'en', sdh: true}), 0)).toBe('English (SDH)');
    expect(subLabel(T('Spanish (Latin America)', {lang: 'es'}), 0)).toBe('Spanish (Latin America)');
  });
  test('an older server’s "Track N" / "Subtitles" with a known lang shows the language', () => {
    expect(subLabel(T('Track 4', {lang: 'fr'}), 3)).toBe('French');
    expect(subLabel(T('Track 4', {lang: 'heb', forced: true}), 3)).toBe('Hebrew (Forced)');
    expect(subLabel(T('Subtitles', {lang: 'en', sdh: true}), 0)).toBe('English (SDH)');
    expect(subLabel(T('Track 4', {lang: 'und'}), 3)).toBe('Track 4');
    expect(subLabel(T('', {}), 6)).toBe('Track 7');
  });
  test('one row per file, never two that read the same, keys stable as tracks arrive', () => {
    const a = buildTracks([T('English'), {label: 'English', url: '/s/en2'}, T('English'), {label: 'Track 2', url: '/s/t2', lang: 'en'}]);
    expect(a.map(t => [t.label, t.key])).toEqual([
      ['English', 'English'],
      ['English (2)', 'English (2)'],
      ['English (3)', 'English (3)'],
    ]);
    const b = buildTracks([T('English'), {label: 'English', url: '/s/en2'}, {label: 'Track 2', url: '/s/t2', lang: 'en'}, T('Hebrew')]);
    expect(b.slice(0, 3).map(t => t.key)).toEqual(a.map(t => t.key));
  });
});

describe('lang.ts trackRank reads the server’s flags (mirrored in public/js/lang.js)', () => {
  test('flags add to the label rules, never take away', () => {
    expect(trackRank({label: 'Hebrew', forced: true})).toBe(2);
    expect(trackRank({label: 'Hebrew', sdh: true})).toBe(1);
    expect(trackRank({label: 'Hebrew', forced: true, sdh: true})).toBe(2);
    expect(trackRank({label: 'English [Forced]', forced: false})).toBe(2);
    expect(trackRank({label: 'English - SDH', sdh: false})).toBe(1);
    expect(trackRank({label: 'Hebrew'})).toBe(0);
    expect(trackRank(null)).toBe(0);
  });
  test('bestTrackIndex with flagged tracks', () => {
    const list = [
      {label: 'English (Forced)', lang: 'en', forced: true},
      {label: 'English (SDH)', lang: 'en', sdh: true},
      {label: 'English', lang: 'en'},
    ];
    expect(bestTrackIndex(list, 'en')).toBe(2);
    expect(bestTrackIndex(list.slice(0, 2), 'en')).toBe(1);
  });
});

describe('dub names', () => {
  test('languages: 2- and 3-letter codes, the old "iw", "und"', () => {
    expect(langName('he')).toBe('Hebrew');
    expect(langName('heb')).toBe('Hebrew');
    expect(langName('iw')).toBe('Hebrew');
    expect(langName('he-IL')).toBe('Hebrew');
    expect(langName('ENG')).toBe('English');
    expect(langName('fre')).toBe('French');
    expect(langName('xyz')).toBe('XYZ');
    expect(langName('und')).toBe('');
    expect(langName('')).toBe('');
    expect(langName(null)).toBe('');
    expect(langName('english')).toBe('English');
  });
  test('a title that says nothing is dropped', () => {
    for (const title of ['Track 1', 'Stereo', '5.1', 'AC3 5.1', 'DTS-HD MA 7.1', 'E-AC-3 5.1 @ 640 kbps'.replace(' @', ''), 'Surround 5.1', 'English', 'eng', 'English 5.1', 'FGT', 'YTS.MX', '[RARBG]', 'x264-SPARKS', 'Audio', 'Main', ''])
      expect([title, audioTitleExtra(title, 'English', 'eng')]).toEqual([title, '']);
  });
  test('a title that says something is kept', () => {
    expect(audioTitleExtra('Commentary', 'English', 'eng')).toBe('Commentary');
    expect(audioTitleExtra("Director's Commentary", 'English', 'eng')).toBe("Director's Commentary");
    expect(audioTitleExtra('MVO', 'Russian', 'rus')).toBe('MVO');
    expect(audioTitleExtra('AD', 'English', 'eng')).toBe('AD');
  });
  test('the fallback name', () => {
    expect(audioLabel({index: 0, language: 'eng', title: 'Stereo'})).toBe('English');
    expect(audioLabel({index: 1, language: 'eng', title: 'Commentary'})).toBe('English · Commentary');
    expect(audioLabel({index: 1, language: 'eng', title: 'English Commentary'})).toBe('English Commentary');
    expect(audioLabel({index: 2, language: 'iw', title: 'Track 3'})).toBe('Hebrew');
    expect(audioLabel({index: 2, language: 'und', title: 'Track 3'})).toBe('Track 3');
    expect(audioLabel({index: 2, language: 'und', title: 'FGT'})).toBe('Track 3');
    expect(audioLabel({index: 0, language: null, title: null})).toBe('Track 1');
    expect(audioLabel({index: 0, language: 'jpn', title: 'Japanese 5.1'})).toBe('Japanese');
  });
  test('the server’s label wins when it sends one', () => {
    expect(audioName({index: 1, language: 'eng', title: 'Stereo', label: 'English · Commentary'})).toBe('English · Commentary');
    expect(audioName({index: 1, language: 'heb', title: 'Dubbed', label: '  '})).toBe('Hebrew · Dubbed');
  });
});

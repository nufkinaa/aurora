// [household] Household recommendations on the TV (src/householdRecs.ts,
// src/householdLive.ts): the words are the table's and the server's to the
// letter (docs/qa/household-recs/DESIGN.md "Words"; src/media/household.js
// `names` / `fromLine` / `cleanNote`), the picker's rules, the key of a title
// and what a send carries, the Show all tile, and the arrival toast — said
// once per arrival.
import {
  arrivalToast,
  bannerLine,
  cleanNote,
  filterOptions,
  fromLine,
  isShowAll,
  names,
  newestAt,
  newLine,
  noteCounter,
  noteLine,
  notesOf,
  pickable,
  pickerTitle,
  sendLabel,
  sendStatus,
  sendTitle,
  sendToast,
  keepPickable,
  offeredNote,
  sentLine,
  showAllTile,
  statusWord,
  titleKey,
  titleName,
  titleType,
  togglePick,
  toSend,
  typedNote,
  withShowAll,
  NOTE_MAX,
  ROW_MAX,
  WORDS,
  PickPerson,
} from '../../src/householdRecs';

declare const __dirname: string;
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
// The server's own word functions, from its source as it is (run as plain CommonJS — not
// through this config's babel, whose helpers live in tv-native/node_modules). Its requires
// are all inside realDeps(), which is never called here: nothing of the server starts.
const server = (() => {
  const src: string = fs.readFileSync(path.join(ROOT, 'src', 'media', 'household.js'), 'utf8');
  const mod = {exports: {} as Record<string, any>}; // eslint-disable-line @typescript-eslint/no-explicit-any
  const noRequire = (m: string) => {
    throw new Error(`the server's ${m} is not loaded in this test`);
  };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', src)(mod, mod.exports, noRequire);
  return mod.exports;
})();
const DESIGN: string = fs.readFileSync(path.join(ROOT, 'docs', 'qa', 'household-recs', 'DESIGN.md'), 'utf8');

describe('the words', () => {
  test('names / fromLine: the server’s, for 0 to 5 people', () => {
    const all = ['Dana', 'Avi', 'Noa', 'Ben', 'Eve'];
    for (let n = 0; n <= all.length; n++) {
      const list = all.slice(0, n);
      expect(names(list)).toBe(server.names(list));
      expect(fromLine(list)).toBe(server.fromLine(list));
    }
    expect(fromLine(['Dana'])).toBe('From Dana');
    expect(fromLine(['Dana', 'Avi'])).toBe('From Dana and Avi');
    expect(fromLine(['Dana', 'Avi', 'Noa'])).toBe('From Dana and 2 others');
  });
  test('every fixed word is in the design’s Words table', () => {
    const table = DESIGN.slice(DESIGN.indexOf('## Words'));
    for (const [k, v] of Object.entries(WORDS)) {
      // (the doc writes the apostrophes as typed: straight)
      expect({k, inTable: table.includes(v)}).toEqual({k, inTable: true});
    }
  });
  test('the lines that carry names and numbers', () => {
    expect(newLine(0)).toBe('');
    expect(newLine(1)).toBe('1 new');
    expect(newLine(3)).toBe('3 new');
    expect(bannerLine([{name: 'Dana'}, {name: 'Avi'}])).toBe('Recommended by Dana and Avi');
    expect(bannerLine([])).toBe('');
    expect(bannerLine([{name: 'Dana'}, {name: 'Dana'}])).toBe('Recommended by Dana'); // a name once
    expect(noteLine('Watch it with the sound up', 'Dana')).toBe('“Watch it with the sound up” — Dana');
    expect(notesOf([{name: 'Dana', note: 'Loved it'}, {name: 'Avi', note: ''}, {name: 'Noa', note: '  '}])).toEqual(['“Loved it” — Dana']);
    expect(pickerTitle('Dune')).toBe('Recommend “Dune”');
    expect(sendLabel(0)).toBe('Send');
    expect(sendLabel(1)).toBe('Send to 1');
    expect(sendLabel(3)).toBe('Send to 3');
    expect(DESIGN).toContain('Send to N');
    expect(DESIGN).toContain('Recommend “<title>”');
    expect(DESIGN).toContain('“note” — Dana');
  });
  test('the sent statuses (server: sent · seen · added · watching · watched)', () => {
    expect(['sent', 'seen', 'added', 'watching', 'watched'].map(statusWord)).toEqual(['Sent', 'Seen', 'In their list', 'Watching', 'Watched']);
    expect(DESIGN).toContain('Sent · Seen · In their list · Watching · Watched');
    expect(statusWord('something new')).toBe('Sent');
    expect(sentLine([{name: 'Dana', status: 'seen'}, {name: 'Avi', status: 'watched'}])).toBe('Dana · Seen   Avi · Watched');
  });
  test('the filter: Everyone, then each person', () => {
    expect(filterOptions([{id: 'a', name: 'Dana'}])).toEqual([{id: '', label: 'Everyone'}, {id: 'a', label: 'Dana'}]);
    expect(filterOptions(null)).toEqual([{id: '', label: 'Everyone'}]);
  });
});

describe('the note', () => {
  test('cleaned exactly as the server cleans it', () => {
    const cases = ['', '  hi  ', 'line\nbreak', 'tab\there', 'x'.repeat(200), '😀'.repeat(150), 'a\u2028b', 'ctrl\u0007char'];
    for (const c of cases) expect(cleanNote(c)).toBe(server.cleanNote(c));
    expect(NOTE_MAX).toBe(server.NOTE_MAX);
    expect(ROW_MAX).toBe(server.ROW_MAX);
  });
  test('while typing: line breaks folded, cut at 140 code points; the counter counts code points', () => {
    expect(typedNote('a\nb')).toBe('a b');
    expect(Array.from(typedNote('😀'.repeat(200))).length).toBe(140);
    expect(noteCounter('')).toBe('0/140');
    expect(noteCounter('😀😀')).toBe('2/140');
    expect(noteCounter(typedNote('x'.repeat(300)))).toBe('140/140');
  });
});

describe('the picker', () => {
  const p = (id: string, state: string): PickPerson => ({id, name: id, state});
  test('ok and "already has it from you" can be picked; greyed ones never', () => {
    for (const s of ['ok', 'sent']) expect(pickable({state: s})).toBe(true);
    for (const s of ['seen', 'kids', 'off', 'limit']) expect(pickable({state: s})).toBe(false);
  });
  test('OK toggles; a greyed face stays as it is; several at once', () => {
    let s = new Set<string>();
    s = togglePick(s, p('dana', 'ok'));
    s = togglePick(s, p('avi', 'sent'));
    s = togglePick(s, p('noa', 'kids'));
    expect([...s].sort()).toEqual(['avi', 'dana']);
    s = togglePick(s, p('dana', 'ok'));
    expect([...s]).toEqual(['avi']);
  });
  test('only who can still get it is sent', () => {
    const people = [p('dana', 'ok'), p('avi', 'limit')];
    expect(toSend(new Set(['dana', 'avi', 'gone']), people)).toEqual(['dana']);
  });
});

describe('after a send (the website’s recommend.js, to the letter)', () => {
  const limitAvi = {to: 'b', name: 'Avi', reason: 'limit', line: 'You can recommend more to Avi in 23 min'};
  test('something went: one toast — the server’s line, then the refused lines, joined by " · "', () => {
    expect(sendToast({sent: [{to: 'a', name: 'Dana'}], refused: [limitAvi], line: 'Recommended to Dana'})).toBe(
      'Recommended to Dana · You can recommend more to Avi in 23 min',
    );
    expect(sendToast({sent: [{to: 'a', name: 'Dana'}], refused: [], line: 'Recommended to Dana'})).toBe('Recommended to Dana');
  });
  test('nothing went: no toast; the sheet says the refusals', () => {
    const a = {
      sent: [],
      refused: [
        {to: 'a', name: 'Dana', reason: 'limit', line: 'You can recommend more to Dana in 23 min'},
        {to: 'n', name: 'Noa', reason: 'kids', line: "Not for Noa's age"},
      ],
      line: 'You can recommend more to Dana in 23 min',
    };
    expect(sendToast(a)).toBe('');
    expect(sendStatus(a)).toBe("You can recommend more to Dana in 23 min · Not for Noa's age");
    expect(sendStatus({sent: [], refused: [], line: ''})).toBe('Nothing was sent');
    expect(sendToast(null)).toBe('');
  });
  test('the faces read again: who can no longer be picked is let go', () => {
    const people: PickPerson[] = [{id: 'a', name: 'Dana', state: 'limit'}, {id: 'b', name: 'Avi', state: 'ok'}];
    expect([...keepPickable(new Set(['a', 'b']), people)]).toEqual(['b']);
  });
  test('the note a person already has from you is offered back', () => {
    expect(offeredNote([{id: 'a', name: 'Dana', state: 'ok'}, {id: 'b', name: 'Avi', state: 'sent', note: 'Watch it!'}])).toBe('Watch it!');
    expect(offeredNote([{id: 'a', name: 'Dana', state: 'sent'}])).toBe('');
    expect(offeredNote(null)).toBe('');
  });
});

describe('a title: its key and what a send carries', () => {
  test('the IMDb id when there is one — the server’s keyOf', () => {
    expect(titleKey({id: 'abc123', imdbId: 'tt0816692', type: 'movie'})).toBe('tt0816692');
    expect(titleKey({id: 'abc123', type: 'movie'})).toBe(server.keyOf({id: 'abc123'}));
    expect(titleKey({id: 'abc123', type: 'movie'})).toBe('lib:abc123');
    expect(titleKey({id: 'abc123', type: 'movie'}, 'tt1375666')).toBe('tt1375666');
    // a catalogue card: only an IMDb id (sometimes as its id)
    expect(titleKey({id: 'tt0133093', type: 'movie', source: 'stream'})).toBe('tt0133093');
    expect(titleKey({imdbId: 'tt0133093', type: 'movie', source: 'stream'})).toBe('tt0133093');
    // nothing to go by
    expect(titleKey({id: 'torrent|abc|0', type: 'movie'})).toBeNull();
    expect(titleKey({id: 'x', type: 'movie', source: 'stream'})).toBeNull();
    expect(titleKey(null)).toBeNull();
  });
  test('an episode stands for its show', () => {
    const ep = {id: 'ep9', showId: 'show1', showTitle: 'Severance', title: 'Hello', season: 1, episode: 2, imdbId: 'tt99999999'};
    expect(titleKey(ep)).toBe('lib:show1');
    expect(titleType(ep)).toBe('show');
    expect(titleName(ep)).toBe('Severance');
    expect(sendTitle(ep)).toEqual({id: 'show1'});
    // a streamed episode resumed from Continue Watching: its show's IMDb id
    const st = {id: 'torrent|h|3', imdbId: 'tt11280740', title: 'Severance', season: 1, episode: 2};
    expect(titleKey(st)).toBe('tt11280740');
    expect(titleType(st)).toBe('show');
  });
  test('a library title is sent by its id; a catalogue title as the My List stream ref', () => {
    expect(sendTitle({id: 'abc123', type: 'movie', imdbId: 'tt0816692', title: 'Interstellar'})).toEqual({id: 'abc123'});
    expect(
      sendTitle({imdbId: 'tt0816692', type: 'movie', source: 'stream', title: 'Interstellar', poster: 'https://p/x.jpg', year: 2014, genres: ['Sci-Fi'], rating: 8.7}),
    ).toEqual({imdbId: 'tt0816692', type: 'movie', title: 'Interstellar', poster: 'https://p/x.jpg', year: 2014, genres: ['Sci-Fi'], rating: 8.7});
    // what the server makes of it is the same title (cleanTitle keeps it, keyed by the IMDb id)
    const t = server.cleanTitle(sendTitle({imdbId: 'tt0816692', type: 'show', source: 'stream', title: 'X'}));
    expect(t.key).toBe('tt0816692');
    expect(t.type).toBe('show');
    expect(sendTitle({id: 'torrent|a|0', type: 'movie', title: 'X'})).toBeNull();
  });
});

describe('Home’s row: the Show all tile', () => {
  test('only when the server says there are more, at the end, the same array each time', () => {
    const items = [{id: 'a', title: 'A'}, {id: 'b', title: 'B'}];
    expect(withShowAll(items, false)).toBe(items);
    expect(withShowAll(items, undefined)).toBe(items);
    const a = withShowAll(items, true);
    expect(a.length).toBe(3);
    expect(isShowAll(a[2])).toBe(true);
    expect(a[2]).toMatchObject({title: 'Show all recommended', cta: true});
    expect(withShowAll(items, true)).toBe(a); // memoised: the memoised Row sees nothing new
    expect(withShowAll([], true)).toEqual([]);
    expect(isShowAll(showAllTile())).toBe(true);
    expect(isShowAll(items[0])).toBe(false);
  });
});

describe('the arrival toast', () => {
  const card = (title: string, from: [string, number][], unseen = true) => ({
    title,
    hh: {key: title, unseen, from: from.map(([name, at]) => ({id: name, name, at}))},
  });
  test('one new: "Dana recommended Dune"; several: "N new recommendations from your household"', () => {
    const items = [card('Dune', [['Dana', 200]]), card('Heat', [['Avi', 50]])];
    expect(arrivalToast(items, 100)).toBe('Dana recommended Dune');
    expect(arrivalToast([...items, card('Arrival', [['Noa', 300]])], 100)).toBe('2 new recommendations from your household');
    expect(DESIGN).toContain('Dana recommended Dune');
    expect(DESIGN).toContain('3 new recommendations from your household');
  });
  test('the newest sender of the new one is named', () => {
    expect(arrivalToast([card('Dune', [['Avi', 300], ['Dana', 50]])], 100)).toBe('Avi recommended Dune');
  });
  test('nothing new, or new but already seen: no toast', () => {
    expect(arrivalToast([card('Dune', [['Dana', 200]])], 200)).toBe('');
    expect(arrivalToast([card('Dune', [['Dana', 200]], false)], 100)).toBe('');
    expect(arrivalToast(null, 0)).toBe('');
  });
  test('newestAt: the newest time a list holds', () => {
    expect(newestAt([card('Dune', [['Dana', 200], ['Avi', 900]]), card('Heat', [['Noa', 400]])])).toBe(900);
    expect(newestAt([])).toBe(0);
  });
});

// ------------------------------------------------------------ the live half
jest.mock('../../src/api', () => ({api: {household: jest.fn()}}));
jest.mock('../../src/toast', () => ({showToast: jest.fn()}));
jest.mock('../../src/usage', () => ({track: jest.fn()}));
const mockHandlers = new Map<string, (d: Record<string, unknown>) => void>();
jest.mock('../../src/realtime', () => ({
  onMessage: (type: string, fn: (d: Record<string, unknown>) => void) => {
    mockHandlers.set(type, fn);
    return () => mockHandlers.delete(type);
  },
}));

describe('householdLive: a ping becomes one toast, once', () => {
  const {api} = require('../../src/api');
  const {showToast} = require('../../src/toast');
  const {track} = require('../../src/usage');
  const live = require('../../src/householdLive');
  const {clearProfileCaches} = require('../../src/profileScope');
  const flush = () => new Promise<void>(r => setTimeout(r, 0));
  const answer = (items: unknown[]) => api.household.mockResolvedValueOnce({items, total: items.length, people: [], unseen: 1});
  const dune = {title: 'Dune', hh: {key: 'tt1', unseen: true, from: [{id: 'd', name: 'Dana', at: 1000}]}};

  beforeEach(() => {
    clearProfileCaches();
    api.household.mockReset();
    showToast.mockReset();
    track.mockReset();
  });

  test('the ping for this profile: one toast, the row re-read; the same arrival again: nothing', async () => {
    const off = live.startHouseholdLive('me');
    const changed = jest.fn();
    const offC = live.onHouseholdChanged(changed);
    answer([dune]);
    mockHandlers.get('household_recs')!({type: 'household_recs', profile: 'me'});
    await flush();
    expect(showToast).toHaveBeenCalledTimes(1);
    // the words to the letter, a left-to-right mark first (a Hebrew name never flips the line)
    expect(showToast.mock.calls[0][0]).toBe('‎Dana recommended Dune');
    expect(track).toHaveBeenCalledWith('feat', {f: 'hhrec-toast'});
    expect(changed).toHaveBeenCalledTimes(1);
    // a repeat send (only the note changed) pings again: the same time, no toast
    answer([dune]);
    mockHandlers.get('household_recs')!({type: 'household_recs', profile: 'me'});
    await flush();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(2);
    offC();
    off();
  });

  test('someone else’s ping is not this profile’s', async () => {
    const off = live.startHouseholdLive('me');
    mockHandlers.get('household_recs')!({type: 'household_recs', profile: 'someone'});
    await flush();
    expect(api.household).not.toHaveBeenCalled();
    off();
  });

  test('what Home’s row already showed is not news', async () => {
    const off = live.startHouseholdLive('me');
    live.noteShown([dune]);
    answer([dune]);
    mockHandlers.get('household_recs')!({type: 'household_recs', profile: 'me'});
    await flush();
    expect(showToast).not.toHaveBeenCalled();
    off();
  });

  test('a profile left forgets what it had been shown', async () => {
    live.startHouseholdLive('me');
    live.noteShown([dune]);
    expect(live._householdLive.state().newest).toBe(1000);
    clearProfileCaches();
    expect(live._householdLive.state()).toEqual({profile: null, newest: 0, asking: false});
  });
});

// [household] the card's two lines and right-to-left names (the design pass, 2026-10-28)
describe('the card lines and right-to-left names', () => {
  const R = require('../../src/householdRecs');
  test('cardLines: the first sender, then the rest — together the server line, word for word', () => {
    expect(R.cardLines('From Dana')).toEqual(['From Dana', '']);
    expect(R.cardLines('From Dana and Avi')).toEqual(['From Dana', 'and Avi']);
    expect(R.cardLines('From Dana and 10 others')).toEqual(['From Dana', 'and 10 others']);
    expect(R.cardLines('From Maximiliana Rosenthal and נועם בן-דוד')).toEqual(['From Maximiliana Rosenthal', 'and נועם בן-דוד']);
    // a name with "and" in it stays whole when the senders are known
    expect(R.cardLines('From Tom and Jerry and Avi', [{name: 'Tom and Jerry'}, {name: 'Avi'}])).toEqual(['From Tom and Jerry', 'and Avi']);
    expect(R.cardLines('From Tom and Jerry', [{name: 'Tom and Jerry'}])).toEqual(['From Tom and Jerry', '']);
    expect(R.cardLines('')).toEqual(['', '']);
    for (const m of ['From Dana', 'From Dana and Avi', 'From Dana and 2 others']) {
      const [a, b] = R.cardLines(m);
      expect([a, b].filter(Boolean).join(' ')).toBe(m);
    }
  });
  test('the marks are not words: stripped, every line is the table words', () => {
    const [a, b] = R.cardLinesShown('From Maximiliana Rosenthal and נועם בן-דוד', [{name: 'Maximiliana Rosenthal'}, {name: 'נועם בן-דוד'}]);
    expect(R.plain(a)).toBe('From Maximiliana Rosenthal');
    expect(R.plain(b)).toBe('and נועם בן-דוד');
    expect(b).toContain('‎נועם בן-דוד‎'); // the Hebrew name fenced off
    expect(R.plain(R.nameWord('נועם', 'Mute'))).toBe('נועם · Mute');
    expect(R.nameWord('נועם', 'Mute').startsWith('‎')).toBe(true);
    expect(R.plain(R.noteLineShown('סרט מדהים', 'Dana'))).toBe(R.noteLine('סרט מדהים', 'Dana'));
    expect(R.notesShown([{name: 'Dana', note: 'Go'}, {name: 'Avi'}]).map(R.plain)).toEqual(R.notesOf([{name: 'Dana', note: 'Go'}, {name: 'Avi'}]));
    // a Latin name is left as it is (no marks inside)
    expect(R.iso('Dana')).toBe('Dana');
    expect(R.ltr('')).toBe('');
  });
});

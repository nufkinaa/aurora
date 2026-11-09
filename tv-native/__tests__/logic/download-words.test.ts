// What the title page's Play button says while a title downloads, on the TV
// and the phone (src/detailLogic.ts): the website's Save & watch words, word
// for word, and no line under the button while it runs (the website has none).
// The root test test/download-words-parity.test.js holds these words to the
// website's own source.
import {CARD_WORDS, dlStatus, dlText, jobMark, SAVE_WORDS, sameJob, saveText} from '../../src/detailLogic';

describe('the Play button while it saves (the website saveState)', () => {
  test('every state, in the website order', () => {
    expect(saveText({status: 'pending', progress: 0})).toBe('Waiting for approval');
    expect(saveText({status: 'approved', progress: 0})).toBe('Queued to download');
    expect(saveText({status: 'downloading', progress: 0.5, phase: 'copying'})).toBe('Almost there…');
    expect(saveText({status: 'downloading', progress: 0, phase: 'finding'})).toBe('Starting download…');
    expect(saveText({status: 'downloading', progress: 0.2, phase: 'starting'})).toBe('Starting download…');
    expect(saveText({status: 'downloading', progress: 0})).toBe('Starting download…');
    expect(saveText({status: 'downloading', progress: 0.42})).toBe('Downloading · 42%');
    expect(saveText({status: 'downloading', progress: 0.42, phase: 'downloading'})).toBe('Downloading · 42%');
  });
  test('the words are the website set, nothing else', () => {
    expect(SAVE_WORDS.pending).toBe('Waiting for approval');
    expect(SAVE_WORDS.approved).toBe('Queued to download');
    expect(SAVE_WORDS.finishing).toBe('Almost there…');
    expect(SAVE_WORDS.starting).toBe('Starting download…');
    expect(SAVE_WORDS.downloading(7)).toBe('Downloading · 7%');
  });
});

describe('an episode card (the website epJobText)', () => {
  test('Requested / Starting / Downloading N%', () => {
    expect(dlText({status: 'pending', progress: 0})).toBe('Requested');
    expect(dlText({status: 'approved', progress: 0})).toBe('Starting');
    expect(dlText({status: 'downloading', progress: 0})).toBe('Starting');
    expect(dlText({status: 'downloading', progress: 0.34})).toBe('Downloading 34%');
    expect(CARD_WORDS.downloading(34)).toBe('Downloading 34%');
    expect(dlText({status: 'downloading', progress: 0.34})).not.toMatch(/sav/i);
  });
});

describe('dlStatus: the button words, and no line while it runs', () => {
  const job = (o: object) => ({status: 'downloading', progress: 0.42, id: 'j', mine: true, ...o});
  test('a running job: the button says it, nothing under it, the strip fills', () => {
    const d = dlStatus('Arrival', job({}), null, false, null);
    expect(d).toEqual({busy: true, label: 'Downloading · 42%', line: null, pct: 0.42, tone: 'live'});
  });
  test('waiting for approval and queued: the website words, no strip while it waits for approval', () => {
    expect(dlStatus('Arrival', job({status: 'pending', progress: 0}), null, false, null)).toMatchObject({label: 'Waiting for approval', line: null, pct: null});
    expect(dlStatus('Arrival', job({status: 'approved', progress: 0}), null, false, null)).toMatchObject({label: 'Queued to download', line: null});
  });
  test('the stage from the socket (dlLive) when the job mark has none: finishing', () => {
    expect(dlStatus('Arrival', job({}), null, false, {phase: 'copying'}).label).toBe('Almost there…');
    expect(dlStatus('Arrival', job({phase: 'copying'}), null, false, null).label).toBe('Almost there…');
  });
  test('pressed, before the job: Starting download…', () => {
    expect(dlStatus('Arrival', null, {key: 'film', kind: 'finding'}, false, null)).toMatchObject({busy: true, label: 'Starting download…', line: null});
    expect(dlStatus('Arrival', null, {key: 'film', kind: 'already'}, false, null)).toMatchObject({label: 'Starting download…', line: null});
  });
  test('the job left the list, the copy not in yet: Almost there…; in: Ready', () => {
    expect(dlStatus('Arrival', null, {key: 'film', kind: 'ended'}, false, null)).toMatchObject({busy: true, label: 'Almost there…', line: null, pct: 1});
    expect(dlStatus('Arrival', null, {key: 'film', kind: 'ended'}, true, null)).toMatchObject({busy: false, label: null, line: 'Ready — press Play'});
  });
  test('failed: the button goes back to Save & watch (no label), the reason under it', () => {
    const d = dlStatus('Arrival', null, {key: 'film', kind: 'failed', text: "Couldn't get Arrival  ·  hold Play for other sources"}, false, null);
    expect(d).toMatchObject({busy: false, label: null, tone: 'warn'});
    expect(d.line).toMatch(/Couldn't get Arrival/);
  });
  test('nothing going on: no label', () => {
    expect(dlStatus('Arrival', null, null, false, null).label).toBeNull();
    expect(dlStatus('Arrival', null, null, true, null)).toEqual({busy: false, label: null, line: null, pct: null, tone: 'hint'});
  });
});

describe('the job mark keeps its stage', () => {
  test('jobMark copies the phase; a new stage is a change the button shows', () => {
    const a = jobMark({status: 'downloading', progress: 0.99, id: 'j', mine: true, phase: 'downloading'});
    const b = jobMark({status: 'downloading', progress: 0.99, id: 'j', mine: true, phase: 'copying'});
    expect(a.phase).toBe('downloading');
    expect(sameJob(a, b)).toBe(false);
    expect(sameJob(a, {...a})).toBe(true);
    expect(jobMark({status: 'approved'})).toEqual({status: 'approved', progress: 0, id: undefined, mine: false, phase: null});
  });
});

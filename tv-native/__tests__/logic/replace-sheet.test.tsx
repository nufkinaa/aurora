// The "Get another version" sheet (components/ReplaceSheet.tsx), driven the
// way the remote drives it: it opens on the reasons with the first one
// focused, a reason brings the versions, a version asks for it, BACK goes
// from the versions to the reasons, and the server's answer can turn the
// sheet into "on its way" (with Cancel) or "refused" (a kids profile).
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

jest.mock('react-native', () => ({...jest.requireActual('./rn-stub.js'), ActivityIndicator: 'ActivityIndicator', TextInput: 'TextInput'}));
// The Sheet: a host that keeps what BACK would call (its onClose).
jest.mock('../../src/components/Sheet', () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement('Sheet', p, p.children as never)};
});
jest.mock('../../src/components/Focusable', () => {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement('Focusable', p, p.children as never)};
});
const mockApi = {
  replaceView: jest.fn(),
  replaceSources: jest.fn(),
  replaceRequest: jest.fn(),
  replaceCancel: jest.fn(),
  report: jest.fn(),
};
// the field's focus bookkeeping and the microphone (useVoiceNote.ts — its words are
// replace-logic's voiceNoteWords) are the devices' own: stood in for here
jest.mock('../../src/focus', () => ({acceptTvEvent: () => true, noteFocus: () => {}, noteFocusLost: () => {}}));
const mockVoice = {available: true, listening: false, label: 'Say it', line: '', press: jest.fn(), cancel: jest.fn()};
jest.mock('../../src/useVoiceNote', () => ({useVoiceNote: () => mockVoice}));
jest.mock('../../src/api', () => ({
  get api() {
    return mockApi;
  },
}));
const mockClose = jest.fn();
jest.mock('../../src/overlay', () => ({closeOverlay: () => mockClose()}));
const mockToast = jest.fn();
jest.mock('../../src/toast', () => ({showToast: (t: string) => mockToast(t)}));
jest.mock('../../src/rootNav', () => ({rootNav: () => ({profileId: 'p1', profileName: 'Claude QA'}), currentRouteName: () => 'Player'}));
jest.mock('../../src/usage', () => ({track: () => {}}));
jest.mock('../../src/theme', () => ({
  __esModule: true,
  default: {colors: {bg: '#000', text: '#fff', textDim: '#999', accent: '#88f', white: '#fff', surfaceHover: '#222'}, fontSize: {body: 16, small: 14, row: 20}, radius: {s: 8, m: 12}, spacing: {sm: 8, md: 12, lg: 16}},
}));

import ReplaceSheet from '../../src/components/ReplaceSheet';

const VIEW = {
  item: {id: 'lib1', type: 'movie', title: 'Film', display: 'Film', season: null, episode: null, showId: null, imdbId: 'tt1'},
  current: {infoHash: 'aa', release: 'Film.HC', provider: 'x', quality: '1080p', sizeBytes: 1, fileName: 'Film.mkv'},
  active: null,
  can: true,
  why: null,
  code: null,
  reasons: [
    {id: 'burned', label: 'Burned-in subtitles'},
    {id: 'picture', label: 'Bad picture'},
    {id: 'sound', label: 'Bad sound'},
    {id: 'language', label: 'Wrong language'},
    {id: 'other', label: 'Other'},
  ],
};
const STREAMS = [
  {infoHash: 'b'.repeat(40), fileIdx: 0, quality: '1080p', sizeString: '2.1 GB', seeders: 40, release: 'Film.1080p.BluRay', recommended: true},
  {infoHash: 'c'.repeat(40), fileIdx: 2, quality: '720p', sizeString: '900 MB', seeders: 3, release: 'Film.720p.HC', badHere: {reason: 'burned', label: 'Burned-in subtitles'}},
];

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});
const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll(n => (n.type as unknown) === 'Text').map(n => [].concat(n.props.children).filter(c => typeof c === 'string').join(''));
const byUi = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll(n => (n.type as unknown) === 'Focusable' && n.props.uiId === id);
const sheet = (r: TestRenderer.ReactTestRenderer) => r.root.find(n => (n.type as unknown) === 'Sheet');

let r: TestRenderer.ReactTestRenderer;
const open = async () => {
  await act(async () => {
    r = TestRenderer.create(<ReplaceSheet libraryId="lib1" title="Film" />);
  });
  await flush();
};
beforeEach(() => {
  jest.clearAllMocks();
  mockApi.replaceView.mockResolvedValue(VIEW);
  mockApi.replaceSources.mockResolvedValue({streams: STREAMS, current: VIEW.current});
  mockApi.replaceRequest.mockResolvedValue({ok: true});
  mockApi.replaceCancel.mockResolvedValue({ok: true});
  mockApi.report.mockResolvedValue({ok: true, id: 'r1'});
});
afterEach(() => act(() => r?.unmount()));

test('opens on the five reasons, the first one focused, before and after the server answers', async () => {
  let resolve!: (v: unknown) => void;
  mockApi.replaceView.mockReturnValue(new Promise(res => (resolve = res)));
  await act(async () => {
    r = TestRenderer.create(<ReplaceSheet libraryId="lib1" title="Film" />);
  });
  expect(sheet(r).props.title).toBe("What's wrong with this copy?");
  let reasons = byUi(r, 'replace.reason');
  expect(reasons).toHaveLength(5);
  expect(reasons.map(x => x.props.hasTVPreferredFocus)).toEqual([true, false, false, false, false]);
  await act(async () => resolve(VIEW));
  reasons = byUi(r, 'replace.reason');
  expect(reasons).toHaveLength(5);
  expect(reasons[0].props.hasTVPreferredFocus).toBe(true);
  expect(texts(r)).toContain('Pick one. Nothing downloads until you pick another version — your place, My List and ratings stay.');
  expect(mockApi.replaceView).toHaveBeenCalledWith('lib1', 'p1');
});

test('a reason → the versions (★ BEST, Reported here), the first one focused; a pick asks for it, toasts and closes', async () => {
  await open();
  await act(async () => byUi(r, 'replace.reason')[0].props.onPress());
  await flush();
  expect(mockApi.replaceSources).toHaveBeenCalledWith('lib1', 'p1', 'burned');
  expect(sheet(r).props.title).toBe('Get another version');
  expect(texts(r)).toContain('Pick one and it starts downloading now. Your copy stays playable until the new one is in.');
  const rows = byUi(r, 'replace.pick');
  expect(rows).toHaveLength(2);
  expect(rows[0].props.hasTVPreferredFocus).toBe(true);
  expect(texts(r)).toEqual(expect.arrayContaining(['★ BEST', '1080p · 2.1 GB · 40 seeders', 'Reported here: Burned-in subtitles']));
  await act(async () => byUi(r, 'replace.pick')[1].props.onPress());
  await flush();
  expect(mockApi.replaceRequest).toHaveBeenCalledWith('lib1', expect.objectContaining({profile: 'p1', reason: 'burned', source: {infoHash: 'c'.repeat(40), fileIdx: 2}}));
  expect(mockClose).toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith("Getting another version — your copy stays playable until it's in.");
});

test('BACK from the versions goes to the reasons; BACK from the reasons closes', async () => {
  await open();
  await act(async () => byUi(r, 'replace.reason')[2].props.onPress());
  await flush();
  expect(sheet(r).props.title).toBe('Get another version');
  await act(async () => (sheet(r).props.onClose as () => void)());
  expect(sheet(r).props.title).toBe("What's wrong with this copy?");
  expect(byUi(r, 'replace.reason')[0].props.hasTVPreferredFocus).toBe(true);
  expect(mockClose).not.toHaveBeenCalled();
  await act(async () => (sheet(r).props.onClose as () => void)());
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test('no other versions, or the provider failing: the words, and a focused Back (focus stays in the sheet)', async () => {
  mockApi.replaceSources.mockResolvedValueOnce({streams: [], current: VIEW.current});
  await open();
  await act(async () => byUi(r, 'replace.reason')[0].props.onPress());
  await flush();
  expect(texts(r)).toContain('No other versions found.');
  const back = r.root.findAll(n => (n.type as unknown) === 'Focusable');
  expect(back).toHaveLength(1);
  expect(back[0].props.hasTVPreferredFocus).toBe(true);
  await act(async () => back[0].props.onPress());
  expect(sheet(r).props.title).toBe("What's wrong with this copy?");

  mockApi.replaceSources.mockRejectedValueOnce(new Error('502 /api/replace/lib1/sources'));
  await act(async () => byUi(r, 'replace.reason')[0].props.onPress());
  await flush();
  expect(texts(r)).toContain("Couldn't reach the source provider.");
});

test("a refused pick shows the server's words and stays on the versions", async () => {
  mockApi.replaceRequest.mockRejectedValueOnce(new Error('Another version of this is already on its way.'));
  await open();
  await act(async () => byUi(r, 'replace.reason')[0].props.onPress());
  await flush();
  await act(async () => byUi(r, 'replace.pick')[0].props.onPress());
  await flush();
  expect(texts(r)).toContain('Another version of this is already on its way.');
  expect(mockClose).not.toHaveBeenCalled();
  expect(byUi(r, 'replace.pick')).toHaveLength(2);
});

test('on its way, asked by me: status, reason; focus is on Close and Cancel asks first', async () => {
  mockApi.replaceView.mockResolvedValue({...VIEW, can: false, code: 'busy', active: {status: 'downloading', progress: 0.45, waiting: false, reasonLabel: 'Burned-in subtitles', mine: true, by: 'Claude QA'}});
  await open();
  expect(sheet(r).props.title).toBe('Another version is on its way');
  expect(texts(r)).toEqual(expect.arrayContaining(['Downloading · 45%', 'Reason: Burned-in subtitles']));
  // A stray OK must not end it: focus landed ON Cancel, and one press cancelled.
  const ask = byUi(r, 'replace.cancel.ask');
  expect(ask).toHaveLength(1);
  expect(ask[0].props.hasTVPreferredFocus).toBeFalsy();
  const focused = r.root.findAll(n => (n.type as unknown) === 'Focusable' && n.props.hasTVPreferredFocus);
  expect(focused).toHaveLength(1);
  expect(byUi(r, 'replace.reason')).toHaveLength(0);
  await act(async () => ask[0].props.onPress());
  await flush();
  expect(mockApi.replaceCancel).not.toHaveBeenCalled();
  expect(sheet(r).props.title).toBe('Cancel this version?');
  // BACK, and "Keep going" (which has the focus): nothing happened
  await act(async () => (sheet(r).props.onClose as () => void)());
  await flush();
  expect(sheet(r).props.title).toBe('Another version is on its way');
  await act(async () => byUi(r, 'replace.cancel.ask')[0].props.onPress());
  await flush();
  const keep = r.root.findAll(n => (n.type as unknown) === 'Focusable' && n.props.hasTVPreferredFocus);
  expect(keep).toHaveLength(1);
  await act(async () => keep[0].props.onPress());
  await flush();
  expect(mockApi.replaceCancel).not.toHaveBeenCalled();
  await act(async () => byUi(r, 'replace.cancel.ask')[0].props.onPress());
  await flush();
  const cancel = byUi(r, 'replace.cancel');
  expect(cancel).toHaveLength(1);
  expect(cancel[0].props.hasTVPreferredFocus).toBeFalsy();
  await act(async () => cancel[0].props.onPress());
  await flush();
  expect(mockApi.replaceCancel).toHaveBeenCalledWith('lib1', 'p1');
  expect(mockClose).toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith('Cancelled — your copy stays as it was.');
});

test('the last try was cancelled: says who, offers the next candidates, and can move on', async () => {
  const last = {status: 'canceled', reason: 'language', reasonLabel: 'Wrong language', canceledBy: 'admin', why: null, release: 'Film.BONE', quality: '1080p', line: 'The admin cancelled it — your copy stays as it was.'};
  mockApi.replaceView.mockResolvedValue({...VIEW, last});
  await open();
  expect(sheet(r).props.title).toBe("That version didn't come through");
  expect(texts(r)).toEqual(expect.arrayContaining([last.line, 'That was: Film.BONE (1080p)', 'Reason: Wrong language', 'Pick the next one, or keep this copy.']));
  const next = byUi(r, 'replace.next');
  expect(next[0].props.hasTVPreferredFocus).toBe(true);
  await act(async () => next[0].props.onPress());
  await flush();
  expect(mockApi.replaceSources).toHaveBeenCalledWith('lib1', 'p1', 'language');
  expect(sheet(r).props.title).toBe('Get another version');
  // BACK from the list goes to the reasons, not round again
  await act(async () => (sheet(r).props.onClose as () => void)());
  await flush();
  expect(sheet(r).props.title).toBe("What's wrong with this copy?");
});

test('the last try: "Something else is wrong" goes to the reasons', async () => {
  mockApi.replaceView.mockResolvedValue({...VIEW, last: {status: 'failed', reason: 'language', reasonLabel: 'Wrong language', canceledBy: null, why: 'no peers', release: null, quality: null, line: 'The download failed (no peers) — your copy stays as it was.'}});
  await open();
  await act(async () => byUi(r, 'replace.other')[0].props.onPress());
  await flush();
  expect(sheet(r).props.title).toBe("What's wrong with this copy?");
  expect(byUi(r, 'replace.reason')).toHaveLength(5);
});

test('Wrong language: the reason goes to the server, its sentence and the language are on the list', async () => {
  mockApi.replaceSources.mockResolvedValue({
    streams: [{infoHash: 'b'.repeat(40), fileIdx: 0, quality: '1080p', seeders: 40, release: 'Film.ENGLISH', recommended: true, langFit: 'right', langLabel: 'English'}],
    current: VIEW.current,
    note: 'Versions in English first. 2 in Russian left out.',
  });
  await open();
  await act(async () => byUi(r, 'replace.reason')[3].props.onPress());
  await flush();
  expect(mockApi.replaceSources).toHaveBeenCalledWith('lib1', 'p1', 'language');
  expect(texts(r)).toEqual(expect.arrayContaining(['Versions in English first. 2 in Russian left out.', 'English']));
});

test('a request from the player carries the client kind and version, like every other report', async () => {
  await open();
  await act(async () => byUi(r, 'replace.reason')[0].props.onPress());
  await flush();
  await act(async () => byUi(r, 'replace.pick')[0].props.onPress());
  await flush();
  const ctx = mockApi.replaceRequest.mock.calls[mockApi.replaceRequest.mock.calls.length - 1][1].context;
  expect(ctx.route).toBe('tv:Player');
  expect(ctx.look).toBe('tv');
  expect(ctx.viewport).toBe('tv');
  expect(ctx.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(ctx.ua).toMatch(/^Aurora TV \d+\.\d+\.\d+ · Android /);
  expect(Array.isArray(ctx.errors)).toBe(true);
});

test("on its way, asked by someone else: who asked, no Cancel; the waiting state's words", async () => {
  mockApi.replaceView.mockResolvedValue({...VIEW, can: false, code: 'busy', active: {status: 'downloading', progress: 1, waiting: true, reasonLabel: 'Bad sound', mine: false, by: 'Dor'}});
  await open();
  expect(texts(r)).toEqual(expect.arrayContaining(['Ready — it takes over once nobody is playing this copy.', 'Reason: Bad sound', 'Asked for by Dor']));
  expect(byUi(r, 'replace.cancel')).toHaveLength(0);
  const close = r.root.findAll(n => (n.type as unknown) === 'Focusable');
  expect(close).toHaveLength(1);
  expect(close[0].props.hasTVPreferredFocus).toBe(true);
});

test('a kids profile: the server says why, and Close', async () => {
  mockApi.replaceView.mockResolvedValue({...VIEW, can: false, code: 'kids', why: "A kids profile can't replace a copy."});
  await open();
  expect(texts(r)).toContain("A kids profile can't replace a copy.");
  expect(byUi(r, 'replace.reason')).toHaveLength(0);
  const close = r.root.findAll(n => (n.type as unknown) === 'Focusable');
  expect(close).toHaveLength(1);
  expect(close[0].props.hasTVPreferredFocus).toBe(true);
  await act(async () => close[0].props.onPress());
  expect(mockClose).toHaveBeenCalled();
});

// ---- "Other" (Jesse's report, 2026-11-08): a few words first, then a choice ----
const field = (r: TestRenderer.ReactTestRenderer) => r.root.find(n => (n.type as unknown) === 'TextInput');
const toOther = async () => {
  await open();
  await act(async () => byUi(r, 'replace.reason')[4].props.onPress());
  await flush();
};

test('Other asks what is wrong first — no list of versions, nothing downloads; the field has the focus', async () => {
  await toOther();
  expect(mockApi.replaceSources).not.toHaveBeenCalled();
  expect(mockApi.replaceRequest).not.toHaveBeenCalled();
  expect(sheet(r).props.title).toBe("What's wrong with it?");
  expect(texts(r)).toContain('A few words, so the admin knows what you saw or heard. Nothing downloads yet.');
  expect(field(r).props.autoFocus).toBe(true);
  expect(field(r).props.placeholder).toBe('What is wrong with this copy?');
  expect(byUi(r, 'replace.other.next')).toHaveLength(1);
  // the remote's microphone, where the TV can hear
  expect(byUi(r, 'replace.other.voice')).toHaveLength(1);
  await act(async () => byUi(r, 'replace.other.voice')[0].props.onPress());
  expect(mockVoice.press).toHaveBeenCalled();
});

test('Other: Next with nothing typed says so and stays; BACK goes to the reasons', async () => {
  await toOther();
  await act(async () => byUi(r, 'replace.other.next')[0].props.onPress());
  await flush();
  expect(texts(r)).toContain("Say what's wrong first — a few words is enough.");
  expect(sheet(r).props.title).toBe("What's wrong with it?");
  await act(async () => (sheet(r).props.onClose as () => void)());
  expect(sheet(r).props.title).toBe("What's wrong with this copy?");
  expect(mockClose).not.toHaveBeenCalled();
});

test('Other → words → "Get another version?" is a choice; No sends them as a report and the copy stays', async () => {
  await toOther();
  await act(async () => field(r).props.onChangeText('The picture freezes\nafter 20 minutes'));
  await act(async () => byUi(r, 'replace.other.next')[0].props.onPress());
  await flush();
  expect(sheet(r).props.title).toBe('Get another version?');
  expect(texts(r)).toContain('“The picture freezes after 20 minutes”');
  // nothing is asked of the server yet, and the focus is not on a download
  expect(mockApi.replaceSources).not.toHaveBeenCalled();
  expect(byUi(r, 'replace.other.another')[0].props.hasTVPreferredFocus).toBe(true);
  await act(async () => byUi(r, 'replace.other.send')[0].props.onPress());
  await flush();
  expect(mockApi.replaceRequest).not.toHaveBeenCalled();
  expect(mockApi.report).toHaveBeenCalledTimes(1);
  const [text, ctx, who] = mockApi.report.mock.calls[0];
  expect(text).toBe('Problem with this copy: Other — The picture freezes after 20 minutes\nNo other version asked for — the copy stays.');
  expect(ctx.note).toBe('The picture freezes after 20 minutes');
  expect(ctx.route).toBe('tv:Player');
  expect(ctx.look).toBe('tv');
  expect(who).toBe('Claude QA');
  expect(mockClose).toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith('Sent — thank you. Your copy stays as it was.');
});

test('Other → Yes: the versions for "other"; the pick carries the words, in the request and its context', async () => {
  await open();
  await act(async () => byUi(r, 'replace.reason')[4].props.onPress());
  await act(async () => field(r).props.onChangeText('No sound in the second half'));
  await act(async () => byUi(r, 'replace.other.next')[0].props.onPress());
  await act(async () => byUi(r, 'replace.other.another')[0].props.onPress());
  await flush();
  expect(mockApi.replaceSources).toHaveBeenCalledWith('lib1', 'p1', 'other');
  expect(sheet(r).props.title).toBe('Get another version');
  // BACK from the list: the question again, the words kept
  await act(async () => (sheet(r).props.onClose as () => void)());
  expect(sheet(r).props.title).toBe('Get another version?');
  await act(async () => byUi(r, 'replace.other.another')[0].props.onPress());
  await flush();
  await act(async () => byUi(r, 'replace.pick')[0].props.onPress());
  await flush();
  const body = mockApi.replaceRequest.mock.calls[0][1];
  expect(body).toEqual(expect.objectContaining({reason: 'other', note: 'No sound in the second half', source: {infoHash: 'b'.repeat(40), fileIdx: 0}}));
  expect(body.context.note).toBe('No sound in the second half');
  expect(mockApi.report).not.toHaveBeenCalled();
});

test('the specific reasons still go straight to their versions (no words asked)', async () => {
  for (const i of [0, 1, 2, 3]) {
    jest.clearAllMocks();
    await open();
    await act(async () => byUi(r, 'replace.reason')[i].props.onPress());
    await flush();
    expect(mockApi.replaceSources).toHaveBeenCalledTimes(1);
    expect(sheet(r).props.title).toBe('Get another version');
    expect(r.root.findAll(n => (n.type as unknown) === 'TextInput')).toHaveLength(0);
    act(() => r.unmount());
  }
});

// The "Get another version" sheet (components/ReplaceSheet.tsx), driven the
// way the remote drives it: it opens on the reasons with the first one
// focused, a reason brings the versions, a version asks for it, BACK goes
// from the versions to the reasons, and the server's answer can turn the
// sheet into "on its way" (with Cancel) or "refused" (a kids profile).
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

jest.mock('react-native', () => ({...jest.requireActual('./rn-stub.js'), ActivityIndicator: 'ActivityIndicator'}));
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
};
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
  expect(texts(r)).toContain('Pick one. Another version replaces it — your place, My List and ratings stay.');
  expect(mockApi.replaceView).toHaveBeenCalledWith('lib1', 'p1');
});

test('a reason → the versions (★ BEST, Reported here), the first one focused; a pick asks for it, toasts and closes', async () => {
  await open();
  await act(async () => byUi(r, 'replace.reason')[0].props.onPress());
  await flush();
  expect(mockApi.replaceSources).toHaveBeenCalledWith('lib1', 'p1');
  expect(sheet(r).props.title).toBe('Get another version');
  expect(texts(r)).toContain('Your copy stays playable until the new one is in.');
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

test('on its way, asked by me: status, reason, a focused Cancel that cancels and toasts', async () => {
  mockApi.replaceView.mockResolvedValue({...VIEW, can: false, code: 'busy', active: {status: 'downloading', progress: 0.45, waiting: false, reasonLabel: 'Burned-in subtitles', mine: true, by: 'Claude QA'}});
  await open();
  expect(sheet(r).props.title).toBe('Another version is on its way');
  expect(texts(r)).toEqual(expect.arrayContaining(['Downloading · 45%', 'Reason: Burned-in subtitles']));
  const cancel = byUi(r, 'replace.cancel');
  expect(cancel).toHaveLength(1);
  expect(cancel[0].props.hasTVPreferredFocus).toBe(true);
  expect(byUi(r, 'replace.reason')).toHaveLength(0);
  await act(async () => cancel[0].props.onPress());
  await flush();
  expect(mockApi.replaceCancel).toHaveBeenCalledWith('lib1', 'p1');
  expect(mockClose).toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith('Cancelled — your copy stays as it was.');
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

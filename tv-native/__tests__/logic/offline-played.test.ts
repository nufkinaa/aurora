// What a saved copy played with no server (src/phone/offline/store.ts): kept
// per sitting, sent once to /api/profiles/:id/watched, and what plays while a
// send is on its way goes out later as a new part (never added to a sent one).
import {api} from '../../src/api';
import {flushOfflinePlayed, noteOfflinePlayed} from '../../src/phone/offline/store';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const storage = require('@react-native-async-storage/async-storage');

type Sent = {profileId: string; reports: {reportId: string; label: string; played: number}[]};
let sent: Sent[] = [];
let fail = false;
let hold: (() => void) | null = null;
beforeEach(() => {
  storage.__store.clear();
  sent = [];
  fail = false;
  (api as unknown as {reportWatched: unknown}).reportWatched = async (profileId: string, reports: Sent['reports']) => {
    if (fail) throw new Error('no server');
    sent.push({profileId, reports: reports.map(r => ({...r}))});
    if (hold) await new Promise<void>(r => (hold = r));
    return {ok: true, results: []};
  };
});
const S = {sitting: 'sit-1', profileId: 'p1', label: 'Saved film', position: 0, duration: 5400};

test('kept while there is no server, sent once it answers, then gone', async () => {
  fail = true;
  for (let i = 0; i < 6; i++) await noteOfflinePlayed({...S, position: i * 5}, 5);
  await flushOfflinePlayed();
  expect(sent).toHaveLength(0);
  fail = false;
  await flushOfflinePlayed();
  expect(sent).toHaveLength(1);
  expect(sent[0].reports).toHaveLength(1);
  expect(sent[0].reports[0].played).toBe(30);
  await flushOfflinePlayed();
  expect(sent).toHaveLength(1); // nothing left to send
});

test('what plays while a send is on its way goes out later under a new id', async () => {
  await noteOfflinePlayed(S, 10);
  hold = () => {};
  const flushing = flushOfflinePlayed();
  await new Promise(r => setTimeout(r, 0));
  await noteOfflinePlayed(S, 5); // played meanwhile
  const release = hold as unknown as () => void;
  hold = null;
  release();
  await flushing;
  await flushOfflinePlayed();
  expect(sent).toHaveLength(2);
  expect(sent[1].reports[0].played).toBe(5);
  expect(sent[1].reports[0].reportId).not.toBe(sent[0].reports[0].reportId);
});

test('nothing played, nothing kept', async () => {
  await noteOfflinePlayed(S, 0);
  await flushOfflinePlayed();
  expect(sent).toHaveLength(0);
});

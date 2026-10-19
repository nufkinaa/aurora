// Home's last answer kept on the box (src/homeSnapshot.ts) and painted at the
// next launch: only this profile's, only this server's, at most a day old,
// only for the audience the profile has NOW (a kids profile never sees a
// grown-up's shelves), and read ahead during boot so Home's first frame has it.
import {
  dropSnapshot,
  expectedAudience,
  loadSnapshot,
  primedSnapshot,
  primeSnapshot,
  saveSnapshot,
  Snapshot,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_MAX_CHARS,
  SNAPSHOT_MAX_KEPT,
  snapshotHome,
  usable,
  whenSnapshot,
} from '../../src/homeSnapshot';
import {clearProfileCaches} from '../../src/profileScope';
import {saveKidsLock, clearKidsLock} from '../../src/storage';
import {api, audienceOf, keptHomeText, setActiveProfile, setBaseUrl} from '../../src/api';
import {blurOf} from '../../src/blur';
import {queue, resetXhr} from './fake-xhr';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store: Map<string, string> = require('@react-native-async-storage/async-storage').__store;

const SERVER = 'http://tv.test';
const answer = (title: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({hero: [{id: 'h1', title}], rows: [{id: 'continue', title: 'Continue Watching', items: [{id: 'a', title}]}], ...extra});
const rec = (over: Partial<Snapshot> = {}): Snapshot => {
  const text = over.text ?? answer('Kept');
  return {v: 1, at: Date.now(), server: SERVER, profileId: 'p1', audience: 'all', chars: text.length, text, ...over};
};
const want = (over: Partial<{server: string | null; profileId: string | null; audience: string | null; now: number}> = {}) => ({
  server: SERVER,
  profileId: 'p1',
  audience: 'all',
  now: Date.now(),
  ...over,
});

beforeEach(() => {
  store.clear();
  clearProfileCaches();
  resetXhr();
  setBaseUrl(SERVER);
  setActiveProfile(null);
});

describe('when a kept answer may be painted', () => {
  test('this profile, this server, this audience, under a day old: yes', () => {
    expect(usable(rec(), want())).toBe(true);
  });
  test('another profile: never — not even when the record claims to be its', () => {
    expect(usable(rec(), want({profileId: 'p2'}))).toBe(false);
    expect(usable(rec({profileId: 'p2'}), want())).toBe(false);
    expect(usable(rec(), want({profileId: null}))).toBe(false);
  });
  test('another server: no (profile ids are a server’s own)', () => {
    expect(usable(rec(), want({server: 'https://nufurora.com'}))).toBe(false);
    expect(usable(rec(), want({server: null}))).toBe(false);
  });
  test('age: a day is the limit, and a clock that went backwards is not trusted', () => {
    const now = Date.now();
    expect(usable(rec({at: now - SNAPSHOT_MAX_AGE_MS}), want({now}))).toBe(true);
    expect(usable(rec({at: now - SNAPSHOT_MAX_AGE_MS - 1}), want({now}))).toBe(false);
    expect(usable(rec({at: now + 60000}), want({now}))).toBe(false);
  });
  test('audience: a grown-up answer is never painted for a kids profile, nor a kids one for another age', () => {
    expect(usable(rec({audience: 'all'}), want({audience: 'kids:7'}))).toBe(false);
    expect(usable(rec({audience: 'kids:12'}), want({audience: 'kids:7'}))).toBe(false);
    expect(usable(rec({audience: 'kids:7'}), want({audience: 'kids:7'}))).toBe(true);
    expect(usable(rec({audience: 'kids:7'}), want({audience: 'all'}))).toBe(false);
    expect(usable(rec(), want({audience: null}))).toBe(false);
  });
  test('a broken record: no', () => {
    expect(usable(null, want())).toBe(false);
    expect(usable(rec({text: ''}), want())).toBe(false);
    expect(usable({...rec(), v: 2} as unknown as Snapshot, want())).toBe(false);
  });
});

describe('whose audience it must be', () => {
  test('what the server said this run decides', () => {
    expect(expectedAudience('p1', 'kids:7', null)).toBe('kids:7');
    expect(expectedAudience('p1', 'all', {id: 'p1', maxAge: 7})).toBe('all');
  });
  test('with nothing said yet, the box’s kids lock does', () => {
    expect(expectedAudience('p1', undefined, {id: 'p1', maxAge: 7})).toBe('kids:7');
    expect(expectedAudience('p1', undefined, {id: 'kid', maxAge: 7})).toBeNull(); // locked to another: nothing
    expect(expectedAudience('p1', undefined, null)).toBe('all');
  });
});

describe('on the box', () => {
  test('saved and read back whole', async () => {
    expect(await saveSnapshot(rec())).toBe(true);
    const got = await loadSnapshot('p1');
    expect(got && got.text).toBe(answer('Kept'));
    expect(got && got.audience).toBe('all');
    expect(await loadSnapshot('p2')).toBeNull();
  });
  test('one profile’s record is filed under it alone', async () => {
    await saveSnapshot(rec({profileId: 'p1', text: answer('One')}));
    await saveSnapshot(rec({profileId: 'p2', text: answer('Two')}));
    expect((await loadSnapshot('p1'))!.text).toBe(answer('One'));
    expect((await loadSnapshot('p2'))!.text).toBe(answer('Two'));
    // a meta that names another profile is refused even under this key
    store.set('aurora.homeSnap.p1', store.get('aurora.homeSnap.p2')!);
    expect(await loadSnapshot('p1')).toBeNull();
  });
  test('a half-written record (the text does not match its meta) is not read', async () => {
    await saveSnapshot(rec());
    store.set('aurora.homeSnapText.p1', answer('Kept').slice(0, 20));
    expect(await loadSnapshot('p1')).toBeNull();
  });
  test('too big: not kept', async () => {
    const huge = 'x'.repeat(SNAPSHOT_MAX_CHARS + 1);
    expect(await saveSnapshot(rec({text: huge}))).toBe(false);
    expect(await loadSnapshot('p1')).toBeNull();
  });
  test(`at most ${SNAPSHOT_MAX_KEPT} profiles: the one used longest ago goes`, async () => {
    for (let i = 0; i <= SNAPSHOT_MAX_KEPT; i++) await saveSnapshot(rec({profileId: `q${i}`}));
    expect(await loadSnapshot('q0')).toBeNull();
    for (let i = 1; i <= SNAPSHOT_MAX_KEPT; i++) expect(await loadSnapshot(`q${i}`)).not.toBeNull();
    expect(store.has('aurora.homeSnapText.q0')).toBe(false);
  });
  test('dropped', async () => {
    await saveSnapshot(rec());
    await dropSnapshot('p1');
    expect(await loadSnapshot('p1')).toBeNull();
  });
  test('the answer comes back ready to draw — its blur-up placeholders filed as a fresh read files them', async () => {
    const text = answer('Blur', {_blur: {'/img/x': 'data:image/webp;base64,AAA'}});
    const home = snapshotHome<{rows: unknown[]}>(rec({text}));
    expect(home && home.rows.length).toBe(1);
    expect(blurOf('/img/x')).toBe('data:image/webp;base64,AAA');
    expect(snapshotHome(rec({text: '{"nope":1}'}))).toBeNull();
    expect(snapshotHome(rec({text: 'not json'}))).toBeNull();
  });
});

describe('read ahead during boot', () => {
  test('primed: in memory before Home mounts, with the kids lock beside it', async () => {
    await saveSnapshot(rec());
    await saveKidsLock({id: 'p1', maxAge: 7});
    primeSnapshot('p1');
    expect(primedSnapshot('p1')).toBeUndefined(); // still reading
    const got = await whenSnapshot('p1');
    expect(got.rec && got.rec.profileId).toBe('p1');
    expect(got.lock).toEqual({id: 'p1', maxAge: 7});
    expect(primedSnapshot('p1')).toBe(got);
    expect(primedSnapshot('p2')).toBeUndefined();
    await clearKidsLock();
  });
  test('a profile change empties what is held in memory', async () => {
    await saveSnapshot(rec());
    primeSnapshot('p1');
    await whenSnapshot('p1');
    clearProfileCaches();
    expect(primedSnapshot('p1')).toBeUndefined();
  });
  test('nothing kept: null, not an error', async () => {
    const got = await whenSnapshot('nobody');
    expect(got.rec).toBeNull();
  });
});

describe('what the server says about the audience (api.ts)', () => {
  test('a filtered answer says kids:<age>; an unfiltered one says all; keyed by the profile the request named', async () => {
    queue(
      {status: 200, body: '{"progress":{}}', headers: {'X-Aurora-Kids': '7'}},
      {status: 200, body: '{"progress":{}}'},
    );
    await api.state('kid1');
    await api.state('adult1');
    expect(audienceOf('kid1')).toBe('kids:7');
    expect(audienceOf('adult1')).toBe('all');
    expect(audienceOf('someone')).toBeUndefined();
  });
  test('Home’s own answer, as the active profile, and the text it came in', async () => {
    setActiveProfile('k2');
    queue({status: 200, body: answer('Kids'), headers: {'X-Aurora-Kids': '12'}});
    const h = await api.home('k2');
    expect(audienceOf('k2')).toBe('kids:12');
    expect(keptHomeText('k2', h)).toBe(answer('Kids'));
    expect(keptHomeText('other', h)).toBeNull();
  });
});

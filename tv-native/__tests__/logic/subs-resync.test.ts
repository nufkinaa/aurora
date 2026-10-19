// The Resync button against the film's audio, the server's ★ ("Matches this
// release") and what a `subtitle_sync` message does (playback/resync.ts,
// lang.ts bestTrackIndex, playback/subTracks.ts autoPick / followPick).
import {bestTrackIndex} from '../../src/lang';
import {autoPick, buildTracks, followPick, PickPrefs} from '../../src/playback/subTracks';
import {
  errorOutcome,
  mergeSubInfo,
  outcomeOf,
  progressLine,
  reloadAfterSync,
  reloadDue,
  ResyncAnswer,
  resyncBody,
  ResyncDeps,
  resyncMode,
  runResync,
  switchedToast,
  syncPlan,
  takesServerTiming,
  toastFor,
  trackPath,
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
type T = {label: string; url: string; lang?: string; star?: boolean; starWhy?: string; sdh?: boolean; forced?: boolean; embedded?: boolean; timing?: any};
const S = (label: string, extra: Partial<T> = {}): T => ({label, url: `/stream/subtitle/${label.replace(/\W+/g, '_')}`, ...extra});

describe('the ★ breaks ties (lang.ts bestTrackIndex — the website rule)', () => {
  test('among equals the ★ track wins over list order', () => {
    const list = [S('Hebrew', {lang: 'he'}), S('Hebrew 2', {lang: 'he', star: true})];
    expect(bestTrackIndex(list, 'he')).toBe(1);
  });
  test('rank first: a starred SDH track never beats a full one', () => {
    const list = [S('Hebrew', {lang: 'he'}), S('Hebrew SDH', {lang: 'he', sdh: true, star: true})];
    expect(bestTrackIndex(list, 'he')).toBe(0);
    const forced = [S('English (Forced)', {lang: 'en', forced: true, star: true}), S('English', {lang: 'en'})];
    expect(bestTrackIndex(forced, 'en')).toBe(1);
  });
  test('a starred track of a better rank found later still wins', () => {
    const list = [S('Hebrew SDH', {lang: 'he', sdh: true}), S('Hebrew', {lang: 'he'}), S('Hebrew 3', {lang: 'he', star: true})];
    expect(bestTrackIndex(list, 'he')).toBe(2);
  });
  test('no ★: the first listed, as always', () => {
    const list = [S('Hebrew', {lang: 'he'}), S('Hebrew 2', {lang: 'he'})];
    expect(bestTrackIndex(list, 'he')).toBe(0);
  });
  test('a ★ in another language changes nothing', () => {
    const list = [S('English', {lang: 'en', star: true}), S('Hebrew', {lang: 'he'}), S('Hebrew 2', {lang: 'he'})];
    expect(bestTrackIndex(list, 'he')).toBe(1);
  });
  test('star must be exactly true', () => {
    const list = [S('Hebrew', {lang: 'he'}), {...S('Hebrew 2', {lang: 'he'}), star: 'yes' as unknown as boolean}];
    expect(bestTrackIndex(list, 'he')).toBe(0);
  });
  test('the auto pick takes the ★ of the Settings language and of a remembered pick', () => {
    const list = [S('English', {lang: 'en'}), S('Hebrew', {lang: 'he'}), S('Hebrew 2', {lang: 'he', star: true})];
    expect(autoPick(list, P(), 'p1').index).toBe(2);
    const remembered = P({subLang: 'en', lastSubSet: true, lastSubLang: 'he', lastSubProfile: 'p1'});
    expect(autoPick(list, remembered, 'p1')).toMatchObject({index: 2, why: 'remembered'});
    // "First available" is not a language: the first track, as before
    expect(autoPick(list, P({subLang: 'any'}), 'p1').index).toBe(0);
  });
});

describe('which Resync a track gets', () => {
  test('a library track (sidecar or inside the file) is matched to the audio', () => {
    expect(resyncMode({isTorrent: false, url: '/stream/subtitle/abc123'})).toBe('audio');
    expect(resyncMode({isTorrent: false, url: '/stream/embedded/vid9/3'})).toBe('audio');
    expect(resyncMode({isTorrent: false, url: '/stream/subtitle/abc123?retry=2'})).toBe('audio');
  });
  test('a torrent stream, or a track from elsewhere: the old reload', () => {
    expect(resyncMode({isTorrent: true, url: '/stream/subtitle/abc123'})).toBe('reload');
    expect(resyncMode({isTorrent: false, url: '/api/torrents/subs/xyz.vtt'})).toBe('reload');
    expect(resyncMode({isTorrent: false, url: 'https://example.org/a.vtt'})).toBe('reload');
  });
  test('no track: nothing', () => {
    expect(resyncMode({isTorrent: false, url: null})).toBe('none');
  });
  test('the body: the url as listed (no query), the dub by its place among the audio tracks', () => {
    expect(trackPath('/stream/subtitle/a?retry=3#x')).toBe('/stream/subtitle/a');
    const audio = [{index: 0}, {index: 1}, {index: 2}];
    expect(resyncBody('it1', '/stream/subtitle/a?retry=1', audio, 2)).toEqual({id: 'it1', track: '/stream/subtitle/a', audio: 2});
    expect(resyncBody('it1', '/stream/embedded/v/4', undefined, 0)).toEqual({id: 'it1', track: '/stream/embedded/v/4', audio: 0});
    expect(resyncBody('it1', '/stream/subtitle/a', audio, 7)).toMatchObject({audio: 0}); // unknown: the first
  });
});

describe('a job’s answers', () => {
  test('progress line', () => {
    expect(progressLine({state: 'listening', progress: 0.4})).toBe('Listening to the film… 40 %');
    expect(progressLine({state: 'listening', progress: 1})).toBe('Listening to the film… 99 %');
    expect(progressLine({state: 'listening'})).toBe('Listening to the film… 0 %');
    expect(progressLine({state: 'matching', progress: 0.92})).toBe('Matching…');
  });
  test('running → null', () => {
    expect(outcomeOf({state: 'listening', progress: 0.1})).toBeNull();
    expect(outcomeOf({state: 'matching'})).toBeNull();
  });
  test('done and applied: the server’s words, the server’s timing', () => {
    const o = outcomeOf({state: 'done', applied: true, verdict: 'moved', words: 'Moved 1.8 s later'})!;
    expect(o).toEqual({kind: 'applied', words: 'Moved 1.8 s later'});
    expect(takesServerTiming(o)).toBe(true);
    expect(outcomeOf({state: 'done', applied: true, verdict: 'parts', words: 'Matched to this release in 3 parts'})).toEqual({
      kind: 'applied',
      words: 'Matched to this release in 3 parts',
    });
  });
  test('in time: nothing moved, but the served timing is the file’s own', () => {
    const o = outcomeOf({state: 'done', applied: false, verdict: 'in-time', words: 'Already in time — nothing to move'})!;
    expect(o.kind).toBe('in-time');
    expect(takesServerTiming(o)).toBe(true);
  });
  test('unmatched and failed keep everything', () => {
    const u = outcomeOf({state: 'done', applied: false, verdict: 'unmatched', words: "Couldn't match — kept as it was"})!;
    expect(u).toEqual({kind: 'unmatched', words: "Couldn't match — kept as it was"});
    expect(takesServerTiming(u)).toBe(false);
    const f = outcomeOf({state: 'failed', error: 'too few lines', words: "Couldn't match — kept as it was"})!;
    expect(f.kind).toBe('failed');
    expect(takesServerTiming(f)).toBe(false);
    expect(outcomeOf({state: 'failed'})).toEqual({kind: 'failed', words: "Couldn't match — kept as it was"});
  });
  test('"none": the server forgot the job', () => {
    expect(outcomeOf({state: 'none', timing: null})!.kind).toBe('lost');
    expect(outcomeOf(null)!.kind).toBe('lost');
  });
  test('errors: an old server, a refusal, the line', () => {
    expect(errorOutcome({status: 404, message: '404 /api/subtitles/resync'})).toEqual({kind: 'old-server'});
    expect(errorOutcome({status: 404, message: 'Not found'})).toEqual({kind: 'old-server'});
    expect(errorOutcome({status: 404, message: "that subtitle is not one of this title's"})).toEqual({
      kind: 'refused',
      words: "Couldn't resync: that subtitle is not one of this title's",
    });
    expect(errorOutcome({status: 0, message: 'Cannot reach server'}).kind).toBe('lost');
    expect(errorOutcome({status: 500, message: 'boom'}).kind).toBe('lost');
    expect(errorOutcome(new Error('x')).kind).toBe('lost');
  });
  test('toasts', () => {
    expect(toastFor({kind: 'applied', words: 'Moved 1.8 s later'})).toBe('Moved 1.8 s later');
    expect(toastFor({kind: 'applied', words: 'Moved 1.8 s later'}, 2.5)).toBe('Moved 1.8 s later · your +2.5s delay is back to 0');
    expect(toastFor({kind: 'in-time', words: 'Already in time — nothing to move'}, -0.5)).toBe(
      'Already in time — nothing to move · your −0.5s delay is back to 0',
    );
    expect(toastFor({kind: 'unmatched', words: "Couldn't match — kept as it was"}, 3)).toBe("Couldn't match — kept as it was");
    expect(toastFor({kind: 'old-server'})).toMatch(/can't match subtitles to the audio yet — re-downloaded/);
    expect(toastFor({kind: 'cancelled'})).toBe('');
  });
});

// A fake server and clock for runResync.
const rig = (answers: (ResyncAnswer | Error)[], o: {start?: ResyncAnswer | Error; liveUntil?: number} = {}) => {
  let t = 0;
  let polls = 0;
  const lines: string[] = [];
  const bodies: unknown[] = [];
  const deps: ResyncDeps = {
    start: async b => {
      bodies.push(b);
      const s = o.start ?? {state: 'listening', progress: 0};
      if (s instanceof Error) throw s;
      return s;
    },
    status: async b => {
      bodies.push(b);
      const a = answers[Math.min(polls++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    },
    sleep: async ms => {
      t += ms;
    },
    now: () => t,
    live: () => o.liveUntil == null || polls < o.liveUntil,
    onProgress: line => lines.push(line),
  };
  return {deps, lines, bodies, polls: () => polls, time: () => t};
};
const apiErr = (status: number, message: string) => Object.assign(new Error(message), {status});
const BODY = {id: 'it1', track: '/stream/subtitle/a', audio: 0};

describe('the Resync flow (runResync)', () => {
  test('listens, matches, applies — one poll a second, the progress shown each time', async () => {
    const r = rig([
      {state: 'listening', progress: 0.4},
      {state: 'listening', progress: 0.8},
      {state: 'matching', progress: 0.92},
      {state: 'done', progress: 1, applied: true, verdict: 'moved', words: 'Moved 1.8 s later'},
    ]);
    const o = await runResync(r.deps, BODY);
    expect(o).toEqual({kind: 'applied', words: 'Moved 1.8 s later'});
    expect(r.lines).toEqual(['Listening to the film… 0 %', 'Listening to the film… 40 %', 'Listening to the film… 80 %', 'Matching…']);
    expect(r.polls()).toBe(4);
    expect(r.time()).toBe(4000);
    expect(r.bodies.every(b => JSON.stringify(b) === JSON.stringify(BODY))).toBe(true);
  });
  test('joining a job that is already done answers at once', async () => {
    const r = rig([], {start: {state: 'done', applied: false, verdict: 'unmatched', words: "Couldn't match — kept as it was"}});
    expect(await runResync(r.deps, BODY)).toEqual({kind: 'unmatched', words: "Couldn't match — kept as it was"});
    expect(r.polls()).toBe(0);
  });
  test('a server from before the route', async () => {
    const r = rig([], {start: apiErr(404, '404 /api/subtitles/resync')});
    expect(await runResync(r.deps, BODY)).toEqual({kind: 'old-server'});
  });
  test('the server refuses the track', async () => {
    const r = rig([], {start: apiErr(404, 'not in the library')});
    expect((await runResync(r.deps, BODY)).kind).toBe('refused');
  });
  test('a Wi-Fi blink while polling is ridden out', async () => {
    const r = rig([
      apiErr(0, 'Cannot reach server'),
      apiErr(0, 'Cannot reach server'),
      {state: 'matching'},
      {state: 'done', applied: true, verdict: 'parts', parts: 3, words: 'Matched to this release in 3 parts'},
    ]);
    expect(await runResync(r.deps, BODY)).toEqual({kind: 'applied', words: 'Matched to this release in 3 parts'});
  });
  test('the line stays down: gives up, nothing changed', async () => {
    const r = rig([apiErr(0, 'Cannot reach server')]);
    const o = await runResync(r.deps, BODY, {maxMisses: 3});
    expect(o.kind).toBe('lost');
    expect(takesServerTiming(o)).toBe(false);
    expect(r.polls()).toBe(3);
  });
  test('the title left the library mid-job (a 404 while polling)', async () => {
    const r = rig([apiErr(404, 'not in the library')]);
    expect((await runResync(r.deps, BODY)).kind).toBe('lost');
    expect(r.polls()).toBe(1);
  });
  test('the server restarted: "none"', async () => {
    const r = rig([{state: 'listening', progress: 0.2}, {state: 'none', timing: null}]);
    expect(await runResync(r.deps, BODY)).toEqual({kind: 'lost', words: 'The resync was interrupted — kept as it was'});
  });
  test('leaving the player stops the asking', async () => {
    const r = rig([{state: 'listening', progress: 0.2}], {liveUntil: 2});
    expect(await runResync(r.deps, BODY)).toEqual({kind: 'cancelled'});
    expect(r.polls()).toBe(2);
  });
  test('too long: stops waiting, says the track updates by itself', async () => {
    const r = rig([{state: 'listening', progress: 0.1}]);
    const o = await runResync(r.deps, BODY, {maxMs: 5000});
    expect(o.kind).toBe('lost');
    expect((o as {words: string}).words).toMatch(/update by themselves/);
    expect(r.time()).toBe(5000);
  });
  test('never throws on a strange answer', async () => {
    const r = rig([null as unknown as ResyncAnswer]);
    expect((await runResync(r.deps, BODY)).kind).toBe('lost');
  });
});

describe('subtitle_sync', () => {
  test('only for the title on screen, never for a torrent', () => {
    expect(syncPlan({msgId: 'it1', playingId: 'it1', isTorrent: false})).toEqual({refetch: true});
    expect(syncPlan({msgId: 'it2', playingId: 'it1', isTorrent: false})).toEqual({refetch: false});
    expect(syncPlan({msgId: 'it1', playingId: 'it1', isTorrent: true})).toEqual({refetch: false});
    expect(syncPlan({msgId: undefined, playingId: 'it1', isTorrent: false})).toEqual({refetch: false});
  });
  test('the track on screen reloads when the title still lists it', () => {
    const fresh = [S('Hebrew'), S('English')];
    expect(reloadAfterSync(fresh[0].url, fresh)).toBe(true);
    expect(reloadAfterSync(`${fresh[0].url}?retry=2`, fresh)).toBe(true);
    expect(reloadAfterSync('/stream/subtitle/gone', fresh)).toBe(false);
    expect(reloadAfterSync(null, fresh)).toBe(false);
  });
  test('…but only when ITS timing moved: another track lined up says nothing to the one on screen', () => {
    // after a restart the background check lines up a title's tracks one by one, one
    // subtitle_sync each — the track on screen was reloaded 2–3 times (Mi TV, 2026-10-18)
    const prev = [S('Hebrew', {timing: {verdict: 'shifted', by: 'audio', words: 'Moved 2 s later'}}), S('Hebrew 2'), S('English')];
    const otherMoved = [prev[0], S('Hebrew 2', {timing: {verdict: 'shifted', by: 'audio', words: 'Moved 1 s earlier'}}), prev[2]];
    expect(reloadAfterSync(prev[0].url, otherMoved, prev)).toBe(false);
    expect(reloadAfterSync(prev[1].url, otherMoved, prev)).toBe(true);
    const mineMoved = [S('Hebrew', {timing: {verdict: 'shifted', by: 'audio', words: 'Moved 16 s later'}}), prev[1], prev[2]];
    expect(reloadAfterSync(`${prev[0].url}?retry=1`, mineMoved, prev)).toBe(true);
    // a track the player had never listed: reload, as before
    expect(reloadAfterSync(prev[0].url, otherMoved, [])).toBe(true);
    expect(reloadAfterSync('/stream/subtitle/gone', otherMoved, prev)).toBe(false);
  });
  test('one reload for the Resync’s end and the message it causes', () => {
    expect(reloadDue(null, '/a', 1000)).toBe(true);
    expect(reloadDue({url: '/a', at: 1000}, '/a', 2500)).toBe(false);
    expect(reloadDue({url: '/a', at: 1000}, '/b', 2500)).toBe(true);
    expect(reloadDue({url: '/a', at: 1000}, '/a', 5000)).toBe(true);
  });
  test('merging: the ★ and the timing move, nothing else; unchanged = the same array', () => {
    const prev = [S('Hebrew', {lang: 'he', star: true, starWhy: 'Matches this release'}), S('Hebrew 2', {lang: 'he'}), S('English', {lang: 'en'})];
    expect(mergeSubInfo(prev, prev.map(t => ({...t})))).toBe(prev);
    const fresh = [
      S('Hebrew', {lang: 'he', timing: {verdict: 'unmatched', by: 'audio'}}),
      S('Hebrew 2', {lang: 'he', star: true, starWhy: 'Matches this release', timing: {verdict: 'moved', by: 'audio', words: 'Moved 1.8 s later', resync: true}}),
      S('English', {lang: 'en'}),
      S('Russian', {lang: 'ru'}),
    ];
    const out = mergeSubInfo(prev, fresh);
    expect(out).not.toBe(prev);
    expect(out.map(t => t.label)).toEqual(['Hebrew', 'Hebrew 2', 'English', 'Russian']); // the order stays, new ones at the end
    expect(out[0].star).toBeUndefined();
    expect(out[0].timing).toEqual({verdict: 'unmatched', by: 'audio'});
    expect(out[1]).toMatchObject({star: true, starWhy: 'Matches this release'});
    expect(out[2]).toBe(prev[2]); // untouched
  });
  test('a listed track the fresh list lacks loses its ★', () => {
    const prev = [S('Hebrew', {lang: 'he', star: true, starWhy: 'Matches this release'})];
    const out = mergeSubInfo(prev, []);
    expect(out[0].star).toBeUndefined();
    expect(out[0].starWhy).toBeUndefined();
  });
  test('an AUTO pick follows the ★ to another track of its language, with its own toast', () => {
    const before = buildTracks([S('Hebrew', {lang: 'he'}), S('Hebrew 2', {lang: 'he'}), S('English', {lang: 'en'})]);
    const p0 = autoPick(before, P(), 'p1');
    const cur = before[p0.index].key;
    expect(cur).toBe('Hebrew');
    const after = buildTracks(mergeSubInfo(before, [S('Hebrew', {lang: 'he'}), S('Hebrew 2', {lang: 'he', star: true, starWhy: 'Matches this release'}), S('English', {lang: 'en'})]));
    expect(after.map(t => t.key)).toEqual(before.map(t => t.key)); // the keys never move
    const p1 = autoPick(after, P(), 'p1');
    const step = followPick({first: false, cur, curUsable: true, pickKey: after[p1.index].key});
    expect(step).toEqual({change: true, key: 'Hebrew 2', announce: true});
    expect(switchedToast(after[0], after[p1.index], true)).toBe('Switched to Hebrew 2 — matches this release');
  });
  test('the switch toast only for a move onto the ★ within one language', () => {
    expect(switchedToast({label: 'English'}, {label: 'Hebrew', star: true}, false)).toBeNull();
    expect(switchedToast({label: 'Hebrew'}, {label: 'Hebrew 2'}, true)).toBeNull();
    expect(switchedToast(null, {label: 'Hebrew 2', star: true}, true)).toBeNull();
  });
});

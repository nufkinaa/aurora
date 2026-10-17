// One press on Play (src/playBest.ts): which source, what the player is
// handed, what a download already on its way plays, and when the title page
// may press Play for you.
import {
  AUTO_PLAY_GIVE_UP_MS,
  autoPlayStep,
  jobSource,
  pickBest,
  runningJobFor,
  runtimeToSeconds,
  streamPlayItem,
} from '../../src/playBest';
import type {Stream} from '../../src/api';

const st = (o: Partial<Stream>): Stream =>
  ({infoHash: 'h'.repeat(40), fileIdx: 0, filename: '', release: '', provider: null, quality: '1080p', qualityLabel: '', tags: [], cam: false, dubbed: false, seeders: 10, sizeString: '2 GB', sizeBytes: 2e9, languages: [], ...o}) as Stream;

describe('the pick (the same rule the title page always used)', () => {
  test('the recommended one among those with peers', () => {
    const a = st({infoHash: 'a', seeders: 90});
    const b = st({infoHash: 'b', seeders: 20, recommended: true});
    expect(pickBest([a, b])).toBe(b);
  });
  test('a recommended source with no peers is passed over for one that has them', () => {
    const dead = st({infoHash: 'd', seeders: 0, recommended: true});
    const live = st({infoHash: 'l', seeders: 3});
    expect(pickBest([dead, live])).toBe(live);
  });
  test('nobody seeding: the first listed; nothing listed: nothing', () => {
    const x = st({infoHash: 'x', seeders: 0});
    expect(pickBest([x])).toBe(x);
    expect(pickBest([])).toBeNull();
    expect(pickBest(null)).toBeNull();
  });
});

describe('what the player is handed', () => {
  const film = {type: 'movie' as const, imdbId: 'tt1', title: 'Film', year: 2020, runtime: '1h 52min', poster: '/p.jpg'};
  test("a film: the server's stream routes, the true runtime, card metadata", () => {
    const pi = streamPlayItem(st({infoHash: 'abc', fileIdx: 2}), film);
    expect(pi).toMatchObject({
      id: 'torrent|abc|2',
      videoUrl: '/stream/torrent/abc/2',
      transcodeBase: '/stream/torrent/hls/abc/2',
      isTorrent: true,
      type: 'movie',
      imdbId: 'tt1',
      duration: 112 * 60,
      needsTranscode: false,
      transcodeV: 'copy',
      cover: '/p.jpg',
      year: 2020,
    });
    expect(pi.season).toBeUndefined();
  });
  test('an episode carries its season and episode — what the player fetches its subtitles by', () => {
    const pi = streamPlayItem(st({}), {...film, type: 'series', season: 2, episode: 5});
    expect(pi).toMatchObject({type: 'show', season: 2, episode: 5, imdbId: 'tt1'});
  });
  test("the release's own name rides along — the server ranks subtitle files against it (fix-subs)", () => {
    expect(streamPlayItem(st({filename: 'Film.2020.1080p.WEB-DL.GRP.mkv', release: 'Film 2020'}), film).release).toBe('Film.2020.1080p.WEB-DL.GRP.mkv');
    expect(streamPlayItem(st({release: 'Film 2020'}), film).release).toBe('Film 2020');
    expect(streamPlayItem(st({}), film).release).toBeUndefined();
    expect(jobSource({status: 'downloading', infoHash: 'f', fileIdx: 0, release: 'Film.2020.mkv'}, []).release).toBe('Film.2020.mkv');
  });
  test('release tags pick the remux up front: audio → copy, picture → h264', () => {
    expect(streamPlayItem(st({tags: ['DTS']}), film)).toMatchObject({needsTranscode: true, transcodeV: 'copy'});
    expect(streamPlayItem(st({tags: ['H.265', 'Atmos']}), film)).toMatchObject({needsTranscode: true, transcodeV: 'h264'});
  });
  test('runtimes', () => {
    expect(runtimeToSeconds('152 min')).toBe(152 * 60);
    expect(runtimeToSeconds(45)).toBe(45 * 60);
    expect(runtimeToSeconds(null)).toBe(0);
  });
});

describe('a download already on its way', () => {
  const jobs = [
    {id: '1', status: 'done', infoHash: 'old', fileIdx: 0, imdbId: 'tt1'},
    {id: '2', status: 'downloading', infoHash: 'film', fileIdx: 1, imdbId: 'tt1', quality: '1080p'},
    {id: '3', status: 'approved', infoHash: 'ep', fileIdx: 4, imdbId: 'tt9', season: 1, episode: 3},
  ];
  test('the running job for the film / for that episode — never a finished one, never another episode', () => {
    expect(runningJobFor(jobs, 'tt1')?.id).toBe('2');
    expect(runningJobFor(jobs, 'tt9', 1, 3)?.id).toBe('3');
    expect(runningJobFor(jobs, 'tt9', 1, 4)).toBeNull();
    expect(runningJobFor(jobs, 'tt9')).toBeNull(); // the film key is not an episode's
    expect(runningJobFor(jobs, 'tt2')).toBeNull();
  });
  test("it plays the source it is fetching — with that source's tags when the list has it", () => {
    const j = runningJobFor(jobs, 'tt1')!;
    expect(jobSource(j, [st({infoHash: 'film', fileIdx: 1, tags: ['DTS']})]).tags).toEqual(['DTS']);
    expect(jobSource(j, [])).toEqual({infoHash: 'film', fileIdx: 1, quality: '1080p', tags: null});
  });
});

describe('the title page pressing Play for you', () => {
  const all = {torrentsKnown: true, libraryKnown: true, jobsKnown: true, target: true, stateKnown: true, elapsed: 900};
  test('presses only once everything a press depends on is known', () => {
    expect(autoPlayStep(all)).toBe('press');
    for (const k of ['torrentsKnown', 'libraryKnown', 'jobsKnown', 'target', 'stateKnown'] as const)
      expect(autoPlayStep({...all, [k]: false})).toBe('wait');
  });
  test('gives up — leaving the page as it is — rather than guess', () => {
    expect(autoPlayStep({...all, libraryKnown: false, elapsed: AUTO_PLAY_GIVE_UP_MS})).toBe('drop');
  });
});

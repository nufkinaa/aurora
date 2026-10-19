// "Play on TV": the player params a play_item opens (src/remote/playItem.ts),
// and which subtitle / audio track a language the remote asked for is.
import {audioForLang, playerParams, sameLang, subForLang} from '../../src/remote/playItem';
import type {PlayItemArgs, WireItem} from '../../src/remote/protocol';
import {buildTracks} from '../../src/playback/subTracks';

const item = (o: Partial<WireItem> = {}): WireItem => ({
  id: 'm1',
  title: 'Dune',
  showTitle: null,
  epTitle: null,
  season: null,
  episode: null,
  type: 'movie',
  imdbId: 'tt1160419',
  poster: '/img/m1.jpg',
  duration: 9300,
  ...o,
});
const args = (o: Partial<PlayItemArgs> = {}): PlayItemArgs => ({item: item(), position: null, restart: false, subLang: null, audioLang: null, ...o});

test('a library film: its id and title, nothing else', () => {
  expect(playerParams(args())).toEqual({id: 'm1', title: 'Dune'});
});

test('a position: where the player starts (remote.position)', () => {
  expect(playerParams(args({position: 1234.5}))).toEqual({id: 'm1', title: 'Dune', remote: {position: 1234.5}});
  expect(playerParams(args({position: 0}))).toEqual({id: 'm1', title: 'Dune'});
});

test('restart: from the top — a position is not carried', () => {
  expect(playerParams(args({restart: true, position: 600}))).toEqual({id: 'm1', title: 'Dune', restart: true});
});

test('the languages ride along; null means the TV decides', () => {
  expect(playerParams(args({subLang: 'he', audioLang: 'en'}))).toEqual({id: 'm1', title: 'Dune', remote: {subLang: 'he', audioLang: 'en'}});
  expect(playerParams(args({subLang: 'off'})).remote).toEqual({subLang: 'off'});
  expect(playerParams(args({subLang: null, audioLang: null})).remote).toBeUndefined();
});

test('a library episode: "Show · S1 E2" (openItem.ts), its own name as epTitle', () => {
  const ep = item({id: 'e12', title: 'The Bay', showTitle: 'Silo', epTitle: 'The Bay', season: 1, episode: 2, type: null});
  expect(playerParams(args({item: ep, position: 300}))).toEqual({id: 'e12', title: 'Silo · S1 E2', epTitle: 'The Bay', remote: {position: 300}});
  // a placeholder name is not a name
  const bare = item({id: 'e13', title: 'Episode 3', showTitle: 'Silo', season: 1, episode: 3, type: null});
  expect(playerParams(args({item: bare}))).toEqual({id: 'e13', title: 'Silo · S1 E3'});
});

test('a stream (`torrent|hash|idx`): the play item is built from the id, as openItem.ts case 1', () => {
  const t = item({id: 'torrent|abc123|4', title: 'Dune', duration: 9300, poster: 'https://image.tmdb.org/p.jpg'});
  const p = playerParams(args({item: t, position: 61}));
  expect(p.id).toBe('torrent|abc123|4');
  expect(p.title).toBe('Dune');
  expect(p.remote).toEqual({position: 61});
  expect(p.stream).toEqual({
    id: 'torrent|abc123|4',
    title: 'Dune',
    videoUrl: '/stream/torrent/abc123/4',
    transcodeBase: '/stream/torrent/hls/abc123/4',
    infoHash: 'abc123',
    fileIdx: 4,
    isTorrent: true,
    type: 'movie',
    imdbId: 'tt1160419',
    season: undefined,
    episode: undefined,
    duration: 9300,
    cover: 'https://image.tmdb.org/p.jpg',
  });
});

test('a streamed episode: a show, with its season and episode', () => {
  const t = item({id: 'torrent|ff|0', title: 'The Bay', showTitle: 'Silo', season: 2, episode: 10, type: 'show'});
  const p = playerParams(args({item: t}));
  expect(p.title).toBe('Silo · S2 E10');
  expect(p.stream).toMatchObject({type: 'show', season: 2, episode: 10, fileIdx: 0, infoHash: 'ff'});
});

test('languages are the same however they are written', () => {
  expect(sameLang('he', 'heb')).toBe(true);
  expect(sameLang('iw', 'he')).toBe(true);
  expect(sameLang('fr', 'fre')).toBe(true);
  expect(sameLang('fr', 'de')).toBe(false);
  expect(sameLang('en', 'he')).toBe(false);
  expect(sameLang('', 'he')).toBe(false);
  expect(sameLang(null, 'he')).toBe(false);
});

test('the subtitle track for a language: by tag, by label for the three, the ★ first, Forced last', () => {
  const tracks = buildTracks([
    {label: 'English', url: '/s/1', lang: 'en'},
    {label: 'Hebrew (Forced)', url: '/s/2', lang: 'he', forced: true},
    {label: 'Hebrew', url: '/s/3', lang: 'heb'},
    {label: 'Hebrew 2', url: '/s/4', lang: 'he', star: true},
    {label: 'French', url: '/s/5', lang: 'fre'},
    {label: 'Russian subtitles', url: '/s/6'},
  ]);
  expect(subForLang(tracks, 'he')?.url).toBe('/s/4');
  expect(subForLang(tracks, 'en')?.url).toBe('/s/1');
  expect(subForLang(tracks, 'fr')?.url).toBe('/s/5');
  expect(subForLang(tracks, 'ru')?.url).toBe('/s/6');
  expect(subForLang(tracks, 'de')).toBeNull();
  expect(subForLang(tracks, 'off')).toBeNull();
  expect(subForLang([], 'he')).toBeNull();
});

test('the dub for a language', () => {
  const list = [
    {index: 0, language: 'eng'},
    {index: 1, language: 'heb'},
    {index: 2, language: null},
  ];
  expect(audioForLang(list, 'he')?.index).toBe(1);
  expect(audioForLang(list, 'en')?.index).toBe(0);
  expect(audioForLang(list, 'ja')).toBeNull();
});

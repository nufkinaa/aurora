// "Play on TV": which screen a play_item opens, with which params — PURE
// (__tests__/logic/remote-play.test.ts). The same rules as a card pressed on
// the TV (openItem.ts): a `torrent|<hash>|<idx>` id carries its own play item
// (its addresses cannot be looked up); anything else is a library id the
// player fetches itself. An episode's title is "Show · S1 E2", as openItem.ts
// and the player's goNext make it (the player splits it back for its header).
//
// And, for the player once it is up: which subtitle / audio track a language
// the remote asked for is (`remote.subLang` / `remote.audioLang`).
import type {TorrentPlayItem} from '../api';
import {langCode, langOf} from '../lang';
import {langName} from '../playback/subTracks';
import type {PlayItemArgs} from './protocol';

/** What the player is told by a remote that opened it (navigation.tsx Player `remote`). */
export type RemoteStart = {position?: number; subLang?: string | null; audioLang?: string | null};

export type PlayerParams = {
  id: string;
  title: string;
  epTitle?: string;
  stream?: TorrentPlayItem;
  restart?: boolean;
  remote?: RemoteStart;
};

const isEpisode = (it: PlayItemArgs['item']) => !!it.showTitle && it.season != null && it.episode != null;

export const playerParams = (a: PlayItemArgs): PlayerParams => {
  const it = a.item;
  const title = isEpisode(it) ? `${it.showTitle} · S${it.season} E${it.episode}` : it.title || it.showTitle || '';
  const remote: RemoteStart = {};
  if (!a.restart && typeof a.position === 'number' && a.position > 0) remote.position = a.position;
  if (a.subLang) remote.subLang = a.subLang;
  if (a.audioLang) remote.audioLang = a.audioLang;
  const out: PlayerParams = {id: it.id, title};
  // the episode's own name (the library may only know "Episode 1")
  const ep = it.epTitle || (isEpisode(it) && it.title && it.title !== it.showTitle ? it.title : null);
  if (ep && !/^Episode \d+$/.test(ep)) out.epTitle = ep;
  if (a.restart) out.restart = true;
  if (Object.keys(remote).length) out.remote = remote;
  if (it.id.startsWith('torrent|')) {
    const parts = it.id.split('|');
    const hash = parts[1] || '';
    const fileIdx = parseInt(parts[2], 10) || 0;
    out.stream = {
      id: it.id,
      title,
      videoUrl: `/stream/torrent/${hash}/${fileIdx}`,
      transcodeBase: `/stream/torrent/hls/${hash}/${fileIdx}`,
      infoHash: hash,
      fileIdx,
      isTorrent: true,
      type: it.type === 'show' || isEpisode(it) ? 'show' : 'movie',
      imdbId: it.imdbId || undefined,
      season: it.season ?? undefined,
      episode: it.episode ?? undefined,
      duration: it.duration || undefined,
      cover: it.poster ?? null,
    };
  }
  return out;
};

/** The same language, however each side writes it ("he" / "heb" / "iw", "fr" / "fre" / "French"). */
export const sameLang = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.trim() || !b.trim()) return false;
  const ca = langCode(a);
  const cb = langCode(b);
  if (ca || cb) return ca === cb;
  const na = langName(a);
  return !!na && na === langName(b);
};

type SubLike = {key: string; lang?: string; label: string; star?: boolean; forced?: boolean};
/** The subtitle track for a language: one the language matches (by its tag,
 *  else its label for Hebrew / English / Russian), the server's ★ first, a
 *  "Forced" one last. null: none (yet). */
export const subForLang = <T extends SubLike>(tracks: T[], lang: string): T | null => {
  if (!lang || lang === 'off') return null;
  const want = langCode(lang);
  const match = tracks.filter(t => (want ? langOf(t) === want : sameLang(t.lang, lang)));
  if (!match.length) return null;
  const rank = (t: T) => (t.forced ? 2 : 0) - (t.star ? 1 : 0);
  return [...match].sort((x, y) => rank(x) - rank(y))[0];
};

/** The dub for a language, or null. */
export const audioForLang = <T extends {index: number; language?: string | null}>(list: T[], lang: string): T | null =>
  (lang && list.find(t => sameLang(t.language, lang))) || null;

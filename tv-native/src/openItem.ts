// One place that decides what pressing a card does, mirroring the browser
// client's `openItem` in public/js/components.js. Every grid and shelf routes
// through here so the four cases can't drift apart per screen.
//
// The cases, in the order they have to be tested:
//
//   1. `torrent|…` — a stream someone is part-way through. Its play URLs are NOT
//      reconstructable from the id (the id is just infoHash + file index), so the
//      stored item has to be handed to the player as-is. Pushing this to Detail
//      instead is why resuming a stream did nothing: Detail read it as a library
//      movie and asked /api/item for an id that is only a stub.
//   2. an EPISODE — no `type`, but a showId and its own playable id. Straight to
//      the player; a Detail page for one episode renders the movie layout and
//      calls itself a FILM.
//   3. a stream (Discover) title — Detail, which fetches Cinemeta metadata.
//   4. anything else — Detail.
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {HeroItem, TorrentPlayItem} from './api';
import {canNavigate} from './navLock';
// Type-only import: navigation.tsx imports the screens, the screens import this,
// so a value import here would close a require cycle at runtime.
import type {RootStackParamList} from './navigation';

// Generic over the CURRENT route: a screen's navigation prop is typed to its own
// route name, and the union-typed version is not assignable from it (setParams
// varies with the route's params). Generic keeps every caller's own typing.
type Nav<R extends keyof RootStackParamList> = NativeStackNavigationProp<
  RootStackParamList,
  R
>;

export const openItem = <R extends keyof RootStackParamList>(
  nav: Nav<R>,
  item: HeroItem,
) => {
  if (!canNavigate(nav as never)) return;

  // 1. Resume a part-watched stream.
  if (typeof item.id === 'string' && item.id.startsWith('torrent|')) {
    // `torrent|<infoHash>|<fileIdx>` — the index is needed by the stream routes.
    const parts = item.id.split('|');
    const fileIdx = parseInt(parts[2], 10) || 0;
    const stream: TorrentPlayItem = {
      id: item.id,
      title: item.title,
      videoUrl: item.videoUrl || `/stream/torrent/${parts[1]}/${fileIdx}`,
      transcodeBase:
        item.transcodeBase || `/stream/torrent/hls/${parts[1]}/${fileIdx}`,
      infoHash: item.infoHash || parts[1],
      fileIdx,
      isTorrent: true,
      type: item.type === 'show' ? 'show' : 'movie',
      imdbId: item.imdbId,
      season: item.season,
      episode: item.episode,
      // A resumed stream never went through the Sources screen, so it has no
      // runtime from metadata — but the saved progress entry recorded the total
      // when it was last played, and that is the same number. Without it the
      // scrubber has no end and shows 0:00 / 0:00.
      duration: item.progress?.duration || undefined,
      // The transcode verdict was decided when the source was first picked and
      // stored with the entry; re-deciding it here would need the release tags,
      // which a Continue Watching row does not carry.
      needsTranscode: item.transcodeV ? true : undefined,
      transcodeV: item.transcodeV,
      // Carried through so the player can hand the SAME card metadata back with
      // the next saved position. Dropping it would have the TV overwrite a
      // poster-bearing entry with a blank one the first time it saved progress.
      year: item.year ?? null,
      cover: item.cover ?? item.poster ?? null,
      backdrop: item.backdrop ?? null,
      // Same rule: the server replaces the stored item wholesale on every save,
      // so any field not carried back here is erased by the first resume.
      quality: item.quality,
    };
    nav.push('Player', {id: item.id, title: item.title, stream});
    return;
  }

  // 2. An episode from Continue Watching.
  if (!item.type && item.showId && item.id) {
    nav.push('Player', {
      id: item.id,
      title:
        item.showTitle && item.season != null && item.episode != null
          ? `${item.showTitle} · S${item.season} E${item.episode}`
          : item.title,
    });
    return;
  }

  // 3 + 4. Everything else has a Detail page that knows stream from library.
  nav.push('Detail', {item});
};

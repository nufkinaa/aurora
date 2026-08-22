// What this profile's history says about a title: started, finished, and when it
// was last touched. Transcribed from `public/js/state.js:117-145`.
//
// The reason it exists, in the site's own words: asking `progress[item.id]` only
// ever answers for a downloaded FILM. A show's history is filed under each
// EPISODE's id, a streamed film's under the torrent file it played from, and a
// streamed episode's in a separate map keyed by show — so the direct lookup came
// back empty for all three, and "Unwatched" happily offered you the series you
// finished last week.
import type {HeroItem, ProfileState, Progress} from './api';

export type Marks = {started: boolean; finished: boolean; at: number};

export const NOT_WATCHED: Marks = {started: false, finished: false, at: 0};

// `seasons` is read structurally rather than added to HeroItem: a library SHOW
// carries the full `Season[]` and a watchlist entry may carry nothing, and
// widening HeroItem to the narrow shape this needs breaks Detail and the player,
// which read the same field expecting episode numbers and titles.
type WithSeasons = {seasons?: {episodes?: {id?: string}[]}[]};

const episodeIdsOf = (item: HeroItem) =>
  ((item as WithSeasons).seasons || [])
    .flatMap(s => (s.episodes || []).map(e => e.id))
    .filter(Boolean) as string[];

/** Bind the three progress maps once; the returned function is what callers
 *  memoise per list (resolving a series walks its whole episode tree). */
export function watchStateFor(s: ProfileState | null) {
  const progress = s?.progress || {};
  const episodeProgress = s?.episodeProgress || {};
  const streamProgress = s?.streamProgress || {};
  return (item: HeroItem): Marks => {
    if (!item) return NOT_WATCHED;
    const isShow = item.type === 'show';
    const episodeIds = isShow ? episodeIdsOf(item) : [];
    const found: (Progress | undefined)[] = [];

    if (isShow) {
      for (const id of episodeIds) found.push(progress[id]);
      if (item.imdbId) {
        for (const [key, p] of Object.entries(episodeProgress)) {
          if (key.startsWith(`${item.imdbId}:`)) found.push(p);
        }
      }
    } else {
      found.push(progress[item.id]);
      if (item.imdbId) {
        found.push(streamProgress[item.imdbId], progress[`stream|${item.imdbId}`]);
      }
    }

    const seen = found.filter(Boolean) as Progress[];
    const done = seen.filter(p => p.finished).length;
    return {
      started: seen.length > 0,
      // A series is only done when every episode we can see is done. For a
      // streamable one we cannot see the full run at all, so it stays "in
      // progress" rather than claiming you finished it after one episode.
      finished: isShow ? episodeIds.length > 0 && done >= episodeIds.length : done > 0,
      at: seen.reduce((latest, p) => Math.max(latest, p.updatedAt || 0), 0),
    };
  };
}

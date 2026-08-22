// Turning watch history back into "have I seen this title?".
//
// Harder than it sounds, because progress is keyed by whatever was PLAYED, and
// that is four different kinds of thing:
//
//   <libraryId>                      a scanner item (movie, show or episode)
//   torrent|<infoHash>|<fileIdx>     a torrent — resolved through streamItems,
//                                    which is the only record of which title it was
//   stream|<imdbId>                  a film ticked off without a local copy
//   stream|<imdbId>|<season>|<ep>    one episode of a show, same
//
// None of those is the id a catalogue entry carries, which is why the home screen
// spent a long time filtering watched titles with `progress[item.id]` — always
// `progress[undefined]` for anything streamable, so the filter did nothing at all.
const discover = require("./discover");
const scanner = require("./scanner");

// Returns { movies: Set<idOrImdbId>, episodes: Map<showKey, Set<episodeKey>> }.
//
// Episodes go through a Set rather than a counter because the same episode
// watched from two different torrents is two progress keys and one episode —
// counting keys would report a 10-episode show as finished after five.
const watchedIndex = ({ progress = {}, streamItems = {} } = {}) => {
  const movies = new Set();
  const episodes = new Map();

  const addMovie = (...keys) => {
    for (const k of keys) if (k) movies.add(k);
  };
  const addEpisode = (episodeKey, ...showKeys) => {
    for (const k of showKeys) {
      if (!k) continue;
      if (!episodes.has(k)) episodes.set(k, new Set());
      episodes.get(k).add(episodeKey);
    }
  };

  for (const [key, prog] of Object.entries(progress)) {
    if (!prog || !prog.finished) continue;

    if (key.startsWith("torrent|")) {
      const meta = streamItems[key];
      if (!meta || !meta.imdbId) continue;
      if (meta.season && meta.episode) {
        addEpisode(`${meta.season}:${meta.episode}`, meta.imdbId);
      } else {
        addMovie(meta.imdbId);
      }
      continue;
    }

    if (key.startsWith("stream|")) {
      const [, imdbId, season, episode] = key.split("|");
      if (!imdbId) continue;
      if (season && episode) addEpisode(`${season}:${episode}`, imdbId);
      else addMovie(imdbId);
      continue;
    }

    const item = scanner.findById(key);
    if (!item) continue;
    if (item.showId) {
      const show = scanner.findById(item.showId);
      // Keyed by the library id AND the show's IMDb id, because the thing being
      // filtered might have arrived from either side.
      addEpisode(key, item.showId, show && show.imdbId);
      if (item.season && item.episode) {
        addEpisode(`${item.season}:${item.episode}`, item.showId, show && show.imdbId);
      }
    } else if (item.type !== "show") {
      addMovie(item.id, item.imdbId);
    }
    // Progress recorded against a show id itself names no episode, so there is
    // nothing countable in it — better ignored than guessed at.
  }

  return { movies, episodes };
};

// Every episode key we hold for a show, under either of its ids.
const watchedEpisodesFor = (watched, item) =>
  new Set([
    ...(item.id ? watched.episodes.get(item.id) || [] : []),
    ...(item.imdbId ? watched.episodes.get(item.imdbId) || [] : []),
  ]);

// How many episodes does this show have in total? Library shows carry the count;
// streamable ones only once someone has opened their detail page and warmed
// meta(). A miss returns 0, which reads as "don't know" below.
const totalEpisodes = (item) => {
  if (item.episodeCount) return item.episodeCount;
  if (!item.imdbId) return 0;
  const meta = discover.metaCached("series", item.imdbId);
  return (meta && meta.episodeCount) || 0;
};

// Is the profile done with this title? Movies: watched to the end. Shows: every
// episode watched.
//
// Fails OPEN on purpose. When we cannot tell how many episodes a show has, the
// answer is "not finished" — hiding a show you are halfway through is a much
// worse outcome than occasionally offering one you completed.
const makeIsSeen = (watched) => (item) => {
  if (item.type === "show") {
    const seen = watchedEpisodesFor(watched, item);
    if (!seen.size) return false;
    const total = totalEpisodes(item);
    if (!total) return false;
    return seen.size >= total;
  }
  return (
    (!!item.id && watched.movies.has(item.id)) ||
    (!!item.imdbId && watched.movies.has(item.imdbId))
  );
};

module.exports = { watchedIndex, makeIsSeen, watchedEpisodesFor, totalEpisodes };

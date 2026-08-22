// "New Episodes": shows you follow that have just put out something you haven't
// watched.
//
// Two decisions shape this row.
//
// What counts as FOLLOWING is deliberately strict — My List, or rated 4/5 stars.
// The looser definitions (anything you have ever pressed play on, anything in the
// library) turn this into a second Continue Watching: it fills with shows you
// bounced off, and the row stops meaning "the thing you are waiting for".
//
// What counts as NEW is the episode's AIR DATE, not when it was downloaded. A
// season that landed on disk in one go last night is not nine new episodes.
const discover = require("./discover");
const scanner = require("./scanner");
const { watchedIndex, watchedEpisodesFor } = require("./watched");

// How far back an episode can have aired and still be "new". Long enough to
// survive a fortnight away from the house, short enough that the row is about
// what is airing now.
const RECENT_DAYS = 45;
const DAY_MS = 24 * 3600 * 1000;
const CAP = 20;

const IMDB_ID = /^tt\d+$/;
// A rating is stored as id -> stars with no type beside it, so a 5-star film and
// a 5-star show are the same shape. Asking Cinemeta for the series meta settles
// it, but the answer for a film is a failed request — so remember those, or the
// warm spends one request per rated film on every home load, forever.
const notSeries = new Map();
const NOT_SERIES_TTL = 24 * 3600 * 1000;
const MAX_WARM = 12;

const isFollowedRating = (stars) => Number(stars) >= 4;

// Every id this profile has told us it cares about, from either signal.
const followKeys = ({ watchlist = [], ratings = {} }) => {
  const keys = new Set();
  for (const entry of watchlist) {
    keys.add(typeof entry === "string" ? entry : entry && entry.imdbId);
  }
  for (const [key, stars] of Object.entries(ratings)) {
    if (isFollowedRating(stars)) keys.add(key);
  }
  return [...keys].filter(Boolean);
};

// The downloaded copy of a show, if there is one.
//
// Library items carry no IMDb id — the scanner reads filenames, not catalogues —
// so a normalised title is the only link between the two sides. That is already
// how discover.js decides a catalogue entry is "in library", so this reuses the
// same idiom rather than inventing a second one.
//
// It matters twice here: the card should open the local copy, and an episode
// watched from disk is recorded against the LIBRARY id, so without this the row
// would keep advertising the episode you watched last night.
const libraryShow = (title) => {
  if (!title) return null;
  const want = discover.normalize(title);
  return (
    scanner
      .allItems()
      .find((i) => i.type === "show" && discover.normalize(i.title || "") === want) || null
  );
};

// A renderable card for a followed show, preferring the local copy.
const cardFor = (meta) => {
  const local = libraryShow(meta.title);
  // The IMDb id rides along on the library card: the scanner cannot know it, but
  // this row does, and the episode lookup needs it.
  return local
    ? { ...local, imdbId: meta.imdbId }
    : { ...meta, cover: meta.poster || null, source: "stream" };
};

// One follow key -> a show card, or null if it is not a show we can resolve.
//
// The catalogue only holds what Home happens to have loaded, and a downloaded
// show is deliberately filtered OUT of the streamable lists — so the show most
// likely to be followed is the one least likely to be in there. Falling back to
// the cached series meta is what makes the row work for downloaded shows at all.
const resolveShow = (key, catalogue) => {
  const known = catalogue && catalogue.get(key);
  if (known && known.type !== "show") return null;
  if (known && known.imdbId) return cardFor(known);
  if (!IMDB_ID.test(key)) return null;
  const meta = discover.metaCached("series", key);
  if (!meta || !meta.seasons) return null;
  return cardFor(meta);
};

// The shows this profile follows, as card-shaped items.
const followedShows = ({ watchlist = [], ratings = {}, catalogue }) => {
  const shows = [];
  const seen = new Set();
  for (const key of followKeys({ watchlist, ratings })) {
    const item = resolveShow(key, catalogue);
    if (!item || !item.imdbId || seen.has(item.imdbId)) continue;
    seen.add(item.imdbId);
    shows.push(item);
  }
  return shows;
};

// Episodes of one show that aired recently and have not been watched.
//
// Reads the cached Cinemeta meta only — a show whose meta isn't warm yet simply
// contributes nothing this time round, which is what keeps Home off the network.
const freshEpisodes = (show, watched, now) => {
  const meta = discover.metaCached("series", show.imdbId);
  if (!meta || !meta.seasons) return [];
  const local = libraryShow(show.title);
  const seenKeys = new Set([
    ...watchedEpisodesFor(watched, show),
    ...(local ? watchedEpisodesFor(watched, { id: local.id }) : []),
  ]);
  const floor = now - RECENT_DAYS * DAY_MS;
  const out = [];
  for (const season of meta.seasons) {
    for (const ep of season.episodes || []) {
      const at = Date.parse(ep.released);
      // Unaired episodes belong to the detail page, not to a row that promises
      // something to watch tonight.
      if (!Number.isFinite(at) || at > now || at < floor) continue;
      if (seenKeys.has(`${season.number}:${ep.episode}`)) continue;
      out.push({ season: season.number, episode: ep.episode, at });
    }
  }
  return out;
};

// Warm the metas the row depends on. Background only — a handful of ids, and
// meta() caches for 12 hours, so this is nearly always a no-op.
const warm = async ({ watchlist, ratings, catalogue, now = Date.now() } = {}) => {
  let spent = 0;
  for (const key of followKeys({ watchlist, ratings })) {
    if (spent >= MAX_WARM) break;
    if (!IMDB_ID.test(key)) continue;
    if (discover.metaCached("series", key)) continue;
    const known = catalogue && catalogue.get(key);
    if (known && known.type !== "show") continue;
    const marked = notSeries.get(key);
    if (marked && now - marked < NOT_SERIES_TTL) continue;
    spent += 1;
    const meta = await discover.meta("series", key).catch(() => null);
    if (!meta || !meta.seasons) notSeries.set(key, now);
  }
};

// The row, newest episode first. Synchronous and cache-only.
const select = ({
  watchlist = [],
  ratings = {},
  progress = {},
  streamItems = {},
  catalogue,
  now = Date.now(),
  cap = CAP,
} = {}) => {
  const watched = watchedIndex({ progress, streamItems });
  const rows = [];
  for (const show of followedShows({ watchlist, ratings, catalogue })) {
    const fresh = freshEpisodes(show, watched, now);
    if (!fresh.length) continue;
    const latest = fresh.reduce((a, b) => (b.at > a.at ? b : a));
    rows.push({ show, latest, count: fresh.length });
  }
  rows.sort((a, b) => b.latest.at - a.latest.at);
  return rows.slice(0, cap).map(({ show, latest, count }) => ({
    ...show,
    // What the card can say beyond the poster: which episode is waiting, and how
    // many there are if you have fallen behind.
    newEpisode: { season: latest.season, episode: latest.episode, released: latest.at },
    newEpisodeCount: count,
  }));
};

module.exports = {
  select,
  warm,
  followedShows,
  _internals: { freshEpisodes, libraryShow, notSeries, RECENT_DAYS },
};

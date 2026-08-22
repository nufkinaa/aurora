// Is a film actually watchable at home yet?
//
// "New Movies" used to mean "recently downloaded", and the obvious fix — sort the
// catalogue by release date — is wrong for a different reason: Cinemeta's
// `released` / `releaseInfo` is the THEATRICAL date. A film that opened in cinemas
// last week reads as released, so the row fills up with titles nobody can watch
// yet, mixed in with ones that were announced and have no release at all.
//
// TMDB is the only source that separates those. Its release_dates endpoint tags
// every date with a type, so "can I watch this at home" is a real question with a
// real answer: is there a digital, physical or TV release whose date has passed.
//
// Needs a tmdbApiKey. Without one every lookup returns an "unknown" verdict and
// callers fall back to the year heuristic, so the feature degrades to roughly
// what it was rather than emptying the rows.
const path = require("path");
const config = require("../config");
const torrent = require("./torrent");
const { JsonStore } = require("../lib/jsonstore");

// TMDB release types. 1 Premiere, 2 Theatrical (limited), 3 Theatrical,
// 4 Digital, 5 Physical, 6 TV.
const HOME_TYPES = new Set([4, 5, 6]);
const THEATRICAL_TYPES = new Set([1, 2, 3]);

const store = new JsonStore(path.join(config.CACHE_DIR, "availability.json"), {
  v: 1,
  titles: {},
});
if (!store.data.titles) store.data.titles = {};

// A "yes, it's out" verdict never expires — a release cannot un-happen. A "not
// yet" one has to, because that is exactly the answer that changes: today's
// theatrical-only film is next month's digital release.
const PENDING_TTL = 12 * 3600 * 1000;
// How many real releases make a film effectively out. More than one, because a
// single mislabelled junk torrent should not flip a verdict; low, because a film
// that has genuinely leaked has dozens.
const ENOUGH_STREAMS = 3;
// Anything this old is out on something by now, and asking TMDB about a 2011 film
// is two requests spent to be told what the year already said. Only titles from
// this year and last are actually ambiguous.
const AMBIGUOUS_YEARS = 2;
// A cold cache would otherwise fire two requests per recent title in one go. The
// verdicts persist, so this only bites on the very first warm.
const MAX_LOOKUPS_PER_PASS = 80;
const CONCURRENCY = 6;

const tmdbJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`tmdb ${res.status}`);
  return res.json();
};

// Cinemeta hands back `moviedb_id` on a full meta but not on catalogue entries,
// so a pool item only has its IMDb id. This is the one extra request that costs.
const tmdbIdForImdb = async (imdbId) => {
  const data = await tmdbJson(
    `https://api.themoviedb.org/3/find/${imdbId}?api_key=${config.TMDB_KEY}&external_source=imdb_id`,
  );
  const hit = (data.movie_results || [])[0];
  return hit ? hit.id : null;
};

// Earliest date of any release whose type is in `types`, as a timestamp.
const earliest = (results, types) => {
  let best = null;
  for (const entry of results || []) {
    for (const r of entry.release_dates || []) {
      if (!types.has(r.type)) continue;
      const t = Date.parse(r.release_date);
      if (!Number.isFinite(t)) continue;
      if (best === null || t < best) best = t;
    }
  }
  return best;
};

// The verdict for one film, straight from TMDB. `home` is null (not false) when
// we could not find out, so callers can tell "not released" apart from "no idea".
const lookup = async (imdbId, now) => {
  const tmdbId = await tmdbIdForImdb(imdbId);
  if (!tmdbId) return { home: null, homeAt: null, theatricalAt: null };
  const data = await tmdbJson(
    `https://api.themoviedb.org/3/movie/${tmdbId}/release_dates?api_key=${config.TMDB_KEY}`,
  );
  const homeAt = earliest(data.results, HOME_TYPES);
  const theatricalAt = earliest(data.results, THEATRICAL_TYPES);
  return { home: homeAt !== null && homeAt <= now, homeAt, theatricalAt };
};

// Does this film actually have watchable releases out there?
//
// The reason this exists: TMDB's digital date is the date the STUDIO sells it,
// which is not the date it becomes watchable here. The Death of Robin Hood left
// cinemas in June with a digital date of 4 August, and sat in Upcoming with a
// full page of 1080p sources behind it — "upcoming" is the wrong word for a film
// you can press play on. So rather than guessing a theatrical-to-digital window,
// ask the source list.
//
// CAMs are excluded deliberately: a camcorder rip is what a film still IN cinemas
// has, and treating that as "out" would undo the whole point of the split. It is
// what keeps Moana in Upcoming three weeks into its run — all five of its sources
// are CAMs — while Robin Hood, with 24 clean 1080p ones, moves out of it. Packs
// too: a boxset listing is not evidence about this one film.
const hasRealStreams = async (imdbId) => {
  const { streams } = await torrent.getSources("movie", imdbId);
  return (streams || []).filter((s) => !s.cam && !s.pack).length >= ENOUGH_STREAMS;
};

// Out on something we can play, by either route.
const isAvailable = (entry) => !!entry && (entry.home === true || entry.streamed === true);

const isFresh = (entry, now) => {
  if (!entry) return false;
  if (isAvailable(entry)) return true;
  // Verdicts written before the source probe existed carry no `streamed` field,
  // and "not out yet" is precisely the answer that probe overturns — so re-ask
  // rather than serving a known-incomplete verdict until its TTL runs out.
  if (entry.streamed === undefined) return false;
  return now - (entry.at || 0) < PENDING_TTL;
};

// Only titles from the last couple of years are worth asking about; everything
// older is out by definition, and a title with no year at all is unknowable.
const isAmbiguous = (item, now) => {
  if (!item || item.type === "show" || !item.imdbId) return false;
  if (!item.year) return false;
  return item.year >= new Date(now).getFullYear() - (AMBIGUOUS_YEARS - 1);
};

// Cached verdict, or null if we have never successfully looked this title up.
const cached = (imdbId, now = Date.now()) => {
  const entry = store.data.titles[imdbId];
  return isFresh(entry, now) ? entry : null;
};

// Is this title watchable at home? Sync, cache-only, and deliberately generous:
// a title we know nothing about counts as available, because hiding things on the
// strength of a failed lookup is worse than showing one film a week early.
// TMDB knows the film but lists no release of any kind, and nobody has looked for
// sources. That is an absence of evidence rather than evidence of absence, so it
// keeps the old generous treatment: counted as available, claimed by neither row.
const noEvidence = (entry) => entry.home === null && entry.streamed === null;

const isReleased = (item, now = Date.now()) => {
  if (!item) return false;
  if (!isAmbiguous(item, now)) return true;
  const entry = cached(item.imdbId, now);
  if (!entry) return true;
  return isAvailable(entry) || noEvidence(entry);
};

// The other side of the same coin, and NOT just !isReleased: "upcoming" is a
// positive claim that needs evidence. A title nobody has managed to look up is
// neither released-known nor upcoming, so it belongs in neither row rather than
// defaulting into this one.
const isUpcoming = (item, now = Date.now()) => {
  if (!isAmbiguous(item, now)) return false;
  const entry = cached(item.imdbId, now);
  if (!entry || isAvailable(entry) || noEvidence(entry)) return false;
  return true;
};

// Fill in the cache for whichever pool items are still ambiguous. Called from the
// background warm, never from a request path.
const warm = async (items, now = Date.now()) => {
  if (!config.TMDB_KEY) return;
  const seen = new Set();
  const todo = [];
  for (const item of items || []) {
    if (!isAmbiguous(item, now) || seen.has(item.imdbId)) continue;
    seen.add(item.imdbId);
    if (!isFresh(store.data.titles[item.imdbId], now)) todo.push(item.imdbId);
    if (todo.length >= MAX_LOOKUPS_PER_PASS) break;
  }
  if (!todo.length) return;

  let dirty = false;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (imdbId) => {
        try {
          const verdict = await lookup(imdbId, now);
          // Worth asking the sources about only when TMDB has not already settled
          // it. A film with a home release needs no probe, and one whose cinema
          // run has not started yet has nothing but CAMs to find — so this stays a
          // handful of probes rather than one per pool item.
          const notInCinemasYet = verdict.theatricalAt && verdict.theatricalAt > now;
          const worthProbing = verdict.home !== true && !notInCinemasYet;
          const streamed = worthProbing ? await hasRealStreams(imdbId).catch(() => false) : null;
          store.data.titles[imdbId] = { ...verdict, streamed, at: now };
          dirty = true;
        } catch {
          // Leave it uncached: isReleased() treats unknown as available, so a
          // TMDB hiccup shows the title rather than hiding it.
        }
      }),
    );
  }
  if (dirty) store.save();
};

module.exports = {
  isReleased,
  isUpcoming,
  isAmbiguous,
  warm,
  cached,
  _internals: {
    earliest,
    hasRealStreams,
    isAvailable,
    HOME_TYPES,
    THEATRICAL_TYPES,
    PENDING_TTL,
    ENOUGH_STREAMS,
  },
};

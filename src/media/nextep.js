// WHICH EPISODE COMES NEXT — one answer for every client.
//
// The website's player worked this out by itself (public/js/screens/player.js
// findNextEpisode) and the TV app by a rule of its own: "the next FILE in the
// library's list". The library only lists what is on disk, so with E1–E4 and
// E8 downloaded the TV's Up next after E4 was E8 — three episodes skipped
// without a word (audit C-2), and a streamed episode had no Up next on the TV
// at all (A-6). Two copies of a rule drift; this is the one copy, and
// GET /api/next-episode (routes/nextep.js) hands its answer to both clients.
//
// THE RULE (the website's, unchanged):
//   1. The series' REAL episode list decides what "next" is — the catalogue's
//      (Cinemeta, through discover.meta), specials (season 0) left out, in
//      airing order across seasons: after the last episode of a season comes
//      the first of the next.
//   2. No episode after this one in that list → nothing (the series ends
//      here). The next one has not aired yet → nothing.
//   3. That episode is ON DISK → it is the answer, as a library episode: it
//      plays at once and may start by itself (autoplay).
//   4. It is not on disk → it is still the answer, as a `stream` episode: the
//      client offers it ("Choose episode") and never starts it by itself.
//   When the catalogue cannot say (no IMDb id, the catalogue is unreachable,
//   it does not know this episode — a special, an odd numbering):
//   5. a library episode falls back to the next file on disk, as before — and
//      the file RIGHT AFTER this one (same season, number + 1) is trusted
//      without asking the catalogue at all (the common case, no lookup);
//   6. a streamed episode has no answer.
//
// decide() is pure; nextFor() fetches what it needs and calls it.

const flatReal = (seasons) =>
  (seasons || [])
    .filter((s) => Number(s.number) > 0) // specials are not "next"
    .flatMap((s) => s.episodes || [])
    .filter((e) => e && Number.isFinite(Number(e.season)) && Number.isFinite(Number(e.episode)));

const sameEp = (a, b) => !!a && !!b && Number(a.season) === Number(b.season) && Number(a.episode) === Number(b.episode);

const asLibrary = (e, show) => ({
  kind: "library",
  id: e.id,
  showId: (show && show.id) || e.showId || null,
  season: Number(e.season),
  episode: Number(e.episode),
  title: e.title || null,
});
const asStream = (e, imdbId) => ({
  kind: "stream",
  imdbId,
  season: Number(e.season),
  episode: Number(e.episode),
  title: e.title || null,
  released: e.released || null,
});

// cur        { season, episode, id? }   the episode that is playing
// libFlat    the show's episodes ON DISK, in order ([] / null for a streamed show)
// show       the library show ({ id }) or null
// real       the catalogue's seasons ([{ number, episodes: [{ season, episode, title, released }] }])
//            — null when it could not be asked
// imdbId     the series' id (null: nothing to ask the catalogue by)
// findOwned  (season, episode) → a library episode or null, for a show whose
//            copy is not `libFlat` (a streamed episode whose next one was
//            downloaded meanwhile)
// → { next: {kind:"library"|"stream", …} | null, why }
const decide = ({ cur, libFlat = null, show = null, real = null, imdbId = null, findOwned = null, now = Date.now() }) => {
  const lib = Array.isArray(libFlat) ? libFlat : [];
  const i = cur && cur.id ? lib.findIndex((e) => e.id === cur.id) : lib.findIndex((e) => sameEp(e, cur));
  const onDisk = i >= 0;
  const nextFile = onDisk ? lib[i + 1] || null : null;
  const here = onDisk ? lib[i] : cur;
  if (!here || !Number.isFinite(Number(here.season)) || !Number.isFinite(Number(here.episode))) {
    return { next: nextFile ? asLibrary(nextFile, show) : null, why: "no-number" };
  }
  // (5, first half) the file right after this one: trusted as it is
  if (nextFile && Number(nextFile.season) === Number(here.season) && Number(nextFile.episode) === Number(here.episode) + 1) {
    return { next: asLibrary(nextFile, show), why: "adjacent" };
  }
  const fallback = (why) => ({ next: onDisk && nextFile ? asLibrary(nextFile, show) : null, why });
  if (!imdbId) return fallback("no-id");
  if (!real) return fallback("no-catalogue");
  const all = flatReal(real);
  const j = all.findIndex((e) => sameEp(e, here));
  if (j < 0) return fallback("unknown-episode");
  const want = all[j + 1];
  if (!want) return { next: null, why: "series-end" };
  const owned = lib.find((e) => sameEp(e, want)) || (findOwned ? findOwned(Number(want.season), Number(want.episode)) : null);
  if (owned && owned.id) return { next: asLibrary({ ...owned, title: owned.title || want.title }, show), why: "owned" };
  if (want.released && new Date(want.released).getTime() > now) return { next: null, why: "not-aired" };
  return { next: asStream(want, imdbId), why: "not-owned" };
};

// The same, with the lookups done: by library episode id, or by a streamed
// episode's identity ({ imdbId, season, episode, title?, year? }).
const nextFor = async (q, deps = {}) => {
  const scanner = deps.scanner || require("./scanner");
  const identity = deps.identity || require("./identity");
  const discover = deps.discover || require("./discover");
  const now = deps.now || Date.now();
  const metaOf = async (imdbId) => {
    try {
      const meta = await discover.meta("series", imdbId);
      return (meta && meta.seasons) || null;
    } catch {
      return null; // no catalogue right now: what the library has, as before
    }
  };

  if (q.id) {
    identity.ensureStamped();
    const ep = scanner.findById(q.id);
    if (!ep || !ep.showId) return { next: null, why: "not-an-episode" };
    const show = scanner.findById(ep.showId);
    if (!show) return { next: null, why: "no-show" };
    const libFlat = (show.seasons || []).flatMap((s) => s.episodes || []);
    // the cheap answer first — no catalogue lookup when the next file is the next episode
    const quick = decide({ cur: ep, libFlat, show, real: null, imdbId: null, now });
    if (quick.why === "adjacent" || quick.why === "no-number") return quick;
    const imdbId = show.imdbId || identity.imdbIdFor(show) || null;
    const real = imdbId ? await metaOf(imdbId) : null;
    return decide({ cur: ep, libFlat, show, real, imdbId, now });
  }

  const imdbId = /^tt\d{4,12}$/.test(String(q.imdbId || "")) ? String(q.imdbId) : null;
  const season = parseInt(q.season, 10);
  const episode = parseInt(q.episode, 10);
  if (!imdbId || !Number.isFinite(season) || !Number.isFinite(episode)) return { next: null, why: "bad-request" };
  const real = await metaOf(imdbId);
  const findOwned = (s, e) =>
    identity.findLibraryPlayable({ imdbId, type: "show", title: q.title ? String(q.title).slice(0, 200) : null, year: parseInt(q.year, 10) || null, season: s, episode: e });
  return decide({ cur: { season, episode }, libFlat: null, show: null, real, imdbId, findOwned, now });
};

module.exports = { decide, nextFor, _internals: { flatReal, sameEp } };

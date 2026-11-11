// The Continue Watching row: which of a person's play history gets a card.
// Pure over the history + a few lookups (profiles.continueWatching wires the
// real ones), so every rule is pinned by test/continuerow.test.js.
//
// elia, 2026-11-11: "continue watching should have only the latest episode of
// a series show up there" and "should not show episodes or movies the user
// has finished watching". The rules:
//
//   1. One card per series, ever. The newest-watched episode decides, whether
//      it was played from the library or as a stream. A series is known by its
//      IMDb id (a library show has it from the IMDb cache, a stream carries
//      it); a stream with no id falls back to the show's name ("Silo · S2 E3"
//      → "silo"), so it is never one card per episode, and a show seen from
//      disk and as a stream is one card.
//   2. Nothing finished. Finished = marked watched, the old > 95 %, OR in the
//      end credits: at or past the credits start the server found for that
//      file (chapters / sound / picture / the skip databases — introdetect.js,
//      skipsegments.js). With no credits time known: an episode with a minute
//      or less left, a film at 92 % or with two minutes or less left (see
//      FILM_DONE below for why 92).
//   3. Up next: when the newest episode of a series is finished, the card is
//      the next episode ON DISK the person has not finished (ones already
//      watched are stepped over); none → the series leaves the row.
//   4. The ✕: an up-next card is hidden per (show, next episode) as before
//      (upNextDismissed); any other card's ✕ hides the whole series until
//      something of it is watched again (`hidden`, written by clearProgress) —
//      without it, taking the newest episode off brought an older one back.
//
// Barely-started rows (10 s or less, not finished) still count for nothing,
// as before: they neither make a card nor claim the series.

const MAX_ITEMS = 12;
const STARTED_S = 10;

// An episode's credits are a minute or two; the old 95 % already leaves 2¼
// minutes of a 45-minute episode, so only short episodes (an 11-minute
// cartoon's last minute is its credits) need the tail rule.
const EP_DONE = 0.95;
const EP_TAIL_S = 60;
// A feature film's end credits usually run 6–10 minutes — 5–8 % of its
// runtime (a 2 h film stopped in the credits sits at ~93 %, the case elia
// saw). 92 % catches a stop in typical credits; it is a little stricter than
// the 90 % Plex and Jellyfin use, so a film stopped in its last scene stays.
// The two-minute tail is for shorts (a 15-minute film's credits are
// about a minute and a half — 90 % of it).
const FILM_DONE = 0.92;
const FILM_TAIL_S = 120;
// The tail rules count only from 80 % on.
const TAIL_FLOOR = 0.8;

// A credits time is believed when it sits in the last part of the programme:
// after 60 % of it, with no more than 20 minutes after it.
const plausibleCredits = (start, duration) =>
  Number.isFinite(start) && duration > 0 && start >= duration * 0.6 && start < duration && duration - start <= 20 * 60;

// `creditsAt`: where this file's end credits start (seconds), or null.
const isDone = (prog, { episode = false, creditsAt = null } = {}) => {
  if (!prog) return false;
  if (prog.finished) return true;
  const pos = Number(prog.position) || 0;
  const dur = Number(prog.duration) || 0;
  if (!(dur > 0) || !(pos > 0)) return false;
  if (plausibleCredits(creditsAt, dur) && pos >= creditsAt) return true;
  const share = pos / dur;
  // (the tail rule only near the end: a two-minute short half-watched has
  // under two minutes left and is anything but finished)
  const tail = share >= TAIL_FLOOR ? dur - pos : Infinity;
  if (episode) return share > EP_DONE || tail <= EP_TAIL_S;
  return share >= FILM_DONE || tail <= FILM_TAIL_S;
};

// The same normalising identity.js matches titles with (ASCII words only).
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// A stream episode's play-item is titled "Silo · S2 E3" (website, TV) — the
// show's name is what is left without the episode code.
const seriesTitleOf = (meta) => {
  if (!meta) return "";
  if (meta.showTitle) return String(meta.showTitle);
  return String(meta.title || "").replace(/\s*[·•|:\-–—]?\s*S\d+\s*[·.\- ]?\s*E\d+\b.*$/i, "").trim();
};

const isStreamEpisode = (meta) =>
  !!meta && meta.season != null && meta.season !== "" && meta.episode != null && meta.episode !== "";

// Series seen so far. An IMDb id matches the same id; a name matches only
// when one side has no id (two shows that share a name, both with ids — "The
// Office" US and UK — stay two series).
const seriesSet = () => {
  const ids = new Set();
  const namesNoId = new Set();
  const namesAny = new Set();
  return {
    has: ({ imdb, title }) =>
      (!!imdb && ids.has(imdb)) || (!!title && (namesNoId.has(title) || (!imdb && namesAny.has(title)))),
    add: ({ imdb, title }) => {
      if (imdb) ids.add(imdb);
      if (title) {
        namesAny.add(title);
        if (!imdb) namesNoId.add(title);
      }
    },
  };
};

// The key a ✕ files a series under, and the stamp it reads back.
const hiddenKey = ({ imdb, title }) => (imdb ? imdb : title ? `t:${title}` : null);
const hiddenAt = (hidden, { imdb, title }) =>
  Math.max((imdb && hidden && hidden[imdb]) || 0, (title && hidden && hidden[`t:${title}`]) || 0);

// The first episode on disk after (season, episode) — or after `fromId` when
// that is one of the show's own files — that is not finished.
const nextUnfinished = (show, from, deps) => {
  if (!show || !show.seasons) return null;
  const flat = show.seasons.flatMap((s) => s.episodes || []);
  let i = from.id ? flat.findIndex((e) => e.id === from.id) : -1;
  if (i === -1) {
    const S = Number(from.season);
    const E = Number(from.episode);
    if (!Number.isFinite(S) || !Number.isFinite(E)) return null;
    // (specials, season 0, never come "next" after a numbered season)
    const after = flat.findIndex((e) => {
      const s = Number(e.season);
      const ep = Number(e.episode);
      return (s > S && !(s === 0 && S > 0)) || (s === S && ep > E);
    });
    if (after === -1) return null;
    i = after - 1;
  }
  for (let j = i + 1; j < flat.length; j++) {
    const ep = flat[j];
    const prog = deps.progressOf(ep.id);
    if (prog && (prog.finished || isDone(prog, { episode: true, creditsAt: deps.creditsLibrary(ep.id, show.id, prog) }))) continue;
    return { ...ep, showId: show.id, showTitle: show.title, cover: show.cover };
  }
  return null;
};

// One history row as Continue Watching sees it: the card it would show, and
// for an episode its series, the library show (for up next) and where up next
// counts from. Null when it makes no card at all. `keepOwned`: a streamed row
// whose title has since been downloaded resolves too (the ✕ asks, below).
const resolve = (itemId, prog, deps, { keepOwned = false } = {}) => {
  if (String(itemId).startsWith("torrent|")) {
    // Torrent streams: resolve from the stored play-item (not in the scanner).
    const meta = deps.streamMeta(itemId);
    if (!meta) return null;
    // Downloaded since: the library copy carries this history now (the
    // progress view) and its own entry renders the card — one that plays the
    // file, not the torrent.
    if (!keepOwned && deps.ownedPlayable(meta)) return null;
    const out = { card: { ...meta, progress: prog }, ser: null, show: null, from: null, creditsAt: () => null };
    if (isStreamEpisode(meta)) {
      const title = norm(seriesTitleOf(meta));
      out.ser = meta.imdbId || title ? { imdb: meta.imdbId || null, title: title || null } : { imdb: null, title: `id:${itemId}` };
      out.show = deps.libraryShowFor({ imdbId: meta.imdbId || null, title: seriesTitleOf(meta), year: meta.year || null });
      out.from = { season: meta.season, episode: meta.episode };
    }
    out.creditsAt = () => (prog ? deps.creditsStream(meta, prog) : null);
    return out;
  }
  const item = deps.libraryItem(itemId);
  if (!item || item.type === "show") return null;
  const out = { card: { ...item, progress: prog }, ser: null, show: null, from: null, creditsAt: () => null };
  if (item.showId) {
    const show = deps.show(item.showId);
    out.show = show || null;
    out.ser = {
      imdb: (show && deps.showImdb(show)) || null,
      title: norm(show ? show.title : item.showTitle) || `lib:${item.showId}`,
    };
    out.from = { id: itemId, season: item.season, episode: item.episode };
    out.creditsAt = () => (prog ? deps.creditsLibrary(itemId, item.showId, prog) : null);
  }
  return out;
};

// The series a row belongs to ({ imdb, title }), or null for a film.
const seriesFor = (itemId, deps) => {
  const e = resolve(itemId, null, deps, { keepOwned: true });
  return e ? e.ser : null;
};

// entries: [[itemId, progressRow]] — the progress VIEW (library ids filled in
// from their title rows), any order.
const pick = (entries, deps, { max = MAX_ITEMS } = {}) => {
  const sorted = entries.slice().sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  const items = [];
  const series = seriesSet();
  const films = new Set();
  const upNextDismissed = deps.upNextDismissed || {};
  const hidden = deps.hidden || {};

  for (const [itemId, prog] of sorted) {
    if (items.length >= max) break;
    if (!prog) continue;

    // (barely started: neither a card nor a claim on the series)
    if (!prog.finished && !((prog.position || 0) > STARTED_S)) continue;
    const e = resolve(itemId, prog, deps);
    if (!e) continue;
    const { card, ser, show, from } = e;
    // (the credits time is asked for only once the row matters)
    const done = () => !!prog.finished || isDone(prog, { episode: !!ser, creditsAt: e.creditsAt() });

    if (!ser) {
      // A film: one card per title, and none once it is finished.
      const fkey = card.imdbId || itemId;
      if (films.has(fkey)) continue;
      films.add(fkey);
      if (!done()) items.push(card);
      continue;
    }

    // An episode: the newest one decides for its whole series.
    if (series.has(ser)) continue;
    series.add(ser);
    // Taken off the row with ✕ after this was watched: the series stays off
    // until something of it is watched again.
    if (hiddenAt(hidden, ser) >= (prog.updatedAt || 0)) continue;
    if (!done()) {
      items.push(card);
      continue;
    }
    const next = show ? nextUnfinished(show, from, deps) : null;
    if (!next) continue;
    // Dismissed via the card's ✕. Keyed to the SPECIFIC next episode, so the
    // dismissal expires by itself: watch further and the candidate changes,
    // and the card comes back for the new episode.
    if (upNextDismissed[show.id] === next.id) continue;
    items.push({ ...next, progress: null, upNext: true });
  }
  return items;
};

module.exports = {
  pick,
  isDone,
  seriesTitleOf,
  hiddenKey,
  seriesFor,
  norm,
  _internals: { nextUnfinished, plausibleCredits, seriesSet, hiddenAt, EP_DONE, EP_TAIL_S, FILM_DONE, FILM_TAIL_S, TAIL_FLOOR, MAX_ITEMS },
};

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
  const name = meta.showTitle
    ? String(meta.showTitle)
    : String(meta.title || "").replace(/\s*[·•|:\-–—]?\s*S\d+\s*[·.\- ]?\s*E\d+\b.*$/i, "");
  // ("Silo (2023)": the year is not part of the name — a library show's
  // title never carries it, and the two must be one series)
  return name.replace(/\s*\((19|20)\d{2}\)\s*$/, "").trim();
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

// One card's identity on every screen (cw-fix, 2026-11-19): the SERIES for an
// episode (so E3 turning into E4 is the same card, updated — never a second
// one beside it), the title for a film. Home's merge (public/js/homeMerge.js,
// the TV's port) and the TV's shelf pin key Continue Watching by it.
const seriesKeyOf = (ser, card, itemId) =>
  ser ? (ser.imdb ? `s:${ser.imdb}` : `s:t:${ser.title}`) : `f:${(card && card.imdbId) || itemId}`;

// The first episode on disk after (season, episode) — or after `fromId` when
// that is one of the show's own files — that is not finished.
const nextUnfinished = (show, from, deps, { inclusive = false } = {}) => {
  if (!show || !show.seasons) return null;
  const flat = show.seasons.flatMap((s) => s.episodes || []);
  const S = Number(from.season);
  const E = Number(from.episode);
  const numbered = from.season != null && from.episode != null && Number.isFinite(S) && Number.isFinite(E);
  let i = from.id && !inclusive ? flat.findIndex((e) => e.id === from.id) : -1;
  if (i === -1) {
    if (!numbered) return null;
    // (specials, season 0, never come "next" after a numbered season)
    const after = flat.findIndex((e) => {
      const s = Number(e.season);
      const ep = Number(e.episode);
      return (s > S && !(s === 0 && S > 0)) || (s === S && (inclusive ? ep >= E : ep > E));
    });
    if (after === -1) return null;
    i = after - 1;
  }
  // An episode is finished when ANY copy of it on disk is: two files of one
  // episode (a 1080p and a 4K, a re-download beside the old file) are two
  // ids, and a show the IMDb cache never resolved has no shared history row
  // to join them.
  const keyOf = (ep) => `${Number(ep.season)}:${Number(ep.episode)}`;
  const doneSE = new Set();
  for (const ep of flat) {
    const prog = deps.progressOf(ep.id);
    if (prog && (prog.finished || isDone(prog, { episode: true, creditsAt: deps.creditsLibrary(ep.id, show.id, prog) }))) doneSE.add(keyOf(ep));
  }
  for (let j = i + 1; j < flat.length; j++) {
    const ep = flat[j];
    // never the same episode again, nor one before it (a second copy of an
    // episode sorts right after the first)
    if (numbered && !inclusive && Number(ep.season) === S && Number(ep.episode) <= E) continue;
    if (doneSE.has(keyOf(ep))) continue;
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
      // The library's show is THE series: its id and name decide, so a stream
      // titled a little differently ("Silo (2023)", a name with no IMDb id)
      // is never a second card beside the episodes on disk — unless the two
      // carry IMDb ids that disagree (two shows that share a name).
      const libImdb = out.show ? deps.showImdb(out.show) || null : null;
      if (out.show && (!meta.imdbId || !libImdb || libImdb === meta.imdbId)) {
        out.ser = { imdb: libImdb || meta.imdbId || null, title: norm(out.show.title) || out.ser.title };
      }
    }
    out.creditsAt = () => (prog ? deps.creditsStream(meta, prog) : null);
    // A server that plays no streams ("torrents": false): the card could not
    // be played. A film's goes; an episode's series keeps its place with the
    // next one on disk, as for an episode whose file is gone.
    if (deps.streamsOff && deps.streamsOff()) {
      if (!out.ser || !out.show) return null;
      return { ...out, card: null, gone: true };
    }
    return out;
  }
  const item = deps.libraryItem(itemId);
  if (!item) {
    // An episode whose file has left the disk (smart cleanup, a tidy-up, a
    // re-download under another name): its history still says which episode
    // it was (the shared title row: "tt…:S:E"), so the series keeps its place
    // and its up next — it used to drop out of the row altogether.
    const gone = deps.goneEpisode ? deps.goneEpisode(itemId) : null;
    if (!gone) return null;
    const show = deps.libraryShowFor({ imdbId: gone.imdbId, title: null, year: null });
    if (!show) return null;
    return {
      card: null,
      gone: true,
      ser: { imdb: deps.showImdb(show) || gone.imdbId, title: norm(show.title) || `lib:${show.id}` },
      show,
      from: { season: gone.season, episode: gone.episode },
      creditsAt: () => null,
    };
  }
  if (item.type === "show") return null;
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
  // Newest first; on a tie a row that still has its file goes before one
  // whose file is gone (a re-download's new id carries the same stamp).
  const isGone = (id) => !String(id).startsWith("torrent|") && !deps.libraryItem(id);
  const sorted = entries
    .slice()
    .sort((a, b) => (b[1] ? b[1].updatedAt || 0 : 0) - (a[1] ? a[1].updatedAt || 0 : 0) || isGone(a[0]) - isGone(b[0]));
  const items = [];
  const series = seriesSet();
  const films = new Set();
  const upNextDismissed = deps.upNextDismissed || {};
  const hidden = deps.hidden || {};
  const add = (card, e, itemId) => items.push({ ...card, seriesKey: seriesKeyOf(e.ser, card, itemId) });

  for (const [itemId, prog] of sorted) {
    if (items.length >= max) break;
    if (!prog) continue;

    // (barely started: neither a card nor a claim on the series)
    if (!prog.finished && !((prog.position || 0) > STARTED_S)) continue;
    // (marked watched and never played here — a mark keeps the stamp it
    // found, 0 when there was none: "seen elsewhere" is not being watched)
    if (!(prog.updatedAt > 0)) continue;
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
      if (!done()) add(card, e, itemId);
      continue;
    }

    // An episode: the newest one decides for its whole series.
    if (series.has(ser)) continue;
    series.add(ser);
    // Taken off the row with ✕ after this was watched: the series stays off
    // until something of it is watched again.
    const hid = hiddenAt(hidden, ser);
    if (hid && hid >= prog.updatedAt) continue;
    const finished = done();
    if (!finished && card) {
      add(card, e, itemId);
      continue;
    }
    // Finished — or not, but its file has left the disk: the next episode
    // on disk not yet finished (for the vanished half-watched one, a copy of
    // that same episode on disk first).
    const next = show ? nextUnfinished(show, from, deps, { inclusive: !finished }) : null;
    if (!next) continue;
    // Dismissed via the card's ✕. Keyed to the SPECIFIC next episode, so the
    // dismissal expires by itself: watch further and the candidate changes,
    // and the card comes back for the new episode.
    if (upNextDismissed[show.id] === next.id) continue;
    // (a copy of the very episode that was being watched resumes, it is not "up next")
    const same = !finished && Number(next.season) === Number(from.season) && Number(next.episode) === Number(from.episode);
    const nextProg = same ? deps.progressOf(next.id) : null;
    add(same && nextProg ? { ...next, progress: nextProg } : { ...next, progress: null, upNext: true }, e, next.id);
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
  seriesKeyOf,
  _internals: { nextUnfinished, plausibleCredits, seriesSet, hiddenAt, EP_DONE, EP_TAIL_S, FILM_DONE, FILM_TAIL_S, TAIL_FLOOR, MAX_ITEMS },
};

// How Aurora studies a person.
//
// The old taste model saw three things — finished, >70% watched, abandoned —
// and turned them into a tally of genres. This one reads everything a profile
// leaves behind, per TITLE, and keeps the titles themselves as evidence:
//
//   signal                               weight   dated?
//   ------------------------------------ -------  ------
//   rated 5★ / 4★ / 3★ / 2★ / 1★          +3 / +2 / +0.3 / −2 / −3   no
//   picked in "titles you love"           +2.5    no
//   finished a film                       +1.6    yes
//     …and came back to it (a rewatch)    +0.8    yes
//   watched most of a film (≥70%)         +1.0    yes
//   mid-way and still at it               +0.3    yes
//   mid-way and left for 3+ weeks         −0.3    yes
//   gave up early (<20%, 5+ min in,
//     not touched for 3+ days)            −0.8    yes
//   a series: 6+ episodes or ≥80% of it   +2.0    yes
//             3–5 episodes                +1.4    yes
//             1–2 episodes, still fresh   +0.6    yes
//             1–2 episodes, then nothing
//               for a month               −0.4    yes   ("dropped after the pilot")
//             a first episode given up    −0.6    yes
//     3+ episodes inside 24 hours (binge) +0.5    yes
//   follows the show                      +1.5    yes
//   on My List                            +1.0    no    (intent, not proof)
//   marked watched by hand                +0.6    no    (a statement about the past)
//   removed from Continue Watching        −1.0    yes   (unless watched again since)
//   hid a show's "up next" card           −0.3    no
//   a genre picked in Settings            +1.5 on that genre only (a prior)
//
// Several signals on one title add up (clamped to −3…+4). Time works on two
// scales at once: every dated signal fades with a 180-day half-life (the
// LONG-term taste) and also carries a 14-day half-life share (what they are
// into right now) — weight × (0.65·long + 0.35·short). Yesterday counts 1.0,
// two months ago 0.52, a year ago 0.16. Undated signals count 0.7.
//
// The result is a model with two views of the same person:
//   taste     one signed vector per feature block — "more heist, less slasher"
//   anchors   the liked (and disliked) titles themselves. Ranking asks "how
//             close is this to SOMETHING they liked" as well as "how close to
//             their average", which is what keeps a profile two people share
//             (cartoons and horror) from averaging into neither.
//
// Pure: collectEvents() takes the stored profile state as data; nothing here
// reads a store or the clock unless told to. Never trains anything.
const features = require("./features");

const W = {
  rate5: 3, rate4: 2, rate3: 0.3, rate2: -2, rate1: -3,
  loved: 2.5,
  finished: 1.6, rewatch: 0.8, mostly: 1.0, watching: 0.3, stalled: -0.3, abandoned: -0.8,
  showDevoted: 2.0, showRegular: 1.4, showStarted: 0.6, showDropped: -0.4, showAbandoned: -0.6, binge: 0.5,
  follow: 1.5, listed: 1.0, marked: 0.6, dismissed: -1.0, upNextHidden: -0.3,
  likedGenre: 1.5,
};
const CLAMP = [-3, 4];
const HALF_LONG = 180;
const HALF_SHORT = 14;
const SHORT_SHARE = 0.35;
const UNDATED = 0.7;
const DAY = 86400000;

// The two-timescale kernel. `at` null/0 = undated.
const recency = (at, now) => {
  if (!at) return { long: UNDATED, short: 0, w: UNDATED * (1 - SHORT_SHARE) + UNDATED * SHORT_SHARE };
  const days = Math.max(0, (now - at) / DAY);
  const long = Math.pow(0.5, days / HALF_LONG);
  const short = Math.pow(0.5, days / HALF_SHORT);
  return { long, short, w: (1 - SHORT_SHARE) * long + SHORT_SHARE * short };
};

const frac = (row) => (row && row.duration > 0 ? row.position / row.duration : 0);
const isMarkOnly = (row) => !!row.marked && (!row.prior || !row.prior.finished);

// One film row -> [{w, kind, at}]
const filmEvents = (row, now) => {
  const out = [];
  if (!row) return out;
  if (isMarkOnly(row)) {
    out.push({ w: W.marked, kind: "marked", at: null });
    return out;
  }
  const at = row.updatedAt || null;
  const f = frac(row);
  const idle = at ? (now - at) / DAY : Infinity;
  if (row.finished) {
    out.push({ w: W.finished, kind: "finished", at });
    if (row.plays > 0) out.push({ w: W.rewatch, kind: "rewatch", at });
  } else if (row.plays > 0) {
    // watching it AGAIN: it was finished once already
    out.push({ w: W.finished + W.rewatch, kind: "rewatch", at });
  } else if (f >= 0.7) out.push({ w: W.mostly, kind: "mostly", at });
  else if (f >= 0.2) out.push(idle > 21 ? { w: W.stalled, kind: "stalled", at } : { w: W.watching, kind: "watching", at });
  else if (row.duration > 600 && row.position >= 300 && idle > 3) out.push({ w: W.abandoned, kind: "abandoned", at });
  return out;
};

// A series' episode rows -> [{w, kind, at, n}]. `total` = how many episodes
// the series has, when known.
const showEvents = (rows, total, now) => {
  const out = [];
  const watched = rows.filter((r) => r.finished && !isMarkOnly(r));
  const marked = rows.filter((r) => isMarkOnly(r));
  const started = rows.filter((r) => !r.finished && !r.marked);
  const stamps = [...watched, ...started].map((r) => r.updatedAt || 0).filter(Boolean);
  const at = stamps.length ? Math.max(...stamps) : null;
  const idle = at ? (now - at) / DAY : Infinity;
  const n = watched.length;
  if (n >= 6 || (total && n >= 3 && n / total >= 0.8)) out.push({ w: W.showDevoted, kind: "devoted", at, n });
  else if (n >= 3) out.push({ w: W.showRegular, kind: "regular", at, n });
  else if (n >= 1) {
    const more = !total || total > n + 1;
    out.push(idle > 30 && more ? { w: W.showDropped, kind: "dropped", at, n } : { w: W.showStarted, kind: "started", at, n });
  } else if (started.length) {
    const first = started.reduce((a, b) => ((a.updatedAt || 0) > (b.updatedAt || 0) ? a : b));
    const f = frac(first);
    if (f < 0.2 && first.duration > 600 && first.position >= 300 && idle > 7) out.push({ w: W.showAbandoned, kind: "abandoned", at });
    else if (f >= 0.2) out.push({ w: W.watching, kind: "watching", at });
  }
  // a binge: three or more episodes finished within one day
  const times = watched.map((r) => r.updatedAt || 0).filter(Boolean).sort((a, b) => a - b);
  for (let i = 0; i + 2 < times.length; i++) {
    if (times[i + 2] - times[i] <= DAY) {
      out.push({ w: W.binge, kind: "binge", at });
      break;
    }
  }
  if (!out.length && marked.length) out.push({ w: W.marked, kind: "marked", at: null });
  else if (marked.length >= 3 && !watched.length) out.push({ w: W.marked, kind: "marked", at: null });
  return out;
};

// Everything one profile has done, as per-title evidence.
//   state    the stored profile state (profiles.json → state[id]): titles,
//            ratings, watchlist, likedTitles, likedGenres, dismissed,
//            upNextDismissed
//   opts     { follows: [{imdbId, at, title}], now,
//              episodesOf(imdbId) -> total episodes | null,
//              imdbOf(key) -> imdbId | null   (a library id -> its IMDb id) }
// Returns { titles: Map(imdbId -> {w, at, kinds:Set, n, events}), likedGenres, seen:Set }
const collectEvents = (state, opts = {}) => {
  const now = opts.now || Date.now();
  const imdbOf = opts.imdbOf || (() => null);
  const tt = (v) => (typeof v === "string" && /^tt\d{4,12}$/.test(v) ? v : null);
  const resolve = (key) => tt(key) || tt(imdbOf(key));
  const titles = new Map();
  const add = (id, ev) => {
    if (!id || !ev) return;
    let t = titles.get(id);
    if (!t) titles.set(id, (t = { id, events: [] }));
    t.events.push(ev);
  };

  // watch history, one row per title (films) / per episode (series)
  const shows = new Map();
  const touched = new Set(); // anything with a history row, verdict or not
  for (const [key, row] of Object.entries((state && state.titles) || {})) {
    if (!row) continue;
    const parts = key.split(":");
    const id = tt(parts[0]);
    if (!id) continue;
    touched.add(id);
    if (parts.length > 1) {
      if (!shows.has(id)) shows.set(id, []);
      shows.get(id).push(row);
    } else for (const ev of filmEvents(row, now)) add(id, ev);
  }
  for (const [id, rows] of shows) {
    const total = opts.episodesOf ? opts.episodesOf(id) : null;
    for (const ev of showEvents(rows, total, now)) add(id, ev);
  }

  for (const [key, stars] of Object.entries((state && state.ratings) || {})) {
    const id = resolve(key);
    const w = stars >= 5 ? W.rate5 : stars === 4 ? W.rate4 : stars === 3 ? W.rate3 : stars === 2 ? W.rate2 : stars === 1 ? W.rate1 : 0;
    if (id && w) add(id, { w, kind: `rated${stars}`, at: null, stars });
  }
  for (const t of (state && state.likedTitles) || []) {
    const id = resolve(t.imdbId || t.id);
    if (id) add(id, { w: W.loved, kind: "loved", at: null });
  }
  for (const e of (state && state.watchlist) || []) {
    const id = resolve(typeof e === "string" ? e : e && e.imdbId);
    if (id) add(id, { w: W.listed, kind: "listed", at: (e && e.addedAt) || null });
  }
  for (const f of opts.follows || []) {
    const id = tt(f.imdbId);
    if (id) add(id, { w: W.follow, kind: "follow", at: f.at || null });
  }
  for (const [key, at] of Object.entries((state && state.dismissed) || {})) {
    const id = tt(String(key).split(":")[0]);
    if (!id) continue;
    // watched again since it was removed: the removal no longer speaks
    const later = (titles.get(id) || { events: [] }).events.some((ev) => ev.at && ev.at > at && ev.w > 0);
    if (!later) add(id, { w: W.dismissed, kind: "dismissed", at });
  }
  for (const showKey of Object.keys((state && state.upNextDismissed) || {})) {
    const id = resolve(showKey);
    if (id) add(id, { w: W.upNextHidden, kind: "upnext-hidden", at: null });
  }

  // fold each title's events into one weight and one "when"
  // "seen" = never recommend again: anything started, watched, rated, marked
  // or removed (a film ten minutes in has no verdict yet, but it lives in
  // Continue Watching, not in a recommendation). My List and follows stay out
  // of recommendations too — the person already has them.
  const seen = new Set(touched);
  for (const t of titles.values()) {
    let w = 0;
    let at = 0;
    let n = 0;
    t.kinds = new Set();
    for (const ev of t.events) {
      w += ev.w;
      if (ev.at && ev.at > at) at = ev.at;
      if (ev.n) n = Math.max(n, ev.n);
      t.kinds.add(ev.kind);
    }
    t.w = Math.max(CLAMP[0], Math.min(CLAMP[1], w));
    t.at = at || null;
    t.n = n;
    seen.add(t.id);
  }
  return { titles, likedGenres: ((state && state.likedGenres) || []).slice(0, 40), seen };
};

// "Because you finished Arrival" — the phrase a title earns as evidence.
const phraseFor = (t, title) => {
  const k = t.kinds;
  if (k.has("rated5")) return `you rated ${title} 5★`;
  if (k.has("loved")) return `you love ${title}`;
  if (k.has("rated4")) return `you rated ${title} 4★`;
  if (k.has("rewatch")) return `you rewatched ${title}`;
  if (k.has("finished")) return `you finished ${title}`;
  if (k.has("binge")) return `you binged ${title}`;
  if (k.has("devoted") || k.has("regular")) return `you watched ${title}`;
  if (k.has("follow")) return `you follow ${title}`;
  if (k.has("mostly")) return `you watched most of ${title}`;
  if (k.has("started") || k.has("watching")) return `you're watching ${title}`;
  if (k.has("listed")) return `${title} is on your list`;
  if (k.has("marked")) return `you've seen ${title}`;
  return `you liked ${title}`;
};

// The model. `vectorFor(imdbId)` -> the title's feature blocks (features.js)
// or null when the index does not know it; `titleFor(imdbId)` -> its name.
const BLOCKS = features.BLOCKS;
const buildModel = (events, { vectorFor, titleFor = () => null, now = Date.now(), maxAnchors = 40 } = {}) => {
  const taste = {};
  for (const b of BLOCKS) taste[b] = new Map();
  const pos = [];
  const neg = [];
  const genreMass = {};
  let mass = 0;
  let known = 0;
  let recent = 0;

  for (const t of events.titles.values()) {
    if (!t.w) continue;
    const v = vectorFor(t.id);
    if (!v) continue;
    known++;
    const r = recency(t.at, now);
    const eff = t.w * r.w;
    if (Math.abs(eff) < 0.02) continue;
    mass += Math.abs(eff);
    if (eff > 0 && r.short > 0.25) recent += eff;
    for (const b of BLOCKS) {
      const blk = v[b];
      if (!blk) continue;
      const m = taste[b];
      for (let i = 0; i < blk.k.length; i++) m.set(blk.k[i], (m.get(blk.k[i]) || 0) + eff * blk.w[i]);
    }
    const title = titleFor(t.id) || "it";
    const a = { id: t.id, v, eff, w: t.w, at: t.at, short: r.short, kinds: t.kinds, title, why: phraseFor(t, title) };
    if (eff > 0) {
      pos.push(a);
      // the calibration target: this title's weight, spread over its genres
      const gs = v.genres || [];
      for (const g of gs) genreMass[g] = (genreMass[g] || 0) + eff / gs.length;
    } else neg.push(a);
  }

  // the Settings picks: a prior on the genre block only, and on calibration
  const gPrior = events.likedGenres || [];
  for (const g of gPrior) {
    const id = features.intern(`genre|${g}`);
    taste.genre.set(id, (taste.genre.get(id) || 0) + W.likedGenre * 0.5);
    genreMass[g] = (genreMass[g] || 0) + W.likedGenre * 0.5;
  }

  // unit length per block, on the POSITIVE mass (dislikes keep their sign and
  // size relative to it; a profile of only dislikes has no direction to rank by)
  for (const b of BLOCKS) {
    let sq = 0;
    for (const v of taste[b].values()) if (v > 0) sq += v * v;
    if (!sq) { taste[b] = null; continue; }
    const n = Math.sqrt(sq);
    for (const [k, v] of taste[b]) taste[b].set(k, v / n);
  }

  pos.sort((a, b) => b.eff - a.eff);
  neg.sort((a, b) => a.eff - b.eff);
  const gTotal = Object.values(genreMass).reduce((n, x) => n + x, 0);
  const genreShare = {};
  if (gTotal > 0) for (const [g, x] of Object.entries(genreMass)) genreShare[g] = x / gTotal;

  return {
    taste,
    pos: pos.slice(0, maxAnchors),
    neg: neg.slice(0, 15),
    genreShare,
    likedGenres: gPrior,
    mass, // total |evidence| — the cold-start gauge
    known, // titles the index could describe
    recentShare: mass ? recent / mass : 0,
    seen: events.seen,
    now,
  };
};

module.exports = {
  collectEvents, buildModel, recency, phraseFor, W,
  _internals: { filmEvents, showEvents, HALF_LONG, HALF_SHORT, SHORT_SHARE, UNDATED, CLAMP },
};

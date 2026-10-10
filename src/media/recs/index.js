// The recommender, as the rest of the server sees it.
//
//   homeRows()            the personalised rows of /api/home, for web and TV
//   personaliseSimilar()  "More like this", re-ordered for whoever is asking
//   localSimilar()        "More like this" from the index alone (TMDB down, no key)
//   sync()                the daily round: learn the titles people touched,
//                         widen the pool along what they like
//   prepare()             build the in-memory vectors (background, chunked)
//
// The request path is cache-only and synchronous, like everything else
// /api/home reads: it uses whatever index and vectors are already in memory.
// Until the first prepare() has finished (a second or two after boot) it
// answers null and the caller falls back to the old taste model.
//
// Layers, each pure and tested on its own:
//   titleindex.js  what is known about a title (disk, TMDB)
//   taxonomy.js    keywords -> themes; canonical genres
//   features.js    a title as vectors; similarity
//   person.js      a profile's history as evidence; the taste model
//   rank.js        scoring, diversity + calibration re-rank, the rows
const titleindex = require("./titleindex");
const features = require("./features");
const person = require("./person");
const rank = require("./rank");
const tax = require("./taxonomy");
const tmdb = require("./tmdb");

// THE ALGO BUMP RULE. Bump this whenever ranking changes — weights, signals,
// features, the taxonomy's meaning, row rules. It is part of every cache key
// here (models, rows), so no list built by an older algorithm is ever served
// by a newer one. (More-like-this rows on disk have their own ALGO in
// similar.js, same rule: bump it when vibe.js or the blend changes.)
//   1  2026-10-10  first version of the feature/person/rank engine
const ALGO = 1;

const DAY = 86400000;
const dayOf = (now) => Math.floor(now / DAY);

// ---------- lazy deps (this module must load in tests without the server) ----------
const dep = {
  scanner: () => require("../scanner"),
  identity: () => require("../identity"),
  discover: () => require("../discover"),
  hero: () => require("../hero"),
  availability: () => require("../availability"),
  profiles: () => require("../../profiles"),
};

// ---------- vectors ----------
// One entry per index record: { id, rec, v }. Rebuilt in the background when
// the index has changed; the request path only ever reads `state.entries`.
const state = {
  entries: new Map(), // imdbId -> { id, rec, v }
  list: [],
  stats: null,
  statsN: 0,
  stamp: -1, // titleindex.stamp() the entries were built at
  gen: 0, // bumped per rebuild — cache keys
  building: null,
  builtAt: 0,
};
const ready = () => state.gen > 0;

const yieldLoop = () => new Promise((r) => setImmediate(r));

const prepare = async ({ force = false } = {}) => {
  if (state.building) return state.building;
  const stamp = titleindex.stamp();
  if (!force && stamp === state.stamp && state.gen > 0) return state;
  state.building = (async () => {
    try {
      const all = titleindex.all();
      // document frequencies drift slowly: recount when the index grew 5%
      if (!state.stats || force || Math.abs(all.length - state.statsN) > state.statsN * 0.05) {
        state.stats = features.buildStats(all);
        state.statsN = all.length;
        state.statsGen = (state.statsGen || 0) + 1;
        await yieldLoop();
      }
      const next = new Map();
      let n = 0;
      for (const rec of all) {
        const cur = state.entries.get(rec.id);
        if (cur && cur.rec === rec && cur.statsGen === state.statsGen) next.set(rec.id, cur);
        else {
          next.set(rec.id, { id: rec.id, rec, v: features.vectorOf(rec, state.stats), statsGen: state.statsGen });
          if (++n % 150 === 0) await yieldLoop(); // never hold the event loop for long
        }
      }
      state.entries = next;
      state.list = [...next.values()];
      state.stamp = stamp;
      state.gen++;
      state.builtAt = Date.now();
      caches.clear();
    } finally {
      state.building = null;
    }
    return state;
  })();
  return state.building;
};
// fire-and-forget from the request path
const prepareSoon = () => {
  if (state.building || titleindex.stamp() === state.stamp) return;
  prepare().catch(() => {});
};

// ---------- cards ----------
// A candidate as a client card. A title the library holds is the LIBRARY
// card (its own cover, plays from disk); everything else is a stream card
// that opens the Discover page by IMDb id, exactly like a catalogue card.
let libMap = { at: null, byImdb: new Map() };
const libraryByImdb = () => {
  const scanner = dep.scanner();
  if (libMap.at === scanner.index.scannedAt && libMap.byImdb.size) return libMap.byImdb;
  const byImdb = new Map();
  try {
    const identity = dep.identity();
    for (const item of scanner.allItems()) {
      const id = item.imdbId || identity.imdbIdFor(item);
      if (id && !byImdb.has(id)) byImdb.set(id, item);
    }
  } catch {}
  libMap = { at: scanner.index.scannedAt, byImdb };
  return byImdb;
};

const cardOf = (rec, lib = null) => {
  const local = (lib || libraryByImdb()).get(rec.id);
  if (local) return local;
  return {
    type: rec.k === "tv" ? "show" : "movie",
    title: rec.title,
    year: rec.year,
    poster: rec.poster,
    cover: rec.poster,
    backdrop: rec.backdrop || `https://images.metahub.space/background/medium/${rec.id}/img`,
    synopsis: (rec.ov || "").slice(0, 400),
    rating: rec.va ? Math.round(rec.va * 10) / 10 : null,
    genres: rec.g || [],
    imdbId: rec.id,
    ...(rec.tm ? { tmdbId: rec.tm } : {}),
    ...(rec.cert ? { certificate: rec.cert } : {}),
    source: "stream",
  };
};

// May this record be recommended at all? Things nobody can play, things with
// no cover, and formats nobody browses a film server for are out.
const NEVER = new Set(["Talk-Show", "News", "Game-Show"]);
const RELEASED = new Set(["Released", "Ended", "Returning Series", "Canceled"]);
const recommendable = (rec, now, lib) => {
  if (!rec.poster && !lib.has(rec.id)) return false;
  if (rec.adult) return false;
  if ((rec.g || []).length && rec.g.every((g) => NEVER.has(g))) return false;
  if (lib.has(rec.id)) return true;
  if (!rec.lite) {
    if (rec.st && !RELEASED.has(rec.st)) return false;
    const at = rec.rel ? Date.parse(rec.rel) : NaN;
    // a film needs a few weeks after its cinema date before it can be
    // watched at home; a series needs to have started
    if (Number.isFinite(at) && at > now - (rec.k === "movie" ? 45 : 0) * DAY) return false;
    if ((rec.vc || 0) < 25) return false; // too obscure to vouch for
  }
  // only a recent film can be "in cinemas but not at home yet" — the one
  // question availability.js answers (from its cache; unknown counts as out)
  if (rec.k === "movie" && rec.year && rec.year >= new Date(now).getUTCFullYear() - 1) {
    try {
      if (!dep.availability().isReleased({ imdbId: rec.id, type: "movie", year: rec.year }, now)) return false;
    } catch {}
  }
  return true;
};

// ---------- per-profile caches ----------
const caches = new Map(); // key -> value, cleared on every rebuild
const cached = (key, build) => {
  if (caches.has(key)) return caches.get(key);
  if (caches.size > 300) caches.clear();
  const v = build();
  caches.set(key, v);
  return v;
};

const episodesOf = (id) => {
  const e = state.entries.get(id);
  return (e && e.rec.eps) || null;
};
const vectorFor = (id) => {
  const e = state.entries.get(id);
  return e ? e.v : null;
};
const titleFor = (id) => {
  const e = state.entries.get(id);
  return e ? e.rec.title : null;
};

const eventsFor = (profileId, now = Date.now()) => {
  const profiles = dep.profiles();
  let imdbOf = () => null;
  try {
    const identity = dep.identity();
    const scanner = dep.scanner();
    imdbOf = (key) => {
      const item = scanner.findById(key);
      return item ? item.imdbId || identity.imdbIdFor(item) : null;
    };
  } catch {}
  // the title view folds library plays into their IMDb-keyed rows
  try { profiles.getProgressView(profileId); } catch {}
  return person.collectEvents(profiles.stateOf(profileId), {
    follows: profiles.followsOf(profileId), now, episodesOf, imdbOf,
  });
};

// The signals stamp moves on every playback heartbeat (a progress write every
// few seconds while somebody watches). Taste does not change that fast: a
// value built less than HOLD_MS ago is reused even though the stamp moved, so
// a home screen opened during a film costs a map lookup, not a re-rank.
const HOLD_MS = 45 * 1000;
const held = (key, stamp, build, now = Date.now()) => {
  const hit = caches.get(key);
  if (hit && (hit.stamp === stamp || now - hit.at < HOLD_MS)) return hit.value;
  if (caches.size > 300) caches.clear();
  const value = build();
  caches.set(key, { stamp, at: now, value });
  return value;
};

const modelFor = (profileId, now = Date.now()) => {
  const profiles = dep.profiles();
  const key = `model|${ALGO}|${profileId}|${dayOf(now)}`;
  return held(key, profiles.signalsStamp(profileId), () => {
    const events = eventsFor(profileId, now);
    const model = person.buildModel(events, { vectorFor, titleFor, now });
    model.unknown = [...events.titles.keys()].filter((id) => !state.entries.has(id) || state.entries.get(id).rec.lite);
    return model;
  }, now);
};

// How many OTHER profiles clearly liked each title — the household's own
// popularity, for cold starts and as a small prior. A kids profile only
// counts what it may see (the caller's `allow` filters candidates anyway).
const householdFor = (profileId, now = Date.now()) => {
  const profiles = dep.profiles();
  const stamps = profiles.list().map((p) => profiles.signalsStamp(p.id)).join(",");
  const all = cached(`house|${stamps}|${dayOf(now)}`, () => {
    const per = new Map(); // profileId -> Set(imdbId)
    for (const p of profiles.list()) {
      const liked = new Set();
      try {
        for (const t of eventsFor(p.id, now).titles.values()) if (t.w >= 1 && t.at && now - t.at < 90 * DAY) liked.add(t.id);
      } catch {}
      per.set(p.id, liked);
    }
    return per;
  });
  const counts = new Map();
  for (const [pid, liked] of all) {
    if (pid === profileId) continue;
    for (const id of liked) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
};

const candidatesFor = (now, allow) => {
  const lib = libraryByImdb();
  const base = cached(`cands|${dep.scanner().index.scannedAt}|${dayOf(now)}`, () =>
    state.list.filter((e) => recommendable(e.rec, now, lib)));
  if (!allow) return base;
  return base.filter((e) => allow(cardOf(e.rec, lib)));
};

// ---------- the home rows ----------
//   profileId   whose home
//   used        ids (IMDb or library) already on the page above the rows:
//               the hero, Continue Watching, My List
//   allow       optional predicate over a card (kids profiles); `allowKey`
//               names the rule (the age limit) for the cache
// Returns null when there is nothing personal to say yet (not built, or a
// profile with no history, no genre picks and no household to borrow from) —
// the caller keeps its old behaviour. Otherwise:
//   { rows: [{ id, title, reason, items: [card + why] }], cold, usedKeys:Set, scoreOf(card) }
const homeRows = ({ profileId, used = [], allow = null, allowKey = "", now = Date.now() } = {}) => {
  if (!ready()) { prepareSoon(); return null; }
  prepareSoon();
  const profiles = dep.profiles();
  const lib = libraryByImdb();
  const day = dayOf(now);
  const usedIds = new Set();
  for (const k of used) {
    if (!k) continue;
    usedIds.add(k);
    const item = /^tt\d+$/.test(k) ? null : dep.scanner().findById(k);
    if (item) {
      const show = item.showId ? dep.scanner().findById(item.showId) : item;
      const id = show && (show.imdbId || dep.identity().imdbIdFor(show));
      if (id) usedIds.add(id);
    }
  }
  const key = `rows|${ALGO}|${profileId}|${day}|${allow ? `kids${allowKey}` : ""}|${[...usedIds].sort().join(",")}`;
  const built = held(key, profiles.signalsStamp(profileId), () => {
    const model = modelFor(profileId, now);
    // evidence the index cannot describe yet: learn it in the background
    if (model.unknown && model.unknown.length) learnSoon(profileId);
    const cands = candidatesFor(now, allow);
    const out = rank.buildRows(model, cands, {
      seed: `${profileId}|${day}`,
      household: householdFor(profileId, now),
      used: usedIds,
      personName: (key2) => personNames.get(key2) || null,
    });
    return { out, model };
  }, now);
  const { out, model } = built;
  if (!out.rows.length) return null;
  const usedKeys = new Set();
  const rows = out.rows.map((r) => ({
    id: r.id,
    title: r.title,
    reason: r.reason,
    ...(r.sub ? { sub: r.sub } : {}),
    items: r.items.map((s) => {
      const card = cardOf(s.c.rec, lib);
      usedKeys.add(s.id);
      if (card.id) usedKeys.add(card.id);
      return s.why ? { ...card, why: s.why } : { ...card };
    }),
  }));
  const scoreOf = (card) => {
    const id = card && (card.imdbId || null);
    const s = id && out.byId ? out.byId.get(id) : null;
    return s ? s.score : 0;
  };
  return { rows, cold: out.cold, usedKeys, scoreOf, mass: model.mass };
};

// director / creator names for "From the director of X — Denis Villeneuve"
const personNames = {
  get: (key) => {
    // key is the TMDB person id; scan lazily, cache per generation
    const map = cached(`people|${state.gen}`, () => {
      const m = new Map();
      for (const e of state.list) for (const [id, name] of [...(e.rec.dir || []), ...(e.rec.cre || [])]) if (!m.has(String(id))) m.set(String(id), name);
      return m;
    });
    return map.get(String(key)) || null;
  },
};

// ---------- more like this ----------
const CONSUMED = /^(finished|rewatch|mostly|devoted|regular|binge|marked|rated\d|dismissed|abandoned|dropped)$/;

// Re-order a "More like this" row for one person: what they have already
// watched (or walked out of) goes, the rest keep the row's own order nudged
// by how well each fits their taste. `items` are client cards with imdbId.
const personaliseSimilar = (items, profileId, { now = Date.now(), limit = 14 } = {}) => {
  const list = Array.isArray(items) ? items : [];
  if (!profileId || !ready() || list.length < 2) return { items: list.slice(0, limit), personalised: false };
  let model;
  try { model = modelFor(profileId, now); } catch { return { items: list.slice(0, limit), personalised: false }; }
  const events = eventsFor(profileId, now);
  const gone = new Set();
  for (const t of events.titles.values()) if ([...t.kinds].some((k) => CONSUMED.test(k))) gone.add(t.id);
  const kept = list.filter((i) => !(i.imdbId && gone.has(i.imdbId)));
  if (model.mass < rank.COLD_MASS) return { items: kept.slice(0, limit), personalised: kept.length !== list.length };
  const cands = [];
  for (const i of kept) {
    const e = i.imdbId ? state.entries.get(i.imdbId) : null;
    if (e) cands.push(e);
  }
  const scored = new Map(rank.scoreAll(model, cands, {}).map((s) => [s.id, s]));
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of scored.values()) { lo = Math.min(lo, s.fit); hi = Math.max(hi, s.fit); }
  const span = hi - lo || 1;
  const ranked = kept.map((item, at) => {
    const s = item.imdbId ? scored.get(item.imdbId) : null;
    const base = 1 - at / kept.length; // the row's own order
    const fit = s ? (s.fit - lo) / span : 0.4; // unknown to the index: neutral-low
    const dislike = s ? s.dislike : 0;
    return { item, val: 0.7 * base + 0.3 * fit - (dislike > 0.3 ? 1 : 0), at };
  });
  ranked.sort((a, b) => b.val - a.val || a.at - b.at);
  return { items: ranked.slice(0, limit).map((r) => r.item), personalised: true };
};

// The neighbours of one title from the index alone — the fallback when the
// vibe ranker cannot reach TMDB. Same curation rules as the vibe row:
// animation stays with animation, documentaries with documentaries, the
// title's own franchise is left to the franchise shelf.
const NO_LIBRARY = new Map();
const localSimilar = (imdbId, { limit = 14, now = Date.now() } = {}) => {
  if (!ready()) { prepareSoon(); return []; }
  const src = state.entries.get(imdbId);
  if (!src) return [];
  const flip = (a, b, g) => (a.rec.g || []).includes(g) !== (b.rec.g || []).includes(g);
  const out = [];
  for (const e of candidatesFor(now, null)) {
    if (e.id === imdbId || e.rec.k !== src.rec.k) continue;
    if (flip(src, e, "Animation") || flip(src, e, "Documentary")) continue;
    if (src.rec.col && e.rec.col && src.rec.col[0] === e.rec.col[0]) continue;
    const sim = features.similarity(src.v, e.v);
    if (sim < 0.15) continue;
    out.push({ e, score: sim * (0.8 + 0.4 * features.qualityOf(e.rec)) });
  }
  out.sort((a, b) => b.score - a.score || (a.e.id < b.e.id ? -1 : 1));
  const seenCol = new Set();
  const items = [];
  for (const { e } of out) {
    if (e.rec.col) {
      if (seenCol.has(e.rec.col[0])) continue;
      seenCol.add(e.rec.col[0]);
    }
    const shared = features.sharedOf(src.v.theme, e.v.theme).slice(0, 3).map((s) => tax.themeLabel(s));
    // always the stream-shaped card here: a detail-page shelf navigates by
    // IMDb id, and that page resolves a library copy by itself
    const card = cardOf(e.rec, NO_LIBRARY);
    items.push({ ...card, ...(shared.length ? { why: `Same vibe: ${shared.join(" · ")}` } : {}) });
    if (items.length >= limit) break;
  }
  return items;
};

// ---------- the daily round ----------
const cardsSeen = () => {
  const cards = [];
  try {
    const t = dep.discover().trendingCached();
    if (t) cards.push(...t.movies, ...t.shows);
  } catch {}
  try { cards.push(...dep.hero().poolCached()); } catch {}
  try { cards.push(...dep.discover().catalogCachedItems()); } catch {}
  try {
    const identity = dep.identity();
    for (const item of dep.scanner().allItems()) {
      const imdbId = item.imdbId || identity.imdbIdFor(item);
      if (imdbId) cards.push({ ...item, imdbId, poster: null });
    }
  } catch {}
  return cards;
};
const wantOf = (c) => ({
  imdbId: c.imdbId, kind: c.type === "show" || c.type === "series" ? "tv" : "movie",
  genres: c.genres, poster: c.poster, backdrop: c.backdrop, synopsis: c.synopsis,
});

// What each profile's evidence points at, as index wants. Kind is a guess
// for ids the index has never seen (episode rows say "series").
const evidenceWants = (profileId) => {
  const profiles = dep.profiles();
  const st = profiles.stateOf(profileId) || {};
  const wants = new Map();
  const add = (imdbId, kind) => {
    if (/^tt\d{4,12}$/.test(String(imdbId || "")) && !wants.has(imdbId)) wants.set(imdbId, { imdbId, kind });
  };
  for (const key of Object.keys(st.titles || {})) add(key.split(":")[0], key.includes(":") ? "tv" : "movie");
  for (const sm of Object.values(st.streamItems || {})) if (sm && sm.imdbId) add(sm.imdbId, sm.type === "show" || sm.season != null ? "tv" : "movie");
  for (const e of st.watchlist || []) if (e && typeof e === "object") add(e.imdbId, e.type === "show" ? "tv" : "movie");
  for (const key of Object.keys(st.ratings || {})) add(key, "movie");
  for (const t of st.likedTitles || []) add(t.imdbId, "movie");
  for (const f of profiles.followsOf(profileId)) add(f.imdbId, "tv");
  return [...wants.values()];
};

// A wrong film/series guess leaves a title unknown; try the other kind once.
const ensureEitherKind = async (wants, budget) => {
  const first = await titleindex.ensure(wants, { budget });
  const left = wants
    .filter((w) => { const r = titleindex.get(w.imdbId); return !r || r.lite; })
    .map((w) => ({ ...w, kind: w.kind === "tv" ? "movie" : "tv" }));
  const second = left.length && budget - first.asked > 0 ? await titleindex.ensure(left, { budget: budget - first.asked }) : { asked: 0, got: 0 };
  return { asked: first.asked + second.asked, got: first.got + second.got, failed: first.failed + (second.failed || 0) };
};

// Budgets, in TMDB detail calls per run. The first run on a fresh install has
// a whole catalogue to learn; after that a day's worth is small.
const BUDGET = { first: 1200, daily: 350, expandPerProfile: 90, refresh: 40, learn: 12 };

const sync = async ({ budget = null } = {}) => {
  const started = Date.now();
  const before = tmdb.stats().calls;
  const out = { titles: 0, learned: 0, catalogue: 0, expanded: 0, refreshed: 0, calls: 0 };
  const cards = cardsSeen();
  titleindex.noteCards(cards); // lite records: no network, works offline
  // what must outlive pruning: everything a profile touched, the library,
  // and the catalogue as it stands today
  try {
    titleindex.setKeep([
      ...cards.map((c) => c.imdbId),
      ...dep.profiles().list().flatMap((p) => evidenceWants(p.id).map((w) => w.imdbId)),
    ]);
  } catch {}
  if (!tmdb.hasKey()) {
    await prepare();
    out.titles = titleindex.size();
    out.note = "no TMDB key: catalogue knowledge only";
    return out;
  }
  const full = titleindex.all().filter((r) => !r.lite).length;
  let left = budget != null ? budget : full < 300 ? BUDGET.first : BUDGET.daily;
  const spend = (r) => { left -= r.asked || 0; return r; };
  const profiles = dep.profiles();

  // 1. what people actually touched — the evidence must be describable
  const evidence = profiles.list().flatMap((p) => evidenceWants(p.id));
  out.learned = spend(await ensureEitherKind(evidence, Math.max(0, left))).got;

  // 2. the catalogue the clients browse (lite -> full), most of the budget
  if (left > 0) out.catalogue = spend(await titleindex.ensure(cards.map(wantOf), { budget: Math.ceil(left * 0.6) })).got;

  // 3. widen the pool along each person's taste
  await prepare();
  for (const p of profiles.list()) {
    if (left <= 0) break;
    let model;
    try { model = modelFor(p.id); } catch { continue; }
    if (!model || model.mass < rank.COLD_MASS) continue;
    const wants = [];
    // a) TMDB's neighbours of their most-liked titles
    for (const a of model.pos.slice(0, 8)) {
      const e = state.entries.get(a.id);
      if (!e || e.rec.lite) continue;
      for (const id of [...(e.rec.recs || []).slice(0, 10), ...(e.rec.sim || []).slice(0, 4)]) wants.push({ tmdbId: id, kind: e.rec.k });
    }
    // b) the other work of the two makers they rate most
    const makers = new Map();
    for (const a of model.pos.slice(0, 12)) {
      const e = state.entries.get(a.id);
      if (!e || a.eff < 1) continue;
      for (const [pid] of [...(e.rec.dir || []), ...(e.rec.cre || [])]) makers.set(pid, { eff: (makers.get(pid) || { eff: 0 }).eff + a.eff, kind: e.rec.k });
    }
    for (const [pid, m] of [...makers.entries()].sort((x, y) => y[1].eff - x[1].eff).slice(0, 2)) {
      try {
        const ids = await titleindex.cachedList(`person|${m.kind}|${pid}`, async () => {
          const credits = (await tmdb.get(`person/${pid}/${m.kind === "tv" ? "tv_credits" : "movie_credits"}`)).crew || [];
          const seen = new Set();
          return credits
            .filter((c) => c.poster_path && (m.kind === "tv" ? /creator|executive producer|writer/i.test(c.job || "") : c.job === "Director"))
            .filter((c) => !seen.has(c.id) && seen.add(c.id))
            .sort((x, y) => (y.vote_count || 0) - (x.vote_count || 0))
            .slice(0, 12)
            .map((c) => c.id);
        });
        for (const id of ids) wants.push({ tmdbId: id, kind: m.kind });
      } catch {}
    }
    // c) the best-loved titles carrying the keywords behind their top themes
    const themeKw = new Map(); // slug -> { eff, ids:Set, kind }
    for (const a of model.pos.slice(0, 12)) {
      const e = state.entries.get(a.id);
      if (!e) continue;
      for (const [kid, name] of e.rec.kw || []) {
        for (const slug of tax._internals.slugsForKeyword(name)) {
          if ((a.v.themes[slug] || 0) < 1) continue;
          const t = themeKw.get(slug) || { eff: 0, ids: new Set(), kinds: {} };
          t.eff += a.eff;
          t.ids.add(kid);
          t.kinds[e.rec.k] = (t.kinds[e.rec.k] || 0) + 1;
          themeKw.set(slug, t);
        }
      }
    }
    for (const [slug, t] of [...themeKw.entries()].sort((x, y) => y[1].eff - x[1].eff).slice(0, 3)) {
      const kind = (t.kinds.tv || 0) > (t.kinds.movie || 0) ? "tv" : "movie";
      try {
        const ids = await titleindex.cachedList(`theme|${kind}|${slug}|${[...t.ids].sort().slice(0, 6).join("-")}`, async () => {
          const res = await tmdb.get(`discover/${kind}`, `&with_keywords=${[...t.ids].slice(0, 6).join("|")}&sort_by=vote_average.desc&vote_count.gte=${kind === "tv" ? 150 : 400}`);
          return (res.results || []).filter((r) => r.poster_path).map((r) => r.id).slice(0, 14);
        });
        for (const id of ids) wants.push({ tmdbId: id, kind });
      } catch {}
    }
    out.expanded += spend(await titleindex.ensure(wants, { budget: Math.min(left, BUDGET.expandPerProfile) })).got;
  }

  // 4. keep what we know current: the stalest full records, a few a day
  if (left > 0) {
    const stalest = titleindex.all()
      .filter((r) => !r.lite && titleindex.stale(r))
      .sort((a, b) => (a.at || 0) - (b.at || 0))
      .slice(0, Math.min(left, BUDGET.refresh))
      .map((r) => ({ imdbId: r.id, tmdbId: r.tm, kind: r.k }));
    out.refreshed = spend(await titleindex.ensure(stalest, { budget: stalest.length, refresh: true })).got;
  }

  await prepare();
  out.titles = titleindex.size();
  out.calls = tmdb.stats().calls - before;
  out.seconds = Math.round((Date.now() - started) / 1000);
  return out;
};

// A profile just touched something the index has never heard of: learn those
// few titles now (a dozen calls at most, at most once per ten minutes per
// profile) so tomorrow's rows are not blind to today's watch.
const learning = new Map();
const learnSoon = (profileId) => {
  if (!tmdb.hasKey()) return;
  const last = learning.get(profileId) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  learning.set(profileId, Date.now());
  setImmediate(async () => {
    try {
      const wants = evidenceWants(profileId).filter((w) => { const r = titleindex.get(w.imdbId); return !r || r.lite; });
      if (!wants.length) return;
      await ensureEitherKind(wants, BUDGET.learn);
      await prepare();
    } catch {}
  });
};

// Boot: read the index, note the cards already cached, build the vectors.
// No network. Called once from server.js a little after start.
const warm = async () => {
  try { titleindex.noteCards(cardsSeen()); } catch {}
  return prepare();
};

const status = () => ({
  algo: ALGO,
  ready: ready(),
  titles: titleindex.size(),
  full: titleindex.all().filter((r) => !r.lite).length,
  builtAt: state.builtAt || null,
  tmdb: tmdb.stats(),
});

module.exports = {
  ALGO, homeRows, personaliseSimilar, localSimilar, sync, warm, prepare, ready, status, cardOf,
  _internals: { state, modelFor, eventsFor, candidatesFor, householdFor, recommendable, BUDGET, caches, dep, evidenceWants },
};

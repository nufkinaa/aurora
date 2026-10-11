// "More like this", by VIBE (v2 of the row, elia 2026-09-23: "similar
// recommendations on different movies and not really good ones based on the
// movie vibe").
//
// What was wrong with v1, measured on the cached rows: it was TMDB's
// /recommendations (collaborative — "people who watched this also watched")
// topped up with /similar. Collaborative data is dominated by what happens to
// sit on the same streaming platform or in the same popularity band, not by
// what a film FEELS like: Interstellar got Stargate: The Ark of Truth and The
// Last Mimzy, Silo got NOS4A2 and House of Cards, Spider-Man got its own
// franchise (which already has a shelf of its own).
//
// v2 keeps that collaborative signal as ONE vote among several and ranks on
// what TMDB knows about a title's vibe — its keywords ("time loop", "slow
// burn", "grief", "dystopia") — plus genre, era, quality, language and
// runtime:
//
//   generate   three candidate pools: /recommendations, /similar, and a
//              keyword discover query built from the source's own keywords
//   pre-rank   cheaply, on the fields list endpoints already carry
//   enrich     the best ~30 with their keywords (one call each, which also
//              returns the IMDb id the client navigates by — the call v1 made
//              per item anyway)
//   rank       weighted keyword overlap does the heavy lifting: a keyword
//              most of the neighbourhood shares says little, a rare shared
//              one ("tesseract") says a lot, a generic one ("based on
//              novel or book") says nothing at all
//
// Plus the rules that make a row feel curated rather than computed: no
// animation under live action (or the reverse), no documentaries under
// fiction, kids' TV only under kids' TV, one film per franchise (and none
// from the source's own — the franchise shelf shows those), and a penalty
// for the blockbuster that is 10x more popular than the film you're on.
//
// v3 (2026-10-10, with the recommender in media/recs): two things keywords
// alone could not see.
//   themes   TMDB's keywords are a folksonomy — "heist", "bank robbery" and
//            "caper" are three spellings of one idea, and two films tagged
//            with different ones shared nothing. The taxonomy
//            (recs/taxonomy.json) maps the spellings onto themes; shared
//            themes now vote next to shared keywords, and name the "why"
//            when no keyword is shared word for word.
//   makers   the same director or creator is a vote of its own (style is the
//            thing keywords never carry).
// And nothing fetched is thrown away any more: every title this ranker
// enriches is handed to the recommender's title index, so a row viewed today
// widens what Home can recommend tomorrow at no extra request.
//
// rankCandidates() is pure — every weight and rule is pinned in
// test/vibe.test.js without a network.
const config = require("../config");
const taxonomy = require("./recs/taxonomy");

const TMDB = "https://api.themoviedb.org/3";
// One retry on a timeout, a dropped connection, a 429 or a 5xx: a row is
// ~45 calls, and one slow answer used to sink the whole thing.
const tmdb = async (pathname, params = "", attempt = 0) => {
  let res;
  try {
    res = await fetch(`${TMDB}/${pathname}?api_key=${config.TMDB_KEY}${params}`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    if (attempt < 1) return tmdb(pathname, params, attempt + 1);
    throw err;
  }
  try { require("../lib/signals").provider(TMDB, res.status); } catch {}
  if ((res.status === 429 || res.status >= 500) && attempt < 1) {
    await new Promise((r) => setTimeout(r, 400));
    return tmdb(pathname, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`tmdb ${res.status}`);
  return res.json();
};

// TMDB genre ids with hard rules attached.
const ANIMATION = 16;
const DOCUMENTARY = 99;
const TV_KIDS = 10762;
const TV_MOVIE = 10770;

// Keywords that describe paperwork, not vibe: sources, production facts,
// ubiquitous settings and relationships. They weigh ZERO — without this, two
// films "match" because both are based on a novel and set in New York.
const STOP = new Set([
  "based on novel or book", "based on comic", "based on true story", "based on young adult novel",
  "based on play or musical", "based on short story", "based on video game", "based on manga",
  "based on tv series", "based on movie", "based on memoir or autobiography", "biography",
  "sequel", "prequel", "remake", "reboot", "spin off", "live action remake", "duringcreditsstinger",
  "aftercreditsstinger", "woman director", "independent film", "anime", "sitcom", "miniseries",
  "tv series", "limited series", "anthology", "new york city", "los angeles, california",
  "london, england", "paris, france", "united states", "usa", "england", "friendship", "family",
  "love", "death", "murder", "father son relationship", "mother daughter relationship",
  "father daughter relationship", "mother son relationship", "husband wife relationship", "family relationships",
  "brother brother relationship", "sister sister relationship", "brother sister relationship",
  "teenager", "high school", "romance", "revenge", "violence", "blood", "lgbt", "gay theme",
  "3d", "imax", "short film", "christmas", "holiday", "sex", "nudity", "drugs", "alcohol",
  // genre names as keywords: genre is already scored on its own, and "Same
  // vibe: science fiction" explains nothing (it put Uranus 2324 under Arrival)
  "science fiction", "sci-fi", "comedy", "horror", "drama", "thriller", "fantasy", "animation",
  "action", "mystery", "adventure",
]);

const lc = (s) => String(s || "").trim().toLowerCase();
const yearOf = (d) => parseInt(String(d || "").slice(0, 4), 10) || null;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// A detail or list payload -> the fields ranking needs. `kind` "movie"|"tv".
const profileOf = (raw, kind, pools = []) => {
  const genreIds = new Set(
    raw.genre_ids ? raw.genre_ids : (raw.genres || []).map((g) => g.id),
  );
  const kwList = raw.keywords
    ? (raw.keywords.keywords || raw.keywords.results || [])
    : null; // null = not enriched yet (list payloads carry no keywords)
  const runtime =
    kind === "movie"
      ? raw.runtime || null
      : (raw.episode_run_time && raw.episode_run_time[0]) || null;
  return {
    tmdbId: raw.id,
    kind,
    title: raw.title || raw.name || "",
    year: yearOf(raw.release_date || raw.first_air_date),
    genreIds,
    keywords: kwList ? kwList.map((k) => lc(k.name)).filter(Boolean) : null,
    runtime,
    lang: raw.original_language || null,
    voteAverage: raw.vote_average || 0,
    voteCount: raw.vote_count || 0,
    popularity: raw.popularity || 0,
    collectionId: (raw.belongs_to_collection && raw.belongs_to_collection.id) || null,
    // who made it: directors (film) / creators (series). null = not enriched.
    makers: raw.credits || raw.created_by
      ? new Set([
          ...((raw.credits && raw.credits.crew) || []).filter((c) => c.job === "Director").map((c) => c.id),
          ...(raw.created_by || []).map((c) => c.id),
        ])
      : null,
    // what it is about, in the taxonomy's terms ({ slug: weight })
    themes: kwList
      ? taxonomy.themesOf({ keywords: kwList.map((k) => lc(k.name)), overview: raw.overview || "" })
      : null,
    imdbId: (raw.external_ids && raw.external_ids.imdb_id) || raw.imdb_id || null,
    poster: raw.poster_path || null,
    backdrop: raw.backdrop_path || null,
    overview: raw.overview || "",
    pools: new Set(pools),
  };
};

const jaccard = (a, b) => {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

// Bayesian-shrunk rating on 0..1: a 9.1 from 12 votes is not a 9.1.
const qualityOf = (c) => {
  const prior = 6.6;
  const weight = 300;
  const bayes = (c.voteAverage * c.voteCount + prior * weight) / (c.voteCount + weight);
  return clamp01((bayes - 5.5) / 3);
};

// TONE. Two films can share every keyword ("space travel", "time travel")
// and feel nothing alike — Interstellar and Avengers: Endgame do exactly
// that. What separates them is register: a contemplative drama vs an action
// spectacle vs a comedy vs a scare. Each flip on these axes (the source has
// it, the candidate doesn't, or the reverse) costs the candidate. TV has its
// own ids for action (10759 "Action & Adventure").
// Weighted: TV's "Action & Adventure" is stamped on so many dramas that it
// is half as telling as a film's Action.
const TONE_AXES = [
  { ids: [35], w: 1 }, // comedy
  { ids: [28], w: 1 }, // action (film)
  { ids: [10759], w: 0.5 }, // action & adventure (tv)
  { ids: [27], w: 1 }, // horror
  { ids: [10751], w: 1 }, // family
  // speculative vs grounded: Silo and House of Cards share "politics ·
  // corruption", but one is a sealed-off future and the other is Washington
  { ids: [878, 14, 10765], w: 1 }, // sci-fi / fantasy (film), sci-fi & fantasy (tv)
];
const toneFlips = (src, c) =>
  TONE_AXES.reduce(
    (n, { ids, w }) => n + (ids.some((g) => src.genreIds.has(g)) !== ids.some((g) => c.genreIds.has(g)) ? w : 0),
    0,
  );

// Genre rules that no amount of keyword overlap can override.
const hardMismatch = (src, c) => {
  const flip = (g) => src.genreIds.has(g) !== c.genreIds.has(g);
  if (flip(ANIMATION)) return "animation vs live action";
  if (flip(DOCUMENTARY)) return "documentary vs fiction";
  if (c.genreIds.has(TV_KIDS) && !src.genreIds.has(TV_KIDS)) return "kids' TV";
  // a TV special / TV movie under a theatrical film (Doctor Who specials
  // under Interstellar share "time travel" and nothing else)
  if (c.genreIds.has(TV_MOVIE) && !src.genreIds.has(TV_MOVIE)) return "tv movie";
  return null;
};

// Cheap first pass on list-level fields, to choose who gets enriched.
const preScore = (src, c) => {
  const pools = (c.pools.has("rec") ? 0.15 : 0) + (c.pools.has("kw") ? 0.2 : 0) + (c.pools.has("sim") ? 0.05 : 0);
  const era = src.year && c.year ? 1 - Math.min(1, Math.abs(src.year - c.year) / 35) : 0.5;
  return 0.4 * jaccard(src.genreIds, c.genreIds) + pools + 0.15 * qualityOf(c) + 0.1 * era +
    0.05 * (src.lang && c.lang === src.lang ? 1 : 0) - 0.08 * toneFlips(src, c);
};

// Keyword weights within this neighbourhood: shared-by-everyone is weak,
// rare is strong, stop-listed is nothing.
const keywordWeights = (src, cands) => {
  const df = new Map();
  for (const c of cands) for (const k of new Set(c.keywords || [])) df.set(k, (df.get(k) || 0) + 1);
  return (k) => (STOP.has(k) ? 0 : 1 / (1 + Math.log(1 + (df.get(k) || 0))));
};

const keywordSim = (src, c, w) => {
  if (!src.keywords || !c.keywords) return { sim: 0, shared: [] };
  const S = new Set(src.keywords);
  const C = new Set(c.keywords);
  let num = 0;
  const shared = [];
  for (const k of S) {
    if (C.has(k) && w(k) > 0) {
      num += w(k);
      shared.push(k);
    }
  }
  let sw = 0;
  let cw = 0;
  for (const k of S) sw += w(k);
  for (const k of C) cw += w(k);
  if (!sw || !cw) return { sim: 0, shared };
  // most distinctive first — that's what the "why" should lead with
  shared.sort((a, b) => w(b) - w(a));
  return { sim: num / Math.sqrt(sw * cw), shared };
};

// Shared themes, as a cosine over the two titles' theme weights. Themes that
// rest on one keyword weigh 0.7, on two or more 1.2+ (taxonomy.themesOf), so
// a passing mention counts for less than what the title is built on.
// `credited`: themes a literally-shared keyword already stands for. Those
// were paid for by the keyword match (and weighed by its rarity there);
// counting the theme again would let "space travel" — which the whole
// neighbourhood shares — outvote a rare shared keyword. Themes only add what
// keywords missed: the same idea under a different spelling.
const themeSim = (src, c, credited = null) => {
  if (!src.themes || !c.themes) return { sim: 0, shared: [] };
  let num = 0;
  let a = 0;
  let b = 0;
  const shared = [];
  for (const [slug, w] of Object.entries(src.themes)) {
    a += w * w;
    if (c.themes[slug] && !(credited && credited.has(slug))) {
      num += w * c.themes[slug];
      shared.push([slug, w * c.themes[slug]]);
    }
  }
  for (const w of Object.values(c.themes)) b += w * w;
  if (!a || !b) return { sim: 0, shared: [] };
  shared.sort((x, y) => y[1] - x[1]);
  return { sim: num / Math.sqrt(a * b), shared: shared.map((s) => s[0]) };
};

// Every weight in one place, so tuning is a data change (and the evaluation
// harness can compare variants side by side without editing code).
const WEIGHTS = {
  kw: 0.45, // shared vibe keywords, normalised within the neighbourhood
  theme: 0.12, // shared taxonomy themes, normalised the same way
  maker: 0.05, // same director / creator
  genre: 0.15,
  quality: 0.12,
  era: 0.07,
  lang: 0.04,
  runtime: 0.03,
  // Collaborative "people also liked", scaled by TMDB's own rank. Tuned on
  // the 12-title judgment set (good/bad in top 10, v1 = 29/12): 0.08 with no
  // trust exemption scored 55/8; raising it to 0.14-0.2, or letting the top
  // 6-10 recommendations skip the no-shared-vibe penalty, only let back the
  // platform-mates keywords had filtered out (House of Cards under Silo).
  voteRec: 0.08,
  recTrustTop: 0, // top-N recommendations vouched for without shared keywords (off; see above)
  voteKw: 0.04, // surfaced by the keyword pool
  tone: 0.12, // per weighted tone-axis flip
  noVibe: 0.1, // has keywords, shares none
  sparse: 0.08, // too few keywords to vouch for its vibe
  magnet: 0.07, // far more popular than the source, without shared vibe
};

// THE ranker. `src` and `cands` are profileOf() shapes; candidates that were
// never enriched (keywords === null) still rank, on everything else.
const rankCandidates = (src, cands, { limit = 14, explain = false, weights = {} } = {}) => {
  const W = { ...WEIGHTS, ...weights };
  const pool = cands.filter(
    (c) =>
      c.tmdbId !== src.tmdbId &&
      c.poster &&
      !hardMismatch(src, c) &&
      // the source's own franchise has its own shelf on the page
      !(src.collectionId && c.collectionId === src.collectionId),
  );
  const w = keywordWeights(src, pool);
  // Keyword similarity lands in a narrow band (~0.03-0.25 in practice), so
  // on its raw scale it was out-voted by a plain genre match. Normalised to
  // the best vibe match in THIS neighbourhood, the closest in feel scores 1.
  const sims = new Map(pool.map((c) => [c, keywordSim(src, c, w)]));
  const maxKw = Math.max(0, ...[...sims.values()].map((x) => x.sim));
  const themeSims = new Map(pool.map((c) => {
    const credited = new Set(sims.get(c).shared.flatMap((k) => taxonomy._internals.slugsForKeyword(k)));
    return [c, themeSim(src, c, credited)];
  }));
  const maxTheme = Math.max(0, ...[...themeSims.values()].map((x) => x.sim));
  const hasVibe = (p) => (p.keywords || []).some((k) => !STOP.has(k));
  const vibeCount = (p) => (p.keywords || []).filter((k) => !STOP.has(k)).length;
  const scored = pool.map((c) => {
    const { sim: raw, shared } = sims.get(c);
    const kw = maxKw > 0 ? raw / maxKw : 0;
    const th = themeSims.get(c);
    const theme = maxTheme > 0 ? th.sim / maxTheme : 0;
    const maker = src.makers && c.makers && [...src.makers].some((id) => c.makers.has(id)) ? 1 : 0;
    const genre = jaccard(src.genreIds, c.genreIds);
    const era = src.year && c.year ? 1 - Math.min(1, Math.abs(src.year - c.year) / 35) : 0.5;
    const runtime =
      src.runtime && c.runtime ? 1 - Math.min(1, Math.abs(src.runtime - c.runtime) / 90) : 0.5;
    const lang = src.lang && c.lang === src.lang ? 1 : 0;
    // collaborative filtering still gets a vote — it's often right, just not
    // alone; the keyword pool is itself evidence of shared vibe
    // …and TMDB's ORDER matters: its top recommendations are the strongest
    // evidence of style, the thing keywords can't see (every Wes Anderson film
    // shares a look, not a plot — Grand Budapest's keywords are "hotel, art
    // theft", which found The Big Kahuna)
    const recVote = c.recRank != null ? W.voteRec * (1 - Math.min(c.recRank, 19) / 20) : 0;
    const votes = recVote + (c.pools.has("kw") ? W.voteKw : 0);
    const vouched = c.recRank != null && c.recRank < W.recTrustTop;
    // the blockbuster magnet: much more popular than the source AND not
    // backed by shared vibe keywords
    const popRatio = src.popularity > 0 && c.popularity > 0 ? Math.log10(c.popularity / src.popularity) : 0;
    const magnet = kw < 0.3 ? W.magnet * clamp01(popRatio - 1) : 0;
    const tone = W.tone * toneFlips(src, c);
    // Vibe evidence required. A candidate with real keywords that shares
    // none with the source is out of vibe; one with barely any keywords
    // (NOS4A2 has one) is UNVERIFIED — and on TV, genre can't vouch for it,
    // because "Sci-Fi & Fantasy" lumps horror, fantasy and sci-fi together.
    // (a shared THEME is vibe evidence too: "bank robbery" under "heist")
    const noVibe = !vouched && hasVibe(src) && vibeCount(c) >= 3 && shared.length === 0 && th.shared.length === 0 ? W.noVibe : 0;
    const sparse = !vouched && hasVibe(src) && vibeCount(c) < 3 ? W.sparse : 0;
    const score =
      W.kw * kw + W.theme * theme + W.maker * maker + W.genre * genre + W.quality * qualityOf(c) + W.era * era +
      W.lang * lang + W.runtime * runtime + votes - magnet - tone - noVibe - sparse;
    return {
      c, score, shared, themes: th.shared,
      parts: { kw, theme, maker, genre, tone: -tone, noVibe: -noVibe, sparse: -sparse, magnet: -magnet, votes },
    };
  });
  scored.sort((a, b) => b.score - a.score);

  // one per franchise, so three Star Treks can't fill a row
  const seenColl = new Set();
  const out = [];
  for (const s of scored) {
    if (s.c.collectionId) {
      if (seenColl.has(s.c.collectionId)) continue;
      seenColl.add(s.c.collectionId);
    }
    out.push(s);
    if (out.length >= limit) break;
  }
  return out.map((s) => ({
    ...s.c,
    score: Math.round(s.score * 1000) / 1000,
    ...(explain ? { parts: s.parts, shared: s.shared, sharedThemes: s.themes } : {}),
    why: s.shared.length
      ? `Same vibe: ${s.shared.slice(0, 3).join(" · ")}`
      : s.themes.length
        ? `Same vibe: ${s.themes.slice(0, 3).map((t) => taxonomy.themeLabel(t)).join(" · ")}`
        : s.c.pools.has("rec")
          ? "People who loved this loved this too"
          : null,
  }));
};

// A ranked profile -> the discover-item shape every catalog response uses.
const toItem = (c) => ({
  type: c.kind === "tv" ? "show" : "movie",
  title: c.title,
  year: c.year,
  poster: `https://image.tmdb.org/t/p/w342${c.poster}`,
  backdrop: c.backdrop ? `https://image.tmdb.org/t/p/w780${c.backdrop}` : null,
  synopsis: c.overview,
  rating: c.voteAverage ? Math.round(c.voteAverage * 10) / 10 : null,
  genres: [],
  tmdbId: c.tmdbId,
  imdbId: c.imdbId,
  ...(c.why ? { why: c.why } : {}),
});

// Which source keywords seed the keyword pools. TMDB lists them in no useful
// order: the first eight of Interstellar's are "spacecraft, race against
// time, expedition, dystopia…", broad enough to pull in any acclaimed film.
// Specific phrases ("black hole", "quantum mechanics") say more than single
// words ("space"). "both" seeds one pool from each and is the default.
const seedKeywords = (srcRaw, mode) => {
  const all = (srcRaw.keywords ? srcRaw.keywords.keywords || srcRaw.keywords.results || [] : []).filter(
    (k) => !STOP.has(lc(k.name)),
  );
  const first = all.slice(0, 8);
  const specific = all
    .map((k) => ({ k, words: lc(k.name).split(/[\s-]+/).length, len: lc(k.name).length }))
    .sort((a, b) => b.words - a.words || b.len - a.len)
    .slice(0, 6)
    .map((x) => x.k);
  if (mode === "first") return [first];
  if (mode === "specific") return [specific];
  return [first, specific];
};

// Network half: the source, its candidate pools, and the enriched shortlist.
// Split from ranking so the evaluation harness can fetch once and re-rank
// many ways.
const gather = async (type, tmdbId, sourceImdbId, { seed = "both", shortlist = 36 } = {}) => {
  const kind = type === "series" ? "tv" : "movie";
  // The full append (credits, ratings, TMDB's own neighbour lists) costs no
  // extra request and is what the recommender's title index keeps.
  const titleindex = require("./recs/titleindex");
  const APPEND = titleindex._internals.APPEND[kind];
  const learn = (raw, imdbId) => {
    try {
      const rec = titleindex._internals.fromTmdb(raw, kind, imdbId ? { imdbId } : {});
      if (rec) titleindex.put(rec);
    } catch {}
  };
  const srcRaw = await tmdb(`${kind}/${tmdbId}`, APPEND);
  learn(srcRaw, sourceImdbId);
  const src = profileOf(srcRaw, kind);

  const byId = new Map();
  const add = (results, tag) => {
    (results || []).forEach((r, i) => {
      if (!r || !r.id || r.id === tmdbId || !r.poster_path) return;
      let hit = byId.get(r.id);
      if (hit) hit.pools.add(tag);
      else byId.set(r.id, (hit = profileOf(r, kind, [tag])));
      // TMDB's own position in its recommendation list — see recVote
      if (tag === "rec") hit.recRank = Math.min(hit.recRank == null ? 99 : hit.recRank, i);
    });
  };
  // "|" = OR: any of the source's genres, so a keyword pool stays in the
  // right broad area without demanding every genre at once
  const genreOr = [...src.genreIds].join("|");
  const minVotes = kind === "movie" ? 150 : 60;
  // Per seed set, two queries: the best-KNOWN films sharing the vibe, and
  // the best-RATED. The first alone skews to mega-hits (Avengers shares
  // "space travel" with everything); the second is where the Moons and
  // Sunshines of a neighbourhood come from.
  const kwQuery = (keywords, sort) =>
    keywords.length
      ? tmdb(
          `discover/${kind}`,
          `&with_keywords=${keywords.map((k) => k.id).join("|")}` +
            (genreOr ? `&with_genres=${genreOr}` : "") +
            `&sort_by=${sort}&vote_count.gte=${minVotes}`,
        ).catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] });
  const seeds = seedKeywords(srcRaw, seed);
  const [rec, sim, ...kwPools] = await Promise.all([
    tmdb(`${kind}/${tmdbId}/recommendations`).catch(() => ({ results: [] })),
    tmdb(`${kind}/${tmdbId}/similar`).catch(() => ({ results: [] })),
    ...seeds.flatMap((ks) => [kwQuery(ks, "vote_count.desc"), kwQuery(ks, "vote_average.desc")]),
  ]);
  add(rec.results, "rec");
  add(sim.results, "sim");
  for (const p of kwPools) add(p.results, "kw");

  // enrich the most promising — hard mismatches never cost a call
  // TMDB's top 12 recommendations are always enriched: six keyword queries
  // bring ~120 candidates, and on pre-score alone they crowded the
  // recommendations out (Moonrise Kingdom never reached Grand Budapest's
  // shortlist). The rest of the slots go to the best pre-scores.
  const eligible = [...byId.values()].filter((c) => !hardMismatch(src, c));
  const recTop = eligible
    .filter((c) => c.recRank != null)
    .sort((a, b) => a.recRank - b.recRank)
    .slice(0, 12);
  const list = [
    ...recTop,
    ...eligible
      .filter((c) => !recTop.includes(c))
      .sort((a, b) => preScore(src, b) - preScore(src, a))
      .slice(0, Math.max(0, shortlist - recTop.length)),
  ];
  const queue = [...list];
  const enriched = [];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const c = queue.shift();
        try {
          const raw = await tmdb(`${kind}/${c.tmdbId}`, APPEND);
          learn(raw);
          const e = profileOf(raw, kind, [...c.pools]);
          if (c.recRank != null) e.recRank = c.recRank;
          enriched.push(e);
        } catch {}
      }
    }),
  );
  return { src, candidates: enriched.filter((c) => c.imdbId && c.imdbId !== sourceImdbId) };
};

const vibeRow = async (type, tmdbId, sourceImdbId, opts = {}) => {
  const { src, candidates } = await gather(type, tmdbId, sourceImdbId, opts);
  const ranked = rankCandidates(src, candidates, opts);
  // explain = the tuning view (scores, parts, genre ids, keywords) instead of client items
  return opts.explain ? { src, ranked } : ranked.map(toItem);
};

module.exports = {
  vibeRow,
  _internals: {
    rankCandidates, gather, profileOf, hardMismatch, keywordSim, keywordWeights, themeSim, qualityOf,
    preScore, toneFlips, seedKeywords, WEIGHTS, STOP, toItem,
  },
};

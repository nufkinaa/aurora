// The taxonomy: what a title is ABOUT and how it FEELS, beyond its genre.
//
// "Thriller" covers a heist caper, a courtroom drama and a serial-killer
// procedural; a person who wants more of the first does not want the third.
// TMDB's keywords know the difference but are a folksonomy — "heist",
// "bank robbery", "bank heist", "caper", "robbery" are five spellings of one
// idea, and two films tagged with different ones share nothing as far as a
// keyword match can tell. taxonomy.json is the curated mapping from those
// spellings onto ~100 THEMES in six groups:
//
//   plot       what happens       heist, whodunit, revenge, survival, time-travel…
//   mood       how it feels       slow-burn, feel-good, dark, mind-bending, satire…
//   setting    where / when       space, dystopia, small-town, wartime, high-school…
//   character  who it is about    antihero, found-family, coming-of-age, strong-female-lead…
//   subgenre   the finer genre    cyberpunk, neo-noir, superhero, zombie, period-drama…
//   form       how it is made     true-story, mockumentary, anthology, anime, stand-up…
//
// A theme matches a title when one of its keywords is on the title (exact,
// lower-case), when a keyword contains one of its `has` fragments, or — at
// half weight, for titles TMDB has barely tagged — when its `plot` pattern is
// in the synopsis. The file is data: adding a spelling or a theme is an edit
// to the JSON, no code (and tools/recs-eval/keywords.js lists the most common
// keywords no theme claims yet, which is how the list was built).
//
// Also here: the canonical GENRE names. The catalogue (Cinemeta/IMDb), the
// library and Settings → "What you like" say "Sci-Fi"; TMDB says "Science
// Fiction", and for series lumps "Sci-Fi & Fantasy" and "Action & Adventure".
const data = require("./taxonomy.json");

const GENRE_ALIASES = {
  "science fiction": ["Sci-Fi"],
  "sci-fi": ["Sci-Fi"],
  "sci-fi & fantasy": ["Sci-Fi", "Fantasy"],
  "action & adventure": ["Action", "Adventure"],
  "war & politics": ["War"],
  kids: ["Family"],
  music: ["Music"],
  musical: ["Music"],
  "tv movie": [],
  soap: ["Drama"],
  news: ["News"],
  reality: ["Reality-TV"],
  "reality-tv": ["Reality-TV"],
  talk: ["Talk-Show"],
  "talk-show": ["Talk-Show"],
  "game-show": ["Game-Show"],
  "film-noir": ["Crime", "Mystery"],
  sport: ["Sport"],
  sports: ["Sport"],
};
const CANON = [
  "Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Documentary", "Drama", "Family",
  "Fantasy", "History", "Horror", "Music", "Mystery", "Romance", "Sci-Fi", "Sport", "Thriller", "War",
  "Western", "Reality-TV", "Talk-Show", "Game-Show", "News",
];
const CANON_BY_LC = new Map(CANON.map((g) => [g.toLowerCase(), g]));

// Any mix of catalogue and TMDB genre names -> canonical names, in first-seen
// order. A lumped TMDB bucket ("Sci-Fi & Fantasy") only adds its parts when
// NONE of them is already there: listed after the catalogue's own genres, it
// must not stamp Fantasy on a show IMDb calls plain Sci-Fi.
const canonGenres = (list) => {
  const out = [];
  for (const raw of list || []) {
    const key = String(raw || "").trim().toLowerCase();
    if (!key) continue;
    const parts = GENRE_ALIASES[key] || (CANON_BY_LC.has(key) ? [CANON_BY_LC.get(key)] : []);
    if (parts.length > 1 && parts.some((p) => out.includes(p))) continue;
    for (const p of parts) if (!out.includes(p)) out.push(p);
  }
  return out;
};

// ---------- themes ----------
const THEMES = data.themes;
const byKeyword = new Map(); // exact keyword -> [slug]
const fragments = []; // [fragment, slug]
const plots = []; // [RegExp, slug]
for (const [slug, t] of Object.entries(THEMES)) {
  for (const k of t.kw || []) {
    const key = k.toLowerCase();
    if (!byKeyword.has(key)) byKeyword.set(key, []);
    byKeyword.get(key).push(slug);
  }
  for (const f of t.has || []) fragments.push([f.toLowerCase(), slug]);
  if (t.plot) plots.push([new RegExp(t.plot, "i"), slug]);
}

// Keywords that say nothing about what a title is like: paperwork, production
// facts, ubiquitous places. Never a theme, never a similarity vote.
const STOP = new Set((data.stop || []).map((s) => s.toLowerCase()));

const fragmentCache = new Map();
const slugsForKeyword = (kw) => {
  const exact = byKeyword.get(kw);
  let hit = fragmentCache.get(kw);
  if (hit === undefined) {
    hit = [];
    for (const [f, slug] of fragments) if (kw.includes(f) && !hit.includes(slug)) hit.push(slug);
    if (fragmentCache.size > 20000) fragmentCache.clear();
    fragmentCache.set(kw, hit);
  }
  if (!exact) return hit;
  if (!hit.length) return exact;
  return [...new Set([...exact, ...hit])];
};

// The themes of one title: { slug: weight }. One keyword is weak evidence
// (0.7 — "teacher" on Breaking Bad does not make it a school story), two are
// solid (1.2), three or more settle it (1.5). The synopsis alone weighs 0.4,
// and lifts a single keyword to 1.
const themesOf = ({ keywords = [], overview = "", genres = [] } = {}) => {
  const count = {};
  for (const k of keywords) {
    const kw = String(k || "").toLowerCase();
    if (!kw) continue;
    for (const slug of slugsForKeyword(kw)) count[slug] = (count[slug] || 0) + 1;
  }
  const out = {};
  for (const [slug, n] of Object.entries(count)) out[slug] = n >= 3 ? 1.5 : n === 2 ? 1.2 : 0.7;
  if (overview) {
    for (const [rx, slug] of plots) {
      if (!out[slug] && rx.test(overview)) out[slug] = 0.4;
      else if (out[slug] && out[slug] < 1 && rx.test(overview)) out[slug] = 1;
    }
  }
  // a theme may be barred from a genre it reads wrongly in ("space" keywords
  // on a documentary about NASA are fine; "superhero" on a parody is fine too —
  // only the listed exclusions apply)
  for (const slug of Object.keys(out)) {
    const t = THEMES[slug];
    if (t.notGenres && t.notGenres.some((g) => genres.includes(g))) delete out[slug];
    else if (t.onlyGenres && !t.onlyGenres.some((g) => genres.includes(g))) delete out[slug];
  }
  return out;
};

const themeInfo = (slug) => THEMES[slug] || null;
// "More heists & capers" — the row title for a theme.
const themeTitle = (slug) => {
  const t = THEMES[slug];
  return t ? t.title || t.label || slug : slug;
};
const themeLabel = (slug) => {
  const t = THEMES[slug];
  return t ? t.label || slug.replace(/-/g, " ") : slug;
};

module.exports = {
  canonGenres, themesOf, themeInfo, themeTitle, themeLabel, STOP, CANON,
  THEMES, GROUPS: data.groups,
  _internals: { slugsForKeyword, GENRE_ALIASES },
};

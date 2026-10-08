// Age ratings ("16+", "18+") for the detail page.
//
// TMDB is the only source we have for these: Cinemeta, TVMaze and the Wikipedia
// fallback carry no certification of any kind. It needs a tmdbApiKey in
// config.json — without one every lookup here returns null and nothing calls out
// to the network, so the feature is simply absent rather than broken.
//
// The awkward part is that TMDB returns one certification PER COUNTRY and those
// are not one scale. "16" in Germany, "15" in the UK and "R" in the US are three
// different bodies with three different meanings, so there is no single field to
// read. We want a plain age, so we ask the countries whose systems already ARE
// plain ages first and only fall back to the US letters.
const config = require("../config");

// FSK (Germany) and Kijkwijzer (Netherlands) are bare numbers; BBFC (UK) is too
// once you ignore the trailing letter on "12A". The US comes last because its
// ratings are letters that have to be translated, and translating loses detail.
const COUNTRY_ORDER = ["DE", "NL", "GB", "US"];

// The only two ratings that carry an official age without printing it. Both are
// the rating body's own wording — "R: under 17 requires an accompanying parent",
// "TV-MA: unsuitable for under 17s" — not an equivalence we invented.
const NAMED_AGES = { R: 17, "TV-MA": 17 };

// Everything these bodies use to mean "no age restriction".
const ALL_AGES = new Set(["AL", "U", "UC", "G", "TV-G", "TV-Y", "0", "0+"]);

// "NR" is in TMDB's own published vocabulary for US films, US series and Dutch
// series, and it means the title was never rated. That is the absence of a
// rating rather than a permissive one, so it has to read as nothing and let the
// next country answer — otherwise a US-only title wears a meaningless "NR".
const UNRATED = new Set(["NR", "UNRATED", "NOT RATED", "N/A", "-"]);

// One certification string -> what the badge shows. Anything with a number in it
// is an age, whatever the country wrote around it: "12A" -> 12+, "PG-13" -> 13+,
// "NC-17" -> 17+, "TV-Y7" -> 7+. Ratings with no number and no official age are
// passed through as-is ("PG", "TV-PG") rather than guessed at.
const ageLabel = (certification) => {
  const raw = String(certification || "").trim().toUpperCase();
  if (!raw || UNRATED.has(raw)) return null;
  if (ALL_AGES.has(raw)) return "ALL";
  if (NAMED_AGES[raw]) return `${NAMED_AGES[raw]}+`;
  const digits = raw.match(/\d{1,2}/);
  return digits ? `${Number(digits[0])}+` : raw;
};

// Flatten either TMDB shape into country -> certification. Films come back as
// `release_dates` (a list per country, one entry per theatrical/digital/physical
// release, and the certification is often blank on all but one of them); series
// come back as `content_ratings` with a single `rating` per country.
const byCountry = (results, kind) => {
  const found = new Map();
  for (const entry of results || []) {
    if (!entry || !entry.iso_3166_1) continue;
    const certification =
      kind === "show"
        ? entry.rating
        : (entry.release_dates || [])
            .map((r) => r && r.certification)
            .find((c) => String(c || "").trim());
    if (String(certification || "").trim()) {
      found.set(entry.iso_3166_1, String(certification).trim());
    }
  }
  return found;
};

// First country in COUNTRY_ORDER that actually rated this title wins, so a film
// with no German release still gets a number off the Dutch or UK board.
const pickCertificate = (results, kind) => {
  const found = byCountry(results, kind);
  for (const country of COUNTRY_ORDER) {
    const label = ageLabel(found.get(country));
    if (label) return label;
  }
  return null;
};

// ---------- the strictest age, for kids profiles ----------
// The badge above answers "what does ONE board say" and asks Germany first.
// That is the wrong question for a kids profile: the FSK is lenient (it passed
// Oppenheimer, Dune: Part Two, Troy and The Shawshank Redemption at 12), so a
// 12+ profile was offered all four. The kids gate asks the opposite question —
// "what is the OLDEST age any board we trust put on this?" — and takes the
// maximum across the countries below. Each has a real, enforced rating system
// whose labels are either an age or map to one without guessing.
const STRICT_COUNTRIES = ["US", "GB", "DE", "NL", "FR", "AU", "CA", "ES", "IT", "BR", "IE", "NZ"];

// "Parental guidance" has no number in any system. 8 is the BBFC's own wording
// ("should not unsettle a child aged around eight or older") and is what
// lib/kids.js has always read PG as: outside the 0 and 7 limits, inside 12.
const PG_AGE = 8;

// Labels that carry no digits, per country. A label that is in neither table
// and has no digits in it is NOT guessed at — it contributes nothing.
const WORD_AGES = {
  // MPA films + US TV Parental Guidelines. R / TV-MA: "under 17" in the
  // bodies' own words. (PG-13, TV-14, TV-Y7, NC-17 are read off their digits.)
  US: { G: 0, "TV-G": 0, "TV-Y": 0, PG: PG_AGE, "TV-PG": PG_AGE, R: 17, "TV-MA": 17 },
  // BBFC. (12, 12A, 15, 18, R18 by digits.)
  GB: { U: 0, UC: 0, PG: PG_AGE },
  // FSK is all digits (0, 6, 12, 16, 18).
  DE: {},
  // Kijkwijzer: AL = alle leeftijden.
  NL: { AL: 0 },
  // CNC: U / TP = tous publics.
  FR: { U: 0, TP: 0 },
  // Australian Classification. M is ADVISORY ("recommended for mature
  // audiences", 15 and over) — not enforced, but it is the board saying "not
  // for under 15", so it counts as 15, the same number as the enforced MA15+.
  // P / C are the children's TV bands. RC = refused classification. E (exempt)
  // says nothing. (MA15+, AV15+, R18+, X18+ by digits.)
  AU: { G: 0, P: 0, C: 0, PG: PG_AGE, M: 15, RC: 18 },
  // Canadian Home Video ratings + TV. Here R and A are both 18-and-over —
  // NOT the American R. (14A, 18A, C8, 14+, 18+, Québec's 13+/16+ by digits.)
  CA: { G: 0, C: 0, PG: PG_AGE, R: 18, A: 18 },
  // ICAA: A / APTA / TP = for everyone, X = adults only. "Infantil" and ERI
  // are the made-for-children marks.
  ES: { A: 0, APTA: 0, TP: 0, INFANTIL: 0, ERI: 0, X: 18 },
  // Italy: T = per tutti; BA = "bambini accompagnati", the TV guidance mark.
  // (VM14, VM18, 6+, 14+, 18+ by digits.)
  IT: { T: 0, BA: PG_AGE },
  // ClassInd: L = livre.
  BR: { L: 0, AL: 0 },
  // IFCO. (12A, 15A, 16, 18 by digits.)
  IE: { G: 0, PG: PG_AGE },
  // New Zealand: M is advisory at 16 ("suitable for mature audiences 16 years
  // and over"); a bare R is "restricted to a specified audience" — read as 18.
  // (R13, R15, R16, R18, RP13, RP16 by digits.)
  NZ: { G: 0, PG: PG_AGE, M: 16, R: 18 },
};

// One country's label -> the youngest age that country rated the title for,
// or null when the label says nothing we can stand on.
const countryAge = (country, certification) => {
  const words = WORD_AGES[country];
  if (!words) return null; // not a country we take ratings from
  const raw = String(certification == null ? "" : certification).trim().toUpperCase();
  if (!raw || UNRATED.has(raw)) return null;
  if (Object.prototype.hasOwnProperty.call(words, raw)) return words[raw];
  const digits = raw.match(/\d{1,2}/);
  if (!digits) return null;
  const age = Number(digits[0]);
  return age <= 21 ? age : null; // "99" is somebody's typo, not a rating
};

// country -> label (a Map, or a plain object in tests) -> the strictest age
// across STRICT_COUNTRIES, or null when none of them rated it.
const strictestOf = (found) => {
  const get = found instanceof Map ? (c) => found.get(c) : (c) => (found || {})[c];
  let max = null;
  for (const country of STRICT_COUNTRIES) {
    const age = countryAge(country, get(country));
    if (age != null && (max == null || age > max)) max = age;
  }
  return max;
};

// The same, straight from a TMDB answer.
const strictestAge = (results, kind) => strictestOf(byCountry(results, kind));

// Cinemeta already hands us the TMDB id as `moviedb_id`, so this is one request
// with no search or id-matching guesswork behind it. A rating is decoration on a
// page that has to render regardless, so every failure here is a null: no key,
// no id, a 404, a timeout, a shape we didn't expect.
//   { certificate, kidsAge } — the badge ("12+", first country in
//   COUNTRY_ORDER) and the kids gate's number (strictest of STRICT_COUNTRIES).
// Two answers from the one request. They are kept apart on purpose: the badge
// is the household's familiar scale and stays what it was; only the kids gate
// reads the strict one.
const NOTHING = Object.freeze({ certificate: null, kidsAge: null });
const fetchCertificates = async (kind, tmdbId) => {
  if (!config.TMDB_KEY || !tmdbId) return NOTHING;
  const endpoint =
    kind === "show"
      ? `tv/${tmdbId}/content_ratings`
      : `movie/${tmdbId}/release_dates`;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/${endpoint}?api_key=${config.TMDB_KEY}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return NOTHING;
    const results = (await res.json()).results;
    return { certificate: pickCertificate(results, kind), kidsAge: strictestAge(results, kind) };
  } catch {
    return NOTHING;
  }
};
const fetchCertificate = async (kind, tmdbId) => (await fetchCertificates(kind, tmdbId)).certificate;

// The title's original language (ISO 639-1: "en", "he", "ja") from TMDB's
// details — the one fact that says which audio track of a multi-dub file is
// the real one. Null without a TMDB key or id.
const fetchOriginalLanguage = async (kind, tmdbId) => {
  if (!config.TMDB_KEY || !tmdbId) return null;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/${kind === "show" ? "tv" : "movie"}/${tmdbId}?api_key=${config.TMDB_KEY}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return null;
    const lang = (await res.json()).original_language;
    return typeof lang === "string" && /^[a-z]{2}$/.test(lang) ? lang : null;
  } catch {
    return null;
  }
};

module.exports = {
  fetchCertificate, fetchCertificates, fetchOriginalLanguage, ageLabel, pickCertificate, COUNTRY_ORDER,
  STRICT_COUNTRIES, countryAge, strictestOf, strictestAge,
};

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

// Cinemeta already hands us the TMDB id as `moviedb_id`, so this is one request
// with no search or id-matching guesswork behind it. A rating is decoration on a
// page that has to render regardless, so every failure here is a null: no key,
// no id, a 404, a timeout, a shape we didn't expect.
const fetchCertificate = async (kind, tmdbId) => {
  if (!config.TMDB_KEY || !tmdbId) return null;
  const endpoint =
    kind === "show"
      ? `tv/${tmdbId}/content_ratings`
      : `movie/${tmdbId}/release_dates`;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/${endpoint}?api_key=${config.TMDB_KEY}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return null;
    return pickCertificate((await res.json()).results, kind);
  } catch {
    return null;
  }
};

module.exports = { fetchCertificate, ageLabel, pickCertificate, COUNTRY_ORDER };

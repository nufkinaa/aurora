// Age ratings. TMDB returns one certification per country and they are not one
// scale, so all the risk in this feature is in choosing which country to read
// and turning its answer into an age. That is what these cover.
const test = require("node:test");
const assert = require("node:assert");

const { ageLabel, pickCertificate } = require("../src/media/certification");

// ---------- one certification -> one badge ----------

test("a bare number is an age", () => {
  // FSK (Germany) and Kijkwijzer (Netherlands) print nothing else.
  assert.strictEqual(ageLabel("16"), "16+");
  assert.strictEqual(ageLabel("12"), "12+");
  assert.strictEqual(ageLabel("9"), "9+");
});

test("a number buried in letters is still the age", () => {
  // The whole point of reading digits rather than keeping a table per country:
  // every one of these means "this many years old" in its own system.
  assert.strictEqual(ageLabel("12A"), "12+"); // BBFC, cinema-only variant
  assert.strictEqual(ageLabel("PG-13"), "13+"); // MPA
  assert.strictEqual(ageLabel("NC-17"), "17+"); // MPA
  assert.strictEqual(ageLabel("TV-14"), "14+"); // US TV
  assert.strictEqual(ageLabel("TV-Y7"), "7+"); // US TV
  assert.strictEqual(ageLabel("R18"), "18+"); // BBFC
});

test("R and TV-MA carry an age their name doesn't print", () => {
  assert.strictEqual(ageLabel("R"), "17+");
  assert.strictEqual(ageLabel("TV-MA"), "17+");
});

test("every body's word for unrestricted comes out the same", () => {
  for (const raw of ["AL", "U", "G", "TV-G", "TV-Y", "0"]) {
    assert.strictEqual(ageLabel(raw), "ALL", `${raw} should be ALL`);
  }
});

test("a rating with no age is shown as it is, not guessed at", () => {
  // "Parental guidance" is not an age and inventing one for it would be a lie.
  assert.strictEqual(ageLabel("PG"), "PG");
  assert.strictEqual(ageLabel("TV-PG"), "TV-PG");
});

test("not-rated reads as no rating, not as a rating called NR", () => {
  // "NR" is in TMDB's published list for US films, US series and Dutch series,
  // and it leaked out as a literal "NR" badge until this existed.
  for (const raw of ["NR", "Unrated", "not rated", "N/A"]) {
    assert.strictEqual(ageLabel(raw), null, `${raw} should be nothing`);
  }
});

test("nothing in, nothing out", () => {
  for (const empty of [null, undefined, "", "   "]) {
    assert.strictEqual(ageLabel(empty), null);
  }
});

test("every certification these four countries can issue lands somewhere sane", () => {
  // Taken verbatim from TMDB's /certification/{movie,tv}/list for the countries
  // in COUNTRY_ORDER, so this fails the day we meet a value we never handled
  // rather than the day one reaches a badge.
  const official = {
    DE: ["0", "6", "12", "16", "18"],
    NL: ["AL", "6", "9", "12", "14", "16", "18", "NR"],
    GB: ["U", "PG", "12A", "12", "15", "18", "R18"],
    US: ["G", "PG", "PG-13", "R", "NC-17", "NR",
         "TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"],
  };
  const expected = {
    "0": "ALL", "6": "6+", "9": "9+", "12": "12+", "14": "14+", "15": "15+",
    "16": "16+", "18": "18+", AL: "ALL", NR: null, U: "ALL", PG: "PG",
    "12A": "12+", R18: "18+", G: "ALL", "PG-13": "13+", R: "17+",
    "NC-17": "17+", "TV-Y": "ALL", "TV-Y7": "7+", "TV-G": "ALL",
    "TV-PG": "TV-PG", "TV-14": "14+", "TV-MA": "17+",
  };
  for (const [country, list] of Object.entries(official)) {
    for (const raw of list) {
      assert.strictEqual(ageLabel(raw), expected[raw], `${country} "${raw}"`);
    }
  }
});

// ---------- choosing a country ----------

const tvResults = (map) =>
  Object.entries(map).map(([iso_3166_1, rating]) => ({ iso_3166_1, rating }));

const movieResults = (map) =>
  Object.entries(map).map(([iso_3166_1, certs]) => ({
    iso_3166_1,
    release_dates: (Array.isArray(certs) ? certs : [certs]).map((certification) => ({
      certification,
    })),
  }));

test("a plain-age country beats the US even when both rated it", () => {
  // The reason the order exists: this title has both, and "16+" is the answer
  // we want rather than "17+" translated out of an MPA letter.
  assert.strictEqual(
    pickCertificate(movieResults({ US: "R", DE: "16" }), "movie"),
    "16+",
  );
  assert.strictEqual(
    pickCertificate(tvResults({ US: "TV-MA", DE: "16" }), "show"),
    "16+",
  );
});

test("a title with no German release falls through to the next board", () => {
  assert.strictEqual(pickCertificate(movieResults({ US: "R", NL: "12" }), "movie"), "12+");
  assert.strictEqual(pickCertificate(movieResults({ US: "R", GB: "15" }), "movie"), "15+");
  assert.strictEqual(pickCertificate(movieResults({ US: "R" }), "movie"), "17+");
});

test("a country that answered NR is passed over like one that didn't answer", () => {
  // Measured on real data: US says NR for a lot of foreign-language films that
  // Germany rated properly, so this decides the badge on those titles.
  assert.strictEqual(pickCertificate(movieResults({ US: "NR", DE: "12" }), "movie"), "12+");
  assert.strictEqual(pickCertificate(movieResults({ US: "NR" }), "movie"), null);
  assert.strictEqual(pickCertificate(tvResults({ NL: "NR", GB: "15" }), "show"), "15+");
});

test("countries we don't read are ignored rather than picked at random", () => {
  assert.strictEqual(pickCertificate(movieResults({ FR: "12", JP: "G" }), "movie"), null);
});

test("a country listed with a blank certification is skipped, not returned empty", () => {
  // Real TMDB shape: a country appears in `results` because it has a release
  // date, with no certification attached to it at all.
  assert.strictEqual(
    pickCertificate(movieResults({ DE: "", US: "R" }), "movie"),
    "17+",
  );
});

test("the certification is found whichever release carries it", () => {
  // Films list theatrical, digital and physical releases separately and usually
  // only one of them is rated.
  assert.strictEqual(
    pickCertificate(movieResults({ DE: ["", "", "16"] }), "movie"),
    "16+",
  );
});

test("an unrated title gives nothing rather than an empty badge", () => {
  assert.strictEqual(pickCertificate([], "movie"), null);
  assert.strictEqual(pickCertificate(undefined, "show"), null);
  assert.strictEqual(pickCertificate([{}, { iso_3166_1: "DE" }], "show"), null);
});

// ---------- the strictest age across countries (kids profiles) ----------
// The badge above reads ONE country, Germany first — and the FSK passed
// Oppenheimer, Dune: Part Two, Troy and The Shawshank Redemption at 12. The
// kids gate reads the oldest age any trusted board gave instead.

const { countryAge, strictestOf, strictestAge, STRICT_COUNTRIES } = require("../src/media/certification");

test("each system's labels map to an age", () => {
  for (const [country, label, age] of [
    // United States — films and TV
    ["US", "G", 0], ["US", "PG", 8], ["US", "PG-13", 13], ["US", "R", 17], ["US", "NC-17", 17],
    ["US", "TV-Y", 0], ["US", "TV-Y7", 7], ["US", "TV-G", 0], ["US", "TV-PG", 8], ["US", "TV-14", 14], ["US", "TV-MA", 17],
    // United Kingdom
    ["GB", "U", 0], ["GB", "PG", 8], ["GB", "12", 12], ["GB", "12A", 12], ["GB", "15", 15], ["GB", "18", 18], ["GB", "R18", 18],
    // Germany, the Netherlands, France
    ["DE", "0", 0], ["DE", "6", 6], ["DE", "12", 12], ["DE", "16", 16], ["DE", "18", 18],
    ["NL", "AL", 0], ["NL", "6", 6], ["NL", "9", 9], ["NL", "14", 14], ["NL", "16", 16],
    ["FR", "U", 0], ["FR", "TP", 0], ["FR", "10", 10], ["FR", "12", 12], ["FR", "16", 16],
    // Australia: M is advisory, read as 15 like the enforced MA15+
    ["AU", "G", 0], ["AU", "PG", 8], ["AU", "M", 15], ["AU", "MA15+", 15], ["AU", "MA 15+", 15], ["AU", "R18+", 18], ["AU", "R 18+", 18], ["AU", "X18+", 18], ["AU", "RC", 18],
    // Canada: R and A are 18 here, not the American 17
    ["CA", "G", 0], ["CA", "PG", 8], ["CA", "14A", 14], ["CA", "18A", 18], ["CA", "R", 18], ["CA", "A", 18], ["CA", "C8", 8], ["CA", "14+", 14], ["CA", "13+", 13],
    // Spain, Italy, Brazil
    ["ES", "A", 0], ["ES", "APTA", 0], ["ES", "TP", 0], ["ES", "7", 7], ["ES", "12", 12], ["ES", "16", 16], ["ES", "18", 18], ["ES", "X", 18],
    ["IT", "T", 0], ["IT", "VM14", 14], ["IT", "VM18", 18], ["IT", "6+", 6],
    ["BR", "L", 0], ["BR", "10", 10], ["BR", "14", 14], ["BR", "18", 18],
    // Ireland, New Zealand
    ["IE", "G", 0], ["IE", "PG", 8], ["IE", "12A", 12], ["IE", "15A", 15], ["IE", "16", 16],
    ["NZ", "G", 0], ["NZ", "PG", 8], ["NZ", "M", 16], ["NZ", "R13", 13], ["NZ", "R16", 16], ["NZ", "RP16", 16], ["NZ", "R18", 18],
    // case and stray spaces don't matter
    ["US", " pg-13 ", 13], ["GB", "12a", 12],
  ]) assert.strictEqual(countryAge(country, label), age, `${country} ${label}`);
});

test("the same letter means different ages in different countries", () => {
  assert.strictEqual(countryAge("US", "R"), 17);
  assert.strictEqual(countryAge("CA", "R"), 18);
  assert.strictEqual(countryAge("NZ", "R"), 18);
  assert.strictEqual(countryAge("ES", "A"), 0, "Spain: apta para todos");
  assert.strictEqual(countryAge("CA", "A"), 18, "Canada: adult");
  assert.strictEqual(countryAge("AU", "M"), 15);
  assert.strictEqual(countryAge("NZ", "M"), 16);
});

test("empty, unrated and unknown labels say nothing — and neither does an unknown country", () => {
  for (const label of ["", "  ", null, undefined, "NR", "Unrated", "Not Rated", "N/A", "-", "banana", "E", "Exempt", "99"])
    assert.strictEqual(countryAge("US", label), null, `US ${label}`);
  assert.strictEqual(countryAge("AU", "E"), null, "exempt from classification is not a rating");
  assert.strictEqual(countryAge("DE", "M"), null, "a letter Germany doesn't use");
  assert.strictEqual(countryAge("JP", "R18+"), null, "not a country we take ratings from");
  assert.strictEqual(countryAge("KR", "18"), null);
  assert.strictEqual(countryAge(undefined, "12"), null);
});

test("the strictest country decides", () => {
  assert.strictEqual(strictestOf({ US: "R", GB: "15", DE: "12" }), 17);
  assert.strictEqual(strictestOf({ DE: "12" }), 12, "one board: that board");
  assert.strictEqual(strictestOf({ DE: "0", GB: "U", US: "G" }), 0);
  assert.strictEqual(strictestOf({ DE: "6", US: "PG" }), 8);
  assert.strictEqual(strictestOf({ DE: "16", US: "TV-14", GB: "15" }), 16);
  assert.strictEqual(strictestOf(new Map([["GB", "12A"], ["AU", "MA15+"]])), 15, "a Map works too");
});

test("unrated and untrusted countries never raise or lower the answer", () => {
  assert.strictEqual(strictestOf({ US: "NR", DE: "6" }), 6, "NR is no rating, not a strict one");
  assert.strictEqual(strictestOf({ US: "", GB: "PG" }), 8);
  assert.strictEqual(strictestOf({ JP: "R18+", KR: "18", RU: "18+", DE: "6" }), 6, "only the listed systems count");
  assert.strictEqual(strictestOf({ JP: "G", KR: "ALL" }), null, "nobody we trust rated it");
  assert.strictEqual(strictestOf({}), null);
  assert.strictEqual(strictestOf(null), null);
  assert.strictEqual(strictestOf({ US: "NR", GB: "Unrated" }), null);
});

// The four films a 12+ kids profile was offered on FSK 12 alone, with the
// certificates TMDB lists for them.
const FOUR = {
  "Oppenheimer": { US: "R", GB: "15", DE: "12", NL: "16", FR: "U", AU: "MA15+", CA: "14A", ES: "16", BR: "16", IE: "15A" },
  "Dune: Part Two": { US: "PG-13", GB: "12A", DE: "12", NL: "12", FR: "U", AU: "M", CA: "PG", ES: "12", BR: "14", IE: "12A" },
  "Troy": { US: "R", GB: "15", DE: "12", NL: "16", FR: "U", AU: "MA15+", CA: "14A", BR: "14" },
  "The Shawshank Redemption": { US: "R", GB: "15", DE: "12", NL: "16", FR: "U", AU: "MA15+", CA: "14A", BR: "16" },
};

test("Oppenheimer, Dune: Part Two, Troy, Shawshank: FSK 12 on the badge, 15–17 for the kids gate", () => {
  const want = { "Oppenheimer": 17, "Dune: Part Two": 15, "Troy": 17, "The Shawshank Redemption": 17 };
  for (const [title, certs] of Object.entries(FOUR)) {
    const results = movieResults(certs);
    assert.strictEqual(pickCertificate(results, "movie"), "12+", `${title}: the badge is unchanged`);
    assert.strictEqual(strictestAge(results, "movie"), want[title], title);
    assert.ok(strictestAge(results, "movie") > 12, `${title} is out of a 12+ profile`);
  }
});

test("strictestAge reads both TMDB shapes, whichever release carries the certificate", () => {
  assert.strictEqual(strictestAge(tvResults({ US: "TV-MA", DE: "16", GB: "15" }), "show"), 17);
  assert.strictEqual(strictestAge(tvResults({ US: "TV-Y7", DE: "6" }), "show"), 7);
  assert.strictEqual(strictestAge(movieResults({ US: ["", "", "R"], DE: ["12", ""] }), "movie"), 17);
  assert.strictEqual(strictestAge([], "movie"), null);
  assert.strictEqual(strictestAge(undefined, "show"), null);
});

test("every country the badge reads is one the kids gate reads too", () => {
  // otherwise a title could carry a badge and still have no strict age
  for (const c of require("../src/media/certification").COUNTRY_ORDER) assert.ok(STRICT_COUNTRIES.includes(c), c);
});

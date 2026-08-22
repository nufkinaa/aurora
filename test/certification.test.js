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

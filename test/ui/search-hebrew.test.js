// Search in Hebrew and with typos, in the real Search screen: the official
// Hebrew name, the English title spelled in Hebrew letters, the wrong keyboard
// layout and an English typo each put the title meant first — in the results
// and in the dropdown while typing — at desktop and phone sizes (the website
// asks the same server search as the TV and the phone app).
//
// The instance is offline: the catalogue it knows is seeded where the server
// keeps the well-known titles (cache/search-known.json) and the official
// Hebrew names (cache/search-he.json, what media/hetitles.js learns from TMDB).
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, PHONE } = require("./helpers");

const now = Date.now();
const known = (imdbId, type, title, year, k, genres = ["Drama"]) =>
  ({ imdbId, type, title, year, poster: `https://images.example/${imdbId}.jpg`, rating: 7.5, genres, cast: [], director: [], k });
const KNOWN = [
  known("tt0903747", "show", "Breaking Bad", 2008, 23, ["Crime", "Drama"]),
  known("tt0108778", "show", "Friends", 1994, 64, ["Comedy"]),
  known("tt1632708", "movie", "Friends with Benefits", 2011, 1811, ["Comedy", "Romance"]),
  known("tt0241527", "movie", "Harry Potter and the Sorcerer's Stone", 2001, 90, ["Fantasy"]),
  known("tt0330373", "movie", "Harry Potter and the Goblet of Fire", 2005, 327, ["Fantasy"]),
  known("tt0145487", "movie", "Spider-Man", 2002, 340, ["Action"]),
  known("tt0316654", "movie", "Spider-Man 2", 2004, 1014, ["Action"]),
  known("tt0126029", "movie", "Shrek", 2001, 605, ["Animation", "Comedy"]),
  known("tt0307453", "movie", "Shark Tale", 2004, 2435, ["Animation", "Comedy"]),
  known("tt0816692", "movie", "Interstellar", 2014, 102, ["Sci-Fi"]),
  known("tt0133093", "movie", "The Matrix", 1999, 181, ["Sci-Fi", "Action"]),
  known("tt0234215", "movie", "The Matrix Reloaded", 2003, 1117, ["Sci-Fi", "Action"]),
];
const HE = {
  tt0903747: "שובר שורות",
  tt0108778: "חברים",
  tt0241527: "הארי פוטר ואבן החכמים",
  tt0330373: "הארי פוטר וגביע האש",
  tt0145487: "ספיידרמן",
  tt0316654: "ספיידרמן 2",
  tt0126029: "שרק",
  tt0816692: "בין כוכבים",
  tt0133093: "מטריקס",
};

const ui = suite({
  server: {
    seed: {
      "cache/search-known.json": { v: 1, at: now, tried: now, titles: KNOWN },
      "cache/search-he.json": { v: 1, titles: Object.fromEntries(Object.entries(HE).map(([id, he]) => [id, { he, at: now }])), miss: {} },
    },
  },
});

const SHOTS = process.env.SH_SHOTS || path.join(os.tmpdir(), "aurora-agents", "search-hebrew", "shots");
const shot = async (page, name) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // (for the eye only: the cards' fade-in and their poster-less labels drawn)
  await page.waitForFunction(() => { const b = document.querySelector("#app .search-busy"); return !b || b.classList.contains("hidden"); }, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const BOX = '.screen input[type="search"]';
const firstCard = (page, want) =>
  page.waitForFunction((w) => {
    const c = document.querySelector("#app .screen > .grid .card");
    return c && (c.getAttribute("aria-label") || "").split(",")[0] === w;
  }, want, { timeout: 15000 });
const cards = (page) => page.evaluate(() => [...document.querySelectorAll("#app .screen > .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0]));
const firstSuggestion = (page, want) =>
  page.waitForFunction((w) => {
    const r = document.querySelector("#app .suggest-list:not(.hidden) .suggest-item .suggest-title");
    return r && r.textContent === w;
  }, want, { timeout: 15000 });

// what a person types → the first card
const TABLE = [
  ["שובר שורות", "Breaking Bad"], // the official Hebrew name
  ["חברים", "Friends"],
  ["בין כוכבים", "Interstellar"],
  ["פרנדס", "Friends"], // the English title in Hebrew letters
  ["בריקינג בד", "Breaking Bad"],
  ["ספיידרמן", "Spider-Man"],
  ["שרק", "Shrek"],
  ["מטריקס", "The Matrix"],
  ["vtrh puyr", "Harry Potter and the Sorcerer's Stone"], // Hebrew keys, English layout
  ["ןמאקרדאקךךשר", "Interstellar"], // English keys, Hebrew layout
  ["brekaing bad", "Breaking Bad"], // English typos
  ["interstelar", "Interstellar"],
];

for (const [label, viewport] of [["desktop", undefined], ["phone", PHONE]]) {
  ui.test(`${label}: Hebrew, the wrong layout and typos put the title meant first — typed letter by letter`, viewport ? { viewport } : {}, async ({ page, goto, signIn, freshProfile }) => {
    await signIn(await freshProfile());
    await goto("#/search");
    const box = page.locator(BOX);
    for (const [q, want] of TABLE) {
      await box.fill("");
      await box.pressSequentially(q, { delay: 15 });
      await firstSuggestion(page, want); // the dropdown while typing
      await box.press("Enter"); // …and the committed search
      await firstCard(page, want);
      assert.equal(await page.inputValue(BOX), q, "the field keeps what was typed");
    }
    // half typed Hebrew: the start of the title
    await box.fill("");
    await box.pressSequentially("הארי פו", { delay: 15 });
    await firstSuggestion(page, "Harry Potter and the Sorcerer's Stone");
    await box.press("Enter");
    await firstCard(page, "Harry Potter and the Sorcerer's Stone");
    const hp = await cards(page);
    assert.ok(hp.slice(0, 2).every((t) => t.startsWith("Harry Potter")), JSON.stringify(hp));
    await shot(page, `${label}-hebrew-harry-potter`);
    // the official name exactly: the one title first, the sequel after it
    await box.fill("");
    await box.pressSequentially("ספיידרמן", { delay: 15 });
    await box.press("Enter");
    await firstCard(page, "Spider-Man");
    assert.deepEqual((await cards(page)).slice(0, 2), ["Spider-Man", "Spider-Man 2"]);
    await shot(page, `${label}-hebrew-spiderman`);
    // the dropdown, open, for a screenshot
    await box.fill("");
    await box.pressSequentially("פרנדס", { delay: 15 });
    await firstSuggestion(page, "Friends");
    await shot(page, `${label}-hebrew-suggest`);
  });
}

ui.run();

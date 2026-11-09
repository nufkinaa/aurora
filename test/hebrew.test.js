// media/hebrew.js: Hebrew letters → sounds, keyboard layouts, folding.
// Pure functions, no fixtures.
const test = require("node:test");
const assert = require("node:assert/strict");

const heb = require("../src/media/hebrew");
const { SOUND_WHOLE, SOUND_START, SOUND_WORD, SOUND_SLIP } = heb.TIERS;

const words = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const tier = (q, title) => heb.soundTier(heb.hebrewKey(q), heb.englishKey(words(title)));

test("fold: vowel points, geresh and the maqaf go; final letters fold", () => {
  assert.equal(heb.fold("שָׁלוֹם"), "שלומ");
  assert.equal(heb.fold("ג׳וקר"), "גוקר");
  assert.equal(heb.fold("ספיידרמן"), "ספיידרמנ");
  assert.equal(heb.fold("בית־הנייר"), "בית הנייר");
  assert.equal(heb.fold("Dune 2021"), "Dune 2021");
});

test("an English title spelled in Hebrew letters is the title, sound for sound", () => {
  for (const [q, title] of [
    ["פרנדס", "Friends"], ["בריקינג בד", "Breaking Bad"], ["שרק", "Shrek"], ["מטריקס", "The Matrix"],
    ["אווטאר", "Avatar"], ["ספיידרמן", "Spider-Man"], ["ספיידר מן", "Spider-Man"], ["אינטרסטלר", "Interstellar"],
    ["גיים אוף תרונס", "Game of Thrones"], ["סטריינג'ר תינגס", "Stranger Things"], ["ג'ון וויק", "John Wick"],
    ["אוונג'רס", "The Avengers"], ["פאודה", "Fauda"], ["שמיגדון", "Schmigadoon!"], ["טוי סטורי 3", "Toy Story 3"],
    ["ג'ורסיק פארק", "Jurassic Park"], ["אופנהיימר", "Oppenheimer"], ["ההוביט", "The Hobbit"],
  ]) assert.equal(tier(q, title), SOUND_WHOLE, `${q} → ${title}`);
});

test("the ambiguous letters: ו, י, כ/ק, ש, צ, ח, א/ע, and the missing vowels", () => {
  assert.equal(tier("ונדטה", "Vendetta"), SOUND_WHOLE); // ו at the start: v
  assert.equal(tier("רובוקופ", "RoboCop"), SOUND_WHOLE); // ו inside: a vowel
  assert.equal(tier("וולברין", "Wolverine"), SOUND_WHOLE); // וו: w/v
  assert.equal(tier("יסטרדיי", "Yesterday"), SOUND_WHOLE); // י at the start: y
  assert.equal(tier("קינג קונג", "King Kong"), SOUND_WHOLE); // ק = k
  assert.equal(tier("כריסטמס", "Christmas"), SOUND_WHOLE); // כ = the k of "ch"
  assert.equal(tier("סקרים", "Scream"), SOUND_WHOLE); // ס, and "sc" is s+k
  assert.equal(tier("שרלוק", "Sherlock"), SOUND_WHOLE); // ש = sh
  assert.equal(tier("סמפסון", "Sampson"), SOUND_WHOLE); // …ס = s
  assert.equal(tier("פיצה", "Pizza"), SOUND_WHOLE); // צ = tz/zz
  assert.equal(tier("צ'אקי", "Chucky"), SOUND_WHOLE); // צ' = ch
  assert.equal(tier("חנוכה", "Hanukkah"), SOUND_WHOLE); // ח = h
  assert.equal(tier("אמלי", "Amelie"), SOUND_WHOLE); // א: a vowel
  assert.equal(tier("אינספשן", "Inception"), SOUND_WHOLE); // "tion" is "shn"
  assert.equal(tier("פרוזן", "Frozen"), SOUND_WHOLE); // פ = f
  assert.equal(tier("ג'וקר", "Joker"), SOUND_WHOLE); // ג' = j
});

test("half typed is the start of the title; a later word counts less; a slip less again", () => {
  assert.equal(tier("ספייד", "Spider-Man"), SOUND_START);
  assert.equal(tier("הארי פו", "Harry Potter and the Goblet of Fire"), SOUND_START);
  assert.equal(tier("פוטר", "Harry Potter and the Goblet of Fire"), SOUND_WORD);
  assert.equal(tier("ספיידרמאן", "Spider-Man"), SOUND_WHOLE); // (an extra א is a vowel)
  assert.equal(tier("ונסדיי", "Wednesday"), SOUND_SLIP); // the silent d
  assert.equal(tier("ווקינג דד", "The Walking Dead"), SOUND_SLIP); // the silent l
});

test("short Hebrew words do not match everything that shares their consonants", () => {
  assert.equal(tier("שרק", "Sherlock"), 0);
  assert.equal(tier("מטריקס", "Metropolis"), 0);
  assert.equal(tier("שרק", "Shark Tale"), SOUND_START); // (starts the same — ranked under Shrek by popularity)
  assert.equal(tier("אב", "Up"), 0); // two letters, one sound: nothing
  assert.equal(heb.hebrewKey("א"), null);
  assert.equal(heb.hebrewKey("harry"), null);
});

test("the other keyboard layout, both ways", () => {
  assert.equal(heb.latinToHebrew("vtrh puyr"), "הארי פוטר");
  assert.equal(heb.latinToHebrew("aucr auru,"), "שובר שורות");
  assert.equal(heb.latinToHebrew("xphhsrni"), "ספיידרמן");
  assert.equal(heb.hebrewToLatin("ןמאקרדאקךךשר"), "interstellar");
  assert.equal(heb.hebrewToLatin("נרקשלןמע נשג"), "breaking bad");
  // English written on purpose is not a layout slip
  assert.equal(heb.latinToHebrew("Dune 2021"), null);
  assert.equal(heb.latinToHebrew("ab"), null);
  assert.equal(heb.hebrewToLatin("ג'וקר"), null);
});

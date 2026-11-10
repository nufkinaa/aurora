// The Aurora Play kit's pure parts (public/js/play/*.js): the odometer's
// wheels, the tilt, the meteor shower's starting set, the share card's line
// breaking and fitting, the easings.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const load = (f) => import(pathToFileURL(path.join(ROOT, "public/js/play", f)).href);

test("odometer: every digit gets a wheel, the units spin the most, other characters stand still", async () => {
  const { wheelPlan } = await load("count.js");
  assert.deepEqual(wheelPlan("136", 2), [{ digit: 1, steps: 1 }, { digit: 3, steps: 13 }, { digit: 6, steps: 26 }]);
  assert.deepEqual(wheelPlan("3:41", 2), [{ digit: 3, steps: 3 }, { char: ":" }, { digit: 4, steps: 14 }, { digit: 1, steps: 21 }]);
  assert.deepEqual(wheelPlan("1,204", 1).map((p) => p.steps ?? p.char), [1, ",", 2, 0, 14]);
  assert.deepEqual(wheelPlan("0", 2), [{ digit: 0, steps: 20 }]);
  assert.deepEqual(wheelPlan("", 2), []);
  assert.deepEqual(wheelPlan("12h", 0), [{ digit: 1, steps: 1 }, { digit: 2, steps: 2 }, { char: "h" }]);
});

test("tilt: the pointer's place over the card -> the turn and the sheen's place", async () => {
  const { tiltFrom } = await load("tilt.js");
  const rect = { left: 100, top: 50, width: 200, height: 280 };
  assert.deepEqual(tiltFrom(200, 190, rect, 14), { rx: 0, ry: 0, mx: 0.5, my: 0.5 });
  const tr = tiltFrom(300, 50, rect, 14); // top-right corner
  assert.equal(tr.ry, 14);
  assert.equal(tr.rx, 14);
  const bl = tiltFrom(100, 330, rect, 10);
  assert.equal(bl.ry, -10);
  assert.equal(bl.rx, -10);
  // outside the card: held to its edge
  assert.deepEqual(tiltFrom(-500, 9999, rect, 10), { rx: -10, ry: -10, mx: 0, my: 1 });
});

test("meteor burst: the same seed throws the same shower, spread round the circle", async () => {
  const { meteors } = await load("burst.js");
  const a = meteors(40, 7);
  assert.equal(a.length, 40);
  assert.deepEqual(a, meteors(40, 7));
  assert.notDeepEqual(a, meteors(40, 8));
  for (const m of a) {
    assert.ok(m.speed > 0 && m.life > 0 && m.size > 0 && m.tail > 0);
    assert.ok(m.color >= 0 && m.color < 4);
  }
  // no quarter of the circle is empty
  const quarters = new Set(a.map((m) => Math.floor((((m.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2))));
  assert.equal(quarters.size, 4);
});

test("share card: lines wrap at the width, the last says … when there is more, a long word is cut", async () => {
  const { wrapLines, fitSize } = await load("sharecard.js");
  const measure = (s) => s.length * 10; // 10 px a character
  assert.deepEqual(wrapLines(measure, "Northern Static", 300, 2), ["Northern Static"]);
  assert.deepEqual(wrapLines(measure, "The Unbelievably Long and Winding Chronicles", 160, 2), ["The Unbelievably", "Long and Windin…"]);
  const two = wrapLines(measure, "The Unbelievably Long and Winding Chronicles of the Lighthouse", 200, 2);
  assert.equal(two.length, 2);
  assert.ok(two[1].endsWith("…"), two[1]);
  for (const l of two) assert.ok(measure(l) <= 200, l);
  const cut = wrapLines(measure, "Supercalifragilisticexpialidocious", 100, 2);
  assert.equal(cut.length, 1);
  assert.ok(cut[0].endsWith("…") && measure(cut[0]) <= 100, cut[0]);
  assert.deepEqual(wrapLines(measure, "", 100, 2), []);
  assert.deepEqual(wrapLines(measure, "הבית ברחוב הירקון", 120, 2), ["הבית ברחוב", "הירקון"]);
  // the biggest size that fits one line
  const m2 = (s, px) => s.length * px * 0.5;
  assert.equal(fitSize(m2, "1234567890", 300, 100, 20), 60);
  assert.equal(fitSize(m2, "x".repeat(200), 300, 100, 20), 20);
});

test("easings start at 0 and land on 1; the spring and back overshoot on the way", async () => {
  const { EASE } = await load("motion.js");
  for (const [name, f] of Object.entries(EASE)) {
    assert.ok(Math.abs(f(0)) < 1e-9, `${name}(0)`);
    assert.ok(Math.abs(f(1) - 1) < 1e-9, `${name}(1)`);
  }
  assert.ok([0.3, 0.4, 0.5, 0.6, 0.7].some((t) => EASE.back(t) > 1));
  assert.ok([0.1, 0.15, 0.2, 0.25].some((t) => EASE.spring(t) > 1));
});

test("the shell carries play.css inert, and the kit's files are where the app serves them", () => {
  const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
  assert.match(html, /<template id="play-css"><link rel="stylesheet" href="\/css\/play\.css" \/><\/template>/);
  for (const f of ["motion.js", "count.js", "press.js", "tilt.js", "burst.js", "story.js", "sharecard.js", "room.js"]) {
    assert.ok(fs.existsSync(path.join(ROOT, "public/js/play", f)), f);
  }
  // the play sheet is not in the shell's bundle (Home never pays for it)
  const { css } = require("../src/lib/cssbundle").get(path.join(ROOT, "public", "css"));
  assert.ok(!css.includes(".play-story"), "play.css must stay out of aurora.css");
});

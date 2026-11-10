// The pure parts of the three games built on the Aurora Play kit
// (public/js/play/): the draw's reel (Pick for me), the telling of a vote
// (Pick together), the deck's depth and pull, what a sitting of Taste says,
// and its constellation.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const load = (f) => import(pathToFileURL(path.join(ROOT, "public/js/play", f)).href);

// ---------------------------------------------------------------- the reel
test("reel: the landing strip goes round the picks in their order and stops on the winner", async () => {
  const { landingStrip } = await load("reel.js");
  assert.deepEqual(landingStrip(6, 0, 9), [4, 5, 0, 1, 2, 3, 4, 5, 0]);
  assert.deepEqual(landingStrip(3, 2, 5), [1, 2, 0, 1, 2]);
  assert.deepEqual(landingStrip(2, 1, 4), [0, 1, 0, 1]);
  // one pick: nothing to pass on the way
  assert.deepEqual(landingStrip(1, 0, 9), [0]);
  assert.deepEqual(landingStrip(0, 0, 9), []);
  // a winner past the end counts round; a strip is never shorter than two
  assert.deepEqual(landingStrip(3, 4, 1), [0, 1]);
  for (const n of [2, 3, 6, 10]) {
    const s = landingStrip(n, n - 1);
    assert.equal(s.length, 9);
    assert.equal(s.at(-1), n - 1);
    for (let k = 1; k < s.length; k++) assert.equal(s[k], (s[k - 1] + 1) % n, "each cell is the next pick");
  }
});

test("reel: 'Another one' passes one other pick on the way when there is one", async () => {
  const { respinStrip, nextDraw } = await load("reel.js");
  assert.deepEqual(respinStrip(6, 0, 1), [0, 2, 1]);
  assert.deepEqual(respinStrip(6, 5, 0), [5, 1, 0]);
  // the one in between is never the one it left
  assert.deepEqual(respinStrip(3, 2, 1), [2, 0, 1]);
  assert.deepEqual(respinStrip(2, 0, 1), [0, 1]);
  assert.deepEqual(respinStrip(1, 0, 0), [0]);
  assert.deepEqual(respinStrip(0, 0, 0), []);
  for (let n = 3; n <= 8; n++) for (let a = 0; a < n; a++) {
    const s = respinStrip(n, a, nextDraw(a, n));
    assert.equal(s.length, 3);
    assert.equal(new Set(s).size, 3, `three different picks (${n}, ${a})`);
  }
  // round to the first again
  assert.equal(nextDraw(5, 6), 0);
  assert.equal(nextDraw(0, 6), 1);
  assert.equal(nextDraw(0, 1), 0);
  assert.equal(nextDraw(3, 0), 0);
});

test("reel: fast, then slowing, a hair past the payline and back onto it", async () => {
  const { reelPos, cellAt, stripShift, LAND_MS, RESPIN_MS, HOLD_MS } = await load("reel.js");
  assert.equal(reelPos(0, 8), 0);
  assert.equal(reelPos(1, 8), 8);
  assert.equal(reelPos(2, 8), 8);
  assert.equal(reelPos(-1, 8), 0);
  assert.equal(reelPos(0.5, 0), 0);
  // the first half covers most of the way (it slows)
  assert.ok(reelPos(0.5, 8) > 8 * 0.8);
  // it never runs backwards before the end of the run-in
  let prev = -1;
  for (let t = 0; t <= 0.68; t += 0.02) {
    const p = reelPos(t, 8);
    assert.ok(p >= prev, `forward at ${t}`);
    prev = p;
  }
  // it goes past the cell near the end — by less than a tenth of a cell — and comes back
  let most = 0;
  for (let t = 0.68; t < 1; t += 0.005) most = Math.max(most, reelPos(t, 8));
  assert.ok(most > 8 && most < 8.1, String(most));
  // the cell at the payline: the nearest one, so the last tick is the winner's
  assert.equal(cellAt(7.49), 7);
  assert.equal(cellAt(7.5), 8);
  assert.equal(cellAt(most), 8);
  assert.equal(cellAt(-3), 0);
  // the strip moves up by whole cells of its own height
  assert.equal(stripShift(0, 9), -0);
  assert.equal(stripShift(3, 9), -(3 / 9) * 100);
  assert.equal(stripShift(8, 9), -(8 / 9) * 100);
  assert.equal(stripShift(1, 0), -100);
  // the suspense is short: under two seconds to land, under one for another
  assert.ok(LAND_MS <= 2000 && RESPIN_MS < 1000 && HOLD_MS < 400);
});

test("hand: the rows come out even — six cards where five fit are dealt three and three", async () => {
  const { handCols } = await load("reel.js");
  // room for five (5 * 168 + 4 * 20 = 920)
  assert.equal(handCols(6, 920), 3);
  assert.equal(handCols(5, 920), 5);
  assert.equal(handCols(7, 920), 4);
  assert.equal(handCols(9, 920), 5);
  assert.equal(handCols(10, 920), 5);
  assert.equal(handCols(11, 920), 4);
  // room for all: one row
  assert.equal(handCols(6, 1200), 6);
  // a narrow room: at least one in a row
  assert.equal(handCols(6, 100), 1);
  assert.equal(handCols(0, 920), 1);
  // never more rows than the plain filling would take, never a row with one card under a full one
  for (let n = 2; n <= 12; n++) for (const room of [360, 560, 760, 920, 1100]) {
    const most = Math.max(1, Math.floor((room + 20) / 188));
    const cols = handCols(n, room);
    assert.ok(cols >= 1 && cols <= most, `${n} in ${room}: ${cols}`);
    assert.equal(Math.ceil(n / cols), Math.ceil(n / most), "the same number of rows");
    const last = n - cols * (Math.ceil(n / cols) - 1);
    assert.ok(cols - last <= Math.ceil(n / cols) - 1 || last === cols, `${n} in ${room}: last row ${last} of ${cols}`);
  }
});

test("nudge: the stage is scrolled only as far as it takes to show it between the bars", async () => {
  const { nudge } = await load("reel.js");
  // free band 80..700
  assert.equal(nudge(80, 700, 200, 500), 0, "already in view: stay");
  assert.equal(nudge(80, 700, 600, 900), 200, "its foot is below: down by what is hidden");
  assert.equal(nudge(80, 700, 20, 320), -60, "its head is under the bar: up to the bar");
  // taller than the band: its head goes under the bar
  assert.equal(nudge(80, 700, 300, 1100), 220);
  // asked to stand in the middle
  assert.equal(nudge(80, 700, 500, 800, true), 500 - (80 + (620 - 300) / 2));
  // no band at all (a keyboard covers the page): the head to the top
  assert.equal(nudge(80, 80, 300, 500), 220);
});

// ---------------------------------------------------------------- the vote
test("tally: a star for every yes, then the maybes, then everyone else", async () => {
  const { tallyOf, MAX_MARKS } = await load("tally.js");
  assert.deepEqual(tallyOf({ yes: 2, maybe: 1, no: 1, missing: 0, of: 4 }), ["yes", "yes", "maybe", "no"]);
  assert.deepEqual(tallyOf({ yes: 2, maybe: 0, no: 0, missing: 0, of: 2 }), ["yes", "yes"]);
  // someone who gave no answer counts with the noes
  assert.deepEqual(tallyOf({ yes: 1, maybe: 0, no: 0, missing: 2, of: 3 }), ["yes", "no", "no"]);
  // numbers that do not add up never draw fewer marks than votes
  assert.deepEqual(tallyOf({ yes: 3, maybe: 1, of: 2 }), ["yes", "yes", "yes", "maybe"]);
  // nothing to draw
  assert.deepEqual(tallyOf(null), []);
  assert.deepEqual(tallyOf({}), []);
  assert.deepEqual(tallyOf({ yes: "x", of: 0 }), []);
  // a room too big for a row of stars
  assert.equal(tallyOf({ yes: MAX_MARKS, of: MAX_MARKS }).length, MAX_MARKS);
  assert.deepEqual(tallyOf({ yes: 7, maybe: 3, of: MAX_MARKS + 1 }), []);
});

test("tie: only when the first two got the same votes and it was not 'everyone said yes'", async () => {
  const { isTie } = await load("tally.js");
  const pick = (yes, maybe, no, extra = {}) => ({ yes, maybe, no, missing: 0, of: yes + maybe + no, ...extra });
  assert.equal(isTie({ picks: [pick(1, 1, 0), pick(1, 1, 0)] }), true);
  assert.equal(isTie({ picks: [pick(1, 1, 0), pick(1, 1, 0), pick(0, 1, 1)] }), true);
  // a clear first
  assert.equal(isTie({ picks: [pick(2, 0, 0), pick(1, 1, 0)] }), false);
  assert.equal(isTie({ picks: [pick(1, 1, 0), pick(1, 0, 1)] }), false);
  // everyone said yes to both: a win, not a draw
  assert.equal(isTie({ picks: [pick(2, 0, 0, { everyone: true }), pick(2, 0, 0, { everyone: true })] }), false);
  // one pick, none, nothing
  assert.equal(isTie({ picks: [pick(1, 1, 0)] }), false);
  assert.equal(isTie({ picks: [] }), false);
  assert.equal(isTie({}), false);
  assert.equal(isTie(null), false);
  assert.equal(isTie({ picks: [pick(1, 1, 0), null] }), false);
});

test("tie-break: the light jumps between the two, slower each time, and ends on the winner", async () => {
  const { tieJumps } = await load("tally.js");
  for (const w of [0, 1]) {
    const j = tieJumps(w);
    assert.equal(j.length, 9);
    assert.equal(j.at(-1).i, w, "the last jump is the winner's");
    assert.equal(j[0].at, 0);
    for (let k = 1; k < j.length; k++) {
      assert.notEqual(j[k].i, j[k - 1].i, "it changes side every jump");
      assert.ok(j[k].at > j[k - 1].at);
      if (k > 1) assert.ok(j[k].at - j[k - 1].at >= j[k - 1].at - j[k - 2].at, "never faster");
    }
    // short enough to stay a beat, not a wait
    assert.ok(j.at(-1).at < 2200, String(j.at(-1).at));
  }
  assert.deepEqual(tieJumps(1, { n: 3, first: 100, grow: 2 }), [{ i: 1, at: 0 }, { i: 0, at: 100 }, { i: 1, at: 300 }]);
  assert.deepEqual(tieJumps(0, { n: 0 }), [{ i: 0, at: 0 }]);
  // anything that is not 1 is the first
  assert.equal(tieJumps(7).at(-1).i, 0);
});

// ---------------------------------------------------------------- the deck
test("deck: how far a drag is towards an answer, and how many cards it still shows", async () => {
  const { pullOf, depthOf, SLAM_MS } = await load("deck.js");
  assert.equal(pullOf(0, 0, 120, 100), 0);
  assert.equal(pullOf(60, 0, 120, 100), 0.5);
  assert.equal(pullOf(-60, 0, 120, 100), 0.5);
  assert.equal(pullOf(0, -100, 120, 100), 1);
  // the further of the two ways counts; never more than all the way
  assert.equal(pullOf(30, 80, 120, 100), 0.8);
  assert.equal(pullOf(999, 0, 120, 100), 1);
  // no distance given: no division by nothing
  assert.equal(pullOf(0.5, 0, 0, 0), 0.5);
  assert.equal(depthOf(0), "0");
  assert.equal(depthOf(1), "1");
  assert.equal(depthOf(3.9), "3");
  assert.equal(depthOf(24), "4");
  assert.equal(depthOf(-2), "0");
  assert.equal(depthOf(undefined), "0");
  assert.ok(SLAM_MS > 0 && SLAM_MS < 300, "the stamp does not hold the answer up");
});

// ---------------------------------------------------------------- Taste's remark
test("taste: this sitting's answers -> the genres loved, the ones refused, the counts", async () => {
  const { readTaste } = await load("tasteread.js");
  const r = readTaste([
    { verdict: "love", genres: ["Sci-Fi", "Thriller"] },
    { verdict: "love", genres: ["Sci-Fi", "Sci-Fi"] }, // a genre said twice counts once
    { verdict: "love", genres: ["Comedy"] },
    { verdict: "nope", genres: ["Comedy", "Horror"] },
    { verdict: "nope", genres: ["Horror"] },
    { verdict: "nope", genres: ["Thriller", "Western"] },
    { verdict: "skip", genres: ["Sci-Fi"] },
    { verdict: "what", genres: ["Sci-Fi"] },
    null,
  ]);
  assert.equal(r.love, 3);
  assert.equal(r.nope, 3);
  assert.equal(r.skip, 1);
  // loved more often than refused, most loved first (Comedy and Thriller: one each way -> not there)
  assert.deepEqual(r.liked, [{ genre: "Sci-Fi", n: 2 }]);
  assert.deepEqual(r.top, { genre: "Sci-Fi", n: 2 });
  // refused twice or more and never loved
  assert.deepEqual(r.less, [{ genre: "Horror", n: 2 }]);
  const none = readTaste([]);
  assert.deepEqual(none, { love: 0, nope: 0, skip: 0, liked: [], less: [], top: null });
  assert.deepEqual(readTaste(null), none);
  // the same count: by name, so the order never jumps about
  assert.deepEqual(readTaste([{ verdict: "love", genres: ["Music", "Crime"] }]).liked.map((g) => g.genre), ["Crime", "Music"]);
});

test("taste: the meter's four stars light at the quarters of the round", async () => {
  const { marksOf, litAt } = await load("tasteread.js");
  assert.deepEqual(marksOf(24), [6, 12, 18, 24]);
  assert.deepEqual(marksOf(10), [3, 5, 8, 10]);
  assert.deepEqual(marksOf(1), [1, 1, 1, 1]);
  assert.equal(litAt(0, 24), 0);
  assert.equal(litAt(5, 24), 0);
  assert.equal(litAt(6, 24), 1);
  assert.equal(litAt(17, 24), 2);
  assert.equal(litAt(24, 24), 4);
  assert.equal(litAt(99, 24), 4);
  assert.equal(litAt(3, 0), 0);
});

test("taste: what it says at a milestone depends on the answers so far", async () => {
  const { milestone } = await load("tasteread.js");
  assert.equal(milestone(1, { love: 2 }), "First stars are lit");
  assert.equal(milestone(1, { love: 0, nope: 6 }), "Tough crowd — keep going");
  assert.equal(milestone(2, { love: 4, top: { genre: "Sci-Fi", n: 2 } }), "A pattern is showing: Sci-Fi");
  assert.equal(milestone(2, { love: 1, top: { genre: "Sci-Fi", n: 1 } }), "Halfway there");
  assert.equal(milestone(3, { love: 1, nope: 9, top: { genre: "Sci-Fi", n: 3 } }), "Picky. Aurora likes that.");
  assert.equal(milestone(3, { love: 6, nope: 4, top: { genre: "Crime", n: 3 } }), "You keep loving Crime");
  assert.equal(milestone(3, { love: 2, nope: 2, top: { genre: "Crime", n: 1 } }), "Almost there");
  // the fourth is the reward itself: no words here
  assert.equal(milestone(4, { love: 9 }), "");
  assert.equal(milestone(1, null), "Tough crowd — keep going");
  // every line is short enough for one line over the card on a small phone
  for (const k of [1, 2, 3]) for (const r of [{ love: 0 }, { love: 9, nope: 0, top: { genre: "Science Fiction", n: 5 } }, { love: 0, nope: 9 }]) {
    assert.ok(milestone(k, r).length <= 40, milestone(k, r));
  }
});

test("constellation: a star for each title loved, the same sky for the same seed, inside its box", async () => {
  const { constellation, seedOf, MAX_STARS } = await load("constellation.js");
  assert.deepEqual(constellation(0, 5), { points: [], lines: [] });
  const one = constellation(1, 5);
  assert.equal(one.points.length, 1);
  assert.deepEqual(one.lines, []);
  assert.equal(one.points[0].x, 160);
  assert.equal(one.points[0].y, 55);
  for (let n = 1; n <= 20; n++) for (const seed of [1, 7, 12345, seedOf("p-abc")]) {
    const c = constellation(n, seed);
    const want = Math.min(n, MAX_STARS);
    assert.equal(c.points.length, want);
    // joined into one figure: a line fewer than stars
    assert.equal(c.lines.length, want - 1);
    for (const p of c.points) {
      assert.ok(p.x >= 0 && p.x <= 320 && p.y >= 0 && p.y <= 110, `${n}/${seed}: ${JSON.stringify(p)}`);
      assert.ok(p.r > 0 && p.r < 6);
    }
    for (const [a, b] of c.lines) assert.ok(a >= 0 && b < want && a !== b);
    // left to right along the main line
    const main = want >= 7 ? want - 1 : want;
    for (let i = 1; i < main; i++) assert.ok(c.points[i].x > c.points[i - 1].x, `${n}/${seed}: star ${i}`);
    assert.deepEqual(c, constellation(n, seed));
  }
  assert.notDeepEqual(constellation(5, 1), constellation(5, 2));
  // the seed from an id: the same for the same text, a number, never nought
  assert.equal(seedOf("abc"), seedOf("abc"));
  assert.notEqual(seedOf("abc"), seedOf("abd"));
  assert.ok(seedOf("") >= 1);
  assert.ok(Number.isInteger(seedOf("שלום")));
});

// The same episode always gets the same intro and credits — whatever it is
// called, wherever it lies, whoever it is compared with, in whatever order,
// urgent or in the background, with the crowd's answers on file or not.
// (Avatar: The Last Airbender S1E4 copied under another name got its intro
// END at 0:57 instead of 0:47: the known intro learned from the original
// matched the copy margins and all, and the longer intro then replaced the
// known one, 5 s more each time round.)
//
// Fifteen-minute synthetic episodes (tools/intro-eval/synth.js): a cold open
// of its own length, the theme (40 s), the episode's own scene straight
// after it, the end theme near the end and a scene after that. The helper
// processes are replaced by an in-memory read of the same sound, so a copy
// is exactly the same sound under another path — as a byte-identical file is.
const test = require("node:test");
const assert = require("node:assert");

const config = require("../src/config");
const scanner = require("../src/media/scanner");
const metadata = require("../src/media/metadata");
const printPool = require("../src/media/introprint-pool");
const introprint = require("../src/media/introprint");
const introdetect = require("../src/media/introdetect");
const synth = require("../tools/intro-eval/synth");
const I = introdetect._internals;

// never write the worktree's data/ from a test
I.store.save = () => {};
I.prints.save = () => {};

const SR = synth.SR;
const DUR = 900;
const THEME = synth.music(40, 7);
const END_THEME = synth.music(60, 9);
const CREDITS_AT = 810;
const OPENS = { 1: 30, 2: 45, 3: 20, 4: 38, 5: 60 };
const sound = {};
const episodeSound = (n) => {
  const all = new Float64Array(DUR * SR);
  const prog = synth.programme(DUR, 100 + n);
  all.set(prog.subarray(0, OPENS[n] * SR), 0);
  all.set(THEME, OPENS[n] * SR);
  // the episode's own scene from the moment the theme ends: no pause between
  const from = (OPENS[n] + 40) * SR;
  all.set(prog.subarray(from, CREDITS_AT * SR), from);
  all.set(END_THEME, CREDITS_AT * SR);
  all.set(synth.programme(30, 300 + n), (CREDITS_AT + 60) * SR);
  const pcm = synth.encode(all, 40 + n).pcm; // (each its own gain, filter and hiss; a few samples' start)
  // a beat of black before the titles, as Avatar's two seconds before its theme
  pcm.fill(0, (OPENS[n] - 6) * SR, OPENS[n] * SR);
  return pcm;
};
for (const n of [1, 2, 3, 4, 5]) sound[n] = episodeSound(n);

// paths: the originals, and two copies of episode 4 under other names
const FILES = {};
for (const n of [1, 2, 3, 4, 5]) FILES[`e${n}`] = { file: `/lib/Copies Show/Season 01/Copies Show S01E0${n}.mkv`, pcm: sound[n] };
FILES.c7 = { file: "/elsewhere/copy of e4.mkv", pcm: sound[4] };
FILES.c9 = { file: "/lib/deep path with spaces/Copies Show S01E09.mkv", pcm: sound[4] };
const COPIES_OF_4 = ["e4", "c7", "c9"];
const NUM = { c7: 7, c9: 9 };

const saved = { shows: scanner.index.shows, resolve: scanner.resolve, getCached: metadata.getCached, read: printPool.read, ffmpeg: config.FFMPEG, ffprobe: config.FFPROBE };
const setLibrary = (ids, showId = "copies-show") => {
  scanner.index.shows = [{ id: showId, title: "Copies Show", seasons: [{ number: 1, episodes: ids.map((id) => ({ id, episode: NUM[id] || Number(id.slice(1)), season: 1 })) }] }];
};
const reset = () => {
  for (const id of Object.keys(FILES)) delete I.store.data[id];
  for (const k of ["copies-show", "copies-alone"]) delete I.prints.data[k];
};
// a show's episodes analysed side by side, `lanes` at a time, one cache (the pass)
const pass = async (ids, lanes, mode = "full") => {
  const cache = new Map();
  let i = 0;
  const lane = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      const ctx = await I.contextOf(id);
      if (I.analysisDue(I.store.data[id], ctx.mtime)) await I.runEpisode(ctx, cache, { mode });
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
};
const urgent = async (id) => { I.urgentQ.push(id); await I.pumpUrgent(); };

test.before(() => {
  // (the files are not on disk: the chapters probe and the picture's look at
  // the credits find nothing — also where there is no ffmpeg at all, as in CI)
  if (!config.FFMPEG) config.FFMPEG = "aurora-test-no-ffmpeg";
  if (!config.FFPROBE) config.FFPROBE = "aurora-test-no-ffprobe";
  scanner.resolve = (id) => (FILES[id] ? { path: FILES[id].file, kind: "video" } : saved.resolve(id));
  const files = new Set(Object.values(FILES).map((f) => f.file));
  metadata.getCached = (p) => (files.has(p) ? { duration: DUR } : saved.getCached(p));
  printPool.read = async (file, start, length) => {
    const f = Object.values(FILES).find((x) => x.file === file);
    if (!f) return saved.read(file, start, length);
    await new Promise((r) => setImmediate(r)); // (answers come back in their own time, as from a helper)
    return introprint.fingerprint(f.pcm.subarray(Math.round(start * SR), Math.round((start + length) * SR)));
  };
});
test.after(() => {
  scanner.index.shows = saved.shows;
  scanner.resolve = saved.resolve;
  metadata.getCached = saved.getCached;
  printPool.read = saved.read;
  config.FFMPEG = saved.ffmpeg;
  config.FFPROBE = saved.ffprobe;
  reset();
});

test("a copy of an episode, under any name, gets the same intro and credits in every condition (±0.2 s)", { timeout: 300000 }, async () => {
  const all = ["e1", "e2", "e3", "e4", "e5", "c7", "c9"];
  const conditions = {
    "the season, one at a time": async () => { setLibrary(all); await pass(all, 1); },
    "the season backwards, three side by side": async () => { setLibrary([...all].reverse()); await pass([...all].reverse(), 3); },
    "the copies first, on Play, nothing known yet": async () => { setLibrary(all); await urgent("c9"); await urgent("c7"); await pass(all, 2); },
    "the copies landing one by one, on Play": async () => {
      const lib = ["e1", "e2", "e3", "e4", "e5"];
      setLibrary(lib);
      await pass(lib, 2);
      for (const id of ["c7", "c9"]) { lib.push(id); setLibrary(lib); await urgent(id); }
      // and the original read again (another version replaced it, say)
      delete I.store.data.e4;
      await urgent("e4");
    },
    "the crowd's answers on file (ten seconds later)": async () => {
      setLibrary(all);
      for (const id of all) {
        const open = OPENS[id === "c7" || id === "c9" ? 4 : Number(id.slice(1))];
        I.store.data[id] = { mtime: I.mtimeOf(FILES[id].file), at: 0, intro: null, credits: null, source: null, db: { at: 0, intro: { start: open, end: open + 50 }, recap: null, credits: { start: CREDITS_AT + 3, end: null }, preview: null, source: "theintrodb" } };
      }
      await pass(all, 2);
    },
    "a copy alone in its season, the show's intro known": async () => {
      setLibrary(["e1", "e2", "e3", "e4", "e5"]);
      await pass(["e1", "e2", "e3", "e4", "e5"], 1);
      setLibrary(["c7"]);
      await urgent("c7");
    },
  };
  const got = [];
  for (const [name, run] of Object.entries(conditions)) {
    reset();
    await run();
    for (const id of COPIES_OF_4) {
      const r = I.store.data[id];
      if (!r || !r.v) continue;
      got.push({ name, id, intro: introdetect.get(id).intro, credits: r.credits && !r.creditsDue ? r.credits.start : undefined });
    }
  }
  const intros = got.filter((g) => g.intro);
  assert.ok(intros.length >= 14, `answers in every condition (got ${intros.length}: ${JSON.stringify(got)})`);
  const show = (g) => `${g.name} / ${g.id}: ${JSON.stringify(g.intro)}`;
  for (const g of intros) {
    assert.ok(Math.abs(g.intro.start - intros[0].intro.start) <= 0.2, `start differs: ${show(g)} vs ${show(intros[0])}`);
    assert.ok(Math.abs(g.intro.end - intros[0].intro.end) <= 0.2, `end differs: ${show(g)} vs ${show(intros[0])}`);
    // and it is the intro: the theme, not the scene after it
    assert.ok(Math.abs(g.intro.start - OPENS[4]) <= 0.5, `starts at the theme: ${show(g)}`);
    assert.ok(Math.abs(g.intro.end - (OPENS[4] + 40)) <= 0.5, `ends with the theme: ${show(g)}`);
  }
  for (const id of COPIES_OF_4) assert.ok(intros.some((g) => g.id === id), `${id} was answered`);
  const credits = got.filter((g) => g.credits !== undefined);
  assert.ok(credits.length >= 8, `credits measured (got ${JSON.stringify(credits)})`);
  for (const g of credits) {
    assert.ok(g.credits != null && Math.abs(g.credits - CREDITS_AT) <= 0.7, `credits at the end theme: ${g.name} / ${g.id}: ${g.credits}`);
    assert.ok(Math.abs(g.credits - credits[0].credits) <= 0.2, `credits differ: ${g.name} / ${g.id}: ${g.credits} vs ${credits[0].credits}`);
  }
});

test("a known intro is held to its own bounds only for the recording it was learned from", () => {
  // the intro of e2, learned with its margins: against e2's own sound again
  // (a copy) and against e4 (another episode)
  const head = (n) => introprint.fingerprint(sound[n].subarray(0, 225 * SR));
  const intro = { start: OPENS[2], end: OPENS[2] + 40 };
  const slice = I.sliceFor(head(2), intro);
  const { list } = I.mergePrints([], slice, { from: "e2", mtime: 1, season: 1, trust: "confirmed", len: 40 });
  assert.deepEqual(list[0].in.map((x) => Math.round(x)), [5, 45], "the intro's place in the slice is kept");
  const known = I.comparisonOf(list[0]);
  const same = I.matchesOf(head(2), known, I.INTRO_MIN_S)[0];
  assert.ok(same.copy, "the same recording is told");
  assert.ok(Math.abs(same.start - intro.start) < 0.05 && Math.abs(same.end - intro.end) < 0.05, `held to the learned intro: ${same.start}–${same.end}`);
  const other = I.matchesOf(head(4), known, I.INTRO_MIN_S)[0];
  assert.ok(!other.copy, "another episode is not a copy");
  assert.ok(Math.abs(other.start - OPENS[4]) <= 0.5 && Math.abs(other.end - (OPENS[4] + 40)) <= 0.5, `its own edges: ${other.start}–${other.end}`);
  // an intro kept before the bounds existed is not used
  const { in: _drop, ...old } = list[0];
  assert.equal(I.comparisonOf(old), null);
  // and two episodes are not one recording; an episode and its copy are
  assert.equal(introprint.sameRecording(head(2), head(4)), false);
  assert.equal(introprint.sameRecording(head(4), head(4)), true);
  const short = (n) => introprint.fingerprint(sound[n].subarray(0, 60 * SR));
  assert.equal(introprint.sameRecording(short(3), short(4)), false, "a short head");
  assert.equal(introprint.sameRecording(short(4), short(4)), true, "a short head, copied");
});

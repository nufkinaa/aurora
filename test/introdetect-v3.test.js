// introdetect analysis 3: which intro / recap / credits the player gets
// (our own measurement, the databases checked against the sound), the strict
// recap rules, and one urgent analysis end to end — three small episodes
// made with ffmpeg sharing a theme at different places, read by the helper
// processes, the answer `pending` until it is there.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const config = require("../src/config");
const scanner = require("../src/media/scanner");
const metadata = require("../src/media/metadata");
const introdetect = require("../src/media/introdetect");
const recaprules = require("../src/media/recaprules");
const synth = require("../tools/intro-eval/synth");
const I = introdetect._internals;

// never write the worktree's data/ from a test
I.store.save = () => {};
I.prints.save = () => {};

test("the player's intro: ours when sure, the databases' when we have nothing — as heard here, never when not heard", () => {
  const db = { intro: { start: 30, end: 60 } };
  // ours, sure (two comparisons): ours, whatever they say
  assert.deepEqual(I.chooseIntro({ v: 3, intro: { start: 40.2, end: 70.1 }, introSource: "audio", support: 2, db }), { start: 40.2, end: 70.1, source: "audio" });
  // agreeing: ours, said so
  assert.equal(I.chooseIntro({ v: 3, intro: { start: 31, end: 60.5 }, introSource: "audio", support: 1, db }).source, "audio+database");
  // ours from a single comparison, the databases elsewhere: theirs
  assert.equal(I.chooseIntro({ v: 3, intro: { start: 120, end: 140 }, introSource: "audio", support: 1, db }).start, 30);
  // chapters always
  assert.equal(I.chooseIntro({ v: 3, intro: { start: 120, end: 140 }, introSource: "chapters", db }).start, 120);
  // nothing of ours: theirs as heard in this file (another cut: moved)
  assert.deepEqual(I.chooseIntro({ v: 3, intro: null, db, dbCheck: { intro: { start: 30, end: 60 }, verdict: "heard", fixed: { start: 42.1, end: 72 } } }), { start: 42.1, end: 72, source: "database, heard here" });
  // ... not heard although there was something to compare with: none
  assert.equal(I.chooseIntro({ v: 3, intro: null, db, dbCheck: { intro: { start: 30, end: 60 }, verdict: "not heard", fixed: null } }), null);
  // ... a check of an older database answer says nothing about the new one
  assert.equal(I.chooseIntro({ v: 3, intro: null, db, dbCheck: { intro: { start: 10, end: 40 }, verdict: "not heard" } }).start, 30);
  // an analysis-2 record keeps what it had
  assert.equal(I.chooseIntro({ v: 2, intro: { start: 120, end: 140 }, source: "audio", db }).start, 120);
});

test("the databases' recap and preview move with the cut our own intro tells", () => {
  assert.equal(I.dbShift({ intro: { start: 42, end: 72 }, db: { intro: { start: 30, end: 60 } } }), 12);
  assert.equal(I.dbShift({ intro: { start: 31, end: 61 }, db: { intro: { start: 30, end: 60 } } }), 0, "the same place");
  assert.equal(I.dbShift({ intro: { start: 42, end: 90 }, db: { intro: { start: 30, end: 60 } } }), 0, "another length: not the same intro moved");
});

test("a recap only where one is likely: never in a show's first episode, never the intro, never late, two databases", () => {
  const intro = { start: 60, end: 100 };
  assert.equal(recaprules.plausibleRecap({ start: 0, end: 30 }, { season: 1, episode: 1, intro }), false, "S1E1 has nothing to recap");
  assert.equal(recaprules.plausibleRecap({ start: 0, end: 30 }, { season: 1, episode: 2, intro }), true);
  assert.equal(recaprules.plausibleRecap({ start: 62, end: 98 }, { season: 2, episode: 3, intro }), false, "the intro under another name");
  assert.equal(recaprules.plausibleRecap({ start: 300, end: 330 }, { season: 2, episode: 3 }), false, "a recap opens an episode");
  assert.equal(recaprules.plausibleRecap({ start: 200, end: 230 }, { season: 2, episode: 3, intro }), false, "long after the intro");
  assert.equal(recaprules.trustRecap({ start: 0, end: 30 }, { season: 1, episode: 2, intro, agreed: false }), false, "one database alone");
  assert.equal(recaprules.trustRecap({ start: 0, end: 30 }, { season: 1, episode: 2, intro, agreed: true }), true);
});

test("the player's recap: heard as the episode before, or not shown", () => {
  const saved = scanner.index.shows;
  scanner.index.shows = [{ id: "s", seasons: [{ number: 1, episodes: [{ id: "e1", episode: 1 }, { id: "e2", episode: 2 }] }] }];
  try {
    const rc = { start: 0, end: 30 };
    const r = (verdict, agreed = false) => ({ db: { recap: rc, ...(agreed ? { agreed: { recap: true } } : {}) }, recapCheck: verdict ? { recap: rc, verdict } : undefined });
    assert.equal(I.chooseRecap(r("heard"), "e2", null).source, "database, heard here");
    assert.equal(I.chooseRecap(r("not heard", true), "e2", null), null, "not heard: never, even with both databases");
    assert.equal(I.chooseRecap(r("unverifiable"), "e2", null), null, "one database, nothing to check against");
    assert.ok(I.chooseRecap(r("unverifiable", true), "e2", null), "both databases, nothing to check against");
    assert.equal(I.chooseRecap(r("heard"), "e1", null), null, "the first episode");
  } finally {
    scanner.index.shows = saved;
  }
});

test("due again: a new database answer, credits left for later — and a record from another file is not this one's", () => {
  const V = I.ANALYSIS_V;
  assert.equal(I.analysisDue({ mtime: 5, v: V, intro: null, source: "audio", checkDue: true }, 5), true);
  assert.equal(I.analysisDue({ mtime: 5, v: V, intro: null, source: "audio", creditsDue: true }, 5), true);
  assert.equal(I.dbChanged({ v: V, db: { intro: { start: 1, end: 20 } } }, { intro: { start: 1, end: 20 } }).checkDue, undefined);
  assert.equal(I.dbChanged({ v: V, db: { intro: { start: 1, end: 20 } } }, { intro: { start: 9, end: 30 } }).checkDue, true);
  // get(): measured on a file that has since changed
  const id = "v3-test-stale";
  const savedResolve = scanner.resolve;
  scanner.resolve = (x) => (x === id ? { path: __filename } : savedResolve(x));
  try {
    I.store.data[id] = { mtime: 1, v: V, intro: { start: 10, end: 40 }, introSource: "audio", support: 2, source: "audio", db: { intro: { start: 11, end: 41 } } };
    assert.deepEqual(introdetect.get(id).intro, { start: 11, end: 41 }, "the databases' (by identity), not the old file's own");
  } finally {
    scanner.resolve = savedResolve;
    delete I.store.data[id];
  }
});

// ---------- an urgent analysis, for real ----------
const ffmpeg = (args) => new Promise((resolve, reject) => {
  const ff = spawn(config.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let err = "";
  ff.stderr.on("data", (d) => (err += d));
  ff.on("error", reject);
  ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg exited ${code}`))));
});
const wav = (file, f64) => {
  const pcm = Int16Array.from(f64, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(pcm.buffer)]));
};

test("pressing Play on an episode nobody measured: pending, then its intro, to a fraction of a second (real ffmpeg, helper processes)", { skip: !config.ffmpegAvailable && "no ffmpeg", timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-introv3-"));
  const saved = { shows: scanner.index.shows, resolve: scanner.resolve, getCached: metadata.getCached };
  try {
    const theme = synth.music(25, 7);
    const at = { 1: 8, 2: 20, 3: 14 };
    const eps = [];
    for (const e of [1, 2, 3]) {
      const before = synth.programme(at[e] + 1, 100 + e).subarray(0, at[e] * 8000);
      const after = synth.programme(70, 200 + e).subarray(0, (70 - at[e] - 25) * 8000);
      const all = new Float64Array(70 * 8000);
      all.set(before, 0); all.set(theme, before.length); all.set(after, before.length + theme.length);
      const w = path.join(dir, `e${e}.wav`);
      wav(w, all);
      const out = path.join(dir, `Show S01E0${e}.mkv`);
      await ffmpeg(["-i", w, "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-ar", "48000", out]);
      eps.push({ id: `introv3-e${e}`, episode: e, file: out });
    }
    scanner.index.shows = [{ id: "introv3-show", title: "Theme Show", seasons: [{ number: 1, episodes: eps.map((e) => ({ id: e.id, episode: e.episode, season: 1 })) }] }];
    scanner.resolve = (id) => { const e = eps.find((x) => x.id === id); return e ? { path: e.file, kind: "video" } : saved.resolve(id); };
    metadata.getCached = (p) => (eps.some((e) => e.file === p) ? { duration: 70 } : saved.getCached(p));
    const id = eps[1].id;
    assert.equal(introdetect.request(id), true, "the first ask starts the work");
    assert.equal(introdetect.request(id), true, "and says so while it runs");
    const started = Date.now();
    let r = null;
    while (Date.now() - started < 120000) {
      if (!introdetect.request(id)) { r = introdetect.get(id); break; }
      await new Promise((ok) => setTimeout(ok, 200));
    }
    assert.ok(r && r.intro, `an intro (got ${JSON.stringify(r)})`);
    assert.ok(Math.abs(r.intro.start - 20) < 0.5, `starts at ${r.intro.start}, the theme at 20`);
    assert.ok(Math.abs(r.intro.end - 45) < 0.7, `ends at ${r.intro.end}, the theme at 45`);
    assert.equal(introdetect.request(id), false, "answered: not asked again");
    // what it learned: the show's intro, for the next episode on its own
    assert.ok(I.prints.data["introv3-show"] && I.prints.data["introv3-show"].prints.length >= 1, "the show's intro is known now");
  } finally {
    scanner.index.shows = saved.shows;
    scanner.resolve = saved.resolve;
    metadata.getCached = saved.getCached;
    for (const e of ["introv3-e1", "introv3-e2", "introv3-e3"]) delete I.store.data[e];
    delete I.prints.data["introv3-show"];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Hebrew subtitles for anything (media/subai.js): a title with no Hebrew gets
// one translated from its best other track — in a private copy of the server
// with a temp library, through the real subtitle routes, with the MODEL
// replaced by a fake that answers in Hebrew (never the network: AI calls cost
// money, and AURORA_AI_MOCK is for devices, not for this).
//
// Pinned:
//   * the file "<video>.Hebrew (AI).srt" is written beside the video, listed
//     as "עברית (AI)" (lang he, ai) after the people's sidecars, and every cue
//     keeps the source's exact timing;
//   * the model gets numbered lines in batches, with context; a line it left
//     out is asked for again, alone;
//   * POST /api/subtitles/fetch for Hebrew with no providers' answer starts
//     it and says so ({ ai }); a title with Hebrew is never translated;
//   * budgets: too long, too dear, the day's titles — refused before a call;
//     a translation that came back with too many holes is thrown away;
//   * who wants Hebrew (Settings, or the last pick by hand), landed/played;
//   * off without a key, or with "subtitleAi": { "enabled": false };
//   * the ★: a translated track has it only where it is its language's only
//     full track.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..");
let root, server, base, S, scanner, subai, subsync, config, movies;
const realFetch = global.fetch;

const call = async (method, url, body) => {
  const r = await realFetch(base + url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text, headers: r.headers };
};

// English dialogue: plain lines, a two-speaker cue, italics, a position tag,
// a song line with nothing to translate, a name alone
const englishCues = (n) => Array.from({ length: n }, (_, i) => {
  const start = 10 + i * 3.137;
  const text = i % 10 === 3 ? "- Who's there?\n- It's me, open up."
    : i % 10 === 5 ? "<i>I never wanted this.</i>"
      : i % 10 === 7 ? "{\\an8}Look up there!"
        : i % 10 === 8 ? "♪"
          : i % 10 === 9 ? "Sarah!"
            : `This is line number ${i} and it says something.`;
  return { start: Math.round(start * 1000) / 1000, end: Math.round((start + 2.411) * 1000) / 1000, text };
});

// the fake model: every Latin word becomes a Hebrew one, tags and dashes stay
const calls = [];
let drop = new Set(); // ids it "forgets" (once each, unless sticky)
let stickyDrop = false;
const fakeModel = async (messages) => {
  const body = JSON.parse(messages[1].content);
  calls.push({ ids: Object.keys(body.lines).map(Number), before: body.before || [], system: messages[0].content });
  const out = {};
  for (const [id, text] of Object.entries(body.lines)) {
    if (drop.has(Number(id))) { if (!stickyDrop) drop.delete(Number(id)); continue; }
    out[id] = text.replace(/(<[^>]*>)|([A-Za-z']+)/g, (m, tag) => tag || "מילה");
  }
  return { text: "```json\n" + JSON.stringify(out) + "\n```", usage: { in: 900, out: 1200, usd: 0.001 } };
};

const mkFilm = (name, files) => {
  const dir = path.join(movies, name);
  fs.mkdirSync(dir, { recursive: true });
  const film = path.join(dir, `${name}.mkv`);
  fs.writeFileSync(film, Buffer.alloc(40000, 1));
  for (const [suffix, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.${suffix}.srt`), text);
  return film;
};
const idOf = (film) => scanner.idForPath(film);
const itemOf = (film) => scanner.findById(idOf(film));
const ready = () => new Promise((r) => subai.events.once("ready", r));
const idle = async () => { for (let i = 0; i < 400 && !subai.idle(); i++) await new Promise((r) => setTimeout(r, 25)); };

let films;
const providerCalls = [];
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-subai-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  movies = path.join(root, "media", "movies");
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [movies], shows: [] }, onlineMetadata: false, prewarmStreams: false,
    autoOcrSubtitles: false, preconvert: false, notifications: {}, authMode: "open",
    // a key, so the feature is on — the model itself is the fake above
    openrouterApiKey: "sk-test-not-a-key",
    subtitleAi: { batch: 25, batchChars: 1500 },
  }));
  global.fetch = async (url, ...rest) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, ...rest);
    throw new Error("network is not allowed in this test");
  };
  S = (p) => require(path.join(root, "src", p));
  config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");
  const srt = (cues) => S("media/subsync").toSrt(cues);
  films = {
    en: mkFilm("English Only (2031)", { English: srt(englishCues(120)) }),
    he: mkFilm("Has Hebrew (2032)", { English: srt(englishCues(60)), Hebrew: srt(englishCues(60).map((c) => ({ ...c, text: "שורה בעברית" }))) }),
    asked: mkFilm("Asked For (2033)", { English: srt(englishCues(40)) }),
    holes: mkFilm("Holes (2034)", { English: srt(englishCues(60)) }),
    long: mkFilm("Very Long (2035)", { English: srt(englishCues(400)) }),
    none: mkFilm("Nothing To Translate (2036)", {}),
  };
  scanner = S("media/scanner");
  subai = S("media/subai");
  subsync = S("media/subsync");
  const D = subai._internals.deps;
  D.model = fakeModel;
  D.wait = async () => {};
  D.providerFetch = async (id, lang) => { providerCalls.push({ id, lang }); return { tracks: [] }; };
  D.profiles = () => [
    { id: "p-he", prefs: { subLang: "he" } },
    { id: "p-pick-he", prefs: { subLang: "any", subPick: "he" } },
    { id: "p-pick-en", prefs: { subLang: "he", subPick: "en" } },
    { id: "p-off", prefs: { subLang: "he", subPick: "off" } },
    { id: "p-en", prefs: { subLang: "en" } },
    { id: "p-none" },
  ];
  scanner.scan();
  // (server.js does this on "ready": the library lists the new file)
  subai.events.on("ready", () => scanner.scan());

  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("routes/subtitles"));
  app.use(S("routes/stream"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmdirSync(path.join(root, "node_modules")); } catch { try { fs.unlinkSync(path.join(root, "node_modules")); } catch {} }
  if (!fs.existsSync(path.join(root, "node_modules"))) {
    for (let i = 0; i < 20 && fs.existsSync(root); i++) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      if (fs.existsSync(root)) await new Promise((r) => setTimeout(r, 150));
    }
  }
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

test("who wants Hebrew: Settings, or Hebrew as the last pick by hand — a pick of another language wins over Settings", () => {
  assert.equal(subai.wantsHebrew("p-he"), true);
  assert.equal(subai.wantsHebrew("p-pick-he"), true);
  assert.equal(subai.wantsHebrew("p-off"), true); // subtitles off for now, Hebrew when on
  assert.equal(subai.wantsHebrew("p-pick-en"), false);
  assert.equal(subai.wantsHebrew("p-en"), false);
  assert.equal(subai.wantsHebrew("p-none"), false);
  assert.equal(subai.wantsHebrew("nobody"), false);
  assert.equal(subai.wantsHebrew(null), false);
});

test("a title with English only: translated in batches, written beside the video, listed as עברית (AI) with every cue's timing exact", async () => {
  calls.length = 0;
  // nobody who wants English is a reason
  assert.equal(subai.played("p-en", idOf(films.en)), null);
  assert.equal(subai.landed(films.en, ["p-en", "p-none"]), null);
  const done = ready();
  assert.ok(["queued", "translating"].includes(subai.played("p-he", idOf(films.en))));
  // asked again while it runs: the same job
  assert.ok(["queued", "translating"].includes(subai.played("p-pick-he", idOf(films.en))));
  const ev = await done;
  const file = path.join(path.dirname(films.en), "English Only (2031).Hebrew (AI).srt");
  assert.equal(ev.file, file);
  assert.ok(fs.existsSync(file));
  // the providers were asked for Hebrew first (a person's translation wins)
  assert.deepEqual(providerCalls.filter((c) => c.id === idOf(films.en)).map((c) => c.lang), ["he"]);
  // batches of at most 25 lines, each with up to three lines before it as
  // context; the song line ("♪") was never sent
  assert.ok(calls.length >= 4, `${calls.length} calls`);
  for (const c of calls) assert.ok(c.ids.length <= 25);
  assert.deepEqual(calls[1].before.length, 3);
  const sent = calls.flatMap((c) => c.ids);
  assert.equal(new Set(sent).size, sent.length, "every line once");
  assert.equal(sent.includes(9), false, "♪ is not sent");
  assert.match(calls[0].system, /from English into Hebrew/);

  const src = subsync.parse(fs.readFileSync(path.join(path.dirname(films.en), "English Only (2031).English.srt"), "utf8"));
  const out = subsync.parse(fs.readFileSync(file, "utf8"));
  assert.equal(out.length, src.length);
  out.forEach((c, i) => {
    assert.equal(c.start, src[i].start, `cue ${i + 1} start`);
    assert.equal(c.end, src[i].end, `cue ${i + 1} end`);
  });
  // the cues: Hebrew, two lines at most, the dialogue one line per speaker,
  // the italic cue italic, no "{\an8}" left to print, "♪" as it was
  assert.match(out[0].text, /^[֐-׿\s\d]+\.$/);
  assert.equal(out[3].text, "- מילה מילה?\n- מילה מילה, מילה מילה.");
  assert.match(out[5].text, /^<i>.*<\/i>$/);
  assert.match(out[7].text, /^מילה/);
  assert.equal(out[8].text, "♪");
  for (const c of out) assert.ok(c.text.split("\n").length <= 2);

  // the library: "עברית (AI)", lang he, marked ai, after the people's sidecars
  const subs = itemOf(films.en).subtitles;
  const ai = subs.find((t) => t.ai);
  assert.equal(ai.label, "עברית (AI)");
  assert.equal(ai.lang, "he");
  assert.match(ai.url, /^\/stream\/subtitle\//);
  assert.equal(subs.indexOf(ai), subs.length - 1);
  // served like any sidecar (WebVTT), the same cues
  const r = await realFetch(`${base}${ai.url}`);
  assert.equal(r.status, 200);
  const vtt = await r.text();
  assert.match(vtt, /^WEBVTT/);
  assert.equal(subsync.parse(vtt).length, out.length);
  // the store: where it came from, what it cost
  const rec = subai._internals.store.data.files[file];
  assert.equal(rec.from.lang, "en");
  assert.equal(rec.calls, calls.length);
  assert.ok(rec.usd > 0);
  // and it now HAS Hebrew: never again
  calls.length = 0;
  assert.equal(subai.played("p-he", idOf(films.en)), null);
  assert.equal(subai.ensure(idOf(films.en)), null);
  await idle();
  assert.equal(calls.length, 0);
});

test("a title that already has Hebrew is never translated", async () => {
  calls.length = 0;
  assert.equal(subai.hasHebrew(itemOf(films.he).subtitles), true);
  assert.equal(subai.played("p-he", idOf(films.he)), null);
  assert.equal(subai.landed(films.he, ["p-he"]), null);
  const r = await call("POST", "/api/subtitles/fetch", { id: idOf(films.he), lang: "he" });
  assert.equal(r.body && r.body.ai, undefined);
  await idle();
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(path.dirname(films.he), "Has Hebrew (2032).Hebrew (AI).srt")), false);
});

test("the player's own ask: no Hebrew from the providers — the answer says one is being translated, and it lands", async () => {
  providerCalls.length = 0;
  const done = ready();
  const r = await call("POST", "/api/subtitles/fetch", { id: idOf(films.asked), lang: "he" });
  // (no IMDb id in this library: the providers answer "no match" — the
  // translation does not need one)
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.tracks, []);
  assert.ok(["queued", "translating"].includes(r.body.ai), JSON.stringify(r.body));
  await done;
  // the route had asked the providers already: the job does not ask again
  assert.equal(providerCalls.filter((c) => c.lang === "he").length, 0);
  assert.ok(itemOf(films.asked).subtitles.some((t) => t.ai && t.label === "עברית (AI)"));
  // English is not translated into anything
  const en = await call("POST", "/api/subtitles/fetch", { id: idOf(films.none), lang: "en" });
  assert.equal(en.body && en.body.ai, undefined);
});

test("a line the model left out is asked for again, alone; too many holes and nothing is written", async () => {
  calls.length = 0;
  drop = new Set([2, 17]);
  stickyDrop = false;
  const done = ready();
  subai.ensure(idOf(films.holes), { why: "test" });
  await done;
  await idle();
  const retry = calls[calls.length - 1];
  assert.deepEqual(retry.ids, [2, 17]);
  const out = subsync.parse(fs.readFileSync(path.join(path.dirname(films.holes), "Holes (2034).Hebrew (AI).srt"), "utf8"));
  assert.match(out[1].text, /[֐-׿]/);
  assert.match(out[16].text, /[֐-׿]/);

  // a model that keeps leaving lines out: thrown away, and not tried again for a while
  fs.unlinkSync(path.join(path.dirname(films.holes), "Holes (2034).Hebrew (AI).srt"));
  scanner.scan();
  drop = new Set(Array.from({ length: 10 }, (_, i) => i * 3 + 1));
  stickyDrop = true;
  delete subai._internals.store.data.tried[films.holes];
  subai.ensure(idOf(films.holes), { why: "test" });
  await idle();
  stickyDrop = false;
  drop = new Set();
  assert.equal(fs.existsSync(path.join(path.dirname(films.holes), "Holes (2034).Hebrew (AI).srt")), false);
  assert.match(subai._internals.store.data.tried[films.holes].why, /did not come back translated/);
  assert.equal(subai.ensure(idOf(films.holes)), null, "not again this week");
});

test("budgets: too many lines, too dear, the day's titles — refused before any call; nothing to translate from", async () => {
  const o = config.SUB_AI;
  const keep = { ...o };
  try {
    calls.length = 0;
    o.maxCues = 300;
    subai.ensure(idOf(films.long));
    await idle();
    assert.equal(calls.length, 0);
    assert.match(subai._internals.store.data.tried[films.long].why, /too long \(400 lines\)/);
    delete subai._internals.store.data.tried[films.long];

    o.maxCues = 3000;
    o.maxUsd = 0.001;
    subai.ensure(idOf(films.long));
    await idle();
    assert.equal(calls.length, 0);
    assert.match(subai._internals.store.data.tried[films.long].why, /over the title's budget/);
    delete subai._internals.store.data.tried[films.long];

    o.maxUsd = 0.5;
    o.dailyTitles = subai._internals.dayUse().titles; // used up
    subai.ensure(idOf(films.long));
    await idle();
    assert.equal(calls.length, 0);
    const t = subai._internals.store.data.tried[films.long];
    assert.match(t.why, /day's budget/);
    assert.ok(t.until - Date.now() <= 864e5, "tried again tomorrow");
    delete subai._internals.store.data.tried[films.long];

    // no subtitle at all: the providers are asked for English too, then it stops
    providerCalls.length = 0;
    subai.ensure(idOf(films.none));
    await idle();
    assert.deepEqual(providerCalls.map((c) => c.lang), ["he", "en"]);
    assert.match(subai._internals.store.data.tried[films.none].why, /no subtitle to translate from/);
    assert.equal(calls.length, 0);
  } finally {
    for (const k of Object.keys(o)) delete o[k];
    Object.assign(o, keep);
  }
});

test("off: \"subtitleAi\": { \"enabled\": false } (or no key) — nothing is queued and the players are told nothing", async () => {
  config.SUB_AI.enabled = false;
  try {
    assert.equal(subai.enabled(), false);
    assert.equal(subai.ensure(idOf(films.long)), null);
    assert.equal(subai.played("p-he", idOf(films.long)), null);
    const r = await call("POST", "/api/subtitles/fetch", { id: idOf(films.long), lang: "he" });
    assert.equal(r.body && r.body.ai, undefined);
  } finally {
    delete config.SUB_AI.enabled;
  }
  const key = config.OPENROUTER_KEY;
  config.OPENROUTER_KEY = null;
  try { assert.equal(subai.enabled(), false); } finally { config.OPENROUTER_KEY = key; }
  assert.equal(subai.enabled(), true);
});

test("the source: English first, the ★ or the file's own, never a forced track or one that matched nothing", () => {
  const pick = (subs) => (subai.pickSource(subs) || {}).label || null;
  assert.equal(pick([
    { label: "French", lang: "fr", url: "/stream/subtitle/a", star: true },
    { label: "English", lang: "en", url: "/stream/subtitle/b", timing: { verdict: "unmatched" } },
    { label: "English 2", lang: "en", url: "/stream/subtitle/c" },
    { label: "English (Forced)", lang: "en", url: "/stream/embedded/v/2", embedded: true, forced: true },
  ]), "English 2");
  assert.equal(pick([
    { label: "English", lang: "en", url: "/stream/subtitle/b" },
    { label: "English 2", lang: "en", url: "/stream/embedded/v/0", embedded: true },
  ]), "English 2");
  assert.equal(pick([
    { label: "English (SDH)", lang: "en", url: "/stream/subtitle/b", sdh: true },
    { label: "English", lang: "en", url: "/stream/subtitle/c", star: true },
  ]), "English");
  assert.equal(pick([{ label: "Russian", lang: "ru", url: "/stream/subtitle/r" }]), "Russian");
  assert.equal(pick([{ label: "עברית (AI)", lang: "he", url: "/stream/subtitle/x", ai: true }]), null);
  assert.equal(pick([{ label: "Unknown (track 1)", url: "/stream/embedded/v/0", embedded: true }]), null);
  // Hebrew that is only forced (signs) is not Hebrew subtitles
  assert.equal(subai.hasHebrew([{ label: "Hebrew (Forced)", lang: "he", forced: true }]), false);
  assert.equal(subai.hasHebrew([{ label: "Hebrew", lang: "he" }]), true);
});

test("the ★: the translated track has it only where it is its language's one full track", () => {
  const { starBest } = scanner;
  const starred = (tracks) => starBest(tracks.map((t) => ({ ...t }))).filter((t) => t.star).map((t) => t.label);
  assert.deepEqual(starred([
    { label: "English", lang: "en", embedded: true },
    { label: "עברית (AI)", lang: "he", ai: true, timing: { verdict: "in-time", by: "audio", r: 0.6 } },
  ]), ["English", "עברית (AI)"]);
  // a person's Hebrew file beside it: the AI track never takes the ★, even
  // when only it is known to be in time
  assert.deepEqual(starred([
    { label: "Hebrew", lang: "he", timing: { verdict: "moved", by: "audio", r: 0.4 } },
    { label: "עברית (AI)", lang: "he", ai: true, timing: { verdict: "in-time", by: "audio", r: 0.6 } },
  ]), ["Hebrew"]);
  assert.deepEqual(starred([
    { label: "Hebrew" , lang: "he" },
    { label: "עברית (AI)", lang: "he", ai: true, timing: { verdict: "in-time", by: "audio", r: 0.6 } },
  ]), []);
});

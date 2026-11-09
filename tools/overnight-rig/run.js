#!/usr/bin/env node
// The overnight preparation, end to end, on a PRIVATE instance (this working
// tree, scripts/ui-test-server.js) with self-made media and a stand-in
// download engine (tools/overnight-rig/preload.js — no torrent anywhere), in
// the real Chrome (playwright-core, channel "chrome"):
//
//   1. a person finished "Rig Show" E02 yesterday and plays on this Chrome;
//      two titles are played the way they always were (live conversion) and
//      their start-up is measured — a film whose MPEG-2 picture no browser
//      decodes, and an episode in HEVC 10-bit with E-AC-3 sound in MKV;
//   2. Run now: the downloads ahead fetch E03 (Next episode) and E04
//      (Background) through the real queue; the night run prepares what this
//      person's device needs;
//   3. while a conversion runs, the person starts a film: the run must pause
//      within seconds, and go on when they stop;
//   4. the same titles are played again: they must start from the prepared
//      file, with no live conversion at all (the decide step, the requests,
//      the server's encoders), and the start-up is measured again;
//   5. what it all weighs on disk.
//
//   node tools/overnight-rig/run.js [--trials 3] [--seconds 90] [--label name] [--headed]
//
// Output: tools/overnight-rig/.runs/<label>.json and a table on stdout.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true); };
const TRIALS = Number(arg("trials", 3));
const SECONDS = Number(arg("seconds", 90));
const LABEL = String(arg("label", `run-${Date.now().toString(36)}`));
if (arg("headed", false)) process.env.HEADED = "1";
const OUT_DIR = path.join(__dirname, ".runs");
const SCRATCH = path.join(os.tmpdir(), "aurora-agents", "overnight-prep", `rig-${LABEL}`);
const T0 = Date.now();
const say = (...a) => console.log(`${((Date.now() - T0) / 1000).toFixed(0).padStart(5)}s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 120000, every = 250) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
};

const { start } = require("../../scripts/ui-test-server");
const { launchBrowser, makeApi, signIn, goto } = require("../../test/ui/helpers");
const config = require("../../src/config");

const ff = (args) => {
  const r = spawnSync(config.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
};
const SHOW_ID = "tt9100001";
const FILM_ID = "tt9100002";
const HASH = (n) => String(n).repeat(40).slice(0, 40);

// ---------- the media ----------
const makeMedia = () => {
  const dir = path.join(SCRATCH, "media");
  const showDir = path.join(dir, "shows", "Rig Show", "Season 1");
  const filmDir = path.join(dir, "movies", "Rig Film (2023)");
  const payloadDir = path.join(dir, "payloads");
  for (const d of [showDir, filmDir, payloadDir]) fs.mkdirSync(d, { recursive: true });
  // HEVC 10-bit + E-AC-3 5.1 in MKV: what a lot of episodes are
  const episode = (out, hue) => ff(["-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=25:duration=${SECONDS},hue=h=${hue}`,
    "-f", "lavfi", "-i", `sine=frequency=${300 + hue}:duration=${SECONDS}`, "-ac", "6",
    "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error:keyint=50",
    "-c:a", "eac3", "-b:a", "256k", "-shortest", out]);
  const files = {};
  files.e1 = path.join(showDir, "Rig Show S01E01.mkv"); episode(files.e1, 0);
  files.e2 = path.join(showDir, "Rig Show S01E02.mkv"); episode(files.e2, 60);
  files.e3 = path.join(payloadDir, "Rig.Show.S01E03.1080p.WEB.x265.mkv"); episode(files.e3, 120);
  files.e4 = path.join(payloadDir, "Rig.Show.S01E04.1080p.WEB.x265.mkv"); episode(files.e4, 180);
  // MPEG-2 + AC-3: a picture no browser decodes (a live ENCODE, every time)
  files.film = path.join(filmDir, "Rig Film (2023).mkv");
  ff(["-f", "lavfi", "-i", `testsrc=size=1280x720:rate=25:duration=${SECONDS}`, "-f", "lavfi", "-i", `sine=frequency=520:duration=${SECONDS}`,
    "-c:v", "mpeg2video", "-q:v", "3", "-g", "25", "-c:a", "ac3", "-b:a", "192k", "-shortest", files.film]);
  return { dir, files };
};

const META = {
  title: "Rig Show", year: 2024, poster: null, originalLanguage: "en",
  seasons: [{ number: 1, episodes: [1, 2, 3, 4, 5].map((e) => ({ season: 1, episode: e, title: `Episode ${e}`, released: `2024-01-0${e}` })) }],
};

const main = async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  say("making the media (self-made: testsrc, sine)…");
  const media = makeMedia();
  const spec = {
    shows: { [SHOW_ID]: META },
    sources: {
      [`${SHOW_ID}:1:3`]: [{ infoHash: HASH(3), fileIdx: 0, quality: "1080p", seeders: 80, sizeBytes: fs.statSync(media.files.e3).size, provider: "rig", recommended: true, release: path.basename(media.files.e3) }],
      [`${SHOW_ID}:1:4`]: [{ infoHash: HASH(4), fileIdx: 0, quality: "1080p", seeders: 80, sizeBytes: fs.statSync(media.files.e4).size, provider: "rig", recommended: true, release: path.basename(media.files.e4) }],
    },
    payloads: { [HASH(3)]: media.files.e3, [HASH(4)]: media.files.e4 },
  };
  const specPath = path.join(SCRATCH, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const at = Date.now();
  say("starting a private instance…");
  const srv = await start({
    preload: [path.join(__dirname, "preload.js")],
    env: { OVERNIGHT_RIG: specPath },
    config: {
      downloadMinFreePercent: 0, preconvert: false,
      // the night's clock, short: ten quiet minutes → 3 s, and so on
      overnight: { quietStartMs: 3000, resumeQuietMs: 3000, maxPauseMs: 120000, tickMs: 400, planEveryMs: 4000 },
    },
    seed: {
      "imdb-map.json": {
        "movie|test film one|2020": { imdbId: "tt9000001", at }, "movie|test film two|2021": { imdbId: "tt9000002", at },
        "movie|test film three|2022": { imdbId: "tt9000004", at }, "show|test show|": { imdbId: "tt9000003", at },
        "show|rig show|": { imdbId: SHOW_ID, at }, "movie|rig film|2023": { imdbId: FILM_ID, at },
      },
    },
  });
  const api = makeApi(srv);
  srv.api = api;
  const results = { label: LABEL, seconds: SECONDS, trials: TRIALS, started: new Date().toISOString(), host: os.hostname(), cpus: os.cpus().length, before: {}, after: {}, ahead: null, pause: null, disk: null, decisions: [] };
  let browser = null;
  try {
    // the rig's titles into the library
    fs.cpSync(path.join(media.dir, "shows"), srv.library.shows, { recursive: true });
    fs.cpSync(path.join(media.dir, "movies"), srv.library.movies, { recursive: true });
    await api.rescan();
    const lib = await until(async () => {
      const l = await api.library();
      const show = l.shows.find((s) => s.title === "Rig Show");
      const film = l.movies.find((m) => m.title === "Rig Film");
      if (!show || !film) return null;
      const item = await api.item(show.id);
      const eps = item.seasons[0].episodes;
      const probed = await Promise.all([api.item(film.id), ...eps.map((e) => api.item(e.id))]);
      return probed.every((x) => x.video && x.video.codec) ? { show: item, film: probed[0], e1: probed[1], e2: probed[2] } : null;
    }, "the rig's titles scanned and probed", 120000, 1000);
    say(`library: ${lib.film.title} (${lib.film.video.codec}), ${lib.show.title} E01/E02 (${lib.e1.video.codec} ${lib.e1.video.bitDepth}-bit, ${lib.e1.audio.codec})`);

    // the person: finished E02 yesterday-ish, plays on this Chrome
    const viewer = await api.createProfile("Rig Viewer", { open: true });
    await api.setProgress(viewer, lib.e2.id, SECONDS, SECONDS);
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const streamReqs = [];
    page.on("request", (r) => { const u = r.url(); if (/\/stream\//.test(u)) streamReqs.push(u.replace(srv.url, "")); });
    await signIn(page, srv, viewer);
    await goto(page, srv, "#/");
    // (the page's own report goes out once per load; a title read after it
    // carries ?caps= and the profile — a film's page, opened again until seen)
    const caps = await until(async () => {
      await goto(page, srv, `#/movie/${lib.film.id}`);
      await sleep(1000);
      await goto(page, srv, "#/");
      const st = await api.adminGet("/api/admin/overnight");
      const mine = (st.devices || []).find((d) => d.person === "Rig Viewer");
      return mine && mine.devices.length ? mine.devices : null;
    }, "this Chrome seen with the person (a title read with ?caps=&profile=)", 60000, 500);
    say(`the person's devices: ${caps.join(", ")}`);

    // ---------- the start-up, measured ----------
    const encoders = async () => { try { const e = await api.adminGet("/api/admin/encoding"); return (e.cpu && e.cpu.viewers) || []; } catch { return []; } };
    const play = async (item, label) => {
      await goto(page, srv, "#/");
      await sleep(500);
      streamReqs.length = 0;
      const logFrom = srv.log().length;
      let maxEnc = 0;
      const kinds = new Set();
      let watching = true;
      const sampler = (async () => { while (watching) { const v = await encoders(); maxEnc = Math.max(maxEnc, v.length); for (const x of v) kinds.add(x.kind); await sleep(300); } })();
      const t0 = Date.now();
      await page.evaluate((h) => { location.hash = h; }, `#/play/${item.id}?restart=1`);
      await page.waitForFunction(() => { const v = document.querySelector(".player video"); return !!v && v.currentTime > 0.3 && !v.paused && v.readyState >= 3; }, null, { timeout: 120000 });
      const ms = Date.now() - t0;
      await sleep(4000); // a few seconds of play: an encoder started late shows up too
      watching = false;
      await sampler;
      const src = await page.evaluate(() => { const v = document.querySelector(".player video"); return v ? v.currentSrc : ""; });
      const lines = srv.log().slice(logFrom).filter((l) => l.includes(`[play] ${item.id.slice(0, 12)}`) && /decision|path/.test(l));
      const r = { ms, src: src.replace(srv.url, ""), liveStreams: [...new Set(streamReqs.filter((u) => /\/stream\/(transcode|hls)\//.test(u)).map((u) => u.split("?")[0].replace(/\/(seg|index|init)[^/]*$/, "")))], encoders: maxEnc, encoderKinds: [...kinds], marks: lines.map((l) => l.replace(/^.*\[play\]/, "[play]")) };
      say(`${label}: first frame in ${ms} ms · ${r.liveStreams.length ? `live: ${r.liveStreams.join(", ")}` : `file: ${r.src}`} · viewer encoders seen: ${maxEnc}${kinds.size ? ` (${[...kinds].join(", ")})` : ""}`);
      for (const m of r.marks) say(`   ${m}`);
      await goto(page, srv, "#/");
      return r;
    };
    const trials = async (item, label, n = TRIALS) => { const out = []; for (let i = 0; i < n; i++) out.push(await play(item, `${label} #${i + 1}`)); return out; };

    say("BEFORE: the titles as they always played");
    results.before.film = await trials(lib.film, "Rig Film (MPEG-2) — before");
    results.before.e1 = await trials(lib.e1, "Rig Show E01 (HEVC 10-bit, E-AC-3) — before");
    // the person goes on watching E01 a bit: it stays in Continue watching
    await api.setProgress(viewer, lib.e1.id, 30, SECONDS);
    await api.setProgress(viewer, lib.film.id, 30, SECONDS);
    await api.setProgress(viewer, lib.e2.id, SECONDS, SECONDS);

    // ---------- Run now ----------
    say("Run now (nobody watching)…");
    await sleep(1500);
    const run = await until(async () => { const r = await api.call("POST", "/api/admin/overnight/run", {}, api.admin); return r.status === 200 ? r.body : null; }, "Run now accepted", 10000);
    say(`Run now: ${JSON.stringify(run)}`);
    // the downloads ahead, through the real queue
    const jobs = await until(async () => {
      const d = await api.get("/api/downloads");
      const mine = d.filter((j) => j.imdbId === SHOW_ID);
      return mine.length >= 2 && mine.every((j) => j.status === "done") ? mine : null;
    }, "E03 and E04 downloaded ahead and landed", 120000, 500);
    results.ahead = jobs.map((j) => ({ label: j.label, status: j.status, auto: j.autoFor || null, priority: j.priority ? j.priority.label : null }));
    for (const j of results.ahead) say(`downloaded ahead: ${j.label} — ${j.status} (${j.auto}, class "${j.priority}")`);

    // ---------- the pause: somebody starts watching mid-conversion ----------
    const st0 = await until(async () => { const s = await api.adminGet("/api/admin/overnight"); return s.making && s.making.progress > 0.05 && !s.making.paused ? s : null; }, "a conversion under way", 240000, 300);
    say(`converting: ${st0.making.label} (${Math.round(st0.making.progress * 100)}%) — now somebody starts a film`);
    const filmOne = (await api.library()).movies.find((m) => m.title === "Test Film One");
    const tPlay = Date.now();
    await page.evaluate((h) => { location.hash = h; }, `#/play/${filmOne.id}`);
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return !!v && v.currentTime > 0.3 && !v.paused; }, null, { timeout: 60000 });
    const tFrame = Date.now();
    const paused = await until(async () => { const s = await api.adminGet("/api/admin/overnight"); return s.state === "paused" ? s : null; }, "the run paused", 30000, 200);
    const tPaused = Date.now();
    // (the pause itself: SIGSTOP on Linux; on Windows a PowerShell call that
    // takes a moment — the progress is read once it has had time to land)
    await sleep(3000);
    const p1 = (await api.adminGet("/api/admin/overnight")).making.progress;
    await sleep(6000);
    const p2 = (await api.adminGet("/api/admin/overnight")).making.progress;
    say(`paused ${tPaused - tFrame} ms after the film's first frame (${tPaused - tPlay} ms after Play) — progress ${(p1 * 100).toFixed(1)}% → ${(p2 * 100).toFixed(1)}% over the next 6 s: ${paused.line}`);
    await goto(page, srv, "#/");
    const tLeft = Date.now();
    const resumed = await until(async () => { const s = await api.adminGet("/api/admin/overnight"); return s.state === "running" ? s : null; }, "the run going on", 60000, 200);
    say(`going on ${Date.now() - tLeft} ms after the viewer left: ${resumed.line}`);
    results.pause = { pausedAfterFirstFrameMs: tPaused - tFrame, pausedAfterPlayMs: tPaused - tPlay, progressWhilePaused: [p1, p2], resumedAfterLeaveMs: Date.now() - tLeft, line: paused.line };

    // ---------- the run finishes ----------
    const done = await until(async () => {
      const s = await api.adminGet("/api/admin/overnight");
      return !s.making && s.queue.length === 0 && s.prepared.length >= 3 ? s : null;
    }, "everything prepared", 600000, 1000);
    say(`run done: ${done.line}`);
    for (const p of done.prepared) say(`   prepared ${p.label} — ${p.kind}, ${(p.bytes / 1e6).toFixed(1)} MB in ${Math.round((p.ms || 0) / 1000)} s, for ${p.people.join(", ")} (${p.reason})`);
    for (const n of (done.plan && done.plan.notes) || []) say(`   nothing needed: ${n.label} — ${n.why}`);
    const srcSize = (f) => fs.statSync(f).size;
    results.disk = {
      budget: done.budget,
      prepared: done.prepared.map((p) => ({ label: p.label, kind: p.kind, bytes: p.bytes, ms: p.ms, reason: p.reason })),
      sources: { film: srcSize(media.files.film), episode: srcSize(media.files.e1) },
    };
    results.line = done.line;
    results.plan = done.plan;

    say("AFTER: the same titles");
    results.after.film = await trials(lib.film, "Rig Film — after");
    const lib2 = await api.item(lib.show.id);
    const e3 = lib2.seasons[0].episodes.find((e) => Number(e.episode) === 3);
    if (e3) results.after.e3 = await trials(e3, "Rig Show E03 (downloaded ahead) — after");
    // a dub other than the prepared one would go the way it always did; a
    // device that plays the file as it is never gets the prepared one
    const item = await api.get(`/api/item/${lib.film.id}`);
    results.itemWithoutCaps = { prepared: !!item.prepared };

  } finally {
    results.ended = new Date().toISOString();
    results.serverLog = srv.log().filter((l) => /\[(overnight|prepared|ahead|smart|download)\]/.test(l)).slice(-200);
    fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.json`), JSON.stringify(results, null, 2));
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
  }
  // ---------- the table ----------
  const med = (xs) => { const s = xs.map((x) => x.ms).sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
  console.log("\n  start-up: first frame, ms           cold (first play)   warm (median of the rest)   live conversion / viewer encoders");
  const row = (name, list) => {
    if (!list || !list.length) return;
    const rest = list.slice(1).map((x) => x.ms).sort((a, b) => a - b);
    const warm = rest.length ? rest[Math.floor((rest.length - 1) / 2)] : "—";
    console.log(`  ${name.padEnd(34)} ${String(list[0].ms).padStart(8)}   ${String(warm).padStart(12)}              ${list.some((x) => x.liveStreams.length) ? "yes" : "none"} / ${Math.max(0, ...list.map((x) => x.encoders))}`);
  };
  row("film (MPEG-2), live", results.before.film);
  row("film (MPEG-2), prepared h264", results.after.film);
  row("episode E01 (HEVC/E-AC-3), live", results.before.e1);
  row("episode E03 (same format), prep.", results.after.e3);
  console.log(`\n  written: ${path.join(OUT_DIR, `${LABEL}.json`)}`);
};

main().catch((e) => { console.error(e); process.exitCode = 1; });

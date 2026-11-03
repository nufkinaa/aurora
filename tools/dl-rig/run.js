#!/usr/bin/env node
// Downloads v2 against the REAL engine: a private Aurora (this working tree,
// scripts/ui-test-server.js, under its keeper) with its own aria2, fetching
// from a BitTorrent swarm that lives on this PC (tools/dl-rig/swarm.js).
// Nothing leaves the machine: the engine runs with no DHT, no peer exchange
// and only the rig's tracker; the content is bytes we make ourselves (a
// one-frame-per-second black MKV header, then random bytes, so ffprobe sees
// a real long video).
//
//   node tools/dl-rig/run.js [--fast] [--phases fallback,slow,preempt,restart,pack] [--label name]
//
//   --fast     the stall rules scaled down (minutes → tens of seconds) to walk
//              every flow quickly; without it the production numbers are used
//              and the times measured are the real ones
//
// What is measured (docs/downloads-v2.md §8):
//   fallback   seven titles at once, each with a bad first copy: nobody sharing
//              it (no details), details but nobody (a cached .torrent), a seeder
//              that leaves at 25%, a zombie seeder that stalls at 10%, a seeder
//              serving corrupt pieces, a fake (.exe), random bytes named .mkv —
//              each with a good second copy. Time to give up on the first copy,
//              time to land; the right bytes in the library.
//   slow       "Downloads at once" = 1: a copy at 30 KiB/s, then a fast one
//              queued behind it — how long until the fast one starts
//   preempt    a 4 MB/s cap, two big films running: a next episode as a
//              person's ordinary download (the control), then the same size as
//              "watching now" (a progress report for the episode before it)
//   restart    a download through a clean restart, an aria2 crash and a server
//              crash: carries on from its bytes, one job, no orphans
//   pack       a season pack (3 episodes, a sample, an .nfo): three episodes
//              asked for in the same instant, one of them listed as the sample
//
// Output: tools/dl-rig/.runs/<label>.json and a table on stdout.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, execFileSync } = require("child_process");
const { startSwarm, freePort } = require("./swarm");

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true); };
const FAST = !!arg("fast", false);
const PHASES = String(arg("phases", "fallback,slow,preempt,restart,pack")).split(",");
const LABEL = String(arg("label", `${FAST ? "fast" : "prod"}-${Date.now().toString(36)}`));
const OUT_DIR = path.join(__dirname, ".runs");
const SCRATCH = path.join(os.tmpdir(), "aurora-agents", "downloads-v2", `rig-${LABEL}`);
const MB = 1e6;
const T0 = Date.now();
const stamp = () => `${((Date.now() - T0) / 1000).toFixed(0).padStart(5)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(stamp(), ...a);
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const results = { label: LABEL, fast: FAST, started: new Date().toISOString(), phases: {} };

// The production rules, or the same rules on a short clock.
const FAST_HEALTH = {
  metaStallMs: 30e3, metaDeadMs: 90e3, peersStallMs: 30e3, peersDeadMs: 75e3,
  bytesStallMs: 40e3, bytesDeadMs: 100e3, zombieDeadMs: 150e3, unavailDeadMs: 60e3,
  slowMs: 45e3, slowGraceMs: 30e3,
};
const FAST_PRIO = { quickCheckMs: 30e3, cooldownMs: 10e3 };

const PROFILE = "rigprofile01";

const run = async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const config = require("../../src/config");
  // ---------- the heads: real, long, tiny MKVs ----------
  const head = (name, seconds) => {
    const file = path.join(SCRATCH, `${name}.mkv`);
    execFileSync(config.FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=160x90:r=1:d=${seconds}`,
      "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "51", "-g", "600",
      "-c:a", "aac", "-b:a", "8k", "-shortest", file], { windowsHide: true });
    return fs.readFileSync(file);
  };
  const filmHead = head("film-head", 1500);   // 25 min
  const epHead = head("ep-head", 420);        // 7 min

  const swarm = await startSwarm({ dir: path.join(SCRATCH, "swarm"), announceIntervalMs: 10000 });
  say(`[rig] tracker ${swarm.announce}`);

  // ---------- content ----------
  const film = (name, size, { headless = false, ext = ".mkv" } = {}) =>
    swarm.makeContent({ name, files: [{ path: `${name}${ext}`, size, ...(headless ? {} : { head: filmHead }) }] });
  const C = {};
  const want = (p) => PHASES.includes(p);
  if (want("fallback")) {
    C.d1 = await film("Rig.Dead.2020.1080p.WEB.A", 40 * MB);
    C.d2 = await film("Rig.Dead.2020.1080p.WEB.B", 40 * MB);
    C.k1 = await film("Rig.Known.2020.1080p.WEB.A", 40 * MB);
    C.k2 = await film("Rig.Known.2020.1080p.WEB.B", 40 * MB);
    C.l1 = await film("Rig.Leaver.2020.1080p.WEB.A", 60 * MB);
    C.l2 = await film("Rig.Leaver.2020.1080p.WEB.B", 60 * MB);
    C.z1 = await film("Rig.Zombie.2020.1080p.WEB.A", 60 * MB);
    C.z2 = await film("Rig.Zombie.2020.1080p.WEB.B", 60 * MB);
    C.c1 = await film("Rig.Corrupt.2020.1080p.WEB.A", 30 * MB);
    C.c2 = await film("Rig.Corrupt.2020.1080p.WEB.B", 30 * MB);
    C.f1 = await film("Rig.Fake.2020.1080p.WEB.A", 30 * MB, { headless: true, ext: ".exe" });
    C.f2 = await film("Rig.Fake.2020.1080p.WEB.B", 30 * MB);
    C.j1 = await film("Rig.Junk.2020.1080p.WEB.A", 30 * MB, { headless: true });
    C.j2 = await film("Rig.Junk.2020.1080p.WEB.B", 30 * MB);
  }
  if (want("slow")) {
    C.s1 = await film("Rig.Slow.2020.1080p.WEB", 40 * MB);
    C.g1 = await film("Rig.Fast.2020.1080p.WEB", 40 * MB);
  }
  if (want("preempt")) {
    C.p1 = await film("Rig.Big.One.2020.1080p.WEB", 1000 * MB);
    C.p2 = await film("Rig.Big.Two.2020.1080p.WEB", 1000 * MB);
    const ep = (name) => swarm.makeContent({ name, files: [{ path: `${name}.mkv`, size: 100 * MB, head: epHead }] });
    C.ectl = await ep("Rig.Control.S01E02.1080p.WEB");
    C.e1 = await ep("Rig.Show.S01E01.1080p.WEB");
    C.e2 = await ep("Rig.Show.S01E02.1080p.WEB");
  }
  if (want("restart")) {
    for (const k of ["r1", "r2", "r3"]) C[k] = await film(`Rig.Restart.${k}.2020.1080p.WEB`, 300 * MB);
  }
  if (want("pack")) {
    C.pk = await swarm.makeContent({
      name: "Rig.Pack.S01.1080p.WEB",
      files: [
        { path: "Rig.Pack.S01E01.1080p.WEB.mkv", size: 50 * MB, head: epHead },
        { path: "Rig.Pack.S01E02.1080p.WEB.mkv", size: 50 * MB, head: epHead },
        { path: "Rig.Pack.S01E03.1080p.WEB.mkv", size: 50 * MB, head: epHead },
        { path: "Sample/rig.pack.s01e02.sample.mkv", size: 3 * MB, head: epHead },
        { path: "Rig.Pack.S01.nfo", size: 2000 },
      ],
    });
  }

  // ---------- the source lists (what Torrentio would answer) ----------
  const stream = (c, over = {}) => ({
    infoHash: c.infoHash, fileIdx: 0, filename: c.files[0].path, release: c.name, provider: "RigTracker",
    quality: "1080p", qualityLabel: "1080p", tags: [], cam: false, prerelease: false, hardsub: false, badge: null, warning: null,
    dubbed: false, seeders: 50, sizeString: `${(c.totalLength / 1e9).toFixed(2)} GB`, sizeBytes: c.files[0].length, languages: [], pack: false, ...over,
  });
  const streams = {};
  const ids = {};
  let n = 0;
  const title = (key, type, list, se = null) => {
    const imdbId = `tt97${String(++n).padStart(5, "0")}`;
    ids[key] = imdbId;
    const k = type === "show" ? `series|${imdbId}:${se[0]}:${se[1]}` : `movie|${imdbId}`;
    const rows = list.map((x, i) => (i === 0 ? { ...x, recommended: true } : x));
    streams[k] = { at: Date.now(), v: 6, streams: rows };
    return imdbId;
  };
  if (want("fallback")) {
    for (const k of ["d", "k", "l", "z", "c", "f", "j"]) title(k, "movie", [stream(C[`${k}1`], { seeders: 90 }), stream(C[`${k}2`], { seeders: 40 })]);
  }
  if (want("slow")) { title("s", "movie", [stream(C.s1)]); title("g", "movie", [stream(C.g1)]); }
  if (want("preempt")) {
    title("p1", "movie", [stream(C.p1)]);
    title("p2", "movie", [stream(C.p2)]);
    title("ectl", "show", [stream(C.ectl, { seeders: 60 })], [1, 2]);
    const show = `tt97${String(++n).padStart(5, "0")}`;
    ids.show = show;
    streams[`series|${show}:1:1`] = { at: Date.now(), v: 6, streams: [stream(C.e1, { seeders: 60, recommended: true })] };
    streams[`series|${show}:1:2`] = { at: Date.now(), v: 6, streams: [stream(C.e2, { seeders: 60, recommended: true })] };
  }
  if (want("restart")) for (const k of ["r1", "r2", "r3"]) title(k, "movie", [stream(C[k])]);
  if (want("pack")) {
    const idx = (p) => C.pk.files.find((f) => f.path === p).index - 1;
    const show = `tt97${String(++n).padStart(5, "0")}`;
    ids.pack = show;
    for (const e of [1, 2, 3]) {
      // episode 2 is listed with the SAMPLE's index, the way a provider sometimes does
      const fileIdx = e === 2 ? idx("Sample/rig.pack.s01e02.sample.mkv") : idx(`Rig.Pack.S01E0${e}.1080p.WEB.mkv`);
      streams[`series|${show}:1:${e}`] = { at: Date.now(), v: 6, streams: [stream(C.pk, { fileIdx, sizeBytes: 50 * MB, seeders: 70, pack: true, recommended: true, release: C.pk.name })] };
    }
  }

  // ---------- the instance ----------
  const server = require("../../scripts/ui-test-server");
  const listenPort = await freePort();
  const srv = await server.start({
    waitForLibrary: false,
    keeper: want("restart"),
    config: {
      downloadMinFreePercent: 0,
      downloadRace: false, // the second-source race has its own tests; this measures the fallback
      downloadEngine: { dht: false, peerExchange: false, excludeTrackers: "*", trackers: [swarm.announce], listenPort },
      ...(FAST ? { downloadHealth: FAST_HEALTH, downloadPriority: FAST_PRIO } : {}),
    },
    seed: {
      "cache/torrent-streams.json": { streams, ids: {} },
      "profiles.json": { profiles: [{ id: PROFILE, name: "Rig Tester", color: "#2c9fe0", avatar: "R" }], state: {}, pending: [], access: {} },
    },
  });
  say(`[rig] private instance ${srv.url} (root ${srv.root})`);
  const stagingRoot = path.join(srv.root, "tmp", "aurora-downloads");
  let seenLog = 0;
  const logTimer = setInterval(() => {
    const all = srv.log();
    const fresh = all.length >= seenLog ? all.slice(seenLog) : all;
    seenLog = all.length;
    for (const line of fresh) if (/\[download\]|\[aria2\]|\[keeper\]|EXITED/.test(line)) say(`srv ${line.slice(0, 230)}`);
  }, 500);

  const call = async (method, url, body, admin = false) => {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(srv.url + url, {
          method, headers: { "Content-Type": "application/json", ...(admin ? { "X-Admin-Password": srv.adminPassword } : {}) },
          body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, body: json };
      } catch (e) {
        if (i >= 60) throw e;
        await sleep(1000); // a restart in progress
      }
    }
  };
  const jobs = async () => (await call("GET", `/api/downloads?profile=${PROFILE}`)).body || [];
  const jobById = async (id) => (await jobs()).find((j) => j.id === id) || null;
  const ask = async (c, imdbId, over = {}) => {
    const s = (over.stream || stream(c));
    const body = {
      infoHash: c.infoHash, fileIdx: s.fileIdx || 0, imdbId, title: over.title || c.name.split(".").slice(0, -4).join(" ").replace(/\./g, " "),
      year: 2020, quality: "1080p", sizeBytes: s.sizeBytes, seeders: s.seeders, provider: s.provider, release: s.release,
      type: over.type || "movie", season: over.season || null, episode: over.episode || null, profile: PROFILE,
    };
    const r = await call("POST", "/api/downloads", body);
    if (!r.body || !r.body.job) throw new Error(`could not ask for ${c.name}: ${JSON.stringify(r.body)}`);
    return r.body.job.id;
  };
  const setSlots = (maxActive, download = "0") => call("POST", "/api/admin/aria2-limits", { download, upload: "0", maxActive }, true);
  const waitFor = async (fn, ms, what, every = 1000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out (${Math.round(ms / 1000)}s) waiting for ${what}`);
      await sleep(every);
    }
  };
  // Every library file's checksum → its path
  const libraryHashes = () => {
    const out = new Map();
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(mkv|mp4|exe)$/i.test(e.name) && !e.name.startsWith(".")) out.set(sha(p), p); } };
    walk(srv.library.movies);
    walk(srv.library.shows);
    return out;
  };
  const shaOf = (c, file = 0) => sha(path.join(c.root, c.files[file].path));
  // A timeline of one job's changes (status / phase / health / note / copy)
  const timelines = {};
  const track = (id, label) => {
    const tl = (timelines[id] = { label, events: [], t0: Date.now() });
    let last = "";
    const tick = async () => {
      const j = await jobById(id).catch(() => null);
      if (!j) return;
      const sig = [j.status, j.phase, j.health && j.health.state, j.note, j.infoHash].join("|");
      if (sig !== last) {
        last = sig;
        tl.events.push({ s: +((Date.now() - tl.t0) / 1000).toFixed(1), status: j.status, phase: j.phase, health: j.health && j.health.state, counted: j.health ? j.health.countsAsRunning : null, note: j.note, copy: j.infoHash.slice(0, 8), progress: +(j.progress || 0).toFixed(3) });
        say(`[job ${label}] ${j.status}${j.phase ? `/${j.phase}` : ""} ${j.health ? j.health.state : ""} ${Math.round((j.progress || 0) * 100)}% copy ${j.infoHash.slice(0, 8)}${j.note ? ` — ${j.note}` : ""}`);
      }
      tl.last = j;
    };
    tl.timer = setInterval(() => tick().catch(() => {}), 1000);
    return tl;
  };
  const untrack = () => { for (const tl of Object.values(timelines)) clearInterval(tl.timer); };
  const firstAt = (tl, pred) => { const e = tl.events.find(pred); return e ? e.s : null; };

  try {
    // ================================================================
    if (want("fallback")) {
      say("[rig] ===== fallback =====");
      await setSlots(6);
      // the good copies have seeders; the bad ones are set up as they should be
      for (const k of ["d", "k", "l", "z", "c", "f", "j"]) await swarm.seed(C[`${k}2`], { label: `${k}2` });
      await swarm.seed(C.l1, { leaveAfterBytes: 0.25 * C.l1.totalLength, rate: 2 * MB, label: "l1-leaves" });
      await swarm.seed(C.z1, { stallAtFraction: 0.1, rate: 2 * MB, label: "z1-zombie" });
      await swarm.seed(C.c1, { corruptPieces: Array.from({ length: C.c1.pieceCount }, (_, i) => i), label: "c1-corrupt" });
      await swarm.seed(C.f1, { label: "f1-fake" });
      await swarm.seed(C.j1, { label: "j1-junk" });
      // "details in, no one to connect to": the .torrent where the engine looks first
      fs.mkdirSync(path.join(stagingRoot, C.k1.infoHash), { recursive: true });
      fs.writeFileSync(path.join(stagingRoot, C.k1.infoHash, `${C.k1.infoHash}.torrent`), C.k1.torrentFile);
      const ids2 = {};
      for (const k of ["d", "k", "l", "z", "c", "f", "j"]) {
        ids2[k] = await ask(C[`${k}1`], ids[k]);
        track(ids2[k], k);
      }
      const limit = FAST ? 12 * 60e3 : 40 * 60e3;
      await waitFor(async () => (await jobs()).filter((j) => Object.values(ids2).includes(j.id)).every((j) => ["done", "error"].includes(j.status)), limit, "every fallback title to end", 3000);
      await sleep(3000);
      const lib = libraryHashes();
      const rows = {};
      for (const k of Object.keys(ids2)) {
        const tl = timelines[ids2[k]];
        const j = tl.last;
        const good = shaOf(C[`${k}2`]);
        rows[k] = {
          what: { d: "no one sharing it (no details)", k: "details in, no one to connect to", l: "seeder leaves at 25%", z: "zombie seeder stalls at 10%", c: "only corrupt pieces", f: "a program (.exe)", j: "random bytes named .mkv" }[k],
          status: j.status,
          gaveUpAfterSec: firstAt(tl, (e) => e.copy === C[`${k}2`].infoHash.slice(0, 8)),
          stalledAtSec: firstAt(tl, (e) => e.health === "stalled"),
          doneAfterSec: firstAt(tl, (e) => e.status === "done"),
          why: j.sources && j.sources.given && j.sources.given[0] ? j.sources.given[0].why : null,
          rightBytesInLibrary: lib.has(good),
          badBytesInLibrary: lib.has(shaOf(C[`${k}1`])),
          note: (tl.events.find((e) => e.note && /trying another/.test(e.note)) || {}).note || null,
        };
      }
      results.phases.fallback = rows;
      console.table(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, { what: r.what, stalled: r.stalledAtSec, switched: r.gaveUpAfterSec, done: r.doneAfterSec, right: r.rightBytesInLibrary, bad: r.badBytesInLibrary, status: r.status }])));
      // the leaver's 25% was set aside and is gone once the job is done
      results.phases.fallback.leaverStagingGone = !fs.existsSync(path.join(stagingRoot, C.l1.infoHash));
      untrack();
    }

    // ================================================================
    if (want("slow")) {
      say("[rig] ===== slow =====");
      await setSlots(1);
      await swarm.seed(C.s1, { rate: 30 * 1024, label: "s1-slow" });
      await swarm.seed(C.g1, { label: "g1-fast" });
      const s = await ask(C.s1, ids.s);
      const tls = track(s, "slow");
      await sleep(2000);
      const g = await ask(C.g1, ids.g);
      const tlg = track(g, "fast");
      const t0 = Date.now();
      await waitFor(async () => { const j = await jobById(g); return j && j.status === "done"; }, FAST ? 6 * 60e3 : 20 * 60e3, "the fast one behind the slow one to land", 2000);
      const sj = await jobById(s);
      results.phases.slow = {
        fastStartedAfterSec: firstAt(tlg, (e) => e.status === "downloading"),
        fastDoneAfterSec: +((Date.now() - t0) / 1000).toFixed(0),
        slowState: sj.health, slowNote: sj.note, slowProgress: sj.progress, slowStillRunning: sj.status === "downloading",
      };
      console.table({ slow: results.phases.slow });
      await call("POST", `/api/downloads/${s}/cancel`, { profile: PROFILE });
      void tls;
      untrack();
    }

    // ================================================================
    if (want("preempt")) {
      say("[rig] ===== preempt =====");
      await setSlots(3, "4M");                 // a 4 MB/s line, three at once
      for (const k of ["p1", "p2", "ectl", "e2"]) await swarm.seed(C[k], { label: k });
      const p1 = await ask(C.p1, ids.p1);
      const p2 = await ask(C.p2, ids.p2);
      track(p1, "big1");
      track(p2, "big2");
      await sleep(25000);                      // the line is measured
      // the control: an episode of the same size as a person's ordinary download
      const ctlAt = Date.now();
      const ctl = await ask(C.ectl, ids.ectl, { type: "show", season: 1, episode: 2, title: "Rig Control" });
      track(ctl, "control");
      await waitFor(async () => { const j = await jobById(ctl); return j && j.status === "done"; }, 10 * 60e3, "the control episode", 1000);
      const ctlSec = (Date.now() - ctlAt) / 1000;
      // the same, as the next episode of a show being watched right now
      const nowAt = Date.now();
      const ep = await ask(C.e2, ids.show, { type: "show", season: 1, episode: 2, title: "Rig Show" });
      const tle = track(ep, "next-episode");
      const pr = await call("POST", `/api/profiles/${PROFILE}/progress`, { itemId: `torrent|${C.e1.infoHash}|0`, position: 300, duration: 2400, item: { imdbId: ids.show, season: 1, episode: 1, quality: "1080p" } });
      say(`[rig] progress report for S01E01: ${pr.status}`);
      await waitFor(async () => { const j = await jobById(ep); return j && j.status === "done"; }, 10 * 60e3, "the next episode", 500);
      const nowSec = (Date.now() - nowAt) / 1000;
      const b1 = [...timelines[p1].events, ...timelines[p2].events];
      results.phases.preempt = {
        controlSec: +ctlSec.toFixed(1), nextEpisodeSec: +nowSec.toFixed(1),
        urgentLabel: (tle.last && tle.last.priority && tle.last.priority.label) || null,
        bigHeldNote: (b1.find((e) => /Paused for a moment/.test(e.note || "")) || {}).note || null,
        bigLetGo: [p1, p2].every((id) => !!(timelines[id].last && !timelines[id].last.heldBack)),
        bigsStillRunningAtTheEnd: [p1, p2].filter((id) => timelines[id].last && timelines[id].last.status === "downloading").length,
        progressRoute: pr.status,
      };
      console.table({ preempt: results.phases.preempt });
      for (const id of [p1, p2]) await call("POST", `/api/downloads/${id}/cancel`, { profile: PROFILE });
      await setSlots(4, "0");
      untrack();
    }

    // ================================================================
    if (want("restart")) {
      say("[rig] ===== restart =====");
      await setSlots(4);
      const state = () => { try { return JSON.parse(fs.readFileSync(path.join(srv.dataDir, "keeper-state.json"), "utf8")); } catch { return {}; } };
      const aria2Pid = (serverPid) => {
        const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(serverPid)}" | Where-Object { $_.Name -eq 'aria2c.exe' } | Select-Object -First 1).ProcessId`], { encoding: "utf8", windowsHide: true });
        return Number(String(r.stdout || "").trim()) || null;
      };
      const out = {};
      for (const [k, how] of [["r1", "clean restart"], ["r2", "aria2 killed"], ["r3", "server crash"]]) {
        const sd = await swarm.seed(C[k], { rate: 3 * MB, label: k });
        const id = await ask(C[k], ids[k]);
        const tl = track(id, k);
        await waitFor(async () => { const j = await jobById(id); return j && j.progress >= 0.3; }, 5 * 60e3, `${k} at 30%`, 500);
        const before = (await jobById(id)).progress;
        const s0 = state();
        if (how === "clean restart") {
          const r = spawnSync(process.execPath, [path.join(__dirname, "..", "..", "scripts", "keeper.js"), "--restart", "--data", srv.dataDir], { encoding: "utf8", windowsHide: true, timeout: 60000 });
          say(`[rig] ${String(r.stdout || r.stderr).trim()}`);
        } else if (how === "aria2 killed") {
          const pid = aria2Pid(s0.childPid);
          say(`[rig] killing the instance's own aria2 (pid ${pid}, child of server pid ${s0.childPid})`);
          if (pid) process.kill(pid);
        } else {
          say(`[rig] killing the instance's server process (pid ${s0.childPid}) — the keeper brings it back`);
          if (s0.childPid) process.kill(s0.childPid);
        }
        const tCut = Date.now();
        // back, and moving from where it was
        const back = await waitFor(async () => { const j = await jobById(id).catch(() => null); return j && j.status === "downloading" && j.phase === "downloading" && j.progress > 0 ? j : null; }, 3 * 60e3, `${k} downloading again`, 500);
        const resumedSec = (Date.now() - tCut) / 1000;
        await waitFor(async () => { const j = await jobById(id); return j && j.status === "done"; }, 6 * 60e3, `${k} to land`, 1000);
        const all = (await jobs()).filter((j) => j.imdbId === ids[k]);
        out[k] = {
          how, progressBefore: +before.toFixed(2), progressWhenBack: +back.progress.toFixed(2), backAfterSec: +resumedSec.toFixed(1),
          jobsForTitle: all.length, rightBytes: libraryHashes().has(shaOf(C[k])), stagingGone: !fs.existsSync(path.join(stagingRoot, C[k].infoHash)),
        };
        void tl;
        await sd.stop();
      }
      results.phases.restart = out;
      console.table(out);
      untrack();
    }

    // ================================================================
    if (want("pack")) {
      say("[rig] ===== pack =====");
      await setSlots(4);
      await swarm.seed(C.pk, { label: "pack" });
      const idx = (p) => C.pk.files.find((f) => f.path === p).index - 1;
      const reqs = [1, 2, 3].map((e) => ask(C.pk, ids.pack, {
        type: "show", season: 1, episode: e, title: "Rig Pack",
        stream: stream(C.pk, { fileIdx: e === 2 ? idx("Sample/rig.pack.s01e02.sample.mkv") : idx(`Rig.Pack.S01E0${e}.1080p.WEB.mkv`), sizeBytes: 50 * MB, seeders: 70, release: C.pk.name }),
      }));
      const idsP = await Promise.all(reqs);   // three in the same instant
      idsP.forEach((id, i) => track(id, `E${i + 1}`));
      await waitFor(async () => (await jobs()).filter((j) => idsP.includes(j.id)).every((j) => ["done", "error"].includes(j.status)), 8 * 60e3, "the three episodes", 2000);
      await sleep(2000);
      const lib = libraryHashes();
      const ep = (e) => shaOf(C.pk, C.pk.files.findIndex((f) => f.path === `Rig.Pack.S01E0${e}.1080p.WEB.mkv`));
      results.phases.pack = {
        statuses: (await jobs()).filter((j) => idsP.includes(j.id)).map((j) => `${j.label || j.title}: ${j.status}`),
        e1Right: lib.has(ep(1)), e2Right: lib.has(ep(2)), e3Right: lib.has(ep(3)),
        sampleInLibrary: lib.has(shaOf(C.pk, C.pk.files.findIndex((f) => /sample/.test(f.path)))),
        doneSec: idsP.map((id) => firstAt(timelines[id], (e) => e.status === "done")),
      };
      console.table({ pack: results.phases.pack });
      untrack();
    }
  } finally {
    untrack();
    clearInterval(logTimer);
    results.ended = new Date().toISOString();
    results.timelines = Object.fromEntries(Object.entries(timelines).map(([id, tl]) => [tl.label, tl.events]));
    fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.json`), JSON.stringify(results, null, 2));
    say(`[rig] results in ${path.join(OUT_DIR, `${LABEL}.json`)}`);
    try { fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.server.log`), srv.log().join("\n")); } catch {}
    await srv.stop().catch(() => {});
    await swarm.stop().catch(() => {});
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
  }
};

run().then(() => process.exit(0), (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });

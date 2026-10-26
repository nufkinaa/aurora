#!/usr/bin/env node
// The load + soak harness. See tools/loadtest/README.md for every command.
//
//   node tools/loadtest/run.js once  --ref master --scenario evening --n 8 --minutes 5
//   node tools/loadtest/run.js ramp  --ref master --scenario evening --steps 4,8,16,24 --step-min 3
//   node tools/loadtest/run.js soak  --ref master --scenario evening --n 8 --minutes 120
//   node tools/loadtest/run.js ab    --a master --b srv-storage --scenario evening --n 8 --minutes 4 --rounds 3
//
// Every run writes <out>.json (everything) and <out>.md (the tables) under
// LT_OUT (default docs/qa/server-round/loadtest-results/ of this worktree).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start, dirSize } = require("./instance");
const { Device, classify } = require("./devices");
const { Stats, sleep, round, median, parseArgs, machineSampler, diskSampler, treeSampler, writeJson, REPO } = require("./lib");
const report = require("./report");

const OUT = process.env.LT_OUT || path.join(REPO, "docs", "qa", "server-round", "loadtest-results");
const say = (s) => process.stderr.write(`[lt ${new Date().toISOString().slice(11, 19)}] ${s}\n`);

// ---------- scenarios ----------
// n = households (evening, households) or streams (streams). Each household is
// one profile with a browser and a TV. "think" = seconds between screen
// changes of someone browsing.
const MIXES = {
  // what an evening's streams are: most direct play, some repackaged, one encode in six
  evening: ["web-direct", "tv-direct", "web-jit", "tv-offset", "web-direct", "web-transcode"],
  streams: ["web-direct", "tv-direct", "web-jit", "tv-direct", "web-direct", "tv-offset", "web-jit", "web-direct", "tv-direct", "web-transcode"],
};
const SCENARIOS = {
  // most people browsing, 3-6 streams (one per two households)
  evening: (n) => ({ households: n, webBrowse: 0.6, webThink: 20, tvBrowse: 0.4, tvThink: 35, streams: Math.max(3, Math.round(n / 2)), mix: MIXES.evening }),
  // a few people browsing, n streams
  streams: (n) => ({ households: 4, webBrowse: 0.5, webThink: 30, tvBrowse: 0.25, tvThink: 60, streams: n, mix: MIXES.streams, dedicated: true }),
  // many households, mostly idle (a Home left open, a TV on its Home), some browsing, two streams
  households: (n) => ({ households: n, webBrowse: 0.25, webThink: 45, tvBrowse: 0.1, tvThink: 90, streams: 2, mix: ["web-direct", "tv-direct"] }),
};
const SCENARIO_NOTE = {
  evening: "evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)",
  streams: "streams heavy: n streams on devices of their own (10 % encoded), 4 households browsing beside them",
  households: "many households: n profiles, mostly idle (WebSocket, netprobe, usage, TV version/tuning polls), 25 % of browsers browsing, 2 streams",
};

// ---------- the context the devices share ----------
const makeCtx = (srv) => {
  const ctx = {
    url: srv.url, stats: new Stats(), counters: { wsDrops: 0, wsFails: 0, libraryUpdated: 0, deviceErrors: 0 }, viewers: new Set(),
    lib: { movies: [], shows: [], items: new Map(), catalog: [], words: [] }, cast: new Map(),
  };
  const seenCat = new Set();
  ctx.learn = (cards) => {
    for (const c of cards) {
      if (c.imdbId && !c.id && !seenCat.has(c.imdbId) && ctx.lib.catalog.length < 600) { seenCat.add(c.imdbId); ctx.lib.catalog.push({ type: c.type === "show" || c.type === "series" ? "show" : "movie", imdbId: c.imdbId }); }
    }
  };
  ctx.learnCast = (meta, imdb) => {
    const cast = meta && (meta.cast || (meta.meta && meta.meta.cast));
    if (Array.isArray(cast) && cast.length) ctx.cast.set(imdb, cast.map((x) => (typeof x === "string" ? x : x && x.name)).filter(Boolean).slice(0, 6));
  };
  ctx.castFor = (imdb) => { const c = ctx.cast.get(imdb); return c && c.length ? c[Math.floor(Math.random() * c.length)] : null; };
  ctx.searchWord = () => {
    const w = ctx.lib.words;
    if (w.length && Math.random() < 0.8) return w[Math.floor(Math.random() * w.length)];
    return ["the", "star", "love", "night", "war", "king", "dark", "man"][Math.floor(Math.random() * 8)];
  };
  return ctx;
};
// The library, as the devices will meet it (asked once, outside every window)
const loadLibrary = async (ctx, srv) => {
  const d = new Device(ctx, { ...srv.sessions[0], name: "setup" });
  // (a library seen for the first time is probed in the background: wait until every file has a duration)
  let lib = null;
  for (const end = Date.now() + 15 * 60000; ;) {
    lib = await d.getJson("setup", `/api/library?profile=${srv.sessions[0].profileId}`, { timeoutMs: 120000 });
    if (lib.json && (lib.json.movies || []).length && (lib.json.movies || []).every((m) => m.duration > 0)) break;
    if (Date.now() > end) break;
    await sleep(5000);
  }
  if (!lib.json) throw new Error(`could not read the library: ${lib.status}`);
  ctx.lib.movies = lib.json.movies || [];
  ctx.lib.shows = lib.json.shows || [];
  for (const m of ctx.lib.movies) {
    const it = await d.getJson("setup", `/api/item/${m.id}`);
    if (it.json && it.json.sizeBytes && it.json.duration) ctx.lib.items.set(m.id, { ...it.json, cls: classify(it.json) });
  }
  const words = new Set();
  for (const m of [...ctx.lib.movies, ...ctx.lib.shows]) {
    const t = String(m.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((x) => x.length >= 3);
    if (t[0]) words.add(t.slice(0, 2).join(" ").slice(0, 10));
  }
  ctx.lib.words = [...words];
  const home = await d.getJson("setup", `/api/home?profile=${srv.sessions[0].profileId}`);
  const { cardsOf, artUrl } = require("./devices");
  if (home.json) ctx.learn(cardsOf(home.json));
  // The pictures a settled server already has: every library cover and backdrop and the Home
  // cards, at the widths the devices ask for. Without this the first windows measure the
  // picture-variant queue of a server seeing its library for the first time.
  if (!ctx.noPrewarm) {
    const t0 = Date.now();
    const urls = new Set();
    for (const m of [...ctx.lib.movies, ...ctx.lib.shows]) {
      for (const w of [360, 256]) { const u = artUrl(m.cover, w); if (u) urls.add(u); }
      for (const w of [1920, 1280]) { const u = artUrl(m.backdrop, w); if (u) urls.add(u); }
    }
    for (const c of home.json ? cardsOf(home.json).slice(0, 120) : []) for (const w of [360, 256]) { const u = artUrl(c.poster || c.cover || c.backdrop, w); if (u) urls.add(u); }
    const list = [...urls];
    for (let k = 0; k < list.length; k += 4) await Promise.all(list.slice(k, k + 4).map((u) => d.hit("setup", "GET", u, { compressed: false, timeoutMs: 120000 })));
    say(`pictures warmed: ${list.length} in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  d.stop();
  ctx.stats = new Stats();
  const pools = { "web-direct": [], "web-jit": [], "web-transcode": [], "tv-direct": [], "tv-offset": [] };
  for (const it of ctx.lib.items.values()) {
    if (it.duration < 300) continue; // (a viewer watches a film, not a 20-second sample)
    if (it.cls.web === "direct") pools["web-direct"].push(it); else pools["web-jit"].push(it);
    if (it.cls.tv === "direct") pools["tv-direct"].push(it); else pools["tv-offset"].push(it);
    if (it.video && it.video.codec === "h264") pools["web-transcode"].push(it);
  }
  for (const k of Object.keys(pools)) if (!pools[k].length) pools[k] = [...ctx.lib.items.values()];
  ctx.pools = pools;
  return { movies: ctx.lib.movies.length, shows: ctx.lib.shows.length, playable: ctx.lib.items.size, pools: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])) };
};

// ---------- a running load at a given size; it can grow ----------
class Load {
  constructor(ctx, srv, opts) {
    this.ctx = ctx; this.srv = srv; this.opts = opts;
    this.devices = []; this.households = 0; this.viewers = []; this.streamIdx = {}; this.nStreams = 0;
    this.byProfile = new Map();
  }
  async grow(spec) {
    const s = this.srv.sessions;
    const maxHh = s.length / 2;
    const want = Math.min(spec.households, maxHh);
    const starts = [];
    for (let h = this.households; h < want; h++) {
      const web = s.find((x) => x.i === h && x.kind === "web");
      const tv = s.find((x) => x.i === h && x.kind === "tv");
      const dw = new Device(this.ctx, { ...web, kind: "web", i: h });
      const dt = new Device(this.ctx, { ...tv, kind: "tv", i: h });
      this.devices.push(dw, dt);
      this.byProfile.set(h, { web: dw, tv: dt });
      // browsing share: decided per household, deterministic in the order households are added
      const r = ((h * 0.618034) % 1);
      starts.push(dw.start({ boot: true, browse: r < spec.webBrowse ? spec.webThink * 1000 : null }));
      starts.push(dt.start({ boot: true, browse: r < spec.tvBrowse ? spec.tvThink * 1000 : null }));
      // households arrive over a few seconds, not all in one instant
      await sleep(this.opts.arriveMs != null ? this.opts.arriveMs : 400);
    }
    this.households = Math.max(this.households, want);
    // streams: each on a household's device that is not already playing
    for (let k = this.nStreams; k < spec.streams; k++) {
      const kind = spec.mix[k % spec.mix.length];
      const [dev, mode] = kind.split("-");
      let device = null;
      for (let h = 0; h < this.households && !device && !spec.dedicated; h++) {
        const hh = this.byProfile.get((k + h) % this.households);
        const d = hh[dev === "tv" ? "tv" : "web"];
        if (!d.playing && !d.reserved) device = d;
      }
      if (!device) { // a further device of a household (another TV, another tab), on that device's session
        const hh = this.byProfile.get(k % this.households);
        const base = hh[dev === "tv" ? "tv" : "web"];
        device = new Device(this.ctx, { profileId: base.profileId, sid: base.sid, kind: base.kind, i: base.i });
        this.devices.push(device);
        device.connectWs(); // (its own WebSocket: activity reports ride on it)
        device.start({ boot: false });
      }
      device.reserved = true;
      const pool = this.ctx.pools[kind] || [];
      const n = (this.streamIdx[kind] = (this.streamIdx[kind] || 0) + 1);
      let item = pool.length ? pool[(n - 1 + k * 7) % pool.length] : null;
      const play = async () => {
        await sleep(2000 + Math.random() * 3000);
        while (!device.stopped) {
          if (mode === "torrent") { item = await device.torrentItem(); if (!item) { this.ctx.counters.deviceErrors++; await sleep(30000); continue; } }
          const p = await device.play(item, mode === "transcode" ? "transcode" : mode, { minutes: this.opts.playMinutes || Infinity, seekEveryMin: this.opts.seekEveryMin || 12 });
          this.viewers.push({ kind, title: item.title, id: item.id, report: p.report, refused: p.refused, segFails: p.segFails, bytes: p.bytes, error: p.error });
          if (device.stopped) break;
          await sleep(3000);
        }
      };
      play();
      this.nStreams++;
    }
  }
  live() { return [...this.ctx.viewers].filter((v) => !v.endedAt); }
  stop() { for (const d of this.devices) d.stop(); }
}

// ---------- measuring a window ----------
const viewerSnap = (ctx) => {
  const m = new Map();
  for (const v of ctx.viewers) m.set(v, { ...v.buf.report(), bytes: v.bytes, segFails: v.segFails, refused: v.refused });
  return m;
};
const measure = async ({ srv, ctx, tree, machine, secs, label }) => {
  ctx.stats = new Stats();
  const counters0 = { ...ctx.counters };
  const v0 = viewerSnap(ctx);
  const d0 = dirSize(srv.dataDir);
  await srv.snap(true);
  const t0 = Date.now();
  const driverCpu0 = process.cpuUsage();
  // a lag probe of our own: GET /healthz five times a second on its own connection
  const lag = { ms: [] };
  const { Client } = require("./http");
  const lc = new Client(srv.url, { maxSockets: 1 });
  let stop = false;
  (async () => { while (!stop) { const r = await lc.request("GET", "/healthz", { compressed: false, timeoutMs: 20000 }); lag.ms.push(r.status === 200 ? r.ms : 20000); await sleep(200); } })();
  const intervals = [];
  const every = Math.min(60, secs);
  let left = secs;
  while (left > 0) {
    const s = Math.min(every, left);
    await sleep(s * 1000);
    left -= s;
    if (left > 0) intervals.push({ t: Date.now() - t0, rss: (tree.last() || {}).rss });
  }
  stop = true;
  const t1 = Date.now();
  const server = await srv.snap(true);
  lc.close();
  const d1 = dirSize(srv.dataDir);
  const v1 = viewerSnap(ctx);
  // the viewers in this window: their stalls, starts and seeks inside it
  const vw = [];
  for (const [v, b] of v1) {
    if (v.endedAt && v.endedAt < t0) continue; // finished before this window
    const a = v0.get(v) || { stalls: 0, stallMs: 0, seeks: 0, seekMs: [], bytes: 0, segFails: 0, refused: 0, ttffMs: null };
    vw.push({
      kind: `${v.device.split(":")[0]}-${v.mode}`, title: v.title, startedInWindow: !v0.has(v), ttffMs: b.ttffMs,
      neverStarted: b.neverStarted && (v.endedAt || t1) - v.t0 > 30000, stalls: b.stalls - a.stalls, stallMs: b.stallMs - a.stallMs, seeks: b.seeks - a.seeks, seekMs: b.seekMs.slice(a.seekMs.length),
      mbit: round(((b.bytes - a.bytes) * 8) / 1e6 / ((t1 - t0) / 1000), 2), segFails: b.segFails - a.segFails, refused: b.refused - a.refused, state: b.state,
    });
  }
  const sorted = lag.ms.slice().sort((x, y) => x - y);
  const q = (p) => sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]) : null;
  const tr = tree.between(t0, t1) || {};
  const counters = Object.fromEntries(Object.keys(ctx.counters).map((k) => [k, ctx.counters[k] - (counters0[k] || 0)]));
  const fsCalls = Object.values(server.fs || {}).reduce((a, b) => a + b, 0);
  const writes = Object.entries(server.writes || {}).map(([f, w]) => ({ file: f, n: w.n, bytes: w.bytes })).sort((a, b) => b.bytes - a.bytes);
  const wsecs = (t1 - t0) / 1000;
  return {
    label, secs: round(wsecs, 1),
    client: { groups: ctx.stats.rows(wsecs), browse: ctx.stats.total((g) => BROWSE.has(g)), api: ctx.stats.total((g) => BROWSE.has(g) && g !== "image"), images: ctx.stats.total((g) => g === "image"), all: ctx.stats.total(() => true), lagProbe: { n: sorted.length, p50: q(50), p95: q(95), p99: q(99), max: q(100) } },
    viewers: vw,
    server: {
      loop: server.loop, stalls: server.stalls, elu: server.elu, cpuMs: server.cpu.userMs + server.cpu.systemMs, gc: server.gc, mem: server.mem, handles: server.handles,
      http: server.http, syncMs: server.syncMs, slowSync: server.slowSync, fsCalls, fsTop: Object.entries(server.fs || {}).slice(0, 12), readStreams: server.readStreams,
      writes: writes.slice(0, 15), writtenBytes: writes.reduce((a, w) => a + w.bytes, 0), writesOutsideData: server.writesOutsideData,
    },
    tree: { ...tr, rssMb: tree.last() ? Math.round(tree.last().rss / 1048576) : null, handles: tree.last() ? tree.last().handles : null, threads: tree.last() ? tree.last().threads : null, kidsAlive: tree.last() ? tree.last().kids : null, kidsRssMb: tree.last() ? Math.round(tree.last().kidsRss / 1048576) : null },
    dataDir: { bytes: d1.bytes, files: d1.files, grewBytes: d1.bytes - d0.bytes, grewFiles: d1.files - d0.files, by: Object.fromEntries(Object.entries(d1.by).map(([k, b]) => [k, b - (d0.by[k] || 0)]).filter(([, b]) => b !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 10)) },
    driverCores: round((((c) => c.user + c.system)(process.cpuUsage(driverCpu0)) / 1e6) / wsecs, 3),
    counters, machine: machine.summary(t0), disk: tree.disk ? tree.disk.summary(t0) : null, intervals,
  };
};
// requests a person waits for while browsing (not media, not telemetry)
const BROWSE = new Set(["home", "library", "state", "title", "grid", "search", "suggest", "person", "boot", "api-other", "image", "tv"]);

// degraded? (stalls, p99 > 1 s, errors) — the yardstick of the ramp
const verdict = (w) => {
  const why = [];
  const b = w.client.browse;
  const errs = b.s5xx + b.net + b.s503;
  if (b.p99 > 1000) why.push(`browse p99 ${b.p99} ms > 1000`);
  if (b.n && errs / b.n > 0.005) why.push(`browse errors ${errs}/${b.n}`);
  if (b.s429) why.push(`${b.s429} × 429`);
  const st = w.viewers.reduce((a, v) => a + v.stalls, 0);
  const never = w.viewers.filter((v) => v.neverStarted).length;
  if (st) why.push(`${st} stall(s) in ${w.viewers.length} viewers`);
  if (never) why.push(`${never} viewer(s) never started`);
  const refused = w.viewers.reduce((a, v) => a + v.refused, 0);
  if (refused) why.push(`${refused} stream refusal(s)`);
  const ls = w.server.stalls;
  if (ls && ls.n1000) why.push(`${ls.n1000} event-loop stall(s) > 1 s`);
  if (ls && ls.totalMs > w.secs * 1000 * 0.02) why.push(`loop stalled ${Math.round(ls.totalMs)} ms (> 2 % of the window)`);
  return { degraded: why.length > 0, why };
};

// the server's own words about streams, encoders, the watchdog and errors (the whole run, not the tail)
const notable = (srv) => srv.log().filter((l) => /\[(jit|encode|remux|ladder|watchdog|healer|stream|store|jsonstore|admission)\]|rror|refus|declin|THE SERVER/.test(l)).slice(-400);

// ---------- commands ----------
const boot = async (a, ref, profiles) => {
  say(`starting ${ref} (${profiles} profiles, media ${a.media || "real"})`);
  // --torrent: the instance gets the internet (no network fence) and its torrent engine, so a
  // "web-torrent" viewer in --mix can play a real swarm. Off by default; never on the household's server.
  const torrents = !!a.torrent;
  const srv = await start({ ref, profiles, media: a.media, machine: a.machine, nodeBin: a.node, verbose: !!a.verbose, config: { ...(torrents ? { prewarmStreams: false } : {}), ...(a.config ? JSON.parse(a.config) : {}) }, torrents, network: torrents });
  say(`up: ${srv.ref} at ${srv.url} in ${srv.upMs} ms; machine ${srv.machine.name} ${JSON.stringify(srv.machine.applied)}`);
  if (srv.machine.applied && srv.machine.applied.error) throw new Error(`machine profile not applied: ${srv.machine.applied.error}`);
  const tree = treeSampler(srv.pid, 2000);
  const root = srv.libraries && srv.libraries.movies && srv.libraries.movies[0];
  tree.disk = diskSampler(root && /^[A-Za-z]:/.test(root) ? root : null);
  const ctx = makeCtx(srv);
  ctx.noPrewarm = !!a["no-prewarm"];
  const lib = await loadLibrary(ctx, srv);
  say(`library: ${lib.movies} films, ${lib.shows} shows; pools ${JSON.stringify(lib.pools)}`);
  // the boot's own background work (enrich, indexes, recommender, intro pass…) first: a
  // window measures the load, not the start (--no-settle to measure from the start)
  if (!a["no-settle"]) {
    const t0 = Date.now();
    let calm = 0;
    await srv.snap(true);
    while (Date.now() - t0 < (Number(a["settle-max"]) || (srv.media === "gen" ? 900 : 240)) * 1000) {
      await sleep(5000);
      const s = await srv.snap(true);
      calm = s.elu < 0.03 && (s.stalls ? s.stalls.max < 200 : true) ? calm + 1 : 0;
      if (calm >= 2) break;
    }
    say(`settled after ${Math.round((Date.now() - t0) / 1000)} s${calm >= 2 ? "" : " (still busy: going ahead)"}`);
  }
  return { srv, tree, ctx, lib };
};
const meta = (a, srv, extra = {}) => ({
  at: new Date().toISOString(), host: { cpus: os.cpus().length, cpu: os.cpus()[0].model, memGb: Math.round(os.totalmem() / 1073741824), platform: process.platform, node: process.version },
  ref: srv && srv.ref, head: srv && srv.head, dirty: srv && srv.dirty, media: srv && srv.media, machine: srv && srv.machine, args: a, ...extra,
});
const settle = async (secs) => { say(`warming ${secs} s`); await sleep(secs * 1000); };

// --mix web-direct,tv-direct: the streams' kinds instead of the scenario's (e.g. no ffmpeg on the box)
const withMix = (a, spec) => (a.mix ? { ...spec, mix: String(a.mix).split(",") } : spec);
const runOnce = async (a, { ref = a.ref, scenario = a.scenario || "evening", n = Number(a.n) || 8, minutes = Number(a.minutes) || 5, warm = Number(a.warm) || 60 } = {}) => {
  const spec = withMix(a, SCENARIOS[scenario](n));
  const machine = machineSampler();
  const { srv, tree, ctx, lib } = await boot(a, ref, Math.max(spec.households, 2));
  const load = new Load(ctx, srv, { seekEveryMin: Number(a["seek-min"]) || 12 });
  try {
    await load.grow(spec);
    await settle(warm);
    const w = await measure({ srv, ctx, tree, machine, secs: minutes * 60, label: `${scenario} n=${n}` });
    w.verdict = verdict(w);
    w.spec = spec;
    return { meta: meta(a, srv, { scenario, n, minutes, lib, note: SCENARIO_NOTE[scenario] }), windows: [w], log: srv.log().slice(-200), notable: notable(srv), exited: srv.exited() };
  } finally { load.stop(); tree.stop(); if (tree.disk) tree.disk.stop(); machine.stop(); await srv.stop(); }
};

const runRamp = async (a) => {
  const scenario = a.scenario || "evening";
  const steps = String(a.steps || "4,8,12,16,24,32").split(",").map(Number);
  const stepMin = Number(a["step-min"]) || 3;
  const warm = Number(a.warm) || 45;
  const spec0 = SCENARIOS[scenario](Math.max(...steps));
  const machine = machineSampler();
  const { srv, tree, ctx, lib } = await boot(a, a.ref, Math.max(spec0.households, 2));
  const load = new Load(ctx, srv, { seekEveryMin: Number(a["seek-min"]) || 12 });
  const windows = [];
  try {
    let bad = 0;
    for (const n of steps) {
      const spec = withMix(a, SCENARIOS[scenario](n));
      say(`step n=${n}: ${spec.households} households, ${spec.streams} streams`);
      await load.grow(spec);
      await settle(warm);
      const w = await measure({ srv, ctx, tree, machine, secs: stepMin * 60, label: `${scenario} n=${n}` });
      w.n = n; w.spec = spec; w.verdict = verdict(w);
      windows.push(w);
      say(`  n=${n}: browse p50/p95/p99 ${w.client.browse.p50}/${w.client.browse.p95}/${w.client.browse.p99} ms, loop stalls>100ms ${w.server.stalls.n100} (max ${w.server.stalls.max}), ELU ${w.server.elu}, cpu ${w.tree.serverCores}+${w.tree.kidsCores} cores, stalls ${w.viewers.reduce((x, v) => x + v.stalls, 0)} — ${w.verdict.degraded ? "DEGRADED: " + w.verdict.why.join("; ") : "ok"}`);
      if (w.verdict.degraded) bad++;
      if (bad >= Number(a["stop-after"] || 2)) { say("degraded twice: stopping the ramp"); break; }
      if (srv.exited()) { say("the server exited"); break; }
    }
    return { meta: meta(a, srv, { scenario, steps, stepMin, lib, note: SCENARIO_NOTE[scenario] }), windows, log: srv.log().slice(-200), notable: notable(srv), exited: srv.exited() };
  } finally { load.stop(); tree.stop(); if (tree.disk) tree.disk.stop(); machine.stop(); await srv.stop(); }
};

const runSoak = async (a) => {
  const scenario = a.scenario || "evening";
  const n = Number(a.n) || 8;
  const minutes = Number(a.minutes) || 120;
  const every = Number(a["window-min"]) || 10;
  const spec = withMix(a, SCENARIOS[scenario](n));
  const machine = machineSampler();
  const { srv, tree, ctx, lib } = await boot(a, a.ref, Math.max(spec.households, 2));
  // viewers end a title and start the next one every 20-40 minutes: sessions come and go as in an evening
  const load = new Load(ctx, srv, { seekEveryMin: Number(a["seek-min"]) || 12, playMinutes: Number(a["play-min"]) || 30 });
  const windows = [];
  const file = path.join(OUT, `${a.out || `soak-${scenario}-n${n}-${stamp()}`}`);
  try {
    await load.grow(spec);
    await settle(Number(a.warm) || 60);
    const end = Date.now() + minutes * 60000;
    let k = 0;
    while (Date.now() < end) {
      const secs = Math.min(every * 60, Math.round((end - Date.now()) / 1000));
      if (secs < 30) break;
      const w = await measure({ srv, ctx, tree, machine, secs, label: `soak window ${++k}` });
      w.verdict = verdict(w);
      w.atMin = round((Date.now() - (end - minutes * 60000)) / 60000, 1);
      windows.push(w);
      say(`  soak ${w.atMin} min: rss ${w.tree.rssMb} MB heap ${Math.round(w.server.mem.heapUsed / 1048576)} MB handles ${w.tree.handles} data ${Math.round(w.dataDir.bytes / 1048576)} MB (+${Math.round(w.dataDir.grewBytes / 1024)} KB) browse p99 ${w.client.browse.p99} stalls>100ms ${w.server.stalls.n100}`);
      // partial results after every window: a soak cut short still says something
      const res = { meta: meta(a, srv, { scenario, n, minutes, every, lib, note: SCENARIO_NOTE[scenario] }), windows, partial: true };
      writeJson(`${file}.json`, res);
      if (srv.exited()) { say("the server exited"); break; }
    }
    return { meta: meta(a, srv, { scenario, n, minutes, every, lib, note: SCENARIO_NOTE[scenario] }), windows, viewersDone: load.viewers.slice(-200), log: srv.log().slice(-300), notable: notable(srv), exited: srv.exited() };
  } finally { load.stop(); tree.stop(); if (tree.disk) tree.disk.stop(); machine.stop(); await srv.stop(); }
};

// A against B, interleaved: A B B A A B … (each a fresh instance, same scenario, same size)
const runAb = async (a) => {
  if (!a.b) throw new Error("--b <ref> is needed");
  // pinned to commits now: a branch that moves during the hour of an A/B must not change sides' code half-way
  const { resolveRef } = require("./instance");
  const pin = (r) => { const x = resolveRef(r); return x.kind === "sha" ? x.sha : r; };
  const refs = { A: pin(a.a || "master"), B: pin(a.b) };
  say(`A = ${a.a || "master"} ${refs.A.slice(0, 8)}, B = ${a.b} ${refs.B.slice(0, 8)}`);
  const rounds = Number(a.rounds) || 3;
  const order = [];
  for (let r = 0; r < rounds; r++) order.push(...(r % 2 ? ["B", "A"] : ["A", "B"]));
  const runs = [];
  for (const side of order) {
    say(`A/B run ${runs.length + 1}/${order.length}: ${side} = ${refs[side]}`);
    const res = await runOnce(a, { ref: refs[side], minutes: Number(a.minutes) || 4, warm: Number(a.warm) || 45 });
    runs.push({ side, ref: refs[side], meta: res.meta, window: res.windows[0] });
  }
  return { meta: { at: new Date().toISOString(), refs, names: { A: a.a || "master", B: a.b }, rounds, order, scenario: a.scenario || "evening", n: Number(a.n) || 8, args: a, host: { cpus: os.cpus().length, cpu: os.cpus()[0].model } }, runs };
};

const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);

const main = async () => {
  const a = parseArgs();
  const cmd = a._[0] || "once";
  if (!["once", "ramp", "soak", "ab"].includes(cmd)) throw new Error(`unknown command ${cmd}`);
  if (a.scenario && !SCENARIOS[a.scenario]) throw new Error(`unknown scenario ${a.scenario} (${Object.keys(SCENARIOS).join(", ")})`);
  fs.mkdirSync(OUT, { recursive: true });
  const res = cmd === "once" ? await runOnce(a) : cmd === "ramp" ? await runRamp(a) : cmd === "soak" ? await runSoak(a) : await runAb(a);
  res.kind = cmd;
  const name = a.out || `${cmd}-${a.scenario || "evening"}${cmd === "ab" ? `-${String(a.b).replace(/[^\w.-]+/g, "_")}` : ""}-${stamp()}`;
  const file = path.join(OUT, name);
  writeJson(`${file}.json`, res);
  fs.writeFileSync(`${file}.md`, report.render(res));
  say(`wrote ${file}.json and .md`);
  process.stdout.write(report.render(res) + "\n");
  process.exit(0);
};

module.exports = { SCENARIOS, verdict, measure, makeCtx, loadLibrary, BROWSE, notable };
if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });

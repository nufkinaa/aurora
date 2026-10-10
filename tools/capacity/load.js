#!/usr/bin/env node
// Load on a private instance (tools/capacity/instance.js) — never the live server.
//
//   node tools/capacity/load.js <test> [--films 150 --shows 30 --profiles 100] [--secs 30]
//
//   endpoints   each API call alone, closed loop, at 1/5/20/50/100 connections:
//               requests/s, p50/p95/p99, and the server's CPU per request
//   mix         1/5/20/50/100 simulated devices doing the household mix
//               (see MIX below), with the event-loop lag seen from outside
//   direct      direct play: N streams at 8 and 25 Mbit read at film speed, and
//               the most bytes/s the process can push
//   ws          idle signed-in devices: memory per WebSocket, and what a
//               "library_updated" broadcast costs when every device refetches
//   overload    more encodes than the server allows: who is refused, and how
//   stampede    many devices asking for the same thing that is not made yet
//   boot        start-up: time to listening, time to a probed library, lag meanwhile
//   all         everything above, one instance each
//
// Results: a table on stdout and docs/qa/capacity/results/load-<test>.json.
const os = require("os");
const { Client, Stats, Device, procSampler, lagProbe, sleep } = require("./sim");
const { start } = require("./instance");
const { round, saveJson, pct } = require("./lib");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const SECS = +arg("secs", 30);
const SHAPE = { films: +arg("films", 150), shows: +arg("shows", 30), profiles: +arg("profiles", 100) };
const LEVELS = String(arg("levels", "1,5,20,50,100")).split(",").map(Number);
const host = () => ({ cpu: os.cpus()[0].model.trim(), logical: os.cpus().length, memGb: round(os.totalmem() / 1024 ** 3, 1), node: process.version, when: new Date().toISOString() });
const table = (rows, cols) => {
  if (!rows.length) return;
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  console.log(cols.map((c, i) => c.padEnd(w[i])).join("  "));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? "").padEnd(w[i])).join("  "));
};
const mb = (b) => Math.round(b / 1048576);
const adminHealth = async (srv) => {
  try { return await (await fetch(`${srv.url}/api/admin/health`, { headers: { "X-Admin-Password": srv.adminPassword } })).json(); } catch { return null; }
};

// ---------- endpoints ----------
const endpoints = async () => {
  const srv = await start(SHAPE);
  const samp = procSampler(srv.pid, 1000);
  const s0 = srv.sessions[0];
  const film = srv.library.movies[20];
  const P = s0.profileId;
  // some watch state, so the personal rows of Home and /state have something in them
  const seedC = new Client(srv.url, { sid: s0.sid });
  for (let i = 0; i < 40; i++) await seedC.post(`/api/profiles/${P}/progress`, { itemId: srv.library.movies[i].id, position: 600 + i, duration: 5400 });
  await sleep(2500);
  const cover = `${film.cover}${film.cover.includes("?") ? "&" : "?"}w=256`;
  await seedC.get(cover); // make the variant once: this row measures the cached send
  const list = [
    ["GET /healthz (no work: the floor)", "GET", "/healthz"],
    ["GET /api/ping", "GET", "/api/ping"],
    ["GET /api/home?profile (web)", "GET", `/api/home?profile=${P}`],
    ["GET /api/home?profile&slim=1 (TV)", "GET", `/api/home?profile=${P}&slim=1`],
    ["GET /api/home (web, NOT compressed)", "GET", `/api/home?profile=${P}`, { compressed: false }],
    ["GET /api/library?profile", "GET", `/api/library?profile=${P}`],
    ["GET /api/item/:id", "GET", `/api/item/${film.id}`],
    ["GET /api/profiles/:id/state", "GET", `/api/profiles/${P}/state`],
    ["GET /api/search?q=", "GET", "/api/search?q=river"],
    ["GET /api/search/suggest?q=", "GET", "/api/search/suggest?q=gol"],
    ["GET /api/profiles", "GET", "/api/profiles"],
    ["POST /api/profiles/:id/progress", "POST", `/api/profiles/${P}/progress`, { body: { itemId: film.id, position: 1234, duration: 5400 } }],
    ["POST /api/usage (2 events)", "POST", "/api/usage", { body: { profile: P, sid: "capx", device: "desktop", look: "glass", events: [{ n: "route", t: Date.now(), p: { r: "home", ms: 250 } }, { n: "nav", t: Date.now(), p: { to: "shows" } }] } }],
    ["GET /img/:id?w=256 (cached variant)", "GET", cover, { compressed: false }],
    ["GET / (app shell)", "GET", "/"],
    ["GET /css/aurora.css", "GET", "/css/aurora.css"],
  ];
  const only = arg("only", "");
  const out = [];
  for (const [name, method, p, o] of list) {
    if (only && !name.includes(only)) continue;
    for (const c of LEVELS) {
      const client = new Client(srv.url, { sid: s0.sid, maxSockets: c });
      const stats = new Stats();
      const lag = lagProbe(srv.url);
      const until = Date.now() + Math.min(SECS, 8) * 1000;
      const t0 = Date.now();
      await Promise.all(Array.from({ length: c }, async () => {
        while (Date.now() < until) stats.add("x", await client.request(method, p, o));
      }));
      const t1 = Date.now();
      await sleep(1100);
      const cpu = samp.cpuBetween(t0, t1 + 1000);
      const r = stats.row("x", (t1 - t0) / 1000);
      const l = lag.cut(); lag.stop(); client.close();
      const row = { endpoint: name, conns: c, rps: r.rps, p50: r.p50, p95: r.p95, p99: r.p99, kB: r.kbAvg, err: r.err, cpuMsPerReq: cpu ? round((cpu.cpuSec * 1000) / r.n, 2) : null, srvCores: cpu ? round(cpu.cpuSec / cpu.wallSec, 2) : null, lagP99: l.p99, rssMb: cpu ? cpu.rssMb : null };
      out.push(row);
    }
    table(out.filter((r) => r.endpoint === name), ["endpoint", "conns", "rps", "p50", "p95", "p99", "kB", "err", "cpuMsPerReq", "srvCores", "lagP99", "rssMb"]);
    console.log("");
  }
  samp.stop();
  await srv.stop();
  saveJson("load-endpoints.json", { host: host(), shape: SHAPE, enrichMs: srv.enrichMs, rows: out });
};

// ---------- the household mix ----------
// Of D devices: 50% idle on Home (a WebSocket, a probe every 5 minutes), 30%
// browsing (a screen change every 20 s), 20% playing — of those playing, 70%
// direct at 8 Mbit, 20% remux (jit copy), 10% an encoded rendition. Every
// player saves progress and reports activity every 5 s.
const MIX = (D) => {
  const kinds = [];
  const playing = Math.max(D >= 5 ? 1 : 0, Math.round(D * 0.2));
  const browsing = Math.max(1, Math.round(D * 0.3));
  const transcode = Math.min(2, Math.round(playing * 0.1));
  const remux = Math.round(playing * 0.2);
  for (let i = 0; i < transcode; i++) kinds.push("transcode");
  for (let i = 0; i < remux; i++) kinds.push("remux");
  for (let i = 0; i < playing - transcode - remux; i++) kinds.push("direct");
  for (let i = 0; i < browsing && kinds.length < D; i++) kinds.push("browse");
  while (kinds.length < D) kinds.push("idle");
  return kinds;
};
const mix = async () => {
  const srv = await start(SHAPE);
  const samp = procSampler(srv.pid, 1000);
  const out = [];
  for (const D of LEVELS) {
    const stats = new Stats();
    const kinds = MIX(D);
    const devices = kinds.map((k, i) => new Device(srv, i, k, stats, { thinkMs: +arg("think", 20000), v: "h264-720", titles: 2 }));
    const lag = lagProbe(srv.url);
    const t0 = Date.now();
    devices.forEach((d) => d.run().catch(() => {}));
    await sleep(Math.max(SECS, 45) * 1000);
    const t1 = Date.now();
    const cpu = samp.cpuBetween(t0, t1);
    const secs = (t1 - t0) / 1000;
    const api = stats.total(secs, (k) => !/^(direct-range|segment|img)/.test(k));
    const all = stats.total(secs);
    const l = lag.cut(); lag.stop();
    const h = await adminHealth(srv);
    const count = (k) => kinds.filter((x) => x === k).length;
    const row = { devices: D, idle: count("idle"), browse: count("browse"), direct: count("direct"), remux: count("remux"), transcode: count("transcode"), reqPerSec: all.rps, apiP50: api.p50, apiP95: api.p95, apiP99: api.p99, apiMax: api.max, errors: all.err, lagP50: l.p50, lagP99: l.p99, lagMax: l.max, srvCores: cpu ? round(cpu.cpuSec / cpu.wallSec, 2) : null, rssMb: cpu ? cpu.rssMb : null, handles: cpu ? cpu.handles : null, ffmpeg: h && h.now ? h.now.ffmpeg : null };
    out.push({ ...row, perEndpoint: stats.rows(secs) });
    table([row], Object.keys(row));
    devices.forEach((d) => d.stop());
    await sleep(4000);
  }
  samp.stop();
  await srv.stop();
  saveJson("load-mix.json", { host: host(), shape: SHAPE, secsPerLevel: Math.max(SECS, 45), rows: out });
};

// ---------- direct play ----------
const direct = async () => {
  const srv = await start({ ...SHAPE, films: 20, shows: 2 });
  const samp = procSampler(srv.pid, 1000);
  const out = [];
  // (a) N viewers reading at film speed
  for (const [mbit, item] of [[8, srv.titles.direct], [25, srv.titles.uhd]]) {
    for (const n of [1, 5, 10, 25, 50]) {
      const stats = new Stats();
      const devices = Array.from({ length: n }, (_, i) => new Device(srv, i, "direct", stats, { mbit }));
      const lag = lagProbe(srv.url);
      const t0 = Date.now();
      devices.forEach((d) => { d.connectWs().then(() => d.directLoop(item, mbit)).catch(() => {}); });
      await sleep(Math.min(SECS, 20) * 1000);
      const t1 = Date.now();
      const cpu = samp.cpuBetween(t0, t1);
      const l = lag.cut(); lag.stop();
      devices.forEach((d) => d.stop());
      const row = { test: `${n} x ${mbit} Mbit at film speed`, mbitTotal: n * mbit, srvCores: cpu ? round(cpu.cpuSec / cpu.wallSec, 3) : null, cpuMsPerMbit: cpu ? round((cpu.cpuSec * 1000) / cpu.wallSec / (n * mbit), 3) : null, lagP99: l.p99, lagMax: l.max, rssMb: cpu && cpu.rssMb, handles: cpu && cpu.handles, threads: cpu && cpu.threads };
      out.push(row);
      table([row], Object.keys(row));
      await sleep(1500);
    }
  }
  // (b) as fast as the process can send (loopback: no network in the way)
  for (const n of [1, 4, 16]) {
    const c = new Client(srv.url, { sid: srv.sessions[0].sid, maxSockets: n });
    const lag = lagProbe(srv.url);
    const t0 = Date.now();
    let bytes = 0;
    const until = t0 + 8000;
    await Promise.all(Array.from({ length: n }, async () => {
      while (Date.now() < until) { const r = await c.get(srv.titles.uhd.url || srv.titles.uhd.videoUrl, { compressed: false, headers: { Range: "bytes=0-" } }); bytes += r.bytes; }
    }));
    const t1 = Date.now();
    await sleep(1100);
    const cpu = samp.cpuBetween(t0, t1 + 1000);
    const l = lag.cut(); lag.stop(); c.close();
    const gbit = (bytes * 8) / ((t1 - t0) / 1000) / 1e9;
    const row = { test: `flat out, ${n} connection(s)`, mbitTotal: Math.round(gbit * 1000), srvCores: cpu ? round(cpu.cpuSec / cpu.wallSec, 2) : null, cpuMsPerMbit: cpu ? round((cpu.cpuSec * 1000) / cpu.wallSec / (gbit * 1000), 4) : null, lagP99: l.p99, lagMax: l.max, rssMb: cpu && cpu.rssMb, handles: cpu && cpu.handles, threads: cpu && cpu.threads };
    out.push(row);
    table([row], Object.keys(row));
  }
  // (c) a slow client: one viewer that stops reading. Does the server buffer the film in memory?
  {
    const before = samp.last();
    const net = require("net");
    const u = new URL(srv.url);
    const socks = [];
    for (let i = 0; i < 20; i++) {
      const s = net.connect(+u.port, u.hostname);
      s.on("error", () => {});
      s.write(`GET ${srv.titles.hdr.url || srv.titles.hdr.videoUrl} HTTP/1.1\r\nHost: x\r\nX-Session: ${srv.sessions[0].sid}\r\n\r\n`);
      s.pause(); // never read
      socks.push(s);
    }
    await sleep(8000);
    const after = samp.last();
    const row = { test: "20 clients that never read (198 MB file each)", rssBeforeMb: mb(before.rss), rssAfterMb: mb(after.rss), handles: after.handles };
    out.push(row);
    table([row], Object.keys(row));
    socks.forEach((s) => s.destroy());
    await sleep(3000);
    const freed = samp.last();
    out.push({ test: "…after they disconnect", rssAfterMb: mb(freed.rss), handles: freed.handles });
    table([out[out.length - 1]], ["test", "rssAfterMb", "handles"]);
  }
  samp.stop();
  await srv.stop();
  saveJson("load-direct.json", { host: host(), threadpool: process.env.UV_THREADPOOL_SIZE || "4 (node default)", rows: out });
};

// ---------- idle devices ----------
const ws = async () => {
  const profiles = 200;
  const srv = await start({ ...SHAPE, profiles });
  const samp = procSampler(srv.pid, 1000);
  const out = [];
  const stats = new Stats();
  const devices = [];
  await sleep(3000);
  const base = samp.last();
  let prev = base;
  for (const target of [100, 500, 1000, 2000]) {
    const lag = lagProbe(srv.url);
    while (devices.length < target) {
      const batch = [];
      for (let i = 0; i < 50 && devices.length < target; i++) {
        const d = new Device(srv, devices.length, "idle", stats, { refetchOnUpdate: true });
        devices.push(d);
        batch.push(d.connectWs());
      }
      await Promise.all(batch);
    }
    await sleep(6000);
    const now = samp.last();
    const l = lag.cut(); lag.stop();
    const open = devices.filter((d) => d.ws && d.ws.readyState === 1).length;
    const row = { test: `${target} idle WebSockets`, open, rssMb: mb(now.rss), kbPerSocket: round((now.rss - base.rss) / 1024 / target, 1), handles: now.handles, idleCores: round((now.cpu - prev.cpu) / ((now.t - prev.t) / 1000), 3), lagP99: l.p99 };
    prev = now;
    out.push(row);
    table([row], Object.keys(row));
    if (target === 100 || target === 500 || target === 2000) {
      // every device is told the library changed, and does what the web client does: refetch three things
      stats.by.clear();
      const lag2 = lagProbe(srv.url, 100);
      const t0 = Date.now();
      await fetch(`${srv.url}/api/admin/rescan`, { method: "POST", headers: { "X-Admin-Password": srv.adminPassword } });
      // wait until the refetches are answered
      for (let i = 0; i < 600; i++) { await sleep(100); const h = stats.by.get("home"); if (h && h.n >= open) break; }
      const t1 = Date.now();
      await sleep(1100);
      const cpu = samp.cpuBetween(t0, t1 + 1000);
      const l2 = lag2.cut(); lag2.stop();
      const home = stats.row("home", (t1 - t0) / 1000) || {};
      const row2 = { test: `library_updated to ${open} devices -> each refetches library+state+home`, stormSecs: round((t1 - t0) / 1000, 1), requests: stats.total().n, errors: stats.total().err, codes: JSON.stringify(stats.rows().reduce((a, r) => { for (const k of Object.keys(r.codes)) a[k] = (a[k] || 0) + r.codes[k]; return a; }, {})), homeP50: home.p50, homeP99: home.p99, homeMax: home.max, lagP99: l2.p99, lagMax: l2.max, srvCpuSec: cpu ? round(cpu.cpuSec, 1) : null, rssMb: cpu && cpu.rssMb };
      out.push(row2);
      table([row2], Object.keys(row2));
      await sleep(3000);
    }
  }
  // everyone drops at once (a server restart seen from the server's side: the reconnect wave)
  const t0 = Date.now();
  devices.forEach((d) => d.stop());
  await sleep(5000);
  const after = samp.last();
  out.push({ test: "all sockets closed", rssMb: mb(after.rss), handles: after.handles, secs: round((Date.now() - t0) / 1000, 1) });
  table([out[out.length - 1]], ["test", "rssMb", "handles"]);
  samp.stop();
  await srv.stop();
  saveJson("load-ws.json", { host: host(), rows: out });
};

// ---------- more encodes than the server allows ----------
const overload = async () => {
  const srv = await start({ ...SHAPE, films: 20, shows: 2 });
  const out = [];
  const T = srv.titles;
  const c = new Client(srv.url, { sid: srv.sessions[0].sid, maxSockets: 32 });
  const note = (what, r) => { const row = { step: what, status: r.status, ms: round(r.ms, 0), said: (r.text || "").slice(0, 70).replace(/\n/g, " ") }; out.push(row); table([row], ["step", "status", "ms", "said"]); };
  const seg = (item, v, k = 0) => c.text(`/stream/transcode/${srv.vid(item)}/jit/seg${String(k).padStart(5, "0")}.ts?v=${v}`).then((r) => ({ ...r, text: r.status === 200 ? `(${r.text.length} bytes)` : r.text }));
  const master = (item, q) => c.text(`/stream/transcode/${srv.vid(item)}/jit/master.m3u8${q}`);
  note("viewer 1: title A, full encode (h264) seg0", await seg(T.hevc[0], "h264"));
  note("viewer 2: title B, full encode (h264) seg0", await seg(T.hevc[1], "h264"));
  note("viewer 3: title C master?top=h264 (needs an encoder)", await master(T.hevc[2], "?top=h264"));
  note("viewer 3: title C seg0 v=h264", await seg(T.hevc[2], "h264"));
  note("viewer 3: title C playlist v=h264", await c.text(`/stream/transcode/${srv.vid(T.hevc[2])}/jit/index.m3u8?v=h264`));
  note("viewer 4: title A again, same rendition (shares the segments)", await seg(T.hevc[0], "h264"));
  note("viewer 5: title A far ahead (seg 4) while viewer 1 is at seg 0", await seg(T.hevc[0], "h264", 4));
  note("viewer 6: a copy (remux) of another title — copies are not capped", await seg(T.remux, "copy"));
  note("viewer 7: lower rung 720p of the remux title (courtesy rung)", await seg(T.remux, "h264-720"));
  note("viewer 7: its master playlist (which rungs are offered now?)", await master(T.remux, ""));
  const h = await adminHealth(srv);
  out.push({ step: "ffmpeg processes alive (watchdog's count)", status: h && h.now ? h.now.ffmpeg : "?" });
  // the older single-rendition route, for the same question
  note("legacy route: title C /0/index.m3u8?v=h264 while 2 encodes run", await c.text(`/stream/transcode/${srv.vid(T.hevc[2])}/0/index.m3u8?v=h264`));
  const logs = srv.log().filter((l) => /\[jit\]|busy|refus|503/i.test(l)).slice(-25);
  await srv.stop();
  saveJson("load-overload.json", { host: host(), rows: out, serverLog: logs });
  console.log("\nserver log:\n" + logs.join("\n"));
};

// ---------- many devices, one thing that is not made yet ----------
const stampede = async () => {
  const srv = await start({ ...SHAPE, films: 60, shows: 2 });
  const samp = procSampler(srv.pid, 500);
  const out = [];
  const c = new Client(srv.url, { sid: srv.sessions[0].sid, maxSockets: 256 });
  const burst = async (name, n, pathOf) => {
    const lag = lagProbe(srv.url, 100);
    const before = srv.log().length;
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => c.get(pathOf(i), { compressed: false })));
    const t1 = Date.now();
    await sleep(600);
    const l = lag.cut(); lag.stop();
    const ms = rs.map((r) => r.ms);
    const codes = {}; for (const r of rs) codes[r.status] = (codes[r.status] || 0) + 1;
    const spawned = srv.log().slice(before).filter((x) => /\[jit\] producer .* from seg/.test(x)).length;
    const cpu = samp.cpuBetween(t0, t1 + 500);
    const row = { test: name, n, wallMs: t1 - t0, p50: round(pct(ms, 50), 0), max: round(Math.max(...ms), 0), codes: JSON.stringify(codes), jitProducersStarted: spawned, lagMax: l.max, srvCpuSec: cpu ? round(cpu.cpuSec, 2) : null };
    out.push(row);
    table([row], Object.keys(row));
  };
  const films = srv.library.movies.filter((m) => m.cover);
  const q = (u, s) => `${u}${u.includes("?") ? "&" : "?"}${s}`;
  await burst("100 requests, the SAME uncached picture variant", 100, () => q(films[0].cover, "w=480"));
  await burst("100 requests, 50 DIFFERENT uncached variants (2 each)", 100, (i) => q(films[1 + (i % 50)].cover, "w=640"));
  await burst("the same 100 again (now cached)", 100, (i) => q(films[1 + (i % 50)].cover, "w=640"));
  await burst("60 requests, arbitrary ?w= values on one picture (ladder snapping)", 60, (i) => q(films[2].cover, `w=${65 + i * 31}`));
  await burst("40 requests, blur 1..8 x 5 widths on one picture", 40, (i) => q(films[3].cover, `w=${[240, 480, 800, 1280, 1920][i % 5]}&blur=${1 + (i % 8)}`));
  await burst("30 viewers ask for the same uncached remux segment 0", 30, () => `/stream/transcode/${srv.vid(srv.titles.remux)}/jit/seg00000.ts`);
  await burst("30 viewers ask for the same uncached ENCODED segment 0", 30, () => `/stream/transcode/${srv.vid(srv.titles.hevc[0])}/jit/seg00000.ts?v=h264`);
  await burst("20 embedded-subtitle requests for the same uncached track", 20, () => `/stream/embedded/${srv.vid(srv.titles.remux)}/0`);
  samp.stop();
  const vttLines = srv.log().filter((l) => /vtt|subtitle/i.test(l)).slice(-5);
  await srv.stop();
  saveJson("load-stampede.json", { host: host(), rows: out, vttLines });
};

// ---------- start-up ----------
const boot = async () => {
  const out = [];
  for (const shape of [{ films: 20, shows: 2 }, { films: 150, shows: 30 }, { films: 600, shows: 60 }]) {
    const t0 = Date.now();
    const srv = await start({ ...shape, profiles: 5 });
    // a second boot of the same instance would reuse data/metadata-cache.json; this is the FIRST boot (cold probe of every file)
    const samp = procSampler(srv.pid, 1000);
    await sleep(2500);
    const s = samp.last();
    const files = shape.films + 7 + shape.shows * 8;
    const row = { library: `${shape.films + 7} films, ${shape.shows} shows (${files} files)`, coldBootToProbedSec: round((Date.now() - t0 - 2500) / 1000, 1), probeMsPerFile: round(srv.enrichMs / files, 0), rssMb: s ? mb(s.rss) : null, handles: s && s.handles };
    out.push(row);
    table([row], Object.keys(row));
    samp.stop();
    await srv.stop();
  }
  saveJson("load-boot.json", { host: host(), rows: out });
};

const tests = { endpoints, mix, direct, ws, overload, stampede, boot };
const main = async () => {
  const which = process.argv[2];
  if (which === "all") { for (const k of Object.keys(tests)) { console.log(`\n===== ${k} =====`); await tests[k](); } }
  else if (tests[which]) await tests[which]();
  else { console.log(`usage: node tools/capacity/load.js <${Object.keys(tests).join("|")}|all>`); process.exit(1); }
  process.exit(0);
};
main().catch((e) => { console.error(e); process.exit(1); });

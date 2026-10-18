#!/usr/bin/env node
// The "power user" against a PRIVATE Aurora instance: the heaviest normal use
// a person makes of the screens, to size the per-device rate limits
// (lib/ratelimit.js) so that normal use is never refused.
//
//   node tools/resilience/poweruser.js [--minutes 10] [--pattern web|tv|both] [--devices 2]
//
// Each device is a SIGNED-IN profile (its own session — the strictest key:
// no LAN allowance), and two devices share one address (a household behind
// one NAT). Per device, all the time, on top of each other:
//   - a screen every second: Home, Movies (the library + the catalogue rows
//     and genres), Shows, My List, a catalogue title page (meta, More like
//     this, the collection, X-Ray, the trailer), a library title;
//   - a 10-letter search typed at 10 letters a second, every 3 s — every
//     letter asks /api/search (and its second phase), the suggestions, and
//     on the web the catalogue search too (no debounce assumed: worse than
//     the real website, whose box waits 180 ms);
//   - every 20 s: ten title pages and ten person sheets in a row, one every
//     300 ms;
//   - every 2 s: the Movies grid flung — 50 (web) / 80 (TV) pictures nobody
//     asked for before (/img/ext misses), at once;
//   - the TV pattern also prefetches the focused card's title and More like
//     this five times a second while it scrolls a row (intent prefetch).
// It records, per rate-limit group, every request it makes, and reports the
// peak in any 1 s and the busiest 10 s, and every 429 it got (must be 0).
// Then a HAMMER (a script, not a person: 200 searches a second) must be refused.
"use strict";
const path = require("path");
const http = require("http");
const fs = require("fs");

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MINUTES = Number(arg("minutes", 10));
const PATTERN = arg("pattern", "both");
const DEVICES = Number(arg("devices", 2));
const REPO = path.join(__dirname, "..", "..");
const ratelimit = require(path.join(REPO, "src", "lib", "ratelimit"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- a fake outside world: quick answers for every provider ----------
const fake = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url.includes("/meta/")
      ? { meta: { id: "tt1", name: "Fake Title", releaseInfo: "2001", genres: ["Drama"], description: "fake", cast: ["A Person"] } }
      : { metas: [{ id: "tt1", name: "Fake", poster: "https://images.metahub.space/poster/small/tt1/img", releaseInfo: "2001" }], results: [], subtitles: [], cast: [], crew: [] }));
  }, 15);
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const get = (base, url, headers) => new Promise((resolve) => {
  const req = http.get(base + url, { agent, headers, timeout: 30000 }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); res.on("error", () => resolve(0)); });
  req.on("timeout", () => req.destroy());
  req.on("error", () => resolve(0));
});

// ---------- one device ----------
const device = (srv, name, headers, pattern, stopAt, log) => {
  const ask = async (url) => {
    const group = ratelimit.groupOf("GET", url.split("?")[0]) || (url.startsWith("/img/ext") ? "img-fetch" : null);
    const t = Date.now();
    const st = await get(srv.url, url, headers);
    log.push({ t, group, st, dev: name, url: url.slice(0, 60) });
    return st;
  };
  let n = 0;
  const uniq = () => `${name}${++n}${Math.floor(Math.random() * 1e6)}`;
  const tt = () => `tt${7000000 + Math.floor(Math.random() * 900000)}`;
  const titlePage = (id) => Promise.all([
    ask(`/api/discover/meta/movie/${id}`),
    ask(`/api/discover/similar/movie/${id}`),
    ask(`/api/discover/collection/movie/${id}`),
    ask(`/api/xray?type=movie&imdbId=${id}`),
    ask(`/api/trailer?type=movie&imdbId=${id}`),
  ]);
  const screens = [
    () => ask("/api/home"),
    () => Promise.all([ask("/api/library"), ask("/api/catalog?type=movie&category=trending&page=0"), ask("/api/catalog?type=movie&category=top&page=0"), ask("/api/catalog/genres?type=movie")]),
    () => Promise.all([ask("/api/library"), ask("/api/catalog?type=show&category=trending&page=0"), ask("/api/catalog/genres?type=show")]),
    () => ask("/api/watchlist"),
    () => titlePage(tt()),
    () => srv.items.length ? ask(`/api/item/${srv.items[n % srv.items.length]}`) : ask("/api/library"),
  ];
  const loops = [];
  // a screen a second
  loops.push((async () => { let i = 0; while (Date.now() < stopAt) { screens[i++ % screens.length]().catch(() => {}); await sleep(1000); } })());
  // a search typed at 10 letters a second, every 3 s
  loops.push((async () => {
    while (Date.now() < stopAt) {
      const word = `zq${uniq()}abcdefgh`.slice(0, 10);
      for (let k = 1; k <= 10 && Date.now() < stopAt; k++) {
        const q = encodeURIComponent(word.slice(0, k));
        ask(`/api/search?v=2&q=${q}`);
        ask(`/api/search?v=2&q=${q}&wait=1`);
        ask(`/api/search/suggest?v=2&q=${q}`);
        if (pattern === "web") ask(`/api/discover/search?q=${q}`);
        await sleep(100);
      }
      await sleep(2000);
    }
  })());
  // ten title pages and ten person sheets in a row, every 20 s
  loops.push((async () => {
    await sleep(5000);
    while (Date.now() < stopAt) {
      for (let k = 0; k < 10 && Date.now() < stopAt; k++) {
        titlePage(tt()).catch(() => {});
        ask(`/api/person/${encodeURIComponent(`A Person ${uniq()}`)}?of=${tt()}&type=movie`);
        await sleep(300);
      }
      await sleep(17000);
    }
  })());
  // the Movies grid flung: pictures nobody asked for before
  loops.push((async () => {
    const fling = pattern === "tv" ? 80 : 50;
    while (Date.now() < stopAt) {
      for (let k = 0; k < fling; k++) ask(`/img/ext?u=${encodeURIComponent(`https://images.metahub.space/poster/medium/${tt()}/img`)}&w=240`);
      await sleep(2000);
    }
  })());
  // the TV: the focused card's title and More like this, five times a second
  if (pattern === "tv") loops.push((async () => { while (Date.now() < stopAt) { const id = tt(); ask(`/api/discover/meta/movie/${id}`); ask(`/api/discover/similar/movie/${id}`); await sleep(200); } })());
  return Promise.all(loops);
};

const peaks = (log) => {
  const out = {};
  for (const g of Object.keys(ratelimit.GROUPS)) {
    const ts = log.filter((e) => e.group === g).map((e) => e.t).sort((a, b) => a - b);
    let p1 = 0, p10 = 0;
    for (let i = 0, j = 0, k = 0; i < ts.length; i++) {
      while (ts[i] - ts[j] >= 1000) j++;
      while (ts[i] - ts[k] >= 10000) k++;
      p1 = Math.max(p1, i - j + 1);
      p10 = Math.max(p10, i - k + 1);
    }
    out[g] = { total: ts.length, peak1s: p1, peak10sPerSec: Math.round((p10 / 10) * 10) / 10 };
  }
  return out;
};

(async () => {
  const { start } = require(path.join(REPO, "scripts", "ui-test-server.js"));
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const srv = await start({
    preload: [path.join(__dirname, "preload.js")],
    env: { AURORA_FAKE_UPSTREAM: `http://127.0.0.1:${fake.address().port}` },
    config: { onlineMetadata: false }, // (rate limits: the code's defaults — "enforce")
  });
  const adminH = { "X-Admin-Password": srv.adminPassword, "Content-Type": "application/json" };
  const post = async (url, body, headers = {}) => { const r = await fetch(srv.url + url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); return r.json(); };
  try {
    const lib = await (await fetch(`${srv.url}/api/library`)).json();
    srv.items = [...(lib.movies || []), ...(lib.shows || [])].map((m) => m.id).filter(Boolean);
    const patterns = PATTERN === "both" ? ["web", "tv"] : [PATTERN];
    const report = { minutes: MINUTES, devices: DEVICES, limits: ratelimit.GROUPS, runs: [] };
    for (const pattern of patterns) {
      // signed-in devices: a profile each, a session each, all from one address
      const sessions = [];
      for (let d = 0; d < DEVICES; d++) {
        const name = `Pu${pattern}${d}${Date.now().toString(36).slice(-4)}`;
        const password = "pw-" + name.toLowerCase();
        const { request } = await post("/api/profiles", { name, password, realName: `${name} Tester`, avatar: "🦊", color: "#2c9fe0" });
        const p = await post(`/api/admin/profile-requests/${request.id}/approve`, {}, adminH);
        const { token } = await post(`/api/profiles/${p.id}/unlock`, { password });
        await post("/api/auth/claim", { profileId: p.id, username: name.toLowerCase() }, { "X-Profile-Token": token });
        const login = await post("/api/auth/login", { username: name.toLowerCase(), password });
        sessions.push({ name, headers: { "X-Session": login.session } });
      }
      const log = [];
      const stopAt = Date.now() + MINUTES * 60 * 1000;
      console.error(`[poweruser] ${pattern}: ${DEVICES} signed-in devices behind one address, ${MINUTES} min`);
      await Promise.all(sessions.map((s) => device(srv, s.name, s.headers, pattern, stopAt, log)));
      await sleep(2000);
      const refused = log.filter((e) => e.st === 429);
      const run = { pattern, requests: log.length, refused: refused.length, refusedByGroup: {}, perDevicePeaks: {} };
      for (const e of refused) run.refusedByGroup[e.group || e.url] = (run.refusedByGroup[e.group || e.url] || 0) + 1;
      for (const s of sessions) run.perDevicePeaks[s.name] = peaks(log.filter((e) => e.dev === s.name));
      // the worst device, per group, and the headroom the limits leave
      run.worst = {};
      for (const g of Object.keys(ratelimit.GROUPS)) {
        const p1 = Math.max(...Object.values(run.perDevicePeaks).map((p) => p[g].peak1s));
        const p10 = Math.max(...Object.values(run.perDevicePeaks).map((p) => p[g].peak10sPerSec));
        const L = ratelimit.GROUPS[g];
        run.worst[g] = { peak1s: p1, peak10sPerSec: p10, burst: L.burst, rate: L.rate, burstHeadroom: p1 ? Math.round((L.burst / p1) * 10) / 10 : null, rateHeadroom: p10 ? Math.round((L.rate / p10) * 10) / 10 : null };
      }
      report.runs.push(run);
      console.error(JSON.stringify({ pattern, requests: run.requests, refused: run.refused, refusedByGroup: run.refusedByGroup }));
      console.error(Object.entries(run.worst).map(([g, w]) => `  ${g.padEnd(10)} peak ${String(w.peak1s).padStart(4)} in 1 s, ${String(w.peak10sPerSec).padStart(5)}/s over 10 s | limit burst ${w.burst} (${w.burstHeadroom}x), ${w.rate}/s (${w.rateHeadroom}x)`).join("\n"));
    }
    // the hammer: a script, 200 searches a second for 5 s, with a session
    {
      const h = sessions0 => sessions0;
      const name = `Hammer${Date.now().toString(36).slice(-4)}`;
      const password = "pw-" + name.toLowerCase();
      const { request } = await post("/api/profiles", { name, password, realName: `${name} Tester`, avatar: "🦊", color: "#2c9fe0" });
      const p = await post(`/api/admin/profile-requests/${request.id}/approve`, {}, adminH);
      const { token } = await post(`/api/profiles/${p.id}/unlock`, { password });
      await post("/api/auth/claim", { profileId: p.id, username: name.toLowerCase() }, { "X-Profile-Token": token });
      const login = await post("/api/auth/login", { username: name.toLowerCase(), password });
      const headers = { "X-Session": login.session };
      const codes = {};
      const stopAt = Date.now() + 5000;
      const jobs = [];
      while (Date.now() < stopAt) {
        for (let k = 0; k < 20; k++) jobs.push(get(srv.url, `/api/search?v=2&q=hammer${k}${Date.now()}`, headers).then((st) => { codes[st] = (codes[st] || 0) + 1; }));
        await sleep(100);
      }
      await Promise.all(jobs);
      report.hammer = { requests: jobs.length, codes };
      console.error(`[poweruser] hammer (200 searches/s for 5 s): ${JSON.stringify(codes)}`);
      void h;
    }
    const out = arg("out", null);
    if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await srv.stop();
    fake.close();
    agent.destroy();
    setTimeout(() => process.exit(0), 300).unref();
  }
})().catch((e) => { console.error(e); process.exit(1); });

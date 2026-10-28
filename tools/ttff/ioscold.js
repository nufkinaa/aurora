#!/usr/bin/env node
// A COLD start of a repackaged (jit copy) film on an iPhone's own player,
// replayed request by request against a private instance of THIS working
// tree — what Safari's native HLS asks for, in the order it asks, through a
// shaped line, timed from the press. (Real Safari cannot run here: its rule
// for WHEN it shows the first frame is assumed — see "Safari" below.)
//
//   node tools/ttff/ioscold.js --label base --title silo1 --runs 3
//   node tools/ttff/ioscold.js --label base --tree base --title silo1,project --at 0.4
//   node tools/ttff/ioscold.js --label base --title project --at 0.4 --down 10400   (a 6 Mbit/s film on 25.9 Mbit/s)
//   node tools/ttff/ioscold.js --report base
//
// The sequence (public/js/screens/player.js, js/airplay.js, prefetch.js):
//   t=0        the player opens: prestart's own playlist fetch, with the start
//              hint (X-Aurora-Start) — the server begins the first segment
//   t=+20ms    the element is given the plain playlist (video.src): AVPlayer
//              asks for the playlist, then init.mp4, then segment after segment,
//              one at a time
//   t=+120ms   (--twin) an Apple TV is in reach on a closed server: the element
//              is moved to the AirPlay twin (/air/<token>/…) — the requests in
//              flight are dropped and AVPlayer starts over on the new address
//   resume     (--at f: a fraction of the film) the element is given the
//              address with ?start= (playstart.js nativeStartUrl). A playlist
//              with EXT-X-START: AVPlayer begins there. Without (an older
//              server): it takes the TOP of the film first and is moved at
//              loadedmetadata (--detour, below)
//
// Safari (ASSUMED, not measured): AVPlayer plays a segment only once it holds
// all of it (no partial segments without LL-HLS) and starts when it holds
// --need seconds of film from the start point (default 0: the first whole
// segment; 6 / 10 / 20 to see what a longer appetite would cost). A COLD
// instance: fresh for every run, no segment table, no segment, nothing warm
// (nufurora: local NVMe — the file in the OS cache here is the fair model).
// --down / --rtt: the line (default 25.9 Mbit/s, 74 ms: elia's iPhone report).
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const ttff = require("./lib");

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); if (i < 0) return dflt; const v = argv[i + 1]; return v == null || v.startsWith("--") ? true : v; };
const flag = (name) => argv.includes(`--${name}`);
const LABEL = String(arg("label", `ios-${Date.now().toString(36)}`));
const MEDIA = String(arg("media", "E:/aurora-stall-media"));
const TITLES = String(arg("title", "silo1")).split(",");
const RUNS = Number(arg("runs", 3));
const AT = Number(arg("at", 0)); // fraction of the film (0 = the top)
const TWIN = !flag("no-twin");
const PRESTART = !flag("no-prestart");
const NEED = Number(arg("need", 0));
const DETOUR = String(arg("detour", "full"));
// how many segments from the top a native player takes before its seek lands
// (Chrome's own HLS: 2 — segment 0 and segment 1 whole; vps.js iphone-jit-resume)
const DETOUR_SEGS = Number(arg("detour-segs", 2));
const SEGS = Number(arg("segs", 4)); // segments fetched after the first frame's
const TREE = arg("tree", null);
const SETTLE = Number(arg("settle", 20));
const LINE = { down: Number(arg("down", 25900)), up: 10000, latency: Number(arg("rtt", 74)) / 2 };
const OUT_DIR = path.join(__dirname, ".runs");
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, `ios-${LABEL}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


// ---- the instance (8 real cores, as nufurora: one thread of each of this PC's 8)
const affinityPreload = () => {
  const file = path.join(OUT_DIR, "ios-affinity.js");
  fs.writeFileSync(file, `"use strict";
try { require("child_process").spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + process.pid + ").ProcessorAffinity = ${0x5555}"], { windowsHide: true, timeout: 20000 }); } catch (e) {}
`);
  return file;
};
const SEED_DIR = path.join(OUT_DIR, `ios-seed-${String(MEDIA).replace(/[^a-z0-9]+/gi, "_")}`);
const seedFiles = () => {
  const out = {};
  const walk = (d, rel) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p, rel + f + "/"); else out[rel + f] = fs.readFileSync(p, "utf8"); } };
  walk(SEED_DIR, "");
  return out;
};
const startInst = async () => {
  const server = require(TREE ? path.join(require("./snapshot").treeDir(TREE), "scripts", "ui-test-server.js") : "../../scripts/ui-test-server");
  const preload = [affinityPreload()];
  const env = {};
  const srv = await server.start({
    preload, env, waitForLibrary: false, seed: seedFiles(),
    config: { libraries: { movies: [path.join(MEDIA, "movies")], shows: [path.join(MEDIA, "shows")] }, hwEncode: "off" },
  });
  const slog = [];
  let seen = 0;
  const poll = setInterval(() => {
    const all = srv.log();
    const fresh = all.length >= seen ? all.slice(seen) : all;
    seen = all.length;
    for (const line of fresh) slog.push({ t: Date.now(), line });
  }, 50);
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const admin = { "X-Admin-Password": srv.adminPassword };
  // a profile with a sign-in of its own (test values, this instance only)
  const name = `I${Date.now().toString(36).slice(-5)}`;
  const username = name.toLowerCase();
  const password = `pass-${username}`;
  const { request } = await call("POST", "/api/profiles", { name, password, realName: `${name} Tester`, avatar: "🦊", color: "#2c9fe0" });
  const p = await call("POST", `/api/admin/profile-requests/${request.id}/approve`, {}, admin);
  const token = (await call("POST", `/api/profiles/${p.id}/unlock`, { password })).token;
  const th = token ? { "X-Profile-Token": token } : {};
  await call("POST", "/api/auth/claim", { profileId: p.id, username, password }, th).catch(async () => call("POST", "/api/auth/claim", { profileId: p.id, username }, th));
  await call("POST", "/api/admin/auth-mode", { mode: "closed" }, admin);
  const login = await call("POST", "/api/auth/login", { username, password });
  const sh = { "X-Session": login.session, "X-Profile": p.id };
  let lib = null;
  for (const until = Date.now() + 600000; Date.now() < until; await sleep(1000)) {
    try { lib = await call("GET", "/api/library", undefined, sh); } catch { lib = null; }
    if (lib && lib.enriched && lib.movies.length && lib.movies.filter((m) => m.duration > 0).length >= lib.movies.length - 1) break;
  }
  try {
    if (!fs.existsSync(SEED_DIR)) {
      fs.mkdirSync(path.join(SEED_DIR, "cache"), { recursive: true });
      for (const f of fs.readdirSync(srv.dataDir)) if (/^(metadata-cache|imdb-map|intro-auto)\.json$/.test(f)) fs.copyFileSync(path.join(srv.dataDir, f), path.join(SEED_DIR, f));
      for (const f of fs.readdirSync(path.join(srv.dataDir, "cache"))) if (/^(library-walk|encode-calibration|probe|probes|tonemap)/.test(f) && fs.statSync(path.join(srv.dataDir, "cache", f)).isFile()) fs.copyFileSync(path.join(srv.dataDir, "cache", f), path.join(SEED_DIR, "cache", f));
    }
  } catch {}
  const titles = {};
  for (const m of lib.movies) titles[m.title.toLowerCase().split(" ")[0]] = { id: m.id, title: m.title, duration: m.duration };
  for (const s of lib.shows) {
    const full = await call("GET", `/api/item/${s.id}`, undefined, sh);
    for (const se of full.seasons || []) for (const e of se.episodes || []) titles[`${s.title.toLowerCase().split(" ")[0]}${e.episode}`] = { id: e.id, title: `${s.title} E${e.episode}`, duration: e.duration };
  }
  return { srv, slog, titles, sh, call, profileId: p.id, stop: async () => { clearInterval(poll); await srv.stop(); } };
};

// ---- one HTTP request through the line, abortable
const request = (base, p, headers, t0) => {
  const u = new URL(base + p);
  const r = { p: p.replace(/\/air\/[^/]+/, "/air/…").slice(0, 110), s: Date.now() - t0, b: null, e: null, n: 0, st: null, srv: null, aborted: false };
  let req = null;
  const done = new Promise((resolve) => {
    req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { "User-Agent": "AppleCoreMedia/1.0.0.22H20 (iPhone; U; CPU OS 18_7 like Mac OS X; en_us)", ...headers } }, (res) => {
      r.b = Date.now() - t0;
      r.st = res.statusCode;
      const st = String(res.headers["server-timing"] || "");
      if (st) { r.srv = {}; for (const part of st.split(",")) { const m = /^\s*([\w-]+)(?:;.*?dur=([\d.]+))?/.exec(part); if (m) r.srv[m[1]] = m[2] != null ? Math.round(parseFloat(m[2])) : true; } }
      const chunks = [];
      res.on("data", (c) => { r.n += c.length; if (r.n < 2e6 && /m3u8/.test(p)) chunks.push(c); });
      res.on("end", () => { r.e = Date.now() - t0; r.body = Buffer.concat(chunks).toString("utf8"); resolve(r); });
      res.on("error", () => resolve(r));
    });
    req.on("error", () => resolve(r));
    req.end();
  });
  return { r, done, abort: () => { r.aborted = true; r.e = Date.now() - t0; try { req.destroy(); } catch {} } };
};

// ---- the iPhone's start
const iphoneStart = async (inst, t, base) => {
  const plain = `/stream/transcode/${t.id}/jit/index.m3u8?seg=fmp4&vtag=hvc1`;
  const resume = AT > 0 ? Math.round(t.duration * AT) : 0;
  // the player's resume point (resumePoint: four seconds early) and the
  // address the element is given (nativeStartUrl; an older server ignores it)
  const startAt = resume ? resume - 4 : 0;
  const elementUrl = startAt > 0 ? `${plain}&start=${startAt}&until=${Math.floor(Date.now() / 1000) + 300}` : plain;
  if (resume) await inst.call("POST", `/api/profiles/${inst.profileId}/progress`, { itemId: t.id, position: resume, duration: t.duration }, inst.sh);
  const reqs = [];
  const t0 = Date.now();
  const go = (p, headers = inst.sh) => { const q = request(base, p, headers, t0); reqs.push(q.r); return q; };
  // the twin's link, asked for as the player does (in parallel with the start)
  const linkP = TWIN ? inst.call("POST", "/api/airplay/link", { path: plain.replace("?seg=fmp4&vtag=hvc1", "?seg=fmp4&vtag=hvc1"), profile: inst.profileId }, inst.sh).catch(() => null) : null;
  if (PRESTART) go(plain, { ...inst.sh, "X-Aurora-Start": `at=${startAt}` });
  await sleep(20);
  // AVPlayer on the plain address
  let addr = elementUrl;
  let abortAll = null;
  const avplayer = async (pl, startOver) => {
    let stop = false;
    const inflight = new Set();
    startOver(() => { stop = true; for (const q of inflight) q.abort(); });
    const fetchOne = async (p) => { const q = go(p, /\/air\//.test(p) ? {} : inst.sh); inflight.add(q); await q.done; inflight.delete(q); return q.r; };
    const plr = await fetchOne(pl);
    if (stop || plr.st !== 200) return null;
    const lines = plr.body.split(/\r?\n/);
    const segs = [];
    let at = 0;
    for (let i = 0; i < lines.length; i++) if (/^#EXTINF:([\d.]+)/.test(lines[i])) { const d = parseFloat(RegExp.$1); segs.push({ d, at, u: lines[i + 1] }); at += d; }
    const target = Number((/#EXT-X-TARGETDURATION:(\d+)/.exec(plr.body) || [])[1]);
    const dir = pl.slice(0, pl.lastIndexOf("/") + 1);
    const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(plr.body);
    const init = await fetchOne(dir + map[1]);
    if (stop) return null;
    let k = 0;
    // EXT-X-START: the native player begins there (ASSUMED of AVPlayer; Chrome's
    // own HLS ignores the tag). Without it the element begins at 0 and is moved
    // at loadedmetadata — which Chrome's HLS fired only after the first
    // segment(s) had arrived: --detour full (default: fetch the first --detour-segs whole,
    // then seek) or drop (ask for it, drop it 60 ms later — the kindest case)
    const xStart = /#EXT-X-START:TIME-OFFSET=([\d.]+)/.exec(plr.body);
    const startSec = xStart ? parseFloat(xStart[1]) : startAt;
    if (startAt > 0 && !xStart) {
      for (let d = 0; d < (DETOUR === "drop" ? 1 : DETOUR_SEGS); d++) {
        const q0 = go(dir + segs[d].u, /\/air\//.test(pl) ? {} : inst.sh);
        inflight.add(q0);
        if (DETOUR === "drop") { await sleep(60); q0.abort(); } else await q0.done;
        inflight.delete(q0);
        if (stop) return null;
      }
    }
    if (startSec > 0) for (k = 0; k + 1 < segs.length && segs[k + 1].at <= startSec; k++);
    const got = [];
    let film = 0;
    let frameAt = null;
    for (let n = 0; k < segs.length && !stop; k++, n++) {
      const r = await fetchOne(dir + segs[k].u);
      if (stop) return null;
      got.push({ k, d: segs[k].d, r });
      film += segs[k].d;
      if (frameAt == null && film >= Math.max(NEED, 0.01)) frameAt = r.e;
      if (frameAt != null && n >= SEGS) break;
    }
    return { target, nSegs: segs.length, first: segs[0] && segs[0].d, frameAt, got, init, xStart: !!xStart };
  };
  let result = null;
  const first = avplayer(addr, (fn) => { abortAll = fn; });
  if (TWIN) {
    const link = await Promise.race([linkP, sleep(4000).then(() => null)]);
    await sleep(Math.max(0, 120 - (Date.now() - t0)));
    if (link && link.url) {
      abortAll();
      addr = link.url.replace(/^https?:\/\/[^/]+/, "");
      const inner = addr.replace(/^(\/air\/[^/]+)(\/stream\/.*?)(\?.*)?$/, "$1$2");
      result = await avplayer(inner + elementUrl.slice(elementUrl.indexOf("?")), () => {});
    }
  }
  if (!result) result = await first;
  return { t0, resume, reqs, result };
};

const report = (label) => {
  const rows = fs.readFileSync(path.join(OUT_DIR, `ios-${label}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const by = {};
  const keyOf = (r) => `${r.tree || "working"}|${r.title}|at${r.at}|${r.twin ? "twin" : "plain"}|${r.xStart ? "EXT-X-START" : "no tag"}`;
  for (const r of rows) (by[keyOf(r)] = by[keyOf(r)] || []).push(r);
  const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  console.log(`\n${label}: ms from the press (medians)`);
  console.log(["case", "n", "1st seg in hand", "seg ready on server", "2nd", "3rd", "spawns", "target", "seg0 dur"].join("\t"));
  for (const [k, list] of Object.entries(by)) {
    console.log([k, list.length, med(list.map((r) => r.frameAt)), med(list.map((r) => r.firstReady)), med(list.map((r) => r.seg2)), med(list.map((r) => r.seg3)), med(list.map((r) => r.spawns)), list[0].target, list[0].first].join("\t"));
  }
};

const main = async () => {
  if (arg("report", null)) return report(String(arg("report")));
  console.log(`ios-cold ${LABEL}: ${TITLES.join(",")} at ${AT}, ${TWIN ? "twin" : "plain"}, line ${LINE.down} kbit/s ${LINE.latency * 2} ms, ${RUNS} runs`);
  for (let run = 1; run <= RUNS; run++) {
    for (const key of TITLES) {
      let inst = null;
      let proxy = null;
      try {
        inst = await startInst();
        await sleep(SETTLE * 1000);
        const t = inst.titles[key];
        if (!t) throw new Error(`no title ${key} (${Object.keys(inst.titles).join(", ")})`);
        proxy = await ttff.throttle.start({ listen: 0, host: "127.0.0.1", to: inst.srv.port, quiet: true, handshake: true, slowstart: true, ...LINE });
        const base = `http://127.0.0.1:${proxy.port}`;
        const out = await iphoneStart(inst, t, base);
        await sleep(300);
        const res = out.result || {};
        const segReqs = (res.got || []);
        const server = inst.slog.filter((l) => l.t >= out.t0 - 100 && /\[jit\]|\[play\]/.test(l.line)).map((l) => `${l.t - out.t0} ${l.line.slice(0, 160)}`);
        const row = {
          label: LABEL, title: key, run, at: AT, twin: TWIN, line: LINE,
          target: res.target, first: res.first, nSegs: res.nSegs, xStart: !!res.xStart, tree: TREE || "working",
          frameAt: res.frameAt,
          firstReady: segReqs[0] ? segReqs[0].r.b : null,
          seg2: segReqs[1] ? segReqs[1].r.e : null,
          seg3: segReqs[2] ? segReqs[2].r.e : null,
          segs: segReqs.map((g) => ({ k: g.k, d: Math.round(g.d * 10) / 10, s: g.r.s, b: g.r.b, e: g.r.e, n: g.r.n, srv: g.r.srv })),
          spawns: server.filter((l) => /producer .* from seg/.test(l)).length,
          reqs: out.reqs.map(({ body, ...r }) => r),
          server,
        };
        fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
        console.log(`  #${run} ${key}: first segment in hand ${row.frameAt} ms (asked ${segReqs[0] && segReqs[0].r.s}, first byte ${row.firstReady}) · 2nd ${row.seg2} · 3rd ${row.seg3} · target ${row.target} s, seg0 ${row.first && row.first.toFixed(1)} s · spawns ${row.spawns}`);
        for (const r of row.reqs) console.log(`      ${String(r.s).padStart(6)} → ${String(r.b).padStart(6)} … ${String(r.e).padStart(6)}  ${r.st} ${String(r.n).padStart(9)} B ${r.aborted ? "(dropped) " : ""}${r.p}${r.srv ? " " + JSON.stringify(r.srv) : ""}`);
        for (const l of server) console.log(`      srv ${l}`);
      } catch (e) {
        console.log(`  #${run} ${key}: ${String(e.stack || e).split("\n").slice(0, 3).join(" | ")}`);
      } finally {
        if (proxy) await proxy.close().catch(() => {});
        if (inst) await inst.stop().catch(() => {});
      }
    }
  }
  report(LABEL);
};
main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// Time to first frame on a VPS-sized server: every way a play can start, on a
// private instance of THIS working tree held to a few CPUs, with no GPU and
// the sign-in wall closed (nufurora.com: a netcup KVM VPS, no GPU, closed).
// Each start is written down as a timeline, so a slow one says WHERE:
//
//   press → item → decision → playlist/probe → producer spawn → segment made
//         → first media byte → first frame
//
//   node tools/ttff/vps.js --label base --cpus 2 --runs 3
//   node tools/ttff/vps.js --label base --cpus 4 --cases jit-encode,torrent-cold
//   node tools/ttff/vps.js --report base            (the tables again)
//
//   --media     <dir>/movies + <dir>/shows: COPIES of real films (default
//               E:/aurora-stall-media, the stall rig's copies)
//   --cpus      the instance and every ffmpeg it starts are held to this many
//               logical CPUs (affinity mask, like tools/stall-rig)
//   --cases     which starts (default: all of CASES below)
//   --runs      each case this many times, each on a FRESH instance (cold)
//   --line      a tools/ttff CONDITIONS name between browser and instance
//               (default LL-HB: "a good connection")
//   --upstream  refuse | hang: what the server's own calls to the internet
//               meet (refuse: at once, as the UI tests; hang: the connection
//               is never answered — a catalogue that is down or slow)
//   --tree      the app from a snapshot (tools/ttff/snapshot.js) — a "before"
//   --open      leave the sign-in wall open (default: closed)
//
// Output: tools/ttff/.runs/vps-<label>.jsonl (one row per start) and the
// tables on stdout.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const ttff = require("./lib");

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); if (i < 0) return dflt; const v = argv[i + 1]; return v == null || v.startsWith("--") ? true : v; };
const flag = (name) => argv.includes(`--${name}`);
const LABEL = String(arg("label", `vps-${Date.now().toString(36)}`));
const MEDIA = String(arg("media", "E:/aurora-stall-media"));
const CPUS = flag("cores8") ? 8 : Number(arg("cpus", 2));
const CPU_OFFSET = Number(arg("cpu-offset", 0)); // which CPUs: from this one on (two runs side by side)
// --cores8: eight REAL cores — one hardware thread of each of this PC's eight
// (0,2,…,14), as a root server's eight dedicated cores (nufurora.com)
const CORES8 = flag("cores8");
const MASK = CORES8 ? 0x5555 : null;
const RUNS = Number(arg("runs", 3));
const LINE = String(arg("line", "LL-HB"));
const UPSTREAM = String(arg("upstream", "refuse"));
const TREE = arg("tree", null);
const CLOSED = !flag("open");
// --steal k: k busy-loop processes on the instance's CPUs (a VPS's vCPU is
// shared and slower than this PC's cores: the server gets what is left)
const STEAL = Number(arg("steal", 0));
// --busy <flavour>:<title>: another household member is already watching
// (tv-encode: the TV's H.264 offset job; tv-copy; web-encode: a browser
// without HEVC on the ladder) — read at real time for as long as the start is measured
const BUSY = arg("busy", null);
const VERBOSE = flag("verbose");
// --watch <s>: how long each start is watched after it (default 12: a fast start hands over ~10 s in)
const WATCH_MS = Number(arg("watch", 12)) * 1000;
const OUT_DIR = path.join(__dirname, ".runs");
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, `vps-${LABEL}.jsonl`);
const SEED_DIR = path.join(OUT_DIR, `vps-seed-${CPUS}-${String(MEDIA).replace(/[^a-z0-9]+/gi, "_")}`);
const seedFiles = () => {
  const out = {};
  const walk = (d, rel) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p, rel + f + "/"); else out[rel + f] = fs.readFileSync(p, "utf8"); } };
  walk(SEED_DIR, "");
  return out;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the starts ----
// title keys: the folder name lower-cased up to the first space (stall rig);
// flavour: desktop (Chrome, decodes HEVC), nohevc (a browser that does not:
// the server encodes on the CPU), iphone (iPhone UA: native HLS), tv (the TV
// app's requests, replayed — ExoPlayer cannot run here)
const CASES = {
  "direct-mp4": { title: "arrival", flavour: "desktop", what: "an MP4 played as the file" },
  "direct-mkv": { title: "knives", flavour: "desktop", what: "an HEVC+AAC MKV played as the file" },
  "jit-copy": { title: "about", flavour: "desktop", what: "HEVC + E-AC-3: video copied, sound to AAC (jit)" },
  "jit-copy-resume": { title: "about", flavour: "desktop", mode: "resume", what: "the same, resumed 40% in" },
  "jit-copy-seek": { title: "about", flavour: "desktop", mode: "seek", what: "the same, a seek 20 min ahead" },
  "jit-encode": { title: "about", flavour: "nohevc", what: "HEVC to a browser without HEVC: CPU encode" },
  "jit-encode-resume": { title: "about", flavour: "nohevc", mode: "resume", what: "the CPU encode, resumed 40% in" },
  "jit-encode-seek": { title: "about", flavour: "nohevc", mode: "seek", what: "the CPU encode, a seek 20 min ahead" },
  "offset": { title: "offsetfilm", flavour: "desktop", what: "an MKV with no index: the offset job" },
  "subs-direct": { title: "knives", flavour: "desktop", subs: true, what: "the MKV as the file, its subtitles on" },
  "subs-episode": { title: "silo1", flavour: "desktop", subs: true, what: "an episode (HEVC10 + E-AC-3), subtitles on" },
  "iphone": { title: "project", flavour: "iphone", what: "iPhone native HLS (HEVC10 fMP4 copy)" },
  "iphone-resume": { title: "project", flavour: "iphone", mode: "resume", what: "iPhone, resumed 40% in" },
  "iphone-encode": { title: "about", flavour: "iphone-h264", what: "an iPhone that cannot take the HEVC: CPU encode" },
  "tv-direct": { title: "knives", flavour: "tv", tv: "direct", what: "TV: the file (ExoPlayer's requests)" },
  "tv-offset": { title: "about", flavour: "tv", tv: "copy", what: "TV: sound it cannot play → offset copy job" },
  "tv-offset-resume": { title: "about", flavour: "tv", tv: "copy", mode: "resume", what: "TV: offset copy job, resumed 40% in" },
  "tv-encode": { title: "about", flavour: "tv", tv: "h264", what: "TV: picture it cannot play → offset H.264 encode" },
  "episode-next": { title: "silo1", flavour: "desktop", mode: "next", what: "an episode, then the Next episode button" },
  "encode-episode-next": { title: "silo1", flavour: "nohevc", mode: "next", what: "the same on a browser without HEVC: both episodes CPU-encoded" },
  "torrent-warm": { torrent: "warm", flavour: "desktop", what: "a torrent stream, its metadata cached, a quick seeder" },
  "torrent-cold": { torrent: "cold", flavour: "desktop", what: "a torrent stream, nothing cached: metadata from the peer" },
  "torrent-slow": { torrent: "slow", flavour: "desktop", what: "a torrent stream from a slow seeder (real-swarm-like)" },
};
const CASE_LIST = String(arg("cases", Object.keys(CASES).join(","))).split(",").filter(Boolean);
for (const c of CASE_LIST) if (!CASES[c]) throw new Error(`unknown case ${c}: ${Object.keys(CASES).join(", ")}`);

// ---- the instance's CPUs (as tools/stall-rig): set before any server code runs
const affinityPreload = (cpus) => {
  const file = path.join(OUT_DIR, `vps-affinity-${MASK ? "m" + MASK : cpus}-${CPU_OFFSET}.js`);
  const mask = (MASK || (2 ** cpus - 1) * 2 ** CPU_OFFSET).toString();
  fs.writeFileSync(file, `"use strict";
try { require("child_process").spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + process.pid + ").ProcessorAffinity = ${mask}"], { windowsHide: true, timeout: 20000 }); } catch (e) {}
`);
  return file;
};
// ---- the internet the instance's own calls meet: never answered
const hangPreload = () => {
  const file = path.join(OUT_DIR, "vps-upstream-hang.js");
  fs.writeFileSync(file, `"use strict";
// After the test fence (which refuses at once): connections to the internet
// are never answered instead — a catalogue that is down. Nothing leaves the PC.
const net = require("net");
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", "[::1]", "::ffff:127.0.0.1"]);
const fenced = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0] : args;
  let host = null;
  if (a[0] && typeof a[0] === "object") { if (a[0].path) return fenced.apply(this, args); host = a[0].host || a[0].hostname || "localhost"; }
  else if (typeof a[0] === "string" && !/^\\d+$/.test(a[0])) return fenced.apply(this, args);
  else host = typeof a[1] === "string" ? a[1] : "localhost";
  if (LOCAL.has(String(host).toLowerCase())) return fenced.apply(this, args);
  this.connecting = true;
  return this; // never connects, never fails: the caller's own timeout decides
};
`);
  return file;
};

// ---- CPU thieves on the same CPUs
const startSteal = (k) => {
  const { spawn } = require("child_process");
  const mask = (MASK || (2 ** CPUS - 1) * 2 ** CPU_OFFSET).toString();
  const kids = [];
  for (let i = 0; i < k; i++) {
    // (it watches for this harness on its own: a killed run leaves no thief behind)
    const c = spawn(process.execPath, ["-e", `const p=${process.pid};let i=0;for(;;){if(++i%30000000===0){try{process.kill(p,0)}catch{process.exit(0)}}}`], { stdio: "ignore", windowsHide: true });
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${c.pid}).ProcessorAffinity = ${mask}`], { windowsHide: true, timeout: 20000 });
    kids.push(c);
  }
  return () => { for (const c of kids) { try { c.kill(); } catch {} } };
};
// ---- a neighbour who is already watching: a reader at real time
const startBusy = (inst, spec) => {
  const [flavour, key] = String(spec).split(":");
  const t = inst.titles[key];
  if (!t) throw new Error(`--busy: no title ${key}`);
  const base = inst.srv.url;
  const media = { "X-Session": inst.sid, "X-Profile": inst.profile.id, "X-Aurora-Viewer": `tvbusy${Math.random().toString(36).slice(2, 8)}` };
  let stop = false;
  // a player's clock: it starts with 2 s of film in hand (ExoPlayer's
  // bufferForPlaybackMs), then runs in real time while there is film; a
  // segment that comes after the clock reached the end of what was in hand is
  // a stall (until it arrives, then 8 s in hand again — the rebuffer rule)
  const st = { startedAt: 0, stalls: 0, stallMs: 0, segs: 0, film: 0, refused: 0 };
  let clockFilm = 0; // film seconds played
  let lastTick = 0;
  let stalledSince = 0;
  const advance = () => {
    const now = Date.now();
    if (!st.startedAt) return;
    if (!stalledSince) {
      clockFilm += (now - lastTick) / 1000;
      if (clockFilm >= st.film) { clockFilm = st.film; stalledSince = now; st.stalls++; }
    }
    lastTick = now;
  };
  const loop = (async () => {
    const url = flavour === "web-encode" ? `/stream/transcode/${t.id}/jit/index.m3u8?v=h264` : `/stream/transcode/${t.id}/0/index.m3u8?v=${flavour === "tv-copy" ? "copy" : "h264"}`;
    let seen = 0;
    while (!stop) {
      const pl = await get(base, url, media);
      if (pl.status !== 200) { st.refused++; await sleep(2000); continue; }
      const lines = pl.body.toString("utf8").split(/\r?\n/);
      const segs = [];
      for (let i = 0; i < lines.length; i++) if (/^#EXTINF:([\d.]+)/.test(lines[i])) segs.push({ d: parseFloat(RegExp.$1), u: lines[i + 1] });
      for (; seen < segs.length && !stop; seen++) {
        // 50 s in hand at most (ExoPlayer's minBufferMs), as the TV keeps it
        while (!stop) { advance(); if (st.film - clockFilm <= 50) break; await sleep(250); }
        const r = await get(base, new URL(segs[seen].u, base + url).toString().replace(base, ""), media);
        if (r.status !== 200) { st.refused++; break; }
        advance();
        st.film += segs[seen].d;
        st.segs++;
        if (!st.startedAt && st.film >= 2) { st.startedAt = Date.now(); lastTick = st.startedAt; }
        if (stalledSince && st.film - clockFilm >= 8) { st.stallMs += Date.now() - stalledSince; stalledSince = 0; lastTick = Date.now(); }
      }
      await sleep(2000);
    }
  })();
  const ticker = setInterval(advance, 250);
  const fn = () => { stop = true; clearInterval(ticker); advance(); if (stalledSince) { st.stallMs += Date.now() - stalledSince; stalledSince = 0; } };
  fn.stats = () => ({ flavour, title: key, ...st, played: Math.round(clockFilm), open: !!stalledSince });
  return fn;
};

// ---- a torrent swarm on this machine (tools/stall-rig/torrent-rig.js)
const TORRENT_FILE = path.join(MEDIA, "torrent", "Rig Film (2020).mkv");
const startSwarm = async ({ slow }) => {
  const { default: Server } = await import("bittorrent-tracker/server");
  const { default: WebTorrent } = await import("webtorrent");
  const tracker = new Server({ udp: false, ws: false, http: true, stats: false });
  await new Promise((r) => tracker.listen(0, "127.0.0.1", r));
  const port = tracker.http.address().port;
  const announce = `http://127.0.0.1:${port}/announce`;
  // quick: ~3x the film's rate; slow: about the film's rate, as a thin public swarm
  const seeder = new WebTorrent({ dht: false, lsd: false, utp: false, uploadLimit: (slow ? 260 : 900) * 1024 });
  const seeded = await new Promise((res) => seeder.seed(TORRENT_FILE, { announce: [announce], pieceLength: 512 * 1024 }, res));
  return { tracker, seeder, port, infoHash: seeded.infoHash, torrentFile: Buffer.from(seeded.torrentFile), close: () => { try { seeder.destroy(); } catch {} try { tracker.close(); } catch {} } };
};

// ---- one instance: closed wall, a signed-in profile, the library probed
const startVps = async ({ swarm = null, seedTorrent = false } = {}) => {
  const server = require(TREE ? path.join(require("./snapshot").treeDir(TREE), "scripts", "ui-test-server.js") : "../../scripts/ui-test-server");
  const preload = [];
  if (CPUS > 0) preload.push(affinityPreload(CPUS));
  if (UPSTREAM === "hang") preload.push(hangPreload());
  if (swarm) preload.push(path.join(__dirname, "..", "stall-rig", "tracker-preload.js"));
  const srv = await server.start({
    preload,
    waitForLibrary: false,
    env: swarm ? { RIG_TRACKER_PORT: String(swarm.port) } : {},
    seed: { ...seedFiles(), ...(swarm && seedTorrent ? { [`cache/torrents/${swarm.infoHash}.torrent`]: swarm.torrentFile } : {}) },
    config: {
      libraries: { movies: [path.join(MEDIA, "movies")], shows: [path.join(MEDIA, "shows")] },
      hwEncode: "off",
      onlineMetadata: UPSTREAM === "hang",
      ...(swarm ? { torrents: true } : {}),
    },
  });
  // the server's log, stamped as it arrives (100 ms)
  const slog = [];
  let seen = 0;
  const poll = setInterval(() => {
    const all = srv.log();
    const fresh = all.length >= seen ? all.slice(seen) : all;
    seen = all.length;
    const t = Date.now();
    for (const line of fresh) { slog.push({ t, line }); if (VERBOSE) console.log(`   srv ${line.slice(0, 200)}`); }
  }, 100);
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const admin = { "X-Admin-Password": srv.adminPassword };
  // a profile with a sign-in of its own (test values, this instance only)
  const name = `V${Date.now().toString(36).slice(-5)}`;
  const username = name.toLowerCase();
  const password = `pass-${username}`;
  const { request } = await call("POST", "/api/profiles", { name, password, realName: `${name} Tester`, avatar: "🦊", color: "#2c9fe0" });
  const p = await call("POST", `/api/admin/profile-requests/${request.id}/approve`, {}, admin);
  const token = (await call("POST", `/api/profiles/${p.id}/unlock`, { password })).token;
  const th = token ? { "X-Profile-Token": token } : {};
  await call("PUT", `/api/profiles/${p.id}`, { lookNoticeSeen: true }, th);
  await call("POST", "/api/auth/claim", { profileId: p.id, username, password }, th).catch(async () => call("POST", "/api/auth/claim", { profileId: p.id, username }, th));
  if (CLOSED) await call("POST", "/api/admin/auth-mode", { mode: "closed" }, admin);
  const login = await call("POST", "/api/auth/login", { username, password });
  const sid = login.session;
  const sh = { "X-Session": sid, "X-Profile": p.id, ...(login.profileToken ? { "X-Profile-Token": login.profileToken } : {}) };
  let lib = null;
  const t0 = Date.now();
  let enrichedAt = 0;
  for (const until = Date.now() + 600000; Date.now() < until; await sleep(1000)) {
    try { lib = await call("GET", "/api/library", undefined, sh); } catch (e) { lib = null; if (VERBOSE) console.log(e.message); }
    if (lib && lib.enriched && !enrichedAt) enrichedAt = Date.now();
    // (a file with no duration in its header — the offset film — never gets one)
    if (lib && lib.enriched && lib.movies.length && (lib.movies.every((m) => m.duration > 0) || Date.now() - enrichedAt > 8000)) break;
  }
  // the probes of the first instance seed the next ones: a real server scanned
  // its library long before anyone pressed Play (jit tables are NOT kept)
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
    for (const se of full.seasons || []) for (const e of se.episodes || []) titles[`${s.title.toLowerCase().split(" ")[0]}${e.episode}`] = { id: e.id, showId: s.id, title: `${s.title} E${e.episode}`, duration: e.duration };
  }
  return {
    srv, slog, titles, profile: { id: p.id, name, username, password }, sid, sh, call, admin, libraryMs: Date.now() - t0,
    stop: async () => { clearInterval(poll); await srv.stop(); },
  };
};

// ---- browsers
const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};
const browsers = {};
const browserFor = async (flavour) => {
  const k = flavour === "nohevc" || flavour === "iphone-h264" ? "nohevc" : "std";
  if (!browsers[k]) browsers[k] = await ttff.launch({ noHevc: k === "nohevc" });
  return browsers[k];
};

// ---- the timeline of one start, from what the page, its network and the server said
const firstLine = (slog, t0, re) => { const l = slog.find((x) => x.t >= t0 - 50 && re.test(x.line)); return l ? Math.round(l.t - t0) : null; };
const timeline = ({ row, requests, slog, t0, marks }) => {
  const rel = (t) => (t == null ? null : Math.round(t - t0));
  const reqs = requests.filter((r) => r.start >= t0 - 30);
  const find = (pred) => reqs.find(pred) || null;
  const item = find((r) => /^\/api\/item\//.test(r.path));
  const st = find((r) => /^\/api\/profiles\/[^/]+\/state/.test(r.path));
  const probe = find((r) => /^\/api\/torrents\/probe\//.test(r.path));
  const owned = find((r) => /^\/api\/library\/for/.test(r.path));
  const pl = find((r) => r.kind === "playlist");
  const seg = reqs.filter((r) => (r.kind === "segment" || r.kind === "video") && r.status != null && r.status < 400).sort((a, b) => (a.ttfb || 1e15) - (b.ttfb || 1e15))[0] || null;
  const sub = find((r) => r.kind === "subtitle");
  const mount = row.mount;
  const markAt = (name) => { const m = marks.find((x) => x.name === name); return m && mount != null ? mount + m.ms : null; };
  return {
    mount,
    item: item ? rel(item.end) : null,
    itemSrv: item && item.server ? Math.round(item.server.app || 0) : null,
    state: st ? rel(st.end) : null,
    owned: owned ? rel(owned.end) : null,
    probe: probe ? rel(probe.end) : null,
    decision: markAt("path") ?? markAt("decision"),
    playlist: pl ? rel(pl.ttfb) : null,
    playlistSrv: pl && pl.server ? Math.round(pl.server.app || 0) : null,
    spawn: firstLine(slog, t0, /\[jit\] producer|\[remux\].*(start|spawn|ffmpeg)|\[transcode\].*start|\[torrent-hls\]|\[hls\].*start/i),
    segAsked: seg ? rel(seg.start) : null,
    segMade: seg && seg.server && seg.server.seg != null ? Math.round(seg.server.seg) : null,
    firstByte: row.firstMediaByte,
    firstFrame: row.ttff,
    subtitle: sub ? rel(sub.end) : null,
    subtitleSrv: sub && sub.server ? Math.round(sub.server.app || 0) : null,
  };
};

// ---- a start in a browser
const PRIMARY = ".detail-actions > .btn-primary";
const webStart = async (inst, cs, { swarm = null } = {}) => {
  const browser = await browserFor(cs.flavour);
  const phone = cs.flavour === "iphone" || cs.flavour === "iphone-h264";
  let proxy = null;
  let origin = inst.srv.url;
  const cond = ttff.CONDITIONS[LINE];
  if (cond) {
    proxy = await ttff.throttle.start({ listen: 0, host: "127.0.0.1", to: inst.srv.port, quiet: true, handshake: true, slowstart: true, ...cond });
    origin = `http://127.0.0.1:${proxy.port}`;
  }
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    ...(phone ? { userAgent: UA.iphone, isMobile: true, hasTouch: true } : {}),
    serviceWorkers: "block",
  });
  try {
    // sign in as the household does: the wall's own login sets the cookie
    const login = await ctx.request.post(`${origin}/api/auth/login`, { data: { username: inst.profile.username, password: inst.profile.password } });
    if (login.status() !== 200) throw new Error(`sign-in ${login.status()}`);
    const lj = await login.json();
    await ctx.addInitScript(({ id, token, subs }) => {
      try {
        if (sessionStorage.getItem("vps-seeded")) return;
        sessionStorage.setItem("vps-seeded", "1");
        localStorage.setItem("aurora-profile", id);
        localStorage.setItem("aurora-kbd-hint", "1");
        localStorage.setItem("aurora-nav-hinted", "1");
        localStorage.setItem("aurora-player", JSON.stringify({ subsDefault: !!subs, subLang: "any" }));
      } catch {}
    }, { id: inst.profile.id, token: lj.profileToken || null, subs: !!cs.subs });
    await ctx.addInitScript(ttff.PAGE_PROBE);
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    const net = await ttff.netlog(ctx, page);
    // the person's subtitle switch (person scope, on the server)
    await inst.call("PUT", `/api/profiles/${inst.profile.id}`, { prefs: { subsDefault: !!cs.subs, subLang: "any" } }, inst.sh).catch(() => {});
    await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("#app .screen", { timeout: 60000 }).catch(() => {});
    await sleep(1500);
    let t = null;
    let hash;
    if (cs.torrent) {
      hash = `#/play/${encodeURIComponent(`torrent|${swarm.infoHash}|0`)}`;
    } else {
      t = inst.titles[cs.title];
      if (!t) throw new Error(`no title ${cs.title} (${Object.keys(inst.titles).join(", ")})`);
      if (cs.mode === "resume") await inst.call("POST", `/api/profiles/${inst.profile.id}/progress`, { itemId: t.id, position: Math.round(t.duration * 0.4), duration: t.duration }, inst.sh);
      hash = t.showId ? `#/show/${t.showId}` : `#/movie/${t.id}`;
    }
    let t0;
    let since = Date.now() - 50;
    if (cs.torrent) {
      net.reset();
      await page.evaluate((h) => { location.hash = h; }, hash);
      t0 = await page.evaluate(() => performance.timeOrigin + performance.now());
    } else {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForSelector(PRIMARY, { timeout: 60000 });
      // the title page as a person sees it: a moment to read it (its own warm-up runs)
      await sleep(2500);
      if (t.showId) {
        // the episode's own row (the primary button plays the next unwatched one: E1)
      }
      net.reset();
      since = Date.now() - 50; // (before the click: the click itself is what is timed from)
      await page.click(PRIMARY);
      t0 = null;
    }
    const ok = await page.waitForFunction(() => {
      const T = window.__ttff;
      return T.videos.some((r) => { const s = r.samples; const n = s.length; return n > 6 && s[n - 1].ct - s[n - 6].ct >= 0.3 && !s[n - 1].p; });
    }, null, { timeout: 150000, polling: 100 }).then(() => true, () => false);
    // seek: 20 minutes on, as the scrubber does it; timed from the click on it
    let seek = null;
    if (ok && cs.mode === "seek") {
      await sleep(6000);
      const film = t.duration;
      const box = await page.locator(".player .scrubber").boundingBox().catch(() => null);
      await page.mouse.move(500, 250);
      await sleep(400);
      const cur = await page.evaluate(() => document.querySelector(".player video").currentTime);
      const to = Math.min(film - 120, cur + 1200);
      const b2 = await page.locator(".player .scrubber").boundingBox().catch(() => box);
      const s0 = Date.now();
      if (b2) await page.mouse.click(b2.x + b2.width * (to / film), b2.y + b2.height / 2);
      const landed = await page.waitForFunction((to) => {
        const v = document.querySelector(".player video");
        const T = window.__ttff;
        const r = T.videos[T.videos.length - 1];
        const s = r.samples; const n = s.length;
        return v && !v.seeking && n > 6 && s[n - 1].ct - s[n - 6].ct >= 0.3 && !s[n - 1].p && Math.abs((v.currentTime || 0) - (to - (r.el === v ? 0 : 0))) < 900;
      }, to, { timeout: 120000, polling: 100 }).then(() => true, () => false);
      seek = { ms: landed ? Date.now() - s0 : null, to: Math.round(to) };
    }
    // NEXT: the Next episode button in this episode's player (an episode change, as Up next makes it)
    let next = null;
    if (ok && cs.mode === "next") {
      await sleep(4000);
      await page.mouse.move(500, 250);
      const btn = '.player .pbtn[aria-label="Next episode"]';
      await page.waitForSelector(`${btn}:not(.hidden)`, { timeout: 20000 }).catch(() => {});
      const n0 = Date.now();
      const before = await page.evaluate(() => location.hash);
      await page.click(btn).catch(() => {});
      const moved = await page.waitForFunction((h) => location.hash !== h && /#\/play\//.test(location.hash), before, { timeout: 15000 }).then(() => true, () => false);
      const landed = moved && await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 0.3 && v.readyState >= 3; }, null, { timeout: 120000, polling: 100 }).then(() => true, () => false);
      next = { ms: landed ? Date.now() - n0 : null };
    }
    // choppiness: frames the browser dropped while it played (not only stalls)
    const quality0 = await page.evaluate(() => { const v = document.querySelector(".player video"); const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null; return q ? { dropped: q.droppedVideoFrames, total: q.totalVideoFrames } : null; }).catch(() => null);
    await sleep(ok ? WATCH_MS : 500);
    const quality1 = await page.evaluate(() => { const v = document.querySelector(".player video"); const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null; return q ? { dropped: q.droppedVideoFrames, total: q.totalVideoFrames } : null; }).catch(() => null);
    const dump = await page.evaluate((since) => ({ clicks: window.__ttff.clicks.filter((c) => c.t >= since - 5), nav: window.__ttff.nav.filter((n) => n.t >= since - 5), videos: window.__ttff.dump(since - 3000), hls: window.__ttff.hlsSince(since) }), since);
    if (t0 == null) t0 = (dump.clicks.filter((c) => c.type === "click")[0] || {}).t || since; // (the press on Play: a seek's click on the scrubber comes later)
    const expectFrom = cs.mode === "resume" && t ? Math.round(t.duration * 0.4) - 4 : 0;
    const row = ttff.digest({ t0, videos: dump.videos.filter((v) => v.created >= t0 - 5), requests: net.all(), watchMs: WATCH_MS, expectFrom });
    const marks = net.all().filter((r) => r.kind === "mark" && r.body).map((r) => { try { return JSON.parse(r.body); } catch { return null; } }).filter(Boolean);
    row.timeline = timeline({ row, requests: net.all(), slog: inst.slog, t0, marks });
    row.seek = seek;
    // hitches while it played (after the start): count, longest, frozen in all
    {
      const vv = dump.videos.filter((v) => v.created >= t0 - 5 && v.gaps).sort((a, b) => b.events.length - a.events.length)[0];
      const from = t0 + (row.ttff || 0) + 2000;
      const g = vv ? vv.gaps.filter((x) => x.t >= from) : [];
      row.hitches = { n: g.length, maxMs: g.reduce((m, x) => Math.max(m, x.ms), 0), frozenMs: g.reduce((m, x) => m + x.ms - 42, 0), at: g.slice(0, 12).map((x) => `${Math.round(x.t - t0)}:${x.ms}`) };
    }
    row.next = next;
    if (quality1) row.frames = { dropped: quality1.dropped, total: quality1.total, droppedLast12s: quality0 ? quality1.dropped - quality0.dropped : null, totalLast12s: quality0 ? quality1.total - quality0.total : null };
    row.hls = dump.hls.map((x) => `${x.what}${x.details ? `:${x.details}` : ""}${x.fatal ? "!" : ""}${x.code ? `(${x.code})` : ""}@${Math.round(x.t - t0)}`).slice(0, 30);
    // (a seek: everything up to where it landed, or gave up)
    const until = seek ? Date.now() - t0 : (row.ttff || 30000) + 3000;
    row.server = inst.slog.filter((l) => l.t >= t0 - 200 && l.t <= t0 + until && !/\[warm\]|\[usage\]/.test(l.line)).map((l) => `${Math.round(l.t - t0)} ${l.line.slice(0, 200)}`).slice(0, 120);
    delete row.waterfall;
    row.requests = net.all().filter((r) => r.start >= t0 - 30 && r.start <= t0 + (seek ? until : (row.ttff || 30000) + 500) && !["image", "telemetry"].includes(r.kind)).slice(0, 300).map((r) => ({ k: r.kind, p: r.path.slice(0, 90), s: Math.round(r.start - t0), b: r.ttfb ? Math.round(r.ttfb - t0) : null, e: r.end ? Math.round(r.end - t0) : null, st: r.status, n: r.bytes, srv: r.server && Object.keys(r.server).length ? r.server : undefined, f: r.failed }));
    return row;
  } finally {
    await ctx.close().catch(() => {});
    if (proxy) await proxy.close().catch(() => {});
  }
};

// ---- a start as the TV app makes one (tv-native Player.tsx), replayed in plain HTTP.
// ExoPlayer's first frame = bufferForPlaybackMs (2000 ms) of film in hand:
// for a file, the bytes of 2 s of film at its bitrate after the header; for an
// HLS source, the first segment's bytes (ExoPlayer needs its first sample).
const get = (base, p, headers, { range = null, maxBytes = Infinity, timeoutMs = 150000 } = {}) => new Promise((resolve) => {
  const u = new URL(base + p);
  const t0 = Date.now();
  let ttfb = null;
  let bytes = 0;
  const chunks = [];
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { "User-Agent": "okhttp/4.12.0 AuroraTV/5.6.0", ...headers, ...(range ? { Range: range } : {}) } }, (res) => {
    ttfb = Date.now() - t0;
    res.on("data", (c) => {
      bytes += c.length;
      if (chunks) chunks.push(c);
      if (bytes >= maxBytes) { req.destroy(); resolve({ status: res.statusCode, ttfb, ms: Date.now() - t0, bytes, headers: res.headers, body: Buffer.concat(chunks) }); }
    });
    res.on("end", () => resolve({ status: res.statusCode, ttfb, ms: Date.now() - t0, bytes, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.setTimeout(timeoutMs, () => req.destroy());
  req.on("error", (e) => resolve({ status: 0, ttfb, ms: Date.now() - t0, bytes, error: e.message, body: Buffer.concat(chunks) }));
  req.end();
});
const tvStart = async (inst, cs) => {
  const t = inst.titles[cs.title];
  const base = inst.srv.url;
  const viewer = `tv${Math.random().toString(36).slice(2, 10)}`;
  const api = { ...inst.sh, "X-Blur": "1" };
  const media = { "X-Session": inst.sid, "X-Profile": inst.profile.id, "X-Aurora-Viewer": viewer };
  if (cs.mode === "resume") await inst.call("POST", `/api/profiles/${inst.profile.id}/progress`, { itemId: t.id, position: Math.round(t.duration * 0.4), duration: t.duration }, inst.sh);
  const t0 = Date.now();
  const tl = { mount: 0 };
  get(base, `/api/play-mark/${t.id}`, {}, {}).catch(() => {});
  const [item, st] = await Promise.all([get(base, `/api/item/${t.id}?profile=${inst.profile.id}`, api), get(base, `/api/profiles/${inst.profile.id}/state`, api)]);
  tl.item = Date.now() - t0;
  tl.state = tl.item;
  const it = JSON.parse(item.body.toString("utf8") || "{}");
  const resume = cs.mode === "resume" ? Math.round(t.duration * 0.4) : 0;
  tl.decision = Date.now() - t0;
  const out = { ok: false, timeline: tl, title: cs.title };
  if (cs.tv === "direct") {
    // ExoPlayer: the header, then (MKV: cues at the end) a seek to read them, then the film
    const url = it.videoUrl;
    const head = await get(base, url, media, { range: "bytes=0-", maxBytes: 1024 * 1024 });
    tl.firstByte = Date.now() - t0 - head.ms + head.ttfb;
    const size = Number(String(head.headers && head.headers["content-range"] || "").split("/")[1]) || 0;
    if (size > 4e6) await get(base, url, media, { range: `bytes=${size - 2 * 1024 * 1024}-`, maxBytes: 2 * 1024 * 1024 });
    const kbps = (it.bitrate || 2500000) / 8;
    const from = resume > 0 && size ? Math.floor(size * (resume / t.duration)) : 1024 * 1024;
    const need = Math.ceil(kbps * 2);
    const body = await get(base, url, media, { range: `bytes=${from}-`, maxBytes: need });
    tl.firstFrame = Date.now() - t0;
    out.ok = body.status >= 200 && body.status < 300;
    out.ttff = tl.firstFrame;
    return out;
  }
  // the offset job: claim (copy: not awaited; h264: awaited), then the playlist, then the segment
  const v = cs.tv;
  const url = `${it.transcodeBase}/${Math.floor(resume)}/index.m3u8?v=${v}`;
  const claim = get(base, `${url}&seek=1`, media);
  if (v !== "copy") { const c = await claim; tl.claim = Date.now() - t0; if (c.status === 503) out.claim503 = true; }
  tl.armed = Date.now() - t0;
  let pl = null;
  for (let i = 0; i < 6; i++) {
    pl = await get(base, `${url}&g=1`, media);
    if (pl.status === 200) break;
    await sleep(1500);
  }
  tl.playlist = Date.now() - t0;
  const text = pl.body.toString("utf8");
  const segLine = text.split(/\r?\n/).find((l) => l && !l.startsWith("#"));
  if (!segLine) { out.why = `playlist ${pl.status}: ${text.slice(0, 120)}`; return out; }
  const segUrl = new URL(segLine, base + url).toString().replace(base, "");
  tl.segAsked = Date.now() - t0;
  const seg = await get(base, segUrl, media);
  tl.firstByte = tl.segAsked + (seg.ttfb || 0);
  tl.firstFrame = Date.now() - t0;
  out.ok = seg.status === 200 && seg.bytes > 0;
  out.ttff = tl.firstFrame;
  out.server = inst.slog.filter((l) => l.t >= t0 - 200 && l.t <= Date.now() + 500).map((l) => `${Math.round(l.t - t0)} ${l.line.slice(0, 200)}`).slice(0, 40);
  tl.spawn = firstLine(inst.slog, t0, /\[remux\]|\[transcode\]|ffmpeg/i);
  // and the next 60 s of film, as the TV keeps its buffer: does production keep up?
  const segs = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  return out;
};

// ---- the tables
const pct = (arr, p) => { const s = arr.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };
const fmt = (ms) => (ms == null ? "—" : ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(2)} s`);
const report = (label) => {
  const rows = fs.readFileSync(path.join(OUT_DIR, `vps-${label}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const by = {};
  const keyOf = (r) => `${r.cpus}c${r.steal ? `+${r.steal}hog` : ""}${r.busy ? `+${r.busy}` : ""}${r.settle != null && r.settle < 20 ? "+fresh" : ""}${r.upstream === "hang" ? "+uphang" : ""}|${r.case}`;
  for (const r of rows) (by[keyOf(r)] = by[keyOf(r)] || []).push(r);
  const STEPS = ["item", "decision", "playlist", "spawn", "segAsked", "firstByte", "firstFrame"];
  console.log(`\n${label}: median ms from the press (p50 / p95 of TTFF; steps are medians)\n`);
  console.log(["box", "case", "n", "ok", "p50", "p95", ...STEPS, "segMade", "rebuf", "seek"].join("\t"));
  for (const [k, list] of Object.entries(by)) {
    const [cpus, c] = k.split("|");
    const tt = list.map((r) => (r.ok ? r.ttff : 150000));
    const med = (f) => pct(list.map((r) => r.timeline && r.timeline[f]), 50);
    console.log([cpus, c, list.length, list.filter((r) => r.ok).length, fmt(pct(tt, 50)), fmt(pct(tt, 95)), ...STEPS.map((s) => med(s) ?? "—"), med("segMade") ?? "—", pct(list.map((r) => r.rebufferMs || 0), 50), fmt(pct(list.map((r) => r.seek && r.seek.ms), 50))].join("\t"));
  }
};

const main = async () => {
  if (arg("report", null)) return report(String(arg("report")));
  console.log(`vps ${LABEL}: ${CPUS} CPUs, no GPU, ${CLOSED ? "closed" : "open"} wall, line ${LINE}, upstream ${UPSTREAM}, ${RUNS} runs × ${CASE_LIST.join(", ")}`);
  const write = (row) => fs.appendFileSync(OUT, JSON.stringify({ label: LABEL, cpus: CPUS, steal: STEAL, busy: BUSY, settle: Number(arg("settle", 45)), line: LINE, upstream: UPSTREAM, tree: TREE || "working", at: new Date().toISOString(), ...row }) + "\n");
  for (let run = 1; run <= RUNS; run++) {
    for (const c of CASE_LIST) {
      const cs = CASES[c];
      let swarm = null;
      let inst = null;
      let stopBusy = null;
      let stopSteal = null;
      try {
        if (cs.torrent) swarm = await startSwarm({ slow: cs.torrent === "slow" });
        inst = await startVps({ swarm, seedTorrent: cs.torrent === "warm" || cs.torrent === "slow" });
        // what a server that has just come up is doing (calibration, scans): a real
        // household presses Play minutes after a restart, not seconds
        await sleep(Number(arg("settle", 45)) * 1000);
        if (BUSY) { stopBusy = startBusy(inst, BUSY); await sleep(15000); }
        if (STEAL) stopSteal = startSteal(STEAL);
        const os = require("os");
        const cpuT = () => os.cpus().reduce((a, x) => { const t = x.times; a.idle += t.idle; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { idle: 0, all: 0 });
        const c0 = cpuT();
        const r = cs.flavour === "tv" ? await tvStart(inst, cs) : await webStart(inst, cs, { swarm });
        const c1 = cpuT();
        // how busy the whole PC was meanwhile (other work on it slows the server's part)
        const row = { case: c, run, bootMs: inst.libraryMs, machineBusy: c1.all > c0.all ? Math.round(100 * (1 - (c1.idle - c0.idle) / (c1.all - c0.all))) : null, ...r };
        if (stopBusy) { await sleep(Number(arg("busy-watch", 0)) * 1000); row.neighbour = stopBusy.stats(); }
        write(row);
        const tl = row.timeline || {};
        console.log(`  ${new Date().toISOString().slice(11, 19)} ${c.padEnd(18)} #${run} (library ready in ${Math.round(inst.libraryMs / 1000)} s) ${row.ok ? `ttff ${fmt(row.ttff).padStart(8)}` : `FAILED ${row.why || ""}`}  ${Object.entries(tl).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(" · ")}${row.rebufferMs ? `  rebuf ${row.rebufferMs}ms/${row.rebuffers}` : ""}${row.seek ? `  seek ${row.seek.ms} ms` : ""}${row.next ? `  next episode ${row.next.ms} ms` : ""}${row.hitches && row.hitches.n ? `  hitches ${row.hitches.n} (max ${row.hitches.maxMs} ms, ${row.hitches.frozenMs} ms) ${row.hitches.at.join(" ")}` : ""}${row.frames && row.frames.totalLast12s ? `  dropped ${row.frames.droppedLast12s}/${row.frames.totalLast12s} frames` : ""}${row.neighbour ? `  neighbour ${row.neighbour.flavour}: ${row.neighbour.played}s played, ${row.neighbour.stalls} stalls ${row.neighbour.stallMs} ms, refused ${row.neighbour.refused}` : ""}`);
      } catch (e) {
        console.log(`  ${c} #${run}: ${String(e.stack || e).split("\n").slice(0, 3).join(" | ")}`);
        write({ case: c, run, ok: false, why: String(e.message).split("\n")[0] });
      } finally {
        if (stopSteal) stopSteal();
        if (stopBusy) stopBusy();
        if (inst) await inst.stop().catch(() => {});
        if (swarm) swarm.close();
      }
    }
  }
  for (const b of Object.values(browsers)) await b.close().catch(() => {});
  report(LABEL);
};
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

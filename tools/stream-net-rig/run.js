#!/usr/bin/env node
// The stream rig: the website plays real library-shaped films on a PRIVATE
// instance of this working tree, in the Chrome on this machine, through a
// shaped line — and every play becomes one row of numbers: time to first
// frame, stalls, the picture height over time, the bytes that crossed the
// line, every rendition change, and whether it was still playing at the end.
//
//   node tools/stream-net-rig/run.js --label base --profiles 3M,drop --titles direct,jit --watch 150
//
//   --label      tools/stream-net-rig/.runs/<label>.jsonl (appended to)
//   --profiles   lines (PROFILES below), comma list
//   --titles     direct | jit | hevc | uhd (TITLES below), comma list
//   --flavour    web (desktop Chrome, default) | iphone (iPhone UA: the player's
//                native-HLS path in Chrome's own HLS player) | android (phone UA, hls.js)
//   --watch      seconds watched after the click (default 150; a profile with a
//                schedule watches at least to its last step + 60 s)
//   --runs       repeats of each cell (default 1)
//   --net        wsl (default: real Linux TCP over netem, see netctl.js) |
//                proxy (tools/throttle-proxy.js in-process: a model, loss = Mathis cap)
//   --cc         cubic (default) | bbr — the server side's congestion control (wsl only)
//   --ssai       0 | 1 (default 1) — tcp_slow_start_after_idle on the server side (wsl only)
//   --line       known (default: the device remembers 90% of the line's first rate,
//                as one that has played here before) | forget (a first play) | <kbps>
//   --set k=v    localStorage before the app starts (repeatable)
//   --hls JSON   merged over the player's hls.js configuration (an experiment knob)
//   --media      the library folder (default E:/aurora-agents/research-stream-efficiency/media)
//   --cpus8      hold the instance (and its ffmpegs) to the 8 real cores 0,2,…,14 (default on;
//                --cpus8 0 for all 16 threads)
//   --config k=v extra instance config.json keys (repeatable; JSON values allowed)
//   --headed     watch it
//   --events     things that happen during the play, seconds after the FIRST FRAME, comma list:
//                  seek@25:+10       the viewer presses → (a 10-s skip; -10 = ←)
//                  seek@45:0.6       the viewer clicks the scrubber at 60 % of the film
//                  blip@60:15        the line loses every packet for 15 s, both ways (Wi-Fi gone, same address)
//                  cut@60:10         the same, and every connection open at that moment stays a black
//                                    hole for good (the viewer's network changed: a router restart, a
//                                    phone moving to another Wi-Fi) — only new connections work
//                  offline@60:15     the browser itself goes offline for 15 s (Wi-Fi switched off on the
//                                    device: requests fail at once, "offline"/"online" events fire)
//                  restart@60        the server restarts (Admin → Update → Restart; the instance runs
//                                    under its keeper, as an installed server does)
//                each becomes a row of `events`: seekMs (press → the first frame shown at the target),
//                stall and recovery around a line event (recoverMs: the line back → the clock moving)
//   --busy N     N other viewers on the server during the play (each pulls another film's copy
//                stream at 1× after a first minute ahead, straight from the instance, not
//                through the line); --busy-enc 1 puts one of them on the 720p encode
//
// One fresh instance, line and browser context per play: every play is a cold
// server and a cold page (the HTTP cache of a returning visitor is kept by
// warming the player's code first).
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");
const { launch, netlog, kindOf, sleep } = require("../ttff/lib");
const throttle = require("../throttle-proxy");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const many = (n) => argv.map((a, i) => (a === `--${n}` ? argv[i + 1] : null)).filter(Boolean);
const list = (n, d) => String(arg(n, d)).split(",").map((s) => s.trim()).filter(Boolean);

// ---------- the lines ----------
// rtt in ms (both ways), rates in kbit/s, loss in % (server → viewer only).
// schedule: [[second after the click, new down rate], …]
const PROFILES = {
  "1.5M": { down: 1500, up: 750, rtt: 70, loss: 0 },
  "3M": { down: 3000, up: 1000, rtt: 70, loss: 0 },
  "5M": { down: 5000, up: 1000, rtt: 70, loss: 0 },
  "8M": { down: 8000, up: 2000, rtt: 70, loss: 0 },
  "25M": { down: 25000, up: 5000, rtt: 70, loss: 0 },
  "3M-L1": { down: 3000, up: 1000, rtt: 70, loss: 1 },
  "8M-L1": { down: 8000, up: 2000, rtt: 70, loss: 1 },
  "20M-L1": { down: 20000, up: 5000, rtt: 70, loss: 1 },
  "8M-L2": { down: 8000, up: 2000, rtt: 70, loss: 2 },
  drop: { down: 10000, up: 2000, rtt: 70, loss: 0, schedule: [[45, 2000], [105, 10000]] },
  "drop-L1": { down: 10000, up: 2000, rtt: 70, loss: 1, schedule: [[45, 2000], [105, 10000]] },
};

// ---------- the films (copies, cut from the household's own shapes) ----------
const MEDIA = String(arg("media", "E:/aurora-agents/research-stream-efficiency/media"));
const TITLES = {
  // (the first cut of this clip kept an edit list, which the jit index reads as a keyframe
  // 6.8 s off — jit declined it, and every switch away from the file failed; "mp4" is the
  // same 12 minutes cut on a keyframe with no edit list, and is what the report uses)
  direct: { title: "Rig Direct", why: "MP4 H.264 High 1920x800 + AAC 5.1, 2.97 Mbit/s avg, 30-s peak 4.6 — plays as the file (edit-list cut: jit declines it)" },
  mp4: { title: "Rig Mp4", why: "MP4 H.264 High 1920x800 + AAC 5.1, 2.98 Mbit/s avg, 30-s peak 4.6 — plays as the file" },
  jit: { title: "Rig Jit", why: "MKV H.264 1920x800 + AC-3, 1.9 Mbit/s avg, 30-s peak 3.2 — repackaged, H.264 ladder" },
  hevc: { title: "Rig Hevc", why: "MKV HEVC Main10 1920x1080 + E-AC-3 5.1, 3.2 Mbit/s avg, 30-s peak 5.0 — repackaged, HEVC top + H.264 rungs" },
  uhd: { title: "Rig Uhd", why: "MKV HEVC Main10 3840x1600 + AAC 5.1, 6.7 Mbit/s avg, 30-s peak 11.9 — plays as the file" },
};

const LABEL = arg("label", "run");
const PROFS = list("profiles", "3M");
const TKEYS = list("titles", "direct");
const FLAVOUR = arg("flavour", "web");
const WATCH = Number(arg("watch", 150));
const RUNS = Number(arg("runs", 1));
const NETMODE = arg("net", "wsl");
const CC = arg("cc", "cubic");
const SSAI = String(arg("ssai", "1"));
const LINE = arg("line", "known");
const SETS = many("set").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; });
const HLS = arg("hls", "");
const CPUS8 = arg("cpus8", "1") !== "0";
// --prewarm all | h264-480,h264-720: every segment of those rungs made BEFORE the play
// (straight from the instance, not through the line) — what a ladder prepared
// overnight would be: the player never waits on an encoder
const PREWARM = arg("prewarm", "");
const TREE = arg("tree", "");
// --at <title>=<sec>[,...]: resume there (the film's busiest 150 s: mp4=390, hevc=546, jit=218)
const AT = Object.fromEntries(String(arg("at", "")).split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k, Number(v)]; }));
const CONFIG = Object.fromEntries(many("config").map((kv) => { const i = kv.indexOf("="); let v = kv.slice(i + 1); try { v = JSON.parse(v); } catch {} return [kv.slice(0, i), v]; }));
const EVENTS = String(arg("events", "")).split(",").map((x) => x.trim()).filter(Boolean).map((e) => {
  const m = /^(seek|blip|cut|restart|offline)@(\d+(?:\.\d+)?)(?::(.+))?$/.exec(e);
  if (!m) throw new Error(`--events: cannot read "${e}"`);
  return { kind: m[1], at: Number(m[2]), arg: m[3] != null ? m[3] : null };
});
const BUSY = Number(arg("busy", 0));
const BUSY_ENC = Number(arg("busy-enc", 0));
const OUT_DIR = path.join(__dirname, ".runs");
const OUT = path.join(OUT_DIR, `${LABEL}.jsonl`);
const PRIMARY = ".detail-actions > .btn-primary";
const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
};

// ---------- the instance ----------
const startInstance = async () => {
  // --tree <dir>: the app from a frozen copy (e.g. master, for a "before" no later edit can touch)
  const server = require(TREE ? path.join(TREE, "scripts", "ui-test-server.js") : "../../scripts/ui-test-server");
  // the machine's encode speed, measured once and handed to every instance (a fresh data folder would
  // measure it again: an x264 encode half a minute into every play, counted as an encoder start)
  const calFile = path.join(OUT_DIR, "encode-calibration.json");
  let cal = null;
  try { cal = JSON.parse(fs.readFileSync(calFile, "utf8")); } catch {}
  const srv = await server.start({
    ...(cal ? { seed: { "cache/encode-calibration.json": cal } } : {}),
    // a restart needs something to start it again: the keeper, as on an installed server
    ...(EVENTS.some((e) => e.kind === "restart") ? { keeper: true } : {}),
    // every video encode the server starts is logged (count-encodes.js): elia's rule is that none
    // may run that would not have run before, so each row counts them
    preload: [path.join(__dirname, "count-encodes.js")],
    config: {
      libraries: { movies: [path.join(MEDIA, "movies")], shows: [path.join(MEDIA, "shows")] },
      hwEncode: "off", // nufurora.com has no graphics card
      ...CONFIG,
    },
  });
  if (CPUS8 && process.platform === "win32") {
    // the 8 real cores of this i7-10700K (logical 0,2,…,14), like the VPS's 8 dedicated cores;
    // every ffmpeg the server starts inherits the mask
    try { execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${srv.pid}).ProcessorAffinity = ${0x5555}`], { stdio: "pipe", windowsHide: true }); } catch (e) { console.warn("affinity:", String(e.message).split("\n")[0]); }
  }
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status}`);
    return json;
  };
  const admin = { "X-Admin-Password": srv.adminPassword };
  const createProfile = async (name) => {
    const password = "pass-" + name.toLowerCase();
    const { request } = await call("POST", "/api/profiles", { name, password, realName: `${name} Tester`, avatar: "🦊", color: "#2c9fe0" });
    const p = await call("POST", `/api/admin/profile-requests/${request.id}/approve`, {}, admin);
    const token = (await call("POST", `/api/profiles/${p.id}/unlock`, { password })).token;
    const h = token ? { "X-Profile-Token": token } : {};
    await call("PUT", `/api/profiles/${p.id}`, { lookNoticeSeen: true }, h);
    await call("POST", `/api/profiles/${p.id}/password`, { newPassword: "", currentPassword: password }, h);
    return { id: p.id };
  };
  const lib = await call("GET", "/api/library");
  const ids = {};
  for (const [k, t] of Object.entries(TITLES)) { const m = lib.movies.find((x) => x.title === t.title); if (m) ids[k] = { id: m.id, duration: m.duration, sizeBytes: m.sizeBytes }; }
  const setProgress = (profileId, itemId, position, duration) => call("POST", `/api/profiles/${profileId}/progress`, { itemId, position, duration });
  if (!cal) {
    const stop = srv.stop;
    srv.stop = async () => {
      try { const made = path.join(srv.dataDir, "cache", "encode-calibration.json"); if (fs.existsSync(made)) fs.copyFileSync(made, calFile); } catch {}
      return stop();
    };
  }
  return { srv, createProfile, setProgress, ids };
};

// Every segment of the ladder's encoded rungs, asked for in order on the instance itself
// (jit keeps a rung's published segments after its job goes idle: they are on disk for the play).
const prewarm = async (srv, id, want) => {
  const base = `${srv.url}/stream/transcode/${encodeURIComponent(id)}/jit`;
  const master = await (await fetch(`${base}/master.m3u8`)).text();
  const lines = (t) => t.split("\n").map((x) => x.trim());
  const uris = lines(master).filter((l) => l && !l.startsWith("#"));
  const t0 = Date.now();
  let segs = 0;
  for (const u of uris) {
    const v = (/[?&]v=([^&]+)/.exec(u) || [])[1] || "copy";
    if (v === "copy" || (want !== "all" && !want.split(",").includes(v))) continue;
    const pl = await (await fetch(`${base}/${u}`)).text();
    const segUris = lines(pl).filter((l) => l && !l.startsWith("#"));
    for (const su of segUris) {
      const r = await fetch(new URL(su, `${base}/${u}`).href);
      await r.arrayBuffer();
      segs++;
    }
  }
  return { segs, sec: Math.round((Date.now() - t0) / 1000) };
};

// ---------- the line ----------
const WSL_NODE = "/home/elia/node22/bin/node";
const toWsl = (p) => "/mnt/" + p.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).replace(/\\/g, "/");
// --port-base: where this rig's line ports start (two rigs side by side: 47210 and 47250)
const PORT_BASE = Number(arg("port-base", 47210));
let listenPort = PORT_BASE;
// (a port WSL still holds from somewhere: the next one — three tries)
const startLine = async (auroraPort, prof, tries = 3) => {
  try { return await startLineOnce(auroraPort, prof); } catch (e) {
    if (tries > 1 && /EADDRINUSE|never answered/.test(String(e.message))) return startLine(auroraPort, prof, tries - 1);
    throw e;
  }
};
const startLineOnce = async (auroraPort, prof) => {
  if (NETMODE === "proxy") {
    const p = await throttle.start({ listen: 0, host: "127.0.0.1", to: auroraPort, quiet: true, handshake: true, slowstart: true, down: prof.down, up: prof.up, latency: prof.rtt / 2, pktloss: prof.loss || 0 });
    return { origin: `http://127.0.0.1:${p.port}`, set: async (down) => p.setDown && p.setDown(down), close: () => p.close(), describe: p.describe };
  }
  listenPort = listenPort >= PORT_BASE + 36 ? PORT_BASE : listenPort + 4;
  const ctl = spawn("wsl.exe", ["-d", "Ubuntu", "-u", "root", "-e", WSL_NODE, toWsl(path.join(__dirname, "netctl.js")), "--aurora", String(auroraPort), "--listen", String(listenPort)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  const lines = [];
  let waiter = null;
  let buf = "";
  ctl.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; lines.push(l); if (waiter && /^(ok|err|ready)/.test(l)) { const w = waiter; waiter = null; w(l); } }
  });
  ctl.stderr.on("data", () => {});
  const next = (ms = 30000) => new Promise((resolve, reject) => { waiter = resolve; setTimeout(() => { if (waiter === resolve) { waiter = null; reject(new Error(`netctl: no answer (${lines.slice(-3).join(" | ")})`)); } }, ms); });
  const send = async (cmd) => { const p = next(); ctl.stdin.write(cmd + "\n"); const a = await p; if (a.startsWith("err")) throw new Error(`netctl ${cmd}: ${a}`); return a; };
  const ready = await next(60000).catch((e) => { try { ctl.stdin.end(); } catch {} throw e; });
  if (!ready.startsWith("ready")) { try { ctl.stdin.end(); } catch {} throw new Error(`netctl: ${ready}`); }
  await send(`cc ${CC}`);
  await send(`ssai ${SSAI}`);
  const shape = (down) => send(`shape ${down} ${prof.up} ${prof.rtt} ${prof.loss || 0}`);
  await shape(prof.down);
  // WSL's localhost forwarding notices a new listener after a moment: wait until the path answers
  const origin = `http://127.0.0.1:${listenPort}`;
  for (let i = 0; ; i++) {
    try { const r = await fetch(`${origin}/api/ping`, { signal: AbortSignal.timeout(3000) }); if (r.ok) break; } catch {}
    if (i >= 40) { try { ctl.stdin.end(); } catch {} throw new Error(`the WSL line never answered on ${origin}`); }
    await sleep(500);
  }
  return {
    origin: `http://127.0.0.1:${listenPort}`,
    set: shape,
    off: () => send("off"),
    freeze: () => send("freeze"),
    close: async () => { try { ctl.stdin.end(); } catch {} await new Promise((r) => { const t = setTimeout(r, 20000); ctl.once("exit", () => { clearTimeout(t); r(); }); }); },
    describe: `wsl ${CC} ssai=${SSAI} down ${prof.down} up ${prof.up} rtt ${prof.rtt} loss ${prof.loss || 0}%`,
  };
};

// ---------- in the page ----------
const PROBE = () => {
  if (window.__rig) return;
  const now = () => performance.timeOrigin + performance.now();
  const R = (window.__rig = { clicks: [], videos: [], hls: [] });
  addEventListener("click", (e) => { if (e.isTrusted) R.clicks.push(now()); }, true);
  R.keys = [];
  addEventListener("keydown", (e) => { if (e.isTrusted) R.keys.push({ t: now(), key: e.key }); }, true);
  // where the player's video is now, and what it holds ahead (for an event's row)
  R.state = () => {
    const v = [...document.querySelectorAll(".player video")].find((x) => x.currentSrc) || null;
    if (!v) return null;
    const ranges = [];
    for (let i = 0; i < v.buffered.length; i++) ranges.push([+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)]);
    return { t: now(), ct: v.currentTime, dur: v.duration, paused: v.paused, ranges };
  };
  const watch = (v) => {
    v.muted = true;
    const rec = { created: now(), events: [], frames: [], samples: [], el: v };
    R.videos.push(rec);
    for (const ev of ["loadedmetadata", "playing", "waiting", "seeking", "seeked", "pause", "error", "emptied", "ended"]) v.addEventListener(ev, () => rec.events.push({ ev, t: now(), ct: v.currentTime }));
    // the first ten frames in full; after them every frame's [time, media time] (a seek's
    // landing is the first frame shown at its target)
    rec.all = [];
    const onFrame = (n, meta) => {
      if (rec.frames.length < 10) rec.frames.push({ t: performance.timeOrigin + n, mt: meta.mediaTime, h: meta.height });
      else if (rec.all.length < 40000) rec.all.push([Math.round(performance.timeOrigin + n), +meta.mediaTime.toFixed(3)]);
      v.requestVideoFrameCallback(onFrame);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
    let dropped0 = null;
    const iv = setInterval(() => {
      if (!v.isConnected && rec.samples.length) return clearInterval(iv);
      if (!v.currentSrc && !rec.samples.length) return;
      if (rec.samples.length >= 4000) return clearInterval(iv);
      let ahead = 0;
      for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.3 && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      if (q && dropped0 == null) dropped0 = q.droppedVideoFrames;
      rec.samples.push({ t: Math.round(now()), ct: +v.currentTime.toFixed(3), p: v.paused ? 1 : 0, sk: v.seeking ? 1 : 0, rs: v.readyState, ah: +ahead.toFixed(1), h: v.videoHeight, df: q ? q.droppedVideoFrames - dropped0 : 0, tf: q ? q.totalVideoFrames : 0, src: (v.currentSrc || "").slice(-60), err: v.error ? v.error.code : 0, card: document.querySelector(".player-error, .player .error-card") ? 1 : 0 });
    }, 250);
  };
  const create = Document.prototype.createElement;
  Document.prototype.createElement = function (name, ...rest) { const el = create.call(this, name, ...rest); try { if (String(name).toLowerCase() === "video") watch(el); } catch {} return el; };
  try {
    let over = null;
    try { over = JSON.parse(localStorage.getItem("rig-hls") || "null"); } catch {}
    let wrapped;
    Object.defineProperty(window, "Hls", {
      configurable: true,
      get: () => wrapped,
      set: (Hc) => {
        wrapped = Hc && class extends Hc {
          constructor(cfg) {
            super(over ? { ...cfg, ...over } : cfg);
            R.inst = this;
            const E = Hc.Events;
            const note = (what, extra) => { if (R.hls.length < 1500) R.hls.push({ t: Math.round(now()), what, ...extra }); };
            note("new", { maxBuf: this.config.maxBufferLength, est: this.config.abrEwmaDefaultEstimate });
            this.on(E.ERROR, (_e, d) => note("error", { details: d && d.details, fatal: !!(d && d.fatal) }));
            this.on(E.LEVEL_SWITCHED, (_e, d) => { const l = this.levels && this.levels[d.level]; note("level", { level: d.level, h: l ? l.height : 0, bw: l ? l.bitrate : 0 }); });
            if (E.FRAG_LOAD_EMERGENCY_ABORTED) this.on(E.FRAG_LOAD_EMERGENCY_ABORTED, () => note("gave-up", {}));
            this.on(E.MANIFEST_PARSED, (_e, d) => note("manifest", { levels: (d.levels || []).map((l) => `${l.height}@${Math.round(l.bitrate / 1000)}`).join(",") }));
            const est = setInterval(() => { try { if (!this.media) return clearInterval(est); note("est", { kbps: Math.round((this.bandwidthEstimate || 0) / 1000), lvl: this.currentLevel }); } catch { clearInterval(est); } }, 5000);
          }
        };
      },
    });
  } catch {}
  R.dump = (since) => ({
    clicks: R.clicks.filter((c) => c >= since),
    hls: R.hls.filter((x) => x.t >= since),
    keys: R.keys.filter((k) => k.t >= since),
    videos: R.videos.filter((r) => r.created >= since - 5 && r.samples.length).map((r) => ({ created: r.created, events: r.events, frames: r.frames, all: r.all, samples: r.samples, inPlayer: !!(r.el.closest && r.el.closest(".player")) })),
  });
};

// ---------- one play → one row ----------
const digest = ({ t0, dump, reqs, endAt }) => {
  const out = { ok: false };
  const vids = dump.videos.filter((v) => v.inPlayer || v.frames.length).sort((a, b) => b.samples.length - a.samples.length);
  if (!vids.length) return { ...out, why: "no video" };
  // the player may rebuild its element: stitch every in-player element's samples in time order
  const samples = vids.flatMap((v) => v.samples).filter((s) => s.t >= t0).sort((a, b) => a.t - b.t);
  const frames = vids.flatMap((v) => v.frames).filter((f) => f.t >= t0).sort((a, b) => a.t - b.t);
  const ff = frames[0] ? frames[0].t : null;
  out.ttff = ff != null ? Math.round(ff - t0) : null;
  if (ff == null) return { ...out, why: "no first frame", watched: Math.round((endAt - t0) / 1000) };
  out.ok = true;
  // stalls: the clock not moving while not paused, after the first frame (a sample every 250 ms)
  let stallMs = 0, stalls = 0, run = 0, longest = 0;
  const heights = {};
  let switches = 0, lastH = 0, maxDropped = 0;
  const after = samples.filter((s) => s.t >= ff);
  for (let i = 1; i < after.length; i++) {
    const a = after[i - 1], b = after[i];
    const dt = b.t - a.t;
    if (dt > 2000) { run = 0; continue; } // a gap in sampling (element swap)
    const frozen = !b.p && b.ct - a.ct < 0.05 && Math.abs(b.ct - a.ct) < 3; // (a jump is a seek, not a stall)
    if (frozen) { run += dt; } else {
      if (run >= 500) { stalls++; stallMs += run; longest = Math.max(longest, run); }
      run = 0;
      if (b.h) heights[b.h] = (heights[b.h] || 0) + dt;
    }
    if (b.h && b.h !== lastH) { if (lastH) switches++; lastH = b.h; }
    maxDropped = Math.max(maxDropped, b.df || 0);
  }
  if (run >= 500) { stalls++; stallMs += run; longest = Math.max(longest, run); }
  out.stalls = stalls;
  out.stallMs = Math.round(stallMs);
  out.longestStallMs = Math.round(longest);
  const playMs = Object.values(heights).reduce((s, x) => s + x, 0);
  out.playedSec = after.length ? +(after[after.length - 1].ct - after[0].ct).toFixed(1) : 0;
  out.watchSec = Math.round((endAt - t0) / 1000);
  out.heightMs = heights;
  out.avgHeight = playMs ? Math.round(Object.entries(heights).reduce((s, [h, ms]) => s + h * ms, 0) / playMs) : 0;
  const share = (lo, hi) => (playMs ? +(Object.entries(heights).filter(([h]) => h >= lo && h < hi).reduce((s, [, ms]) => s + ms, 0) / playMs).toFixed(2) : 0);
  out.shareTop = share(790, 99999); // the film's own height (800-1600 here)
  out.share720 = share(700, 790);
  out.shareLow = share(1, 700);
  out.switches = switches;
  out.droppedFrames = maxDropped;
  // still going at the end: the clock moved in the last 15 s
  const tail = after.filter((s) => s.t >= endAt - 15000);
  out.endPlaying = tail.length > 4 && tail[tail.length - 1].ct - tail[0].ct > 8;
  out.endHeight = after.length ? after[after.length - 1].h : 0;
  // how it ended: the last sample (paused, readyState, a media error code, an error card on screen)
  { const e = after[after.length - 1]; if (e) out.endState = { paused: e.p, readyState: e.rs, mediaError: e.err || 0, card: e.card || 0, src: e.src }; }
  out.pausedSec = +(after.filter((s) => s.p).length * 0.25).toFixed(1);
  // the bytes that crossed the line for the film after the click
  const media = reqs.filter((r) => r.start >= t0 - 50 && (r.kind === "segment" || r.kind === "video" || r.kind === "playlist"));
  out.mediaBytes = media.reduce((s, r) => s + r.bytes, 0);
  out.mediaMbit = +((out.mediaBytes * 8) / ((endAt - t0) / 1000) / 1e6).toFixed(2);
  out.mbitPerPlayedSec = out.playedSec > 0 ? +((out.mediaBytes * 8) / out.playedSec / 1e6).toFixed(2) : null;
  out.requests = media.length;
  out.failedRequests = media.filter((r) => r.failed || r.status >= 400).length;
  const lv = media.filter((r) => r.kind === "segment").map((r) => (/[?&]v=([^&]+)/.exec(r.path) || [])[1] || "copy");
  out.levelsUsed = [...new Set(lv)];
  let segSwitches = 0;
  for (let i = 1; i < lv.length; i++) if (lv[i] !== lv[i - 1]) segSwitches++;
  out.segLevelChanges = segSwitches;
  out.path = media.some((r) => r.kind === "video") && !media.some((r) => r.kind === "segment") ? "direct" : media.some((r) => /\/jit\//.test(r.path)) ? (media.some((r) => /master\.m3u8/.test(r.path)) ? "ladder" : "jit") : media.some((r) => r.kind === "video") ? "direct+hls" : "hls";
  // what hls.js did
  const h = dump.hls;
  out.hlsNew = h.filter((x) => x.what === "new").length;
  out.hlsErrors = h.filter((x) => x.what === "error").length;
  out.hlsFatal = h.filter((x) => x.what === "error" && x.fatal).length;
  out.hlsGaveUp = h.filter((x) => x.what === "gave-up").length;
  out.hlsErrorList = h.filter((x) => x.what === "error").slice(0, 25).map((x) => `${x.details}${x.fatal ? "!" : ""}@${Math.round((x.t - t0) / 1000)}`);
  out.hlsLevels = h.filter((x) => x.what === "level").map((x) => `${x.h}@${Math.round((x.t - t0) / 1000)}`).join(" ");
  out.manifest = (h.find((x) => x.what === "manifest") || {}).levels || null;
  out.estKbps = h.filter((x) => x.what === "est").map((x) => x.kbps);
  // a per-5-s timeline, for charts: [s, height, buffer ahead, frozen?]
  out.timeline = [];
  for (let s = 0; s * 1000 < endAt - t0; s += 5) {
    const at = samples.filter((x) => x.t >= t0 + s * 1000 && x.t < t0 + (s + 5) * 1000);
    if (!at.length) { out.timeline.push([s, 0, 0, 1]); continue; }
    const moved = at[at.length - 1].ct - at[0].ct;
    out.timeline.push([s, at[at.length - 1].h, at[at.length - 1].ah, moved < 2 && !at[at.length - 1].p ? 1 : 0]);
  }
  return out;
};

// ---------- other viewers (--busy) ----------
// Each pulls another film's jit stream the way hls.js does: a minute ahead first, then at 1×,
// straight from the instance (their lines are not this viewer's line).
const busyLoad = (srvUrl, ids, measured, n, enc) => {
  const st = { stop: false, viewers: [], segs: 0, bytes: 0, errors: 0 };
  const others = Object.keys(ids).filter((k) => k !== measured && k !== "direct");
  const one = async (key, v, from) => {
    const id = ids[key].id;
    const base = `${srvUrl}/stream/transcode/${encodeURIComponent(id)}/jit`;
    try {
      const master = await (await fetch(`${base}/master.m3u8`)).text();
      const uris = master.split("\n").map((x) => x.trim()).filter((l) => l && !l.startsWith("#"));
      const u = uris.find((x) => (/[?&]v=([^&]+)/.exec(x) || [])[1] === v) || uris.find((x) => !/[?&]v=h264/.test(x)) || uris[0];
      const plUrl = new URL(u, `${base}/master.m3u8`).href;
      const pl = (await (await fetch(plUrl)).text()).split("\n").map((x) => x.trim());
      const segs = [];
      let at = 0;
      for (let i = 0; i < pl.length; i++) {
        const m = /^#EXTINF:([\d.]+)/.exec(pl[i]);
        if (m) {
          const d = Number(m[1]);
          let j = i + 1;
          while (j < pl.length && (!pl[j] || pl[j].startsWith("#"))) j++;
          if (j < pl.length) segs.push({ at, d, url: new URL(pl[j], plUrl).href });
          at += d;
          i = j;
        }
      }
      const t0 = Date.now();
      for (const sg of segs) {
        if (st.stop) return;
        if (sg.at + sg.d < from) continue;
        while (!st.stop && sg.at - from - (Date.now() - t0) / 1000 > 60) await sleep(250);
        if (st.stop) return;
        try {
          const r = await fetch(sg.url);
          const b = await r.arrayBuffer();
          if (r.status >= 400) st.errors++;
          else { st.segs++; st.bytes += b.byteLength; }
        } catch { st.errors++; }
      }
    } catch { st.errors++; }
  };
  for (let i = 0; i < n; i++) {
    const key = others[i % others.length];
    const v = enc && i === 0 ? "h264-720" : "copy";
    st.viewers.push(`${key}:${v}@${60 * (i + 1)}`);
    one(key, v, 60 * (i + 1));
  }
  return st;
};

// ---------- events during a play (--events) ----------
const pageNow = (page) => page.evaluate(() => performance.timeOrigin + performance.now());
const runEvent = async (ev, { page, line, inst, prof, context }) => {
  const rec = { kind: ev.kind, at: ev.at, arg: ev.arg };
  rec.before = await page.evaluate(() => window.__rig.state()).catch(() => null);
  if (ev.kind === "seek") {
    if (/^[+-]/.test(ev.arg)) {
      const back = ev.arg.startsWith("-");
      rec.t = await pageNow(page);
      await page.keyboard.press(back ? "ArrowLeft" : "ArrowRight");
      rec.target = rec.before ? rec.before.ct + (back ? -10 : 10) : null;
    } else {
      const frac = Number(ev.arg);
      // the controls first (a pointer over the picture), then a click on the scrubber
      const vp = page.viewportSize() || { width: 1280, height: 720 };
      await page.mouse.move(vp.width * 0.45, vp.height * 0.5);
      await sleep(120);
      await page.mouse.move(vp.width * 0.5, vp.height * 0.55);
      await sleep(250);
      const box = await page.locator(".player .scrubber").first().boundingBox();
      if (!box) { rec.error = "no scrubber"; return rec; }
      const dur = rec.before && isFinite(rec.before.dur) ? rec.before.dur : null;
      rec.t = await pageNow(page);
      await page.mouse.click(box.x + frac * box.width, box.y + box.height / 2);
      rec.target = dur ? frac * dur : null;
    }
    if (rec.before && rec.target != null) rec.inBuffer = rec.before.ranges.some(([a, b]) => a <= rec.target && b >= rec.target + 1);
    return rec;
  }
  if (ev.kind === "blip" || ev.kind === "cut") {
    rec.t = await pageNow(page);
    if (ev.kind === "cut") rec.frozen = await line.freeze();
    await line.off();
    await sleep(Number(ev.arg || 10) * 1000);
    await line.set(prof.down);
    rec.restoredAt = await pageNow(page);
    return rec;
  }
  if (ev.kind === "offline") {
    rec.t = await pageNow(page);
    await context.setOffline(true);
    await sleep(Number(ev.arg || 10) * 1000);
    await context.setOffline(false);
    rec.restoredAt = await pageNow(page);
    return rec;
  }
  if (ev.kind === "restart") {
    rec.t = await pageNow(page);
    const r = await fetch(`${inst.srv.url}/api/admin/update/restart`, { method: "POST", headers: { "X-Admin-Password": inst.srv.adminPassword, "Content-Type": "application/json" }, body: "{}" }).catch((e) => ({ status: String(e.message) }));
    rec.status = r.status;
    // down (the old one has let go), then up again
    let wentDown = false;
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      let ok = false;
      try { ok = (await fetch(`${inst.srv.url}/api/ping`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (!ok) wentDown = true;
      if (ok && wentDown) break;
      await sleep(100);
    }
    rec.wentDown = wentDown;
    rec.restoredAt = await pageNow(page);
    return rec;
  }
  return rec;
};

// stalls as digest() counts them, as intervals
const frozenRuns = (samples) => {
  const runs = [];
  let from = null;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (b.t - a.t > 2000) { from = null; continue; }
    const frozen = !b.p && b.ct - a.ct < 0.05 && Math.abs(b.ct - a.ct) < 3;
    if (frozen) { if (from == null) from = a.t; } else if (from != null) { if (b.t - from >= 500) runs.push([from, a.t]); from = null; }
  }
  if (from != null && samples.length && samples[samples.length - 1].t - from >= 500) runs.push([from, samples[samples.length - 1].t]);
  return runs;
};
const digestEvents = (events, dump, endAt, reqs = []) => {
  const vids = dump.videos.filter((v) => v.inPlayer || v.frames.length);
  const samples = vids.flatMap((v) => v.samples).sort((a, b) => a.t - b.t);
  const frames = vids.flatMap((v) => v.all || []).sort((a, b) => a[0] - b[0]);
  const runs = frozenRuns(samples);
  return events.map((e, k) => {
    const out = { ...e };
    // (a seek's own window ends where the next event begins)
    const nextT = events[k + 1] && events[k + 1].t ? events[k + 1].t : Infinity;
    if (out.before) {
      const b = out.before;
      out.ct = +b.ct.toFixed(1);
      const cover = b.ranges.filter(([x, y]) => x <= b.ct + 0.3 && y > b.ct);
      out.ahead = cover.length ? +(Math.max(...cover.map(([, y]) => y)) - b.ct).toFixed(1) : 0;
      delete out.before;
    }
    if (e.kind === "seek" && e.t && e.target != null) {
      const land = frames.find(([t, mt]) => t > e.t && Math.abs(mt - e.target) < 1.5);
      out.seekMs = land ? Math.round(land[0] - e.t) : null;
      const moving = land && samples.find((x) => x.t > land[0] && x.ct >= e.target + 1);
      out.movingMs = moving ? Math.round(moving.t - e.t) : null;
      // the media requests the landing waited on: rung, first byte (the server + one round trip), bytes
      const after = reqs.filter((r) => r.start >= e.t - 20 && r.start < e.t + (out.seekMs || 15000) && (r.kind === "segment" || r.kind === "video"));
      out.reqs = after.slice(0, 4).map((r) => ({ v: (/[?&]v=([^&]+)/.exec(r.path) || [])[1] || (r.kind === "video" ? "file" : "copy"), seg: (/seg(\d+)/.exec(r.path) || [])[1] || null, ttfb: r.ttfb ? Math.round(r.ttfb - r.start) : null, at: Math.round(r.start - e.t), kb: Math.round(r.bytes / 1000), end: r.end ? Math.round(r.end - e.t) : null }));
      const w = Math.min(e.t + 30000, nextT);
      out.stallMs = Math.round(runs.filter(([a, b]) => b > e.t && a < w).reduce((n, [a, b]) => n + Math.min(b, w) - Math.max(a, e.t), 0));
    } else if (e.t) {
      const end = Math.min(endAt, (e.restoredAt || e.t) + 90000);
      const inWin = runs.filter(([a, b]) => b > e.t && a < end);
      out.stalls = inWin.length;
      out.stallMs = Math.round(inWin.reduce((n, [a, b]) => n + Math.min(b, end) - Math.max(a, e.t), 0));
      if (e.restoredAt) {
        out.outMs = Math.round(e.restoredAt - e.t);
        const at = inWin.find(([a, b]) => a <= e.restoredAt && b >= e.restoredAt);
        // the line back → the clock moving again (0: the buffer carried it)
        out.recoverMs = at ? Math.round(at[1] - e.restoredAt) : 0;
        const later = inWin.filter(([a]) => a > e.restoredAt);
        out.stallsAfter = later.length;
        out.stallMsAfter = Math.round(later.reduce((n, [a, b]) => n + Math.min(b, end) - a, 0));
      }
    }
    return out;
  });
};

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launch({ headed: flag("headed") });
  const meta = { tree: TREE || null, at: Object.keys(AT).length ? AT : null, prewarm: PREWARM || null, label: LABEL, at: new Date().toISOString(), net: NETMODE, cc: CC, ssai: SSAI, line: LINE, flavour: FLAVOUR, sets: SETS, hls: HLS || null, config: CONFIG, chrome: browser.version(), cpus8: CPUS8 };
  console.log(`rig ${LABEL}: ${PROFS.join(",")} × ${TKEYS.join(",")} × ${RUNS}  net=${NETMODE} cc=${CC} flavour=${FLAVOUR} line=${LINE} (Chrome ${meta.chrome})`);
  for (let run = 1; run <= RUNS; run++) for (const pname of PROFS) for (const tkey of TKEYS) {
    const prof = PROFILES[pname];
    if (!prof) throw new Error(`unknown profile ${pname}`);
    const row = { ...meta, profile: pname, title: tkey, run, prof };
    let inst = null, line = null, context = null, busy = null;
    const t1 = Date.now();
    try {
      inst = await startInstance();
      const item = inst.ids[tkey];
      if (!item) throw new Error(`title ${tkey} not in the library`);
      row.fileKbps = item.sizeBytes && item.duration ? Math.round((item.sizeBytes * 8) / item.duration / 1000) : null;
      if (PREWARM) { row.prewarm = await prewarm(inst.srv, item.id, PREWARM); console.log(`    prewarmed ${row.prewarm.segs} segments in ${row.prewarm.sec}s`); }
      line = await startLine(inst.srv.port, prof);
      if (BUSY > 0) {
        busy = busyLoad(inst.srv.url, inst.ids, tkey, BUSY, BUSY_ENC);
        // the server's event loop meanwhile (its own /healthz windows)
        busy.loop = { maxMs: 0, p99Ms: 0 };
        const lp = setInterval(() => {
          if (busy.stop) return clearInterval(lp);
          fetch(`${inst.srv.url}/healthz`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).then((j) => {
            const l = (j && (j.loop || j.eventLoop || j.lag)) || j || {};
            busy.loop.maxMs = Math.max(busy.loop.maxMs, Number(l.maxMs) || 0);
            busy.loop.p99Ms = Math.max(busy.loop.p99Ms, Number(l.p99Ms) || 0);
          }).catch(() => {});
        }, 5000);
        await sleep(8000); // the others already playing
      }
      row.lineDescribe = line.describe;
      const profile = await inst.createProfile(`R${Date.now().toString(36).slice(-6)}`);
      if (AT[tkey] > 0) { await inst.setProgress(profile.id, item.id, AT[tkey], item.duration); row.at = AT[tkey]; }
      context = await browser.newContext({ viewport: FLAVOUR === "web" ? { width: 1280, height: 720 } : { width: 390, height: 844 }, serviceWorkers: "block", ...(UA[FLAVOUR] ? { userAgent: UA[FLAVOUR], isMobile: true, hasTouch: true } : {}) });
      const page = await context.newPage();
      page.setDefaultTimeout(60000);
      const lineKbps = LINE === "forget" ? 0 : LINE === "known" ? Math.round(prof.down * 0.9) : Number(LINE) || 0;
      await page.addInitScript(({ id, sets, hls, lineKbps }) => {
        try {
          if (sessionStorage.getItem("rig-seeded")) return;
          sessionStorage.setItem("rig-seeded", "1");
          localStorage.setItem("aurora-profile", id);
          localStorage.setItem("aurora-kbd-hint", "1");
          localStorage.setItem("aurora-nav-hinted", "1");
          if (lineKbps > 0) localStorage.setItem("aurora-line-kbps", JSON.stringify({ kbps: lineKbps, at: Date.now() }));
          if (hls) localStorage.setItem("rig-hls", hls);
          for (const [k, v] of sets) localStorage.setItem(k, v);
        } catch {}
      }, { id: profile.id, sets: SETS, hls: HLS, lineKbps });
      await page.addInitScript(PROBE);
      const net = await netlog(context, page);
      const origin = line.origin;
      await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForSelector("#app .screen", { timeout: 90000 });
      await page.evaluate(() => Promise.all(["/js/vendor/hls.min.js", "/js/screens/player.js"].map((u) => fetch(u).then((r) => r.arrayBuffer()).catch(() => null))));
      await page.evaluate((h) => { location.hash = h; }, `#/movie/${item.id}`);
      await page.waitForSelector(PRIMARY, { timeout: 90000 });
      await sleep(2500); // the title page settles (its own requests, the start warm-up)
      const since = await page.evaluate(() => performance.timeOrigin + performance.now());
      net.reset();
      await page.click(PRIMARY);
      const t0c = Date.now();
      const watchSec = Math.max(WATCH, prof.schedule ? prof.schedule[prof.schedule.length - 1][0] + 60 : 0);
      const steps = (prof.schedule || []).slice();
      const evq = EVENTS.slice().sort((a, b) => a.at - b.at);
      const evDone = [];
      let ffAt = null;
      while (Date.now() - t0c < watchSec * 1000) {
        const el = (Date.now() - t0c) / 1000;
        while (steps.length && el >= steps[0][0]) { const [, d] = steps.shift(); await line.set(d); }
        if (evq.length) {
          if (ffAt == null) ffAt = await page.evaluate(() => { const f = window.__rig.videos.flatMap((v) => v.frames).sort((a, b) => a.t - b.t)[0]; return f ? f.t : null; }).catch(() => null);
          if (ffAt != null && (await pageNow(page)) - ffAt >= evq[0].at * 1000) evDone.push(await runEvent(evq.shift(), { page, line, inst, prof, context }));
        }
        await sleep(evq.length ? 200 : 500);
      }
      if (busy) busy.stop = true;
      const endAt = await page.evaluate(() => performance.timeOrigin + performance.now());
      const dump = await page.evaluate((s) => window.__rig.dump(s), since);
      const t0 = dump.clicks.length ? dump.clicks[0] : since;
      Object.assign(row, digest({ t0, dump, reqs: net.all(), endAt }));
      if (EVENTS.length) row.events = digestEvents(evDone, dump, endAt, net.all());
      if (busy) row.busy = { viewers: busy.viewers, segs: busy.segs, mb: +(busy.bytes / 1e6).toFixed(1), errors: busy.errors, loop: busy.loop };
      // the player's own marks (what path it chose, any step-down)
      row.marks = net.all().filter((r) => r.kind === "mark" && r.body).map((r) => { try { const m = JSON.parse(r.body); return `${m.name}${m.path ? `:${m.path}` : ""}${m.to ? `:${m.to}` : ""}${m.v ? `:${m.v}` : ""}${m.levels ? `:${m.levels}` : ""}@${m.ms}`; } catch { return null; } }).filter(Boolean).slice(0, 40);
      { const pm = row.marks.filter((m) => /^path:/.test(m)).map((m) => m.split(":")[1].split("@")[0]); if (pm.length) row.pathMarks = pm.join(">"); }
      row.stepDowns = row.marks.filter((m) => /^step-down/.test(m)).length;
      const log = inst.srv.log();
      const enc = log.filter((l) => /^\[rig-encode\]/.test(l));
      row.encodeStarts = enc.length;
      row.encodes = enc.map((l) => l.replace("[rig-encode] ", "")).slice(0, 40);
      row.serverLogTail = log.filter((l) => /\[jit\]|\[ladder\]|\[play\]/.test(l)).slice(-25);
    } catch (e) {
      row.ok = false;
      row.why = String(e.message).split("\n")[0];
    } finally {
      if (busy) busy.stop = true;
      try { if (context) await context.close(); } catch {}
      try { if (line) await line.close(); } catch {}
      try { if (inst) await inst.srv.stop(); } catch {}
    }
    row.wallSec = Math.round((Date.now() - t1) / 1000);
    for (const e of row.events || []) console.log(`      ${e.kind}@${e.at}${e.arg ? ":" + e.arg : ""}  ${e.kind === "seek" ? `seek ${e.seekMs} ms  moving ${e.movingMs} ms  ${e.inBuffer ? "in buffer" : "outside"}  stalled ${e.stallMs} ms` : `out ${e.outMs} ms  ahead ${e.ahead} s  recover ${e.recoverMs} ms  stalls ${e.stalls} / ${e.stallMs} ms  after ${e.stallsAfter}`}`);
    fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
    console.log(`  ${pname.padEnd(7)} ${tkey.padEnd(6)} #${run} ${row.ok ? `ttff ${String(row.ttff).padStart(6)} ms  stalls ${String(row.stalls).padStart(2)} / ${String((row.stallMs / 1000).toFixed(1)).padStart(5)} s  avgH ${String(row.avgHeight).padStart(4)}  top ${Math.round(row.shareTop * 100)}%  sw ${row.switches}  ${row.mediaMbit} Mbit/s  ${(row.mediaBytes / 1e6).toFixed(0)} MB  enc ${row.encodeStarts}  path ${row.path} [${row.levelsUsed.join(",")}] end ${row.endPlaying ? "playing" : "STUCK"}` : `FAILED ${row.why}`}`);
  }
  await browser.close();
};
main().catch((e) => { console.error(e); process.exit(1); });

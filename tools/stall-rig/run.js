#!/usr/bin/env node
// Long-play stall rig: real Chrome clients play real films on a PRIVATE
// instance of this working tree for tens of minutes, and every freeze is
// written down with what the network and the server were doing at that
// moment.
//
//   node tools/stall-rig/run.js --label before --minutes 40 \
//        --media E:/aurora-stall-media --clients knives:jit,arrival:direct \
//        --cpus 4 --hw off --script seeks
//
//   --media     folder with movies/ and shows/ (a COPY of some films — the
//               instance's scanner, sweeps and caches must never see the
//               household's library)
//   --clients   comma list of <title-key>:<flavour>[@<line>]
//               flavours: web (whatever the player picks in desktop Chrome),
//               nohevc (a Chrome that cannot decode HEVC: the server encodes),
//               iphone (iPhone user agent: native HLS in Chrome 154),
//               android (Android phone user agent, hls.js)
//               title keys: the folder name lower-cased up to the first space
//               (knives, arrival, about, jolt, project, silo1, silo2)
//               @line: a tools/ttff CONDITIONS name (through tools/throttle-proxy)
//   --minutes   how long each client plays (default 30)
//   --script    what the viewer does: plain | seeks (default seeks: forward
//               and back seeks, a 3-minute pause, a 2-minute background tab)
//   --cpus      the instance (and every ffmpeg it starts) is held to this many
//               logical CPUs by its affinity mask (Windows), like a small VPS
//   --hw        hwEncode for the instance: off (a VPS has no GPU) | auto
//   --rate      playbackRate of every client (default 1)
//   --headed    watch it
//
// Output: tools/stall-rig/.runs/<label>.json (every stall with its context)
// and a summary on stdout. A "stall" is the picture not moving for >= 700 ms
// while the element is not paused and no seek WE asked for is under way (a
// seek's own wait is written down separately as a seek, with its time).
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ttff = require("../ttff/lib");

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v == null || v.startsWith("--") ? true : v;
};
const LABEL = String(arg("label", `run-${Date.now().toString(36)}`));
const MEDIA = String(arg("media", "E:/aurora-stall-media"));
const MINUTES = Number(arg("minutes", 30));
const SCRIPT = String(arg("script", "seeks"));
const CPUS = Number(arg("cpus", 0));
const CPU_OFFSET = Number(arg("cpu-offset", 0)); // which CPUs: from this one on (two rigs side by side)
// --mask <n>: an exact affinity mask instead (e.g. 0x55 = four real cores 0,2,4,6; 0x5500 = 8,10,12,14)
const MASK = arg("mask", null) != null ? Number(arg("mask")) : null;
const HW = String(arg("hw", "off"));
const RATE = Number(arg("rate", 1));
const HEADED = !!arg("headed", false);
const VERBOSE = !!arg("verbose", false);
// --restarts 8,20: the server is restarted (cleanly, by its keeper — a deploy,
// an admin's Restart, the watchdog) at these minutes; implies running under the keeper
const RESTARTS = String(arg("restarts", "")).split(",").filter(Boolean).map(Number);
const CLIENTS = String(arg("clients", "knives:web,arrival:web")).split(",").map((s) => {
  const [a, line] = s.split("@");
  const [key, flavour = "web"] = a.split(":");
  return { key, flavour, line: line || null };
});
const OUT_DIR = path.join(__dirname, ".runs");
fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stamp = (t = Date.now()) => `${((t - T0) / 1000).toFixed(1).padStart(7)}s`;

// ---- the instance's CPUs: a preload that sets its own affinity before any
// server code runs; every ffmpeg it spawns inherits the mask.
const affinityPreload = (cpus) => {
  const file = path.join(OUT_DIR, `affinity-${MASK ? "m" + MASK : cpus}-${CPU_OFFSET}.js`);
  const mask = (MASK || (2 ** cpus - 1) * 2 ** CPU_OFFSET).toString();
  fs.writeFileSync(file, `"use strict";
try {
  require("child_process").spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + process.pid + ").ProcessorAffinity = ${mask}"], { windowsHide: true, timeout: 20000 });
} catch (e) {}
`);
  return file;
};

// ---- the page probe: every freeze, every seek, every media error ----
const PROBE = () => {
  if (window.__rig) return;
  const now = () => performance.timeOrigin + performance.now();
  const R = (window.__rig = { stalls: [], seeks: [], events: [], hls: [], open: null, cur: null, ourSeekUntil: 0, played: 0, samples: 0 });
  const note = (what, extra = {}) => { if (R.events.length < 4000) R.events.push({ t: now(), what, ...extra }); };
  R.note = note;
  const bufOf = (v) => {
    const out = [];
    for (let i = 0; i < v.buffered.length; i++) out.push([+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)]);
    return out;
  };
  R.bufOf = bufOf;
  const aheadOf = (v) => {
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.3 && v.buffered.end(i) > v.currentTime) return +(v.buffered.end(i) - v.currentTime).toFixed(2);
    return 0;
  };
  R.aheadOf = aheadOf;
  const EVENTS = ["waiting", "stalled", "error", "emptied", "loadstart", "ended", "seeking", "seeked", "pause", "play", "playing"];
  const create = Document.prototype.createElement;
  Document.prototype.createElement = function (name, ...rest) {
    const el = create.call(this, name, ...rest);
    try {
      if (String(name).toLowerCase() === "video") {
        el.muted = true;
        for (const ev of EVENTS) el.addEventListener(ev, () => note(`v:${ev}`, { ct: +el.currentTime.toFixed(2), rs: el.readyState, ns: el.networkState, err: el.error ? el.error.code + " " + (el.error.message || "") : undefined }));
      }
    } catch {}
    return el;
  };
  // hls.js: errors, level switches, buffer flushes
  try {
    let wrapped;
    Object.defineProperty(window, "Hls", {
      configurable: true,
      get: () => wrapped,
      set: (Hv) => {
        wrapped = Hv && class extends Hv {
          constructor(cfg) {
            super(cfg);
            window.__rigHls = this;
            const E = Hv.Events;
            const n = (what, extra) => { if (R.hls.length < 3000) R.hls.push({ t: now(), what, ...extra }); };
            this.on(E.ERROR, (_e, d) => n("error", { details: d && d.details, fatal: !!(d && d.fatal), type: d && d.type, code: d && d.response && d.response.code, sn: d && d.frag ? d.frag.sn : undefined, url: d && (d.url || (d.frag && d.frag.url) || (d.context && d.context.url)) ? String(d.url || (d.frag && d.frag.url) || d.context.url).replace(/^https?:\/\/[^/]+/, "").slice(0, 120) : undefined }));
            this.on(E.LEVEL_SWITCHED, (_e, d) => n("level", { level: d.level }));
            if (E.BUFFER_FLUSHING) this.on(E.BUFFER_FLUSHING, (_e, d) => n("flush", { from: d && d.startOffset, to: d && d.endOffset }));
            this.on(E.DESTROYING, () => n("destroy"));
          }
        };
      },
    });
  } catch {}
  // the freeze detector
  setInterval(() => {
    const v = document.querySelector(".player video");
    const t = now();
    if (!v) { if (R.open) { R.open.end = t; R.open.why = "player gone"; R.stalls.push(R.open); R.open = null; } return; }
    R.samples++;
    const ct = v.currentTime;
    const last = R.cur;
    R.cur = { t, ct, el: v };
    if (!last || last.el !== v) return;
    const moved = ct - last.ct;
    if (moved > 0 && moved < 2) { R.played += moved; if (R.played > 1) R.started = true; }
    // (before the film has really played once, a wait is the START, not a stall)
    const frozen = R.started && !v.paused && !v.ended && Math.abs(moved) < 0.01;
    const ours = t < R.ourSeekUntil;
    if (frozen && !R.open) {
      R.open = { start: last.t, ct: +ct.toFixed(2), rs: v.readyState, ns: v.networkState, ahead: aheadOf(v), buf: bufOf(v), seeking: v.seeking, ours, hash: location.hash, src: (v.currentSrc || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 120) };
    } else if (!frozen && R.open) {
      R.open.end = t;
      R.open.ms = Math.round(t - R.open.start);
      R.open.after = { ct: +ct.toFixed(2), buf: bufOf(v) };
      if (R.open.ms >= 700) (R.open.ours ? R.seeks : R.stalls).push(R.open);
      R.open = null;
    } else if (frozen && R.open && R.open.ms == null && t - R.open.start > 5000 && !R.open.mid) {
      R.open.mid = { rs: v.readyState, ns: v.networkState, ahead: aheadOf(v), buf: bufOf(v), seeking: v.seeking };
    }
  }, 250);
};

const run = async () => {
  const preload = CPUS > 0 ? [affinityPreload(CPUS)] : [];
  // --tree <name>: the app from a frozen snapshot (node tools/ttff/snapshot.js <name> [<rev>]) — a "before"
  const TREE = (() => { const i = process.argv.indexOf("--tree"); return i < 0 ? null : process.argv[i + 1]; })();
  const server = require(TREE ? path.join(require("../ttff/snapshot").treeDir(TREE), "scripts", "ui-test-server.js") : "../../scripts/ui-test-server");
  if (TREE) console.log(`[rig] the app from snapshot ${TREE}`);
  const calFile = path.join(__dirname, "..", "ttff", ".runs", "encode-calibration.json");
  let cal = null;
  try { cal = JSON.parse(fs.readFileSync(calFile, "utf8")); } catch {}
  console.log(`[rig] ${LABEL}: starting a private instance (cpus ${CPUS || "all"}, hw ${HW}) on ${MEDIA}`);
  const srv = await server.start({
    preload,
    waitForLibrary: false, // (below, with a longer patience: real films on a spinning disk)
    ...(RESTARTS.length ? { keeper: true } : {}),
    ...(cal && CPUS === 0 ? { seed: { "cache/encode-calibration.json": cal } } : {}),
    config: {
      libraries: { movies: [path.join(MEDIA, "movies")], shows: [path.join(MEDIA, "shows")] },
      hwEncode: HW,
    },
  });
  // the server's log, stamped as it arrives
  const slog = [];
  let seen = 0;
  const pollLog = setInterval(() => {
    const all = srv.log();
    // (srv.log keeps the last 5000; count from the end when it has rotated)
    const fresh = all.length >= seen ? all.slice(seen) : all;
    seen = all.length;
    const t = Date.now();
    for (const line of fresh) {
      slog.push({ t, line });
      if (VERBOSE || /\[jit\]|\[remux\]|\[watchdog\]|\[hwenc\]|\[torrent|error|failed|parked|exited/i.test(line)) {
        if (!/\[warm\]|\[play\]/.test(line)) console.log(`${stamp(t)} srv ${line.slice(0, 220)}`);
      }
    }
  }, 300);
  if (CPUS > 0) {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${srv.pid}).ProcessorAffinity`], { encoding: "utf8", windowsHide: true });
    console.log(`[rig] instance pid ${srv.pid} affinity mask: ${String(r.stdout).trim()}`);
  }
  const api = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const admin = { "X-Admin-Password": srv.adminPassword };
  const makeProfile = async (name) => {
    const password = "pass-" + name.toLowerCase();
    const { request } = await api("POST", "/api/profiles", { name, password, realName: `${name} Tester`, avatar: "🦊", color: "#2c9fe0" });
    const p = await api("POST", `/api/admin/profile-requests/${request.id}/approve`, {}, admin);
    const token = (await api("POST", `/api/profiles/${p.id}/unlock`, { password })).token;
    const h = token ? { "X-Profile-Token": token } : {};
    await api("PUT", `/api/profiles/${p.id}`, { lookNoticeSeen: true }, h);
    await api("POST", `/api/profiles/${p.id}/password`, { newPassword: "", currentPassword: password }, h);
    return { id: p.id, name };
  };
  let lib = null;
  for (const until = Date.now() + 300000; Date.now() < until; await sleep(1000)) {
    try { lib = await api("GET", "/api/library"); } catch { lib = null; }
    if (lib && lib.enriched && lib.movies.length && lib.movies.every((m) => m.duration > 0)) break;
  }
  const titles = {};
  for (const m of lib.movies) titles[m.title.toLowerCase().split(" ")[0]] = { id: m.id, title: m.title, duration: m.duration };
  for (const s of lib.shows) {
    const full = await api("GET", `/api/item/${s.id}`);
    for (const se of full.seasons || []) for (const e of se.episodes || []) titles[`${s.title.toLowerCase().split(" ")[0]}${e.episode}`] = { id: e.id, title: `${s.title} E${e.episode}`, duration: e.duration };
  }
  console.log(`[rig] titles: ${Object.entries(titles).map(([k, t]) => `${k}=${t.id}(${Math.round(t.duration / 60)}m)`).join(" ")}`);

  const browsers = {};
  const browserFor = async (noHevc) => {
    const k = noHevc ? "nohevc" : "std";
    if (!browsers[k]) browsers[k] = await ttff.launch({ headed: HEADED, noHevc });
    return browsers[k];
  };
  const UA = {
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
  };
  const proxies = [];
  const results = [];
  const clients = await Promise.all(CLIENTS.map(async (c, i) => {
    const title = titles[c.key];
    if (!title) throw new Error(`no title "${c.key}" in the library (have ${Object.keys(titles).join(", ")})`);
    let base = srv.url;
    if (c.line) {
      const cond = ttff.CONDITIONS[c.line];
      const p = await ttff.throttle.start({ listen: 0, host: "127.0.0.1", to: srv.port, quiet: true, handshake: true, slowstart: true, ...cond });
      proxies.push(p);
      base = `http://127.0.0.1:${p.port}`;
    }
    const browser = await browserFor(c.flavour === "nohevc");
    const phone = c.flavour === "iphone" || c.flavour === "android";
    const ctx = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 720 },
      ...(UA[c.flavour] ? { userAgent: UA[c.flavour], isMobile: true, hasTouch: true } : {}),
    });
    const profile = await makeProfile(`R${i}${Date.now().toString(36).slice(-4)}`);
    await ctx.addInitScript(({ id }) => {
      try {
        if (sessionStorage.getItem("rig-seeded")) return;
        sessionStorage.setItem("rig-seeded", "1");
        localStorage.setItem("aurora-profile", id);
        localStorage.setItem("aurora-kbd-hint", "1");
        localStorage.setItem("aurora-nav-hinted", "1");
      } catch {}
    }, { id: profile.id });
    await ctx.addInitScript(PROBE);
    const page = await ctx.newPage();
    const net = await ttff.netlog(ctx, page);
    const name = `${i}:${c.key}:${c.flavour}${c.line ? "@" + c.line : ""}`;
    const consoleLines = [];
    page.on("console", (m) => { const tx = m.text(); if (consoleLines.length < 3000) consoleLines.push({ t: Date.now(), type: m.type(), text: tx.slice(0, 300) }); if (/\[player\]|stall|recover|error/i.test(tx) && VERBOSE) console.log(`${stamp()} ${name} console ${tx.slice(0, 200)}`); });
    page.on("pageerror", (e) => consoleLines.push({ t: Date.now(), type: "pageerror", text: String(e.message).slice(0, 300) }));
    return { c, i, name, title, ctx, page, net, base, consoleLines, profile, actions: [] };
  }));

  // open every player
  for (const cl of clients) {
    await cl.page.goto(`${cl.base}/#/movies`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await cl.page.waitForSelector("#app .screen", { timeout: 60000 }).catch(() => {});
    await cl.page.evaluate((h) => { location.hash = h; }, `#/play/${cl.title.id}`);
    cl.t0 = Date.now();
    console.log(`${stamp()} ${cl.name} opened ${cl.title.title}`);
  }
  for (const cl of clients) {
    await cl.page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 0.5; }, null, { timeout: 120000 }).catch((e) => console.log(`${stamp()} ${cl.name} did not start: ${e.message.split("\n")[0]}`));
    if (RATE !== 1) await cl.page.evaluate((r) => { const v = document.querySelector(".player video"); if (v) v.playbackRate = r; }, RATE);
    console.log(`${stamp()} ${cl.name} playing`);
  }

  // the viewer's script, per client, on a staggered timeline (minutes from start)
  const SCRIPTS = {
    plain: [],
    seeks: [
      { at: 6, do: "seek", by: 600 },
      { at: 10, do: "pause", ms: 180000 },
      { at: 16, do: "seek", by: -240 },
      { at: 20, do: "hide", ms: 120000 },
      { at: 25, do: "seek", by: 1500 },
      { at: 28, do: "seek", by: 30 },
      { at: 34, do: "pause", ms: 60000 },
      { at: 40, do: "seek", by: -900 },
    ],
  };
  const steps = SCRIPTS[SCRIPT] || [];
  const act = async (cl, s) => {
    const p = cl.page;
    const at = Date.now();
    if (s.do === "seek") {
      // As a viewer does it: a click on the player's timeline (the player
      // decides what a seek means on its path — a far seek on an offset
      // stream is a new job, on jit a segment further on).
      const film = cl.title.duration;
      const now = await p.evaluate(() => {
        window.__rig.ourSeekUntil = performance.timeOrigin + performance.now() + 30000;
        const el = document.querySelector(".player .scrub-row > span");
        const parts = el ? el.textContent.trim().split(":").map(Number) : [];
        return parts.length && parts.every(Number.isFinite) ? parts.reduce((a, n) => a * 60 + n, 0) : null;
      }).catch(() => null);
      let r = null;
      if (now != null && film > 0) {
        const to = Math.max(0, Math.min(film - 90, now + s.by));
        await p.mouse.move(500 + (cl.actions.length % 2) * 20, 250).catch(() => {});
        await sleep(400);
        const box = await p.locator(".player .scrubber").boundingBox().catch(() => null);
        if (box) {
          await p.mouse.click(box.x + box.width * (to / film), box.y + box.height / 2).catch(() => {});
          r = { from: now, to: Math.round(to), via: "scrubber" };
        }
      }
      if (!r) {
        r = await p.evaluate((by) => {
          const v = document.querySelector(".player video");
          if (!v) return null;
          const to = Math.max(0, Math.min((v.duration || 1e9) - 60, v.currentTime + by));
          v.currentTime = to;
          return { from: +(to - by).toFixed(1), to: +to.toFixed(1), via: "currentTime" };
        }, s.by).catch(() => null);
      }
      await sleep(800);
      // the seek's wait ends when the clock moves again
      await p.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.seeking && v.readyState >= 3 && !v.paused; }, null, { timeout: 60000 }).catch(() => {});
      await p.evaluate(() => { window.__rig.ourSeekUntil = performance.timeOrigin + performance.now() + 1500; }).catch(() => {});
      cl.actions.push({ t: at, ...s, ...(r || {}), waitMs: Date.now() - at });
      console.log(`${stamp()} ${cl.name} seek ${s.by > 0 ? "+" : ""}${s.by}s ${r ? `${r.from}→${r.to}` : ""} ready after ${Date.now() - at} ms`);
    } else if (s.do === "pause") {
      await p.evaluate(() => document.querySelector(".player video")?.pause()).catch(() => {});
      console.log(`${stamp()} ${cl.name} pause ${s.ms / 1000}s`);
      await sleep(s.ms);
      await p.evaluate(() => { window.__rig.ourSeekUntil = performance.timeOrigin + performance.now() + 1500; return document.querySelector(".player video")?.play(); }).catch(() => {});
      cl.actions.push({ t: at, ...s });
      console.log(`${stamp()} ${cl.name} resume`);
    } else if (s.do === "hide") {
      // another tab in front: this one is hidden (timers throttled, rAF stopped)
      const other = await cl.ctx.newPage();
      await other.goto("about:blank");
      await other.bringToFront();
      const vis = await p.evaluate(() => document.visibilityState).catch(() => "?");
      console.log(`${stamp()} ${cl.name} background tab (${vis}) for ${s.ms / 1000}s`);
      await sleep(s.ms);
      await p.bringToFront();
      await other.close();
      cl.actions.push({ t: at, ...s, vis });
    }
  };
  const until = Date.now() + MINUTES * 60000;
  const restartTimers = RESTARTS.map((m) => setTimeout(() => {
    console.log(`${stamp()} RESTART: asking the keeper to restart the server`);
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "..", "scripts", "keeper.js"), "--restart", "--data", srv.dataDir], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    console.log(`${stamp()} RESTART: ${String(r.stdout || r.stderr).trim().slice(0, 200)}`);
  }, m * 60000));
  const ticker = setInterval(async () => {
    const parts = [];
    for (const cl of clients) {
      const st = await cl.page.evaluate(() => { const R = window.__rig; const v = document.querySelector(".player video"); return { n: R.stalls.length, open: R.open ? Math.round(performance.timeOrigin + performance.now() - R.open.start) : 0, ct: v ? Math.round(v.currentTime) : null, ahead: v ? R.aheadOf(v) : null }; }).catch(() => null);
      parts.push(`${cl.name} ct ${st ? st.ct : "?"} ahead ${st ? st.ahead : "?"} stalls ${st ? st.n : "?"}${st && st.open > 1500 ? ` (FROZEN ${st.open} ms)` : ""}`);
    }
    console.log(`${stamp()} | ${parts.join(" | ")}`);
  }, 60000);
  await Promise.all(clients.map(async (cl, n) => {
    const start = Date.now() + n * 20000; // staggered so the clients do not act at once
    for (const s of steps) {
      const when = start + s.at * 60000;
      if (when > until) break;
      while (Date.now() < when) await sleep(1000);
      await act(cl, s).catch((e) => console.log(`${stamp()} ${cl.name} ${s.do} failed: ${e.message.split("\n")[0]}`));
    }
    while (Date.now() < until) {
      await sleep(5000);
      const st = await cl.page.evaluate(() => { const R = window.__rig; const v = document.querySelector(".player video"); return { stalls: R.stalls.length, open: !!R.open, ct: v ? +v.currentTime.toFixed(0) : null, ended: v ? v.ended : null }; }).catch(() => null);
      if (st && st.ended) break;
    }
  }));
  clearInterval(ticker);
  for (const t of restartTimers) clearTimeout(t);
  for (const cl of clients) {
    const R = await cl.page.evaluate(() => { const R = window.__rig; const v = document.querySelector(".player video"); const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null; return { stalls: R.stalls, seeks: R.seeks, open: R.open, events: R.events, hls: R.hls, played: R.played, ct: v ? v.currentTime : null, src: v ? v.currentSrc : null, frames: q ? { dropped: q.droppedVideoFrames, total: q.totalVideoFrames } : null }; }).catch((e) => ({ error: e.message }));
    const reqs = cl.net.all().filter((r) => r.kind !== "image" && r.kind !== "script");
    // every stall in context
    const ctxOf = (s) => {
      const a = s.start - 15000;
      const b = (s.end || Date.now()) + 2000;
      return {
        requests: reqs.filter((r) => (r.kind === "segment" || r.kind === "playlist" || r.kind === "video" || r.kind === "subtitle") && r.start <= b && (r.end || Date.now()) >= a)
          .map((r) => ({ kind: r.kind, path: r.path.slice(0, 110), range: r.range || undefined, status: r.status, failed: r.failed, start: Math.round(r.start - s.start), ttfb: r.ttfb ? Math.round(r.ttfb - s.start) : null, end: r.end ? Math.round(r.end - s.start) : null, bytes: r.bytes, srv: r.server && r.server.seg != null ? Math.round(r.server.seg) : undefined })),
        server: slog.filter((l) => l.t >= a && l.t <= b && !/\[warm\]/.test(l.line)).map((l) => `${Math.round(l.t - s.start)} ${l.line.slice(0, 220)}`),
        hls: (R.hls || []).filter((h) => h.t >= a && h.t <= b).map((h) => ({ ...h, t: Math.round(h.t - s.start) })),
        events: (R.events || []).filter((h) => h.t >= a && h.t <= b).map((h) => ({ ...h, t: Math.round(h.t - s.start) })),
        console: cl.consoleLines.filter((l) => l.t >= a && l.t <= b).map((l) => `${Math.round(l.t - s.start)} ${l.type} ${l.text}`),
      };
    };
    const stalls = (R.stalls || []).map((s) => ({ ...s, ctx: ctxOf(s) }));
    if (R.open) stalls.push({ ...R.open, unfinished: true, ms: Math.round(Date.now() - R.open.start), ctx: ctxOf(R.open) });
    const bad = reqs.filter((r) => (r.status && r.status >= 400) || r.failed).map((r) => ({ kind: r.kind, path: r.path.slice(0, 110), status: r.status, failed: r.failed, at: Math.round((r.start - cl.t0) / 1000) }));
    const slowSegs = reqs.filter((r) => r.kind === "segment" && r.end && r.end - r.start > 3000).map((r) => ({ path: r.path.slice(0, 100), ms: Math.round(r.end - r.start), ttfb: r.ttfb ? Math.round(r.ttfb - r.start) : null, at: Math.round((r.start - cl.t0) / 1000) }));
    const marks = reqs.filter((r) => r.kind === "mark" && r.body).map((r) => { try { const m = JSON.parse(r.body); return { at: Math.round((r.start - cl.t0) / 1000), ...m }; } catch { return null; } }).filter(Boolean);
    const row = {
      label: LABEL, client: cl.name, title: cl.title.title, flavour: cl.c.flavour, line: cl.c.line, minutes: MINUTES, cpus: CPUS, hw: HW,
      played: Math.round(R.played || 0), endAt: R.ct, frames: R.frames || null, src: (R.src || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 120),
      stallCount: stalls.length, stallMs: stalls.reduce((n, s) => n + (s.ms || 0), 0),
      seeks: (R.seeks || []).map((s) => ({ ms: s.ms, ct: s.ct })), actions: cl.actions,
      paths: [...new Set(marks.filter((m) => m.name === "path").map((m) => m.path))],
      marks: marks.filter((m) => !["mount"].includes(m.name)).slice(0, 200).map((m) => `${m.at}s ${m.name}${m.path ? ":" + m.path : ""}${m.why ? ":" + m.why : ""}${m.to ? ":" + m.to : ""}`),
      bad, slowSegs, hlsErrors: (R.hls || []).filter((h) => h.what === "error").map((h) => ({ at: Math.round((h.t - cl.t0) / 1000), details: h.details, fatal: h.fatal, code: h.code, url: h.url })),
      stalls,
    };
    results.push(row);
    console.log(`\n== ${cl.name} ${cl.title.title}: played ${row.played}s, ${row.stallCount} stalls, ${(row.stallMs / 1000).toFixed(1)} s frozen; paths ${row.paths.join(",")}; bad requests ${bad.length}; slow segments ${slowSegs.length}; hls errors ${row.hlsErrors.length}`);
    for (const s of stalls) console.log(`   stall ${stamp(s.start)} ${s.ms} ms at ${s.ct}s ahead ${s.ahead}s rs ${s.rs} seeking ${s.seeking}${s.unfinished ? " (UNFINISHED)" : ""}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.json`), JSON.stringify({ label: LABEL, at: new Date(T0).toISOString(), minutes: MINUTES, cpus: CPUS, hw: HW, script: SCRIPT, results, serverLog: slog.filter((l) => !/\[warm\]/.test(l.line)).map((l) => `${stamp(l.t)} ${l.line.slice(0, 300)}`) }, null, 1));
  console.log(`\n[rig] written ${path.join(OUT_DIR, `${LABEL}.json`)}`);
  clearInterval(pollLog);
  for (const b of Object.values(browsers)) await b.close().catch(() => {});
  for (const p of proxies) await p.close().catch(() => {});
  await srv.stop();
};

run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

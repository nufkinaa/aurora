#!/usr/bin/env node
// The website as a person feels it, with the server FAR away: start-up, moving
// around, taps, a long session — on a desktop and on a phone, on a fast line
// and on a slow one.
//
//   node tools/webperf/feel.js --instance <state file> --label before
//        [--cells desktop:fast,desktop:slow,phone:fast,phone:slow]
//        [--only start,flows] [--runs 5] [--look glass]
//        [--session 600]  (seconds of browsing for --only session)
//        [--flows title,back]  (only these flows)
//
// The line: Chrome → an HTTPS/HTTP-2 front (tools/mobile-perf/front.js, where
// Caddy stands on nufurora.com) → slowproxy.js (every request waits a round
// trip, every byte is paced to the line's speed) → the private instance. The
// front sees every request that crossed the line — the service worker's
// included, which Chrome's own line emulation (CDP) does not slow down.
//
//   lines   fast  70 ms round trip, 50 Mbit/s (a desktop 70 ms from the server)
//           slow  250 ms, 3 Mbit/s (a phone on a poor mobile line)
//   devices desktop 1440×900, CPU ×1;  phone 390×844 ×3, touch, CPU ×4
//
// start   per run a fresh browser context: COLD (no HTTP cache, no service
//         worker, the profile remembered) and then WARM (the same page opened
//         again: cache and worker in place). TTFB, FCP, LCP (before the
//         billboard first turns), rows (Home's own mark: shelves on the page),
//         hero (the billboard's picture in), shelf1 (the first shelf's
//         pictures in view are in), screen (every picture in view is in);
//         requests and KB that crossed the line by then and in all (12 s),
//         by kind; main-thread time (script, layout, style) and long tasks.
//         The first run of a fresh instance is thrown away (it cuts its
//         pictures to size on that run).
// flows   on a warm page, each from a tap to: the screen's words (no
//         skeleton left) and its pictures in view; the tap's own input →
//         next paint (Event Timing); long tasks during the flow.
//           title (a shelf card) · back (to Home) · movies (the tab) ·
//           movies-scroll (three screens) · movies-title · search (a word
//           typed, a letter at a time: each key → results painted) · player
//           (Play → the play request leaves — nothing after it is watched) ·
//           calendar · list · downloads
// session --session seconds of a ten-screen tour, round after round: per
//         round after a forced collection the JS heap, DOM nodes, listeners,
//         documents; intervals and timers alive; animations running and how
//         many of them on things nobody can see; frames asked for in 2 s of
//         sitting still on Settings.
//
// Writes out/<label>/feel.json (every run) and prints the medians.
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { OUT, argv, list, DEVICES, launch, sleep, median, writeJson } = require("./lib");
const { startFront } = require("../mobile-perf/front");

const LINES = { fast: { rtt: 70, mbit: 50 }, slow: { rtt: 250, mbit: 3 }, local: null };
const DEV = { desktop: { d: "desktop-1440", cpu: 1 }, phone: { d: "phone-390", cpu: 4 } };

// ---- in the page, from the first byte
const WATCH = () => {
  const w = (window.__fl = { long: [], lcps: [], events: [], intervals: new Map(), timers: 0 });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.long.push({ t: e.startTime, d: e.duration, a: (e.attribution || []).map((x) => x.containerSrc || x.name).join(",") }); }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { const el = e.element; w.lcps.push({ t: e.startTime, size: e.size, el: el ? el.tagName.toLowerCase() + "." + String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className).split(/\s+/).slice(0, 2).join(".") : null }); } }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) w.events.push({ t: e.startTime, name: e.name, d: e.duration, id: e.interactionId, pd: e.processingStart - e.startTime, pr: e.processingEnd - e.processingStart }); }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch {}
  // intervals alive (what keeps ticking on screens left behind)
  const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = function (fn, ms, ...a) {
    const id = si.call(window, fn, ms, ...a);
    w.intervals.set(id, { ms, at: (new Error().stack || "").split("\n").slice(2, 4).map((s) => s.trim().replace(/^at /, "").replace(/\?v=[0-9a-f]+/, "")).join(" < ") });
    return id;
  };
  window.clearInterval = function (id) { w.intervals.delete(id); return ci.call(window, id); };
};

// the moment (page clock, at a frame) a condition first holds
const when = (page, fn, arg, timeout = 60000) =>
  page.waitForFunction(fn, arg, { polling: "raf", timeout }).then((h) => h.jsonValue()).catch(() => null);

// in the page: is every picture in view in?
const PICS_IN = (scope) => {
  const root = scope ? document.querySelector(scope) : document.getElementById("app");
  if (!root) return null;
  const vh = innerHeight, vw = innerWidth;
  let n = 0;
  for (const im of root.querySelectorAll("img")) {
    const r = im.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    if (getComputedStyle(im).visibility === "hidden") continue;
    n++;
    const poster = im.classList.contains("img-blurup") || im.classList.contains("img-fade");
    if (poster ? !im.classList.contains("img-in") : !(im.complete && im.naturalWidth > 0)) return null;
  }
  return performance.now();
};
// the billboard's picture (a CSS background): when its file had arrived
const HERO_AT = () => {
  const layer = document.querySelector("#app .hero-backdrop.on") || document.querySelector("#app .hero-backdrop");
  if (!layer) return null;
  const cs = getComputedStyle(layer);
  const portrait = matchMedia("(max-width: 900px) and (orientation: portrait)").matches;
  const v = (portrait ? layer.style.getPropertyValue("--hero-poster") : layer.style.getPropertyValue("--hero-art")) || cs.backgroundImage;
  const m = /url\("?([^")]+)"?\)/.exec(v || "");
  if (!m) return null;
  const abs = new URL(m[1], location.href).href;
  const e = performance.getEntriesByName(abs).find((x) => x.responseEnd > 0);
  return e ? e.responseEnd : null;
};
const SETTLED = () => {
  const app = document.getElementById("app");
  if (!app || app.childElementCount === 0) return null;
  if (app.querySelector(".skeleton, .route-skel, .cal-skel, .calg-skel, .grid-skel")) return null;
  return performance.now();
};

const metrics = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

// ---- the line
const startLine = async (inst, line, log) => {
  if (!LINES[line]) return { url: inst.url, stop: async () => {} };
  const { rtt, mbit } = LINES[line];
  const child = spawn(process.execPath, [path.join(__dirname, "slowproxy.js"), "--to", inst.url, "--rtt", String(rtt), "--mbit", String(mbit)], { stdio: ["ignore", "pipe", "inherit"] });
  process.on("exit", () => { try { process.kill(child.pid); } catch {} });
  const proxyUrl = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (c) => { buf += c; const m = buf.match(/\{.*\}/); if (m) resolve(JSON.parse(m[0]).url); });
    child.on("exit", () => reject(new Error("slowproxy exited")));
  });
  const t0 = Date.now();
  const front = await startFront(proxyUrl, { onLog: (e) => log.push({ ...e, t0: e.t0 - t0, t1: e.t1 - t0 }) });
  return { url: front.url, spki: front.spki, stop: async () => { await front.stop(); try { process.kill(child.pid); } catch {} } };
};

const kindOf = (u, type) => {
  if (/^\/api\//.test(u)) return "api";
  if (/^\/img\/|\.(png|jpe?g|webp|avif)(\?|$)/.test(u) || /^image\//.test(type)) return "img";
  if (/\.js(\?|$)/.test(u)) return "js";
  if (/\.css(\?|$)/.test(u)) return "css";
  if (u === "/" || /^\/(\?|#|$)/.test(u)) return "html";
  return "other";
};
const wire = (log, from, to) => {
  const e = log.filter((x) => x.t1 >= from && x.t1 <= to);
  const by = {};
  for (const x of e) { const k = kindOf(x.url, x.type); (by[k] = by[k] || { n: 0, kb: 0 }); by[k].n++; by[k].kb += x.bytes / 1024; }
  for (const k of Object.keys(by)) by[k].kb = Math.round(by[k].kb);
  return { n: e.length, kb: Math.round(e.reduce((a, x) => a + x.bytes, 0) / 1024), by };
};

const prime = async (page, origin, inst, look) => {
  await page.goto(`${origin}/robots.txt`, { waitUntil: "load" });
  const p = inst.profiles[look];
  await page.evaluate(([id, name, look]) => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem("aurora-profile", id);
    localStorage.setItem("aurora-profile-name", JSON.stringify(name));
    localStorage.setItem("aurora-look", look === "legacy" ? "legacy" : "glass");
    localStorage.setItem("aurora-authmode", "open");
    localStorage.setItem("aurora-early", "open");
    localStorage.setItem("aurora-nav-hinted", "1");
    localStorage.setItem("aurora-kbd-hint", "1");
    localStorage.setItem("aurora-data-mode", "full");
  }, [p.id, p.name, look]);
};

// ---- start-up
const startOnce = async (page, cdp, origin, log, { reload }) => {
  const m0 = await metrics(cdp);
  const n0 = log.length;
  const tWall = Date.now();
  const logStart = log.length ? log[log.length - 1].t1 : 0;
  if (reload) await page.reload({ waitUntil: "commit", timeout: 120000 });
  else await page.goto(`${origin}/#/`, { waitUntil: "commit", timeout: 120000 });
  const rows = await when(page, () => { const m = performance.getEntriesByName("aurora-home-rows")[0]; return m ? m.startTime : null; }, null, 120000);
  const hero = await when(page, HERO_AT, null, 30000);
  const shelf1 = await when(page, () => {
    const row = [...document.querySelectorAll('#app [data-kind="shelf"]')].find((r) => r.querySelector("img"));
    if (!row) return null;
    // (the cards across the window's width, wherever the shelf sits: what
    // is seen of it once it is scrolled to)
    let n = 0;
    for (const im of row.querySelectorAll("img")) {
      const r = im.getBoundingClientRect();
      if (r.width < 8 || r.left >= innerWidth || r.right <= 0) continue;
      n++;
      if (!im.classList.contains("img-in") && !(im.complete && im.naturalWidth > 0 && !im.classList.contains("img-blurup") && !im.classList.contains("img-fade"))) return null;
    }
    return n ? performance.now() : null;
  }, null, 60000);
  const imgs = await when(page, PICS_IN, null, 60000);
  const screen = imgs != null && hero != null ? Math.max(imgs, hero) : null;
  // the window: 12 s from the start
  const since = Date.now() - tWall;
  await sleep(Math.max(12000 - since, 1500));
  const m1 = await metrics(cdp);
  const p = await page.evaluate((rows) => {
    const w = window.__fl;
    const nav = performance.getEntriesByType("navigation")[0];
    const fcpE = performance.getEntriesByName("first-contentful-paint")[0];
    const cut = rows != null ? rows + 8500 : Infinity;
    const lcps = w.lcps.filter((e) => e.t < cut);
    const lcp = lcps.length ? lcps[lcps.length - 1] : null;
    const res = performance.getEntriesByType("resource");
    return {
      ttfb: nav ? Math.round(nav.responseStart) : null,
      dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      fcp: fcpE ? Math.round(fcpE.startTime) : null,
      lcp: lcp ? Math.round(lcp.t) : null,
      lcpEl: lcp ? lcp.el : null,
      longTasks: w.long.length,
      blocked: Math.round(w.long.reduce((a, l) => a + Math.max(0, l.d - 50), 0)),
      long: w.long.map((l) => [Math.round(l.t), Math.round(l.d)]),
      pageRequests: res.length,
      swServed: res.filter((r) => r.workerStart > 0 && r.transferSize === 0).length,
      domNodes: document.getElementsByTagName("*").length,
    };
  }, rows);
  // what crossed the line: until each moment (page clock ≈ line clock from its start)
  const L = log.slice(n0);
  const base = L.length ? Math.min(...L.map((x) => x.t0)) : 0;
  const rel = L.map((x) => ({ ...x, t1: x.t1 - base }));
  const r = (v) => (v == null ? null : Math.round(v));
  return {
    ...p,
    rows: r(rows), hero: r(hero), shelf1: r(shelf1), screen: r(screen),
    wireToRows: rows != null ? wire(rel, -1, rows).n : null,
    kbToRows: rows != null ? wire(rel, -1, rows).kb : null,
    wireToScreen: screen != null ? wire(rel, -1, screen).n : null,
    kbToScreen: screen != null ? wire(rel, -1, screen).kb : null,
    wire: wire(rel, -1, 1e9),
    // (a reload starts the counters again: the warm side reads them whole)
    script: Math.round((m1.ScriptDuration - (reload ? 0 : m0.ScriptDuration)) * 1000),
    layout: Math.round((m1.LayoutDuration - (reload ? 0 : m0.LayoutDuration)) * 1000),
    style: Math.round((m1.RecalcStyleDuration - (reload ? 0 : m0.RecalcStyleDuration)) * 1000),
    task: Math.round((m1.TaskDuration - (reload ? 0 : m0.TaskDuration)) * 1000),
    urls: rel.map((x) => [Math.round(x.t1), x.status, x.bytes, x.url.slice(0, 90)]),
    _logStart: logStart,
  };
};

// ---- moving around
const flows = async ({ page, cdp, inst, touch, vp }) => {
  const out = {};
  const now = () => page.evaluate(() => performance.now());
  const press = async (h) => { if (touch) await h.tap(); else await h.click(); };
  const pick = list("flows", "");
  const flow = async (name, fn, { settle = 800 } = {}) => {
    if (pick.length && !pick.includes(name)) return;
    await page.evaluate(() => { window.__fl.mark = performance.now(); });
    const before = await metrics(cdp);
    let extra = {};
    try { extra = (await fn()) || {}; } catch (e) { extra = { error: String(e.message || e).slice(0, 120) }; }
    await sleep(settle);
    const after = await metrics(cdp);
    const w = await page.evaluate(() => {
      const w = window.__fl, s = w.mark;
      const ev = w.events.filter((e) => e.t >= s);
      const by = new Map();
      for (const e of ev) by.set(e.id, Math.max(by.get(e.id) || 0, e.d));
      const long = w.long.filter((l) => l.t >= s);
      return { inp: by.size ? Math.round(Math.max(...by.values())) : null, longTasks: long.length, blocked: Math.round(long.reduce((a, l) => a + Math.max(0, l.d - 50), 0)), worstTask: Math.round(Math.max(0, ...long.map((l) => l.d))) };
    });
    out[name] = { ...extra, ...w, script: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000), layout: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000), style: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000) };
  };
  // from a tap: the words, then the pictures
  const land = async (t0, { pics = true } = {}) => {
    const words = await when(page, SETTLED, null, 60000);
    const shown = pics ? await when(page, PICS_IN, null, 30000) : null;
    return { words: words != null ? Math.round(words - t0) : null, pics: shown != null ? Math.round(shown - t0) : null };
  };
  const pickCard = () => page.evaluateHandle(() => {
    const rows = [...document.querySelectorAll('[data-kind="shelf"] .row-scroller')];
    for (const row of rows) {
      const c = [...row.querySelectorAll(".card")].find((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top > 80 && r.bottom < innerHeight - 90 && c._item && c._item.source === "stream"; });
      if (c) return c;
    }
    for (const row of rows) {
      row.scrollIntoView({ block: "center" });
      const c = [...row.querySelectorAll(".card")].find((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top > 80 && r.bottom < innerHeight - 90 && c._item && c._item.source === "stream"; });
      if (c) return c;
    }
    return null;
  });
  const scroll = (dy, repeat = 1) => cdp.send("Input.synthesizeScrollGesture", { x: Math.round(vp.width / 2), y: Math.round(vp.height * 0.7), yDistance: -Math.round(dy), speed: 2400, gestureSourceType: touch ? "touch" : "mouse", repeatCount: repeat, repeatDelayMs: 200 });

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1500);
  // Home → a title → Back
  {
    const card = (await pickCard()).asElement();
    await sleep(800);
    await flow("title", async () => { const t0 = await now(); await press(card); return land(t0); }, { settle: 1500 });
    await flow("back", async () => {
      const t0 = await now();
      await page.goBack({ waitUntil: "commit" }).catch(() => {});
      const rows = await when(page, () => { const c = document.querySelector("#app .row .card"); return c && c.getBoundingClientRect().height > 0 ? performance.now() : null; });
      const l = await land(t0);
      return { rows: rows != null ? Math.round(rows - t0) : null, ...l };
    }, { settle: 1500 });
  }
  // Home → Movies → scroll → a title
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);
  await flow("movies", async () => {
    const t0 = await now();
    const item = await page.$('.nav-item[data-route="#/movies"]');
    await press(item);
    const grid = await when(page, () => { const c = document.querySelector("#app .grid .card"); return c && c.getBoundingClientRect().height > 0 ? performance.now() : null; });
    const l = await land(t0);
    return { grid: grid != null ? Math.round(grid - t0) : null, ...l };
  }, { settle: 1200 });
  await flow("movies-scroll", async () => {
    await scroll(vp.height * 0.9, 3);
    const t0 = await now();
    const shown = await when(page, PICS_IN, null, 30000);
    return { picsAfter: shown != null ? Math.round(shown - t0) : null };
  }, { settle: 800 });
  {
    const card = (await page.evaluateHandle(() => [...document.querySelectorAll("#app .grid .card")].find((c) => { const r = c.getBoundingClientRect(); return r.top > 90 && r.bottom < innerHeight - 90; }))).asElement();
    if (card) await flow("movies-title", async () => { const t0 = await now(); await press(card); return land(t0); }, { settle: 1500 });
  }
  // Search: a word, a letter at a time
  await flow("search", async () => {
    const item = await page.$('.nav-item[data-route="#/search"]');
    const t0 = await now();
    await press(item);
    const input = await page.waitForSelector('#app input[type="search"]', { timeout: 30000, state: "visible" });
    const open = Math.round((await now()) - t0);
    await press(input);
    await page.evaluate(() => {
      const w = window.__fl;
      w.keys = [];
      const app = document.getElementById("app");
      w.mo && w.mo.disconnect();
      w.mo = new MutationObserver(() => {
        const k = w.keys[w.keys.length - 1];
        if (k && k.painted == null && document.querySelector('#app .card, #app [class*="result"]')) requestAnimationFrame(() => { if (k.painted == null) k.painted = performance.now(); });
      });
      w.mo.observe(app, { childList: true, subtree: true });
      document.addEventListener("keydown", (e) => { if (e.key.length === 1) w.keys.push({ k: e.key, t: performance.now() }); }, true);
    });
    for (const ch of "harbor") { await page.keyboard.type(ch); await sleep(160); }
    await sleep(2500);
    const keys = await page.evaluate(() => { window.__fl.mo.disconnect(); return window.__fl.keys.map((k) => (k.painted != null ? Math.round(k.painted - k.t) : null)); });
    const last = keys[keys.length - 1];
    return { open, keyToResults: keys.join(" "), lastKeyToResults: last };
  }, { settle: 800 });
  // a library film: Play → the play request leaves
  if (!pick.length || pick.includes("player")) {
    await page.evaluate((id) => { location.hash = `#/movie/${id}`; }, inst.lib.film2);
    const play = await page.waitForSelector('[data-ui="detail.play"], .detail-actions > .btn-primary', { timeout: 30000, state: "visible" });
    await sleep(1500);
    await flow("player", async () => {
      const seen = [];
      const onReq = (r) => seen.push({ u: r.url(), t: Date.now() });
      page.on("request", onReq);
      const t0w = Date.now();
      const t0 = await now();
      await press(play);
      const route = await when(page, () => (/^#\/play\//.test(location.hash) ? performance.now() : null), null, 15000);
      const deadline = Date.now() + 15000;
      let hit = null;
      while (Date.now() < deadline && !hit) {
        hit = seen.find((s) => s.t >= t0w && /\/(stream|hls|jit|transcode|direct|play)\/|\.m3u8|\/api\/play\b|\/api\/stream/.test(new URL(s.u).pathname) && !/play-mark|perf-mark/.test(s.u));
        if (!hit) await sleep(10);
      }
      page.off("request", onReq);
      return { route: route != null ? Math.round(route - t0) : null, playRequest: hit ? hit.t - t0w : null, playUrl: hit ? new URL(hit.u).pathname.slice(0, 60) : null, firstReqs: seen.filter((s) => s.t >= t0w).slice(0, 8).map((s) => `${s.t - t0w} ${new URL(s.u).pathname.slice(0, 50)}`) };
    }, { settle: 300 });
    // leave at once: nothing after the request is ours to watch
    await page.evaluate(() => { location.hash = "#/"; });
    await sleep(2500);
    try { await fetch(`${inst.url}/api/profiles/${inst.profiles.glass.id}/progress/${encodeURIComponent(inst.lib.film2)}`, { method: "DELETE" }); } catch {}
  }
  // three more screens, by their address
  for (const [name, hash] of [["calendar", "#/calendar"], ["list", "#/list"], ["downloads", "#/downloads"]]) {
    await flow(name, async () => {
      const t0 = await now();
      await page.evaluate((h) => { location.hash = h; }, hash);
      return land(t0);
    }, { settle: 1200 });
  }
  return out;
};

// ---- a long session
const session = async ({ page, cdp, inst, seconds }) => {
  const tour = ["#/", "#/movies", "#/shows", "#/search", inst.routes.film, inst.routes.show, "#/list", "#/calendar", "#/downloads", "#/preferences"];
  await cdp.send("HeapProfiler.enable");
  const rounds = [];
  const tEnd = Date.now() + seconds * 1000;
  let k = 0;
  while (Date.now() < tEnd || k < 2) {
    for (const h of tour) {
      await page.evaluate((h) => { location.hash = h; }, h);
      await sleep(1600);
      await page.evaluate(() => window.scrollBy(0, innerHeight * 1.5));
      await sleep(500);
    }
    // sit still on Settings: who still asks for frames?
    const still = await page.evaluate(() => new Promise((res) => {
      let n = 0; const t0 = performance.now();
      const raf = window.requestAnimationFrame;
      const tick = () => { n++; if (performance.now() - t0 < 2000) raf(tick); else res(n); };
      raf(tick);
    }));
    await cdp.send("HeapProfiler.collectGarbage");
    await sleep(300);
    await cdp.send("HeapProfiler.collectGarbage");
    const m = await metrics(cdp);
    const dom = await cdp.send("Memory.getDOMCounters");
    const p = await page.evaluate(() => {
      const anims = document.getAnimations();
      const running = anims.filter((a) => a.playState === "running");
      const unseen = running.filter((a) => {
        const t = a.effect && a.effect.target;
        if (!t || !t.isConnected) return true;
        const r = t.getBoundingClientRect();
        return r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || getComputedStyle(t).visibility === "hidden";
      });
      const iv = [...window.__fl.intervals.values()];
      return { anims: running.length, unseenAnims: unseen.length, unseenWhat: [...new Set(unseen.map((a) => (a.animationName || a.constructor.name) + "@" + (a.effect && a.effect.target ? (a.effect.target.id || String(a.effect.target.className).split(" ")[0]) : "?")))].slice(0, 8), intervals: iv.length, intervalWhat: iv.map((x) => `${x.ms}ms ${x.at}`).slice(0, 12) };
    });
    rounds.push({ round: k, t: Math.round((seconds * 1000 - (tEnd - Date.now())) / 1000), heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2), nodes: dom.nodes, listeners: dom.jsEventListeners, documents: dom.documents, stillFrames2s: still, ...p });
    console.log(JSON.stringify(rounds[rounds.length - 1]));
    k++;
  }
  return rounds;
};

const main = async () => {
  const label = argv("label", "feel");
  const cells = list("cells", "desktop:fast,desktop:slow,phone:fast,phone:slow");
  const only = list("only", "start,flows");
  const runs = Number(argv("runs", 5));
  const look = argv("look", "glass");
  const seconds = Number(argv("session", 600));
  const inst = JSON.parse(fs.readFileSync(argv("instance"), "utf8"));
  const result = { label, at: new Date().toISOString(), cells: {} };
  for (const cell of cells) {
    const [dev, line] = cell.split(":");
    const { d, cpu } = DEV[dev];
    const log = [];
    const ln = await startLine(inst, line, log);
    const browser = await launch({ extraArgs: ln.spki ? [`--ignore-certificate-errors-spki-list=${ln.spki}`] : [] });
    const D = DEVICES[d];
    const R = (result.cells[cell] = { start: [], flows: [], session: null });
    const newCtx = async () => {
      const ctx = await browser.newContext({ viewport: { width: D.width, height: D.height }, deviceScaleFactor: D.dpr, isMobile: D.mobile, hasTouch: D.mobile, ...(D.ua ? { userAgent: D.ua } : {}), serviceWorkers: "allow", ignoreHTTPSErrors: true });
      await ctx.addInitScript(WATCH);
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Performance.enable");
      await cdp.send("Network.enable");
      await cdp.send("Network.clearBrowserCache");
      await cdp.send("Storage.clearDataForOrigin", { origin: ln.url, storageTypes: "all" }).catch(() => {});
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
      await prime(page, ln.url, inst, look);
      return { ctx, page, cdp };
    };
    try {
      if (only.includes("start") || only.includes("flows")) {
        for (let i = 0; i <= runs; i++) {
          const { ctx, page, cdp } = await newCtx();
          try {
            const cold = await startOnce(page, cdp, ln.url, log, { reload: false });
            await sleep(1500);
            const warm = await startOnce(page, cdp, ln.url, log, { reload: true });
            let fl = null;
            if (only.includes("flows")) fl = await flows({ page, cdp, inst, touch: D.mobile, vp: { width: D.width, height: D.height } });
            if (i === 0) { console.log(`${cell} warm-up run thrown away (cold rows ${cold.rows}, screen ${cold.screen})`); continue; }
            R.start.push({ cold, warm });
            if (fl) R.flows.push(fl);
            console.log(`${cell} #${i}: cold ttfb ${cold.ttfb} fcp ${cold.fcp} lcp ${cold.lcp} rows ${cold.rows} shelf1 ${cold.shelf1} screen ${cold.screen} wire ${cold.wire.n}/${cold.wire.kb}KB | warm fcp ${warm.fcp} rows ${warm.rows} screen ${warm.screen} wire ${warm.wire.n}/${warm.wire.kb}KB`);
          } catch (e) { console.log(`${cell} #${i} failed: ${e.message}`); }
          await ctx.close();
        }
      }
      if (only.includes("session")) {
        const { ctx, page, cdp } = await newCtx();
        await startOnce(page, cdp, ln.url, log, { reload: false });
        R.session = await session({ page, cdp, inst, seconds });
        await ctx.close();
      }
    } finally {
      await browser.close();
      await ln.stop();
    }
    writeJson(path.join(OUT, label, "feel.json"), result);
  }
  // medians
  const med = (arr, f) => { const v = median(arr.map(f).filter((x) => x != null)); return v == null ? "-" : Math.round(v); };
  for (const [cell, R] of Object.entries(result.cells)) {
    if (!R.start.length) continue;
    console.log(`\n== ${label} ${cell} (${R.start.length} runs, medians)`);
    for (const side of ["cold", "warm"]) {
      const s = R.start.map((x) => x[side]);
      console.log(`${side}: ttfb ${med(s, (x) => x.ttfb)} fcp ${med(s, (x) => x.fcp)} lcp ${med(s, (x) => x.lcp)} rows ${med(s, (x) => x.rows)} hero ${med(s, (x) => x.hero)} shelf1 ${med(s, (x) => x.shelf1)} screen ${med(s, (x) => x.screen)} | toRows ${med(s, (x) => x.wireToRows)}req/${med(s, (x) => x.kbToRows)}KB toScreen ${med(s, (x) => x.wireToScreen)}req/${med(s, (x) => x.kbToScreen)}KB all ${med(s, (x) => x.wire.n)}req/${med(s, (x) => x.wire.kb)}KB | script ${med(s, (x) => x.script)} layout ${med(s, (x) => x.layout)} style ${med(s, (x) => x.style)} long ${med(s, (x) => x.longTasks)} blocked ${med(s, (x) => x.blocked)}`);
    }
    if (R.flows.length) {
      const names = Object.keys(R.flows[0]);
      for (const n of names) {
        const f = R.flows.map((x) => x[n]).filter(Boolean);
        const keys = Object.keys(f[0]).filter((k) => typeof f[0][k] === "number" || f[0][k] === null);
        console.log(`  ${n}: ` + keys.map((k) => `${k} ${med(f, (x) => x[k])}`).join(" "));
      }
    }
  }
};

process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
main().catch((e) => { console.error(e); process.exit(1); });

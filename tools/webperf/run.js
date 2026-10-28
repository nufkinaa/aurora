#!/usr/bin/env node
// Aurora website performance, measured the same way every time, so a change
// can be compared with what came before it (compare.js).
//
//   node tools/webperf/run.js --label baseline
//       [--devices desktop-1440,ipad-1024,ipad-820,phone-390,phone-360]
//       [--looks glass,legacy] [--cpu 4,6] [--nets none,fast3g]
//       [--runs 3] [--instance <state file>] [--only load,gestures]
//
// Against a private instance only (tools/mobile-perf/instance.js — the UI
// tests' throwaway server with 400 made-up titles and made-up pictures): a
// running one from --instance / tools/mobile-perf/.cache/instance.json, else
// one started and stopped here. The machine's own Chrome (playwright-core,
// channel "chrome"), headless, nothing leaving the machine.
//
// One cell = device × look × CPU slowdown × line. Per cell, --runs times, in a
// fresh browser context:
//
//   load-cold   Home opened with no HTTP cache and no service worker (the
//               profile remembered): FCP, LCP, TBT (long tasks' time over
//               50 ms, from FCP to the end of the window), long tasks,
//               "rows" (Home's own mark: the first shelves are on the page)
//   load-warm   the same page opened again right after (caches warm)
//
// Then, on the cells with no line limit (--nets none), the gestures, each
// measured on its own with a requestAnimationFrame frame-time sampler
// (frames > 50 ms, the worst frame), long tasks, INP (the slowest
// input → next paint, Event Timing) and Chrome's main-thread counters:
//
//   scroll-home   three screens down Home and back up (touch on touch devices,
//                 the wheel on desktop)
//   hold          a card held (touch) / right-clicked (desktop) until its peek
//                 sheet is up: holdToSheet = from the end of the 480 ms hold
//   open-title    a catalogue card tapped, until the title page has painted
//   back          Back, until Home's shelves are painted again
//   tab-movies    the Movies tab, until the grid has painted; scroll-movies
//   tab-shows     the Shows tab;  scroll-shows
//   search-type   Search opened, "harbor" typed a letter at a time
//   player        a library film's Play tapped: ttff = press → the picture
//                 moving (first timeupdate past the start), in the page's clock
//   seek          → (10 s forward) in the player: seekToFrame = key → first
//                 timeupdate after "seeked"
//   heap          ten more navigations, a forced collection: JS heap, DOM
//                 nodes, listeners
//
// Writes out/<label>/results.json (every run's raw numbers and the median /
// min / max per metric). Data mode is pinned to "Full quality" so the
// connection meter's verdict (which picks 1× or 2× pictures) does not differ
// between two runs for reasons of its own.
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const { OUT, argv, list, DEVICES, launch, newContext, throttle, prime, clearCaches, sleep, spread, writeJson } = require("./lib");
const { getInstance } = require("../mobile-perf/instance");

const WATCH = () => {
  const w = (window.__wp = { frames: [], long: [], events: [], lcp: null, on: false, media: {} });
  let last = 0;
  let looping = false;
  const loop = (t) => {
    if (!w.on) { looping = false; return; }
    if (last) w.frames.push(t - last);
    last = t;
    requestAnimationFrame(loop);
  };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.long.push({ t: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        const el = e.element;
        (w.lcps || (w.lcps = [])).push({ t: e.startTime, size: e.size, el: el ? `${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className).split(/\s+/).slice(0, 2).join(".")}` : null });
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) w.events.push({ t: e.startTime, name: e.name, d: e.duration }); }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch {}
  w.start = () => {
    w.frames = [];
    w.mark = performance.now();
    last = 0;
    w.on = true;
    if (!looping) { looping = true; requestAnimationFrame(loop); }
  };
  w.stop = () => {
    w.on = false;
    const since = w.mark;
    return { frames: w.frames, long: w.long.filter((l) => l.t >= since), events: w.events.filter((e) => e.t >= since) };
  };
  // the moments a video starts and seeks (capture: media events don't bubble)
  const m = w.media;
  m.reset = () => { for (const k of Object.keys(m)) if (typeof m[k] !== "function") delete m[k]; };
  document.addEventListener("pointerup", () => { m.press = performance.now(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") m.key = performance.now(); }, true);
  document.addEventListener("playing", () => { if (m.playing == null) m.playing = performance.now(); }, true);
  document.addEventListener("seeked", () => { if (m.key != null && m.seeked == null) m.seeked = performance.now(); }, true);
  document.addEventListener("timeupdate", (e) => {
    const v = e.target;
    if (m.firstMove == null && v.currentTime > (m.startAt == null ? (m.startAt = v.currentTime) : m.startAt) + 0.05) m.firstMove = performance.now();
    if (m.seeked != null && m.afterSeek == null) m.afterSeek = performance.now();
  }, true);
};

const metrics = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

const loadOnce = async (page, cdp, origin, hash, { reload = false } = {}) => {
  const t0 = Date.now();
  if (reload) await page.reload({ waitUntil: "commit", timeout: 120000 });
  else await page.goto(`${origin}/${hash}`, { waitUntil: "commit", timeout: 120000 });
  // Home's own mark (the first shelves are on the page), or the first card
  const rows = await page.waitForFunction(() => {
    const m = performance.getEntriesByName("aurora-home-rows")[0];
    return m ? m.startTime : null;
  }, null, { timeout: 120000, polling: 100 }).then((h) => h.jsonValue()).catch(() => null);
  // the window: at least 10 s from the start, and 4 s past the rows
  const since = Date.now() - t0;
  await sleep(Math.max(10000 - since, 4000));
  return page.evaluate((rows) => {
    const w = window.__wp;
    const fcpE = performance.getEntriesByName("first-contentful-paint")[0];
    const fcp = fcpE ? fcpE.startTime : null;
    const end = performance.now();
    const after = w.long.filter((l) => fcp != null && l.t >= fcp);
    const nav = performance.getEntriesByType("navigation")[0];
    // LCP as it stands before the billboard first turns (9 s after Home has
    // painted, home.js HERO_DWELL_MS): the next slide's picture is a new,
    // later "largest paint" that says nothing about the load
    const cut = rows != null ? rows + 8500 : Infinity;
    const lcps = (w.lcps || []).filter((e) => e.t < cut);
    w.lcp = lcps.length ? lcps[lcps.length - 1] : null;
    return {
      fcp: fcp != null ? Math.round(fcp) : null,
      lcp: w.lcp ? Math.round(w.lcp.t) : null,
      lcpEl: w.lcp ? w.lcp.el : null,
      rows: rows != null ? Math.round(rows) : null,
      tbt: Math.round(after.reduce((a, l) => a + Math.max(0, l.d - 50), 0)),
      longTasks: w.long.length,
      worstTask: Math.round(Math.max(0, ...w.long.map((l) => l.d))),
      window: Math.round(end),
      domNodes: document.getElementsByTagName("*").length,
      transferKB: Math.round(performance.getEntriesByType("resource").reduce((a, r) => a + (r.transferSize || 0), 0) / 1024 + (nav ? nav.transferSize / 1024 : 0)),
      requests: performance.getEntriesByType("resource").length,
    };
  }, rows);
};

const forget = async (inst, look) => {
  const p = inst.profiles[look];
  try { await fetch(`${inst.url}/api/profiles/${p.id}/progress/${encodeURIComponent(inst.lib.film2)}`, { method: "DELETE" }); } catch {}
};

const gestures = async ({ page, cdp, ctxDevice, origin, inst, look }) => {
  const d = DEVICES[ctxDevice];
  const touch = d.mobile;
  const vp = { width: d.width, height: d.height };
  const out = {};
  const gesture = async (name, fn, { settle = 700 } = {}) => {
    const before = await metrics(cdp);
    await page.evaluate(() => window.__wp.start());
    const extra = (await fn()) || {};
    await sleep(settle);
    const w = await page.evaluate(() => window.__wp.stop());
    const after = await metrics(cdp);
    const dd = (k) => Math.round((after[k] - before[k]) * 1000);
    const late = w.frames.filter((f) => f > 50).length;
    out[name] = {
      frames: w.frames.length,
      lateFrames: late,
      lateShare: w.frames.length ? +(late / w.frames.length).toFixed(3) : 0,
      worstFrame: Math.round(Math.max(0, ...w.frames)),
      inp: Math.round(Math.max(0, ...w.events.map((e) => e.d))),
      longTasks: w.long.length,
      blocked: Math.round(w.long.reduce((a, l) => a + Math.max(0, l.d - 50), 0)),
      worstTask: Math.round(Math.max(0, ...w.long.map((l) => l.d))),
      task: dd("TaskDuration"), script: dd("ScriptDuration"), layout: dd("LayoutDuration"), style: dd("RecalcStyleDuration"),
      layouts: after.LayoutCount - before.LayoutCount, recalcs: after.RecalcStyleCount - before.RecalcStyleCount,
      ...extra,
    };
  };
  const scroll = (x, y, { dy = 0, dx = 0, speed = 1400, repeat = 1 }) =>
    cdp.send("Input.synthesizeScrollGesture", { x: Math.round(x), y: Math.round(y), yDistance: Math.round(dy), xDistance: Math.round(dx), speed, gestureSourceType: touch ? "touch" : "mouse", repeatCount: repeat, repeatDelayMs: 250 });
  const press = async (handle) => { if (touch) await handle.tap(); else await handle.click(); };
  const painted = (sel, timeout = 60000) => page.waitForSelector(sel, { timeout, state: "visible" });
  const tStart = () => page.evaluate(() => performance.now());

  // ---- Home: scroll
  await gesture("scroll-home", async () => {
    await scroll(vp.width / 2, vp.height * 0.7, { dy: -vp.height * 0.9, repeat: 3 });
    await sleep(400);
    await scroll(vp.width / 2, vp.height * 0.3, { dy: vp.height * 0.9, repeat: 3, speed: 2400 });
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);

  // a catalogue card fully on screen in a shelf (not Continue Watching)
  const pickCard = () => page.evaluateHandle(() => {
    const rows = [...document.querySelectorAll('[data-kind="shelf"] .row-scroller')];
    for (const row of rows) {
      row.scrollIntoView({ block: "center" });
      const c = [...row.querySelectorAll(".card")].find((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top > 80 && r.bottom < innerHeight - 90 && c._item && c._item.source === "stream"; });
      if (c) return c;
    }
    return null;
  });

  // ---- hold: the peek sheet
  {
    const card = (await pickCard()).asElement();
    await sleep(500);
    if (card) {
      const box = await card.boundingBox();
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await gesture("hold", async () => {
        const t0 = await tStart();
        if (touch) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
          await page.waitForSelector(".peek", { timeout: 10000 });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          await page.mouse.click(cx, cy, { button: "right" });
          await page.waitForSelector(".peek", { timeout: 10000 });
        }
        const t1 = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(performance.now()))));
        return { holdToSheet: Math.round(t1 - t0 - (touch ? 480 : 0)) };
      }, { settle: 900 });
      await page.keyboard.press("Escape");
      await sleep(800);
    }
  }

  // ---- open a title, then Back
  {
    const card = (await pickCard()).asElement();
    await sleep(400);
    await gesture("open-title", async () => {
      const t0 = Date.now();
      await press(card);
      await painted(".detail-title");
      return { toPaint: Date.now() - t0 };
    }, { settle: 1500 });
    await gesture("back", async () => {
      const t0 = Date.now();
      await page.goBack({ waitUntil: "commit" }).catch(() => {});
      await painted(".row .card");
      return { toPaint: Date.now() - t0 };
    }, { settle: 1200 });
  }

  // ---- the grids
  for (const [tab, name] of [["#/movies", "movies"], ["#/shows", "shows"]]) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await gesture(`tab-${name}`, async () => {
      const t0 = Date.now();
      const item = await page.$(`.nav-item[data-route="${tab}"]`);
      await press(item);
      await painted(".grid .card");
      return { toPaint: Date.now() - t0 };
    }, { settle: 1500 });
    await gesture(`scroll-${name}`, async () => {
      await scroll(vp.width / 2, vp.height * 0.7, { dy: -vp.height * 0.9, repeat: 4 });
    });
  }

  // ---- Search: type a word
  await gesture("search-type", async () => {
    const item = await page.$('.nav-item[data-route="#/search"]');
    await press(item);
    const input = await page.waitForSelector('#app input[type="search"]', { timeout: 30000, state: "visible" });
    await press(input);
    for (const ch of "harbor") { await page.keyboard.type(ch); await sleep(140); }
    await sleep(900);
  }, { settle: 1200 });

  // ---- the player: start, then seek
  await page.evaluate((id) => { location.hash = `#/movie/${id}`; }, inst.lib.film2);
  const play = await page.waitForSelector('[data-ui="detail.play"], .detail-actions > .btn-primary', { timeout: 30000, state: "visible" });
  await sleep(1200);
  await page.evaluate(() => window.__wp.media.reset());
  await gesture("player", async () => {
    await press(play);
    await page.waitForFunction(() => window.__wp.media.firstMove != null, null, { timeout: 60000, polling: 50 }).catch(() => {});
    const m = await page.evaluate(() => ({ ...window.__wp.media }));
    return { ttff: m.firstMove != null && m.press != null ? Math.round(m.firstMove - m.press) : null, toPlaying: m.playing != null && m.press != null ? Math.round(m.playing - m.press) : null };
  }, { settle: 2000 });
  await gesture("seek", async () => {
    await page.evaluate(() => { const m = window.__wp.media; delete m.key; delete m.seeked; delete m.afterSeek; });
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => window.__wp.media.afterSeek != null, null, { timeout: 30000, polling: 50 }).catch(() => {});
    const m = await page.evaluate(() => ({ ...window.__wp.media }));
    return { seekToFrame: m.afterSeek != null && m.key != null ? Math.round(m.afterSeek - m.key) : null, seeked: m.seeked != null && m.key != null ? Math.round(m.seeked - m.key) : null };
  }, { settle: 1500 });
  await page.goBack().catch(() => {});
  await sleep(1500);
  // the film is as it was (no resume point, no Continue Watching card): the
  // next run and the next cell meet the same Home and the same Play
  await forget(inst, look);

  // ---- memory after ten navigations (and ten more: what keeps growing)
  {
    const tour = ["#/", "#/movies", "#/shows", "#/search", "#/list", inst.routes.film, inst.routes.show, "#/preferences", "#/downloads", "#/"];
    const weigh = async () => {
      await cdp.send("HeapProfiler.enable");
      await cdp.send("HeapProfiler.collectGarbage");
      await sleep(300);
      await cdp.send("HeapProfiler.collectGarbage");
      const m = await metrics(cdp);
      return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2), nodes: m.Nodes, listeners: m.JSEventListeners };
    };
    const rounds = [];
    for (let k = 0; k < 2; k++) {
      for (const h of tour) { await page.evaluate((h) => { location.hash = h; }, h); await sleep(1200); }
      rounds.push(await weigh());
    }
    out.heap = { ...rounds[0], growHeapMB: +(rounds[1].heapMB - rounds[0].heapMB).toFixed(2), growNodes: rounds[1].nodes - rounds[0].nodes, growListeners: rounds[1].listeners - rounds[0].listeners };
  }
  return out;
};

const main = async () => {
  const label = argv("label", "run");
  const devices = list("devices", Object.keys(DEVICES).join(","));
  const looks = list("looks", "glass,legacy");
  const cpus = list("cpu", "4,6").map(Number);
  const nets = list("nets", "none,fast3g");
  const runs = Number(argv("runs", 3));
  const only = list("only", "load,gestures");
  const inst = await getInstance();
  const origin = inst.url;
  const browser = await launch();
  // what was measured: --commit (an instance of another checkout), else this one
  let commit = argv("commit", null);
  if (!commit) {
    try {
      const repo = path.join(__dirname, "..", "..");
      commit = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
      if (execFileSync("git", ["status", "--porcelain", "--", "public", "src", "server.js"], { cwd: repo, encoding: "utf-8" }).trim()) commit += "+changes";
    } catch {}
  }
  const result = { meta: { label, commit, instanceRoot: inst.root || null, at: new Date().toISOString(), devices, looks, cpus, nets, runs }, cells: [] };
  const file = path.join(OUT, label, "results.json");
  try {
    for (const device of devices) for (const look of looks) for (const cpu of cpus) for (const net of nets) {
      const raw = [];
      for (let n = 0; n < runs; n++) {
        const ctx = await newContext(browser, device);
        await ctx.addInitScript(WATCH);
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Performance.enable");
        const r = {};
        try {
          await prime(page, inst, { look, extra: { "aurora-data-mode": "full" } });
          await clearCaches(cdp, origin);
          if (only.includes("load")) {
            await throttle(cdp, { line: net, cpu });
            r["load-cold"] = await loadOnce(page, cdp, origin, "#/");
            r["load-warm"] = await loadOnce(page, cdp, origin, "#/", { reload: true });
          }
          if (net === "none" && only.includes("gestures")) {
            if (!only.includes("load")) {
              await page.goto(`${origin}/#/`, { waitUntil: "load" });
              await page.waitForSelector(".row .card", { timeout: 60000 });
            }
            await throttle(cdp, { line: "none", cpu: 1 });
            await sleep(2500);
            await throttle(cdp, { line: "none", cpu });
            Object.assign(r, await gestures({ page, cdp, ctxDevice: device, origin, inst, look }));
          }
        } catch (e) {
          r.error = String(e && e.message || e).split("\n")[0];
        }
        raw.push(r);
        await ctx.close();
        await forget(inst, look);
        const brief = Object.entries(r).filter(([k]) => k !== "error").map(([k, v]) => `${k} ${v.lcp != null ? `lcp ${v.lcp} tbt ${v.tbt}` : v.ttff != null ? `ttff ${v.ttff}` : v.heapMB != null ? `${v.heapMB}MB` : `late ${v.lateFrames} inp ${v.inp}`}`).join(" | ");
        process.stdout.write(`${device} ${look} x${cpu} ${net} #${n + 1}: ${r.error ? "ERROR " + r.error + " | " : ""}${brief}\n`);
      }
      // medians per scenario per number
      const med = {};
      const names = [...new Set(raw.flatMap((r) => Object.keys(r)))].filter((k) => k !== "error");
      for (const s of names) {
        med[s] = {};
        const keys = [...new Set(raw.flatMap((r) => (r[s] ? Object.keys(r[s]) : [])))];
        for (const k of keys) {
          const vals = raw.map((r) => (r[s] ? r[s][k] : null));
          med[s][k] = typeof vals.find((v) => v != null) === "number" ? spread(vals) : vals.find((v) => v != null);
        }
      }
      result.cells.push({ device, look, cpu, net, metrics: med, raw, errors: raw.map((r) => r.error).filter(Boolean) });
      writeJson(file, result);
    }
  } finally {
    await browser.close();
    await inst.stop();
  }
  console.log(`\n${result.cells.length} cells -> ${file}`);
};

main().catch((e) => { console.error(e.stack || e); process.exit(1); });

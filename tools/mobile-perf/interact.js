#!/usr/bin/env node
// A slow phone in the hand: what each gesture costs.
//
//   node tools/mobile-perf/interact.js --label baseline [--looks glass,legacy]
//       [--device phone-390] [--cpu 4,6] [--runs 3]
//
// No network limit, caches warm; Chrome slowed --cpu times. One visit, the
// gestures a person makes, each measured on its own:
//
//   scroll-home     a finger scroll down Home, 3 screens, then back up
//   swipe-row       a shelf swiped sideways (twice)
//   open-title      a card tapped, until the title page has painted
//   back            Back, until Home has painted again
//   tab-movies      the Movies tab tapped, until the grid has painted
//   scroll-grid     a finger scroll down the grid
//   search-type     Search opened and six letters typed
//   open-player     Play tapped on a library film, until the player is up
//
// Per gesture:
//   frames          how the main thread kept up: requestAnimationFrame gaps —
//                   the share of frames later than 50 ms, the longest gap
//   inp             the slowest input → next paint (Event Timing), ms
//   long            long tasks: how many, how much time over 50 ms each (blocked)
//   main thread     script / style / layout / total task time (Chrome's own counters)
//   layouts, style recalcs counted
//
// Then the session's weight: DOM nodes, listeners, JS heap after each screen,
// and again after three more rounds of the same tour with a forced garbage
// collection — what keeps growing is a leak.
// Writes out/<label>/interact/<look>.x<cpu>.json
"use strict";
const path = require("path");
const { argv, list, open, emulate, prime, sleep, spread, outDir, writeJson } = require("./lib");

const WATCH = () => {
  const w = (window.__ix = { frames: [], long: [], events: [], on: false });
  let last = 0;
  const loop = (t) => { if (w.on && last) w.frames.push(t - last); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (w.on) w.long.push({ t: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: false });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (w.on && e.interactionId) w.events.push({ name: e.name, d: e.duration, delay: e.processingStart - e.startTime, proc: e.processingEnd - e.processingStart }); }).observe({ type: "event", durationThreshold: 16, buffered: false });
  } catch {}
  w.start = () => { w.frames = []; w.long = []; w.events = []; last = 0; w.on = true; };
  w.stop = () => { w.on = false; return { frames: w.frames, long: w.long, events: w.events }; };
};

const metrics = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

const main = async () => {
  const label = argv("label", "run");
  const looks = list("looks", "glass");
  const device = argv("device", "phone-390");
  const cpus = list("cpu", "4").map(Number);
  const runs = Number(argv("runs", 3));
  const dir = outDir(label, "interact");
  const ctx = await open();
  const summary = [];
  try {
    for (const look of looks) for (const cpu of cpus) {
      const all = [];
      let session = null;
      for (let n = 0; n < runs; n++) {
        const page = await ctx.browser.newPage();
        const cdp = await page.createCDPSession();
        await emulate(page, device);
        await cdp.send("Performance.enable");
        await page.evaluateOnNewDocument(WATCH);
        await prime(page, ctx.inst, { look });
        await page.goto(`${ctx.origin}/#/`, { waitUntil: "networkidle2", timeout: 90000 });
        await page.waitForSelector(".row .card", { timeout: 60000 });
        await sleep(2500);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
        const vp = page.viewport();
        const out = {};
        // one gesture: counters before and after, the page's own watch in between
        const gesture = async (name, fn, { settle = 700 } = {}) => {
          const before = await metrics(cdp);
          await page.evaluate(() => window.__ix.start());
          const t0 = Date.now();
          const extra = (await fn()) || {};
          const took = Date.now() - t0;
          await sleep(settle);
          const w = await page.evaluate(() => window.__ix.stop());
          const after = await metrics(cdp);
          const d = (k) => Math.round((after[k] - before[k]) * 1000);
          const late = w.frames.filter((f) => f > 50).length;
          out[name] = {
            took,
            frames: w.frames.length, lateFrames: late, lateShare: w.frames.length ? +(late / w.frames.length).toFixed(3) : 0,
            worstFrame: Math.round(Math.max(0, ...w.frames)),
            inp: Math.round(Math.max(0, ...w.events.map((e) => e.d))),
            inputDelay: Math.round(Math.max(0, ...w.events.map((e) => e.delay))),
            long: w.long.length, blocked: Math.round(w.long.reduce((a, l) => a + Math.max(0, l.d - 50), 0)), worstTask: Math.round(Math.max(0, ...w.long.map((l) => l.d))),
            task: d("TaskDuration"), script: d("ScriptDuration"), layout: d("LayoutDuration"), style: d("RecalcStyleDuration"),
            layouts: after.LayoutCount - before.LayoutCount, recalcs: after.RecalcStyleCount - before.RecalcStyleCount,
            ...extra,
          };
        };
        const fingerScroll = (x, y, { dy = 0, dx = 0, speed = 1400, repeat = 1 }) => cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: dy, xDistance: dx, speed, gestureSourceType: "touch", repeatCount: repeat, repeatDelayMs: 250 });
        const painted = (sel, timeout = 60000) => page.waitForSelector(sel, { timeout, visible: true });
        const weigh = async (name) => {
          const m = await metrics(cdp);
          return { screen: name, nodes: m.Nodes, listeners: m.JSEventListeners, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), dom: await page.evaluate(() => document.getElementsByTagName("*").length), imgs: await page.evaluate(() => document.images.length) };
        };
        const weights = [await weigh("home")];

        await gesture("scroll-home", async () => {
          await fingerScroll(vp.width / 2, vp.height * 0.7, { dy: -vp.height * 0.9, repeat: 3 });
          await sleep(400);
          await fingerScroll(vp.width / 2, vp.height * 0.3, { dy: vp.height * 0.9, repeat: 3, speed: 2400 });
        });
        weights.push(await weigh("home scrolled"));
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(500);
        const rowY = await page.evaluate(() => {
          const row = document.querySelectorAll(".row-scroller")[1];
          row.scrollIntoView({ block: "center" });
          const r = row.getBoundingClientRect();
          return Math.max(80, Math.min(innerHeight - 120, r.top + r.height / 2));
        });
        await sleep(400);
        await gesture("swipe-row", async () => {
          await fingerScroll(vp.width * 0.8, rowY, { dx: -vp.width * 0.9, repeat: 2, speed: 1600 });
        });
        // a catalogue title's card, in the second shelf
        const card = await page.evaluateHandle(() => [...document.querySelectorAll(".row .card.poster")].find((c) => { const r = c.getBoundingClientRect(); return r.left > 0 && r.right < innerWidth && r.top > 80 && r.bottom < innerHeight - 90; }));
        await gesture("open-title", async () => {
          const t0 = Date.now();
          await card.asElement().tap();
          await painted(".detail-title, .detail-head h1, .detail-info h1");
          return { toPaint: Date.now() - t0 };
        }, { settle: 1500 });
        weights.push(await weigh("title"));
        await gesture("back", async () => {
          const t0 = Date.now();
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          await painted(".row .card");
          return { toPaint: Date.now() - t0 };
        }, { settle: 1200 });
        await gesture("tab-movies", async () => {
          const t0 = Date.now();
          const tab = await page.$('.nav-item[data-route="#/movies"]');
          await tab.tap();
          await painted(".grid .card");
          return { toPaint: Date.now() - t0 };
        }, { settle: 1500 });
        weights.push(await weigh("movies"));
        await gesture("scroll-grid", async () => {
          await fingerScroll(vp.width / 2, vp.height * 0.7, { dy: -vp.height * 0.9, repeat: 4 });
        });
        weights.push(await weigh("movies scrolled"));
        await gesture("search-type", async () => {
          const tab = await page.$('.nav-item[data-route="#/search"]');
          await tab.tap();
          const input = await page.waitForSelector("#app input", { timeout: 30000, visible: true });
          await input.tap();
          for (const ch of "harbor") { await page.keyboard.type(ch); await sleep(140); }
          await sleep(900);
        }, { settle: 1200 });
        weights.push(await weigh("search"));
        await gesture("open-player", async () => {
          const t0 = Date.now();
          await page.evaluate((id) => { location.hash = `#/movie/${id}`; }, ctx.inst.lib.film1);
          const play = await page.waitForSelector(".detail-actions > .btn-primary", { timeout: 30000, visible: true });
          const t1 = Date.now();
          await play.tap();
          await painted(".player", 30000);
          return { toTitle: t1 - t0, toPlayer: Date.now() - t1 };
        }, { settle: 2500 });
        weights.push(await weigh("player"));
        await page.goBack().catch(() => {});
        await sleep(800);
        all.push(out);

        // the tour, three more times, then what is left after a collection
        if (n === 0) {
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
          const tour = ["#/", "#/movies", "#/shows", "#/search", "#/list", ctx.inst.routes.film, ctx.inst.routes.show, "#/preferences", "#/downloads", "#/"];
          const rounds = [];
          const gc = async () => { await cdp.send("HeapProfiler.enable"); await cdp.send("HeapProfiler.collectGarbage"); await sleep(300); await cdp.send("HeapProfiler.collectGarbage"); };
          for (let round = 0; round < 4; round++) {
            for (const hash of tour) {
              await page.evaluate((h) => { location.hash = h; }, hash);
              await sleep(1100);
            }
            await gc();
            const m = await metrics(cdp);
            rounds.push({ round, nodes: m.Nodes, listeners: m.JSEventListeners, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), documents: m.Documents });
          }
          session = { weights, rounds, growthPerRound: { nodes: Math.round((rounds[3].nodes - rounds[1].nodes) / 2), listeners: Math.round((rounds[3].listeners - rounds[1].listeners) / 2), heapMB: +((rounds[3].heapMB - rounds[1].heapMB) / 2).toFixed(2) } };
        }
        await page.close();
        process.stdout.write(`  ${look} x${cpu} #${n + 1}: ` + Object.entries(out).map(([k, v]) => `${k} late ${Math.round(v.lateShare * 100)}% inp ${v.inp} blocked ${v.blocked}`).join(" | ") + "\n");
      }
      const names = Object.keys(all[0]);
      const med = {};
      for (const g of names) {
        med[g] = {};
        for (const k of Object.keys(all[0][g])) med[g][k] = spread(all.map((r) => r[g][k]));
      }
      writeJson(path.join(dir, `${look}.x${cpu}.json`), { look, cpu, device, runs, gestures: med, session });
      for (const g of names) summary.push({ cell: `${look} x${cpu} ${g}`, late: `${Math.round(med[g].lateShare.median * 100)}%`, worstFrame: med[g].worstFrame.median, inp: med[g].inp.median, long: med[g].long.median, blocked: med[g].blocked.median, task: med[g].task.median, script: med[g].script.median, layout: med[g].layout.median, style: med[g].style.median, toPaint: med[g].toPaint ? med[g].toPaint.median : "" });
      if (session) console.log("  session:", JSON.stringify(session.growthPerRound), JSON.stringify(session.rounds));
    }
  } finally {
    await ctx.close();
  }
  console.table(summary);
};

main().catch((e) => { console.error(e.stack || e); process.exit(1); });

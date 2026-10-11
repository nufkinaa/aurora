#!/usr/bin/env node
// Where the main thread's time goes while a route loads on a slow phone.
//
//   node tools/mobile-perf/cpu.js --label baseline [--routes home] [--looks glass]
//       [--device phone-390] [--cpu 4] [--runs 3] [--settle 6000]
//
// No network limit (the line is not what is being measured), HTTP cache and
// service worker warm — the everyday visit. Chrome is slowed --cpu times and
// a trace of the load is taken, from the navigation until --settle ms later.
// From the trace:
//
//   main-thread time by kind (script, style, layout, paint, parse, GC…)
//   long tasks (>50 ms): when, how long, and what ran in them
//   JS self time by file and by function (the sampling profiler in the trace)
//   Total Blocking Time over the window, and time to `usable` (see net.js)
//   DOM size, layers, style recalcs and layouts counted
//
// Writes out/<label>/cpu/<route>.<look>.json; --keep-trace also keeps the raw
// trace (open it in chrome://tracing or the Performance panel).
"use strict";
const fs = require("fs");
const path = require("path");
const { argv, flag, list, open, emulate, prime, sleep, spread, outDir, writeJson } = require("./lib");
const { PROBE } = require("./net");

const CATEGORIES = [
  "devtools.timeline", "disabled-by-default-devtools.timeline", "v8.execute", "blink.user_timing", "loading",
  "disabled-by-default-v8.cpu_profiler", "disabled-by-default-devtools.timeline.frame", "latencyInfo",
];

const KIND = {
  EvaluateScript: "script", FunctionCall: "script", "v8.compile": "compile", "v8.compileModule": "compile", "v8.evaluateModule": "script",
  EventDispatch: "script", TimerFire: "script", FireAnimationFrame: "script", FireIdleCallback: "script", RunMicrotasks: "script",
  "V8.GC_Scavenger": "gc", MajorGC: "gc", MinorGC: "gc", "BlinkGC.AtomicPhase": "gc",
  UpdateLayoutTree: "style", ScheduleStyleRecalculation: "style", ParseAuthorStyleSheet: "parseCss",
  Layout: "layout", PrePaint: "prepaint", Paint: "paint", PaintImage: "paint", Layerize: "composite", UpdateLayer: "composite", UpdateLayerTree: "composite", CompositeLayers: "composite", Commit: "composite",
  ParseHTML: "parseHtml", "Decode Image": "imageDecode", "Decode LazyPixelRef": "imageDecode", ImageDecodeTask: "imageDecode", "Draw LazyPixelRef": "imageDecode",
  XHRReadyStateChange: "script", HitTest: "other", IntersectionObserverController: "script",
};

// Self time per event name on one thread: complete events ("X"), nested.
const analyse = (events, origin) => {
  // the renderer main thread of the page: the one that ran the most script
  const perThread = new Map();
  for (const e of events) {
    if (e.ph !== "X" || !e.dur) continue;
    const k = `${e.pid}:${e.tid}`;
    const t = perThread.get(k) || { script: 0, n: 0 };
    if (e.name === "RunTask") t.n++;
    if (e.name === "EvaluateScript" || e.name === "FunctionCall" || e.name === "v8.evaluateModule") t.script += e.dur;
    perThread.set(k, t);
  }
  const mainKey = [...perThread.entries()].sort((a, b) => b[1].script - a[1].script)[0][0];
  const [pid, tid] = mainKey.split(":").map(Number);
  const navStart = Math.min(...events.filter((e) => e.name === "navigationStart" && e.pid === pid && e.args && e.args.data && String(e.args.data.documentLoaderURL || "").startsWith(origin)).map((e) => e.ts).concat([Infinity]));
  const main = events.filter((e) => e.pid === pid && e.tid === tid && e.ph === "X" && e.ts >= navStart).sort((a, b) => a.ts - b.ts || b.dur - a.dur);

  // self time by kind, via an explicit stack
  const kinds = {};
  const counts = { styleRecalcs: 0, layouts: 0, paints: 0, forcedLayouts: 0 };
  const stack = [];
  const close = (until) => {
    while (stack.length && stack[stack.length - 1].end <= until) {
      const top = stack.pop();
      const kind = KIND[top.e.name] || (top.e.name === "RunTask" ? "task-other" : null);
      if (kind) kinds[kind] = (kinds[kind] || 0) + top.self;
    }
  };
  for (const e of main) {
    close(e.ts);
    const end = e.ts + (e.dur || 0);
    if (stack.length) stack[stack.length - 1].self -= Math.min(e.dur || 0, stack[stack.length - 1].end - e.ts);
    stack.push({ e, end, self: e.dur || 0 });
    if (e.name === "UpdateLayoutTree") counts.styleRecalcs++;
    if (e.name === "Layout") { counts.layouts++; if (stack.some((s) => KIND[s.e.name] === "script")) counts.forcedLayouts++; }
    if (e.name === "Paint") counts.paints++;
  }
  close(Infinity);

  // long tasks, with what was in them
  const tasks = main.filter((e) => e.name === "RunTask" && e.dur > 50000);
  const long = tasks.map((t) => {
    const inside = main.filter((e) => e !== t && e.ts >= t.ts && e.ts + (e.dur || 0) <= t.ts + t.dur && e.dur > 4000);
    const what = inside
      .filter((e) => ["EvaluateScript", "FunctionCall", "v8.evaluateModule", "Layout", "UpdateLayoutTree", "Paint", "ParseAuthorStyleSheet", "TimerFire", "FireIdleCallback", "FireAnimationFrame", "EventDispatch", "ParseHTML", "v8.compile", "v8.compileModule", "PrePaint", "Layerize", "MajorGC"].includes(e.name))
      .sort((a, b) => b.dur - a.dur).slice(0, 5)
      .map((e) => {
        const d = (e.args && (e.args.data || e.args.beginData)) || {};
        const where = String(d.url || d.fileName || d.scriptName || "").replace(origin, "") + (d.functionName ? ` ${d.functionName}` : "") + (d.lineNumber != null && d.url ? `:${d.lineNumber}` : "") + (d.type ? ` ${d.type}` : "");
        return `${e.name} ${Math.round(e.dur / 1000)}ms${where.trim() ? " " + where.trim() : ""}`;
      });
    return { at: Math.round((t.ts - navStart) / 1000), ms: Math.round(t.dur / 1000), what };
  });
  const tbt = tasks.reduce((a, t) => a + (t.dur / 1000 - 50), 0);

  // the sampling profiler's chunks -> self time by function and by file
  const nodes = new Map();
  const self = new Map();
  for (const e of events) {
    if (e.name !== "ProfileChunk" || e.pid !== pid) continue;
    const cp = e.args.data.cpuProfile || {};
    for (const n of cp.nodes || []) nodes.set(`${e.id}:${n.id}`, n);
    const samples = cp.samples || [];
    const deltas = e.args.data.timeDeltas || [];
    for (let i = 0; i < samples.length; i++) self.set(`${e.id}:${samples[i]}`, (self.get(`${e.id}:${samples[i]}`) || 0) + (deltas[i] || 0));
  }
  const byFn = new Map();
  const byFile = new Map();
  for (const [key, us] of self) {
    const n = nodes.get(key);
    if (!n) continue;
    const cf = n.callFrame;
    const file = String(cf.url || "").replace(origin, "") || `(${cf.functionName || "native"})`;
    if (/^\((idle|program|root)\)$/.test(file)) continue;
    const fn = `${file} ${cf.functionName || "(anonymous)"}:${cf.lineNumber + 1}`;
    byFn.set(fn, (byFn.get(fn) || 0) + us);
    byFile.set(file, (byFile.get(file) || 0) + us);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => ({ what: k, ms: Math.round(us / 1000) }));

  const ms = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, Math.round(v / 1000)]));
  return { kinds: ms, total: Object.values(ms).reduce((a, b) => a + b, 0), counts, tbt: Math.round(tbt), longTasks: long.sort((a, b) => b.ms - a.ms).slice(0, 12), longTaskCount: long.length, jsByFile: top(byFile, 16), jsByFunction: top(byFn, 30) };
};

const main = async () => {
  const label = argv("label", "run");
  const routes = list("routes", "home");
  const looks = list("looks", "glass");
  const device = argv("device", "phone-390");
  const cpu = Number(argv("cpu", 4));
  const runs = Number(argv("runs", 3));
  const settle = Number(argv("settle", 6000));
  const dir = outDir(label, "cpu");
  const ctx = await open();
  const summary = [];
  try {
    for (const route of routes) for (const look of looks) {
      const url = `${ctx.origin}/${route === "picker" ? "" : ctx.inst.routes[route]}`;
      // the first visit (unmeasured): fills the caches, installs the worker
      {
        const page = await ctx.browser.newPage();
        await emulate(page, device);
        await prime(page, ctx.inst, { look, profile: route !== "picker" });
        await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 }).catch(() => {});
        await sleep(3000);
        await page.close();
      }
      const results = [];
      for (let n = 0; n < runs; n++) {
        const page = await ctx.browser.newPage();
        const cdp = await page.createCDPSession();
        await emulate(page, device);
        await page.evaluateOnNewDocument(PROBE);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
        const tracePath = path.join(dir, `${route}.${look}.${n}.trace.json`);
        await page.tracing.start({ path: tracePath, categories: CATEGORIES });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
        await sleep(settle);
        const mp = await page.evaluate(() => window.__mp);
        const dom = await page.evaluate(() => ({ nodes: document.getElementsByTagName("*").length, imgs: document.images.length, heap: performance.memory ? performance.memory.usedJSHeapSize : null }));
        await page.tracing.stop();
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        const layers = await (async () => {
          try {
            await cdp.send("LayerTree.enable");
            const got = await new Promise((resolve) => { cdp.once("LayerTree.layerTreeDidChange", (e) => resolve(e.layers || [])); setTimeout(() => resolve(null), 1500); });
            return got ? got.length : null;
          } catch { return null; }
        })();
        const events = JSON.parse(fs.readFileSync(tracePath, "utf-8")).traceEvents;
        const a = analyse(events, ctx.origin);
        if (!flag("keep-trace")) fs.rmSync(tracePath, { force: true });
        const r = { ...a, fcp: mp.paint["first-contentful-paint"], usable: mp.marks.usable, viewport: mp.marks.viewport, lcp: mp.lcp && mp.lcp.t, cls: mp.cls, dom, layers };
        results.push(r);
        process.stdout.write(`  ${route}.${look} x${cpu} #${n + 1}: fcp ${Math.round(r.fcp)} usable ${Math.round(r.usable)} lcp ${Math.round(r.lcp)} tbt ${r.tbt} main ${r.total}ms (script ${r.kinds.script || 0} compile ${r.kinds.compile || 0} style ${r.kinds.style || 0} layout ${r.kinds.layout || 0} paint ${(r.kinds.paint || 0) + (r.kinds.prepaint || 0)} composite ${r.kinds.composite || 0}) long ${r.longTaskCount} dom ${dom.nodes}\n`);
        await page.close();
      }
      const m = (f) => spread(results.map(f));
      const mid = results.slice().sort((a, b) => a.total - b.total)[Math.floor(results.length / 2)];
      const out = {
        route, look, device, cpu, runs, settleMs: settle,
        fcp: m((r) => r.fcp), usable: m((r) => r.usable), viewport: m((r) => r.viewport), lcp: m((r) => r.lcp), tbt: m((r) => r.tbt), total: m((r) => r.total),
        kinds: Object.fromEntries([...new Set(results.flatMap((r) => Object.keys(r.kinds)))].map((k) => [k, m((r) => r.kinds[k] || 0)])),
        longTaskCount: m((r) => r.longTaskCount), dom: mid.dom, layers: mid.layers, counts: mid.counts,
        longTasks: mid.longTasks, jsByFile: mid.jsByFile, jsByFunction: mid.jsByFunction,
      };
      writeJson(path.join(dir, `${route}.${look}.json`), out);
      const mdn = (x) => (x && x.median != null ? Math.round(x.median) : null);
      summary.push({ cell: `${route}.${look}`, fcp: mdn(out.fcp), usable: mdn(out.usable), lcp: mdn(out.lcp), tbt: out.tbt.median, main: out.total.median, script: out.kinds.script && out.kinds.script.median, style: out.kinds.style && out.kinds.style.median, layout: out.kinds.layout && out.kinds.layout.median, long: out.longTaskCount.median, dom: out.dom.nodes });
    }
  } finally {
    await ctx.close();
  }
  console.table(summary);
};

main().catch((e) => { console.error(e.stack || e); process.exit(1); });

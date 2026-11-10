#!/usr/bin/env node
// What the main thread does while Home starts, and what is inside each long
// task (> 50 ms) — from a Chrome trace, on the same far line as feel.js.
//
//   node tools/webperf/tasks.js --instance <state file> --label before
//        [--cell phone:slow] [--runs 3] [--warm]
//
// Per run a fresh context, Home opened cold (or, --warm, opened once and then
// again), traced for 10 s. Reported per run and as medians:
//   main thread by kind: script (compile / module evaluation / calls),
//   style, layout, paint, parse HTML, GC; JS compile+parse alone
//   long tasks: start, length, and what filled them — the largest pieces by
//   self time (a function and its file, a layout, a style pass…)
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { OUT, argv, flag, DEVICES, launch, sleep, median, writeJson } = require("./lib");
const { startFront } = require("../mobile-perf/front");

const LINES = { fast: { rtt: 70, mbit: 50 }, slow: { rtt: 250, mbit: 3 } };
const DEV = { desktop: { d: "desktop-1440", cpu: 1 }, phone: { d: "phone-390", cpu: 4 } };

const startLine = async (inst, line) => {
  const { rtt, mbit } = LINES[line];
  const child = spawn(process.execPath, [path.join(__dirname, "slowproxy.js"), "--to", inst.url, "--rtt", String(rtt), "--mbit", String(mbit)], { stdio: ["ignore", "pipe", "inherit"] });
  process.on("exit", () => { try { process.kill(child.pid); } catch {} });
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (c) => { buf += c; const m = buf.match(/\{.*\}/); if (m) resolve(JSON.parse(m[0]).url); });
    child.on("exit", () => reject(new Error("slowproxy exited")));
  });
  const front = await startFront(url);
  return { url: front.url, spki: front.spki, stop: async () => { await front.stop(); try { process.kill(child.pid); } catch {} } };
};

const KIND = (n) => {
  if (/^(v8\.compile|v8\.compileModule|V8\.CompileCode|v8\.parseOnBackground|V8\.ParseProgram|V8\.ParseFunction|CompileScript|v8\.produceCache|v8\.produceModuleCache)/i.test(n)) return "compile";
  if (/^(EvaluateScript|v8\.evaluateModule|FunctionCall|TimerFire|EventDispatch|FireAnimationFrame|v8\.callFunction|RunMicrotasks|V8\.Execute|XHRReadyStateChange|FireIdleCallback)$/.test(n)) return "script";
  if (/^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet)$/.test(n)) return "style";
  if (/^Layout$/.test(n)) return "layout";
  if (/^(Paint|PaintImage|RasterTask|CompositeLayers|UpdateLayer|UpdateLayerTree|PrePaint|Layerize|Commit)$/.test(n)) return "paint";
  if (/^ParseHTML$/.test(n)) return "html";
  if (/^(MinorGC|MajorGC|V8\.GCScavenger|V8\.GCFinalizeMC|BlinkGC\.|V8\.GC_)/.test(n)) return "gc";
  if (/^(Decode Image|ImageDecodeTask|Decode LazyPixelRef)$/.test(n)) return "decode";
  return null;
};

const summarize = (events) => {
  // the renderer's main thread
  const names = events.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args && e.args.name === "CrRendererMain");
  // the page's renderer: the one with the most work
  let best = null, bestN = -1;
  for (const t of names) {
    const n = events.filter((e) => e.pid === t.pid && e.tid === t.tid && e.ph === "X").length;
    if (n > bestN) { best = t; bestN = n; }
  }
  if (!best) return null;
  const main = events.filter((e) => e.pid === best.pid && e.tid === best.tid && e.ph === "X" && e.dur != null).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const nav = events.find((e) => e.name === "navigationStart" && e.pid === best.pid) || events.find((e) => e.name === "TracingStartedInBrowser");
  const t0 = nav ? nav.ts : main[0].ts;
  // nesting: self time per event
  const stack = [];
  const out = { kinds: {}, long: [] };
  const tops = [];
  for (const e of main) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
    e.self = e.dur;
    e.kids = [];
    if (stack.length) { const p = stack[stack.length - 1]; p.self -= e.dur; p.kids.push(e); e.parent = p; }
    else tops.push(e);
    stack.push(e);
  }
  const label = (e) => {
    const d = (e.args && e.args.data) || {};
    // the nearest JS frame above for script pieces
    let p = e, fn = null;
    while (p && !fn) { const dd = (p.args && p.args.data) || {}; if (dd.functionName || dd.url) fn = `${dd.functionName || "(anon)"} ${String(dd.url || "").replace(/^.*\/\/[^/]+/, "").replace(/\?v=.*/, "")}`; p = p.parent; }
    const k = KIND(e.name) || e.name;
    if (k === "script" || k === "compile") return `${k}: ${fn || e.name}${d.url && !fn ? " " + d.url : ""}`;
    return k;
  };
  for (const e of main) {
    const k = KIND(e.name);
    if (k) out.kinds[k] = (out.kinds[k] || 0) + e.self / 1000;
  }
  for (const k of Object.keys(out.kinds)) out.kinds[k] = Math.round(out.kinds[k]);
  // long tasks: top-level tasks over 50 ms
  for (const t of tops) {
    if (t.dur < 50000) continue;
    const parts = new Map();
    const walk = (e) => { if (e.self > 500) { const l = label(e); parts.set(l, (parts.get(l) || 0) + e.self / 1000); } e.kids.forEach(walk); };
    walk(t);
    out.long.push({ at: Math.round((t.ts - t0) / 1000), ms: Math.round(t.dur / 1000), what: [...parts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, ms]) => `${Math.round(ms)} ${l}`) });
  }
  return out;
};

const main = async () => {
  const label = argv("label", "tasks");
  const [dev, line] = argv("cell", "phone:slow").split(":");
  const runs = Number(argv("runs", 3));
  const warm = flag("warm");
  const inst = JSON.parse(fs.readFileSync(argv("instance"), "utf8"));
  const ln = await startLine(inst, line);
  const browser = await launch({ extraArgs: [`--ignore-certificate-errors-spki-list=${ln.spki}`] });
  const D = DEVICES[DEV[dev].d];
  const all = [];
  try {
    for (let i = 0; i <= runs; i++) {
      const ctx = await browser.newContext({ viewport: { width: D.width, height: D.height }, deviceScaleFactor: D.dpr, isMobile: D.mobile, hasTouch: D.mobile, ...(D.ua ? { userAgent: D.ua } : {}), serviceWorkers: "allow", ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.clearBrowserCache");
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: DEV[dev].cpu });
      await page.goto(`${ln.url}/robots.txt`);
      await page.evaluate(([id, name]) => {
        localStorage.setItem("aurora-profile", id); localStorage.setItem("aurora-profile-name", JSON.stringify(name));
        localStorage.setItem("aurora-authmode", "open"); localStorage.setItem("aurora-early", "open");
        localStorage.setItem("aurora-nav-hinted", "1"); localStorage.setItem("aurora-kbd-hint", "1"); localStorage.setItem("aurora-data-mode", "full");
      }, [inst.profiles.glass.id, inst.profiles.glass.name]);
      if (warm) { await page.goto(`${ln.url}/#/`); await sleep(9000); }
      const file = path.join(OUT, label, `trace-${i}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await browser.startTracing(page, { path: file, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "v8.execute", "blink", "loading", "toplevel", "disabled-by-default-v8.compile"] });
      if (warm) await page.reload({ waitUntil: "commit" }); else await page.goto(`${ln.url}/#/`, { waitUntil: "commit" });
      await sleep(10000);
      await browser.stopTracing();
      await ctx.close();
      if (i === 0) { fs.unlinkSync(file); continue; }
      const tr = JSON.parse(fs.readFileSync(file, "utf8"));
      const s = summarize(tr.traceEvents || tr);
      if (!flag("keep")) fs.unlinkSync(file);
      all.push(s);
      console.log(`run ${i}: ${JSON.stringify(s.kinds)}; long tasks ${s.long.length}`);
      for (const l of s.long) console.log(`   @${l.at} ${l.ms} ms: ${l.what.join(" | ")}`);
    }
  } finally {
    await browser.close();
    await ln.stop();
  }
  const kinds = {};
  for (const k of new Set(all.flatMap((s) => Object.keys(s.kinds)))) kinds[k] = median(all.map((s) => s.kinds[k] || 0));
  console.log(`\n== ${label} ${dev}:${line} ${warm ? "warm" : "cold"} medians: ${JSON.stringify(kinds)}; long tasks ${median(all.map((s) => s.long.length))}, blocked ${median(all.map((s) => s.long.reduce((a, l) => a + l.ms - 50, 0)))} ms`);
  writeJson(path.join(OUT, label, `tasks-${dev}-${line}${warm ? "-warm" : ""}.json`), all);
};
module.exports = { summarize };
if (require.main === module) {
  process.on("SIGINT", () => process.exit(130));
  main().catch((e) => { console.error(e); process.exit(1); });
}

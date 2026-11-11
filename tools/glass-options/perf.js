// What each glass version costs while the page moves (tools/glass-apple/
// scrollperf.js, one side per version instead of before/after), and what
// opening the phone's More menu costs.
//
//   node tools/glass-options/perf.js <out.json> [size,size] [runs] [a,b,c,d,e]
//
// Per run and version, in a fresh context: Home walked once to the bottom so
// every picture is in, back to the top, four seconds of rest, one steady
// gesture to the bottom at 3000 px/s (frame times from requestAnimationFrame,
// late = over 25 ms; Chrome's compositor frames from its trace), three
// seconds at rest mid-page (the sky repaints under the glass); then, on a
// phone, back to the top and the More menu opened: the frames of its first
// 700 ms (the sheet slides in over 280 ms, the page dims under it).
"use strict";
const fs = require("fs");
const { launch, openPage, go, sleep, SIZES } = require("../glass-apple/lib");

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const med = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const r1 = (x) => Math.round(x * 10) / 10;
const CPU = { phone: 4, "phone-390": 4, "phone-320": 4, tablet: 2 };

const WATCH = () => {
  const w = (window.__fp = { frames: [], on: false });
  let last = 0;
  const loop = (t) => { if (!w.on) return; if (last) w.frames.push(t - last); last = t; requestAnimationFrame(loop); };
  w.start = () => { w.frames = []; last = 0; w.on = true; requestAnimationFrame(loop); };
  w.stop = () => { w.on = false; return w.frames; };
};

const stats = (f) => ({ n: f.length, mean: r1(f.reduce((a, b) => a + b, 0) / Math.max(1, f.length)), p50: r1(pct(f, 0.5)), p95: r1(pct(f, 0.95)), p99: r1(pct(f, 0.99)), worst: Math.round(Math.max(0, ...f)), late: f.filter((x) => x > 25).length });

// Chrome's compositor frames, from its trace: each PipelineReporter is one
// frame it set out to produce; its state says whether it reached the screen.
const frameStates = (buf) => {
  let ev = [];
  try { ev = JSON.parse(buf.toString("utf-8")).traceEvents || []; } catch { return null; }
  let presented = 0, dropped = 0, partial = 0;
  for (const e of ev) {
    if (e.name !== "PipelineReporter" || (e.ph !== "b" && e.ph !== "B")) continue;
    const a = e.args || {};
    const s = (a.chrome_frame_reporter && a.chrome_frame_reporter.state) || a.state || "";
    if (/DROPPED/i.test(s)) dropped++;
    else if (/PARTIAL/i.test(s)) partial++;
    else if (/PRESENTED/i.test(s)) presented++;
  }
  const n = presented + dropped + partial;
  return n ? { frames: n, dropped, partial, droppedPct: r1((dropped / n) * 100) } : null;
};

(async () => {
  const [outFile = "perf.json", sizesArg = "phone-390", runsArg = "4", vArg = "a,b,c,d,e"] = process.argv.slice(2);
  const route = "home";
  const sizes = sizesArg.split(",");
  const runs = Number(runsArg);
  const sides = vArg.split(",");
  const b = await launch();
  const res = {};
  try {
    for (const size of sizes) {
      res[size] = Object.fromEntries(sides.map((s) => [s, []]));
      for (let r = 0; r < runs; r++) {
        // the order turns each run, so neither side always goes first
        const order = sides.map((_, i) => sides[(i + r) % sides.length]);
        for (const side of order) {
          const h = await openPage(b, { size, side: "after", freeze: false, glass: side === "a" ? null : side });
          const { page } = h;
          const cdp = await h.ctx.newCDPSession(page);
          await page.addInitScript(WATCH);
          await go(h, route);
          const got = await page.evaluate(() => document.documentElement.dataset.glass || "a");
          if (got !== side) throw new Error(`version ${got} on the page, ${side} asked`);
          await page.waitForSelector(".row .card, .grid .card", { timeout: 30000 });
          // every picture in, before anything is timed
          const max = await page.evaluate(async () => {
            const sc = document.scrollingElement;
            for (let y = 0; y < sc.scrollHeight; y += Math.round(innerHeight * 0.8)) { sc.scrollTop = y; await new Promise((r) => setTimeout(r, 180)); }
            await new Promise((r) => setTimeout(r, 1200));
            sc.scrollTop = 0;
            return sc.scrollHeight - innerHeight;
          });
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU[size] || 1 });
          await sleep(4000);
          const d = SIZES[size];
          const x = Math.round(d.width / 2), y = Math.round(d.height * 0.55);
          if (!d.mobile) await page.mouse.move(x, y);
          await b.startTracing(page, { categories: ["benchmark", "cc", "viz", "input"] }).catch(() => {});
          await page.evaluate(() => window.__fp.start());
          await cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: -max, speed: 3000, gestureSourceType: d.mobile ? "touch" : "mouse", repeatCount: 0 });
          const scroll = await page.evaluate(() => window.__fp.stop());
          let trace = null;
          try { trace = frameStates(await b.stopTracing()); } catch {}
          // at rest in the middle of the page: only the sky moves
          await page.evaluate((m) => { document.scrollingElement.scrollTop = Math.round(m / 2); }, max);
          await sleep(800);
          await page.evaluate(() => window.__fp.start());
          await sleep(3000);
          const rest = await page.evaluate(() => window.__fp.stop());
          // the More menu, opened on a phone
          let more = null;
          if (SIZES[size].mobile && SIZES[size].width <= 720) {
            await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
            await sleep(1200);
            await page.evaluate(() => window.__fp.start());
            await page.evaluate(() => document.querySelector(".nav-more").click());
            await sleep(700);
            const f = await page.evaluate(() => window.__fp.stop());
            more = { ...stats(f), sum: Math.round(f.reduce((a, x) => a + x, 0)) };
          }
          const one = { scroll: stats(scroll), rest: stats(rest), trace, more };
          res[size][side].push(one);
          console.log(size, side, "run", r + 1, JSON.stringify(one));
          await h.ctx.close();
        }
      }
    }
  } finally { await b.close(); }
  const summary = {};
  for (const size of Object.keys(res)) {
    summary[size] = {};
    for (const side of sides) {
      const a = res[size][side];
      const m = (f) => med(a.map(f));
      summary[size][side] = {
        scrollMean: m((x) => x.scroll.mean), scrollP95: m((x) => x.scroll.p95), scrollP99: m((x) => x.scroll.p99), scrollWorst: m((x) => x.scroll.worst), scrollLate: m((x) => x.scroll.late), scrollFrames: m((x) => x.scroll.n),
        restMean: m((x) => x.rest.mean), restP95: m((x) => x.rest.p95), restLate: m((x) => x.rest.late),
        droppedPct: m((x) => (x.trace ? x.trace.droppedPct : NaN)), compositorFrames: m((x) => (x.trace ? x.trace.frames : NaN)),
        moreFrames: m((x) => (x.more ? x.more.n : NaN)), moreP95: m((x) => (x.more ? x.more.p95 : NaN)), moreWorst: m((x) => (x.more ? x.more.worst : NaN)), moreLate: m((x) => (x.more ? x.more.late : NaN)),
      };
    }
    console.log(size, JSON.stringify(summary[size]));
  }
  fs.writeFileSync(outFile, JSON.stringify({ route, runs, cpu: CPU, summary, all: res }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });

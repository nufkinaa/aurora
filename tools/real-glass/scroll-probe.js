// Why a scroll costs what it costs: Home scrolled top to bottom at 3000 px/s
// (tools/glass-options/perf.js's gesture), several times, per side — frame
// times, plus what the lens did meanwhile (maps drawn, surfaces re-fitted).
//
//   node tools/real-glass/scroll-probe.js [size=desktop] [runs=4] [a,e,n]
//   a = today's stylesheet and script, e = this worktree, n = e with the lens off
"use strict";
const { launch, openPage, go, sleep, SIZES } = require("../glass-apple/lib");

const WATCH = () => {
  const w = (window.__fp = { frames: [], on: false });
  let last = 0;
  const loop = (t) => { if (!w.on) return; if (last) w.frames.push(t - last); last = t; requestAnimationFrame(loop); };
  w.start = () => { w.frames = []; last = 0; w.on = true; requestAnimationFrame(loop); };
  w.stop = () => { w.on = false; return w.frames; };
  // what the lens does: every --rg-lens it sets
  window.__lensSets = 0;
  const sp = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (k, ...r) { if (k === "--rg-lens") window.__lensSets++; return sp.call(this, k, ...r); };
};
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const r1 = (x) => Math.round(x * 10) / 10;

(async () => {
  const size = process.argv[2] || "desktop";
  const runs = Number(process.argv[3] || 4);
  const sides = (process.argv[4] || "a,e,n").split(",");
  const cpu = SIZES[size].mobile ? 4 : 1;
  const b = await launch();
  const res = Object.fromEntries(sides.map((s) => [s, []]));
  try {
    for (let r = 0; r < runs; r++) {
      for (const side of sides.map((_, i) => sides[(i + r) % sides.length])) {
        const h = await openPage(b, { size, side: side === "a" ? "before" : "after", freeze: false, extra: side === "n" ? { "aurora-lens": "off" } : {} });
        const { page } = h;
        const cdp = await h.ctx.newCDPSession(page);
        await page.addInitScript(WATCH);
        await go(h, "home");
        await page.waitForSelector(".row .card", { timeout: 30000 });
        const max = await page.evaluate(async () => {
          const sc = document.scrollingElement;
          for (let y = 0; y < sc.scrollHeight; y += Math.round(innerHeight * 0.8)) { sc.scrollTop = y; await new Promise((r) => setTimeout(r, 180)); }
          await new Promise((r) => setTimeout(r, 1200));
          sc.scrollTop = 0;
          return sc.scrollHeight - innerHeight;
        });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
        await sleep(3000);
        const d = SIZES[size];
        const x = Math.round(d.width / 2), y = Math.round(d.height * 0.55);
        if (!d.mobile) await page.mouse.move(x, y);
        const before = await page.evaluate(() => [window.__lensSets, document.querySelectorAll("#rg-defs filter").length]);
        await page.evaluate(() => window.__fp.start());
        await cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: -max, speed: 3000, gestureSourceType: d.mobile ? "touch" : "mouse", repeatCount: 0 });
        const f = await page.evaluate(() => window.__fp.stop());
        const after = await page.evaluate(() => [window.__lensSets, document.querySelectorAll("#rg-defs filter").length]);
        const one = { n: f.length, mean: r1(f.reduce((a, c) => a + c, 0) / f.length), worst: Math.round(Math.max(...f)), late: f.filter((v) => v > 25).length, lensSets: after[0] - before[0], filters: `${before[1]}->${after[1]}` };
        res[side].push(one);
        console.log(size, side, JSON.stringify(one));
        await h.ctx.close();
      }
    }
  } finally { await b.close(); }
  for (const s of sides) console.log(s, "mean", med(res[s].map((v) => v.mean)), "worst", med(res[s].map((v) => v.worst)), "late", med(res[s].map((v) => v.late)), "| all late:", res[s].map((v) => v.late).join(","));
})().catch((e) => { console.error(e); process.exit(1); });

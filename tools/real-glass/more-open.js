// What opening the phone's More menu costs (its first 700 ms, CPU x4), many
// times over, for: "a" today's stylesheet and script, "e" this worktree's,
// "n" this worktree's with the lens switched off (localStorage aurora-lens).
// tools/glass-options/perf.js measures the same once per run; this is the
// quick, repeated version used to find where a late frame comes from.
//
// "b": e with the tab bar's lens taken off (the round buttons keep theirs);
// "t": e with the round buttons' lens taken off (the bar keeps its own).
//
//   node tools/real-glass/more-open.js [runs=10] [a,e,n,b,t]
"use strict";
const { launch, openPage, go, sleep } = require("../glass-apple/lib");

const WATCH = () => {
  const w = (window.__fp = { frames: [], on: false });
  let last = 0;
  const loop = (t) => { if (!w.on) return; if (last) w.frames.push(t - last); last = t; requestAnimationFrame(loop); };
  w.start = () => { w.frames = []; last = 0; w.on = true; requestAnimationFrame(loop); };
  w.stop = () => { w.on = false; return w.frames; };
};
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

(async () => {
  const runs = Number(process.argv[2] || 10);
  const sides = (process.argv[3] || "a,e,n").split(",");
  const b = await launch();
  const res = Object.fromEntries(sides.map((s) => [s, []]));
  try {
    for (let r = 0; r < runs; r++) {
      for (const side of sides.map((_, i) => sides[(i + r) % sides.length])) {
        const h = await openPage(b, { size: "phone-390", side: side === "a" ? "before" : "after", freeze: false, extra: side === "n" ? { "aurora-lens": "off" } : {} });
        const cdp = await h.ctx.newCDPSession(h.page);
        await h.page.addInitScript(WATCH);
        await go(h, "home");
        await h.page.waitForSelector(".row .card", { timeout: 30000 });
        const plain = { b: ".nav-items", t: ".nav-logo, .nav-gear, .nav-profile, .nav-dl, .hero-actions .btn" }[side];
        if (plain) await h.page.addStyleTag({ content: `${plain.split(",").map((x) => `html[data-look="glass"][data-lens]:root ${x.trim()}`).join(",")} { --g-blur: var(--ge-blur) !important; }` });
        await sleep(1500);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await sleep(2500);
        await h.page.evaluate(() => window.__fp.start());
        await h.page.evaluate(() => document.querySelector(".nav-more").click());
        await sleep(700);
        const f = await h.page.evaluate(() => window.__fp.stop());
        res[side].push({ n: f.length, worst: Math.round(Math.max(...f)), late: f.filter((x) => x > 25).length });
        await h.ctx.close();
      }
    }
  } finally { await b.close(); }
  for (const s of sides) console.log(s, "frames", med(res[s].map((x) => x.n)), "worst", res[s].map((x) => x.worst).join(","), "median worst", med(res[s].map((x) => x.worst)), "late", med(res[s].map((x) => x.late)));
})().catch((e) => { console.error(e); process.exit(1); });

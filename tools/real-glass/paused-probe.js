// What still asks for frames while a film is PAUSED with the controls up:
// who calls requestAnimationFrame (by the top of its stack), which CSS
// animations run, which timers fire, and how many frames the page really
// draws in five seconds.
//
//   node tools/real-glass/paused-probe.js
"use strict";
const { launch, openPage, go, sleep } = require("../glass-apple/lib");

const SPY = () => {
  const who = (window.__raf = {});
  const real = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => {
    if (window.__spy) {
      const at = (new Error().stack || "").split("\n").slice(2, 4).map((l) => l.trim().replace(/^at /, "").replace(/https?:\/\/[^/]+/, "").slice(0, 90)).join(" < ");
      who[at] = (who[at] || 0) + 1;
    }
    return real(fn);
  };
  const timers = (window.__timers = {});
  for (const name of ["setInterval"]) {
    const r = window[name].bind(window);
    window[name] = (fn, ms, ...rest) => {
      const at = (new Error().stack || "").split("\n").slice(2, 3).map((l) => l.trim().replace(/^at /, "").replace(/https?:\/\/[^/]+/, "").slice(0, 90)).join("");
      return r((...a) => { if (window.__spy) timers[`${ms}ms ${at}`] = (timers[`${ms}ms ${at}`] || 0) + 1; return fn(...a); }, ms, ...rest);
    };
  }
};

(async () => {
  const b = await launch();
  try {
    const h = await openPage(b, { size: "desktop", freeze: false });
    const { page } = h;
    await page.addInitScript(SPY);
    await go(h, `#/play/${h.inst.lib.film1}`);
    await page.waitForSelector(".player video", { timeout: 25000 });
    await page.evaluate(async () => { const v = document.querySelector(".player video"); v.muted = true; await v.play().catch(() => {}); });
    await sleep(2500);
    await page.evaluate(() => document.querySelector(".player video").pause());
    await sleep(3000);
    const cdp = await h.ctx.newCDPSession(page);
    await cdp.send("Performance.enable");
    const frames = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "Frames")?.value;
    const f0 = await frames();
    await page.evaluate(() => { window.__spy = true; });
    await sleep(5000);
    const f1 = await frames();
    const out = await page.evaluate(() => ({
      raf: window.__raf, timers: window.__timers,
      animations: document.getAnimations().filter((a) => a.playState === "running").map((a) => `${a.animationName || a.transitionProperty || "?"} on ${a.effect && a.effect.target ? (a.effect.target.id ? "#" + a.effect.target.id : "." + String(a.effect.target.className).split(" ")[0]) : "?"}${a.effect && a.effect.pseudoElement ? a.effect.pseudoElement : ""}`),
      paused: document.querySelector(".player video").paused, cls: document.querySelector(".player").className,
      canvases: [...document.querySelectorAll("canvas")].map((c) => `${c.id || c.className} ${c.width}x${c.height} shown:${c.offsetWidth > 0}`),
    }));
    console.log("frames drawn in 5 s:", f1 - f0);
    console.log(JSON.stringify(out, null, 1));
  } finally { await b.close(); }
})().catch((e) => { console.error(e); process.exit(1); });

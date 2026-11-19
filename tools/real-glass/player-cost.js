// What the glass over a PLAYING film costs: the player's chrome sits over a
// picture that changes every frame, so its backdrop filter runs every frame.
// A library film played for some seconds on a desktop with the controls
// held up; measured: the page's frame times, the frames the video dropped,
// and the processor time the browser's GPU process and the page's own
// process used meanwhile (Chrome's SystemInfo.getProcessInfo).
//
// WHERE=home (and SIZE=phone-390|desktop): the same at rest on Home, scrolled
// a little so posters are under the bar — there the living sky and the
// pictures are what is behind the glass. SCROLL=1: while the page is
// scrolled up and down the whole time by script; SCROLL=touch: by a finger.
// TOP=1: Home not scrolled (the hero and its glass button in view).
//
//   node tools/real-glass/player-cost.js [runs=4] [a,e,n] [seconds=10]
//   a = today's stylesheet and script, e = this worktree, n = e with the lens off, r = n with no ::before at all,
//   o = e with only the bar's lens, m = e without the small round buttons' and a title's buttons' lenses
"use strict";
const { launch, openPage, go, sleep } = require("../glass-apple/lib");

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const r1 = (x) => Math.round(x * 10) / 10;

(async () => {
  const runs = Number(process.argv[2] || 4);
  const sides = (process.argv[3] || "a,e,n").split(",");
  const secs = Number(process.argv[4] || 10);
  const res = Object.fromEntries(sides.map((s) => [s, []]));
  for (let r = 0; r < runs; r++) {
    for (const side of sides.map((_, i) => sides[(i + r) % sides.length])) {
      // a browser of its own each time: its GPU process's time is this run's alone
      const b = await launch();
      try {
        const h = await openPage(b, { size: process.env.SIZE || "desktop", side: side === "a" ? "before" : "after", freeze: false, extra: side === "n" || side === "r" ? { "aurora-lens": "off" } : {} }); // (h = e with the pointer resting on Settings)
        const { page } = h;
        if (process.env.RES) await page.addInitScript((r) => { window.__rgRes = r; }, Number(process.env.RES)); // (a try: how fine the maps are drawn)
        // CSS="…": a stylesheet laid over side e (a try at other numbers), before the lens starts
        if (process.env.CSS && side === "e") await page.addInitScript((css) => { addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.textContent = css; document.head.append(st); }); }, process.env.CSS);
        if (process.env.NORAF) await page.addInitScript(() => { window.__noraf = true; });
        const home = process.env.WHERE === "home";
        await go(h, home ? "home" : `#/play/${h.inst.lib.film1}`);
        if (home) { await page.waitForSelector(".row .card", { timeout: 30000 }); if (!process.env.TOP) await page.evaluate(() => scrollTo(0, 900)); }
        else await page.waitForSelector(".player video", { timeout: 25000 });
        await page.evaluate(async ([home, scroll]) => {
          const v = document.querySelector(".player video") || { getVideoPlaybackQuality: () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 }), paused: true };
          window.__v = v;
          if (!home) { v.muted = true; v.loop = true; await v.play().catch(() => {}); }
          // the controls held up for the whole measurement
          window.__hold = setInterval(() => document.querySelector(".player")?.classList.remove("controls-hidden"), 200);
          if (scroll === "1") { let y = 900, dir = 12; setInterval(() => { y += dir; if (y > 2600 || y < 600) dir = -dir; scrollTo(0, y); }, 16); }
          window.__f = []; let last = 0;
          const loop = (t) => { if (last) window.__f.push(t - last); last = t; requestAnimationFrame(loop); };
          // (NORAF=1: nothing of ours asks for frames — a paused film then draws none at all)
          if (!window.__noraf) requestAnimationFrame(loop);
        }, [home, process.env.SCROLL || ""]);
        // r = n without the rims' rings (::before): what the rings cost
        if (side === "r") await page.addStyleTag({ content: "html[data-look='glass']:root *::before { content: none !important; }" });
        await sleep(2500);
        // PAUSED=1: the film paused on a frame, the controls up (the lens is on the player's chrome then);
        // HOVER=1: the pointer resting on the settings button (it wears its lens under the pointer)
        if (process.env.PAUSED) { await page.evaluate(() => window.__v.pause()); await sleep(1200); }
        if (process.env.HOVER || side === "h") { const c = await page.evaluate(() => { const r = document.querySelector(".nav-gear").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }); await page.mouse.move(c[0], c[1]); await sleep(600); }
        // TRY=ref: every lens swapped for the plain frosted filter (still a url() filter, no map, no bend);
        // TRY=one: only the bar keeps its lens; TRY=nomap: lenses without their map picture's cost? (see notes)
        const how = side === "o" ? "one" : side === "m" ? "mid" : process.env.TRY;
        if (how) await page.evaluate((how) => {
          for (const el of document.querySelectorAll("[style*='--rg-lens']")) {
            if (how === "ref") el.style.setProperty("--rg-lens", "url(#rg-0)");
            if (how === "one" && !el.matches(".nav-items")) el.style.setProperty("--rg-lens", "url(#rg-0)");
            if (how === "bar" && el.matches(".nav-items")) el.style.setProperty("--rg-lens", "url(#rg-0)");
            if (how === "mid" && el.matches(".nav-gear, .nav-dl, .nav-remote, .detail-actions .btn")) el.style.setProperty("--rg-lens", "url(#rg-0)");
          }
        }, how);
        await sleep(500);
        const sys = await b.newBrowserCDPSession();
        const times = async () => Object.fromEntries((await sys.send("SystemInfo.getProcessInfo")).processInfo.map((p) => [`${p.type}:${p.id}`, p.cpuTime]));
        const lens = await page.evaluate(() => [...document.querySelectorAll(".nav-items, .nav-logo, .nav-gear, .nav-profile, .hero-actions .btn, .player-bottom, .player-top > div, .player-top .pbtn")].filter((e) => e.offsetWidth > 0 && /url\(/.test(getComputedStyle(e).backdropFilter)).length); // (lenses being SHOWN now)
        const q0 = await page.evaluate(() => { window.__f = []; const q = window.__v.getVideoPlaybackQuality(); return [q.totalVideoFrames, q.droppedVideoFrames]; });
        const t0 = await times();
        if (process.env.SCROLL === "touch") {
          // a finger's scroll (the compositor's own, as on a phone), down and up, for the whole time
          const cdp = await h.ctx.newCDPSession(page);
          const end = Date.now() + secs * 1000;
          for (let dir = -1; Date.now() < end; dir = -dir) await cdp.send("Input.synthesizeScrollGesture", { x: 195, y: 450, yDistance: dir * 1400, speed: 1400, gestureSourceType: "touch", repeatCount: 0 });
        } else await sleep(secs * 1000);
        const t1 = await times();
        const out = await page.evaluate(() => { const q = window.__v.getVideoPlaybackQuality(); return { f: window.__f, q: [q.totalVideoFrames, q.droppedVideoFrames], playing: !window.__v.paused }; });
        const sum = (type) => Object.keys(t1).filter((k) => k.startsWith(type)).reduce((a, k) => a + (t1[k] - (t0[k] || 0)), 0);
        const one = { lens, playing: out.playing, frames: out.f.length, mean: r1(out.f.reduce((a, c) => a + c, 0) / Math.max(1, out.f.length)), late: out.f.filter((v) => v > 25).length, video: out.q[0] - q0[0], dropped: out.q[1] - q0[1], gpuMs: Math.round(sum("gpu") * 1000), rendererMs: Math.round(sum("renderer") * 1000) };
        res[side].push(one);
        console.log(side, JSON.stringify(one));
      } finally { await b.close(); }
    }
  }
  for (const s of sides) console.log(s, `over ${secs}s: GPU process ${med(res[s].map((v) => v.gpuMs))} ms, page ${med(res[s].map((v) => v.rendererMs))} ms, mean frame ${med(res[s].map((v) => v.mean))} ms, late ${med(res[s].map((v) => v.late))}, video frames dropped ${med(res[s].map((v) => v.dropped))} of ${med(res[s].map((v) => v.video))}`);
})().catch((e) => { console.error(e); process.exit(1); });

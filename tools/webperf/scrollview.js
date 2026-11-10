#!/usr/bin/env node
// What a person SEES while scrolling a page of posters on a desktop: not the
// frame times (run.js "scroll-home" has those) but the pictures — how many
// posters are on screen without their picture, for how long, and what the
// page looks like mid-scroll.
//
//   node tools/webperf/scrollview.js --instance <state file> --label before
//       [--route "#/"] [--line 4g|none] [--cpu 1] [--runs 3] [--shots]
//       [--notch 100] [--every 90]   (a wheel notch of 100 px every 90 ms:
//                                      a steady hand on a mouse wheel)
//       [--warm]  (the pictures already in the HTTP cache: a second visit)
//       [--speed 3000]  (px/s: one steady wheel gesture, a free-spinning wheel)
//       [--settle 4000] (ms at the top of the page before the scroll starts)
//       [--extra k=v,k=v] (localStorage, e.g. aurora-data-mode=saver)
//       [--sky page] (the page sky kept on the page's thread instead of its worker)
//       [--bare]  (frame times only: lateFrames / worstFrame without the cost
//                  of watching the posters — the picture numbers read 0)
//       [--device phone-390]  (a size out of lib.js DEVICES instead of the
//                  1440x900 desktop; a touch device is scrolled by a finger.
//                  With --speed only)
//   --live <url> --rules <file>: this PC's own server instead of an instance,
//       signed in as the test profile through the page. For a server that is
//       far away, put slowproxy.js in front of either.
//
// Per run, in a fresh context: the page opened and left to settle, then
// wheeled to the bottom. Every animation frame the posters in view are
// counted: `blank` = in view with no picture drawn yet (not loaded, or still
// fading/sharpening in). Reported:
//   blankFrames     the sum over frames of blank posters in view (the area
//                   under the curve: what the eye pays)
//   worstBlank      the most blank posters in view at once
//   blankShare      of all poster-frames in view, the share that was blank
//   lateMs p50/p90  from a poster entering the view to its picture being in
//   lateFrames      frames over 25 ms; worstFrame
//   --shots         a screenshot every ~250 ms into out/<label>/scroll-*.jpg
"use strict";
const path = require("path");
const fs = require("fs");
const { OUT, argv, flag, launch, newContext, throttle, prime, clearCaches, sleep, median, writeJson, DEVICES } = require("./lib");

const WATCH = () => {
  const w = (window.__sv = { frames: [], blank: [], soft: [], inview: [], late: [], on: false });
  try { performance.setResourceTimingBufferSize(4000); } catch {}
  const seen = new Map(); // img -> first time in view while blank
  // 0 = no picture, 1 = there but still fading / sharpening in, 2 = in
  const state = (im) => {
    if (!im.complete || !im.naturalWidth) return 0;
    if (im.classList.contains("img-in")) {
      if (parseFloat(getComputedStyle(im).opacity) <= 0.9) return 1;
      // (a finished animation that fills forwards is still listed)
      return im.getAnimations && im.getAnimations().some((x) => x.playState === "running") ? 1 : 2;
    }
    return !im.classList.contains("img-fade") && !im.classList.contains("img-blurup") ? 2 : 0;
  };
  let last = 0;
  const loop = (t) => {
    if (!w.on) return;
    if (last) w.frames.push(t - last);
    last = t;
    // (--bare: the frame times alone — counting posters every frame is work
    // of its own, and more of it the more pictures are already in)
    if (w.bare) return requestAnimationFrame(loop);
    const vh = innerHeight, vw = innerWidth;
    let blank = 0, soft = 0, n = 0;
    for (const im of document.querySelectorAll(".card img, .grid img")) {
      const b = im.getBoundingClientRect();
      if (!(b.width > 0 && b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw)) continue;
      n++;
      const st = state(im);
      if (st === 1) soft++;
      if (st === 2) {
        if (seen.has(im)) { w.late.push(t - seen.get(im)); seen.delete(im); im.__svDone = true; }
        else if (!im.__svDone) { w.late.push(0); im.__svDone = true; }
      } else {
        if (st === 0) blank++;
        if (!seen.has(im) && !im.__svDone) seen.set(im, t);
      }
    }
    w.blank.push(blank);
    w.soft.push(soft);
    w.inview.push(n);
    requestAnimationFrame(loop);
  };
  w.start = () => { w.on = true; last = 0; w.t0 = performance.now(); requestAnimationFrame(loop); };
  w.stop = () => {
    w.on = false;
    const imgs = performance.getEntriesByType("resource").filter((e) => /\/img\//.test(e.name) && e.startTime > w.t0);
    return {
      frames: w.frames, blank: w.blank, soft: w.soft, inview: w.inview, late: w.late, never: seen.size,
      img: imgs.map((e) => [Math.round(e.duration), e.transferSize, e.encodedBodySize, e.deliveryType || "", (e.name.match(/[?&]w=(\d+)/) || [])[1] || ""]),
    };
  };
};

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };

(async () => {
  // --live <url>: this PC's own server, signed in as the test profile through
  // the page (its password read from the briefs, never written here). Looking
  // only: Home is opened and scrolled.
  const live = argv("live");
  const inst = live ? { url: live } : JSON.parse(fs.readFileSync(argv("instance"), "utf8"));
  const signIn = async (page) => {
    const rules = fs.readFileSync(argv("rules"), "utf8");
    const pw = (rules.match(/username claudeqa, password ([^)\s]+)\)/) || [])[1];
    await page.goto(`${inst.url}/`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Claude QA" }).first().click();
    await page.getByPlaceholder("Password").fill(pw);
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.waitForSelector(".row .card", { timeout: 30000 });
  };
  const label = argv("label", "scrollview");
  const route = argv("route", "#/");
  const line = argv("line", "4g");
  const cpu = Number(argv("cpu", "1"));
  const runs = Number(argv("runs", "3"));
  const notch = Number(argv("notch", "100"));
  const every = Number(argv("every", "90"));
  const look = argv("look", "glass");
  const device = argv("device", "desktop-1440");
  const dev = DEVICES[device];
  const at = { x: Math.round(dev.width / 2), y: Math.round(dev.height * 0.55) };
  const out = path.join(OUT, label);
  fs.mkdirSync(out, { recursive: true });
  const browser = await launch();
  const all = [];
  for (let r = 0; r < runs; r++) {
    const ctx = await newContext(browser, device);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await page.addInitScript(WATCH);
    // (the page sky painted on the page's own thread, as before 2026-11-10 — see aurora-sky.js)
    if (argv("sky") === "page") await page.addInitScript(() => { delete HTMLCanvasElement.prototype.transferControlToOffscreen; });
    if (live) await signIn(page);
    else await prime(page, inst, { look, extra: Object.fromEntries(argv("extra", "").split(",").filter(Boolean).map((kv) => kv.split("="))) });
    await clearCaches(cdp, inst.url);
    await throttle(cdp, { line, cpu });
    await page.goto(`${inst.url}/${route}`, { waitUntil: "load" });
    if (live) await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".row .card, .grid .card", { timeout: 30000 });
    // (--settle <ms>: how long the person looks at the top before scrolling;
    // 4 s lets the first screen's pictures in and the held ones go)
    await sleep(Number(argv("settle", "4000")));
    if (flag("warm")) {
      // a second visit: everything this page shows is in the HTTP cache
      await page.evaluate(async () => {
        const sc = document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight ? document.scrollingElement : document.body;
        for (let y = 0; y < sc.scrollHeight; y += 600) { sc.scrollTop = y; await new Promise((r) => setTimeout(r, 250)); }
        await new Promise((r) => setTimeout(r, 2500));
      });
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector(".row .card, .grid .card", { timeout: 30000 });
      await sleep(4000);
    }
    if (!dev.mobile) await page.mouse.move(at.x, at.y);
    await page.evaluate((bare) => { window.__sv.bare = bare; window.__sv.start(); }, flag("bare"));
    const height = async () => page.evaluate(() => {
      const sc = document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight ? document.scrollingElement : document.body;
      return { top: Math.round(sc.scrollTop), max: sc.scrollHeight - innerHeight };
    });
    let shot = 0, lastShot = 0, still = 0, prev = -1;
    const t0 = Date.now();
    // --speed <px/s>: one steady wheel gesture at that speed (Chrome's own
    // synthetic gesture — a free-spinning wheel, a flick on a trackpad),
    // instead of notches sent one by one (which top out near 1500 px/s)
    const speed = Number(argv("speed", "0"));
    if (speed) {
      const max = (await height()).max;
      const shots = (async () => {
        while (flag("shots") && r === 0 && shot < 60 && (await height()).top < max - 2) {
          await page.screenshot({ path: path.join(out, `scroll-${String(shot++).padStart(2, "0")}.jpg`), type: "jpeg", quality: 60 }).catch(() => {});
          await sleep(120);
        }
      })();
      await cdp.send("Input.synthesizeScrollGesture", { x: at.x, y: at.y, yDistance: -max, speed, gestureSourceType: dev.mobile ? "touch" : "mouse", repeatCount: 0 });
      await shots;
    }
    for (let i = 0; i < (speed ? 0 : 400); i++) {
      await page.mouse.wheel(0, notch);
      await sleep(every);
      if (flag("shots") && r === 0 && Date.now() - lastShot > 250) {
        lastShot = Date.now();
        await page.screenshot({ path: path.join(out, `scroll-${String(shot++).padStart(2, "0")}.jpg`), type: "jpeg", quality: 60 });
      }
      const h = await height();
      if (h.top >= h.max - 2 || h.top === prev) { if (++still > 3) break; } else still = 0;
      prev = h.top;
      if (Date.now() - t0 > 60000) break;
    }
    await sleep(1500);
    const d = await page.evaluate(() => window.__sv.stop());
    const posterFrames = d.inview.reduce((a, b) => a + b, 0);
    const blankFrames = d.blank.reduce((a, b) => a + b, 0);
    const res = {
      frames: d.frames.length,
      blankFrames,
      softFrames: d.soft.reduce((a, b) => a + b, 0),
      worstSoft: Math.max(0, ...d.soft),
      worstBlank: Math.max(0, ...d.blank),
      blankShare: posterFrames ? Math.round((blankFrames / posterFrames) * 1000) / 10 : 0,
      posters: d.late.length,
      lateP50: Math.round(pct(d.late, 0.5) || 0),
      lateP90: Math.round(pct(d.late, 0.9) || 0),
      lateMax: Math.round(Math.max(0, ...d.late)),
      onTime: d.late.length ? Math.round((d.late.filter((x) => x === 0).length / d.late.length) * 100) : 0,
      never: d.never,
      lateFrames: d.frames.filter((x) => x > 25).length,
      worstFrame: Math.round(Math.max(0, ...d.frames)),
      frameP95: Math.round((pct(d.frames, 0.95) || 0) * 10) / 10,
      frameP99: Math.round((pct(d.frames, 0.99) || 0) * 10) / 10,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      // the pictures asked for while scrolling: how many, how many from the
      // network (a transfer size), and how long each took
      imgs: d.img.length,
      imgsNet: d.img.filter((x) => x[1] > 0).length,
      imgMsP50: Math.round(pct(d.img.map((x) => x[0]), 0.5) || 0),
      imgMsP90: Math.round(pct(d.img.map((x) => x[0]), 0.9) || 0),
      imgKB: Math.round(d.img.reduce((a, x) => a + x[2], 0) / 1024),
    };
    all.push(res);
    console.log(`run ${r + 1}:`, JSON.stringify(res));
    await ctx.close();
  }
  await browser.close();
  const keys = Object.keys(all[0] || {});
  const med = Object.fromEntries(keys.map((k) => [k, median(all.map((x) => x[k]))]));
  console.log(`${label} median:`, JSON.stringify(med));
  writeJson(path.join(out, "scrollview.json"), { label, route, device, line, cpu, notch, every, runs: all, median: med });
})().catch((e) => { console.error(e); process.exit(1); });

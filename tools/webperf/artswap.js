#!/usr/bin/env node
// What a person SEES when a hero's picture is replaced by its sharper one
// (public/js/artUpgrade.js): the frames around the swap, every one the browser
// drew, with the moment the page changed the picture marked.
//
//   node tools/webperf/artswap-instance.js --state <state file>     (the instance: small AND large pictures)
//   node tools/webperf/slowproxy.js --to <its url> --mbit 8 --state <proxy file>   (so the large one takes a while)
//   node tools/webperf/artswap.js --instance <state file> --via <proxy url> --label before-phone-home
//       [--device phone-390|desktop-1440] [--look glass|legacy] [--route home|film|#/...]
//       [--slowstart]   the page starts on the "slow line" tier it remembers, so
//                       the hero is painted small and gets its full picture once
//                       the line has measured well (the desktop path)
//       [--reduced]     prefers-reduced-motion: reduce
//       [--lite]        <html data-fx="lite"> (the light graphics tier)
//       [--turn]        the billboard is turned to its next slide 120 ms into the swap
//       [--stay]        the billboard does not turn by itself (the focus is put
//                       on its first button, without an input event): a wide
//                       screen's slide gets its full picture only after a few
//                       seconds, and would have turned by then
//       [--cast]        the screencast (every frame, the whole view, CSS pixels)
//                       instead of photographs of a piece (device pixels, ~40 ms)
//       [--part x,y,w,h] the piece photographed (CSS px)
//       [--layers]      no pictures taken: the compositor's layers counted
//                       instead - at rest before the swap, the most during it,
//                       at rest after (they must be equal before and after)
//       [--gpu]         the machine's graphics card draws (Windows), not the
//                       software stand-in a headless browser uses: a fade over a
//                       wide hero is what a real screen would show
//       [--wait 40000]  how long to wait for a swap
//
// Writes out/artswap/<label>/: frames/*.jpg (named by their time from the
// swap in ms) and manifest.json (events: every change of the
// hero's picture, the fade layer coming and going). artswap-strip.py makes the
// strip and the numbers out of that.
"use strict";
const fs = require("fs");
const path = require("path");
const { OUT, argv, flag, launch, newContext, prime, clearCaches, sleep, writeJson } = require("./lib");

const WATCH = () => {
  const w = (window.__as = { ev: [] });
  const now = () => performance.timeOrigin + performance.now();
  const SEL = ".hero-backdrop.fade, .detail-hero";
  const last = new WeakMap();
  const note = (n) => {
    if (!n.matches || !n.matches(SEL)) return;
    const cur = { art: n.style.getPropertyValue("--hero-art"), poster: n.style.getPropertyValue("--hero-poster") };
    const was = last.get(n) || { art: "", poster: "" };
    for (const k of ["art", "poster"]) {
      if (cur[k] === was[k]) continue;
      const shown = n.classList.contains("on") || n.matches(".detail-hero");
      // (the same picture at another size — not the billboard's next slide)
      const one = (u) => String(u).replace(/(%2F|\/)(small|medium|large)(%2F|\/)/g, "/~/").replace(/([&?])(w|dpr)=[\d.]+/g, "");
      const e = { t: now(), k, from: was[k], to: cur[k], shown, up: !!(was[k] && cur[k] && shown && one(was[k]) === one(cur[k])) };
      w.ev.push(e);
      if (e.up && window.__asUp) window.__asUp(e.t, k);
    }
    last.set(n, cur);
  };
  const layer = (n, k) => {
    if (n.nodeType !== 1) return;
    const l = n.classList.contains("art-up") ? [n] : n.querySelectorAll ? [...n.querySelectorAll(".art-up")] : [];
    for (const _ of l) {
      const e = { t: now(), k };
      w.ev.push(e);
      if (k === "layer+" && window.__asUp) window.__asUp(e.t, "layer");
    }
  };
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "attributes") { note(m.target); continue; }
      for (const a of m.addedNodes) {
        if (a.nodeType !== 1) continue;
        layer(a, "layer+");
        note(a);
        if (a.querySelectorAll) a.querySelectorAll(SEL).forEach(note);
      }
      for (const r of m.removedNodes) layer(r, "layer-");
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
};

const LITE = () => {
  const keep = () => { if (document.documentElement && document.documentElement.dataset.fx !== "lite") document.documentElement.dataset.fx = "lite"; };
  new MutationObserver(keep).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-fx"] });
};

(async () => {
  const inst = JSON.parse(fs.readFileSync(path.resolve(argv("instance")), "utf8"));
  if (argv("via")) inst.url = argv("via").replace(/\/$/, "");
  const label = argv("label", "artswap");
  const device = argv("device", "phone-390");
  const look = argv("look", "glass");
  const route = inst.routes[argv("route", "home")] || argv("route", "#/");
  const maxWait = Number(argv("wait", "40000"));
  const dir = path.join(OUT, "artswap", label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "frames"), { recursive: true });

  const browser = await launch({ extraArgs: flag("gpu") ? ["--enable-gpu", "--use-angle=d3d11", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"] : [] });
  const ctx = await newContext(browser, device);
  const page = await ctx.newPage();
  if (flag("reduced")) await page.emulateMedia({ reducedMotion: "reduce" });
  const cdp = await ctx.newCDPSession(page);
  await clearCaches(cdp, new URL(inst.url).origin);

  let swapAt = null;
  const ups = [];
  await page.exposeFunction("__asUp", (t, k) => { ups.push({ t, k }); if (swapAt == null) swapAt = t; });
  await page.addInitScript(WATCH);
  if (flag("lite")) await page.addInitScript(LITE);
  await prime(page, inst, { look, extra: flag("slowstart") ? { "aurora-net-last": JSON.stringify({ tier: "slow", at: Date.now() }) } : {} });

  // Two ways of looking, one per run (each disturbs the other):
  //   default   photographs of a piece of the picture in the device's own
  //             pixels, as fast as the browser gives them (~every 40 ms): soft
  //             or sharp (the whole view at 3x takes ~150 ms a photograph)
  //   --cast    the screencast: EVERY frame the browser drew, in CSS pixels:
  //             a single dark or empty frame cannot hide between two photographs
  // Before a swap only the last 1.5 s is kept.
  const frames = [];
  const keep = (t, data) => {
    frames.push({ t, data });
    if (swapAt == null) { const cut = t - 1500; while (frames.length > 2 && frames[1].t < cut) frames.shift(); }
  };
  const cast = flag("cast");
  const counting = flag("layers");
  const trees = []; // { t, n }
  let on = true;
  let loop = null;
  if (cast) {
    cdp.on("Page.screencastFrame", (f) => {
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      keep(f.metadata.timestamp * 1000, f.data);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
  }
  await page.goto(`${inst.url}/${route}`, { waitUntil: "domcontentloaded" });
  // the piece: --part x,y,w,h (CSS px), or the upper middle of the hero (no
  // title, no buttons)
  let part = argv("part") ? (([x, y, width, height]) => ({ x, y, width, height }))(argv("part").split(",").map(Number)) : null;
  if (!cast && !counting && !part) {
    await page.waitForSelector(".detail-head, .hero, .detail-hero", { timeout: maxWait });
    part = await page.evaluate(() => {
      const head = document.querySelector(".detail-head");
      const h = head && getComputedStyle(head).display !== "contents" ? head : document.querySelector(".hero, .detail-hero");
      const b = h.getBoundingClientRect();
      const x0 = Math.max(0, b.left), x1 = Math.min(innerWidth, b.right), y0 = Math.max(0, b.top), y1 = Math.min(innerHeight, b.bottom);
      const w = Math.min(240, (x1 - x0) * 0.6), hh = Math.min(170, (y1 - y0) * 0.34);
      return { x: Math.round(x0 + (x1 - x0 - w) / 2), y: Math.round(y0 + (y1 - y0) * 0.08), width: Math.round(w), height: Math.round(hh) };
    });
  }
  if (!cast && !counting) loop = (async () => {
    while (on) {
      const a = Date.now();
      try {
        const r = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...part, scale: 1 }, optimizeForSpeed: true });
        keep((a + Date.now()) / 2, r.data);
      } catch { await sleep(30); }
    }
  })();
  // (the tree is asked for again and again: about every 60 ms)
  if (counting) loop = (async () => {
    while (on) {
      try {
        await cdp.send("LayerTree.enable");
        const got = await new Promise((resolve) => { cdp.once("LayerTree.layerTreeDidChange", (e) => resolve(e.layers || null)); setTimeout(() => resolve(null), 800); });
        if (got) trees.push({ t: Date.now(), n: got.length });
        await cdp.send("LayerTree.disable");
      } catch {}
      await sleep(40);
    }
  })();
  if (flag("stay")) {
    await page.waitForSelector(".hero .hero-info button, .hero .hero-info a", { timeout: maxWait }).catch(() => {});
    await page.evaluate(() => { const b = document.querySelector(".hero .hero-info button, .hero .hero-info a"); if (b) b.focus({ preventScroll: true }); });
  }
  const t0 = Date.now();
  while (swapAt == null && Date.now() - t0 < maxWait) await sleep(20);
  if (swapAt != null && flag("turn")) {
    await sleep(120);
    await page.evaluate(() => { const d = document.querySelectorAll(".hero-dots button, .hero-dots .dot"); if (d[1]) d[1].click(); });
  }
  await sleep(swapAt != null ? 1600 : 0);
  on = false;
  if (loop) await loop;
  if (cast) await cdp.send("Page.stopScreencast").catch(() => {});
  const info = await page.evaluate(() => {
    const box = (sel) => { const h = document.querySelector(sel); if (!h) return null; const b = h.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    return {
      ev: window.__as.ev,
      net: document.documentElement.dataset.net,
      fx: document.documentElement.dataset.fx || null,
      layers: document.querySelectorAll(".art-up").length,
      hero: box(".hero, .detail-hero"),
      head: box(".detail-head"),
      view: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    };
  });
  await browser.close();

  const out = [];
  if (swapAt != null) {
    for (const f of frames) {
      const off = Math.round(f.t - swapAt);
      if (off < -1500 || off > 1600) continue;
      const file = `f${off < 0 ? "m" : "p"}${String(Math.abs(off)).padStart(4, "0")}.${cast ? "jpg" : "png"}`;
      fs.writeFileSync(path.join(dir, "frames", file), Buffer.from(f.data, "base64"));
      out.push({ off, file });
    }
  }
  const before = trees.filter((x) => swapAt != null && x.t < swapAt - 30);
  const during = trees.filter((x) => swapAt != null && x.t >= swapAt - 30 && x.t < swapAt + 1100);
  const layerCount = counting && swapAt != null ? {
    before: before.length ? before[before.length - 1].n : null,
    most: Math.max(...during.map((x) => x.n), before.length ? before[before.length - 1].n : 0),
    after: trees.length ? trees[trees.length - 1].n : null,
    trail: during.map((x) => [Math.round(x.t - swapAt), x.n]),
  } : null;
  const short = (s) => (s || "").replace(/^url\("?/, "").replace(/"?\)$/, "").slice(-70);
  const events = info.ev.map((e) => ({ at: swapAt != null ? Math.round(e.t - swapAt) : Math.round(e.t), k: e.k, up: e.up, shown: e.shown, from: short(e.from), to: short(e.to) }));
  const { ev, ...rest } = info;
  writeJson(path.join(dir, "manifest.json"), { label, device, look, route, swapAt, ups: ups.map((u) => ({ at: Math.round(u.t - (swapAt || 0)), k: u.k })), events, mode: cast ? "cast" : counting ? "layers" : "shots", layerCount, part, frames: out, ...rest });
  console.log(JSON.stringify({ label, swap: swapAt != null, frames: out.length, net: info.net, fadeLayersLeft: info.layers, layerCount, events: swapAt != null ? events.filter((e) => e.at > -3000) : events.slice(-6) }, null, 1));
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

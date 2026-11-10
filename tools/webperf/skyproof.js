#!/usr/bin/env node
// Is the sky the same picture, wherever it is painted? (2026-11-10: the glass
// look's page sky moved to a worker on a computer — aurora-sky.js — and that
// move must not change a pixel.)
//
// One seed, the same moments, per window size:
//   old     the painter as it was before the move (git show <--old>:public/js/aurora-sky.js)
//   page    today's painter on the page's own thread
//   worker  today's painter through aurora-sky-worker.js, as the app runs it
//   core    today's painter in a bare worker on a canvas of its own (its
//           pixels can be read back; the app's worker canvas can only be seen)
// each moving (two paints, at 11.5 s and 12.0 s — a shooting star is in
// flight) and still (the reduced-motion frame). Compared: the canvases'
// own pixels (old = page = core) and what the screen shows (old = page = worker).
//
//   node tools/webperf/skyproof.js --instance <state file> [--label skyproof]
//       [--old d38464d0] [--sizes 1440x900,1920x1080,2560x1440] [--phone 390x844]
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { OUT, argv, launch, writeJson } = require("./lib");

const SEED = 20261110;
const FRAMES = [11.5, 12.0];
const PACE = 0.95;

const HARNESS = `<!doctype html><meta charset="utf-8"><title>sky proof</title>
<style>html,body{margin:0;height:100%;background:#05060d}canvas{position:fixed;left:0;top:0;width:100%;height:100lvh;display:block}</style>
<canvas id="sky"></canvas>`;

// in the page: one variant painted; -> the canvas's own pixels as a PNG data URL (or null: not readable)
const PAINT = async ({ variant, still, seed, frames, pace }) => {
  const canvas = document.getElementById("sky");
  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))));
  if (variant === "old") {
    let a = seed;
    Math.random = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // the old loop, driven by hand: its frame callback is called at the two moments
    const raf = window.requestAnimationFrame.bind(window);
    let loop = null;
    window.requestAnimationFrame = (fn) => { loop = fn; return 1; };
    window.setTimeout = () => 0;
    const m = await import("/js/__sky-before.js");
    m.initAuroraSky(canvas, { pace });
    if (!still) for (const t of frames) loop(t * 1000);
    window.requestAnimationFrame = raf;
    await new Promise((r) => raf(() => raf(r)));
    return canvas.toDataURL("image/png");
  }
  if (variant === "page") {
    const m = await import("/js/aurora-sky.js");
    m.initAuroraSky(canvas, still ? { pace, seed } : { pace, seed, frames });
    await settle();
    return canvas.toDataURL("image/png");
  }
  if (variant === "worker") {
    window.__auroraSkyWatch = true;
    const painted = new Promise((res, rej) => {
      window.addEventListener("aurora-sky-paint", res, { once: true });
      setTimeout(() => rej(new Error("the worker never painted")), 8000);
    });
    const m = await import("/js/aurora-sky.js");
    m.initAuroraSky(canvas, still ? { pace, seed, offMain: true } : { pace, seed, frames, offMain: true });
    await painted;
    await settle();
    let handed = false;
    try { canvas.getContext("2d"); } catch { handed = true; }
    if (!handed) throw new Error("the canvas was not handed to a worker");
    return null;
  }
  // "core": the painter alone, in a worker, on a canvas whose pixels come back
  const src = `self.onmessage = async ({ data }) => {
    const core = await import(data.core);
    const c = new OffscreenCanvas(300, 150);
    const sky = core.makeSky(c, { mobile: false, pace: data.pace, stars: true, seed: data.seed, makeCanvas: (w, h) => new OffscreenCanvas(w, h) });
    sky.size(...data.size);
    if (data.still) sky.paint(6, true); else for (const t of data.frames) sky.paint(t);
    const b = await c.convertToBlob({ type: "image/png" });
    self.postMessage(await b.arrayBuffer());
  };`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" });
  const buf = await new Promise((res, rej) => {
    w.onmessage = (e) => res(e.data);
    w.onerror = (e) => rej(new Error(e.message || "worker error"));
    w.postMessage({ core: new URL("/js/aurora-sky-core.js", location.href).href, pace, seed, frames, still, size: [canvas.clientWidth, canvas.clientHeight, devicePixelRatio || 1] });
  });
  w.terminate();
  let s = "";
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(s);
};

// in the page: two PNGs (data URLs), pixel by pixel
const DIFF = async ([a, b]) => {
  const px = async (url) => {
    const bmp = await createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return g.getImageData(0, 0, bmp.width, bmp.height);
  };
  const A = await px(a), B = await px(b);
  if (A.width !== B.width || A.height !== B.height) return { size: `${A.width}x${A.height} vs ${B.width}x${B.height}`, same: false };
  let differing = 0, max = 0, lit = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]), Math.abs(A.data[i + 3] - B.data[i + 3]));
    if (d) { differing++; if (d > max) max = d; }
    if (A.data[i] + A.data[i + 1] + A.data[i + 2] > 60) lit++;
  }
  // (`lit`: pixels that are not near-black — a blank canvas would also be "the same")
  return { size: `${A.width}x${A.height}`, pixels: A.width * A.height, lit, differing, max, same: differing === 0 };
};

(async () => {
  const inst = JSON.parse(fs.readFileSync(argv("instance"), "utf8"));
  const label = argv("label", "skyproof");
  const old = argv("old", "d38464d0");
  const before = execFileSync("git", ["show", `${old}:public/js/aurora-sky.js`], { cwd: path.join(__dirname, "..", ".."), encoding: "utf8", maxBuffer: 1 << 24 });
  const dir = path.join(OUT, label);
  fs.mkdirSync(dir, { recursive: true });
  const desks = argv("sizes", "1440x900,1920x1080,2560x1440").split(",").map((s) => ({ name: s, phone: false, size: s.split("x").map(Number) }));
  const phone = argv("phone", "390x844");
  const cases = [...desks, ...(phone === "none" ? [] : [{ name: `phone-${phone}`, phone: true, size: phone.split("x").map(Number) }])];
  const browser = await launch();
  const out = [];
  let ok = true;
  for (const c of cases) {
    const [width, height] = c.size;
    const ctx = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: c.phone ? 3 : 1,
      isMobile: c.phone,
      hasTouch: c.phone,
      serviceWorkers: "block",
    });
    await ctx.route(`${inst.url}/__skyproof`, (r) => r.fulfill({ contentType: "text/html", body: HARNESS }));
    await ctx.route(`${inst.url}/js/__sky-before.js`, (r) => r.fulfill({ contentType: "text/javascript", body: before }));
    for (const still of [false, true]) {
      const got = {};
      // (a phone's sky never goes to a worker: old against page only)
      for (const variant of c.phone ? ["old", "page"] : ["old", "page", "worker", "core"]) {
        const page = await ctx.newPage();
        await page.emulateMedia({ reducedMotion: still ? "reduce" : "no-preference" });
        await page.goto(`${inst.url}/__skyproof`);
        const own = await page.evaluate(PAINT, { variant, still, seed: SEED, frames: FRAMES, pace: PACE });
        const shot = variant === "core" ? null : await page.screenshot({ type: "png" });
        if (shot) fs.writeFileSync(path.join(dir, `${c.name}-${still ? "still" : "moving"}-${variant}.png`), shot);
        got[variant] = { own, shot: shot && "data:image/png;base64," + shot.toString("base64") };
        await page.close();
      }
      const page = await ctx.newPage();
      await page.goto(`${inst.url}/__skyproof`);
      const cmp = (a, b) => page.evaluate(DIFF, [a, b]);
      const row = { size: c.name, frame: still ? "still" : "moving" };
      row["canvas: old = page"] = await cmp(got.old.own, got.page.own);
      row["screen: old = page"] = await cmp(got.old.shot, got.page.shot);
      if (!c.phone) {
        row["canvas: page = core in a worker"] = await cmp(got.page.own, got.core.own);
        row["screen: page = worker"] = await cmp(got.page.shot, got.worker.shot);
        row["screen: old = worker"] = await cmp(got.old.shot, got.worker.shot);
      }
      await page.close();
      for (const [k, v] of Object.entries(row)) {
        if (typeof v !== "object") continue;
        if (!v.same) ok = false;
        console.log(`${c.name} ${row.frame}  ${k}: ${v.same ? "identical" : `DIFFERENT (${v.differing} px, max ${v.max})`}  [${v.size}, ${v.lit} lit]`);
      }
      out.push(row);
    }
    await ctx.close();
  }
  await browser.close();
  writeJson(path.join(dir, "skyproof.json"), { seed: SEED, frames: FRAMES, old, rows: out, identical: ok });
  console.log(ok ? "identical everywhere" : "NOT identical");
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// Mobile correctness, checked rather than assumed — per route, on a phone:
//
//   node tools/mobile-perf/correctness.js --label baseline [--looks glass,legacy]
//
//   sideways scroll     the page is wider than the screen (portrait, and
//                       again after turning the phone to landscape and back)
//   tap targets         links and buttons smaller than 44×44 CSS px (the
//                       iOS guideline; Android's is 48) — how many, which
//   under the chrome    tappable things hidden behind the fixed nav / tab bar
//   viewport units      elements sized with 100vh that end up taller than the
//                       visible screen when the browser's bars are showing
//                       (emulated: a 100 px shorter visual viewport)
//   reduced motion      with "reduce motion" on: animations still running
//   zoom                pinch-zoom is allowed (no user-scalable=no / maximum-scale)
//   text scale          the page at 130% root font size: sideways scroll,
//                       clipped text (an approximation of Android's font-size
//                       setting, which Chrome applies as text autosizing)
//
// Writes out/<label>/correctness/<look>.json
"use strict";
const path = require("path");
const { argv, list, open, emulate, prime, sleep, outDir, writeJson, DEVICES } = require("./lib");

const inspect = () => {
  const vw = innerWidth, vh = innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.05 || cs.pointerEvents === "none") return null;
    return r;
  };
  const name = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className).split(/\s+/).filter(Boolean).slice(0, 2).join(".")} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}"`;
  const tappable = [...document.querySelectorAll("a[href], button, [role=button], input, select, textarea, [tabindex]:not([tabindex='-1'])")];
  const small = [];
  let shown = 0;
  for (const el of tappable) {
    const r = visible(el);
    if (!r) continue;
    shown++;
    if (r.width < 44 || r.height < 44) small.push({ el: name(el), w: Math.round(r.width), h: Math.round(r.height) });
  }
  // what the widest element is, when the page scrolls sideways
  const doc = document.documentElement;
  const overflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - vw;
  let widest = null;
  if (overflow > 1) {
    for (const el of document.querySelectorAll("#app *, #nav, #nav *")) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0 && !el.closest(".row-scroller, .nav-items, .hero-picks, [style*='overflow']")) { widest = `${name(el)} right=${Math.round(r.right)}`; break; }
    }
  }
  // tappable things whose centre is covered by fixed chrome
  const covered = [];
  for (const el of tappable) {
    const r = visible(el);
    if (!r || el.closest("#nav")) continue;
    const top = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), Math.min(vh - 1, Math.max(0, r.top + r.height / 2)));
    if (top && top.closest("#nav") && !el.closest("#nav")) covered.push(name(el));
  }
  return {
    overflowX: Math.max(0, Math.round(overflow)), widest,
    tappable: shown, smallTargets: small.length, smallest: small.sort((a, b) => a.w * a.h - b.w * b.h).slice(0, 8),
    coveredByNav: covered.length, coveredSample: covered.slice(0, 4),
    animations: document.getAnimations ? document.getAnimations().filter((a) => a.playState === "running").length : null,
    clippedText: [...document.querySelectorAll("#app h1, #app h2, #app .btn, #app .card-label, #nav .nav-item")].filter((el) => { const r = visible(el); return r && (el.scrollWidth > el.clientWidth + 2) && getComputedStyle(el).textOverflow !== "ellipsis" && getComputedStyle(el).overflow !== "visible"; }).length,
  };
};

const main = async () => {
  const label = argv("label", "run");
  const looks = list("looks", "glass,legacy");
  const routes = list("routes", "picker,home,movies,search,list,film,show,libfilm,settings,downloads");
  const device = "phone-390";
  const dir = outDir(label, "correctness");
  const ctx = await open();
  try {
    for (const look of looks) {
      const out = {};
      const page = await ctx.browser.newPage();
      const cdp = await page.createCDPSession();
      await emulate(page, device);
      const d = DEVICES[device];
      for (const route of routes) {
        await prime(page, ctx.inst, { look, profile: route !== "picker" });
        await cdp.send("Emulation.setEmulatedMedia", { features: [] });
        await page.goto(`${ctx.origin}/${route === "picker" ? "" : ctx.inst.routes[route]}`, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
        await sleep(1500);
        const r = { portrait: await page.evaluate(inspect) };
        // the phone turned on its side, and back
        await page.setViewport({ width: d.height, height: d.width, deviceScaleFactor: d.dpr, isMobile: true, hasTouch: true });
        await sleep(900);
        r.landscape = await page.evaluate(inspect);
        await page.setViewport({ width: d.width, height: d.height, deviceScaleFactor: d.dpr, isMobile: true, hasTouch: true });
        await sleep(900);
        const back = await page.evaluate(inspect);
        r.afterRotation = { overflowX: back.overflowX, sameAsBefore: back.overflowX === r.portrait.overflowX && back.tappable === r.portrait.tappable };
        // the browser's bars showing: 100 px less to see
        await page.setViewport({ width: d.width, height: d.height - 100, deviceScaleFactor: d.dpr, isMobile: true, hasTouch: true });
        await sleep(600);
        r.shortViewport = await page.evaluate(() => ({ overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth), navBottom: (() => { const n = document.querySelector(".nav-items"); if (!n) return null; const b = n.getBoundingClientRect(); return { bottom: Math.round(b.bottom), viewport: innerHeight, visible: b.bottom <= innerHeight + 1 && b.top >= 0 }; })() }));
        await page.setViewport({ width: d.width, height: d.height, deviceScaleFactor: d.dpr, isMobile: true, hasTouch: true });
        // larger text
        await page.evaluate(() => { document.documentElement.style.fontSize = "130%"; });
        await sleep(700);
        const big = await page.evaluate(inspect);
        r.largerText = { overflowX: big.overflowX, widest: big.widest, clippedText: big.clippedText };
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        // reduce motion
        await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        await page.reload({ waitUntil: "networkidle2" }).catch(() => {});
        await sleep(2500);
        r.reducedMotion = await page.evaluate(() => ({ running: document.getAnimations().filter((a) => a.playState === "running").map((a) => `${a.animationName || a.transitionProperty || "?"} on ${a.effect && a.effect.target ? a.effect.target.className : "?"}`.slice(0, 70)).slice(0, 8) }));
        r.zoomAllowed = await page.evaluate(() => { const m = document.querySelector('meta[name=viewport]'); return !/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(m ? m.content : ""); });
        out[route] = r;
        process.stdout.write(`  ${look} ${route}: sideways ${r.portrait.overflowX}px (landscape ${r.landscape.overflowX}px, larger text ${r.largerText.overflowX}px) · small targets ${r.portrait.smallTargets}/${r.portrait.tappable} · behind nav ${r.portrait.coveredByNav} · moving with reduce-motion ${r.reducedMotion.running.length}\n`);
      }
      await page.close();
      writeJson(path.join(dir, `${look}.json`), out);
    }
  } finally {
    await ctx.close();
  }
};

main().catch((e) => { console.error(e.stack || e); process.exit(1); });

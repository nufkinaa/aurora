#!/usr/bin/env node
// Pixel proof for one CSS line: a poster that has finished sharpening in
// (glass.css `blurup-in`) looks the same whether the finished animation still
// holds `filter: blur(0)` on it (`… both`, as it was) or not.
//
//   node tools/webperf/fillproof.js --instance <state file of a build that still has `both`>
//       [--devices desktop-1440,phone-390] [--label fillproof]
//       [--with "isolation: isolate;"]  (what the rule gets in the animation's place)
//
// The instance should be far away (slowproxy.js in front of it), so that the
// posters arrive late enough to sharpen at all. Per device and screen, on ONE
// page: wait until every poster in view has sharpened, photograph it twice
// (the noise floor), take the animation off the posters, photograph it again.
// Nothing else changes between the shots. Then:
//   python tools/mobile-perf/diff.py out/<label>/a,out/<label>/a2 out/<label>/b
"use strict";
const path = require("path");
const fs = require("fs");
const { OUT, argv, list, launch, newContext, prime, clearCaches, sleep } = require("./lib");

const STILL = () => {
  // the billboard's 9-second rotation is not started (as tools/mobile-perf/shots.js)
  const real = window.setInterval;
  window.setInterval = (fn, ms, ...rest) => (ms === 9000 ? 0 : real(fn, ms, ...rest));
};
const SCREENS = [["home-half", "#/", 0.6], ["home-down1", "#/", 1], ["home-down3", "#/", 3], ["movies", "#/movies", 0], ["shows-down1", "#/shows", 1]];

(async () => {
  const inst = JSON.parse(fs.readFileSync(argv("instance"), "utf8"));
  const label = argv("label", "fillproof");
  const out = path.join(OUT, label);
  for (const d of ["a", "a2", "b"]) fs.mkdirSync(path.join(out, d), { recursive: true });
  const browser = await launch();
  const table = [];
  for (const device of list("devices", "desktop-1440,phone-390")) {
    for (const [name, route, screens] of SCREENS) {
      const ctx = await newContext(browser, device);
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await page.addInitScript(STILL);
      await prime(page, inst, { look: "glass" });
      await clearCaches(cdp, inst.url);
      await page.goto(`${inst.url}/${route}`, { waitUntil: "load" });
      await page.waitForSelector(".row .card, .grid .card", { timeout: 30000 });
      // the living skies are taken off the page for all three shots
      // …and the four things that never stop moving are stopped (the page's
      // washes of light, the dot on New, the shine on the greeting)
      await page.addStyleTag({ content: "#glass-sky, #nav-aurora { visibility: hidden !important; } html::before, html::after, .nav-new-dot, .greet-name { animation: none !important; }" });
      await sleep(2500);
      if (screens) {
        await page.evaluate((n) => {
          const sc = document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight ? document.scrollingElement : document.body;
          sc.scrollTop = innerHeight * n;
        }, screens);
      }
      // every poster in view is in, and nothing on it is still moving
      await page.waitForFunction(() => {
        const seen = [...document.querySelectorAll(".card img, .grid img")].filter((im) => {
          const b = im.getBoundingClientRect();
          return b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
        });
        // (a poster with neither class was there at once: it never sharpens)
        const plain = (im) => !im.classList.contains("img-fade") && !im.classList.contains("img-blurup");
        return seen.length > 0 && seen.every((im) => im.complete && im.naturalWidth > 0 && (im.classList.contains("img-in") || plain(im)) &&
          !im.getAnimations().some((a) => a.playState === "running"));
      }, null, { timeout: 30000 }).catch(async (e) => {
        console.error(await page.evaluate(() => [...document.querySelectorAll(".card img, .grid img")].filter((im) => {
          const b = im.getBoundingClientRect();
          return b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
        }).map((im) => [im.className, im.complete, im.naturalWidth, im.loading, !!im.style.backgroundImage, im.getAnimations().map((a) => a.playState).join()].join(" | "))));
        throw e;
      });
      await sleep(1200);
      const count = () => page.evaluate(() => {
        const seen = [...document.querySelectorAll(".card img, .grid img")].filter((im) => {
          const b = im.getBoundingClientRect();
          return b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
        });
        return { seen: seen.length, held: seen.filter((im) => /blur/.test(getComputedStyle(im).filter)).length };
      });
      const before = await count();
      const file = `${device}.${name}.png`;
      await page.screenshot({ path: path.join(out, "a", file) });
      await sleep(300);
      await page.screenshot({ path: path.join(out, "a2", file) });
      await page.addStyleTag({ content: `.img-blurup.img-in:not(.img-now) { animation: none !important; ${argv("with", "")} }` });
      await sleep(400);
      const after = await count();
      await page.screenshot({ path: path.join(out, "b", file) });
      table.push({ shot: file, postersInView: before.seen, holdingFilterBefore: before.held, holdingFilterAfter: after.held });
      console.log(JSON.stringify(table[table.length - 1]));
      await ctx.close();
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(out, "fillproof.json"), JSON.stringify(table, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// Pixel proof for a change to how posters ARRIVE (when they are asked for,
// whether they sharpen in): once they have all arrived, the page is the same
// page. tools/mobile-perf/shots.js cannot say — it holds every picture to a
// plain end state before it photographs.
//
//   node tools/webperf/endproof.js --instance <state file> --label <name>
//       [--devices desktop-1440,phone-390] [--looks glass]
//   …once per build, each behind a slowproxy.js with a long round trip
//   (--rtt 200: every picture is then "late" in both builds, so which poster
//   sharpened is not left to chance), then
//   python tools/mobile-perf/diff.py out/<label A> out/<label B>
//   Run each build TWICE and throw a freshly started instance's first run
//   away: a server makes a picture's sizes the first time each is asked for
//   and answers with another encoding meanwhile, so that run differs from
//   every later one in every poster (max ~30-85 of 255) — the server's doing,
//   not the page's. Two runs of the same build are also the noise floor (it is
//   not zero here: a chip that depends on a timer, a poster's encoding).
//
// Per device: Home, Movies and Shows opened cold, left alone for a while (a
// build that fetches ahead does so), wheeled to the bottom a screen at a time
// so every poster has come into view, then photographed at fixed places once
// nothing is arriving or moving. The living skies and the four things that
// never stop moving are taken off the page (as fillproof.js).
"use strict";
const path = require("path");
const fs = require("fs");
const { OUT, argv, list, launch, newContext, prime, clearCaches, sleep } = require("./lib");

const STILL = () => {
  const real = window.setInterval;
  window.setInterval = (fn, ms, ...rest) => (ms === 9000 ? 0 : real(fn, ms, ...rest));
};
const PAGES = [["home", "#/", [0.6, 1.5, 3, 5]], ["movies", "#/movies", [0, 1.5]], ["shows", "#/shows", [0, 2]]];

(async () => {
  const inst = JSON.parse(fs.readFileSync(argv("instance"), "utf8"));
  const out = path.join(OUT, argv("label", "endproof"));
  fs.mkdirSync(out, { recursive: true });
  const browser = await launch();
  for (const device of list("devices", "desktop-1440,phone-390")) {
    for (const look of list("looks", "glass")) {
      for (const [name, route, places] of PAGES) {
        const ctx = await newContext(browser, device);
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await page.addInitScript(STILL);
        await prime(page, inst, { look });
        await clearCaches(cdp, inst.url);
        await page.goto(`${inst.url}/${route}`, { waitUntil: "load" });
        await page.waitForSelector(".row .card, .grid .card", { timeout: 30000 });
        await page.addStyleTag({ content: "#glass-sky, #nav-aurora { visibility: hidden !important; } html::before, html::after, .nav-new-dot, .greet-name { animation: none !important; }" });
        await sleep(5000);
        const to = (n) => page.evaluate((n) => {
          const sc = document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight ? document.scrollingElement : document.body;
          sc.scrollTop = Math.round(innerHeight * n);
          return sc.scrollTop >= sc.scrollHeight - innerHeight - 2;
        }, n);
        const settled = () => page.waitForFunction(() => {
          const seen = [...document.querySelectorAll(".card img, .grid img")].filter((im) => {
            const b = im.getBoundingClientRect();
            return b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
          });
          const plain = (im) => !im.classList.contains("img-fade") && !im.classList.contains("img-blurup");
          return seen.every((im) => im.complete && im.naturalWidth > 0 && (im.classList.contains("img-in") || plain(im)) && !im.style.backgroundImage &&
            !im.getAnimations().some((a) => a.playState === "running"));
        }, null, { timeout: 30000 });
        // every poster comes into view once
        for (let n = 0; n < 40; n += 0.8) {
          const end = await to(n);
          await sleep(350);
          await settled();
          if (end) break;
        }
        for (const n of places) {
          await to(n);
          await sleep(600);
          await settled();
          await sleep(900);
          const file = `${device}.${look}.${name}-${String(n).replace(".", "_")}.png`;
          await page.screenshot({ path: path.join(out, file) });
          const st = await page.evaluate(() => {
            const seen = [...document.querySelectorAll(".card img, .grid img")].filter((im) => {
              const b = im.getBoundingClientRect();
              return b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
            });
            return { seen: seen.length, sharpened: seen.filter((im) => im.classList.contains("img-blurup") && im.classList.contains("img-in") && !im.classList.contains("img-now")).length, late: seen.filter((im) => im.classList.contains("img-late")).length, filter: seen.filter((im) => getComputedStyle(im).filter !== "none").length };
          });
          console.log(file, JSON.stringify(st));
        }
        await ctx.close();
      }
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

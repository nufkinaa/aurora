#!/usr/bin/env node
// Screenshots of the /install page itself, at the sizes it has to work at —
// on a private, throwaway instance (scripts/ui-test-server.js) with the
// published TV build copied in, so the TV card shows a real version.
//
//   node tools/install-page/page-shots.js [--out docs/qa/install-page] [--sizes desktop,phone,…] [--full]
//
// Writes <out>/<size>[-<look/theme>].png (the first screen) and, with --full,
// <out>/<size>-full.jpg (the whole page).
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const REPO = path.join(__dirname, "..", "..");
const server = require(path.join(REPO, "scripts", "ui-test-server.js"));
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg("out", path.join(REPO, "docs", "qa", "install-page")));
const UA_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  wide: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA_PHONE },
  "phone-360": { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA_ANDROID },
  "phone-430": { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA_PHONE },
};
const VARIANTS = { "": {}, legacy: { look: "legacy" }, oled: { theme: "oled" }, warm: { theme: "warm" } };

(async () => {
  const sizes = (arg("sizes", "desktop,phone")).split(",");
  const variants = (arg("variants", "")).split(",");
  const srv = await server.start({});
  const apk = path.join(REPO, "public", "aurora-tv.apk");
  if (fs.existsSync(apk)) fs.copyFileSync(apk, path.join(srv.root, "public", "aurora-tv.apk"));
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--force-color-profile=srgb"] });
  fs.mkdirSync(OUT, { recursive: true });
  try {
    for (const size of sizes) {
      for (const v of variants) {
        const context = await browser.newContext({ ...SIZES[size], serviceWorkers: "block" });
        await context.addInitScript((v) => {
          try {
            if (v.look) localStorage.setItem("aurora-look", v.look);
            if (v.theme) localStorage.setItem("aurora-theme", v.theme);
          } catch {}
        }, VARIANTS[v]);
        const page = await context.newPage();
        page.on("pageerror", (e) => console.log("pageerror", size, String(e)));
        page.on("console", (m) => { if (m.type() === "error") console.log("console.error", size, m.text()); });
        await page.goto(`${srv.url}/install`, { waitUntil: "networkidle" });
        await page.waitForTimeout(3200); // (the sky fades in once the page is idle)
        const name = `${size}${v ? `-${v}` : ""}`;
        await page.screenshot({ path: path.join(OUT, `${name}.png`) });
        if (process.argv.includes("--full")) {
          // every lazy picture in, then the whole page
          await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight; y += innerHeight * 0.8) { scrollTo({ top: y, behavior: "instant" }); await new Promise((r) => setTimeout(r, 250)); }
            scrollTo({ top: 0, behavior: "instant" }); // (the page scrolls smoothly otherwise)
          });
          await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20000 })
            .catch(() => console.log("not every picture loaded:", size));
          await page.waitForTimeout(600);
          await page.screenshot({ path: path.join(OUT, `${name}-full.jpg`), fullPage: true, type: "jpeg", quality: 82, scale: "css" }); // (CSS pixels: a phone page at 2x is taller than Chrome can capture in one piece)
        }
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
        console.log(name, m.sw > m.iw ? `OVERFLOW ${m.sw} > ${m.iw}` : "no overflow");
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await srv.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });

// Pictures of the phone app's real-glass chrome WITHOUT a phone: mock.html
// draws the tab bar, the top buttons, the glass button and the action circles
// from the app's own style values, twice — "today" (origin/master's
// tv-native/src/phone/theme.ts) and "real glass" (the working tree's) — and
// this takes them at the Pixel 9's size (411 css px wide, scale 2.625).
//
//   node tools/real-glass-app/shoot.js [--base origin/master]
//
// Out: docs/qa/real-glass/final/app-home.png, app-title.png. They are drawn
// in a browser, not photographed: the look still has to be checked on a
// device (inset shadows are Android 10+, react-native-svg draws the rim).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { launch, argv } = require("../webperf/lib");

const ROOT = path.join(__dirname, "..", "..");
const TV = path.join(ROOT, "tv-native");
const OUT = path.join(ROOT, "docs", "qa", "real-glass", "final");
const ts = require(path.join(TV, "node_modules", "typescript"));

/** theme.ts → its exports (the shared TV theme it imports is not needed here). */
function theme(src) {
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const mod = { exports: {} };
  new Function("module", "exports", "require", js)(mod, mod.exports, () => ({ colors: {} }));
  return JSON.parse(JSON.stringify(mod.exports));
}

/** Keep a picture under 1.5 MB: when it is over, its colours go to 6 bits a channel (steps of 4 in
 *  255 — the soft shadows pack far better, nothing visible changes) and it is packed again. */
const LIMIT = 1.5 * 1024 * 1024;
function slim(file) {
  if (fs.statSync(file).size <= LIMIT) return;
  const { PNG } = require(path.join(TV, "node_modules", "pngjs"));
  const png = PNG.sync.read(fs.readFileSync(file));
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = (d[i] & 0xfc) | 2;
    d[i + 1] = (d[i + 1] & 0xfc) | 2;
    d[i + 2] = (d[i + 2] & 0xfc) | 2;
    d[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png, { colorType: 2, inputHasAlpha: true, deflateLevel: 9 }));
}

(async () => {
  const base = argv("base", "origin/master");
  const today = theme(execFileSync("git", ["show", `${base}:tv-native/src/phone/theme.ts`], { cwd: ROOT, encoding: "utf8" }));
  const real = theme(fs.readFileSync(path.join(TV, "src", "phone", "theme.ts"), "utf8"));
  if (!real.RG_ARCS) throw new Error("the working tree's theme.ts has no real-glass tokens");
  const logo = "data:image/png;base64," + fs.readFileSync(path.join(TV, "src", "assets", "logo-mark.png")).toString("base64");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 902, height: 923 }, deviceScaleFactor: 2.625 });
    for (const page of ["home", "title"]) {
      const p = await ctx.newPage();
      await p.addInitScript((d) => { window.DATA = d; }, { today, real, logo });
      await p.goto("file:///" + path.join(__dirname, "mock.html").replace(/\\/g, "/"));
      await p.evaluate((name) => window.render(name), page);
      const file = path.join(OUT, `app-${page}.png`);
      await (await p.$("#sheet")).screenshot({ path: file });
      slim(file);
      console.log(file, Math.round(fs.statSync(file).size / 1024) + " KB");
      await p.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });

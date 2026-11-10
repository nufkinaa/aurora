// The experiment: refraction at a bar's rim, as Chromium alone can draw it —
// an SVG displacement map in `backdrop-filter: url(#…)`, bent where the
// capsule turns away (content near the rim is pulled from further inside,
// the way a thick edge bends what is behind it).
//
//   node tools/glass-apple/refract.js <outdir>          photographs, with and without
//   (scrollperf.js takes this file as its "extra" side: what it costs)
//
// The map has to be drawn at the bar's own size in pixels (an feImage does
// not stretch with the box it is used on), so a real version would need a
// script that redraws it whenever the bar changes size. This file is the
// test of whether that would be worth writing.
"use strict";
const path = require("path");
const fs = require("fs");

// in the page: one filter per bar, sized to it
const APPLY = (sels) => {
  const NS = "http://www.w3.org/2000/svg";
  document.getElementById("ga-refract")?.remove();
  document.getElementById("ga-refract-css")?.remove();
  const svg = document.createElementNS(NS, "svg");
  svg.id = "ga-refract";
  svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
  svg.style.cssText = "position:absolute;width:0;height:0;pointer-events:none";
  let css = "";
  sels.forEach((sel, i) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w < 8 || h < 8) return;
    const rad = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, h / 2, w / 2);
    const zone = Math.min(h * 0.42, 20);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    const im = x.createImageData(w, h);
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      // the nearest point of the rounded box's edge, and the way out from it
      const cx = Math.min(Math.max(px + 0.5, rad), w - rad), cy = Math.min(Math.max(py + 0.5, rad), h - rad);
      let nx = px + 0.5 - cx, ny = py + 0.5 - cy;
      const len = Math.hypot(nx, ny);
      let d; // distance to the edge, inside
      if (len > 1e-6) { d = rad - len; nx /= len; ny /= len; }
      else {
        const dl = px + 0.5, dr = w - px - 0.5, dt = py + 0.5, db = h - py - 0.5;
        d = Math.min(dl, dr, dt, db);
        nx = d === dl ? -1 : d === dr ? 1 : 0; ny = d === dt ? -1 : d === db ? 1 : 0;
      }
      const t = d >= zone ? 0 : Math.pow(1 - Math.max(0, d) / zone, 2);
      const o = (py * w + px) * 4;
      // pulled from further inside: against the way out
      im.data[o] = Math.round(128 - 127 * nx * t);
      im.data[o + 1] = Math.round(128 - 127 * ny * t);
      im.data[o + 2] = 128;
      im.data[o + 3] = 255;
    }
    x.putImageData(im, 0, 0);
    const f = document.createElementNS(NS, "filter");
    f.id = `ga-refract-${i}`;
    f.setAttribute("x", "0"); f.setAttribute("y", "0"); f.setAttribute("width", "100%"); f.setAttribute("height", "100%");
    f.setAttribute("color-interpolation-filters", "sRGB");
    const img = document.createElementNS(NS, "feImage");
    img.setAttribute("href", c.toDataURL("image/png"));
    img.setAttribute("x", "0"); img.setAttribute("y", "0"); img.setAttribute("width", String(w)); img.setAttribute("height", String(h));
    img.setAttribute("preserveAspectRatio", "none"); img.setAttribute("result", "map");
    const dm = document.createElementNS(NS, "feDisplacementMap");
    dm.setAttribute("in", "SourceGraphic"); dm.setAttribute("in2", "map");
    dm.setAttribute("scale", String(Math.round(zone * 1.6)));
    dm.setAttribute("xChannelSelector", "R"); dm.setAttribute("yChannelSelector", "G");
    f.append(img, dm);
    svg.append(f);
    css += `html[data-look="glass"]:root ${sel} { backdrop-filter: url(#ga-refract-${i}) var(--g-blur) !important; }\n`;
  });
  document.body.append(svg);
  const st = document.createElement("style");
  st.id = "ga-refract-css";
  st.textContent = css;
  document.head.append(st);
  return css;
};

const BARS = [".nav-items", ".nav-logo", ".nav-profile"];
const apply = async (page) => page.evaluate(APPLY, BARS);
module.exports = { apply };

if (require.main === module) {
  (async () => {
    const { launch, openPage, go, sleep } = require("./lib");
    const out = process.argv[2] || "refract";
    fs.mkdirSync(out, { recursive: true });
    const b = await launch();
    try {
      for (const size of ["phone", "desktop"]) {
        const h = await openPage(b, { size, side: "after" });
        await go(h, "home");
        await h.page.evaluate(([s, f]) => window.__ga.brightRow(s, { frac: f, kinds: ["cream", "snow", "lemon", "cream", "snow", "lemon"] }), [".nav-items", size === "phone" ? 0.5 : 0.3]);
        await sleep(600);
        const clip = await h.page.evaluate(() => { const r = document.querySelector(".nav-items").getBoundingClientRect(); return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 20), width: Math.min(innerWidth, r.width + 40), height: r.height + 40 }; });
        await h.page.screenshot({ path: path.join(out, `${size}.plain.png`), clip });
        console.log(size, (await apply(h.page)).trim());
        await sleep(600);
        await h.page.screenshot({ path: path.join(out, `${size}.refract.png`), clip });
        await h.ctx.close();
      }
    } finally { await b.close(); }
  })().catch((e) => { console.error(e); process.exit(1); });
}

// lib/imgvariant.js: the width ladder (including the TV card steps) and the
// pre-blurred variant the TV's billboard asks for instead of blurring on the
// box. The blur is checked against a port of the filter Android ran
// (Fresco's blur_filter.cpp), on pixels decoded back out of the variant.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const config = require("../src/config");
const iv = require("../src/lib/imgvariant");

test("the ladder snaps up, never down, and knows the TV card widths", () => {
  assert.deepEqual(iv.LADDER, [240, 256, 352, 360, 448, 480, 640, 800, 960, 1280, 1600, 1920]);
  assert.equal(iv.snap(248), 256); // poster, 124 dp × 2
  assert.equal(iv.snap(256), 256);
  assert.equal(iv.snap(352), 352); // landscape card, 176 dp × 2
  assert.equal(iv.snap(353), 360);
  assert.equal(iv.snap(448), 448); // Continue Watching, 224 dp × 2
  assert.equal(iv.snap(240), 240); // the blur-up placeholder's size is untouched
  assert.equal(iv.snap(176), 240);
  assert.equal(iv.snap(1280), 1280);
  assert.equal(iv.snap(1281), 1600); // the website's hero on a desktop monitor
  assert.equal(iv.snap(1920), 1920);
  assert.equal(iv.snap(1921), null); // wider than any source: the original
  assert.equal(iv.snap(10), null);
  assert.equal(iv.snap("x"), null);
});

test("blur radius is 1..8 source pixels, anything else is no blur", () => {
  assert.equal(iv.blurOf("1"), 1);
  assert.equal(iv.blurOf(2), 2);
  assert.equal(iv.blurOf("8"), 8);
  assert.equal(iv.blurOf("9"), 0);
  assert.equal(iv.blurOf("0"), 0);
  assert.equal(iv.blurOf(undefined), 0);
  assert.equal(iv.blurOf("abc"), 0);
});

test("without blur the filter chain is exactly the old one", () => {
  assert.equal(iv.filterFor(480, 0), "scale='min(480,iw)':-2");
  assert.equal(iv.filterFor(1280, 2), "format=gbrp,boxblur=lr=2:lp=2:cr=2:cp=2,scale='min(1280,iw)':-2,format=yuvj444p");
  assert.equal(iv.filterFor(null, 1), "format=gbrp,boxblur=lr=1:lp=2:cr=1:cp=2,format=yuvj444p");
});

test("no width and no blur: no variant (the original is served)", async () => {
  assert.equal(await iv.variant(__filename, undefined), null);
  assert.equal(await iv.variant(__filename, "nope", { blur: "0" }), null);
});

// ---- the real encode (skipped where ffmpeg is missing) ----------------------

// Fresco's NativeBlurFilter.iterativeBoxBlur, transcribed: per iteration a
// horizontal then a vertical (2r+1) box, edges clamped, each pass rounded
// with the same division table.
const frescoBlur = (px, w, h, iterations, r) => {
  const d = 2 * r + 1;
  const div = (s) => Math.floor((s + r) / d);
  let a = Float64Array.from(px);
  const pass = (horizontal) => {
    const out = new Float64Array(a.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let k = -r; k <= r; k++) {
            const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
            const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
            s += a[(yy * w + xx) * 3 + c];
          }
          out[(y * w + x) * 3 + c] = div(s);
        }
    a = out;
  };
  for (let i = 0; i < iterations; i++) {
    pass(true);
    pass(false);
  }
  return a;
};
const rgbOf = (file, w, h) =>
  execFileSync(config.FFMPEG, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-"], {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });

test("blur=N matches Android's blurRadius postprocessor and is cached under its own name", { skip: !config.FFMPEG }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imgvariant-"));
  const W = 160;
  const H = 90;
  const src = path.join(tmp, "src.png");
  // a sharp, busy picture: the worst case for a blur to get wrong
  execFileSync(config.FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=1`, "-frames:v", "1", src], {
    windowsHide: true,
  });
  const made = [];
  // the encoder probe (webp or jpeg) answers asynchronously at load; let it
  // land so both asks below name the same file
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const orig = rgbOf(src, W, H);
    for (const r of [1, 2]) {
      const out = await iv.variant(src, undefined, { blur: String(r) });
      assert.ok(out, "a blurred variant was made");
      made.push(out);
      assert.match(path.basename(out), new RegExp(`-wfull-b${r}\\.jpg$`));
      const want = frescoBlur(orig, W, H, 2, r);
      const got = rgbOf(out, W, H);
      let sum = 0;
      let unblurred = 0;
      for (let i = 0; i < got.length; i++) {
        sum += Math.abs(got[i] - want[i]);
        unblurred += Math.abs(orig[i] - want[i]);
      }
      const mean = sum / got.length;
      // a 4:4:4 JPEG at q 2 on top of an at-most-one-level filter difference
      assert.ok(mean < 1.5, `mean error ${mean.toFixed(2)} against Fresco's blur (r=${r})`);
      assert.ok(unblurred / got.length > mean * 2, "and it really is blurred");
      // the second ask is the cached file
      assert.equal(await iv.variant(src, undefined, { blur: r }), out);
    }
    // width + blur: its own file, the width honoured
    const both = await iv.variant(src, 100, { blur: 1 });
    made.push(both);
    assert.match(path.basename(both), /-w240-b1\.jpg$/); // 100 → 240, never wider than the source
    // the unblurred variant keeps the name it always had
    const plain = await iv.variant(src, 100);
    made.push(plain);
    const st = fs.statSync(src);
    const key = crypto.createHash("md5").update(`${src}|${st.mtimeMs}|${st.size}|240`).digest("hex");
    assert.match(path.basename(plain), new RegExp(`^${key}-w240\\.(webp|jpg)$`));
  } finally {
    for (const f of made) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

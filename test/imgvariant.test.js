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

test("fmt is webp or nothing", () => {
  assert.equal(iv.fmtOf("webp"), "webp");
  assert.equal(iv.fmtOf("WEBP"), "webp");
  assert.equal(iv.fmtOf(" webp "), "webp");
  for (const bad of ["jpg", "jpeg", "avif", "png", "", "1", "webp2", undefined, null, 1, true, ["webp"], { fmt: "webp" }])
    assert.equal(iv.fmtOf(bad), "", `fmt ${JSON.stringify(bad)} is ignored`);
});

test("fmt=webp changes only the blurred chain's last step and its encoder", () => {
  // default (and any fmt that is not webp): today's chain, to the character
  assert.equal(iv.filterFor(1280, 2), "format=gbrp,boxblur=lr=2:lp=2:cr=2:cp=2,scale='min(1280,iw)':-2,format=yuvj444p");
  assert.equal(iv.filterFor(1280, 2, ""), iv.filterFor(1280, 2));
  assert.equal(iv.filterFor(1280, 2, "jpg"), iv.filterFor(1280, 2));
  // webp: the same blur and the same downscale
  const w = iv.filterFor(1280, 2, "webp");
  assert.ok(w.startsWith(`${iv.blurChain(1280, 2)},format=`));
  assert.ok(iv.filterFor(1280, 2).startsWith(`${iv.blurChain(1280, 2)},format=`));
  assert.doesNotMatch(w, /yuvj444p/);
  // unblurred: fmt means nothing
  assert.equal(iv.filterFor(480, 0, "webp"), "scale='min(480,iw)':-2");
  // the encoders: the JPEG's is untouched, the WebP's is libwebp
  assert.deepEqual(iv.codecFor("x-w1280-b1.jpg", 1280, 1), ["-q:v", "2"]);
  assert.equal(iv.codecFor("x-w1280-b1.webp", 1280, 1)[1], "libwebp");
  assert.deepEqual(iv.codecFor("x-w480.webp", 480, 0), ["-c:v", "libwebp", "-quality", "78", "-compression_level", "4"]);
  assert.deepEqual(iv.codecFor("x-w1920.webp", 1920, 0), ["-c:v", "libwebp", "-quality", "84", "-compression_level", "4"]);
  assert.deepEqual(iv.codecFor("x-w480.jpg", 480, 0), ["-q:v", "4"]);
});

test("without blur the filter chain is exactly the old one", () => {
  assert.equal(iv.filterFor(480, 0), "scale='min(480,iw)':-2");
  assert.equal(iv.filterFor(1280, 2), "format=gbrp,boxblur=lr=2:lp=2:cr=2:cp=2,scale='min(1280,iw)':-2,format=yuvj444p");
  assert.equal(iv.filterFor(null, 1), "format=gbrp,boxblur=lr=1:lp=2:cr=1:cp=2,format=yuvj444p");
});

test("no width and no blur: no variant (the original is served)", async () => {
  assert.equal(await iv.variant(__filename, undefined), null);
  assert.equal(await iv.variant(__filename, "nope", { blur: "0" }), null);
  // fmt alone asks for nothing
  assert.equal(await iv.variant(__filename, undefined, { fmt: "webp" }), null);
  assert.equal(await iv.variant(__filename, "nope", { blur: "0", fmt: "webp" }), null);
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

// What a file really is and how big, read back through ffmpeg ("webp 240x136").
const probe = (file) => {
  const r = require("child_process").spawnSync(config.FFMPEG, ["-hide_banner", "-i", file], { windowsHide: true, encoding: "utf8" });
  const m = /Video: (\w+)[^\n]*?, (\d+)x(\d+)/.exec(r.stderr || "");
  return m ? `${m[1]} ${m[2]}x${m[3]}` : "?";
};

test("blur + fmt=webp: a WebP of its own beside the untouched JPEG; a bad fmt is the JPEG", { skip: !config.FFMPEG }, async (t) => {
  // the encoder probe answers asynchronously at load
  await new Promise((r) => setTimeout(r, 1500));
  if (!iv.hasWebp()) return t.skip("this ffmpeg has no libwebp");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imgvariant-fmt-"));
  const src = path.join(tmp, "src.png");
  execFileSync(config.FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=1", "-frames:v", "1", src], {
    windowsHide: true,
  });
  const made = new Set();
  const ask = async (w, opts) => {
    const out = await iv.variant(src, w, opts);
    if (out) made.add(out);
    return out;
  };
  try {
    const st = fs.statSync(src);
    const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
    const base = `${src}|${st.mtimeMs}|${st.size}`;

    // DEFAULT UNCHANGED: no fmt → the JPEG, under the key and name it always had
    const jpg = await ask(480, { blur: 2 });
    assert.equal(path.basename(jpg), `${md5(`${base}|480|b2`)}-w480-b2.jpg`);
    assert.equal(probe(jpg), "mjpeg 480x270");

    // fmt=webp → a .webp, the asked width, its own key
    const webp = await ask(480, { blur: 2, fmt: "webp" });
    assert.ok(webp, "a blurred webp variant was made");
    assert.equal(path.basename(webp), `${md5(`${base}|480|b2|webp`)}-w480-b2.webp`);
    assert.notEqual(webp, jpg);
    assert.notEqual(path.basename(webp).split("-")[0], path.basename(jpg).split("-")[0], "the cache key is distinct");
    assert.equal(probe(webp), "webp 480x270");
    assert.ok(fs.statSync(webp).size < fs.statSync(jpg).size, "and it is the smaller file");
    // cached: the second ask is the same file, and the JPEG is still its own
    assert.equal(await ask(480, { blur: "2", fmt: "WEBP" }), webp);
    assert.equal(await ask(480, { blur: 2 }), jpg);

    // the same picture: the WebP against the JPEG, pixel for pixel
    const a = rgbOf(jpg, 480, 270);
    const b = rgbOf(webp, 480, 270);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    // (testsrc2 is the worst case for 4:2:0 — saturated one-pixel colour edges)
    assert.ok(sum / a.length < 6, `mean difference ${(sum / a.length).toFixed(2)} between the WebP and the JPEG`);

    // no width: blurred at the source's own size
    const full = await ask(undefined, { blur: 1, fmt: "webp" });
    assert.match(path.basename(full), /-wfull-b1\.webp$/);
    assert.equal(probe(full), "webp 640x360");
    // never wider than the source
    assert.equal(probe(await ask(1280, { blur: 1, fmt: "webp" })), "webp 640x360");

    // BAD fmt IGNORED: exactly the JPEG an ask without fmt gets
    for (const bad of ["jpg", "avif", "", "webp;rm", ["webp"], 1]) assert.equal(await ask(480, { blur: 2, fmt: bad }), jpg);

    // fmt without blur changes nothing: the unblurred variant, its old name
    const plain = await ask(480);
    assert.equal(path.basename(plain), `${md5(`${base}|480`)}-w480.webp`);
    assert.equal(await ask(480, { fmt: "webp" }), plain);
    assert.equal(await ask(480, { fmt: "nope" }), plain);
  } finally {
    for (const f of made) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

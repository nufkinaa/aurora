// AVIF posters in a real browser (lib/imgvariant.js, 2026-11-09): Chrome
// asks with image/avif in its Accept header, gets the WebP the first time
// (the AVIF is made behind it), and the AVIF after that — and the posters
// look the same either way: the same decoded size, the same pixels within a
// few levels, no colour cast. (The picture quality itself is measured on
// real posters: tools/avif-bench; crops in docs/qa/avif.) (The covers are swapped for a detailed picture first: the
// test library's are single colours, which would prove nothing.)
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { suite, PHONE } = require("./helpers");
const config = require("../../src/config");

const ui = suite({
  setup: async (srv) => {
    // (this instance's own copy of the library — never the shared built one)
    const films = fs.readdirSync(srv.library.movies);
    films.forEach((f, i) => {
      const cover = path.join(srv.library.movies, f, "cover.jpg");
      if (!fs.existsSync(cover)) return;
      execFileSync(config.FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", `mandelbrot=size=400x600:rate=1:start_scale=${(3 - i * 0.7).toFixed(2)}`, "-frames:v", "1", "-q:v", "2", cover], { windowsHide: true });
    });
  },
});

const POSTERS = "#app img.card-poster";
// every poster on show has loaded and finished appearing
const settle = async (page) => {
  await page.waitForSelector(POSTERS);
  for (const img of await page.locator(POSTERS).all()) if (await img.isVisible()) await img.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await page.waitForFunction((sel) => {
    const imgs = [...document.querySelectorAll(sel)].filter((i) => i.offsetParent !== null);
    return imgs.length >= 2 && imgs.every((i) => i.complete && i.naturalWidth > 0 && i.classList.contains("img-in") && !i.style.backgroundImage && getComputedStyle(i).opacity === "1");
  }, POSTERS, { timeout: 15000 });
  // (the blur-up's fade: let the last frame of it pass)
  await page.waitForTimeout(700);
};
// What each poster is, as drawn: its address, its decoded size, and its pixels.
const shoot = async (page) => {
  const out = [];
  for (const img of await page.locator(POSTERS).all()) {
    if (!(await img.isVisible())) continue;
    const info = await img.evaluate((i) => ({ src: i.getAttribute("src"), w: i.naturalWidth, h: i.naturalHeight, label: i.closest(".card").getAttribute("aria-label") }));
    out.push({ ...info, png: (await img.screenshot()).toString("base64") });
  }
  return out;
};
// Mean and 99.9th-percentile difference between two screenshots, per channel value.
const diff = (page, a, b) =>
  page.evaluate(async ([a, b]) => {
    const px = async (b64) => {
      const im = new Image();
      im.src = `data:image/png;base64,${b64}`;
      await im.decode();
      const c = document.createElement("canvas");
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const x = c.getContext("2d");
      x.drawImage(im, 0, 0);
      return x.getImageData(0, 0, c.width, c.height);
    };
    const [p, q] = await Promise.all([px(a), px(b)]);
    if (p.width !== q.width || p.height !== q.height) return { size: `${p.width}x${p.height} vs ${q.width}x${q.height}` };
    const hist = new Array(256).fill(0);
    const signed = [0, 0, 0];
    let sum = 0;
    let n = 0;
    for (let i = 0; i < p.data.length; i += 4) for (let c = 0; c < 3; c++) { const s = q.data[i + c] - p.data[i + c]; const d = Math.abs(s); signed[c] += s; sum += d; hist[d]++; n++; }
    let acc = 0;
    let p999 = 0;
    for (let d = 0; d < 256; d++) { acc += hist[d]; if (acc >= n * 0.999) { p999 = d; break; } }
    return { mean: sum / n, p999, cast: signed.map((x) => x / (n / 3)) };
  }, [a, b]);

for (const [label, viewport] of [["desktop", undefined], ["phone", PHONE]]) {
  ui.test(`posters: WebP first, AVIF once made, and they look the same (${label})`, viewport ? { viewport } : {}, async ({ page, context, goto, signIn, freshProfile, t }) => {
    const seen = [];
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/img/") && u.searchParams.get("w")) seen.push({ path: u.pathname + u.search, type: r.headers()["content-type"], cache: r.headers()["cache-control"], vary: r.headers()["vary"] || "" });
    });
    await signIn(await freshProfile());
    await goto("#/movies");
    await settle(page);
    const firstLook = await shoot(page);
    assert.ok(firstLook.length >= 2, `${firstLook.length} posters on show`);
    const srcs = firstLook.map((b) => b.src);
    const first = seen.filter((s) => srcs.includes(s.path));
    assert.ok(first.length >= 2, "the posters were asked for with a width");
    for (const s of first) {
      assert.match(s.vary, /accept/i, `${s.path} says Vary: Accept`);
      // the first look: the WebP, kept for minutes only while the AVIF is made
      // (or, on a machine too busy to make the WebP in time, the original for
      // a minute — the variant queue's own rule)
      // (a minute, too, when it was another size of the WebP standing in)
      if (s.type === "image/webp") assert.match(s.cache, /^public, max-age=(300|60)$/, "the WebP standing in for the AVIF is kept for minutes only");
      else if (s.type === "image/jpeg") assert.equal(s.cache, "public, max-age=60");
      else assert.equal(s.type, "image/avif", `${s.path}: ${s.type}`);
    }
    // Both made, as the server answers each kind of asker (polled from here:
    // waitForFunction would take an async predicate's promise for a yes).
    const madeFor = async (accept, want) => {
      const t0 = Date.now();
      for (;;) {
        const types = await page.evaluate(([list, accept]) => Promise.all(list.map((s) => fetch(s, { headers: { accept }, cache: "no-store" }).then((r) => r.headers.get("content-type")))), [srcs, accept]);
        if (types.every((x) => x === want)) return;
        assert.ok(Date.now() - t0 < 90000, `not all ${want} in 90 s: ${types.join(", ")}`);
        await page.waitForTimeout(500);
      }
    };
    await madeFor("image/webp,*/*", "image/webp");
    await madeFor("image/avif,image/webp,*/*", "image/avif");
    const cdp = await context.newCDPSession(page);
    const freshLook = async () => {
      await cdp.send("Network.clearBrowserCache");
      seen.length = 0;
      await page.reload();
      await settle(page);
      return shoot(page);
    };
    // TODAY'S PICTURE: the page as a browser without AVIF sees it (an older
    // Safari; the TV app asks the same way) — the WebP
    await page.route("**/img/**", (route) => route.continue({ headers: { ...route.request().headers(), accept: "image/webp,image/*,*/*;q=0.8" } }));
    const before = await freshLook();
    for (const b of before) assert.equal((seen.find((x) => x.path === b.src) || {}).type, "image/webp", `${b.label}: today's WebP`);
    await page.unroute("**/img/**");

    // a fresh look as Chrome itself: every poster is an AVIF now
    const after = await freshLook();
    for (const b of before) {
      const a = after.find((x) => x.label === b.label);
      assert.ok(a, `${b.label} is on show again`);
      const s = seen.find((x) => x.path === a.src);
      assert.ok(s, `${a.src} was asked for again`);
      assert.equal(s.type, "image/avif", `${a.label}: ${s.type} ${JSON.stringify(seen.filter((x) => x.path === a.src))}`);
      assert.equal(s.cache, "public, max-age=86400");
      // the same picture: the same decoded size, and the same pixels near enough
      assert.deepEqual([a.w, a.h], [b.w, b.h], `${a.label}: decoded size`);
      const d = await diff(page, b.png, a.png);
      assert.ok(!d.size, `${a.label}: screenshot sizes differ ${d.size}`);
      // (two lossy copies of a fractal — the hardest picture there is — differ
      // by a few levels everywhere; what must not happen is a colour cast, a
      // range or matrix mistake, which moves every pixel the same way)
      assert.ok(d.mean < 5, `${a.label}: mean difference ${d.mean.toFixed(2)} levels between the WebP and the AVIF`);
      assert.ok(d.p999 < 100, `${a.label}: 99.9% of pixel values within ${d.p999} levels`);
      for (const c of d.cast) assert.ok(Math.abs(c) < 1.5, `${a.label}: colour cast ${d.cast.map((x) => x.toFixed(2)).join(" / ")} (R / G / B)`);
      t.diagnostic(`${a.label}: mean ${d.mean.toFixed(2)}, p99.9 ${d.p999}, cast ${d.cast.map((x) => x.toFixed(2)).join(" / ")}`);
    }
  });
}

ui.run({ concurrency: 1 });

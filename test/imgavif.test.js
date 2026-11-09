// AVIF picture variants (lib/imgvariant.js, routes/stream.js — 2026-11-09):
// who gets one (the Accept header, ?fmt=), who never does (the TV and phone
// apps, blurred variants, an ffmpeg without libaom), and that nobody ever
// waits for one: the first ask is the WebP, short-lived, and the AVIF is
// made in the background for the next.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const express = require("express");
const config = require("../src/config");
const iv = require("../src/lib/imgvariant");

// What browsers really send for an <img> (2024–2026 releases).
const CHROME = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
const FIREFOX = "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5";
const SAFARI = "image/webp,image/avif,image/jxl,image/heic,image/heic-sequence,video/*;q=0.8,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5";
const OLD_SAFARI = "image/webp,image/png,image/svg+xml,image/*;q=0.8,video/*;q=0.8,*/*;q=0.5";

test("Accept: only an explicit image/avif with q above zero counts", () => {
  for (const a of [CHROME, FIREFOX, SAFARI, "image/avif", "IMAGE/AVIF", " image/avif ; q=0.5 ", "image/png,image/avif;q=1"]) assert.equal(iv.acceptsAvif(a), true, a);
  for (const a of [OLD_SAFARI, "*/*", "image/*", "image/webp,*/*", "image/avif;q=0", "image/avif;q=0.0", "image/avifx", "text/html", "", undefined, null, 1, ["image/avif"]])
    assert.equal(iv.acceptsAvif(a), false, String(a));
});

test("wantsAvif: ?fmt=avif asks, ?fmt=webp and blur say no, otherwise the Accept header", () => {
  assert.equal(iv.wantsAvif({}, CHROME), true);
  assert.equal(iv.wantsAvif({ w: "480" }, OLD_SAFARI), false);
  // what the TV and phone apps send: no Accept at all (Fresco over OkHttp)
  assert.equal(iv.wantsAvif({ w: "352" }, undefined), false);
  assert.equal(iv.wantsAvif({ fmt: "avif" }, undefined), true);
  assert.equal(iv.wantsAvif({ fmt: " AVIF " }, "*/*"), true);
  assert.equal(iv.wantsAvif({ fmt: "webp" }, CHROME), false, "an explicit WebP stays WebP");
  assert.equal(iv.wantsAvif({ fmt: "jpg" }, CHROME), false);
  assert.equal(iv.wantsAvif({ fmt: ["avif"] }, CHROME), false, "a repeated parameter is not an ask");
  // blurred variants (the TV's billboard) are never AVIF
  assert.equal(iv.wantsAvif({ blur: "2" }, CHROME), false);
  assert.equal(iv.wantsAvif({ blur: "2", fmt: "avif" }, CHROME), false);
  assert.equal(iv.wantsAvif({ blur: "0" }, CHROME), true, "blur 0 is no blur");
  assert.equal(iv.wantsAvif(null, CHROME), true);
});

test("the AVIF encode: the measured settings (tools/avif-bench; crops in docs/qa/avif)", () => {
  // full range 4:2:0, the width ladder's own scale
  assert.equal(iv.avifFilter(480), "scale='min(480,iw)':-2:out_range=full,format=yuv420p");
  const opt = (c, k) => c[c.indexOf(k) + 1];
  const c = iv.avifCodec(480);
  assert.equal(opt(c, "-c:v"), "libaom-av1");
  assert.equal(opt(c, "-still-picture"), "1");
  assert.equal(opt(c, "-usage"), "allintra");
  assert.equal(opt(c, "-crf"), "24");
  assert.equal(opt(c, "-cpu-used"), "6");
  assert.equal(opt(c, "-aom-params"), "tune=ssim");
  assert.ok(Number(opt(c, "-threads")) <= 2, "at most two threads");
  // tagged: full range, sRGB, the JPEG's BT.601 matrix
  assert.equal(opt(c, "-color_range"), "pc");
  assert.equal(opt(c, "-color_primaries"), "bt709");
  assert.equal(opt(c, "-color_trc"), "iec61966-2-1");
  assert.equal(opt(c, "-colorspace"), "bt470bg");
  // the hero sizes (where the WebP is q84) get the finer crf
  for (const w of [1280, 1600, 1920]) assert.equal(opt(iv.avifCodec(w), "-crf"), w >= 1600 ? "18" : "24", `width ${w}`);
});

// ---- the real thing (skipped where this ffmpeg cannot make an AVIF) --------

const has = (what) => {
  if (!config.FFMPEG) return false;
  const r = spawnSync(config.FFMPEG, ["-hide_banner", what], { windowsHide: true, encoding: "utf8" });
  return r.stdout || "";
};
const CAN = !!config.FFMPEG && /\blibaom-av1\b/.test(has("-encoders")) && /^\s*E\s+avif\b/m.test(has("-muxers")) && /\blibwebp\b/.test(has("-encoders"));
const probeLanded = async () => {
  const t0 = Date.now();
  while (!iv.hasAvif() && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
  assert.ok(iv.hasAvif(), "the encoder probe found libaom and the avif muxer");
};
const probe = (file) => {
  const r = spawnSync(config.FFMPEG, ["-hide_banner", "-i", file], { windowsHide: true, encoding: "utf8" });
  const m = /Video: (\w+)[^\n]*?, (\d+)x(\d+)/.exec(r.stderr || "");
  return m ? `${m[1]} ${m[2]}x${m[3]}` : "?";
};
const until = async (fn, ms = 60000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const picture = (dir, name = "poster.jpg", size = "640x360") => {
  const src = path.join(dir, name);
  // a photo-like picture: smooth gradients, edges and some noise
  execFileSync(config.FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", `mandelbrot=size=${size}:rate=1`, "-frames:v", "1", "-q:v", "2", src], { windowsHide: true });
  return src;
};
const MADE = 60000;
const cleanUp = async (dir, made) => {
  await Promise.allSettled([...iv._internals.inflight.values(), ...iv._internals.avifInflight.values()]);
  for (const f of made) { try { fs.unlinkSync(f); } catch {} }
  iv.forget();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test("first ask: the WebP at once, marked pending; the AVIF is made behind it and is the next answer", { skip: !CAN }, async () => {
  await probeLanded();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-avif-"));
  const made = new Set();
  const deps = iv._internals.avifDeps;
  const real = deps.viewerBusy;
  try {
    const src = picture(dir);
    iv.forget();
    // (held back, as while a viewer's video is encoded, so "on its way" can be looked at)
    deps.viewerBusy = () => true;
    const o1 = { avif: true, maxWaitMs: MADE };
    const first = await iv.variant(src, 480, o1);
    made.add(first);
    assert.match(first, /-w480\.webp$/, "the first answer is the WebP");
    assert.equal(o1.avifPending, true, "marked: the route keeps it for minutes, not a week");
    assert.equal(iv._internals.avifInflight.size, 1, "one AVIF on its way");
    // asked again while it is being made: still the WebP, still pending, no second encode
    const o2 = { avif: true, maxWaitMs: MADE };
    assert.equal(await iv.variant(src, 480, o2), first);
    assert.equal(o2.avifPending, true);
    assert.equal(iv._internals.avifInflight.size, 1);
    deps.viewerBusy = real;
    iv._internals.pumpAvif();
    await until(() => iv._internals.avifInflight.size === 0);
    const o3 = { avif: true };
    const avif = await iv.variant(src, 480, o3);
    made.add(avif);
    assert.match(avif, /-w480\.avif$/);
    assert.equal(o3.avifPending, undefined, "made: nothing pending");
    assert.equal(probe(avif), "av1 480x270");
    // the container says what a decoder needs: baseline brand, sRGB/BT.601, full range
    const box = fs.readFileSync(avif);
    assert.equal(box.toString("latin1", 4, 12), "ftypavif");
    assert.ok(box.includes(Buffer.from("MA1B")), "the AVIF baseline profile brand");
    const colr = box.indexOf(Buffer.from("colrnclx"));
    assert.ok(colr > 0, "an nclx colour box");
    assert.deepEqual([box.readUInt16BE(colr + 8), box.readUInt16BE(colr + 10), box.readUInt16BE(colr + 12), box[colr + 14] >> 7], [1, 13, 5, 1]);
    // the same key as the WebP's: the same source and width
    assert.equal(path.basename(avif).split("-")[0], path.basename(first).split("-")[0]);
    assert.equal(require("../src/lib/imgcheck").mimeOfFile(avif), "image/avif");
    // an asker without AVIF (the TV, the phone app, an old Safari) gets the WebP it always got
    const tv = {};
    assert.equal(await iv.variant(src, 480, tv), first);
    assert.equal(tv.avifPending, undefined);
    // blurred: never AVIF (the route never sets avif with a blur, nor does variant use it)
    const blurred = await iv.variant(src, 480, { blur: 2, avif: true, maxWaitMs: MADE });
    made.add(blurred);
    assert.match(blurred, /-w480-b2\.jpg$/);
    // found on disk after the fast path forgets it
    iv.forget();
    assert.equal(await iv.variant(src, 480, { avif: true }), avif);
  } finally {
    deps.viewerBusy = real;
    await cleanUp(dir, made);
  }
});

test("AVIF switched off (config) or not possible: the WebP, nothing pending, nothing queued", { skip: !CAN }, async () => {
  await probeLanded();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-avif-off-"));
  const made = new Set();
  const was = config.IMG_AVIF;
  try {
    const src = picture(dir);
    config.IMG_AVIF = false;
    assert.equal(iv.hasAvif(), false);
    const o = { avif: true, maxWaitMs: MADE };
    const out = await iv.variant(src, 360, o);
    made.add(out);
    assert.match(out, /-w360\.webp$/);
    assert.equal(o.avifPending, undefined);
    assert.equal(iv._internals.avifInflight.size, 0);
    config.IMG_AVIF = was;
    // an ffmpeg without the avif muxer
    const p = iv._internals.probe.get();
    iv._internals.probe.set({ avifMux: false });
    try {
      assert.equal(iv.hasAvif(), false);
      const o2 = { avif: true };
      assert.equal(await iv.variant(src, 360, o2), out);
      assert.equal(o2.avifPending, undefined);
    } finally {
      iv._internals.probe.set(p);
    }
  } finally {
    config.IMG_AVIF = was;
    await cleanUp(dir, made);
  }
});

test("an AVIF encode waits while a viewer's video is encoded, and behind any WebP somebody waits for", { skip: !CAN }, async () => {
  await probeLanded();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-avif-gate-"));
  const made = new Set();
  const deps = iv._internals.avifDeps;
  const real = deps.viewerBusy;
  try {
    const src = picture(dir);
    made.add(await iv.variant(src, 256, { maxWaitMs: MADE })); // the WebP exists
    let busy = true;
    deps.viewerBusy = () => busy;
    const o = { avif: true };
    await iv.variant(src, 256, o);
    assert.equal(o.avifPending, true);
    assert.equal(iv._internals.avifQueue.length, 1, "queued, not started: a viewer's encode is running");
    // the viewers are done — but a WebP is waiting: it goes first
    busy = false;
    const blocker = { client: null, run: () => Promise.resolve() };
    iv._internals.queue.push(blocker);
    iv._internals.pumpAvif();
    assert.equal(iv._internals.avifQueue.length, 1, "still queued behind the waiting WebP");
    iv._internals.queue.splice(iv._internals.queue.indexOf(blocker), 1);
    iv._internals.pumpAvif();
    assert.equal(iv._internals.avifQueue.length, 0, "started");
    await until(() => iv._internals.avifInflight.size === 0);
    const avif = await iv.variant(src, 256, { avif: true });
    made.add(avif);
    assert.match(avif, /-w256\.avif$/);
    assert.ok(iv._internals.avifStats.heldForViewers >= 1);
  } finally {
    deps.viewerBusy = real;
    await cleanUp(dir, made);
  }
});

test("a full AVIF queue is not joined: the WebP, not pending, and not looked for again for a while", { skip: !CAN }, async () => {
  await probeLanded();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-avif-full-"));
  const made = new Set();
  const deps = iv._internals.avifDeps;
  const real = deps.viewerBusy;
  const q = iv._internals.avifQueue;
  const fillers = [];
  try {
    const src = picture(dir);
    made.add(await iv.variant(src, 352, { maxWaitMs: MADE }));
    deps.viewerBusy = () => true; // nothing drains while the queue is filled by hand
    while (q.length < 400) { const f = { run: () => Promise.resolve(null) }; fillers.push(f); q.push(f); }
    const full = iv._internals.avifStats.full;
    const o = { avif: true };
    assert.match(await iv.variant(src, 352, o), /-w352\.webp$/);
    assert.equal(o.avifPending, undefined, "not on its way: the WebP is kept as long as ever");
    assert.equal(iv._internals.avifStats.full, full + 1);
    assert.ok(iv._internals.avifWait.size >= 1, "not asked again at once");
    const o2 = { avif: true };
    await iv.variant(src, 352, o2);
    assert.equal(iv._internals.avifStats.full, full + 1, "the second ask did not try again");
  } finally {
    for (const f of fillers) { const i = q.indexOf(f); if (i >= 0) q.splice(i, 1); }
    deps.viewerBusy = real;
    await cleanUp(dir, made);
  }
});

// ---- the routes: headers a cache can trust ---------------------------------

test("routes: Vary: Accept, a short life for the WebP while the AVIF is made, then image/avif; the TV's asks unchanged", { skip: !CAN }, async () => {
  await probeLanded();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-avif-route-"));
  const jpeg = fs.readFileSync(picture(dir, "art.jpg", "960x540"));
  const app = express();
  app.use(require("../src/routes/stream"));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const real = global.fetch;
  const url = `https://image.tmdb.org/t/p/original/avif-${crypto.randomBytes(4).toString("hex")}.jpg`;
  global.fetch = async (u, init) => (String(u).startsWith(base) ? real(u, init) : new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }));
  const cacheFile = path.join(config.CACHE_DIR, "posters-web", crypto.createHash("md5").update(url).digest("hex") + ".img");
  const get = async (q, accept) => {
    const res = await real(`${base}/img/ext?u=${encodeURIComponent(url)}${q}`, { headers: accept ? { accept } : {} });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), vary: res.headers.get("vary") || "", bytes: body.length };
  };
  const made = new Set();
  const before = new Set(fs.existsSync(iv.DIR) ? fs.readdirSync(iv.DIR) : []);
  try {
    assert.ok(require("../src/lib/imghosts").extAllowed(url), "a listed picture host");
    // the TV: no Accept → the WebP, a week, and Vary: Accept (the address answers by it)
    const tv = await get("&w=480");
    assert.equal(tv.status, 200);
    assert.equal(tv.type, "image/webp");
    assert.equal(tv.cache, "public, max-age=604800");
    assert.match(tv.vary, /accept/i);
    // a browser that decodes AVIF: the WebP now, for five minutes, while the AVIF is made
    const first = await get("&w=480", CHROME);
    assert.equal(first.type, "image/webp");
    assert.equal(first.cache, "public, max-age=300");
    assert.match(first.vary, /accept/i);
    await until(() => iv._internals.avifInflight.size === 0);
    const second = await get("&w=480", CHROME);
    assert.equal(second.type, "image/avif");
    assert.equal(second.cache, "public, max-age=604800");
    assert.match(second.vary, /accept/i);
    assert.ok(second.bytes > 512);
    // ?fmt=avif without the header; ?fmt=webp with it
    assert.equal((await get("&w=480&fmt=avif")).type, "image/avif");
    assert.equal((await get("&w=480&fmt=webp", CHROME)).type, "image/webp");
    // the TV's billboard (blurred): exactly as before — no AVIF, no Vary: Accept
    const blur = await get("&w=480&blur=2", CHROME);
    assert.equal(blur.type, "image/jpeg");
    assert.doesNotMatch(blur.vary, /accept/i);
    // no width: the original, no negotiation
    const orig = await get("", CHROME);
    assert.equal(orig.type, "image/jpeg");
    assert.doesNotMatch(orig.vary, /accept/i);
  } finally {
    await Promise.allSettled([...iv._internals.inflight.values(), ...iv._internals.avifInflight.values()]);
    for (const f of fs.readdirSync(iv.DIR)) if (!before.has(f)) made.add(path.join(iv.DIR, f));
    global.fetch = real;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    try { fs.unlinkSync(cacheFile); } catch {}
    await cleanUp(dir, made);
  }
});

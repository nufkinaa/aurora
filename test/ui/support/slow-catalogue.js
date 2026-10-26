// Preloaded (node -r, after the fence) into a private instance by the search
// tests (search-net.test.js): Cinemeta's search, as it was when "La Cocina"
// said "No results" and was found after leaving Search and coming back
// (2026-10-26) — answering, but slower than the page waits (2.5 s,
// lib/upstream.js), or not at all. Nothing of the app is changed; every other
// host still meets the fence and is refused (the fallbacks — TVMaze,
// Wikipedia — fail at once, as when they are down).
//
//   UI_SLOW_CATALOGUE=1    turns it on (the instance's env, ui-test-server opts.env)
//
// The test steers it at run time through <instance>/slow-catalogue.json:
//   { "mode": "slow", "delayMs": 3500 }   every search answered after delayMs
//   { "mode": "down" }                    every search refused
//   { "mode": "ok" }                      answered at once
// and it counts what was asked in <instance>/slow-catalogue-asked.json.
"use strict";
const fs = require("fs");
const path = require("path");

if (process.env.UI_SLOW_CATALOGUE === "1") {
  const root = process.cwd(); // the instance folder (ui-test-server starts it there)
  const CONTROL = path.join(root, "slow-catalogue.json");
  const ASKED = path.join(root, "slow-catalogue-asked.json");
  const control = () => {
    try { return JSON.parse(fs.readFileSync(CONTROL, "utf-8")); } catch { return { mode: "ok" }; }
  };
  const asked = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const TITLES = [
    { id: "tt27770001", name: "La Cocina", releaseInfo: "2024", type: "movie", genres: ["Drama"], description: "A kitchen in Times Square, one long lunch shift." },
    { id: "tt27770002", name: "Tampopo", releaseInfo: "1985", type: "movie", genres: ["Comedy"], description: "A noodle shop, and the perfect bowl of ramen." },
  ];
  const search = (type, q) => {
    const words = decodeURIComponent(q).toLowerCase().split(/\s+/).filter(Boolean);
    return TITLES.filter((t) => t.type === type && words.every((w) => t.name.toLowerCase().includes(w))).map((t) => ({
      ...t, poster: `https://images.metahub.space/poster/small/${t.id}/img`, imdbRating: "6.8",
    }));
  };
  // its poster: a warm made-up picture (a PNG made here, nothing on disk)
  const png = (w, h, px) => {
    const zlib = require("zlib");
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type), data]);
      const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
      return Buffer.concat([len, body, sum]);
    };
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  let poster = null;
  const posterRes = () => {
    if (!poster) poster = png(120, 180, (x, y) => [200 - y / 2, 70 + x / 3, 40 + y / 4].map((v) => Math.max(0, Math.min(255, Math.round(v)))));
    return new Response(poster, { status: 200, headers: { "content-type": "image/png", "content-length": String(poster.length) } });
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    let u = null;
    try { u = new URL(typeof input === "string" ? input : input.url); } catch {}
    if (u && u.host === "images.metahub.space" && /^\/poster\/[a-z]+\/tt2777000[12]\/img$/.test(u.pathname)) return posterRes();
    const m = u && u.host === "v3-cinemeta.strem.io" && /^\/catalog\/(movie|series)\/top\/search=(.+)\.json$/.exec(u.pathname);
    if (!m) return realFetch(input, init);
    const c = control();
    asked.push({ at: Date.now(), type: m[1], q: decodeURIComponent(m[2]), mode: c.mode });
    try { fs.writeFileSync(ASKED, JSON.stringify(asked)); } catch {}
    if (c.mode === "down") throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    if (c.mode === "slow") await new Promise((r) => setTimeout(r, Number(c.delayMs) || 3500));
    return json({ metas: search(m[1] === "series" ? "show" : "movie", m[2]) });
  };
  process.stdout.write("[slow-catalogue] Cinemeta's search is a stand-in (mode from slow-catalogue.json)\n");
}

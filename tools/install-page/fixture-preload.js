// Preloaded (node -r) into the screenshot instance, after the UI tests' own
// fence (test/ui/support/server-preload.js: no outbound network at all). It
// answers the two outside services Home is built from with the invented
// catalogue (catalogue.js) and its painted artwork (make-art.py), exactly the
// way tools/mobile-perf/fixture-preload.js does — but every title gets its
// OWN poster and backdrop, with its own name on it.
//
//   IP_ART_DIR     the folder make-art.py wrote
//   IP_CATALOGUE   this folder's catalogue.js
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cat = require(process.env.IP_CATALOGUE);

const ART = process.env.IP_ART_DIR;
const STILLS = fs.readdirSync(ART).filter((f) => f.startsWith("still-")).sort();
const pick = (list, key) => list[parseInt(crypto.createHash("md5").update(key).digest("hex").slice(0, 8), 16) % list.length];

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const image = (file) => {
  const p = path.join(ART, file);
  if (!fs.existsSync(p)) return new Response("", { status: 404 });
  const buf = fs.readFileSync(p);
  return new Response(buf, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(buf.length) } });
};

const answer = (u) => {
  if (u.host === "v3-cinemeta.strem.io") {
    if (u.pathname === "/manifest.json") {
      const extra = [{ name: "genre", options: cat.GENRES }];
      return json({ catalogs: [{ type: "movie", id: "top", extra }, { type: "series", id: "top", extra }] });
    }
    let m = /^\/meta\/(movie|series)\/(tt\d+)\.json$/.exec(u.pathname);
    if (m) {
      const meta = cat.meta(m[1], m[2]);
      return meta ? json({ meta }) : new Response("{}", { status: 404 });
    }
    m = /^\/catalog\/(movie|series)\/([A-Za-z]+)(?:\/(.+))?\.json$/.exec(u.pathname);
    if (m) {
      const extra = Object.fromEntries(decodeURIComponent(m[3] || "").split("&").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
      return json({ metas: cat.page(m[1], m[2], { genre: extra.genre || "", skip: Number(extra.skip || 0), search: extra.search || "" }) });
    }
    return new Response("{}", { status: 404 });
  }
  if (u.host === "episodes.metahub.space") {
    return /^\/tt\d+\/\d+\/\d+\/w780\.jpg$/.test(u.pathname) ? image(pick(STILLS, u.pathname)) : new Response("", { status: 404 });
  }
  if (u.host === "images.metahub.space") {
    const m = /^\/(poster|background|logo)\/[a-z]+\/(tt\d+)\/img$/.exec(u.pathname);
    if (!m || m[1] === "logo") return new Response("", { status: 404 });
    return image(`${m[1] === "poster" ? "poster" : "backdrop"}-${m[2]}.jpg`);
  }
  return null;
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let u = null;
  try { u = new URL(typeof input === "string" ? input : input.url); } catch {}
  const res = u ? answer(u) : null;
  return res || realFetch(input, init);
};
process.stdout.write(`[install-page] catalogue fixture on: ${cat.CATALOGUE.movie.length} films, ${cat.CATALOGUE.series.length} series\n`);

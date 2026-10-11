// Preloaded (node -r) into the mobile-perf harness's private instance, after
// the UI tests' own fence (test/ui/support/server-preload.js: no outbound
// network at all). The app is not changed. This file stands in for the two
// outside services a real Home is built from, so the private instance has a
// realistically large catalogue with nothing leaving the machine:
//
//   v3-cinemeta.strem.io    catalogue pages, genres, a title's page  -> catalogue.js
//   images.metahub.space    posters, backdrops                       -> the made-up
//   episodes.metahub.space  episode stills                              pictures in MP_ART_DIR (make-art.py)
//
// Every other host still meets the fence and is refused, exactly as in the
// tests. MP_UPSTREAM_MS (optional) delays these answers, to stand for a
// catalogue that is slow to reply.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cat = require(process.env.MP_CATALOGUE);

const ART = process.env.MP_ART_DIR;
const DELAY = Number(process.env.MP_UPSTREAM_MS || 0);
const files = (prefix) => fs.readdirSync(ART).filter((f) => f.startsWith(prefix)).sort();
const POSTERS = files("poster-");
const BACKDROPS = files("backdrop-");
const STILLS = files("still-");
const pick = (list, key) => list[parseInt(crypto.createHash("md5").update(key).digest("hex").slice(0, 8), 16) % list.length];

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const image = (file) => {
  const buf = fs.readFileSync(path.join(ART, file));
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
    if (m[1] === "poster") return image(pick(POSTERS, m[2]));
    return image(pick(BACKDROPS, m[2]));
  }
  return null;
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let u = null;
  try { u = new URL(typeof input === "string" ? input : input.url); } catch {}
  const res = u ? answer(u) : null;
  if (!res) return realFetch(input, init);
  if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
  return res;
};
process.stdout.write(`[mobile-perf] catalogue fixture on: ${cat.CATALOGUE.movie.length} films, ${cat.CATALOGUE.series.length} series, ${POSTERS.length} posters, ${BACKDROPS.length} backdrops\n`);

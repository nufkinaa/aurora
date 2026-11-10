// Preloaded after tools/mobile-perf/fixture-preload.js (which answers every
// poster address with the same file): the catalogue's LARGE poster gets the
// large drawing (artswap-art.py's posterL-*), so a hero that moves from the
// small poster to the large one really gets a sharper picture.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ART = process.env.MP_ART_DIR;
const LARGE = fs.readdirSync(ART).filter((f) => f.startsWith("posterL-")).sort();
const pick = (list, key) => list[parseInt(crypto.createHash("md5").update(key).digest("hex").slice(0, 8), 16) % list.length];

const inner = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let u = null;
  try { u = new URL(typeof input === "string" ? input : input.url); } catch {}
  const m = u && u.host === "images.metahub.space" && LARGE.length ? /^\/poster\/large\/(tt\d+)\/img$/.exec(u.pathname) : null;
  if (!m) return inner(input, init);
  const buf = fs.readFileSync(path.join(ART, pick(LARGE, m[1])));
  return new Response(buf, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(buf.length) } });
};
process.stdout.write(`[artswap] large posters on: ${LARGE.length}\n`);

// Blur-up placeholders (elia, 2026-10-07): a poster slot shows the picture's
// colours and rough shape from the first frame, and the real picture sharpens
// over it, instead of a grey shimmer.
//
// For every picture address the API hands out (cover / poster / backdrop) the
// server keeps a 16-pixel-wide WebP of it — about 150 bytes — as a data: URI.
// A JSON answer to a client that asks (header `X-Blur: 1`) gains one extra
// top-level field, `_blur: { "<picture address>": "data:image/webp;base64,…" }`,
// for the pictures in it whose placeholder is already known. Unknown ones are
// queued and made in the background, so the first visit to a new row costs
// nothing and the second has them. Clients that do not ask (the TV app, older
// tabs) get exactly the payload they always got.
//
// Made by fetching the picture from this server's own image routes (one code
// path for library covers, cached metadata posters and proxied catalogue art)
// and shrinking it with ffmpeg, the tool the variants and stills already use.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const config = require("../config");

const DIR = path.join(config.CACHE_DIR, "blur");
try {
  fs.mkdirSync(DIR, { recursive: true });
} catch {}

const WIDTH = 16;
const MAX_PER_RESPONSE = 120; // the hero and the first rows of a page: ~35 KB beside the answer, less gzipped
const MAX_CONCURRENT = 2;
const FAIL_TTL = 6 * 3600 * 1000;
const KEYS = ["cover", "poster", "backdrop"];

const mem = new Map(); // picture address -> data URI
const failed = new Map(); // picture address -> failedAt
const queued = new Set();
const queue = [];
let running = 0;

const fileFor = (u) => path.join(DIR, crypto.createHash("md5").update(u).digest("hex") + ".b64");

// The address this server's own image routes answer for a picture, small.
const localUrl = (u) => {
  if (u.startsWith("/img/")) return /^\/img\/(?:meta\/)?[A-Za-z0-9._-]+$/.test(u) ? `${u}?w=240` : u;
  if (!u.startsWith("https://")) return null;
  // /img/ext keeps its own list of hosts it will fetch from; one it refuses
  // simply fails here and is not asked again for a while
  return `/img/ext?u=${encodeURIComponent(u)}&w=240`;
};

const shrink = (buf) =>
  new Promise((resolve, reject) => {
    if (!config.FFMPEG) return reject(new Error("no ffmpeg"));
    const ff = spawn(
      config.FFMPEG,
      ["-v", "error", "-i", "pipe:0", "-vf", `scale=${WIDTH}:-2`, "-frames:v", "1", "-c:v", "libwebp", "-quality", "40", "-f", "webp", "pipe:1"],
      { windowsHide: true },
    );
    const out = [];
    const timer = setTimeout(() => ff.kill(), 15000);
    ff.stdout.on("data", (d) => out.push(d));
    ff.on("error", (e) => { clearTimeout(timer); reject(e); });
    ff.on("close", (code) => {
      clearTimeout(timer);
      const b = Buffer.concat(out);
      if (code !== 0 || b.length < 30 || b.length > 4000) return reject(new Error(`ffmpeg ${code}, ${b.length} bytes`));
      resolve(b);
    });
    ff.stdin.on("error", () => {});
    ff.stdin.end(buf);
  });

const make = async (u) => {
  const local = localUrl(u);
  if (!local) throw new Error("not a picture this server serves");
  // The server asking itself: in closed mode the sign-in wall answered this
  // 401 like any stranger (no placeholder for anyone, and a log full of
  // "[auth] 401 /img ua=node"). It carries this process's own pass instead.
  const r = await fetch(`http://127.0.0.1:${config.PORT}${local}`, {
    signal: AbortSignal.timeout(20000),
    headers: { [require("./internalpass").HEADER]: require("./internalpass").value },
  });
  if (!r.ok) throw new Error(`picture answered ${r.status}`);
  const webp = await shrink(Buffer.from(await r.arrayBuffer()));
  const uri = `data:image/webp;base64,${webp.toString("base64")}`;
  mem.set(u, uri);
  fs.writeFile(fileFor(u), uri, () => {});
  return uri;
};

const pump = () => {
  while (running < MAX_CONCURRENT && queue.length) {
    const u = queue.shift();
    running++;
    make(u)
      .catch(() => failed.set(u, Date.now()))
      .finally(() => {
        queued.delete(u);
        running--;
        pump();
      });
  }
};

// The placeholder if it is known; otherwise null — and it is on its way.
const get = (u) => {
  if (typeof u !== "string" || u.length > 600) return null;
  const hit = mem.get(u);
  if (hit) return hit;
  if (queued.has(u)) return null;
  if (Date.now() - (failed.get(u) || 0) < FAIL_TTL) return null;
  if (!localUrl(u)) return null;
  queued.add(u);
  // a restart finds yesterday's on disk — cheap, async, never blocks a request
  fs.readFile(fileFor(u), "utf8", (err, text) => {
    if (!err && text.startsWith("data:image/")) {
      mem.set(u, text);
      queued.delete(u);
      return;
    }
    if (queue.length > 2000) return queued.delete(u); // a flood: let it be asked again later
    queue.push(u);
    pump();
  });
  return null;
};

// Every picture address in a JSON answer, in the order it appears: posters
// and covers in one set, backdrops in another.
const collect = (node, out, depth = 0, wide = null) => {
  if (!node || typeof node !== "object" || depth > 8 || out.size > 1200) return;
  if (Array.isArray(node)) {
    for (const x of node) collect(x, out, depth + 1, wide);
    return;
  }
  for (const k of KEYS) {
    const v = node[k];
    if (typeof v === "string" && v) (k === "backdrop" && wide ? wide : out).add(v);
  }
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === "object") collect(v, out, depth + 1, wide);
  }
};

// What a page draws first decides the order: the first few backdrops (the
// hero's slides), then every poster — a card is a poster — then the rest of
// the backdrops while there is room.
const HERO_BACKDROPS = 8;
const annotate = (body) => {
  const posters = new Set();
  const backdrops = new Set();
  collect(body, posters, 0, backdrops);
  if (!posters.size && !backdrops.size) return null;
  const wide = [...backdrops];
  const order = [...wide.slice(0, HERO_BACKDROPS), ...posters, ...wide.slice(HERO_BACKDROPS)];
  const map = {};
  let n = 0;
  for (const u of order) {
    const uri = get(u); // asked for all of them, so the next answer has more
    if (uri && n < MAX_PER_RESPONSE && !(u in map)) {
      map[u] = uri;
      n++;
    }
  }
  return n ? map : null;
};

// Express middleware: GET /api/* answers for a client that asked.
const middleware = (req, res, next) => {
  if (req.method !== "GET" || req.get("X-Blur") !== "1" || !req.path.startsWith("/api/") || req.path.startsWith("/api/admin")) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    try {
      if (body && typeof body === "object" && !Array.isArray(body) && res.statusCode === 200 && body._blur === undefined) {
        const map = annotate(body);
        if (map) return json({ ...body, _blur: map });
      }
    } catch {}
    return json(body);
  };
  next();
};

module.exports = { middleware, get, annotate, _internals: { collect, localUrl, mem, shrink, make } };

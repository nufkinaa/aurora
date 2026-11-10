// Viewing histories for Aurora Wrapped: what data/watch-sessions.json holds
// after a year of real use, written before a private instance boots (the
// story is drawn from those sessions — src/telemetry.js wrappedFor).
//
//   const ws = require("./support/wrapped-seed");
//   start({ seed: ws.seed({ rich: "Maya", tiny: "Tom", huge: "Omer" }) })
//
// Four shapes of a year, each for a profile NAME (sessions are filed by name):
//   rich   ~150 sittings over ten months: Friday nights, a handful after
//          midnight, a twelve-day streak, one six-hour day, a clear top show
//          (~40 % of the hours), a Hebrew title in the top five, a title with
//          no picture, the TV and a phone
//   tiny   one sitting of 42 minutes, yesterday
//   huge   ~2,000 sittings, 60 titles, one with a very long name — the
//          numbers at their widest
//   (empty: a profile with no sessions at all — nothing to seed)
// Genres: online-metadata.json, filed the way a looked-up title keeps them.
// Posters: the calendar showcase's drawn posters (SVG text, posterSvgs())
// rendered to PNG by the caller — the picture route sends what it sniffs, and
// an SVG is not one of those — passed in as { pngs: { imdbId: Buffer } },
// written to data/cache/posters and named in the metadata (the server's
// /img/meta/<name>). Without them every title is a title without a picture.
// Deterministic: the same seed draws the same year (relative to today).
"use strict";

const showcase = require("./calendar-showcase");

// [title, type, genres, imdbId (null: no poster)]
const TITLES = [
  ["Northern Static", "show", ["Sci-Fi", "Thriller", "Mystery"], "tt8300002"],
  ["Low Orbit", "show", ["Sci-Fi", "Drama"], "tt8300004"],
  ["Kingdom of Ash", "show", ["Fantasy", "Drama", "Action"], "tt8300003"],
  ["הבית ברחוב הירקון", "show", ["Drama", "Comedy"], "tt8300008"],
  ["Ember & Frost", "movie", ["Romance", "Drama"], "tt8300009"],
  ["Signal Lost", "movie", ["Thriller", "Horror"], "tt8300010"],
  ["Velvet District", "show", ["Crime", "Drama"], "tt8300006"],
  ["Arcadia Bay", "movie", ["Comedy"], "tt8300011"],
  ["Paper Lanterns", "movie", ["Animation", "Family"], "tt8300012"],
  ["Midnight Signal", "show", ["Horror", "Mystery"], "tt8300013"],
  ["The Salt Road", "show", ["Adventure", "Drama"], "tt8300001"],
  ["Small Hours", "movie", ["Comedy", "Drama"], null],
];
const LONG_TITLE = "The Unbelievably Long and Winding Chronicles of the Lighthouse Keeper's Third Daughter";

// a small seeded random (mulberry32)
const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const DAY = 86400000;
// local midnight `daysAgo` days before today, plus `hour` (may pass 24)
const at = (daysAgo, hour, minute = 0) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return new Date(d.getTime() + (hour * 60 + minute) * 60000);
};

let n = 0;
const session = (profile, title, type, start, sec, device, ep) => {
  const content = type === "show" ? `${title} · S${ep[0]} E${ep[1]}` : title;
  const startedAt = start.toISOString();
  const endedAt = new Date(start.getTime() + sec * 1000).toISOString();
  return {
    id: `ws${(++n).toString(16).padStart(10, "0")}`,
    clientId: `seed-${device}`,
    profile,
    profileId: null,
    ip: "192.168.1.20",
    device: { device, browser: device === "TV" ? "Aurora TV" : "Safari", os: device === "TV" ? "Android TV" : "iOS" },
    content,
    startedAt, updatedAt: endedAt, lastPlayAt: endedAt, endedAt,
    watchedSec: Math.round(sec),
    position: Math.round(sec), duration: Math.round(sec * 1.1),
    state: "paused", acct: 2, live: false, endReason: "next",
  };
};

// The rich year. Hand-placed moments first (the streak, the big day, the
// late finishes), then ordinary evenings around them.
const richYear = (profile) => {
  const r = rng(7);
  const out = [];
  const pick = (weights) => {
    let x = r() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; }
    return weights.length - 1;
  };
  const W = [40, 12, 10, 14, 5, 5, 4, 3, 3, 3, 3, 2]; // share of evenings per title
  const eps = new Map();
  const nextEp = (t) => { const e = (eps.get(t) || 0) + 1; eps.set(t, e); return [1 + Math.floor((e - 1) / 8), 1 + ((e - 1) % 8)]; };
  const add = (daysAgo, hour, minute, ti, min, device) => {
    const [title, type] = TITLES[ti];
    out.push(session(profile, title, type, at(daysAgo, hour, minute), min * 60, device, type === "show" ? nextEp(title) : null));
  };
  // the twelve-day streak, ~2 months ago
  for (let d = 0; d < 12; d++) add(70 - d, 21, 10 + d * 3, d % 3 === 2 ? 1 : 0, 48 + (d % 4) * 9, "TV");
  // the six-hour Saturday (Kingdom of Ash, back to back)
  for (let k = 0; k < 6; k++) add(118, 14 + k, 5, 2, 58, "TV");
  // the longest sitting: Ember & Frost's extended cut, 3 h 41 m
  add(201, 20, 30, 4, 221, "TV");
  // after midnight, six times — one finish at 4 am
  add(33, 24 + 1, 15, 0, 52, "Mobile");
  add(47, 24 + 0, 40, 9, 61, "Mobile");
  add(88, 24 + 2, 5, 0, 49, "Mobile");
  add(140, 24 + 3, 10, 5, 58, "Mobile");
  add(160, 24 + 1, 30, 0, 44, "Mobile");
  add(230, 24 + 0, 20, 9, 55, "TV");
  // ordinary evenings over ten months, Fridays heaviest
  for (let i = 0; out.length < 152; i++) {
    const daysAgo = 3 + Math.floor(r() * 295);
    const wd = at(daysAgo, 0).getDay();
    if (wd !== 5 && wd !== 6 && r() < 0.42) continue; // weekends win
    const ti = pick(W);
    const hour = 19 + Math.floor(r() * 4);
    add(daysAgo, hour, Math.floor(r() * 60), ti, 22 + Math.floor(r() * 55), r() < 0.62 ? "TV" : "Mobile");
  }
  return out;
};

const tinyYear = (profile) => [session(profile, "Arcadia Bay", "movie", at(1, 20, 12), 42 * 60, "Mobile", null)];

const hugeYear = (profile) => {
  const r = rng(99);
  const names = [LONG_TITLE, ...TITLES.map((t) => t[0])];
  for (let i = names.length; i < 60; i++) names.push(`Title Number ${i}`);
  const out = [];
  for (let i = 0; i < 2000; i++) {
    const ti = Math.floor(Math.pow(r(), 2.2) * names.length);
    const daysAgo = Math.floor(r() * 330);
    out.push(session(profile, names[ti], ti % 3 ? "show" : "movie", at(daysAgo, 12 + Math.floor(r() * 14), Math.floor(r() * 60)),
      (30 + Math.floor(r() * 90)) * 60, ["TV", "Mobile", "Desktop"][Math.floor(r() * 3)], [1 + (i % 6), 1 + (i % 10)]));
  }
  // every day of the last 40 in a row: a long streak
  for (let d = 0; d < 40; d++) out.push(session(profile, names[1], "show", at(d + 2, 22), 50 * 60, "TV", [9, d + 1]));
  return out;
};

// online-metadata.json: genres (and a poster where there is one) for every
// title, filed the way src/media/online.js keeps a looked-up title.
const onlineMeta = (pngs) => {
  const out = {};
  for (const [title, type, genres, id] of TITLES) {
    out[`${type}|${title.toLowerCase().trim()}`] = { title, year: 2025, genres, ...(id && pngs[id] ? { poster: `${id}.png` } : {}), fetchedAt: Date.now() };
  }
  out[`movie|${LONG_TITLE.toLowerCase()}`] = { title: LONG_TITLE, year: 2024, genres: ["Drama", "History"], fetchedAt: Date.now() };
  return out;
};

// The files to write into data/ before boot. `names`: { rich, tiny, huge, kids }
// profile names (any may be left out). `pngs`: posters by IMDb id. Extra
// files: `more`.
const seed = (names = {}, { pngs = {}, more = {} } = {}) => {
  n = 0;
  const sessions = [
    ...(names.rich ? richYear(names.rich) : []),
    ...(names.tiny ? tinyYear(names.tiny) : []),
    ...(names.huge ? hugeYear(names.huge) : []),
    ...(names.kids ? richYear(names.kids) : []), // (a kids profile with the same year)
  ].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)); // newest first, as the store keeps them
  const files = { "watch-sessions.json": sessions, "online-metadata.json": onlineMeta(pngs), ...more };
  for (const [id, png] of Object.entries(pngs)) files[`cache/posters/${id}.png`] = png;
  return files;
};

// { imdbId: svgText } for the titles that have a poster
const posterSvgs = () => {
  const all = showcase.posters();
  return Object.fromEntries(TITLES.filter((t) => t[3]).map((t) => [t[3], all[t[3]]]));
};

// A plain PNG of one colour (w×h), made here: a poster file for tests that
// need a real picture without a browser to draw one.
const zlib = require("zlib");
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const plainPng = (w = 40, h = 60, [r, g, b] = [40, 60, 140]) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};

module.exports = { seed, posterSvgs, plainPng, TITLES, LONG_TITLE, richYear, tinyYear, hugeYear };

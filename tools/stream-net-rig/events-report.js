#!/usr/bin/env node
// Tables for the events matrix (round2.sh): what each event cost, per line ×
// film, medians over the plays — and "before → after" when given two labels.
//
//   node tools/stream-net-rig/events-report.js before-seek            one build
//   node tools/stream-net-rig/events-report.js before-seek after-seek before → after
//   (--md: Markdown tables)
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const load = (label) => {
  const f = path.join(__dirname, ".runs", `${label}.jsonl`);
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const med = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const sec = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
const evName = (e) => `${e.kind}${e.arg ? " " + e.arg : ""}`;

const summarize = (rows) => {
  const cells = new Map();
  for (const r of rows) {
    // (plays with different events are different cells: a Wi-Fi drop's play is not a restart's)
    const sig = (r.events || []).filter((e) => e.kind !== "seek").map((e) => `${e.kind}${e.arg ? " " + e.arg : ""}`).join(",");
    const key = `${r.flavour || "web"}|${r.profile}|${r.title}${sig ? " (" + sig + ")" : ""}`;
    if (!cells.has(key)) cells.set(key, { rows: [], events: new Map() });
    const c = cells.get(key);
    c.rows.push(r);
    for (const e of r.events || []) {
      const k = `${evName(e)}@${e.at}`;
      if (!c.events.has(k)) c.events.set(k, []);
      c.events.get(k).push(e);
    }
  }
  const out = new Map();
  for (const [key, c] of cells) {
    const ok = c.rows.filter((r) => r.ok);
    const s = {
      plays: c.rows.length,
      ok: ok.length,
      ttff: med(ok.map((r) => r.ttff)),
      stallMs: med(ok.map((r) => r.stallMs)),
      stalls: med(ok.map((r) => r.stalls)),
      avgH: med(ok.map((r) => r.avgHeight)),
      top: med(ok.map((r) => r.shareTop)),
      enc: c.rows.reduce((n, r) => n + (r.encodeStarts || 0), 0),
      stuck: ok.filter((r) => !r.endPlaying).length,
      rebuf: med(ok.map((r) => (r.playedSec > 0 ? r.stallMs / 1000 / (r.playedSec + r.stallMs / 1000) : null))),
      // the clock standing still outside a seek's own landing (a landing is the seek's time, not a rebuffer)
      exSeek: med(ok.map((r) => Math.max(0, r.stallMs - (r.events || []).filter((e) => e.kind === "seek").reduce((n, e) => n + (e.seekMs || 0), 0)))),
      events: new Map(),
    };
    for (const [k, es] of c.events) {
      const seek = es[0].kind === "seek";
      s.events.set(k, seek
        ? { seek: true, ms: med(es.map((e) => e.seekMs)), moving: med(es.map((e) => e.movingMs)), stall: med(es.map((e) => e.stallMs)), inBuf: es.filter((e) => e.inBuffer).length, n: es.length, missed: es.filter((e) => e.seekMs == null).length }
        : { seek: false, recover: med(es.map((e) => e.recoverMs)), stall: med(es.map((e) => e.stallMs)), stalls: med(es.map((e) => e.stalls)), ahead: med(es.map((e) => e.ahead)), out: med(es.map((e) => e.outMs)), n: es.length });
    }
    out.set(key, s);
  }
  return out;
};

const [a, b] = args;
const A = summarize(load(a));
const B = b ? summarize(load(b)) : null;
const arrow = (x, y, f) => (B ? `${f(x)} → **${f(y)}**` : f(x));
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const pct2 = (x) => (x == null ? "–" : `${(x * 100).toFixed(2)}%`);
const num = (x) => (x == null ? "–" : String(Math.round(x * 10) / 10));

console.log(`\n### Plays (${a}${b ? " → " + b : ""})\n`);
console.log("| flavour | line | film | plays | first frame | stalled (count) | stalled outside seek landings | rebuffer ratio | avg height | at full height | encoder starts (all plays) | stuck at the end |");
console.log("|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
for (const [key, s] of A) {
  const t = B ? B.get(key) : null;
  if (B && !t) continue;
  const [fl, prof, title] = key.split("|");
  const x = t || s;
  console.log(`| ${fl} | ${prof} | ${title} | ${s.plays}${t ? " / " + t.plays : ""} | ${arrow(s.ttff, x.ttff, sec)} | ${arrow(s.stallMs, x.stallMs, sec)} (${arrow(s.stalls, x.stalls, num)}) | ${arrow(s.exSeek, x.exSeek, sec)} | ${arrow(s.rebuf, x.rebuf, pct2)} | ${arrow(s.avgH, x.avgH, (h) => (h == null ? "–" : `${Math.round(h)}p`))} | ${arrow(s.top, x.top, pct)} | ${arrow(s.enc, x.enc, String)} | ${arrow(s.stuck, x.stuck, String)} |`);
}
const evRows = [];
for (const [key, s] of A) {
  const t = B ? B.get(key) : null;
  if (B && !t) continue;
  for (const [k, e] of s.events) {
    const f = t ? t.events.get(k) : null;
    if (B && !f) continue;
    evRows.push({ key, k, e, f: f || e });
  }
}
const seeks = evRows.filter((r) => r.e.seek);
if (seeks.length) {
  console.log(`\n### Seeks — from the press to the first frame at the target (median)\n`);
  console.log("| flavour | line | film | seek | inside the buffer | to the picture | to moving | stalled after |");
  console.log("|---|---|---|---|--:|--:|--:|--:|");
  for (const { key, k, e, f } of seeks) {
    const [fl, prof, title] = key.split("|");
    console.log(`| ${fl} | ${prof} | ${title} | ${k} | ${e.inBuf}/${e.n}${B ? ` → ${f.inBuf}/${f.n}` : ""} | ${arrow(e.ms, f.ms, sec)}${e.missed || f.missed ? ` (missed ${e.missed}${B ? "→" + f.missed : ""})` : ""} | ${arrow(e.moving, f.moving, sec)} | ${arrow(e.stall, f.stall, sec)} |`);
  }
}
const nets = evRows.filter((r) => !r.e.seek);
if (nets.length) {
  console.log(`\n### Line and server events (median; "back to moving" = the line or server back → the clock moving again, 0 = the buffer carried it)\n`);
  console.log("| flavour | line | film | event | held ahead | out for | stalled (count) | back to moving |");
  console.log("|---|---|---|---|--:|--:|--:|--:|");
  for (const { key, k, e, f } of nets) {
    const [fl, prof, title] = key.split("|");
    console.log(`| ${fl} | ${prof} | ${title} | ${k} | ${arrow(e.ahead, f.ahead, (x) => (x == null ? "–" : `${Math.round(x)} s`))} | ${sec(e.out)} | ${arrow(e.stall, f.stall, sec)} (${arrow(e.stalls, f.stalls, num)}) | ${arrow(e.recover, f.recover, sec)} |`);
  }
}

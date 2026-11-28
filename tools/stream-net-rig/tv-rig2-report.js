#!/usr/bin/env node
// Tables from tv-rig2.js rows: medians per cell (title, mode, source, resume).
//   node tools/stream-net-rig/tv-rig2-report.js base [after]
"use strict";
const fs = require("fs");
const path = require("path");
const load = (label) => {
  const f = path.join(__dirname, ".runs", `${label}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const med = (a) => {
  const v = a.filter((x) => typeof x === "number" && isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};
const key = (r) => `${r.title}|${r.mode}|${r.source}|${r.resumeAt}`;
const cells = (rows) => {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(key(r))) out.set(key(r), []);
    out.get(key(r)).push(r);
  }
  return out;
};
const sum = (rs) => {
  const seeks = {};
  for (const r of rs) for (const [i, s] of (r.seeks || []).entries()) (seeks[i] = seeks[i] || []).push(s);
  return {
    n: rs.length,
    ff: med(rs.map((r) => r.firstFrameMs)),
    mount: med(rs.map((r) => r.mountToFrameMs)),
    boot: med(rs.map((r) => r.coldBootMs)),
    start: med(rs.map((r) => (r.startPos != null ? Math.round(r.startPos * 10) : null))),
    stalls: med(rs.map((r) => r.stalls)),
    stallMs: med(rs.map((r) => r.stallMs)),
    ratio: med(rs.map((r) => (r.rebufferRatio != null ? Math.round(r.rebufferRatio * 10000) : null))),
    seeks: Object.values(seeks).map((ss) => ({ to: ss[0].to, press: med(ss.map((s) => s.pictureMs)), commit: med(ss.map((s) => s.fromCommitMs)) })),
    blips: rs.flatMap((r) => r.blips || []),
  };
};
const fmt = (s) => {
  if (!s) return "—";
  const p = [`${s.n}×`, `ff ${s.ff}`];
  if (s.boot != null) p.push(`(boot ${s.boot} + player ${s.mount})`);
  if (s.start != null) p.push(`start ${s.start / 10}`);
  p.push(`stalls ${s.stalls} / ${s.stallMs} ms (${s.ratio != null ? (s.ratio / 100).toFixed(2) : "?"} %)`);
  if (s.seeks.length) p.push("seeks " + s.seeks.map((k) => `→${k.to}: ${k.press} (${k.commit} after commit)`).join(", "));
  if (s.blips.length) p.push("blips " + s.blips.map((b) => `${b.kind}${b.secs}s stalled ${b.stalledMs} back ${b.backAfterMs}`).join("; "));
  return p.join(" · ");
};
const [a, b] = process.argv.slice(2);
const A = cells(load(a));
const B = b ? cells(load(b)) : new Map();
for (const k of new Set([...A.keys(), ...B.keys()])) {
  console.log(k.replace(/\|/g, "  "));
  console.log(`   ${a}: ${fmt(A.has(k) ? sum(A.get(k)) : null)}`);
  if (b) console.log(`   ${b}: ${fmt(B.has(k) ? sum(B.get(k)) : null)}`);
}

#!/usr/bin/env node
// The tables of the report, from what the scripts wrote.
//
//   node tools/mobile-perf/summary.js <label>                 one version
//   node tools/mobile-perf/summary.js <before> <after>        side by side, "before → after"
//       [--only lh,net,cpu,interact,session]
//
// Prints Markdown. Medians; where a spread is shown it is min–max over the runs.
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "out");
const labels = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== (process.argv[process.argv.indexOf("--only") + 1] || "\0"));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const want = (k) => !only || only.includes(k);
const [A, B] = labels;

const read = (label, kind) => {
  const dir = path.join(OUT, label, kind);
  const out = {};
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json") || f.endsWith(".report.json") || f.endsWith(".trace.json")) continue;
      out[f.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    }
  } catch {}
  return out;
};
const md = (x) => (x == null ? null : typeof x === "object" ? x.median : x);
const r0 = (v) => (v == null ? "–" : String(Math.round(v)));
const sec = (v) => (v == null ? "–" : (v / 1000).toFixed(v < 9950 ? 1 : 0) + " s");
const kb = (v) => (v == null ? "–" : Math.round(v / 1024) + " KB");
const pair = (a, b, fmt = r0) => (B ? `${fmt(a)} → ${fmt(b)}` : fmt(a));
const range = (x, fmt = r0) => (x && x.min != null && x.min !== x.max ? ` (${fmt(x.min)}–${fmt(x.max)})` : "");
const table = (head, rows) => {
  if (!rows.length) return;
  console.log(`| ${head.join(" | ")} |`);
  console.log(`|${head.map((_, i) => (i ? "---:" : "---")).join("|")}|`);
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
  console.log("");
};
const keys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b || {})])].sort();

if (want("lh")) {
  const a = read(A, "lh"), b = B ? read(B, "lh") : {};
  const ks = keys(a, b);
  if (ks.length) {
    console.log(`### Lighthouse${B ? ` — ${A} → ${B}` : ""}\n`);
    table(["route · look · profile · cache", "score", "FCP", "LCP", "TBT ms", "CLS", "Speed Index", "weight", "requests"], ks.map((k) => {
      const x = a[k] || {}, y = b[k] || {};
      return [k.replace(/\./g, " · "),
        B ? `**${r0(md(x.score))}**${range(x.score)} → **${r0(md(y.score))}**${range(y.score)}` : `**${r0(md(x.score))}**${range(x.score)}`,
        pair(md(x.fcp), md(y.fcp), sec), pair(md(x.lcp), md(y.lcp), sec), pair(md(x.tbt), md(y.tbt)),
        pair(md(x.cls), md(y.cls), (v) => (v == null ? "–" : v.toFixed(3))), pair(md(x.si), md(y.si), sec), pair(md(x.bytes), md(y.bytes), kb), pair(md(x.requests), md(y.requests))];
    }));
  }
}

if (want("net")) {
  const a = read(A, "net"), b = B ? read(B, "net") : {};
  const ks = keys(a, b);
  if (ks.length) {
    console.log(`### On a slow line${B ? ` — ${A} → ${B}` : ""}\n`);
    table(["line · route · look · cache", "first paint", "usable", "billboard picture", "first screen complete", "LCP", "wire quiet", "before usable", "in all"], ks.map((k) => {
      const x = a[k] || {}, y = b[k] || {};
      const bu = (z) => (z.beforeUsable ? `${r0(md(z.beforeUsable.n))} req / ${kb(md(z.beforeUsable.bytes))}` : "–");
      const tot = (z) => (z.total ? `${r0(md(z.total.n))} req / ${kb(md(z.total.bytes))}` : "–");
      return [k.replace(/\./g, " · "), pair(md(x.fcp), md(y.fcp), sec), `**${pair(md(x.usable), md(y.usable), sec)}**`, pair(md(x.heroPicture), md(y.heroPicture), sec),
        pair(md(x.viewport), md(y.viewport), sec), pair(md(x.lcp), md(y.lcp), sec), pair(md(x.quiet), md(y.quiet), sec), B ? `${bu(x)} → ${bu(y)}` : bu(x), B ? `${tot(x)} → ${tot(y)}` : tot(x)];
    }));
  }
}

if (want("cpu")) {
  const a = read(A, "cpu"), b = B ? read(B, "cpu") : {};
  const ks = keys(a, b);
  if (ks.length) {
    console.log(`### On a slow phone: the load${B ? ` — ${A} → ${B}` : ""}\n`);
    table(["route · look (CPU ÷)", "usable", "LCP", "blocking ms", "main thread ms", "script", "style", "layout", "paint+composite", "long tasks", "layouts (forced)"], ks.map((k) => {
      const x = a[k] || {}, y = b[k] || {};
      const kk = (z, n) => (z.kinds && z.kinds[n] ? md(z.kinds[n]) : 0);
      const pc = (z) => kk(z, "paint") + kk(z, "prepaint") + kk(z, "composite");
      const lay = (z) => (z.counts ? `${z.counts.layouts} (${z.counts.forcedLayouts})` : "–");
      return [`${k.replace(/\./g, " · ")} (÷${(x.cpu || y.cpu)})`, pair(md(x.usable), md(y.usable), sec), pair(md(x.lcp), md(y.lcp), sec), `**${pair(md(x.tbt), md(y.tbt))}**`, pair(md(x.total), md(y.total)),
        pair(kk(x, "script"), kk(y, "script")), pair(kk(x, "style"), kk(y, "style")), pair(kk(x, "layout"), kk(y, "layout")), pair(pc(x), pc(y)), pair(md(x.longTaskCount), md(y.longTaskCount)), B ? `${lay(x)} → ${lay(y)}` : lay(x)];
    }));
  }
}

if (want("interact")) {
  const a = read(A, "interact"), b = B ? read(B, "interact") : {};
  for (const k of keys(a, b)) {
    const x = a[k] || {}, y = b[k] || {};
    console.log(`### Gestures — ${k.replace(/\./g, " · ")}${B ? ` — ${A} → ${B}` : ""}\n`);
    const gs = Object.keys((x.gestures || y.gestures) || {});
    table(["gesture", "late frames", "worst frame ms", "INP ms", "long tasks", "blocked ms", "task ms", "script", "layout", "style", "to paint ms"], gs.map((g) => {
      const p = (x.gestures || {})[g] || {}, q = (y.gestures || {})[g] || {};
      const pct = (v) => (v == null ? "–" : Math.round(v * 100) + "%");
      return [g, pair(md(p.lateShare), md(q.lateShare), pct), pair(md(p.worstFrame), md(q.worstFrame)), `**${pair(md(p.inp), md(q.inp))}**`, pair(md(p.long), md(q.long)), pair(md(p.blocked), md(q.blocked)),
        pair(md(p.task), md(q.task)), pair(md(p.script), md(q.script)), pair(md(p.layout), md(q.layout)), pair(md(p.style), md(q.style)), pair(md(p.toPaint || p.toPlayer), md(q.toPaint || q.toPlayer))];
    }));
    const s = x.session, t = y.session;
    if (s) {
      console.log(`Session weight (${k}): ` + s.weights.map((w, i) => `${w.screen} ${w.dom} elements / ${w.heapMB} MB${t && t.weights[i] ? ` → ${t.weights[i].dom} / ${t.weights[i].heapMB} MB` : ""}`).join("; ") + ".");
      console.log(`After each of four rounds of the ten-screen tour, collected: ` + s.rounds.map((r) => `${r.nodes} nodes · ${r.listeners} listeners · ${r.heapMB} MB`).join(" | ") + (t ? `  →  ` + t.rounds.map((r) => `${r.nodes} · ${r.listeners} · ${r.heapMB} MB`).join(" | ") : "") + "\n");
    }
  }
}

if (want("session")) {
  const a = read(A, "session"), b = B ? read(B, "session") : {};
  const ks = keys(a, b);
  if (ks.length) {
    console.log(`### Data for a five-minute visit${B ? ` — ${A} → ${B}` : ""}\n`);
    const kinds = ["html", "css", "js", "api", "img", "worker", "probe", "other"];
    table(["line · mode", "total", "requests", "tier at the end", ...kinds], ks.map((k) => {
      const x = a[k] || {}, y = b[k] || {};
      const kd = (z, n) => (z.byKind && z.byKind[n] ? z.byKind[n].bytes : 0);
      return [k.replace(/\./g, " · "), `**${pair(x.totalBytes, y.totalBytes, (v) => (v == null ? "–" : (v / 1048576).toFixed(2) + " MB"))}**`, pair(x.requests, y.requests), B ? `${x.tierAtEnd} → ${y.tierAtEnd}` : String(x.tierAtEnd),
        ...kinds.map((n) => pair(kd(x, n), kd(y, n), kb))];
    }));
  }
}

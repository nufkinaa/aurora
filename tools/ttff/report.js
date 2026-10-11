#!/usr/bin/env node
// Tables and waterfalls from the harness's result files.
//
//   node tools/ttff/report.js baseline                 the tables for one label
//   node tools/ttff/report.js baseline after           before → after, side by side
//   node tools/ttff/report.js baseline --waterfall HL-LB:mkv-ac3:cold
//                                                      the request waterfall of the median run
//   node tools/ttff/report.js --matrix baseline after  one line per title × mode, a column per line × label
//        [--modes cold,warm] [--lines HL-LB,LL-LB] [--titles a,b] [--field rebufferMs]
//   node tools/ttff/report.js baseline --md            Markdown (for docs/qa/ttff/REPORT.md)
//
// Every figure is the MEDIAN over the runs, with min–max beside it. Times are
// milliseconds from the click (or from the address change, for an episode
// that started by itself).
"use strict";
const fs = require("fs");
const path = require("path");
const { CONDITIONS } = require("./lib");

const DIR = path.join(__dirname, ".runs");
const load = (label) => {
  const f = path.join(DIR, `${label}.jsonl`);
  if (!fs.existsSync(f)) throw new Error(`no results for "${label}" (${f})`);
  return fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.title !== "*");
};
const med = (arr) => {
  const s = arr.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
const range = (arr) => {
  const s = arr.filter((x) => x != null && Number.isFinite(x));
  return s.length ? [Math.min(...s), Math.max(...s)] : [null, null];
};
const group = (rows) => {
  const g = new Map();
  for (const r of rows) {
    const k = `${r.cond}|${r.title}|${r.mode}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return g;
};
const secs = (ms) => (ms == null ? "—" : ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(2)} s`);
const mb = (n) => (n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);
const most = (arr) => {
  const c = new Map();
  for (const x of arr) c.set(x, (c.get(x) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]).map(([k]) => k)[0];
};

const summarize = (rs) => {
  const ok = rs.filter((r) => r.ok);
  const [lo, hi] = range(ok.map((r) => r.ttff));
  return {
    n: rs.length, failed: rs.length - ok.length,
    ttff: med(ok.map((r) => r.ttff)), lo, hi,
    ttplay: med(ok.map((r) => r.ttplay)),
    mount: med(ok.map((r) => r.mount)),
    firstMediaByte: med(ok.map((r) => r.firstMediaByte)),
    roundTrips: med(ok.map((r) => r.roundTrips)),
    serverMs: med(ok.map((r) => r.serverMs)),
    firstSegServer: med(ok.map((r) => r.firstSegServer)),
    mediaBytes: med(ok.map((r) => r.mediaBytesBeforeFF)),
    rebufferMs: med(ok.map((r) => r.rebufferMs)),
    rebuffers: med(ok.map((r) => r.rebuffers)),
    watched: med(ok.map((r) => r.watched)),
    hitch: med(ok.map((r) => r.startHitchMs)),
    path: most(ok.map((r) => r.path)),
    firstLevel: most(ok.map((r) => r.firstLevel || "")),
    endHeight: most(ok.map((r) => r.endHeight)),
    levels: most(ok.map((r) => (r.levels || []).join(">"))),
  };
};

const order = (keys, wanted) => [...keys].sort((a, b) => (wanted.indexOf(a) + 1 || 99) - (wanted.indexOf(b) + 1 || 99) || a.localeCompare(b));
const COND_ORDER = Object.keys(CONDITIONS);
const MODE_ORDER = ["cold", "warm", "resume", "next", "autonext"];

const table = (rows, { md = false } = {}) => {
  const g = group(rows);
  const titles = [...new Set(rows.map((r) => r.title))];
  const conds = order(new Set(rows.map((r) => r.cond)), COND_ORDER);
  const modes = order(new Set(rows.map((r) => r.mode)), MODE_ORDER);
  const out = [];
  const head = ["title", "mode", "line", "TTFF median", "min–max", "n", "path", "starts on", "round trips", "server", "media bytes by 1st frame", "rebuffer", "ends at"];
  if (md) { out.push(`| ${head.join(" | ")} |`); out.push(`|${head.map(() => "---").join("|")}|`); }
  else out.push(head.join("\t"));
  for (const t of titles) for (const m of modes) for (const c of conds) {
    const rs = g.get(`${c}|${t}|${m}`);
    if (!rs) continue;
    const s = summarize(rs);
    const cells = [
      t, m, c, secs(s.ttff), `${secs(s.lo)}–${secs(s.hi)}`, `${s.n - s.failed}/${s.n}`, s.path || "—", s.firstLevel || (s.path === "direct" ? "file" : "—"),
      s.roundTrips ?? "—", s.serverMs != null ? `${s.serverMs} ms` : "—", mb(s.mediaBytes),
      s.rebufferMs ? `${secs(s.rebufferMs)} in ${secs(s.watched)}` : "none", s.endHeight ? `${s.endHeight}p` : "—",
    ];
    out.push(md ? `| ${cells.join(" | ")} |` : cells.join("\t"));
  }
  return out.join("\n");
};

const compare = (a, b, { md = false } = {}) => {
  const ga = group(a);
  const gb = group(b);
  const out = [];
  const head = ["title", "mode", "line", "before", "after", "change", "path before → after", "starts on", "rebuffer before → after"];
  if (md) { out.push(`| ${head.join(" | ")} |`); out.push(`|${head.map(() => "---").join("|")}|`); }
  else out.push(head.join("\t"));
  const keys = [...ga.keys()].filter((k) => gb.has(k));
  const sortKey = (k) => { const [c, t, m] = k.split("|"); return [t, String(MODE_ORDER.indexOf(m)), String(COND_ORDER.indexOf(c))].join("|"); };
  keys.sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  for (const k of keys) {
    const [c, t, m] = k.split("|");
    const x = summarize(ga.get(k));
    const y = summarize(gb.get(k));
    const d = x.ttff != null && y.ttff != null ? y.ttff - x.ttff : null;
    const cells = [
      t, m, c, secs(x.ttff), secs(y.ttff),
      d == null ? "—" : `${d <= 0 ? "−" : "+"}${secs(Math.abs(d))} (${d <= 0 ? "−" : "+"}${Math.round((Math.abs(d) / x.ttff) * 100)}%)`,
      `${x.path || "—"} → ${y.path || "—"}`, `${x.firstLevel || "file"} → ${y.firstLevel || "file"}`,
      `${x.rebufferMs ? secs(x.rebufferMs) : "none"} → ${y.rebufferMs ? secs(y.rebufferMs) : "none"}`,
    ];
    out.push(md ? `| ${cells.join(" | ")} |` : cells.join("\t"));
  }
  return out.join("\n");
};

// One line per title × mode, one column per line (× label): the median time
// to first frame. A play that never showed a frame in the time allowed
// counts as that time (120 s), so a median is never flattered by failures;
// "3/5" beside a figure says how many of the runs got a picture at all.
const LIMIT_MS = 120000;
const matrix = (sets, { md = false, modes: only = null, conds: onlyConds = null, titles: onlyTitles = null, field = "ttff" } = {}) => {
  const labels = Object.keys(sets);
  const all = Object.values(sets).flat();
  const titles = onlyTitles || [...new Set(all.map((r) => r.title))];
  const conds = onlyConds || order(new Set(all.map((r) => r.cond)), COND_ORDER);
  const modes = only || order(new Set(all.map((r) => r.mode)), MODE_ORDER);
  const groups = Object.fromEntries(labels.map((l) => [l, group(sets[l])]));
  const cell = (rs) => {
    if (!rs || !rs.length) return "";
    const vals = rs.map((r) => (r.ok && r[field] != null ? r[field] : field === "ttff" ? LIMIT_MS : null)).filter((v) => v != null);
    const ok = rs.filter((r) => r.ok).length;
    const m = med(vals);
    if (m == null) return "—";
    const txt = field === "rebufferMs" ? (m ? secs(m) : "0") : m >= LIMIT_MS ? "> 120 s" : secs(m);
    return ok < rs.length ? `${txt} (${ok}/${rs.length})` : txt;
  };
  const head = ["title", "mode", ...conds.flatMap((c) => labels.map((l) => (labels.length > 1 ? `${c} ${l}` : c)))];
  const out = [];
  if (md) { out.push(`| ${head.join(" | ")} |`); out.push(`|${head.map((_, i) => (i < 2 ? "---" : "--:")).join("|")}|`); }
  else out.push(head.join("\t"));
  for (const t of titles) for (const m of modes) {
    const cells = conds.flatMap((c) => labels.map((l) => cell(groups[l].get(`${c}|${t}|${m}`))));
    if (cells.every((x) => !x)) continue;
    out.push(md ? `| ${[t, m, ...cells].join(" | ")} |` : [t, m, ...cells].join("\t"));
  }
  return out.join("\n");
};

// The request waterfall of the run whose TTFF is the median of its group.
const waterfall = (rows, spec) => {
  const [c, t, m] = spec.split(":");
  const rs = rows.filter((r) => r.cond === c && r.title === t && r.mode === (m || "cold") && r.ok).sort((a, b) => a.ttff - b.ttff);
  if (!rs.length) return `no successful run for ${spec}`;
  const r = rs[Math.floor((rs.length - 1) / 2)];
  const W = 60;
  const span = Math.max(r.ttff, 1) * 1.05;
  const col = (ms) => Math.max(0, Math.min(W - 1, Math.round((ms / span) * (W - 1))));
  const lines = [];
  lines.push(`${t} · ${m || "cold"} · ${c} (${CONDITIONS[c] ? CONDITIONS[c].what : ""}) — run ${r.run}, first frame at ${r.ttff} ms`);
  lines.push(`path ${r.path}${r.firstLevel ? `, starts on ${r.firstLevel}` : ""}; ${r.roundTrips} requests in a row before the first media byte (${r.firstMediaByte} ms); server ${r.serverMs} ms of that; ${mb(r.mediaBytesBeforeFF)} of media by the first frame`);
  lines.push("");
  lines.push(`${"start".padStart(6)} ${"1st byte".padStart(8)} ${"end".padStart(6)} ${"bytes".padStart(8)}  ${"|" + "-".repeat(W - 2) + "|"}  what`);
  const mark = (ms, ch, row) => { if (ms != null && ms <= span) row[col(ms)] = ch; };
  for (const w of r.waterfall) {
    if (w.start > r.ttff) continue;
    const row = Array(W).fill(" ");
    const a = col(Math.max(0, w.start));
    const b = w.ttfb != null ? col(Math.min(w.ttfb, span)) : W - 1;
    const e = w.end != null ? col(Math.min(w.end, span)) : W - 1;
    for (let i = a; i <= b; i++) row[i] = "."; // waiting for the first byte
    for (let i = b; i <= e; i++) row[i] = "#"; // the body arriving
    const srv = w.server && w.server.app != null ? ` [server ${Math.round(w.server.app)} ms${w.server.seg != null ? `, segment ${w.server["seg:desc"] || ""} ${Math.round(w.server.seg)} ms` : ""}${w.server.ladder != null ? `, probe ${Math.round(w.server.ladder)} ms` : ""}${w.server.table != null && w.server.table >= 1 ? `, index ${Math.round(w.server.table)} ms` : ""}]` : "";
    const what = `${w.kind} ${w.method === "GET" ? "" : w.method + " "}${w.path.replace(/^\/stream\/transcode\/[^/]+\//, "…/").replace(/^\/stream\/video\/.*/, "/stream/video/…").replace(/^\/api\/profiles\/[^/]+\//, "/api/profiles/…/").replace(/^\/api\/play-mark\/.*/, "/api/play-mark")}${w.range ? ` (${w.range})` : ""}${w.newConn ? " +new connection" : ""}${w.cache ? " (browser cache)" : ""}${srv}`;
    lines.push(`${String(w.start).padStart(6)} ${String(w.ttfb ?? "—").padStart(8)} ${String(w.end ?? "…").padStart(6)} ${mb(w.bytesByFF ?? w.bytes).padStart(8)}  ${row.join("")}  ${what}`);
  }
  const ev = Array(W).fill(" ");
  mark(r.mount, "M", ev);
  mark(r.loadedmetadata, "L", ev);
  mark(r.ttff, "F", ev);
  lines.push(`${" ".repeat(32)}${ev.join("")}  M player mounted ${r.mount} · L metadata ${r.loadedmetadata} · F first frame ${r.ttff}`);
  lines.push(`marks: ${(r.marks || []).join("  ")}`);
  return lines.join("\n");
};

module.exports = { load, summarize, group, table, compare, matrix, waterfall, med };

if (require.main === module) {
  const args = process.argv.slice(2);
  const md = args.includes("--md");
  const wi = args.indexOf("--waterfall");
  const labels = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--waterfall" && !["--modes", "--lines", "--titles", "--field"].includes(args[i - 1]));
  if (!labels.length) { console.log("usage: node tools/ttff/report.js <label> [<label after>] [--md] [--waterfall LINE:title:mode]"); process.exit(1); }
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1].split(",") : null; };
  const a = load(labels[0]);
  if (args.includes("--matrix")) {
    const skip = new Set(["--modes", "--lines", "--titles", "--field"].flatMap((n) => { const i = args.indexOf(n); return i >= 0 ? [args[i + 1]] : []; }));
    const ls = labels.filter((l) => !skip.has(l));
    console.log(matrix(Object.fromEntries(ls.map((l) => [l, load(l)])), { md, modes: opt("--modes"), conds: opt("--lines"), titles: opt("--titles"), field: (opt("--field") || ["ttff"])[0] }));
  } else if (wi >= 0) console.log(waterfall(a, args[wi + 1]));
  else if (labels[1]) console.log(compare(a, load(labels[1]), { md }));
  else console.log(table(a, { md }));
}

#!/usr/bin/env node
// Markdown tables from a run's JSON.
//
//   node tools/loadtest/report.js <result.json>              the tables again
//   node tools/loadtest/report.js <a.json> --vs <b.json>     two runs side by side (any two "once"/"ramp" windows)
"use strict";
const fs = require("fs");
const { table, round, median, parseArgs } = require("./lib");

const mb = (b) => (b == null ? null : round(b / 1048576, 1));
const kb = (b) => (b == null ? null : round(b / 1024, 1));
const sum = (a, f) => a.reduce((x, v) => x + (f(v) || 0), 0);
const p50of = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.ceil(s.length / 2) - 1] : null; };
const maxOf = (xs) => { const s = xs.filter((x) => x != null); return s.length ? Math.max(...s) : null; };

// the numbers of one window that matter for "better or worse"
const key = (w) => {
  const v = w.viewers || [];
  const g = Object.fromEntries((w.client.groups || []).map((r) => [r.group, r]));
  const sr = (w.server.http && w.server.http.routes) || {};
  return {
    households: w.spec ? w.spec.households : null,
    streams: w.spec ? w.spec.streams : v.length,
    browseRps: round(w.client.browse.n / w.secs, 1),
    browseP50: w.client.browse.p50, browseP95: w.client.browse.p95, browseP99: w.client.browse.p99, browseMax: w.client.browse.max,
    apiP95: w.client.api ? w.client.api.p95 : null, apiP99: w.client.api ? w.client.api.p99 : null,
    imageP95: w.client.images ? w.client.images.p95 : g.image ? g.image.p95 : null, imageP99: w.client.images ? w.client.images.p99 : g.image ? g.image.p99 : null,
    homeP95: g.home ? g.home.p95 : null, homeP99: g.home ? g.home.p99 : null,
    homeServerP99: sr.home ? sr.home.p99 : null,
    segP95: g.segment ? g.segment.p95 : null, segP99: g.segment ? g.segment.p99 : null,
    firstSegP50: g["first-segment"] ? g["first-segment"].p50 : null,
    directFirstByteP95: g["direct-first-byte"] ? g["direct-first-byte"].p95 : null,
    lagP99: w.client.lagProbe.p99, lagMax: w.client.lagProbe.max,
    loopP50: w.server.loop ? w.server.loop.p50 : null, loopP99: w.server.loop ? w.server.loop.p99 : null, loopMax: w.server.loop ? w.server.loop.max : null,
    stall50: w.server.stalls ? w.server.stalls.n50 : null, stall100: w.server.stalls ? w.server.stalls.n100 : null, stall250: w.server.stalls ? w.server.stalls.n250 : null,
    stallMsPerMin: w.server.stalls ? round(w.server.stalls.totalMs / (w.secs / 60), 0) : null, stallMax: w.server.stalls ? w.server.stalls.max : null,
    elu: w.server.elu,
    serverCpuSecPerMin: round((w.server.cpuMs / 1000) / (w.secs / 60), 2),
    serverCores: w.tree.serverCores, kidsCores: w.tree.kidsCores,
    rssMb: w.tree.rssMb, heapMb: mb(w.server.mem && w.server.mem.heapUsed), handles: w.tree.handles, kidsAlive: w.tree.kidsAlive,
    fsCallsPerSec: round(w.server.fsCalls / w.secs, 1),
    writtenKbPerMin: round(kb(w.server.writtenBytes) / (w.secs / 60), 1),
    dataGrewKb: kb(w.dataDir.grewBytes),
    stalls: sum(v, (x) => x.stalls), stallSec: round(sum(v, (x) => x.stallMs) / 1000, 1), neverStarted: v.filter((x) => x.neverStarted).length,
    ttffP50: p50of(v.map((x) => x.ttffMs)), ttffMax: maxOf(v.map((x) => x.ttffMs)),
    seekP50: p50of(v.flatMap((x) => x.seekMs || [])), seekMax: maxOf(v.flatMap((x) => x.seekMs || [])),
    refused: sum(v, (x) => x.refused),
    // errors a person would see while browsing (the rig's offline misses — catalogue pictures, people, X-Ray — are their own groups and not counted)
    err5xx: w.client.browse.s5xx, errNet: w.client.browse.net, err429: w.client.browse.s429, err503: w.client.browse.s503,
    streamErrors: ["segment", "playlist", "direct", "first-segment"].reduce((a, k) => a + (g[k] ? g[k].err : 0), 0),
    machineCpu: w.machine ? w.machine.cpuPctMean : null, machineFreeMb: w.machine ? w.machine.freeMbMin : null,
    starved: w.machine ? w.machine.cpuPctMean > 85 || w.machine.freeMbMin < 1024 : false, driverCores: w.driverCores,
    diskBusy: w.disk ? w.disk.busyPctMean : null, diskReadMBs: w.disk ? w.disk.readMBsMean : null,
  };
};

const capacityTable = (windows) => table(windows.map((w) => ({ ...key(w), label: w.label, verdict: w.verdict ? (w.verdict.degraded ? `**degraded**: ${w.verdict.why.join("; ")}` : "ok") : "" })), [
  ["window", "label"], ["hh", "households"], ["streams", "streams"], ["browse req/s", "browseRps"],
  ["browse p50/p95/p99 ms", (r) => `${r.browseP50}/${r.browseP95}/${r.browseP99}`],
  ["API p95/p99", (r) => `${r.apiP95 ?? ""}/${r.apiP99 ?? ""}`], ["pictures p95/p99", (r) => `${r.imageP95 ?? ""}/${r.imageP99 ?? ""}`],
  ["Home p99 client/server", (r) => `${r.homeP99 ?? ""}/${r.homeServerP99 ?? ""}`],
  ["segment p95", "segP95"], ["1st seg p50", "firstSegP50"], ["TTFF p50/max", (r) => `${r.ttffP50 ?? ""}/${r.ttffMax ?? ""}`],
  ["stalls (s)", (r) => `${r.stalls} (${r.stallSec})`],
  ["loop stalls >50/>100/>250 ms", (r) => `${r.stall50}/${r.stall100}/${r.stall250}`], ["stall ms/min", "stallMsPerMin"], ["longest stall ms", "stallMax"], ["healthz p99", "lagP99"],
  ["ELU", "elu"], ["server cores", "serverCores"], ["ffmpeg cores", "kidsCores"], ["RSS MB", "rssMb"], ["handles", "handles"],
  ["fs calls/s", "fsCallsPerSec"], ["written KB/min", "writtenKbPerMin"],
  ["5xx/net/429/503", (r) => `${r.err5xx}/${r.errNet}/${r.err429}/${r.err503}`], ["PC CPU % / free MB min", (r) => `${r.machineCpu}/${r.machineFreeMb}${r.starved ? " (PC starved)" : ""}`], ["driver cores", "driverCores"], ["library disk busy % / MB/s (whole PC)", (r) => (r.diskBusy == null ? "" : `${r.diskBusy}/${r.diskReadMBs}`)], ["verdict", "verdict"],
]);

const groupTable = (w) => table(w.client.groups.filter((g) => g.group !== "setup"), [
  ["group", "group"], ["n", "n"], ["req/s", "rps"], ["p50", "p50"], ["p95", "p95"], ["p99", "p99"], ["max", "max"], ["KB avg", "kbAvg"],
  ["errors", (r) => (r.err ? `${r.err} (${Object.entries(r.codes).filter(([c]) => !(c >= 200 && c < 400)).map(([c, n]) => `${c}:${n}`).join(" ")})` : "0")],
]);
const serverRoutes = (w) => {
  const r = (w.server.http && w.server.http.routes) || {};
  return table(Object.entries(r).sort((a, b) => b[1].n - a[1].n).map(([g, x]) => ({ g, ...x })), [["route group (server side)", "g"], ["n", "n"], ["p50", "p50"], ["p95", "p95"], ["p99", "p99"], ["max", "max"]]);
};
const viewersTable = (w) => table(w.viewers, [
  ["viewer", "kind"], ["title", (v) => String(v.title).slice(0, 28)], ["TTFF ms", "ttffMs"], ["stalls", "stalls"], ["stall ms", "stallMs"],
  ["seeks (ms)", (v) => (v.seekMs && v.seekMs.length ? v.seekMs.join(", ") : "")], ["Mbit/s", "mbit"], ["seg fails", "segFails"], ["refused", "refused"], ["state", "state"],
]);
const writesTable = (w) => table((w.server.writes || []).slice(0, 10), [["data/ file", "file"], ["writes", "n"], ["KB", (x) => kb(x.bytes)]]);

const renderAb = (res) => {
  const out = [];
  const refs = res.meta.names ? { A: `${res.meta.names.A} ${String(res.meta.refs.A).slice(0, 8)}`, B: `${res.meta.names.B} ${String(res.meta.refs.B).slice(0, 8)}` } : res.meta.refs;
  out.push(`# A/B: ${refs.A} (A) vs ${refs.B} (B) — ${res.meta.scenario} n=${res.meta.n}, ${res.runs.length} runs interleaved ${res.meta.order.join(" ")}`);
  out.push("");
  const metrics = [
    ["browse p50 ms", "browseP50", -1], ["browse p95 ms", "browseP95", -1], ["browse p99 ms", "browseP99", -1], ["API p95 ms (browse minus pictures)", "apiP95", -1], ["API p99 ms", "apiP99", -1], ["pictures p95 ms", "imageP95", -1], ["pictures p99 ms", "imageP99", -1], ["Home p99 ms (client)", "homeP99", -1], ["Home p99 ms (server)", "homeServerP99", -1],
    ["segment p95 ms", "segP95", -1], ["first segment p50 ms", "firstSegP50", -1], ["TTFF p50 ms", "ttffP50", -1], ["stalls", "stalls", -1],
    ["loop stalls > 50 ms", "stall50", -1], ["loop stalls > 100 ms", "stall100", -1], ["loop stall ms/min", "stallMsPerMin", -1], ["longest stall ms", "stallMax", -1], ["healthz p99 ms", "lagP99", -1], ["ELU", "elu", -1],
    ["server CPU s/min", "serverCpuSecPerMin", -1], ["ffmpeg cores", "kidsCores", -1], ["RSS MB", "rssMb", -1], ["heap MB", "heapMb", -1], ["handles", "handles", -1],
    ["fs calls/s", "fsCallsPerSec", -1], ["written KB/min (server, data/)", "writtenKbPerMin", -1], ["browse 5xx", "err5xx", -1], ["stream request errors", "streamErrors", -1], ["429", "err429", -1], ["503", "err503", -1], ["PC CPU % (noise)", "machineCpu", 0],
  ];
  const A = res.runs.filter((r) => r.side === "A").map((r) => key(r.window));
  const B = res.runs.filter((r) => r.side === "B").map((r) => key(r.window));
  const rows = metrics.map(([name, k, dir]) => {
    const a = median(A.map((x) => x[k])), b = median(B.map((x) => x[k]));
    const d = a != null && b != null && a !== 0 ? round(((b - a) / Math.abs(a)) * 100, 1) : null;
    // "better" only when every B run beats every A run (no overlap) — the noise test this PC needs
    const as = A.map((x) => x[k]).filter((x) => x != null), bs = B.map((x) => x[k]).filter((x) => x != null);
    let call = "";
    if (dir && as.length && bs.length) {
      if (Math.max(...bs) < Math.min(...as)) call = "B better (no overlap)";
      else if (Math.min(...bs) > Math.max(...as)) call = "B worse (no overlap)";
      else call = "overlap";
    }
    return { name, a, b, d, call, av: as.join(" / "), bv: bs.join(" / ") };
  });
  out.push(table(rows, [["metric", "name"], ["A median", "a"], ["B median", "b"], ["B vs A", (r) => (r.d == null ? "" : `${r.d > 0 ? "+" : ""}${r.d} %`)], ["call", "call"], ["A runs", "av"], ["B runs", "bv"]]));
  out.push("");
  out.push("Runs:");
  for (const r of res.runs) out.push(`- ${r.side} ${r.meta.ref}${r.meta.dirty ? " (uncommitted)" : ""}: ${r.window.verdict.degraded ? `degraded: ${r.window.verdict.why.join("; ")}` : "ok"}`);
  return out.join("\n");
};

const render = (res) => {
  if (res.kind === "ab") return renderAb(res);
  const out = [];
  const m = res.meta;
  out.push(`# ${res.kind} — ${m.ref}${m.dirty ? " (uncommitted)" : ""} — ${m.scenario}`);
  out.push("");
  out.push(`${m.at}, ${m.host.cpu} (${m.host.cpus} threads, ${m.host.memGb} GB), Node ${m.host.node}, machine profile **${(m.machine && m.machine.name) || "full"}**${m.machine && m.machine.applied && Object.keys(m.machine.applied).length ? ` (${JSON.stringify(m.machine.applied)})` : ""}, media ${m.media}: ${m.lib ? `${m.lib.movies} films, ${m.lib.shows} shows` : ""}. ${m.note || ""}`);
  out.push("");
  if (res.kind === "soak") {
    out.push(table(res.windows.map((w) => ({ ...key(w), at: w.atMin, data: mb(w.dataDir.bytes), files: w.dataDir.files })), [
      ["min", "at"], ["RSS MB", "rssMb"], ["heap MB", "heapMb"], ["handles", "handles"], ["data MB", "data"], ["data files", "files"], ["data grew KB", "dataGrewKb"], ["written KB/min", "writtenKbPerMin"],
      ["browse p50/p99", (r) => `${r.browseP50}/${r.browseP99}`], ["loop stalls >100 ms / longest", (r) => `${r.stall100}/${r.stallMax}`], ["ELU", "elu"], ["server CPU s/min", "serverCpuSecPerMin"], ["ffmpeg cores", "kidsCores"], ["stalls", "stalls"], ["errors 5xx/net", (r) => `${r.err5xx}/${r.errNet}`], ["PC CPU %", "machineCpu"],
    ]));
    const w = res.windows[res.windows.length - 1];
    if (w) { out.push("", "Largest writers in the last window:", "", writesTable(w), "", "Data folder growth by entry (last window):", "", "```", JSON.stringify(w.dataDir.by, null, 1), "```"); }
  } else {
    out.push(capacityTable(res.windows));
    const w = res.windows[res.windows.length - 1];
    if (w) {
      out.push("", `Requests in the last window (${w.label}), as the devices saw them:`, "", groupTable(w));
      out.push("", "Server side (request -> response finished):", "", serverRoutes(w));
      if (w.viewers.length) out.push("", "Viewers:", "", viewersTable(w));
      out.push("", "Largest writers to data/:", "", writesTable(w));
    }
  }
  if (res.exited) out.push("", `**The server exited during the run: ${JSON.stringify(res.exited)}**`);
  return out.join("\n");
};

module.exports = { render, key, capacityTable };

if (require.main === module) {
  const a = parseArgs();
  const res = JSON.parse(fs.readFileSync(a._[0], "utf8"));
  if (a.vs) {
    const other = JSON.parse(fs.readFileSync(a.vs, "utf8"));
    const ws = [...res.windows.map((w) => ({ ...w, label: `A ${w.label}` })), ...other.windows.map((w) => ({ ...w, label: `B ${w.label}` }))];
    console.log(capacityTable(ws));
  } else console.log(render(res));
}

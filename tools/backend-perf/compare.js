#!/usr/bin/env node
// BEFORE against AFTER, under the same weather: two private instances at once
// (one per commit), the same request sent to one and then the other, round
// after round. On a machine that is busy with other work the CPU a request
// costs moves by tens of percent from minute to minute; taking turns puts
// both commits in the same minutes.
//
//   node tools/backend-perf/compare.js --before 68e946a [--after <commit>] [--weak] [--rounds 5]
//                                      [--only home,library] [--label findbyid]
//   -> docs/qa/backend-efficiency/results/compare[-weak][-label].json and a table
//
// --after defaults to the working tree. Per round: (the server process's CPU
// over the window - its idle rate) / requests. Reported: the BEST round (the
// least CPU a request was seen to cost — what the code needs when nothing
// else is in its way, and the steadier figure on a busy machine) and the median.
const path = require("path");
const { start } = require("./instance");
const { endpoints, prepare, call } = require("./endpoints");
const { median, round, saveJson, arg, table, sleep } = require("./lib");

(async () => {
  const weak = !!arg("weak");
  const rounds = +arg("rounds", 7);
  const before = arg("before") === true ? undefined : arg("before");
  const after = arg("after") === true ? undefined : arg("after");
  const label = arg("label") === true ? undefined : arg("label");
  const only = arg("only") && arg("only") !== true ? String(arg("only")).split(",") : null;
  const pick = (list) => (only ? list.filter((e) => only.some((o) => e.name.toLowerCase().includes(o.toLowerCase()))) : list);
  if (!before) throw new Error("--before <commit> is required");
  const cfg = { weak, probe: "light", loop: false, config: { scanIntervalMinutes: 24 * 60 } };
  const A = await start({ ...cfg, ref: before });
  const B = await start({ ...cfg, ref: after });
  const out = { at: new Date().toISOString(), before, after: after || "working tree", weak, rounds, rows: [] };
  try {
    for (const s of [A, B]) { await s.waitWarm(); }
    for (const s of [A, B]) { await s.waitQuiet(); }
    const la = pick(await prepare(A, endpoints(A)));
    const lb = pick(await prepare(B, endpoints(B)));
    const idleOf = async (s) => { await s.reset(); await sleep(6000); const x = await s.snap(); return (x.cpuSinceReset.user + x.cpuSinceReset.system) / 1000 / x.sinceResetMs; };
    const idle = { a: await idleOf(A), b: await idleOf(B) };
    for (let k = 0; k < la.length; k++) {
      const ea = la[k], eb = lb.find((e) => e.name === ea.name);
      if (!eb) continue;
      const res = { a: [], b: [] };
      let bytes = { a: 0, b: 0 }, status = { a: 0, b: 0 };
      for (const [s, e] of [[A, ea], [B, eb]]) {
        const first = await call(s, e, 0);
        if (e.needsEtag) e.headers = { "If-None-Match": first.etag };
        for (let i = 0; i < (e.warm || 12); i++) await call(s, e, i);
      }
      const n = Math.max(10, Math.round(ea.n / 2));
      for (let r = 0; r < rounds; r++) {
        // alternate who goes first, so neither always gets the warmer cache
        const order = r % 2 ? [["b", B, eb], ["a", A, ea]] : [["a", A, ea], ["b", B, eb]];
        for (const [key, s, e] of order) {
          await s.reset();
          let last = null;
          for (let i = 0; i < n; i++) last = await call(s, e, i);
          const x = await s.snap();
          res[key].push(((x.cpuSinceReset.user + x.cpuSinceReset.system) / 1000 - idle[key] * x.sinceResetMs) / n);
          bytes[key] = last.bytes; status[key] = last.status;
        }
      }
      const a = Math.min(...res.a), b = Math.min(...res.b);
      const pct = (x, y) => `${y <= x ? "-" : "+"}${Math.abs(round((1 - y / x) * 100, 0))} %`;
      const row = { name: ea.name, status: `${status.a}/${status.b}`, bytesBefore: bytes.a, bytesAfter: bytes.b, beforeMs: round(a, 3), afterMs: round(b, 3), change: pct(a, b),
        beforeMedianMs: round(median(res.a), 3), afterMedianMs: round(median(res.b), 3), changeMedian: pct(median(res.a), median(res.b)), beforeRuns: res.a.map((x) => round(x, 2)), afterRuns: res.b.map((x) => round(x, 2)) };
      out.rows.push(row);
      process.stderr.write(`[compare] ${row.name}: ${row.beforeMs} -> ${row.afterMs} ms (${row.change})\n`);
    }
  } finally { await A.stop(); await B.stop(); }
  const f = saveJson(`compare${weak ? "-weak" : ""}${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.rows, [["request", "name"], ["status", "status"], ["before, CPU ms (best)", "beforeMs"], ["after", "afterMs"], ["change", "change"], ["before (median)", "beforeMedianMs"], ["after", "afterMedianMs"], ["change", "changeMedian"], ["answer B", (r) => (r.bytesBefore === r.bytesAfter ? r.bytesAfter : `${r.bytesBefore} / ${r.bytesAfter}`)]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

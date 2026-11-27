#!/usr/bin/env node
// Real Linux TCP over the shaped link (wsl-net.sh): what ONE connection
// carries, CUBIC against BBR, with and without packet loss, at a far
// round trip — and how a player's request rhythm (a segment, then seconds of
// silence while the buffer is full, then the next) fares with slow start
// after idle on and off. Run INSIDE WSL as root (it calls wsl-net.sh and
// `ip netns exec` itself):
//
//   wsl.exe -d Ubuntu -u root -e /home/elia/node22/bin/node tcp-bench.js [--quick] [--out file.json]
//
// The server end runs in the "auranet" namespace (its sysctls decide the
// congestion control); the client end in the root namespace.
"use strict";
const http = require("http");
const { execFileSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const HERE = __dirname;
const NET = path.join(HERE, "wsl-net.sh");
const NODE = process.execPath;
const PORT = 47190;
const sh = (...a) => execFileSync("sh", [NET, ...a.map(String)], { encoding: "utf8", env: { ...process.env, SLOT: "49" } }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUICK = process.argv.includes("--quick");
const RHYTHM_ONLY = process.argv.includes("--rhythm-only"); // (part 2 alone, with loss 1 %)
const oi = process.argv.indexOf("--out");
const OUT = oi > 0 ? process.argv[oi + 1] : null;

// the server: GET /n/<bytes> answers that many bytes (one 1 MB buffer, repeated)
const SERVER_SRC = `
const http=require('http');const buf=Buffer.alloc(1<<20,7);
http.createServer((q,r)=>{const n=Number((q.url.split('/')[2])||0);r.writeHead(200,{'Content-Length':n,'Content-Type':'application/octet-stream'});let left=n;const go=()=>{while(left>0){const k=Math.min(left,buf.length);left-=k;if(!r.write(k===buf.length?buf:buf.subarray(0,k))){r.once('drain',go);return;}}r.end();};go();}).listen(${PORT},'10.77.98.2',()=>console.log('srv up'));`;

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const get = (bytes, { ag = agent } = {}) =>
  new Promise((resolve, reject) => {
    const t0 = performance.now();
    let first = null;
    let got = 0;
    const req = http.get({ host: "10.77.98.2", port: PORT, path: `/n/${bytes}`, agent: ag }, (res) => {
      res.on("data", (c) => { if (first == null) first = performance.now(); got += c.length; });
      res.on("end", () => resolve({ ms: performance.now() - t0, ttfb: first - t0, bytes: got }));
    });
    req.on("error", reject);
    req.setTimeout(180000, () => req.destroy(new Error("timeout")));
  });

// one connection for `sec` seconds of a big body: Mbit/s after the first 2 s
const bulk = (sec) =>
  new Promise((resolve, reject) => {
    const t0 = performance.now();
    let got = 0, at2 = null, got2 = 0;
    const ag = new http.Agent({ keepAlive: false });
    const req = http.get({ host: "10.77.98.2", port: PORT, path: `/n/${4e9}`, agent: ag }, (res) => {
      res.on("data", (c) => {
        got += c.length;
        const t = performance.now() - t0;
        if (at2 == null && t >= 2000) { at2 = t; got2 = got; }
        if (t >= sec * 1000) { req.destroy(); resolve({ mbit: ((got - got2) * 8) / ((t - at2) / 1000) / 1e6, allMbit: (got * 8) / (t / 1000) / 1e6 }); }
      });
    });
    req.on("error", (e) => { if (!/aborted|socket hang up/.test(e.message)) reject(e); });
  });

// a player's rhythm: `n` segments of `bytes`, one every `gapMs` after the
// previous ended, on ONE keep-alive connection; ms per segment
const rhythm = async ({ n, bytes, gapMs }) => {
  const ag = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const out = [];
  await get(65536, { ag }); // open the connection
  for (let i = 0; i < n; i++) {
    await sleep(gapMs);
    out.push(await get(bytes, { ag }));
  }
  ag.destroy();
  return out;
};

const main = async () => {
  console.log(sh("up"));
  const srv = spawn("ip", ["netns", "exec", "auranet49", NODE, "-e", SERVER_SRC], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => srv.stdout.once("data", r));
  const results = { at: new Date().toISOString(), kernel: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(), bulk: [], rhythm: [] };
  try {
    // 1. one connection, steady: rate × loss × cc
    const RATES = RHYTHM_ONLY ? [] : QUICK ? [20000] : [5000, 20000];
    const LOSSES = QUICK ? [0, 1] : [0, 0.5, 1, 2];
    const SEC = QUICK ? 12 : 20;
    for (const rtt of [70]) for (const rate of RATES) for (const loss of LOSSES) for (const cc of ["cubic", "bbr"]) {
      sh("shape", rate, 2000, rtt, loss);
      sh("cc", cc);
      sh("ssai", 1);
      const runs = [];
      for (let k = 0; k < (QUICK ? 1 : 2); k++) runs.push(await bulk(SEC));
      const mbit = runs.reduce((s, r) => s + r.mbit, 0) / runs.length;
      const row = { rtt, rate, loss, cc, mbit: +mbit.toFixed(2), share: +(mbit / (rate / 1000)).toFixed(2), runs: runs.map((r) => +r.mbit.toFixed(2)) };
      results.bulk.push(row);
      console.log(`bulk  rtt ${rtt} ms  line ${rate / 1000} Mbit/s  loss ${String(loss).padEnd(3)}%  ${cc.padEnd(5)}  ${row.mbit} Mbit/s (${Math.round(row.share * 100)}% of the line)`);
    }
    // 2. a player's rhythm: 2.5 MB segments (≈ 6 s of a 3.3 Mbit/s film) every 4 s of silence
    for (const loss of RHYTHM_ONLY ? [1] : QUICK ? [0] : [0, 1]) for (const cc of ["cubic", "bbr"]) for (const ssai of [1, 0]) {
      sh("shape", 20000, 2000, 70, loss);
      sh("cc", cc);
      sh("ssai", ssai);
      const segs = await rhythm({ n: QUICK ? 4 : 8, bytes: 2.5e6, gapMs: 4000 });
      const ms = segs.map((s) => Math.round(s.ms));
      const med = [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)];
      const row = { rate: 20000, rtt: 70, loss, cc, ssai, segMs: ms, medianMs: med, medianMbit: +((2.5e6 * 8) / (med / 1000) / 1e6).toFixed(2) };
      results.rhythm.push(row);
      console.log(`rhythm 20 Mbit/s 70 ms loss ${loss}%  ${cc.padEnd(5)} slow-start-after-idle=${ssai}: 2.5 MB segment median ${med} ms (${row.medianMbit} Mbit/s)  [${ms.join(" ")}]`);
    }
  } finally {
    srv.kill();
    sh("cc", "cubic");
    sh("ssai", 1);
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  }
};
main().catch((e) => { console.error(e); process.exit(1); });

// Shared helpers for the load + soak harness (tools/loadtest/README.md).
// Nothing here touches the live server or the production tree: every scratch
// file lives in LT_WORK (default %TEMP%/aurora-agents/srv-loadtest).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const HERE = __dirname;
const REPO = path.join(HERE, "..", "..");
const WORK = process.env.LT_WORK || path.join(os.tmpdir(), "aurora-agents", "srv-loadtest");
fs.mkdirSync(WORK, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms, spread = 0.3) => ms * (1 - spread + Math.random() * 2 * spread);
const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null);
const median = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// --name value | --flag   (a flag without a value is `true`)
const parseArgs = (argv = process.argv.slice(2)) => {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) out[a.slice(2)] = true;
    else { out[a.slice(2)] = v; i++; }
  }
  return out;
};

// A latency recorder: exact values up to a cap, then reservoir sampling, so a
// two-hour soak does not grow without bound and the percentiles stay honest.
class Rec {
  constructor(cap = 50000) { this.cap = cap; this.v = []; this.n = 0; this.sum = 0; this.max = 0; }
  add(x) {
    this.n++; this.sum += x; if (x > this.max) this.max = x;
    if (this.v.length < this.cap) this.v.push(x);
    else { const j = Math.floor(Math.random() * this.n); if (j < this.cap) this.v[j] = x; }
  }
  summary() {
    const s = this.v.slice().sort((a, b) => a - b);
    return { n: this.n, mean: round(this.n ? this.sum / this.n : null), p50: round(pct(s, 50)), p95: round(pct(s, 95)), p99: round(pct(s, 99)), max: round(this.max) };
  }
}

// Requests by route group: count, errors by kind, latency.
class Stats {
  constructor() { this.groups = new Map(); this.t0 = Date.now(); }
  g(name) {
    let s = this.groups.get(name);
    if (!s) this.groups.set(name, (s = { n: 0, ok: 0, err: 0, s429: 0, s503: 0, s5xx: 0, s4xx: 0, net: 0, bytes: 0, rec: new Rec(), codes: {} }));
    return s;
  }
  add(name, r) {
    const s = this.g(name);
    s.n++;
    s.bytes += r.bytes || 0;
    s.codes[r.status] = (s.codes[r.status] || 0) + 1;
    if (r.status >= 200 && r.status < 400) s.ok++;
    else {
      s.err++;
      if (r.status === 429) s.s429++;
      else if (r.status === 503) s.s503++;
      else if (r.status >= 500) s.s5xx++;
      else if (r.status >= 400) s.s4xx++;
      else s.net++;
    }
    s.rec.add(r.ms);
  }
  rows(secs = (Date.now() - this.t0) / 1000) {
    return [...this.groups.entries()].sort((a, b) => b[1].n - a[1].n).map(([name, s]) => ({
      group: name, n: s.n, rps: round(s.n / secs, 2), err: s.err, s429: s.s429, s503: s.s503, s5xx: s.s5xx, s4xx: s.s4xx, net: s.net,
      kbAvg: round(s.bytes / Math.max(1, s.n) / 1024, 1), ...s.rec.summary(), codes: s.codes,
    }));
  }
  // every group except the ones a filter leaves out, as one distribution
  total(filter = () => true) {
    const r = new Rec(200000);
    let n = 0, err = 0, s429 = 0, s503 = 0, s5xx = 0, net = 0;
    for (const [k, s] of this.groups) {
      if (!filter(k)) continue;
      n += s.n; err += s.err; s429 += s.s429; s503 += s.s503; s5xx += s.s5xx; net += s.net;
      for (const v of s.rec.v) r.add(v);
    }
    const sm = r.summary();
    return { n, err, s429, s503, s5xx, net, p50: sm.p50, p95: sm.p95, p99: sm.p99, max: sm.max };
  }
}

// ---------- the machine, while a run goes on ----------
// Whole-machine CPU % from os.cpus() deltas (other agents share this PC: a
// run's wall-clock numbers mean little without it) and free memory.
const machineSampler = (everyMs = 2000) => {
  const samples = [];
  let prev = os.cpus();
  const t = setInterval(() => {
    const cur = os.cpus();
    let busy = 0, total = 0;
    cur.forEach((c, i) => {
      const p = prev[i] ? prev[i].times : { user: 0, nice: 0, sys: 0, irq: 0, idle: 0 };
      const d = { user: c.times.user - p.user, nice: c.times.nice - p.nice, sys: c.times.sys - p.sys, irq: c.times.irq - p.irq, idle: c.times.idle - p.idle };
      busy += d.user + d.nice + d.sys + d.irq;
      total += d.user + d.nice + d.sys + d.irq + d.idle;
    });
    prev = cur;
    samples.push({ t: Date.now(), cpuPct: total ? (100 * busy) / total : 0, freeMb: Math.round(os.freemem() / 1048576), load: os.loadavg()[0] });
  }, everyMs);
  t.unref();
  return {
    samples,
    stop: () => clearInterval(t),
    summary: (from = 0) => {
      const s = samples.filter((x) => x.t >= from);
      const c = s.map((x) => x.cpuPct).sort((a, b) => a - b);
      return { n: s.length, cpuPctMean: round(c.reduce((a, b) => a + b, 0) / Math.max(1, c.length)), cpuPctP95: round(pct(c, 95)), freeMbMin: s.length ? Math.min(...s.map((x) => x.freeMb)) : null, cores: os.cpus().length };
    },
  };
};

// The library disk (Windows: performance counters of the physical disk that
// holds the first library root): % busy and MB/s read, every 5 s. Other
// agents and the live server read the same disk, so this is context, not a
// result.
const diskSampler = (drive, everyMs = 5000) => {
  const samples = [];
  if (process.platform !== "win32" || !drive) return { samples, stop: () => {}, summary: () => null };
  const d = String(drive).slice(0, 1).toUpperCase();
  const BS = String.fromCharCode(92); // a backslash (counter paths), spelled so no tool can eat it
  const script = `$ErrorActionPreference='SilentlyContinue'; $inst = (Get-Counter -ListSet PhysicalDisk).PathsWithInstances | Where-Object { $_ -like '*${d}:)${BS}% Idle Time' } | Select-Object -First 1; if (-not $inst) { exit }; $base = $inst.Substring(0, $inst.LastIndexOf('${BS}')); while ($true) { $c = Get-Counter -Counter @("$base${BS}% Idle Time", "$base${BS}Disk Read Bytes/sec") -SampleInterval ${Math.max(1, Math.round(everyMs / 1000))} -MaxSamples 1; $v = $c.CounterSamples | ForEach-Object { $_.CookedValue }; [Console]::Out.WriteLine(('{0},{1},{2}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $v[0], $v[1])) }`;
  const child = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (x) => {
    buf += x;
    let i;
    while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {
      const [t, idle, rd] = buf.slice(0, i).trim().split(",").map(Number);
      buf = buf.slice(i + 1);
      if (Number.isFinite(idle)) samples.push({ t, busyPct: Math.max(0, 100 - idle), readMBs: rd / 1048576 });
    }
  });
  return {
    samples,
    stop: () => { try { child.kill(); } catch {} },
    summary: (from = 0) => {
      const s = samples.filter((x) => x.t >= from);
      if (!s.length) return null;
      return { drive: d, n: s.length, busyPctMean: round(s.reduce((a, x) => a + x.busyPct, 0) / s.length), readMBsMean: round(s.reduce((a, x) => a + x.readMBs, 0) / s.length, 2) };
    },
  };
};

// ---------- the graphics card (NVIDIA), while a run goes on ----------
// nvidia-smi every `everyMs`: GPU %, encoder %, decoder %, encoder sessions
// open on the card (EVERY program's: the live server and other agents count
// too, so this is context beside the server's own count), memory. No card or
// no nvidia-smi: an empty sampler.
const gpuSampler = (everyMs = 2000) => {
  const samples = [];
  let child = null;
  try {
    child = spawn("nvidia-smi", ["--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,encoder.stats.sessionCount,encoder.stats.averageFps,memory.used", "--format=csv,noheader,nounits", "-lms", String(everyMs)], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    child.on("error", () => {});
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (x) => {
      buf += x;
      let i;
      while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {
        const v = buf.slice(0, i).split(",").map((y) => Number(y.trim()));
        buf = buf.slice(i + 1);
        if (v.length >= 6 && Number.isFinite(v[0])) samples.push({ t: Date.now(), gpu: v[0], enc: v[1], dec: v[2], sessions: v[3], encFps: v[4], memMb: v[5] });
      }
    });
  } catch { child = null; }
  return {
    samples,
    stop: () => { if (child) try { child.kill(); } catch {} },
    summary: (from = 0, to = Infinity) => {
      const s = samples.filter((x) => x.t >= from && x.t <= to);
      if (!s.length) return null;
      const mean = (k) => round(s.reduce((a, x) => a + x[k], 0) / s.length);
      const max = (k) => Math.max(...s.map((x) => x[k]));
      return { n: s.length, gpuPctMean: mean("gpu"), gpuPctMax: max("gpu"), encPctMean: mean("enc"), encPctMax: max("enc"), decPctMean: mean("dec"), decPctMax: max("dec"), sessionsMean: mean("sessions"), sessionsMax: max("sessions"), memMbMax: max("memMb") };
    },
  };
};

// ---------- the server process tree, seen from outside ----------
// CPU seconds of the server process AND of every child it ever started
// (ffmpeg, ffprobe): one long-lived helper asks the OS every `everyMs`
// (PowerShell + CIM on Windows, /proc on Linux). A child that lives and dies
// between two samples is missed; one seen at least once counts with its last
// reading, so children's CPU is a slight undercount, never an overcount.
const treeSampler = (pid, everyMs = 2000) => {
  const samples = []; // { t, cpu (server s), kidsCpu (s, cumulative), kids (alive), rss, handles, threads }
  const kidLast = new Map();
  let child = null, timer = null, reaped = 0;
  const push = (t, cpu, rss, handles, threads, kids) => {
    for (const k of kids) kidLast.set(k.pid, k.cpu);
    let kidsCpu = reaped;
    for (const v of kidLast.values()) kidsCpu += v;
    samples.push({ t, cpu, rss, handles, threads, kids: kids.length, kidsCpu, kidsRss: kids.reduce((a, k) => a + (k.rss || 0), 0) });
  };
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$root=${pid}`,
      "while ($true) {",
      "  $p = Get-Process -Id $root; if (-not $p) { break }",
      // (only processes started after the server: Windows keeps a dead parent's pid in ParentProcessId,
      // so an older process whose parent once had this pid would otherwise count as a child)
      "  $born = $p.StartTime",
      "  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize,CreationDate | Where-Object { $_.CreationDate -ge $born }",
      "  $kids = @{}; $front = @($root)",
      "  while ($front.Count) { $next = @(); foreach ($x in $all) { if ($front -contains $x.ParentProcessId -and -not $kids.ContainsKey($x.ProcessId) -and $x.ProcessId -ne $root) { $kids[$x.ProcessId] = $x; $next += $x.ProcessId } }; $front = $next }",
      "  $k = ($kids.Values | ForEach-Object { '{0}:{1}:{2}' -f $_.ProcessId, (($_.KernelModeTime + $_.UserModeTime) / 1e7), $_.WorkingSetSize }) -join ';'",
      "  [Console]::Out.WriteLine(('{0},{1},{2},{3},{4},{5}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $p.TotalProcessorTime.TotalSeconds, $p.WorkingSet64, $p.HandleCount, $p.Threads.Count, $k))",
      `  Start-Sleep -Milliseconds ${everyMs}`,
      "}",
    ].join("\n");
    child = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const [t, cpu, rss, handles, threads, k] = line.split(",");
        if (!Number.isFinite(Number(cpu))) continue;
        const kids = (k || "").split(";").filter(Boolean).map((s) => { const [p, c, r] = s.split(":"); return { pid: Number(p), cpu: Number(c), rss: Number(r) }; });
        push(Number(t), Number(cpu), Number(rss), Number(handles), Number(threads), kids);
      }
    });
  } else {
    const tick = () => {
      try {
        const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
        const hz = 100;
        // cutime/cstime: children already reaped (ffmpeg that finished)
        reaped = (Number(st[13]) + Number(st[14])) / hz;
        const kids = [];
        const want = new Set([pid]);
        for (const d of fs.readdirSync("/proc")) {
          if (!/^\d+$/.test(d)) continue;
          try {
            const s2 = fs.readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1].split(" ");
            if (want.has(Number(s2[1]))) kids.push({ pid: Number(d), cpu: (Number(s2[11]) + Number(s2[12])) / hz, rss: Number(s2[21]) * 4096 });
          } catch {}
        }
        // (the reaped total already includes every child that has exited: count only the live ones' readings on top)
        kidLast.clear();
        push(Date.now(), (Number(st[11]) + Number(st[12])) / hz, Number(st[21]) * 4096, fs.readdirSync(`/proc/${pid}/fd`).length, Number(st[17]), kids);
      } catch {}
    };
    tick();
    timer = setInterval(tick, everyMs);
  }
  const at = (t) => samples.filter((s) => s.t <= t).pop() || samples[0];
  return {
    samples,
    last: () => samples[samples.length - 1] || null,
    between: (a, b) => {
      const s0 = at(a), s1 = at(b);
      if (!s0 || !s1 || s1 === s0) return null;
      const wall = (s1.t - s0.t) / 1000;
      return { wallSec: round(wall, 1), serverCpuSec: round(s1.cpu - s0.cpu, 2), kidsCpuSec: round(s1.kidsCpu - s0.kidsCpu, 2), serverCores: round((s1.cpu - s0.cpu) / wall, 3), kidsCores: round((s1.kidsCpu - s0.kidsCpu) / wall, 3) };
    },
    stop: () => { if (child) try { child.kill(); } catch {} if (timer) clearInterval(timer); },
  };
};

// ---------- tables ----------
const table = (rows, cols) => {
  const head = `| ${cols.map((c) => c[0]).join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
  return [head, ...rows.map((r) => `| ${cols.map((c) => { const v = typeof c[1] === "function" ? c[1](r) : r[c[1]]; return v == null ? "" : String(v); }).join(" | ")} |`)].join("\n");
};

const git = (args, opts = {}) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();

const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); return file; };

module.exports = { HERE, REPO, WORK, sleep, jitter, round, pct, median, parseArgs, Rec, Stats, machineSampler, diskSampler, gpuSampler, treeSampler, table, git, writeJson };

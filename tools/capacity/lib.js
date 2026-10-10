// Shared helpers for the capacity tools (tools/capacity/README.md).
// Nothing here touches the product: scratch files live OUTSIDE the repo, in
// CAP_WORK (default: <tmp>/aurora-cap-work), and are never committed.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..", "..");
const WORK = process.env.CAP_WORK || path.join(os.tmpdir(), "aurora-cap-work");
const MEDIA = path.join(WORK, "media");
const OUT = path.join(WORK, "out");
const RESULTS = path.join(REPO, "docs", "qa", "capacity", "results");
for (const d of [WORK, MEDIA, OUT, RESULTS]) fs.mkdirSync(d, { recursive: true });

const which = (name) => {
  if (process.env[name.toUpperCase() + "_PATH"]) return process.env[name.toUpperCase() + "_PATH"];
  const win = process.platform === "win32";
  try {
    return execFileSync(win ? "where" : "which", [win ? `${name}.exe` : name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  } catch { return null; }
};
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");

// System-wide CPU busy time (all logical CPUs), in seconds, since boot.
const sysCpu = () => {
  let busy = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    busy += t.user + t.sys + t.nice + t.irq;
    total += t.user + t.sys + t.nice + t.irq + t.idle;
  }
  return { busy: busy / 1000, total: total / 1000, n: os.cpus().length };
};

// Run ffmpeg with -benchmark and parse what the process itself reports:
// user + kernel CPU seconds, wall seconds, peak resident memory. These come
// from the OS's own accounting of that one process, so they hold on a machine
// that is busy with other work (wall time does not).
const runFfmpeg = (args, { timeoutMs = 20 * 60 * 1000, cwd } = {}) =>
  new Promise((resolve) => {
    // -benchmark's lines are logged at "info": lift a quieter level so they print
    const a = [...args];
    const vi = a.indexOf("-v");
    if (vi >= 0 && /^(error|warning|quiet|fatal|panic)$/.test(a[vi + 1])) a[vi + 1] = "info";
    else if (vi < 0) a.unshift("-v", "info");
    if (!a.includes("-nostats")) a.unshift("-nostats");
    a.unshift("-benchmark", "-hide_banner", "-y");
    const s0 = sysCpu();
    const t0 = process.hrtime.bigint();
    const p = spawn(FFMPEG, a, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d) => { tail = (tail + d).slice(-6000); });
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      const wall = Number(process.hrtime.bigint() - t0) / 1e9;
      const s1 = sysCpu();
      const m = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(tail);
      const r = /bench: maxrss=(\d+)kB/.exec(tail);
      const utime = m ? parseFloat(m[1]) : null;
      const stime = m ? parseFloat(m[2]) : null;
      resolve({
        code, wall,
        utime, stime, cpu: m ? utime + stime : null,
        rtime: m ? parseFloat(m[3]) : wall,
        maxrssMb: r ? Math.round(parseInt(r[1], 10) / 1024) : null,
        // how busy the whole machine was meanwhile (0..1), ours included
        sysBusy: (s1.busy - s0.busy) / Math.max(0.001, s1.total - s0.total),
        sysBusySec: s1.busy - s0.busy,
        err: code === 0 ? null : tail.split(/\r?\n/).filter((l) => /error|invalid|failed|unable/i.test(l)).slice(-4).join(" | ") || tail.slice(-300),
      });
    });
  });

const probeDuration = (file) => {
  try {
    return parseFloat(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
  } catch { return 0; }
};

// Pin THIS process (and every child it starts afterwards — Windows and Linux
// both hand affinity down) to the first `logical` logical CPUs. On Intel with
// Hyper-Threading logical CPUs 2k and 2k+1 are one core, so 12 = 6C/12T.
const pinTo = (logical) => {
  const mask = (1n << BigInt(logical)) - 1n;
  try {
    if (process.platform === "win32") {
      execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${mask.toString()}`], { stdio: "ignore" });
    } else {
      execFileSync("taskset", ["-p", mask.toString(16), String(process.pid)], { stdio: "ignore" });
    }
    return true;
  } catch { return false; }
};

const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const saveJson = (name, data) => {
  const f = path.join(RESULTS, name);
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  return f;
};

module.exports = { REPO, WORK, MEDIA, OUT, RESULTS, FFMPEG, FFPROBE, sysCpu, runFfmpeg, probeDuration, pinTo, rmrf, median, pct, round, saveJson };

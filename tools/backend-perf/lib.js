// Shared helpers for the backend-efficiency tools (tools/backend-perf/README.md).
// Nothing here touches the product or the live server: every scratch file
// lives OUTSIDE the repository, in EFF_WORK (default <tmp>/aurora-eff-work).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..", "..");
const WORK = process.env.EFF_WORK || path.join(os.tmpdir(), "aurora-eff-work");
const RESULTS = process.env.EFF_RESULTS || path.join(REPO, "docs", "qa", "backend-efficiency", "results");
for (const d of [WORK, RESULTS]) fs.mkdirSync(d, { recursive: true });

const which = (name) => {
  if (process.env[name.toUpperCase() + "_PATH"]) return process.env[name.toUpperCase() + "_PATH"];
  const win = process.platform === "win32";
  try {
    return execFileSync(win ? "where" : "which", [win ? `${name}.exe` : name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  } catch { return null; }
};

// The "weak PC" profile used throughout: two logical CPUs that are two
// DIFFERENT physical cores (on an Intel with Hyper-Threading logical 0 and 1
// are one core, so the mask is 0b101 = CPUs 0 and 2), and a 512 MB old-space
// cap. Children (ffprobe, ffmpeg) inherit the affinity on Windows and Linux.
const WEAK = { mask: 5n, heapMb: 512 };
const pin = (pid, mask) => {
  try {
    if (process.platform === "win32") {
      execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).ProcessorAffinity = ${mask.toString()}`], { stdio: "ignore" });
    } else {
      execFileSync("taskset", ["-p", mask.toString(16), String(pid)], { stdio: "ignore" });
    }
    return true;
  } catch { return false; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = a.filter((x) => x != null).slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const saveJson = (name, data) => {
  const f = path.join(RESULTS, name);
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  return f;
};
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
// A small deterministic generator: the dataset is the same on every run.
const rng = (seed = 1) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const table = (rows, cols) => {
  const head = `| ${cols.map((c) => c[0]).join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
  return [head, ...rows.map((r) => `| ${cols.map((c) => { const v = typeof c[1] === "function" ? c[1](r) : r[c[1]]; return v == null ? "" : String(v); }).join(" | ")} |`)].join("\n");
};

module.exports = { REPO, WORK, RESULTS, which, WEAK, pin, sleep, median, pct, round, saveJson, arg, rng, table };

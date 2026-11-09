// mean signed per-channel difference (candidate - ref), Chrome-decoded, to catch colour/range mis-tagging
const { execFileSync } = require("child_process"); const FF = require("../../src/config").FFMPEG;
const raw = (f) => execFileSync(FF, ["-v", "error", "-i", f, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 26 });
const [ref, ...cands] = process.argv.slice(2); const r = raw(ref);
for (const c of cands) { const d = raw(c); const s = [0, 0, 0]; const a = [0, 0, 0];
  for (let i = 0; i < r.length; i++) { s[i % 3] += d[i] - r[i]; a[i % 3] += Math.abs(d[i] - r[i]); }
  const n = r.length / 3; console.log(c.split(/[\/]/).pop(), "signed", s.map((x) => (x / n).toFixed(2)).join(" "), "abs", a.map((x) => (x / n).toFixed(2)).join(" ")); }

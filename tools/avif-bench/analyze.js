// Stage 4: AVIF settings against today's WebP, per picture class and width.
const fs = require("fs"), path = require("path");
const S = process.argv[2]; const M = (process.argv[3] || "enc").split(",").flatMap((d) => JSON.parse(fs.readFileSync(path.join(S, d, "metrics.json"))));
const by = new Map(); for (const m of M) { if (!by.has(m.img)) by.set(m.img, {}); by.get(m.img)[m.key] = m; }
const keys = [...new Set(M.map((m) => m.key))].filter((k) => k.startsWith("avif")).sort();
const cls = (img) => img.replace(/^(bd|po|pl)-.*-w(\d+)$/, "$1-w$2");
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : NaN; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
// "as good as the WebP" on a picture: no metric worse than the WebP's beyond noise
const TOL = { ssim: 0.0005, msssim: 0.0005, psnrhvs: 0.1, cambi: 0.05 };
const asGood = (a, w) => a.ssim >= w.ssim - TOL.ssim && a.msssim >= w.msssim - TOL.msssim && a.psnrhvs >= w.psnrhvs - TOL.psnrhvs && a.cambi <= w.cambi + TOL.cambi;
const rows = [];
for (const k of keys) {
  const r = { key: k, n: 0, good: 0, ratio: [], dSsim: [], dMs: [], dHvs: [], dCambi: [], cpu: [], cpuW: [] };
  for (const [img, e] of by) { const a = e[k], w = e.webp; if (!a || !w || a.ssim == null) continue;
    r.n++; if (asGood(a, w)) r.good++; r.ratio.push(a.bytes / w.bytes); r.dSsim.push(a.ssim - w.ssim); r.dMs.push(a.msssim - w.msssim); r.dHvs.push(a.psnrhvs - w.psnrhvs); r.dCambi.push(a.cambi - w.cambi); r.cpu.push(a.cpu); r.cpuW.push(w.cpu); }
  rows.push(r);
}
console.log("setting                              n  asGood  bytes/webp(med,mean)  dSSIM    dMSSSIM  dPSNRHVS dCAMBI  cpu(avif/webp)");
for (const r of rows) console.log(r.key.padEnd(36), String(r.n).padStart(3), `${(100 * r.good / r.n).toFixed(0)}%`.padStart(6), `${med(r.ratio).toFixed(2)} ${mean(r.ratio).toFixed(2)}`.padStart(14), mean(r.dSsim).toFixed(4).padStart(9), mean(r.dMs).toFixed(4).padStart(8), mean(r.dHvs).toFixed(2).padStart(8), mean(r.dCambi).toFixed(3).padStart(7), `${(mean(r.cpu)).toFixed(2)}/${mean(r.cpuW).toFixed(2)}s`);
// per class for the requested keys
const pick = (process.argv[4] || "").split(",").filter(Boolean);
for (const k of pick) {
  console.log(`\n${k} by class`);
  const groups = new Map();
  for (const [img, e] of by) { const a = e[k], w = e.webp, j = e.jpg; if (!a || !w) continue; const c = cls(img); if (!groups.has(c)) groups.set(c, []); groups.get(c).push({ img, a, w, j }); }
  for (const [c, g] of [...groups].sort()) {
    const wb = g.reduce((x, y) => x + y.w.bytes, 0), ab = g.reduce((x, y) => x + y.a.bytes, 0), jb = g.reduce((x, y) => x + y.j.bytes, 0);
    console.log(c.padEnd(10), `n=${g.length}`, `webp ${(wb / g.length / 1024).toFixed(1)}KB`, `avif ${(ab / g.length / 1024).toFixed(1)}KB`, `jpg ${(jb / g.length / 1024).toFixed(1)}KB`, `saving vs webp ${(100 * (1 - ab / wb)).toFixed(0)}%`, `asGood ${g.filter((x) => asGood(x.a, x.w)).length}/${g.length}`,
      `ssim ${mean(g.map((x) => x.w.ssim)).toFixed(4)}->${mean(g.map((x) => x.a.ssim)).toFixed(4)}`, `cambi ${mean(g.map((x) => x.w.cambi)).toFixed(2)}->${mean(g.map((x) => x.a.cambi)).toFixed(2)}`, `cpu ${mean(g.map((x) => x.a.cpu)).toFixed(2)}s wall ${mean(g.map((x) => x.a.wall)).toFixed(2)}s (webp ${mean(g.map((x) => x.w.cpu)).toFixed(2)}s)`);
  }
  const bad = []; for (const [img, e] of by) { const a = e[k], w = e.webp; if (a && w && !asGood(a, w)) bad.push(`${img}: ssim ${(a.ssim - w.ssim).toFixed(4)} ms ${(a.msssim - w.msssim).toFixed(4)} hvs ${(a.psnrhvs - w.psnrhvs).toFixed(2)} cambi ${(a.cambi - w.cambi).toFixed(3)} bytes ${(a.bytes / w.bytes).toFixed(2)}`); }
  if (bad.length) console.log("  not as good:\n   " + bad.join("\n   "));
}

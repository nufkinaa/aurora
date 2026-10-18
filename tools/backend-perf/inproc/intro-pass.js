// Runs INSIDE the private instance (probe /exec): one intro pass
// (media/introdetect.js run()) over a settled library — what follows every
// rescan — counting the blocking stats it makes and its wall time.
module.exports = async (arg = {}, ctx) => {
  const fs = require("fs");
  const intro = ctx.req("src/media/introdetect");
  const real = fs.statSync;
  let stats = 0;
  fs.statSync = function (...a) { stats++; return real.apply(this, a); };
  const t0 = ctx.now();
  const c0 = process.cpuUsage();
  try { await intro.run(); } finally { fs.statSync = real; }
  const c = process.cpuUsage(c0);
  return { stats, wallMs: Math.round(ctx.now() - t0), cpuMs: Math.round((c.user + c.system) / 1000) };
};

// Runs INSIDE the private instance (probe /exec): what the intro pass pays to
// learn the date of every library episode — introdetect's own mtimeOf, called
// as one pass calls it (once per episode, inside a pass's memo), counting the
// blocking stats. (Calling run() itself measures nothing when a pass is
// already running or waiting for its place behind other background work.)
module.exports = async (arg = {}, ctx) => {
  const fs = require("fs");
  const scanner = ctx.req("src/media/scanner");
  const intro = ctx.req("src/media/introdetect");
  const paths = [];
  for (const s of scanner.index.shows) for (const se of s.seasons || []) for (const ep of se.episodes || []) { const e = scanner.resolve(ep.id); if (e) paths.push(e.path); }
  const real = fs.statSync;
  let stats = 0;
  fs.statSync = function (...a) { stats++; return real.apply(this, a); };
  const t0 = ctx.now();
  try { intro._internals.mtimeMemoFor(() => { for (const p of paths) intro._internals.mtimeOf(p); }); } finally { fs.statSync = real; }
  return { episodes: paths.length, stats, wallMs: Math.round((ctx.now() - t0) * 10) / 10 };
};

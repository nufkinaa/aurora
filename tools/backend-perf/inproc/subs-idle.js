// Runs INSIDE a private instance (probe /exec): are the subtitle background
// jobs (audio resync, language detection) done? They rewrite their stores and
// burn CPU while they run — a storage measurement waits for them.
module.exports = (arg, ctx) => {
  const out = {};
  for (const m of ["src/media/subaudio", "src/media/sublang"]) {
    try { out[m] = ctx.req(m).idle(); } catch { out[m] = null; }
  }
  out.idle = Object.values(out).every((v) => v !== false);
  return out;
};

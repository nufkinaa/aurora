// Runs INSIDE the private instance (probe /exec, perf-server 2026-11-10): the
// server's own background jobs, one at a time, each measured alone — wall
// time, event-loop active time, the loop's longest delay while it ran, CPU.
// The instance has no network, so jobs that are mostly fetching (skip
// databases, title metadata) measure only their local part.
module.exports = async (arg, ctx) => {
  const only = arg && arg.only ? new Set(arg.only) : null;
  const jobs = [
    ["recommendations sync (daily)", () => ctx.req("src/media/recs").sync()],
    ["recs warm (boot)", () => ctx.req("src/media/recs").warm()],
    ["household-recs daily", () => ctx.req("src/media/household").instance().daily()],
    ["calendar refresh (daily)", () => ctx.req("src/media/calendar").refresh()],
    ["my-list-downloads daily", () => ctx.req("src/media/mylistdl").daily()],
    ["search index rebuild", async () => { const s = ctx.req("src/media/search"); s._internals._reset && s._internals._reset(); return s.warm && s.warm(); }],
    ["healer round", () => ctx.req("src/lib/healer").run()],
    ["health round", () => ctx.req("src/lib/health").run()],
    ["library rescan (worker walk)", () => ctx.req("src/media/scanner").scanAsync({ force: true })],
    ["library rescan (full, every 6th)", () => ctx.req("src/media/scanner").scanAsync({ force: true, full: true })],
    ["backup (daily)", () => ctx.req("src/lib/backup").runDaily()],
  ];
  const out = [];
  for (const [name, fn] of jobs) {
    if (only && !only.has(name)) continue;
    await new Promise((r) => setTimeout(r, 1500));
    ctx.reset();
    const t0 = ctx.now();
    let error = null;
    try { await fn(); } catch (e) { error = String((e && e.message) || e).slice(0, 120); }
    // let what it queued for the next ticks run too
    await new Promise((r) => setTimeout(r, 300));
    const s = ctx.snap();
    out.push({
      name, wallMs: Math.round(ctx.now() - t0), loopActiveMs: Math.round(s.elu.activeMs), loopMaxMs: s.loopDelay ? Math.round(s.loopDelay.max) : null,
      cpuMs: Math.round((s.cpuSinceReset.user + s.cpuSinceReset.system) / 1000), syncFs: s.syncFs.filter((f) => !/ @ /.test(f.key)).reduce((a, f) => a + f.n, 0), error,
    });
  }
  return out;
};

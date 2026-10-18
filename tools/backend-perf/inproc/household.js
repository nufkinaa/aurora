// Runs INSIDE a private instance (probe /exec): the household as this build
// sees it — profiles, history rows, one profile's row of one item, what the
// stores had to recover, the journal's boot (when this build has one).
module.exports = (arg, ctx) => {
  const profiles = ctx.req("src/profiles");
  const js = ctx.req("src/lib/jsonstore");
  let rows = 0;
  for (const p of profiles.list()) {
    const st = profiles.stateOf(p.id);
    rows += Object.keys(st.progress || {}).length + Object.keys(st.titles || {}).length;
  }
  const st = arg && arg.pid ? profiles.stateOf(arg.pid) : null;
  const status = js.status();
  let journal = null;
  try { const j = profiles._internals.journal && profiles._internals.journal(); if (j) journal = { boot: j.stats.boot, pending: j.pending() }; } catch {}
  return {
    profiles: profiles.list().length,
    rows,
    item: st && arg.item ? st.progress[arg.item] || null : null,
    safeMode: status.safeMode,
    recoveries: status.recoveries.length,
    journal,
  };
};

// Runs INSIDE a private instance (probe /exec): plays one item on one
// profile the way a player reports — a save every `everyMs` (positions one
// second apart per tick), a seek every `seekEvery` ticks — until told to
// stop. { op: "start", pid, item, from, everyMs, seekEvery } | { op: "status" }
// | { op: "stop" }. status: { last, lastUrgent, lastUrgentAt, n }.
module.exports = (arg, ctx) => {
  const g = global.__drillTicks || (global.__drillTicks = { timer: null, n: 0, last: null, lastUrgent: null, lastUrgentAt: 0 });
  if (arg.op === "start") {
    const profiles = ctx.req("src/profiles");
    if (g.timer) clearInterval(g.timer);
    let pos = arg.from || 100;
    g.timer = setInterval(() => {
      g.n++;
      const seek = g.n % (arg.seekEvery || 25) === 0;
      pos += seek ? 600 : 1;
      profiles.setProgress(arg.pid, arg.item, pos, 100000, null);
      g.last = pos;
      if (seek || g.n === 1) { g.lastUrgent = pos; g.lastUrgentAt = Date.now(); }
    }, arg.everyMs || 200);
    return { ok: true };
  }
  if (arg.op === "stop" && g.timer) { clearInterval(g.timer); g.timer = null; }
  return { n: g.n, last: g.last, lastUrgent: g.lastUrgent, lastUrgentAt: g.lastUrgentAt, now: Date.now() };
};

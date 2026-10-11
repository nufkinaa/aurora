// Runs INSIDE the private instance (probe /exec): what the small things every
// request does cost, one call at a time (microseconds, CPU). arg.sid: a session id.
module.exports = (arg = {}, ctx) => {
  const authz = ctx.req("src/lib/authz");
  const sessions = ctx.req("src/lib/sessions");
  const profiles = ctx.req("src/profiles");
  const scanner = ctx.req("src/media/scanner");
  const identity = ctx.req("src/media/identity");
  const resetgate = ctx.req("src/lib/resetgate");
  const req = { headers: { "x-session": arg.sid, "user-agent": "bench" }, path: "/api/library", method: "GET", query: {}, get: () => undefined };
  const p0 = profiles.list()[0].id;
  const pLast = profiles.list()[profiles.list().length - 1].id;
  const films = scanner.index.movies;
  const lastEp = scanner.index.shows.length ? scanner.index.shows[scanner.index.shows.length - 1].seasons.slice(-1)[0].episodes.slice(-1)[0].id : null;
  const time = (fn, n) => {
    for (let i = 0; i < Math.min(n, 200); i++) fn(i);
    const c0 = process.cpuUsage();
    const t0 = ctx.now();
    for (let i = 0; i < n; i++) fn(i);
    const c = process.cpuUsage(c0);
    return { us: Math.round(((ctx.now() - t0) * 1000 / n) * 100) / 100, cpuUs: Math.round(((c.user + c.system) / n) * 100) / 100 };
  };
  const out = {};
  out["sessions.get(sid) — sha256 + row copy"] = time(() => sessions.get(arg.sid), 100000);
  out["authz.sessionFor(req) — the same + profiles.list().find"] = time(() => authz.sessionFor(req), 100000);
  out[`profiles.exists(last of ${profiles.list().length}) — the array scan alone`] = time(() => profiles.exists(pLast), 300000);
  out["resetgate: restrictedProfile + signedOut (every gated request)"] = time(() => { resetgate.restrictedProfile(req); resetgate.signedOut(req); }, 100000);
  out["scanner.findById(first film)"] = time(() => scanner.findById(films[0].id), 200000);
  out["scanner.findById(last film)"] = time(() => scanner.findById(films[films.length - 1].id), 100000);
  if (lastEp) out["scanner.findById(last episode of the last show)"] = time(() => scanner.findById(lastEp), 50000);
  out["scanner.findById(an id that is not in the library)"] = time(() => scanner.findById("torrent|abc|0"), 50000);
  out["identity.findLibraryFor({title, year}) — no maps handed in"] = time((i) => identity.findLibraryFor({ type: "movie", title: films[i % films.length].title, year: films[i % films.length].year }), 2000);
  out["identity._internals.libraryMaps()"] = time(() => identity._internals.libraryMaps(), 300);
  out["profiles.getProgressView(busiest profile)"] = time(() => profiles.getProgressView(p0), 300);
  out["profiles.continueWatching(busiest profile)"] = time(() => profiles.continueWatching(p0), 100);
  out["JSON.stringify(profiles store) — one save's worth"] = time(() => JSON.stringify(profiles._internals.store.data), 20);
  return { profiles: profiles.list().length, films: films.length, calls: Object.entries(out).map(([what, v]) => ({ what, ...v })) };
};

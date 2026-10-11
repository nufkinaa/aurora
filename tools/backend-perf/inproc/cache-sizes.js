// Runs INSIDE the private instance (probe /exec): how many entries each
// module-scope cache holds right now — the ones the code review found with
// no bound, or a bound that depends on what clients send. Read through the
// modules' own exports where they have one; a cache that is not reachable
// from outside its module is left out (and listed in the report as such).
module.exports = (arg, ctx) => {
  const out = {};
  const size = (name, fn) => { try { const v = fn(); out[name] = v == null ? null : typeof v === "number" ? v : v.size != null ? v.size : Array.isArray(v) ? v.length : Object.keys(v).length; } catch { out[name] = null; } };
  const req = ctx.req;
  size("blurup.mem (placeholders)", () => req("src/lib/blurup")._internals.mem);
  size("scanner registry (ids)", () => { const s = req("src/media/scanner"); return s.index.movies.length + s.index.shows.reduce((a, x) => a + x.episodeCount, 0); });
  size("profiles: stored state entries", () => req("src/profiles")._internals.store.data.state);
  size("profiles.json bytes", () => JSON.stringify(req("src/profiles")._internals.store.data).length);
  size("sessions.json rows", () => req("src/lib/sessions")._internals.store.data);
  size("realtime.clients", () => req("src/realtime").clients);
  size("realtime.watchHistory", () => req("src/realtime").watchHistory.data);
  size("telemetry sessions (watch-sessions.json)", () => req("src/telemetry")._internals ? req("src/telemetry")._internals.sessions.data : null);
  size("recs caches", () => req("src/media/recs")._internals.caches);
  size("tel timings histograms", () => req("src/lib/tel/timings").summary().histograms);
  size("metadata-cache.json entries", () => req("src/media/metadata")._store ? req("src/media/metadata")._store.data : null);
  size("discover certificates", () => req("src/media/discover")._internals.certStore.data);
  size("logbuffer lines", () => { const l = req("src/lib/logbuffer"); return l.lines ? l.lines() : l.buf; });
  const mem = process.memoryUsage();
  return { sizes: out, rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), externalMb: Math.round(mem.external / 1048576), arrayBuffersMb: Math.round(mem.arrayBuffers / 1048576), handles: process._getActiveHandles().length };
};

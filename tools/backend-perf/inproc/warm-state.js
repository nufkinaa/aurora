// Runs INSIDE the private instance (probe /exec): is everything that builds
// itself after boot built? The library probed, the recommender's vectors made,
// the search index made.
module.exports = (arg, ctx) => {
  const scanner = ctx.req("src/media/scanner");
  const out = { enriched: !!scanner.index.enriched, films: scanner.index.movies.length, shows: scanner.index.shows.length, uptimeMs: Math.round(ctx.now()) };
  try { out.recs = !!ctx.req("src/media/recs").ready(); } catch { out.recs = null; }
  try { const s = ctx.req("src/media/search"); out.search = s._internals && s._internals.indexBuilt ? !!s._internals.indexBuilt() : null; } catch { out.search = null; }
  out.warm = out.enriched && out.recs !== false && out.search !== false && out.uptimeMs > 22000;
  return out;
};

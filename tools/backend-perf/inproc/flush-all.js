// Runs INSIDE a private instance (probe /exec): what a graceful shutdown
// does to the stores (lib/shutdown.js -> jsonstore.flushAll).
module.exports = (arg, ctx) => { ctx.req("src/lib/jsonstore").flushAll(); return { ok: true }; };

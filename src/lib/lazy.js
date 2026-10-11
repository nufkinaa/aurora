// A require() written INSIDE a function — the usual way round a circular
// import — asked for once instead of on every call.
//
//   const lazy = require("../lib/lazy");
//   const scanner = lazy(require, "./media/scanner");
//   … scanner().findById(id) …
//
// Why this exists: `require("x")` of a module that is already loaded is only
// fast when THIS folder was the one that first loaded it under THIS string
// (Node remembers that pair). Otherwise every call resolves the path again:
// measured inside the server on Node 22, 40 µs a call on a two-core box
// instead of under 1 µs — and several request paths did it per row (Home:
// 1,771 calls, 71 ms of CPU per request; every request of a household with a
// kids profile: 3 calls). docs/qa/backend-efficiency has the numbers.
//
// What a call returns is exactly what require() returns at that moment:
//   - the module's CURRENT exports (read on every call, so a module that
//     replaces `module.exports` is followed);
//   - nothing is remembered until the module has finished loading (a call
//     made in the middle of a circular load gets Node's own answer);
//   - if the module was dropped from require.cache (tests do this to get a
//     fresh copy), the next call asks require() again.
module.exports = (req, id) => {
  let file = null;
  let mod;
  return () => {
    if (mod !== undefined && req.cache[file] === mod) return mod.exports;
    const got = req(id);
    try {
      file = req.resolve(id);
      const m = req.cache[file];
      mod = m && m.loaded ? m : undefined;
    } catch {
      mod = undefined; // a built-in, or something require.resolve cannot name: just ask every time
    }
    return got;
  };
};

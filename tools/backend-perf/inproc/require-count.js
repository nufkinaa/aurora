// Runs INSIDE the private instance (probe /exec): how many times does serving
// ONE request call require() for a module that is already loaded, from where,
// and what does one such call cost here?
//   arg.path     the request to make (to this server), arg.headers
//   arg.repeat   how many requests (default 3; counts are per request)
module.exports = async (arg = {}, ctx) => {
  const Module = require("module");
  const path = require("path");
  const http = require("http");
  const config = ctx.req("src/config");
  const get = () => new Promise((resolve, reject) => {
    const u = new URL(arg.path, "http://127.0.0.1");
    const req = http.get({ host: "127.0.0.1", port: config.PORT, path: u.pathname + u.search, headers: arg.headers || {} }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
  });
  await get(); // warm
  const counts = new Map();
  const orig = Module.prototype.require;
  let total = 0;
  Module.prototype.require = function (id) {
    total++;
    const from = path.relative(ctx.root, this.filename || "?").split(path.sep).join("/");
    const key = `${from} -> ${id}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    return orig.apply(this, arguments);
  };
  const repeat = arg.repeat || 3;
  let status = 0;
  try { for (let i = 0; i < repeat; i++) status = await get(); } finally { Module.prototype.require = orig; }
  // the price of one require() of a loaded module, from a module of this server
  const mod = require.cache[path.join(ctx.root, "src", "profiles.js")];
  const N = 20000;
  const c0 = process.cpuUsage();
  const t0 = ctx.now();
  for (let i = 0; i < N; i++) mod.require("./media/identity");
  const usEach = ((ctx.now() - t0) * 1000) / N;
  const c = process.cpuUsage(c0);
  return {
    status, perRequest: Math.round(total / repeat), microsecondsPerRequire: Math.round(usEach * 10) / 10, cpuMicrosecondsPerRequire: Math.round(((c.user + c.system) / N) * 10) / 10,
    msPerRequestInRequire: Math.round(((total / repeat) * usEach) / 100) / 10,
    top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => ({ site: k, perRequest: Math.round((n / repeat) * 10) / 10 })),
  };
};

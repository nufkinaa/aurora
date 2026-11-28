// Preloaded into tv-instance.js's private server: one line per media request
// (/stream/*) to the file named by AURORA_RIG_REQLOG — when it came, its Range,
// the status, how many bytes went out, how long the response lived and how it
// ended (finished / closed by the viewer). To see what the TV's player asks
// for around a stall: a seek is a new Range, a reader that gave up is a close.
"use strict";
const fs = require("fs");
const http = require("http");
const file = process.env.AURORA_RIG_REQLOG;
if (file) {
  const t0 = Date.now();
  const out = (s) => { try { fs.appendFileSync(file, s + "\n"); } catch {} };
  const emit = http.Server.prototype.emit;
  let n = 0;
  // every second, the bytes each open media response has sent so far
  const open = new Map();
  setInterval(() => {
    if (!open.size) return;
    out(`${((Date.now() - t0) / 1000).toFixed(2)} open ${[...open].map(([id, r]) => `#${id}=${r.bytes()}`).join(" ")}`);
  }, 1000).unref();
  http.Server.prototype.emit = function (ev, req, res) {
    if (ev === "request" && req && /^\/stream\//.test(req.url || "")) {
      const id = ++n;
      const at = Date.now();
      let bytes = 0;
      const write = res.write;
      res.write = function (chunk, ...rest) { if (chunk) bytes += chunk.length; return write.call(this, chunk, ...rest); };
      const end = res.end;
      res.end = function (chunk, ...rest) { if (chunk && typeof chunk !== "function") bytes += chunk.length; return end.call(this, chunk, ...rest); };
      const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
      out(`${((at - t0) / 1000).toFixed(2)} #${id} ${req.method} ${req.url.split("?")[0]} range=${req.headers.range || "-"} peer=${peer}`);
      let done = false;
      open.set(id, { bytes: () => bytes });
      const fin = (how) => { if (done) return; done = true; open.delete(id); out(`${((Date.now() - t0) / 1000).toFixed(2)} #${id} ${how} status=${res.statusCode} bytes=${bytes} lived=${Date.now() - at}ms`); };
      res.on("finish", () => fin("finished"));
      res.on("close", () => fin("closed"));
    }
    return emit.apply(this, arguments);
  };
}

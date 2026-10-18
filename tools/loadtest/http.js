// The HTTP side of a simulated device: one keep-alive agent per device (a
// browser tab or a TV app holds its own connections), the session header, and
// a result for every request that never throws.
"use strict";
const http = require("http");

class Client {
  constructor(base, { sid = null, maxSockets = 6, ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", extra = {} } = {}) {
    this.base = new URL(base);
    this.sid = sid;
    this.ua = ua;
    this.extra = extra;
    this.agent = new http.Agent({ keepAlive: true, maxSockets });
    this.closed = false;
  }
  // -> { status, bytes, ms, ttfbMs, headers, body? } ; status 0 = transport error
  // opts.onChunk(chunk, res, req): return false to stop reading (the request is destroyed)
  request(method, p, { body = null, headers = {}, onChunk = null, keepBody = false, compressed = true, timeoutMs = 60000, signal = null } = {}) {
    return new Promise((resolve) => {
      if (this.closed) return resolve({ status: 0, bytes: 0, ms: 0, error: "closed" });
      const t0 = process.hrtime.bigint();
      const el = () => Number(process.hrtime.bigint() - t0) / 1e6;
      const data = body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      const h = { "User-Agent": this.ua, ...(compressed ? { "Accept-Encoding": "gzip, deflate, br" } : {}), ...(this.sid ? { "X-Session": this.sid } : {}), ...this.extra, ...headers };
      if (data) { h["Content-Type"] = h["Content-Type"] || "application/json"; h["Content-Length"] = data.length; }
      let done = false;
      const finish = (r) => { if (done) return; done = true; resolve(r); };
      const req = http.request({ host: this.base.hostname, port: this.base.port, path: p, method, headers: h, agent: this.agent }, (res) => {
        const ttfbMs = el();
        let bytes = 0;
        const chunks = keepBody ? [] : null;
        res.on("data", (c) => {
          bytes += c.length;
          if (chunks) chunks.push(c);
          if (onChunk && onChunk(c, res, req) === false) { req.destroy(); finish({ status: res.statusCode, bytes, ms: el(), ttfbMs, headers: res.headers, stopped: true }); }
        });
        res.on("end", () => finish({ status: res.statusCode, bytes, ms: el(), ttfbMs, headers: res.headers, body: chunks ? Buffer.concat(chunks) : undefined }));
        res.on("error", () => finish({ status: 0, bytes, ms: el(), ttfbMs, error: "res-error" }));
        res.on("aborted", () => finish({ status: 0, bytes, ms: el(), ttfbMs, error: "aborted" }));
        // (a response this side destroyed — a seek, a stop — ends with "close" and nothing else)
        res.on("close", () => finish({ status: res.complete ? res.statusCode : 0, bytes, ms: el(), ttfbMs, headers: res.headers, stopped: !res.complete, error: res.complete ? undefined : "closed" }));
      });
      if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
      req.on("error", (e) => finish({ status: 0, bytes: 0, ms: el(), error: e.code || e.message }));
      if (signal) signal.addEventListener("abort", () => { req.destroy(); finish({ status: 0, bytes: 0, ms: el(), error: "aborted-by-client", stopped: true }); }, { once: true });
      if (data) req.write(data);
      req.end();
    });
  }
  async json(p, o = {}) {
    const r = await this.request("GET", p, { ...o, keepBody: true, compressed: false });
    let j = null;
    try { j = r.body ? JSON.parse(r.body.toString("utf8")) : null; } catch {}
    return { ...r, json: j };
  }
  async text(p, o = {}) {
    const r = await this.request("GET", p, { ...o, keepBody: true, compressed: false });
    return { ...r, text: r.body ? r.body.toString("utf8") : "" };
  }
  close() { this.closed = true; this.agent.destroy(); }
}

module.exports = { Client };

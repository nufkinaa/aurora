#!/usr/bin/env node
// A server far away, on this machine: a reverse proxy in front of a local
// Aurora that makes every request wait a round trip and paces the answers to
// a line's speed. Chrome's own line emulation (lib.js throttle) is not felt
// by what the service worker fetches — and the service worker fetches every
// poster — so a page measured with it sees pictures arrive in ~10 ms.
//
//   node tools/webperf/slowproxy.js --to http://127.0.0.1:4000 [--port 0]
//        [--rtt 70] [--mbit 50] [--state <file>]
//
// Prints (and writes to --state) { url, pid }. Looking only: every request is
// passed on as it came. Stop it by its pid.
"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const { argv } = require("./lib");

const to = new URL(argv("to", "http://127.0.0.1:4000"));
const rtt = Number(argv("rtt", "70"));
const bps = (Number(argv("mbit", "50")) * 1e6) / 8;

// one line for everybody: bytes leave in 10 ms slices
let waiting = [];
let timer = null;
const pump = () => {
  let budget = bps / 100;
  while (budget > 0 && waiting.length) {
    const job = waiting[0];
    const n = Math.min(budget, job.buf.length - job.at);
    job.res.write(job.buf.subarray(job.at, job.at + n));
    job.at += n;
    budget -= n;
    if (job.at >= job.buf.length) { waiting.shift(); job.done(); }
  }
  if (!waiting.length) { clearInterval(timer); timer = null; }
};
const send = (res, buf) => new Promise((done) => {
  waiting.push({ res, buf, at: 0, done });
  if (!timer) timer = setInterval(pump, 10);
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const server = http.createServer((req, res) => {
  setTimeout(() => {
    const up = http.request({ host: to.hostname, port: to.port, method: req.method, path: req.url, headers: { ...req.headers, host: to.host }, agent }, async (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      try {
        for await (const chunk of ur) await send(res, chunk);
      } catch {}
      res.end();
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  }, rtt);
});
// (web sockets and the like: passed straight through)
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(Number(to.port), to.hostname, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
server.listen(Number(argv("port", "0")), "127.0.0.1", () => {
  const state = { url: `http://127.0.0.1:${server.address().port}`, pid: process.pid, to: to.href, rtt, mbit: bps * 8 / 1e6 };
  if (argv("state")) fs.writeFileSync(argv("state"), JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state));
});

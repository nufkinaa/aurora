#!/usr/bin/env node
// A TCP proxy that can make the connections it carries go DEAD without
// closing them — what a Wi-Fi hand-over, a router's NAT table or a mobile
// line does to a long download: no FIN, no RST, just no more bytes. New
// connections made afterwards pass as normal.
//
//   node tools/stall-rig/blackhole-proxy.js --listen 4300 --to 4123 --control 4301
//   curl http://127.0.0.1:4301/freeze          every connection open NOW goes silent for ever
//   curl http://127.0.0.1:4301/freeze?big=1    only those that have carried >= 1 MB (the media ones)
//   curl http://127.0.0.1:4301/list            what is open, with bytes carried
//
// Nothing here is for production.
"use strict";
const net = require("net");
const http = require("http");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const LISTEN = Number(arg("listen", 4300));
const TO = Number(arg("to", 4000));
const CONTROL = Number(arg("control", LISTEN + 1));
const HOST = String(arg("bind", "0.0.0.0"));

let seq = 0;
const conns = new Map();
const server = net.createServer((client) => {
  const id = ++seq;
  const up = net.connect(TO, "127.0.0.1");
  const c = { id, client, up, down: 0, upBytes: 0, frozen: false, at: Date.now(), first: "" };
  conns.set(id, c);
  client.on("data", (d) => {
    if (!c.first) c.first = String(d.slice(0, 120)).split("\r\n")[0];
    c.upBytes += d.length;
    if (!c.frozen) up.write(d);
  });
  up.on("data", (d) => {
    if (c.frozen) { up.pause(); return; } // hold everything: the client hears nothing more
    c.down += d.length;
    if (!client.write(d)) { up.pause(); client.once("drain", () => { if (!c.frozen) up.resume(); }); }
  });
  const end = () => { conns.delete(id); client.destroy(); up.destroy(); };
  client.on("close", end); up.on("close", () => { if (!c.frozen) end(); });
  client.on("error", end); up.on("error", () => {});
});
server.listen(LISTEN, HOST, () => console.log(`[blackhole] ${HOST}:${LISTEN} -> 127.0.0.1:${TO}; control http://127.0.0.1:${CONTROL}`));

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/freeze") {
    const big = u.searchParams.get("big") === "1";
    let n = 0;
    for (const c of conns.values()) {
      if (c.frozen || (big && c.down < 1024 * 1024)) continue;
      c.frozen = true;
      c.up.pause();
      n++;
      console.log(`[blackhole] ${new Date().toISOString().slice(11, 19)} froze #${c.id} (${(c.down / 1e6).toFixed(1)} MB carried) ${c.first}`);
    }
    return res.end(`froze ${n}\n`);
  }
  if (u.pathname === "/list") {
    return res.end([...conns.values()].map((c) => `#${c.id} ${c.frozen ? "FROZEN" : "live"} ${(c.down / 1e6).toFixed(1)}MB ${c.first}`).join("\n") + "\n");
  }
  res.statusCode = 404;
  res.end();
}).listen(CONTROL, "127.0.0.1");

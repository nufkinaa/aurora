#!/usr/bin/env node
// A local stand-in for what Caddy does in front of the real server: TLS and
// HTTP/2 (HTTP/1.1 still accepted, as Caddy accepts it), every request passed
// on to the plain-HTTP instance behind it.
//
//   node tools/ttff/h2-front.js --listen 4443 --to 4000
//
// Why it matters for start-up time: over HTTP/1.1 a browser opens up to six
// connections and each new one costs a round trip (TCP) before its first
// request; over TLS a further one (TLS 1.3) or two (1.2). HTTP/2 does all of
// that ONCE and then runs every request — playlist, segment, API, picture —
// side by side on the one connection, whose congestion window stays warm.
//
// The certificate is self-signed (made with the openssl that ships with Git);
// the harness's browser is told to accept it. Nothing here is for production.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const http2 = require("http2");
const net = require("net");
const { spawnSync } = require("child_process");

const CERT_DIR = path.join(__dirname, ".runs", "cert");
const cert = () => {
  const key = path.join(CERT_DIR, "key.pem");
  const crt = path.join(CERT_DIR, "cert.pem");
  if (fs.existsSync(key) && fs.existsSync(crt) && Date.now() - fs.statSync(crt).mtimeMs < 20 * 24 * 3600 * 1000) {
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const candidates = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"];
  for (const exe of candidates) {
    const r = spawnSync(exe, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "30", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { windowsHide: true, encoding: "utf-8", env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
    if (r.status === 0 && fs.existsSync(crt)) return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  }
  throw new Error("could not make a certificate: openssl was not found (it ships with Git for Windows)");
};

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "host"]);

const start = ({ listen = 0, to = 4000, toHost = "127.0.0.1" } = {}) =>
  new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
    const server = http2.createSecureServer({ ...cert(), allowHTTP1: true });
    const sockets = new Set();
    server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    server.on("secureConnection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    server.on("request", (req, res) => {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(":") && !HOP.has(k)) headers[k] = v;
      headers.host = req.headers[":authority"] || req.headers.host || `${toHost}:${to}`;
      headers["x-forwarded-proto"] = "https";
      const up = http.request({ host: toHost, port: to, method: req.method, path: req.url, headers, agent }, (ur) => {
        const out = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) out[k] = v;
        try { res.writeHead(ur.statusCode, out); } catch { return ur.destroy(); }
        ur.pipe(res);
        res.on("close", () => ur.destroy());
      });
      up.on("error", () => { try { if (!res.headersSent) res.writeHead(502); res.end(); } catch {} });
      req.pipe(up);
      req.on("aborted", () => up.destroy());
    });
    // The live socket (WebSocket) arrives as an HTTP/1.1 upgrade: pass the bytes through.
    server.on("upgrade", (req, socket, head) => {
      const up = net.connect(to, toHost, () => {
        up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
        if (head && head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      const end = () => { up.destroy(); socket.destroy(); };
      up.on("error", end);
      socket.on("error", end);
    });
    server.on("error", reject);
    server.listen(listen, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => { for (const s of sockets) s.destroy(); agent.destroy(); server.close(() => done()); }),
      });
    });
  });

module.exports = { start };

if (require.main === module) {
  const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : def; };
  start({ listen: arg("listen", 4443), to: arg("to", 4000) }).then((f) => console.log(`h2 front: https://127.0.0.1:${f.port} -> http://127.0.0.1:${arg("to", 4000)}`), (e) => { console.error(e.message); process.exit(1); });
}

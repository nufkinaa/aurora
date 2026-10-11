// An HTTPS + HTTP/2 front for the private instance, standing where Caddy
// stands on the public site (nufurora.com answers "Via: 1.1 Caddy", h2 and
// h3 on offer): one connection, every request multiplexed on it. Without
// this the harness would measure HTTP/1.1 with six connections per host —
// right for http://<lan address>:4000 at home, wrong for a phone on mobile
// data, which is where a weak line happens.
//
//   const front = await startFront(instance.url)   // { url: "https://127.0.0.1:<port>", spki, stop() }
//
// It passes bytes through untouched (the app's own compression, caching
// headers and ETags are what is being measured) and carries the WebSocket
// over HTTP/1.1 upgrade, as Caddy does. The certificate is self-signed, made
// once with openssl and kept in .cache/; Chrome is told to trust exactly that
// key (--ignore-certificate-errors-spki-list), so service workers register
// as they do on the real site.
"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const http2 = require("http2");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const CACHE = path.join(__dirname, ".cache");

const cert = () => {
  const key = path.join(CACHE, "front-key.pem");
  const crt = path.join(CACHE, "front-cert.pem");
  if (!fs.existsSync(key) || !fs.existsSync(crt)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const r = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
      "-keyout", key, "-out", crt, "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ], { encoding: "utf-8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr || r.error}`);
  }
  const pem = fs.readFileSync(crt);
  const spki = crypto.createHash("sha256")
    .update(new crypto.X509Certificate(pem).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  return { key: fs.readFileSync(key), cert: pem, spki };
};

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "http2-settings", "te"]);

const startFront = async (target) => {
  const t = new URL(target);
  const { key, cert: crt, spki } = cert();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const server = http2.createSecureServer({ key, cert: crt, allowHTTP1: true });

  server.on("request", (req, res) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.startsWith(":") || HOP.has(k)) continue;
      headers[k] = v;
    }
    headers.host = t.host;
    headers["x-forwarded-proto"] = "https";
    const up = http.request({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers, agent }, (ur) => {
      const out = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(ur.statusCode, out);
      ur.pipe(res);
    });
    up.on("error", () => { try { res.writeHead(502); } catch {} res.end(); });
    req.on("aborted", () => up.destroy());
    res.on("close", () => { if (!res.writableEnded) up.destroy(); });
    req.pipe(up);
  });

  // WebSocket: an HTTP/1.1 upgrade, spliced through as raw bytes.
  server.on("upgrade", (req, socket, head) => {
    const up = net.connect(Number(t.port), t.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        lines.push(`${k}: ${k.toLowerCase() === "host" ? t.host : req.rawHeaders[i + 1]}`);
      }
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const end = () => { try { up.destroy(); } catch {} try { socket.destroy(); } catch {} };
    up.on("error", end);
    socket.on("error", end);
    socket.on("close", end);
    up.on("close", end);
  });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  const sessions = new Set();
  server.on("session", (s) => { sessions.add(s); s.on("close", () => sessions.delete(s)); });
  return {
    url: `https://127.0.0.1:${port}`,
    spki,
    stop: async () => {
      for (const s of sessions) { try { s.destroy(); } catch {} }
      agent.destroy();
      await new Promise((r) => server.close(() => r()));
    },
  };
};

module.exports = { startFront };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) { console.error("usage: node front.js http://127.0.0.1:<port>"); process.exit(1); }
  startFront(target).then((f) => console.log(`${f.url}  ->  ${target}\n(spki ${f.spki})`));
}

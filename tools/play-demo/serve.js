#!/usr/bin/env node
// The Aurora Play kit's demo page (not shipped): every piece of
// public/js/play/*.js and public/css/play.css on one page, for whoever builds
// a play screen next.
//
//   node tools/play-demo/serve.js [port]   -> http://127.0.0.1:<port>/
//
// A tiny static server: "/" is tools/play-demo/index.html, everything else
// is public/ as the app serves it (no server, no data, nothing written).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PUB = path.join(__dirname, "..", "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const port = Number(process.argv[2]) || 4710;

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = url === "/" ? path.join(__dirname, "index.html") : path.join(PUB, ...url.split("/").filter(Boolean));
  if (!file.startsWith(PUB) && file !== path.join(__dirname, "index.html")) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  });
}).listen(port, "127.0.0.1", () => console.log(`Aurora Play demo: http://127.0.0.1:${port}/`));

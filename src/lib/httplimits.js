// How long the HTTP server waits for a client, and how much it accepts.
//
//   keepAliveTimeout 75 s   An idle keep-alive connection lives this long —
//                           longer than any client pool and than nginx's
//                           upstream keepalive (60 s), so it is the CLIENT
//                           that closes first. (5 s, Node's default, cut a
//                           TV on laggy Wi-Fi mid-reuse: 2026-10-08.)
//   headersTimeout   20 s   A request's headers must have arrived 20 s after
//                           its first byte. It was 80 s: a "slowloris" client
//                           dripping a header a byte at a time held a socket
//                           for 80 s each. Proved on Node 20.18 and 22.13: an
//                           idle keep-alive connection is NOT cut by it (the
//                           clock starts at a request's first byte), so the
//                           laggy-TV fix above stands.
//   requestTimeout  120 s   The whole request, body included (an avatar of
//                           2 MB over a poor phone line is far inside it).
//                           It never limits an ANSWER: a film streams for
//                           hours on one request.
//   connectionsCheckingInterval 2 s
//                           How often Node looks for connections over those
//                           two limits. Node's default is 30 s, which made a
//                           20 s limit a 20–50 s one.
//   silent connections      One that never sends a byte is closed at the
//                           header limit too (Node does it; proved in tests).
//   maxConnections          Set at listen from the file-handle limit on Linux
//                           (lib/resources.js): past it a new connection is
//                           refused at once, instead of the process running
//                           out of handles and failing to open its own files.
//
// Overridable in config.json: "http": { "headersTimeoutSec": 20,
// "requestTimeoutSec": 120, "keepAliveTimeoutSec": 75 } (checked at boot).
"use strict";
const http = require("http");

const DEFAULTS = { keepAliveTimeoutSec: 75, headersTimeoutSec: 20, requestTimeoutSec: 120, checkEveryMs: 2000 };

const settings = (cfg) => {
  const o = (cfg && typeof cfg === "object") ? cfg : {};
  const n = (v, d, min, max) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : d);
  const keepAlive = n(o.keepAliveTimeoutSec, DEFAULTS.keepAliveTimeoutSec, 1, 3600);
  const headers = n(o.headersTimeoutSec, DEFAULTS.headersTimeoutSec, 1, 600);
  const request = n(o.requestTimeoutSec, DEFAULTS.requestTimeoutSec, 1, 3600);
  return {
    keepAliveTimeout: keepAlive * 1000,
    // Node refuses a requestTimeout below headersTimeout
    headersTimeout: Math.min(headers, request) * 1000,
    requestTimeout: Math.max(headers, request) * 1000,
    checkEveryMs: DEFAULTS.checkEveryMs,
  };
};

// A connection that never sends a single byte is closed by Node itself at
// the header limit (proved on Node 20.18 and 22.13, Windows and Linux: a
// silent socket gets its 408 at headersTimeout + up to one check interval).
const idle = { timedOut: 0 };

// A request the parser gave up on (over a time limit, malformed, headers too
// big): answered with its status and the socket ENDED, not destroyed — Node's
// own default writes the answer and destroys at once, and on Windows the
// answer was often lost to the reset (the client saw a bare close). The
// socket is destroyed a second later whatever the client does.
const STATUS = { ERR_HTTP_REQUEST_TIMEOUT: [408, "Request Timeout"], HPE_HEADER_OVERFLOW: [431, "Request Header Fields Too Large"] };
const onClientError = (err, socket) => {
  if (!err || err.code === "ECONNRESET" || !socket.writable) { try { socket.destroy(); } catch {} return; }
  if (err.code === "ERR_HTTP_REQUEST_TIMEOUT") idle.timedOut++;
  const [code, text] = STATUS[err.code] || [400, "Bad Request"];
  try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  const t = setTimeout(() => { try { socket.destroy(); } catch {} }, 1000);
  t.unref?.();
};

const createServer = (app, cfg) => {
  const s = settings(cfg);
  const server = http.createServer({ connectionsCheckingInterval: s.checkEveryMs }, app);
  server.keepAliveTimeout = s.keepAliveTimeout;
  server.headersTimeout = s.headersTimeout;
  server.requestTimeout = s.requestTimeout;
  server.on("clientError", onClientError);
  return server;
};

module.exports = { createServer, settings, DEFAULTS, idle };

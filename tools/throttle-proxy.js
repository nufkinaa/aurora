#!/usr/bin/env node
// A slow-connection stand-in for testing the apps (TV, phone) against this
// server: a TCP proxy in front of Aurora that limits bandwidth and adds
// latency, both directions, for HTTP and WebSocket alike.
//
//   node tools/throttle-proxy.js --listen 4010 --to 4000 --down 3000 --up 1000 --latency 120 --loss 0
//
//   --down / --up   kilobits per second the client may receive / send (0 = unlimited)
//   --latency       milliseconds added to every chunk, each way
//   --loss          percent of connections dropped at random after a moment (0–100)
//
// Point a QA build of the TV app (or a phone) at http://<this PC>:4010 and the
// whole app — pages, pictures, video segments, the live socket — goes through
// the limit. Bandwidth is shared across all connections, like a real line.
"use strict";
const net = require("net");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : def;
};
const LISTEN = arg("listen", 4010);
const TO = arg("to", 4000);
const DOWN = arg("down", 3000) * 125; // kbit/s -> bytes/s
const UP = arg("up", 1000) * 125;
const LATENCY = arg("latency", 120);
const LOSS = arg("loss", 0);

// One token bucket per direction, shared by every connection. BACKPRESSURE:
// a real slow line pushes back on the sender, so this one must too — the
// first version let the server pour a whole 2 GB film into the queue at local
// speed (12 GB of memory, every other connection waiting behind it). Now a
// reader is paused while its bytes wait in the queue past a small window and
// resumed when they have gone, and bytes for a socket that closed meanwhile
// are dropped without being charged to the line.
const WINDOW = 64 * 1024; // bytes one connection may have waiting, per direction
const bucket = (rate) => ({ rate, tokens: Math.min(rate, 256 * 1024), at: Date.now(), queue: [], timer: null });
const down = bucket(DOWN);
const up = bucket(UP);
const pump = (b) => {
  if (b.timer) return;
  const step = () => {
    b.timer = null;
    const now = Date.now();
    b.tokens = Math.min(Math.max(b.rate, 1) * 0.25, b.tokens + ((now - b.at) / 1000) * b.rate);
    b.at = now;
    while (b.queue.length) {
      const [sock, chunk, from, pending] = b.queue[0];
      if (sock.destroyed) {
        b.queue.shift(); // not charged: the line never carried it
        pending.n -= chunk.length;
        continue;
      }
      // A chunk may be bigger than the bucket ever holds (64 KB chunks at
      // 28 KB of tokens): it goes when the bucket is in credit and leaves it
      // in debt, which keeps the average rate right and never stalls.
      if (b.rate && b.tokens <= 0) break;
      b.tokens -= chunk.length;
      b.queue.shift();
      pending.n -= chunk.length;
      sock.write(chunk);
      if (pending.n < WINDOW && from.isPaused()) from.resume();
    }
    if (b.queue.length) b.timer = setTimeout(step, 20);
  };
  step();
};
const send = (b, sock, chunk, from, pending) => {
  pending.n += chunk.length;
  if (pending.n >= WINDOW) from.pause();
  const go = () => {
    b.queue.push([sock, chunk, from, pending]);
    pump(b);
  };
  LATENCY ? setTimeout(go, LATENCY) : go();
};

let conns = 0;
net
  .createServer((client) => {
    conns++;
    const upstream = net.connect(TO, "127.0.0.1");
    const pendUp = { n: 0 };
    const pendDown = { n: 0 };
    const id = conns;
    const t0 = Date.now();
    client.on("data", (c) => {
      // one line per request, so a test can see what the client asked for and when
      const m = /^(GET|POST|PUT|DELETE|HEAD) (\S+)/.exec(c.subarray(0, 200).toString("latin1"));
      if (m) console.log(`${new Date().toISOString().slice(11, 19)} #${id} ${m[1]} ${m[2].slice(0, 90)}`);
      send(up, upstream, c, client, pendUp);
    });
    upstream.on("data", (c) => send(down, client, c, upstream, pendDown));
    // A side that closes does not take the other down until everything it
    // sent has been delivered — a real network delivers the bytes already in
    // flight when a server closes an idle connection. (The first version
    // destroyed the client at once and every slow picture ended with
    // "unexpected end of stream".)
    const drain = (b, sock, pending, then) => {
      const t = setInterval(() => {
        if (pending.n <= 0 || sock.destroyed) {
          clearInterval(t);
          then();
        }
      }, 25);
    };
    let closing = false;
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", closeBoth);
    upstream.on("error", closeBoth);
    client.on("close", () => {
      if (closing) return;
      closing = true;
      drain(up, upstream, pendUp, () => upstream.end());
    });
    upstream.on("close", () => {
      console.log(`${new Date().toISOString().slice(11, 19)} #${id} server closed after ${((Date.now() - t0) / 1000).toFixed(1)}s, ${pendDown.n}B still queued`);
      if (closing) return;
      closing = true;
      drain(down, client, pendDown, () => client.end());
    });
    if (LOSS > 0 && Math.random() * 100 < LOSS) setTimeout(closeBoth, 500 + Math.random() * 3000);
  })
  .listen(LISTEN, "0.0.0.0", () => {
    console.log(`throttle: :${LISTEN} -> :${TO} | down ${DOWN / 125} kbit/s, up ${UP / 125} kbit/s, +${LATENCY} ms, loss ${LOSS}%`);
  });
setInterval(() => {}, 1 << 30);

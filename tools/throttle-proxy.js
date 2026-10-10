#!/usr/bin/env node
// A slow-connection stand-in for testing the apps (TV, phone, the website)
// against this server: a TCP proxy in front of Aurora that limits bandwidth
// and adds latency, both directions, for HTTP, TLS and WebSocket alike.
//
//   node tools/throttle-proxy.js --listen 4010 --to 4000 --down 3000 --up 1000 --latency 120
//
//   --down / --up     kilobits per second the client may receive / send (0 = unlimited)
//   --latency         milliseconds added to every chunk, EACH way (round trip = 2x)
//   --latency-down    …or one figure per direction (server → client)
//   --latency-up      (client → server)
//   --jitter          up to this many extra milliseconds per chunk, each way (order is kept)
//   --handshake 1     a new connection waits one round trip before its first byte
//                     moves, as a real TCP connect does (0 = connect is free)
//   --slowstart 1     TCP slow start: a connection begins at ten packets per round
//                     trip and doubles each round trip; after a second of silence
//                     it begins again (Linux's default). On a far server this, not
//                     the bandwidth, is what the first megabyte waits on.
//   --pktloss         percent of packets lost, as TCP feels it: each connection is
//                     held to the rate a lossy path allows (Mathis: 1.22·MSS / (RTT·√p))
//                     and a lost packet holds that connection up for one round trip
//   --loss            percent of CONNECTIONS dropped at random after a moment (0–100)
//   --to-host         where Aurora is (default 127.0.0.1)
//   --quiet 1         no line per request
//
// Point a QA build of the TV app (or a phone, or a browser) at
// http://<this PC>:4010 and the whole app — pages, pictures, video segments,
// the live socket — goes through the limit. Bandwidth is shared across all
// connections, like a real line.
//
// As a module (tools/ttff/ uses it in-process):
//   const { start } = require("./throttle-proxy");
//   const p = await start({ listen: 0, to: 4000, down: 3000, up: 1000, latency: 100 });
//   p.port, p.stats(), await p.close()
"use strict";
const net = require("net");

const MSS = 1460;
// How much the line passes at once after standing idle, in seconds of its rate.
const BURST_SEC = 0.1;

// Timers that keep time. setTimeout on Windows wakes on a ~15 ms tick, which
// turned "5 ms each way" into a 30–45 ms round trip; anything due sooner than
// that is waited for on the event loop itself (setImmediate), which only
// spins while bytes are actually in flight.
const due = []; // [{ at, fn }] sorted by at
let spinning = false;
let sleeper = null;
const clock = () => performance.now();
const runDue = () => {
  spinning = false;
  const now = clock();
  while (due.length && due[0].at <= now) due.shift().fn();
  arm();
};
const arm = () => {
  if (!due.length || spinning) return;
  const wait = due[0].at - clock();
  if (wait <= 20) {
    spinning = true;
    clearTimeout(sleeper);
    sleeper = null;
    setImmediate(runDue);
  } else {
    clearTimeout(sleeper);
    sleeper = setTimeout(() => { sleeper = null; runDue(); }, wait - 18);
  }
};
const later = (fn, ms) => {
  const at = clock() + Math.max(0, ms);
  let i = due.length;
  while (i > 0 && due[i - 1].at > at) i--;
  due.splice(i, 0, { at, fn });
  arm();
};
// A chunk is cut into pieces no larger than this before it meets the bucket,
// so a slow line passes a steady trickle rather than 64 KB bursts.
const PIECE = 8 * 1024;

const start = (opts = {}) =>
  new Promise((resolve, reject) => {
    const LISTEN = opts.listen == null ? 4010 : opts.listen;
    const TO = opts.to || 4000;
    const TO_HOST = opts.toHost || "127.0.0.1";
    const DOWN = (opts.down || 0) * 125; // kbit/s -> bytes/s
    const UP = (opts.up || 0) * 125;
    const LAT_DOWN = opts.latencyDown != null ? opts.latencyDown : opts.latency || 0;
    const LAT_UP = opts.latencyUp != null ? opts.latencyUp : opts.latency || 0;
    const JITTER = opts.jitter || 0;
    const LOSS = opts.loss || 0;
    const PKTLOSS = Math.max(0, Math.min(50, opts.pktloss || 0)) / 100;
    const HANDSHAKE = !!opts.handshake;
    const SLOWSTART = !!opts.slowstart && (LAT_DOWN + LAT_UP) > 0;
    const INIT_CWND = 10 * MSS;
    const IDLE_RESET_MS = Math.max(1000, (LAT_DOWN + LAT_UP) * 3);
    const RTT = LAT_DOWN + LAT_UP;
    // Bytes one connection may have waiting, per direction (see BACKPRESSURE):
    // what a real path holds in flight — its rate over a round trip — and
    // never less than a socket buffer's worth.
    const windowFor = (rate) => (rate ? Math.max(64 * 1024, Math.ceil(rate * ((RTT + 100) / 1000))) : 8 * 1024 * 1024);
    const log = opts.quiet ? () => {} : opts.log || ((line) => console.log(line));
    // What a lossy path lets ONE TCP connection carry (bytes/s); 0 = no bound.
    const LOSSY_RATE = PKTLOSS > 0 ? (1.22 * MSS) / ((Math.max(RTT, 2) / 1000) * Math.sqrt(PKTLOSS)) : 0;

    // One token bucket per direction, shared by every connection. BACKPRESSURE:
    // a real slow line pushes back on the sender, so this one must too — the
    // first version let the server pour a whole 2 GB film into the queue at
    // local speed (12 GB of memory, every other connection waiting behind it).
    // Now a reader is paused while its bytes wait past a small window and
    // resumed when they have gone, and bytes for a socket that closed
    // meanwhile are dropped without being charged to the line.
    const bucket = (rate) => ({ rate, tokens: rate * BURST_SEC, at: clock(), queue: [], timer: false, window: windowFor(rate) });
    const down = bucket(DOWN);
    const up = bucket(UP);
    const totals = { down: 0, up: 0, conns: 0, requests: 0 };
    const refill = (b, now) => {
      b.tokens = Math.min(Math.max(b.rate, 1) * BURST_SEC, b.tokens + ((now - b.at) / 1000) * b.rate);
      b.at = now;
    };
    const pump = (b) => {
      if (b.timer) return;
      const step = () => {
        b.timer = false;
        const now = clock();
        refill(b, now);
        // A connection that is over its own bound on a lossy path must not
        // hold the others up: it is skipped (all of it, so order within one
        // connection is kept) and the scan goes on.
        const held = new Set();
        for (let i = 0; i < b.queue.length; ) {
          const { sock, chunk, lane } = b.queue[i];
          if (sock.destroyed) {
            b.queue.splice(i, 1); // not charged: the line never carried it
            lane.pending -= chunk.length;
            continue;
          }
          // A chunk may be bigger than the bucket ever holds: it goes when
          // the bucket is in credit and leaves it in debt, which keeps the
          // average rate right and never stalls.
          if (b.rate && b.tokens <= 0) break;
          if (lane.own || lane.ss) {
            if (held.has(lane)) { i++; continue; }
            const ss = lane.ss;
            if (ss) {
              // silent for a while: the window starts over
              if (now - ss.sentAt > IDLE_RESET_MS) { ss.cwnd = INIT_CWND; ss.tokens = INIT_CWND; ss.at = now; }
              ss.tokens = Math.min(ss.cwnd, ss.tokens + ((now - ss.at) / Math.max(RTT, 1)) * ss.cwnd);
              ss.at = now;
            }
            if (lane.own) refill(lane.own, now);
            if ((lane.own && lane.own.tokens <= 0) || lane.heldUntil > now || (ss && ss.tokens <= 0)) { held.add(lane); i++; continue; }
            if (lane.own) lane.own.tokens -= chunk.length;
            if (ss) {
              ss.tokens -= chunk.length;
              ss.cwnd = Math.min(32 * 1024 * 1024, ss.cwnd + chunk.length); // every byte through is a byte more per round trip
              ss.sentAt = now;
            }
          }
          b.tokens -= chunk.length;
          b.queue.splice(i, 1);
          lane.pending -= chunk.length;
          lane.dir === "down" ? (totals.down += chunk.length) : (totals.up += chunk.length);
          sock.write(chunk);
          if (lane.pending < b.window && lane.from.isPaused()) lane.from.resume();
        }
        if (b.queue.length) { b.timer = true; later(step, 4); }
      };
      step();
    };

    // One direction of one connection: a delay line that keeps order (each
    // chunk leaves no earlier than the one before it), then the shared bucket.
    const lane = (dir, from, to) => {
      const b = dir === "down" ? down : up;
      const base = dir === "down" ? LAT_DOWN : LAT_UP;
      const l = {
        dir, from, pending: 0, last: 0, heldUntil: 0,
        own: LOSSY_RATE ? { rate: LOSSY_RATE, tokens: MSS * 10, at: clock() } : null,
        ss: SLOWSTART ? { cwnd: INIT_CWND, tokens: INIT_CWND, at: clock(), sentAt: clock() } : null,
        delayed: [], timer: false,
      };
      const release = () => {
        l.timer = false;
        const now = clock();
        while (l.delayed.length && l.delayed[0].at <= now) {
          const { chunk } = l.delayed.shift();
          for (let o = 0; o < chunk.length; o += PIECE) b.queue.push({ sock: to, chunk: chunk.subarray(o, Math.min(chunk.length, o + PIECE)), lane: l });
        }
        pump(b);
        if (l.delayed.length) { l.timer = true; later(release, l.delayed[0].at - clock()); }
      };
      l.send = (chunk, extraDelay = 0) => {
        l.pending += chunk.length;
        if (l.pending >= b.window) from.pause();
        const now = clock();
        // a lost packet: the connection waits a round trip for the resend
        if (PKTLOSS && Math.random() < 1 - Math.pow(1 - PKTLOSS, Math.ceil(chunk.length / MSS))) {
          l.heldUntil = Math.max(l.heldUntil, now) + Math.max(RTT, 20);
        }
        const at = Math.max(l.last, now + base + extraDelay + (JITTER ? Math.random() * JITTER : 0));
        l.last = at;
        if (at <= now && !l.delayed.length) {
          for (let o = 0; o < chunk.length; o += PIECE) b.queue.push({ sock: to, chunk: chunk.subarray(o, Math.min(chunk.length, o + PIECE)), lane: l });
          return pump(b);
        }
        l.delayed.push({ at, chunk });
        if (!l.timer) { l.timer = true; later(release, at - now); }
      };
      return l;
    };

    let conns = 0;
    const sockets = new Set();
    const server = net.createServer((client) => {
      conns++;
      totals.conns++;
      const upstream = net.connect(TO, TO_HOST);
      sockets.add(client);
      sockets.add(upstream);
      const laneUp = lane("up", client, upstream);
      const laneDown = lane("down", upstream, client);
      const id = conns;
      const t0 = Date.now();
      let first = true;
      client.on("data", (c) => {
        // one line per request, so a test can see what the client asked for and when
        const m = /^(GET|POST|PUT|DELETE|HEAD) (\S+)/.exec(c.subarray(0, 200).toString("latin1"));
        if (m) {
          totals.requests++;
          log(`${new Date().toISOString().slice(11, 19)} #${id} ${m[1]} ${m[2].slice(0, 90)}`);
        }
        // the TCP handshake: SYN out, SYN-ACK back, and only then the first byte
        laneUp.send(c, first && HANDSHAKE ? RTT : 0);
        first = false;
      });
      upstream.on("data", (c) => laneDown.send(c));
      // A side that closes does not take the other down until everything it
      // sent has been delivered — a real network delivers the bytes already in
      // flight when a server closes an idle connection. (The first version
      // destroyed the client at once and every slow picture ended with
      // "unexpected end of stream".)
      const drain = (sock, l, then) => {
        const t = setInterval(() => {
          if (l.pending <= 0 || sock.destroyed) {
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
        sockets.delete(client);
        if (closing) return;
        closing = true;
        drain(upstream, laneUp, () => upstream.end());
      });
      upstream.on("close", () => {
        sockets.delete(upstream);
        log(`${new Date().toISOString().slice(11, 19)} #${id} server closed after ${((Date.now() - t0) / 1000).toFixed(1)}s, ${laneDown.pending}B still queued`);
        if (closing) return;
        closing = true;
        drain(client, laneDown, () => client.end());
      });
      if (LOSS > 0 && Math.random() * 100 < LOSS) setTimeout(closeBoth, 500 + Math.random() * 3000);
    });
    server.on("error", reject);
    server.listen(LISTEN, opts.host || "0.0.0.0", () => {
      const port = server.address().port;
      const describe = `:${port} -> ${TO_HOST}:${TO} | down ${DOWN / 125 || "∞"} kbit/s, up ${UP / 125 || "∞"} kbit/s, +${LAT_DOWN}/${LAT_UP} ms (down/up)` +
        `${JITTER ? `, jitter ${JITTER} ms` : ""}${HANDSHAKE ? ", connect = 1 round trip" : ""}${SLOWSTART ? ", slow start" : ""}${PKTLOSS ? `, ${PKTLOSS * 100}% packet loss (≤ ${Math.round(LOSSY_RATE / 125)} kbit/s per connection)` : ""}${LOSS ? `, ${LOSS}% connections dropped` : ""}`;
      resolve({
        port,
        describe,
        stats: () => ({ ...totals }),
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            for (const b of [down, up]) b.queue.length = 0;
            server.close(() => done());
          }),
      });
    });
  });

module.exports = { start };

if (require.main === module) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
  };
  const num = (name, def) => {
    const v = arg(name, null);
    return v == null ? def : Number(v);
  };
  start({
    listen: num("listen", 4010),
    to: num("to", 4000),
    toHost: arg("to-host", "127.0.0.1"),
    down: num("down", 3000),
    up: num("up", 1000),
    latency: num("latency", 120),
    latencyDown: arg("latency-down", null) != null ? num("latency-down", 0) : undefined,
    latencyUp: arg("latency-up", null) != null ? num("latency-up", 0) : undefined,
    jitter: num("jitter", 0),
    handshake: num("handshake", 0) > 0,
    slowstart: num("slowstart", 0) > 0,
    pktloss: num("pktloss", 0),
    loss: num("loss", 0),
    quiet: num("quiet", 0) > 0,
  }).then((p) => console.log(`throttle: ${p.describe}`), (err) => {
    console.error(`throttle: ${err.message}`);
    process.exit(1);
  });
  setInterval(() => {}, 1 << 30);
}

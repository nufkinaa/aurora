#!/usr/bin/env node
// A plain TCP relay: every connection accepted on --listen is piped to --to,
// both ways, with backpressure (pipe). The shaped-line rig (wsl-net.sh) chains
// three of them so that ONE hop of the path — the one inside WSL that crosses
// the netem link — is a real Linux TCP connection whose congestion control
// (cubic or bbr) is the server namespace's. The other hops are local and fast.
//
//   node relay.js --listen 0.0.0.0:47100 --to 10.77.0.2:47101 [--name A]
//
// Prints one line when it listens. Exits when its parent closes stdin
// (so a WSL session that is torn down takes it with it) or on SIGTERM.
"use strict";
const net = require("net");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const split = (s) => { const i = s.lastIndexOf(":"); return { host: s.slice(0, i), port: Number(s.slice(i + 1)) }; };
const L = split(arg("listen", "127.0.0.1:0"));
const T = split(arg("to", "127.0.0.1:4000"));
const NAME = arg("name", "relay");
let conns = 0;
const server = net.createServer((c) => {
  conns++;
  c.setNoDelay(true);
  const u = net.connect(T.port, T.host);
  u.setNoDelay(true);
  const kill = () => { c.destroy(); u.destroy(); };
  c.on("error", kill);
  u.on("error", kill);
  c.pipe(u);
  u.pipe(c);
});
server.listen(L.port, L.host, () => console.log(`${NAME} ${L.host}:${server.address().port} -> ${T.host}:${T.port}`));
server.on("error", (e) => { console.error(`${NAME}: ${e.message}`); process.exit(1); });
process.on("SIGTERM", () => process.exit(0));
if (process.argv.includes("--stdin-exit")) { process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); }
setInterval(() => {}, 1 << 30);

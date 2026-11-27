#!/usr/bin/env node
// The WSL side of the shaped line (run.js starts it; README.md). Runs INSIDE
// WSL as root:
//
//   wsl.exe -d Ubuntu -u root -e /home/elia/node22/bin/node netctl.js --aurora <port> --listen <port>
//
// Builds the path   Windows browser → localhost:<listen> (WSL's localhost forwarding)
//                   → relay A (root ns, 0.0.0.0:<listen>)
//                   → [vr0/vs0: the SHAPED veth — netem delay, rate, loss]
//                   → relay B (namespace "auranet": ITS TCP stack sends the film,
//                     so its congestion control is the one measured)
//                   → [vs1/vr1: a plain veth]
//                   → relay C (root ns) → the Windows host → the private Aurora on <aurora>
//
// and takes commands on stdin, one per line, answering "ok <what>" or "err <why>":
//   shape DOWN UP RTT LOSS     (kbit/s, kbit/s, ms, %)
//   cc cubic|bbr
//   ssai 0|1
//   quit
// stdin closing is a quit: everything it built is taken down again.
"use strict";
const net = require("net");
const path = require("path");
const readline = require("readline");
const { execFileSync, spawn } = require("child_process");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const AURORA = Number(arg("aurora", 0));
const LISTEN = Number(arg("listen", 47210));
const PB = LISTEN + 1;
const PC = LISTEN + 2;
const NET = path.join(__dirname, "wsl-net.sh");
// one line per listening port (wsl-net.sh SLOT): a run being torn down never touches the next one's
const SLOT = String(Math.floor(LISTEN / 2) % 50);
const NS = `auranet${SLOT}`;
const SUB_A = `10.77.${SLOT * 2}`;
const SUB_B = `10.77.${SLOT * 2 + 1}`;
const sh = (...a) => execFileSync("sh", [NET, ...a.map(String)], { encoding: "utf8", env: { ...process.env, SLOT } }).trim();
const winHost = execFileSync("sh", ["-c", "ip route | awk '/default/ {print $3; exit}'"], { encoding: "utf8" }).trim();

const relay = (lhost, lport, thost, tport) =>
  new Promise((resolve, reject) => {
    const s = net.createServer((c) => {
      c.setNoDelay(true);
      const u = net.connect(tport, thost);
      u.setNoDelay(true);
      const kill = (e) => { if (e && process.env.NETCTL_DEBUG) console.error(`relay ${lport}: ${e.message}`); c.destroy(); u.destroy(); };
      c.on("error", kill);
      u.on("error", kill);
      c.pipe(u);
      u.pipe(c);
    });
    s.on("error", reject);
    s.listen(lport, lhost, () => resolve(s));
  });

let b = null;
let cleaned = false;
let upDone = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { if (b) b.kill("SIGTERM"); } catch {}
  if (!upDone) return;
  try { sh("cc", "cubic"); } catch {}
  try { sh("down"); } catch {}
};
process.on("exit", cleanup);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

const main = async () => {
  if (!AURORA) throw new Error("--aurora <port> is required");
  // The viewer's port FIRST: if it is taken, nothing of anyone's line is touched
  // ("up" removes and re-creates this slot's namespace — two rigs on one port
  // used to take each other's line down mid-play).
  await relay("0.0.0.0", LISTEN, `${SUB_A}.2`, PB);
  sh("up");
  upDone = true;
  sh("shape", 100000, 100000, 2, 0);
  await relay(`${SUB_B}.1`, PC, winHost, AURORA);
  b = spawn("ip", ["netns", "exec", NS, process.execPath, path.join(__dirname, "relay.js"), "--listen", `${SUB_A}.2:${PB}`, "--to", `${SUB_B}.1:${PC}`, "--name", "B"], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r, j) => { b.stdout.once("data", r); b.once("exit", (c) => j(new Error(`relay B exited ${c}`))); });
  console.log(`ready ${LISTEN} -> ${winHost}:${AURORA}`);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    try {
      if (cmd === "quit") return process.exit(0);
      if (cmd === "shape" || cmd === "cc" || cmd === "ssai") console.log(`ok ${sh(cmd, ...rest)}`);
      else if (cmd === "show") console.log(`ok ${sh("show").replace(/\n/g, " | ")}`);
      else console.log(`err unknown ${cmd}`);
    } catch (e) {
      console.log(`err ${String(e.message).split("\n")[0]}`);
    }
  });
  rl.on("close", () => process.exit(0));
};
main().catch((e) => { console.log(`err ${e.message}`); process.exit(1); });

#!/usr/bin/env node
// A private server for the Mi TV start-buffer check (REPORT.md "Built", item 7):
// this working tree on a throwaway data folder, the E: test library, a
// throwaway profile "Claude QA" (no password), and tools/throttle-proxy.js in
// front of it on 0.0.0.0:<listen> — the address a QA build of the TV app has
// as its only server. Commands on stdin, one per line:
//   line <down kbit/s> <latency ms each way>     a new shaped line (the proxy restarts)
//   tuning <json>                                config "tvPlayer" (tv-tuning-preload.js)
//   progress <title key> <seconds>               the profile's resume point for a title
//   marks                                        the [play] lines since the last call
//   quit
// It never talks to nufurora.com or the live server; the TV only ever sees <listen>.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const throttle = require("../throttle-proxy");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const LISTEN = Number(arg("listen", 47400));
const MEDIA = arg("media", "E:/aurora-agents/research-stream-efficiency/media");
const TITLES = { mp4: "Rig Mp4", hevc: "Rig Hevc", jit: "Rig Jit", uhd: "Rig Uhd" };
const tuningFile = path.join(os.tmpdir(), `rig-tv-tuning-${process.pid}.json`);
fs.writeFileSync(tuningFile, "null");

const main = async () => {
  const server = require("../../scripts/ui-test-server");
  const srv = await server.start({
    config: { libraries: { movies: [path.join(MEDIA, "movies")], shows: [path.join(MEDIA, "shows")] }, hwEncode: "off" },
    preload: [path.join(__dirname, "tv-tuning-preload.js"), path.join(__dirname, "count-encodes.js")],
    env: { AURORA_RIG_TV_TUNING: tuningFile },
  });
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status}`);
    return json;
  };
  const admin = { "X-Admin-Password": srv.adminPassword };
  const { request } = await call("POST", "/api/profiles", { name: "Claude QA", password: "qa-rig-1", realName: "Claude QA", avatar: "🦊", color: "#2c9fe0" });
  const p = await call("POST", `/api/admin/profile-requests/${request.id}/approve`, {}, admin);
  const token = (await call("POST", `/api/profiles/${p.id}/unlock`, { password: "qa-rig-1" })).token;
  const h = token ? { "X-Profile-Token": token } : {};
  await call("POST", `/api/profiles/${p.id}/password`, { newPassword: "", currentPassword: "qa-rig-1" }, h);
  const lib = await call("GET", "/api/library");
  const ids = {};
  for (const [k, t] of Object.entries(TITLES)) { const m = lib.movies.find((x) => x.title === t); if (m) ids[k] = { id: m.id, title: m.title, duration: m.duration, transcodeBase: m.transcodeBase, videoUrl: m.videoUrl, type: "movie" }; }
  let proxy = null;
  const line = async (down, lat) => {
    if (proxy) await proxy.close();
    // (down 0: a plain pass-through — no rate, no delay, no slow start — to tell the
    // proxy's own effects from the TV's)
    proxy = down > 0
      ? await throttle.start({ listen: LISTEN, host: "0.0.0.0", to: srv.port, quiet: true, handshake: true, slowstart: true, down, up: Math.max(1000, Math.round(down / 3)), latency: lat })
      : await throttle.start({ listen: LISTEN, host: "0.0.0.0", to: srv.port, quiet: true, handshake: false, slowstart: false, down: 0, up: 0, latency: 0 });
    return proxy.describe;
  };
  console.log(`ready port=${srv.port} pid=${srv.pid} profile=${p.id} line=${await line(100000, 2)}`);
  console.log(`items ${JSON.stringify(ids)}`);
  let seen = 0;
  // commands from stdin, or (--cmd <file>) from lines appended to a file — for a
  // server left running in the background between shell calls
  const CMD = arg("cmd", "");
  const rl = CMD ? new (require("events"))() : readline.createInterface({ input: process.stdin });
  if (CMD) {
    fs.writeFileSync(CMD, "");
    let off = 0;
    setInterval(() => {
      let txt = "";
      try { txt = fs.readFileSync(CMD, "utf8"); } catch { return; }
      if (txt.length <= off) return;
      const chunk = txt.slice(off);
      const NL = String.fromCharCode(10);
      const nl = chunk.lastIndexOf(NL);
      if (nl < 0) return;
      off += nl + 1;
      for (const l of chunk.slice(0, nl).split(NL)) if (l.trim()) rl.emit("line", l);
    }, 400);
  }
  rl.on("line", async (raw) => {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    try {
      if (cmd === "quit") { if (proxy) await proxy.close(); await srv.stop(); try { fs.unlinkSync(tuningFile); } catch {} process.exit(0); }
      if (cmd === "line") console.log(`ok ${await line(Number(rest[0]), Number(rest[1] || 0))}`);
      else if (cmd === "tuning") { fs.writeFileSync(tuningFile, rest.join(" ")); console.log("ok tuning"); }
      else if (cmd === "progress") { const it = ids[rest[0]]; await call("POST", `/api/profiles/${p.id}/progress`, { itemId: it.id, position: Number(rest[1]), duration: it.duration }); console.log("ok progress"); }
      else if (cmd === "marks") {
        const log = srv.log();
        const out = log.slice(seen).filter((l) => /\[play\]|\[rig-tv\]|\[rig-encode\]/.test(l));
        seen = log.length;
        console.log(`marks ${JSON.stringify(out)}`);
      } else console.log(`err ${cmd}`);
    } catch (e) { console.log(`err ${e.message}`); }
  });
  rl.on("close", async () => { if (proxy) await proxy.close(); await srv.stop(); process.exit(0); });
};
main().catch((e) => { console.error(e); process.exit(1); });

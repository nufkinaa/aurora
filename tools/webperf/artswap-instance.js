#!/usr/bin/env node
// The mobile-perf instance (tools/mobile-perf/instance.js) with pictures that
// have a small and a large version of the same drawing (artswap-art.py), for
// looking at a hero's picture being replaced by its sharper one (artswap.js).
//
//   node tools/webperf/artswap-instance.js --state <file>
//
// Prints the address, writes the state file ({ url, profiles, routes, pid }).
// Stop it by its pid.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { argv } = require("./lib");

const REPO = path.join(__dirname, "..", "..");
const ART = path.join(__dirname, ".cache", "artswap-art-v1");
if (!fs.existsSync(path.join(ART, ".ready"))) {
  fs.mkdirSync(ART, { recursive: true });
  const r = spawnSync(process.platform === "win32" ? "python" : "python3", [path.join(__dirname, "artswap-art.py"), ART], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("artswap-art.py failed (needs Python 3 with Pillow)");
}

// (the instance is mobile-perf's own, with one more preload and this art)
const server = require(path.join(REPO, "scripts", "ui-test-server.js"));
const start = server.start;
server.start = (o) => start({ ...o, preload: [...(o.preload || []), path.join(__dirname, "artswap-fixture.js")], env: { ...(o.env || {}), MP_ART_DIR: ART } });
const { startInstance } = require(path.join(REPO, "tools", "mobile-perf", "instance.js"));

startInstance({ repo: argv("repo") ? path.resolve(argv("repo")) : REPO })
  .then((inst) => {
    const { stop, log, ...plain } = inst;
    const state = { ...plain, pid: process.pid };
    if (argv("state")) fs.writeFileSync(path.resolve(argv("state")), JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ url: inst.url, pid: process.pid }));
  })
  .catch((err) => { console.error(err.stack || err.message); process.exit(1); });

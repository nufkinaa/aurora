// lib/children.js: however the server's process ends, the helpers it started
// (and tracked) end with it — on Windows nothing else ends them (server
// round, 2026-10-18).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

test("a tracked helper is killed when the process exits, even by process.exit()", async () => {
  const children = path.join(__dirname, "..", "src", "lib", "children.js").replace(/\\/g, "/");
  const script = `
    const { spawn } = require("child_process");
    const children = require(${JSON.stringify(children)});
    const c = children.track(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }), "test");
    console.log(c.pid);
    setTimeout(() => process.exit(0), 300);
  `;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20000 });
  const pid = Number(String(r.stdout).trim());
  assert.ok(pid > 0, `the helper started (${r.stdout} ${r.stderr})`);
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    gone = !alive(pid);
    if (!gone) await new Promise((res) => setTimeout(res, 100));
  }
  if (!gone) { try { process.kill(pid); } catch {} }
  assert.ok(gone, "the helper went with its parent");
});

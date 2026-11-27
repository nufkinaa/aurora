// lib/nettune.js + routes/nettune.js — the admin's "Network for streaming":
// what it reads from /proc (no root), the share of data sent twice, the one
// setup line, and that a press only ever hands the helper "apply" or "undo".
// The helper itself: test/nettune-helper.test.js.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const nettune = require("../src/lib/nettune");

const { deps, snmpTcp, setupCommand, versionOf, reset } = nettune._internals;
const real = { ...deps };
const SNMP = (out, retrans) => [
  "Ip: Forwarding DefaultTTL",
  "Ip: 1 64",
  "Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors",
  `Tcp: 1 200 120000 -1 10 20 0 0 3 1000 ${out} ${retrans} 0 0 0`,
  "",
].join("\n");

const linux = ({ cc = "cubic", qdisc = "fq_codel", ssai = "1", helper = null, counters = [1000, 1] } = {}) => {
  let t = 1_000_000;
  const calls = [];
  Object.assign(deps, {
    platform: () => "linux",
    now: () => t,
    readProc: (rel) => {
      const sys = {
        "sys/net/ipv4/tcp_congestion_control": cc, "sys/net/core/default_qdisc": qdisc,
        "sys/net/ipv4/tcp_slow_start_after_idle": ssai, "sys/net/ipv4/tcp_available_congestion_control": "reno cubic bbr",
      };
      if (rel === "net/snmp") return SNMP(counters[0], counters[1]);
      if (rel in sys) return sys[rel] + "\n";
      throw new Error("ENOENT " + rel);
    },
    helperText: () => helper,
    repoText: () => "#!/bin/bash\nVERSION=1\n",
    repoHelper: () => "/home/elia/aurora/scripts/nufurora/aurora-net-helper",
    user: () => "elia",
    helper: async (args) => {
      calls.push(args);
      if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ ok: true, queue: qdisc, iface: "eth0", file: cc === "bbr" }) + "\n", stderr: "" };
      cc = args[0] === "apply" ? "bbr" : "cubic";
      qdisc = args[0] === "apply" ? "fq" : "fq_codel";
      ssai = args[0] === "apply" ? "0" : "1";
      return { code: 0, stdout: JSON.stringify({ ok: true, cc, queue: qdisc, queueNow: true }) + "\n", stderr: "" };
    },
  });
  return { calls, tick: (ms) => { t += ms; }, set: (o, r) => { counters = [o, r]; } };
};

test.afterEach(() => { Object.assign(deps, real); reset(); });

test("the TCP counters of /proc/net/snmp", () => {
  assert.deepEqual(snmpTcp(SNMP(5000, 25)), { out: 5000, retrans: 25 });
  assert.equal(snmpTcp("nothing"), null);
  assert.equal(versionOf("x\nVERSION=3\n"), 3);
});

test("not on Linux: nothing to change, no helper asked", async () => {
  deps.platform = () => "win32";
  let asked = false;
  deps.helper = async () => { asked = true; return {}; };
  assert.deepEqual(await nettune.status(), { supported: false, platform: "win32" });
  assert.match((await nettune.run("apply")).error, /Linux/);
  assert.equal(asked, false);
});

test("before the one-time setup: what is in force, and the one line to paste", async () => {
  const L = linux();
  const s = await nettune.status();
  assert.equal(s.supported, true);
  assert.equal(s.cc, "cubic");
  assert.equal(s.slowStartAfterIdle, 1);
  assert.equal(s.on, false);
  assert.equal(s.helper.installed, false);
  assert.match(s.setup, /^sudo install -o root -g root -m 0755 \/home\/elia\/aurora\/scripts\/nufurora\/aurora-net-helper \/usr\/local\/sbin\/aurora-net-helper && /);
  assert.ok(s.setup.includes("'elia ALL=(root) NOPASSWD: /usr/local/sbin/aurora-net-helper'"));
  assert.ok(s.setup.includes("sudo visudo -cf"), "the sudoers line is checked before it is installed");
  assert.ok(s.setup.includes("/etc/sudoers.d/aurora-net"));
  const r = await nettune.run("apply");
  assert.match(r.error, /not installed/);
  assert.equal(r.setup, s.setup);
  assert.deepEqual(L.calls, []);
});

test("a user name that is not a plain word never reaches the sudoers line", () => {
  deps.user = () => "x' ALL=(ALL) NOPASSWD: ALL #";
  deps.repoHelper = () => "/srv/a b/aurora-net-helper";
  const c = setupCommand();
  assert.ok(c.includes("'elia ALL=(root) NOPASSWD: /usr/local/sbin/aurora-net-helper'"));
  assert.ok(c.includes("'/srv/a b/aurora-net-helper'"), "a path with a space is quoted");
});

test("apply and undo hand the helper one word each, and the status follows", async () => {
  const L = linux({ helper: "#!/bin/bash\nVERSION=1\n" });
  const before = await nettune.status();
  assert.equal(before.helper.ready, true);
  assert.equal(before.on, false);
  const a = await nettune.run("apply");
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.status.on, true);
  assert.equal(a.status.cc, "bbr");
  const u = await nettune.run("undo");
  assert.equal(u.ok, true);
  assert.equal(u.status.on, false);
  assert.deepEqual(L.calls.filter((c) => c[0] !== "status"), [["apply"], ["undo"]]);
  assert.match((await nettune.run("rm -rf")).error, /unknown/);
});

test("a helper without its sudo line is reported as setup, not as an error of the change", async () => {
  linux({ helper: "#!/bin/bash\nVERSION=1\n" });
  deps.helper = async () => ({ code: 1, stdout: "", stderr: "sudo: a password is required\n" });
  const s = await nettune.status();
  assert.equal(s.helper.installed, true);
  assert.equal(s.helper.ready, false);
  const r = await nettune.run("apply");
  assert.match(r.error, /sudo rule/);
  assert.ok(r.setup);
});

test("an older helper on the server is called out", async () => {
  linux({ helper: "#!/bin/bash\nVERSION=1\n" });
  deps.repoText = () => "VERSION=2\n";
  assert.equal((await nettune.status()).helper.outdated, true);
});

test("data sent twice: over the kept minutes, and since the server started", async () => {
  const L = linux({ counters: [100000, 500] });
  let s = await nettune.status();
  assert.equal(s.loss.recent, null, "one sample: still measuring");
  assert.equal(s.loss.sinceBoot.pct, 0.5);
  L.tick(5 * 60 * 1000);
  L.set(200000, 1500); // 100 000 sent, 1 000 again
  s = await nettune.status();
  assert.deepEqual(s.loss.recent, { pct: 1, minutes: 5, sent: 100000 });
});

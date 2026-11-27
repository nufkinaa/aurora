// scripts/nufurora/aurora-net-helper — the root helper behind the admin's
// "Network for streaming" (docs/network-for-streaming.md). Run here in its
// test mode: a folder standing in for / (its proc/sys files are plain files)
// and stub ip / tc / modprobe that keep the card's queues in a file. Nothing
// real changes; what the helper writes, its way back and its refusals are held.
//
// Needs bash (Linux CI; Git Bash on Windows). Without one the file is skipped.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HELPER = path.join(__dirname, "..", "scripts", "nufurora", "aurora-net-helper");
const WIN = process.platform === "win32";
const findBash = () => {
  const c = WIN
    ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"), path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "bash.exe")]
    : ["/bin/bash", "/usr/bin/bash"];
  return c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
};
const BASH = findBash();
const ROOT_USER = typeof process.getuid === "function" && process.getuid() === 0;
const SKIP = !BASH ? "no bash on this machine — the helper is a bash script" : ROOT_USER ? "running as root: the helper refuses its test mode as root (by design)" : false;
const bashPath = (p) => (WIN ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, "/") : p);

const MQ = [
  "qdisc mq 0: root",
  "qdisc fq_codel 0: parent :2 limit 10240p flows 1024 quantum 1514 target 5ms interval 100ms memory_limit 32Mb ecn drop_batch 64",
  "qdisc fq_codel 0: parent :1 limit 10240p flows 1024 quantum 1514 target 5ms interval 100ms memory_limit 32Mb ecn drop_batch 64",
  "",
].join("\n");
const SINGLE = "qdisc fq_codel 0: root refcnt 2 limit 10240p flows 1024 quantum 1514 target 5ms interval 100ms\n";

const STUBS = {
  ip: `#!/bin/bash
echo "default via 10.0.0.1 dev eth0 proto static"
`,
  modprobe: `#!/bin/bash
echo "modprobe $*" >> "$SIM/calls"
[ -n "\${STUB_NO_BBR:-}" ] && exit 1
f="$AURORA_NET_HELPER_ROOT/proc/sys/net/ipv4/tcp_available_congestion_control"
grep -qw bbr "$f" || printf '%s bbr\\n' "$(cat "$f")" > "$f"
exit 0
`,
  caddy: `#!/bin/bash
echo "caddy $*" >> "$SIM/calls"
if [ -n "\${STUB_CADDY_INVALID:-}" ]; then echo "Error: adapting config using caddyfile: unrecognized servers option 'protocolz'" >&2; exit 1; fi
exit 0
`,
  systemctl: `#!/bin/bash
echo "systemctl $*" >> "$SIM/calls"
[ -n "\${STUB_RELOAD_FAIL:-}" ] && exit 1
exit 0
`,
  tc: `#!/bin/bash
echo "tc $*" >> "$SIM/calls"
f="$SIM/qdisc"
if [ "$1 $2" = "qdisc show" ]; then cat "$f"; exit 0; fi
if [ "$1 $2" = "qdisc replace" ]; then
  [ -n "\${STUB_TC_FAIL:-}" ] && exit 2
  if [ "$5" = "root" ]; then awk -v k="$6" '$4=="root"{$2=k} {print}' "$f" > "$f.t"
  else awk -v p="$6" -v k="$7" '$4=="parent" && $5==p {$2=k} {print}' "$f" > "$f.t"; fi
  mv "$f.t" "$f"; exit 0
fi
exit 1
`,
};

const PROC = {
  "net/ipv4/tcp_congestion_control": "cubic",
  "net/core/default_qdisc": "fq_codel",
  "net/ipv4/tcp_slow_start_after_idle": "1",
  "net/ipv4/tcp_available_congestion_control": "reno cubic",
  "net/core/rmem_max": "212992",
  "net/core/wmem_max": "212992",
};

const sandbox = ({ queues = MQ, proc = {}, caddyfile = null } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-net-helper-"));
  const root = path.join(dir, "root");
  const bin = path.join(dir, "bin");
  const sim = path.join(dir, "sim");
  for (const d of [bin, sim]) fs.mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  for (const [rel, v] of Object.entries({ ...PROC, ...proc })) {
    const f = path.join(root, "proc", "sys", ...rel.split("/"));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, v + "\n");
  }
  fs.writeFileSync(path.join(sim, "qdisc"), queues);
  if (caddyfile != null) {
    fs.mkdirSync(path.join(root, "etc", "caddy"), { recursive: true });
    fs.writeFileSync(path.join(root, "etc", "caddy", "Caddyfile"), caddyfile);
  }
  const sb = {
    dir, root,
    run: (args, extra = {}) => {
      const env = {
        PATH: process.env.PATH,
        AURORA_NET_HELPER_TEST: "1",
        AURORA_NET_HELPER_ROOT: bashPath(root),
        AURORA_NET_HELPER_BIN: bashPath(bin),
        SIM: bashPath(sim),
        ...extra,
      };
      if (WIN) { env.SYSTEMROOT = process.env.SYSTEMROOT; env.TEMP = process.env.TEMP; env.TMP = process.env.TMP; }
      const r = spawnSync(BASH, [bashPath(HELPER), ...args], { env, encoding: "utf8", timeout: 60000, windowsHide: true });
      const line = String(r.stdout || "").trim().split(/\r?\n/).pop() || "";
      let json = null;
      try { json = JSON.parse(line); } catch {}
      assert.ok(json, `the helper printed no JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
      return { ...json, exit: r.status };
    },
    proc: (rel) => fs.readFileSync(path.join(root, "proc", "sys", ...rel.split("/")), "utf8").trim(),
    file: (rel) => { try { return fs.readFileSync(path.join(root, ...rel.split("/")), "utf8"); } catch { return null; } },
    queues: () => fs.readFileSync(path.join(sim, "qdisc"), "utf8"),
    calls: () => { try { return fs.readFileSync(path.join(sim, "calls"), "utf8").trim().split(/\r?\n/).filter(Boolean); } catch { return []; } },
    done: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
  return sb;
};
const CONF = "etc/sysctl.d/90-aurora-streaming.conf";
const MODS = "etc/modules-load.d/aurora-bbr.conf";
const STATE = "var/lib/aurora-net-helper/before";

test("status: what is in force, and nothing changes", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const s = sb.run(["status"]);
    assert.equal(s.ok, true);
    assert.equal(s.exit, 0);
    assert.equal(s.version, 1);
    assert.equal(s.cc, "cubic");
    assert.equal(s.defaultQdisc, "fq_codel");
    assert.equal(s.slowStartAfterIdle, "1");
    assert.equal(s.iface, "eth0");
    assert.equal(s.queue, "fq_codel", "a multi-queue card: its first child's queue");
    assert.equal(s.file, false);
    assert.equal(s.saved, false);
    assert.equal(sb.queues(), MQ);
    assert.equal(sb.file(CONF), null);
    assert.deepEqual(sb.calls().filter((c) => !/^tc qdisc show /.test(c)), [], "status only reads");
  } finally { sb.done(); }
});

test("apply: BBR, fq on every queue of the card, no slow start after a pause, kept for the next boot", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const s = sb.run(["apply"]);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.cc, "bbr");
    assert.equal(s.defaultQdisc, "fq");
    assert.equal(s.slowStartAfterIdle, "0");
    assert.equal(s.queue, "fq");
    assert.equal(s.queueNow, true);
    assert.equal(s.file, true);
    assert.equal(sb.proc("net/core/rmem_max"), "7500000", "HTTP/3's buffers raised");
    assert.equal(sb.proc("net/core/wmem_max"), "7500000");
    assert.doesNotMatch(sb.queues(), /fq_codel/, "both children of mq are fq now");
    assert.match(sb.queues(), /^qdisc mq 0: root/m, "the multi-queue root stays");
    const conf = sb.file(CONF);
    for (const l of ["net.core.default_qdisc = fq", "net.ipv4.tcp_congestion_control = bbr", "net.ipv4.tcp_slow_start_after_idle = 0", "net.core.rmem_max = 7500000"]) assert.ok(conf.includes(l), conf);
    assert.equal(sb.file(MODS).trim(), "tcp_bbr");
    assert.ok(sb.calls().includes("modprobe tcp_bbr"));
    assert.match(sb.file(STATE), /^cc=cubic$/m);
  } finally { sb.done(); }
});

test("undo after two applies: the values from before the FIRST one, files gone", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    sb.run(["apply"]);
    sb.run(["apply"]); // the second must not save "bbr" as the way back
    assert.match(sb.file(STATE), /^cc=cubic$/m);
    const u = sb.run(["undo"]);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.equal(u.cc, "cubic");
    assert.equal(u.defaultQdisc, "fq_codel");
    assert.equal(u.slowStartAfterIdle, "1");
    assert.equal(u.queue, "fq_codel");
    assert.equal(sb.proc("net/core/rmem_max"), "212992");
    assert.equal(sb.queues(), MQ);
    assert.equal(sb.file(CONF), null);
    assert.equal(sb.file(MODS), null);
    assert.equal(sb.file(STATE), null);
  } finally { sb.done(); }
});

test("a card with one queue: the root itself becomes fq and comes back", { skip: SKIP }, () => {
  const sb = sandbox({ queues: SINGLE });
  try {
    assert.equal(sb.run(["apply"]).queue, "fq");
    assert.match(sb.queues(), /^qdisc fq 0: root/);
    assert.equal(sb.run(["undo"]).queue, "fq_codel");
  } finally { sb.done(); }
});

test("big UDP buffers already there are never lowered", { skip: SKIP }, () => {
  const sb = sandbox({ proc: { "net/core/rmem_max": "16777216" } });
  try {
    sb.run(["apply"]);
    assert.equal(sb.proc("net/core/rmem_max"), "16777216");
    assert.equal(sb.proc("net/core/wmem_max"), "7500000");
  } finally { sb.done(); }
});

test("a kernel without BBR: refused, nothing written", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const s = sb.run(["apply"], { STUB_NO_BBR: "1" });
    assert.equal(s.ok, false);
    assert.equal(s.code, "nobbr");
    assert.equal(s.exit, 1);
    assert.equal(sb.proc("net/ipv4/tcp_congestion_control"), "cubic");
    assert.equal(sb.file(CONF), null);
    assert.equal(sb.file(STATE), null);
  } finally { sb.done(); }
});

test("the queue that cannot change now is said, the rest still applies", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const s = sb.run(["apply"], { STUB_TC_FAIL: "1" });
    assert.equal(s.ok, true);
    assert.equal(s.queueNow, false);
    assert.equal(s.cc, "bbr");
  } finally { sb.done(); }
});

test("a tampered 'before' file is read as words and numbers only", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    sb.run(["apply"]);
    fs.writeFileSync(path.join(sb.root, ...STATE.split("/")), "cc=cubic; touch /tmp/x\nqdisc=$(id)\nssai=7\nrmem=12abc\nqueue=fq_codel\n");
    const u = sb.run(["undo"]);
    assert.equal(u.ok, true);
    assert.equal(u.cc, "cubic", "the bad value falls back to the default");
    assert.equal(u.defaultQdisc, "fq_codel");
    assert.equal(u.slowStartAfterIdle, "1");
  } finally { sb.done(); }
});

test("refusals: other words, extra arguments, test mode under sudo", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    for (const args of [[], ["reboot"], ["apply", "x"], ["status", "--all"], ["undo", "now"]]) {
      const r = sb.run(args);
      assert.equal(r.ok, false, args.join(" "));
      assert.equal(r.code, "args");
    }
    const s = sb.run(["apply"], { SUDO_USER: "elia" });
    assert.equal(s.ok, false);
    assert.equal(s.code, "testmode");
    assert.equal(sb.proc("net/ipv4/tcp_congestion_control"), "cubic");
  } finally { sb.done(); }
});

// ---------- Caddy: HTTP/1.1 + HTTP/2 only, and back ----------
const WITH_GLOBAL = "# Caddy for the server\n{\n\temail someone@example.com\n}\n\nexample.com {\n\treverse_proxy 127.0.0.1:4000\n}\n";
const NO_GLOBAL = "example.com {\n\treverse_proxy 127.0.0.1:4000\n}\n";
const HAND = "{\n\tservers {\n\t\tprotocols h1 h2 h3\n\t}\n}\nexample.com {\n\treverse_proxy 127.0.0.1:4000\n}\n";
const CF = "etc/caddy/Caddyfile";

test("caddy-h2 into an existing global block, checked, reloaded; caddy-h3 gives the file back byte for byte", { skip: SKIP }, () => {
  const sb = sandbox({ caddyfile: WITH_GLOBAL });
  try {
    assert.equal(sb.run(["status"]).caddy, "default");
    const s = sb.run(["caddy-h2"]);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.caddy, "mine");
    const text = sb.file(CF);
    assert.match(text, /^\{\n\t# aurora-net-helper: HTTP\/1\.1 \+ HTTP\/2 only[^\n]*\n\tservers \{\n\t\tprotocols h1 h2\n\t\}\n\t# \/aurora-net-helper\n\temail someone@example\.com\n\}/m);
    assert.ok(text.startsWith("# Caddy for the server\n{\n"), "the comment above stays first");
    const calls = sb.calls();
    assert.ok(calls.some((c) => /^caddy validate --config \S*etc\/caddy\/Caddyfile\.aurora-new --adapter caddyfile$/.test(c)), calls.join("\n"));
    assert.ok(calls.includes("systemctl reload caddy"));
    assert.equal(sb.file(CF + ".aurora-new"), null, "no file left behind");
    assert.equal(sb.file(CF + ".aurora-old"), null);
    // pressed twice: nothing more
    const n = sb.calls().length;
    assert.equal(sb.run(["caddy-h2"]).caddy, "mine");
    assert.equal(sb.calls().filter((c) => !/^tc qdisc show/.test(c)).length, sb.calls().slice(0, n).filter((c) => !/^tc qdisc show/.test(c)).length);
    const back = sb.run(["caddy-h3"]);
    assert.equal(back.ok, true);
    assert.equal(back.caddy, "default");
    assert.equal(sb.file(CF), WITH_GLOBAL);
  } finally { sb.done(); }
});

test("caddy-h2 without a global block: one is put first, and taken out whole", { skip: SKIP }, () => {
  const sb = sandbox({ caddyfile: NO_GLOBAL });
  try {
    assert.equal(sb.run(["caddy-h2"]).ok, true);
    assert.ok(sb.file(CF).startsWith("# aurora-net-helper: HTTP/1.1 + HTTP/2 only"));
    assert.ok(sb.file(CF).includes("{\n\tservers {\n\t\tprotocols h1 h2\n\t}\n}\n# /aurora-net-helper\nexample.com {"));
    assert.equal(sb.run(["caddy-h3"]).ok, true);
    assert.equal(sb.file(CF), NO_GLOBAL);
  } finally { sb.done(); }
});

test("Caddy refuses the new file: nothing changes, nothing reloads", { skip: SKIP }, () => {
  const sb = sandbox({ caddyfile: WITH_GLOBAL });
  try {
    const s = sb.run(["caddy-h2"], { STUB_CADDY_INVALID: "1" });
    assert.equal(s.ok, false);
    assert.equal(s.code, "caddyinvalid");
    assert.match(s.error, /protocolz/, "Caddy's own words are passed on");
    assert.equal(sb.file(CF), WITH_GLOBAL);
    assert.ok(!sb.calls().some((c) => /systemctl/.test(c)));
    assert.equal(sb.file(CF + ".aurora-new"), null);
  } finally { sb.done(); }
});

test("the reload fails: the old Caddyfile is back", { skip: SKIP }, () => {
  const sb = sandbox({ caddyfile: WITH_GLOBAL });
  try {
    const s = sb.run(["caddy-h2"], { STUB_RELOAD_FAIL: "1" });
    assert.equal(s.ok, false);
    assert.equal(s.code, "caddyreload");
    assert.equal(sb.file(CF), WITH_GLOBAL);
    assert.equal(sb.file(CF + ".aurora-old"), null);
  } finally { sb.done(); }
});

test("a Caddyfile with its own protocols line is left alone; no Caddyfile is said", { skip: SKIP }, () => {
  const sb = sandbox({ caddyfile: HAND });
  try {
    const st = sb.run(["status"]);
    assert.equal(st.caddy, "hand");
    assert.equal(st.caddyLine, "protocols h1 h2 h3");
    const s = sb.run(["caddy-h2"]);
    assert.equal(s.code, "hand");
    assert.match(s.error, /protocols h1 h2 h3/);
    assert.equal(sb.file(CF), HAND);
    assert.equal(sb.run(["caddy-h3"]).ok, true, "nothing of ours to take out: fine");
    assert.equal(sb.file(CF), HAND);
  } finally { sb.done(); }
  const sb2 = sandbox();
  try {
    assert.equal(sb2.run(["status"]).caddy, "none");
    assert.equal(sb2.run(["caddy-h2"]).code, "nocaddy");
  } finally { sb2.done(); }
});

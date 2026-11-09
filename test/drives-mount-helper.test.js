// scripts/nufurora/aurora-mount-helper — the root helper behind the admin's
// "Tune this network drive" (docs/storage-drives.md). Run here in its test
// mode: a fake fstab, a fake state folder, and stub mount / umount / findmnt
// / systemctl that keep "what is mounted" in a file. Nothing real is mounted;
// the helper's line editing, its refusals and its way back are what is held.
//
// Needs bash (Linux CI; Git Bash on Windows). Without one the file is skipped
// and says why.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HELPER = path.join(__dirname, "..", "scripts", "nufurora", "aurora-mount-helper");
const WIN = process.platform === "win32";

const findBash = () => {
  const c = WIN
    ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"), path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "bash.exe")]
    : ["/bin/bash", "/usr/bin/bash"];
  return c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
};
const BASH = findBash();
const ROOT_USER = typeof process.getuid === "function" && process.getuid() === 0;
const SKIP = !BASH ? "no bash on this machine (Git Bash on Windows, /bin/bash on Linux) — the helper is a bash script"
  : ROOT_USER ? "running as root: the helper refuses its test mode as root (by design)" : false;
// a path as bash sees it (Git Bash: /c/Users/...)
const bashPath = (p) => (WIN ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, "/") : p);

const FSTAB_TEXT = [
  "# /etc/fstab: static file system information.",
  "UUID=1111-2222  /               ext4    errors=remount-ro 0       1",
  "/dev/vdb1  /data  ext4  defaults  0  2",
  "46.38.248.210:/voln1117606a1  /mnt/storagespace  nfs  rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536  0  0",
  "# 10.0.0.9:/old  /mnt/old  nfs  rw,hard  0  0",
  "10.0.0.7:/media\\040files\t/mnt/second\tnfs4\trw,hard,vers=4.1\t0 0",
  "",
].join("\n");
const ORIGINAL_NFS = "46.38.248.210:/voln1117606a1  /mnt/storagespace  nfs  rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536  0  0";
const TUNED_OPTS = "rw,vers=3,proto=tcp,nolock,rsize=1048576,wsize=1048576,nconnect=4,_netdev,nofail,x-systemd.mount-timeout=30s,soft,timeo=100,retrans=2";

// the stubs: "mounted" is a file per mount point (sim/<name>) holding the kernel's options
const STUBS = {
  findmnt: `#!/bin/bash
# findmnt -n -o OPTIONS|TARGET --mountpoint <mp>
col=""; mp=""
while [ $# -gt 0 ]; do case "$1" in -o) col="$2"; shift ;; --mountpoint) mp="$2"; shift ;; esac; shift; done
f="$SIM/$(printf '%s' "$mp" | tr '/' '_')"
[ -f "$f" ] || exit 1
if [ "$col" = "TARGET" ]; then echo "$mp"; else cat "$f"; fi
`,
  mount: `#!/bin/bash
echo "mount $*" >> "$SIM/calls"
mp="$1"
line=$(awk -v mp="$mp" '$0 !~ /^[ \\t]*#/ && $2 == mp' "$AURORA_MOUNT_HELPER_FSTAB")
[ -n "$line" ] || { echo "mount: $mp: can't find in /etc/fstab." >&2; exit 1; }
opts=$(printf '%s\\n' "$line" | awk '{ print $4 }')
if [ -n "\${STUB_MOUNT_FAIL_IF:-}" ] && [[ ",$opts," == *",\${STUB_MOUNT_FAIL_IF}"* ]]; then
  echo "mount.nfs: an incorrect mount option was specified" >&2; exit 32
fi
# what the kernel shows: no userspace options; the server may agree to a smaller rsize
live=""
IFS=,; for o in $opts; do
  case "$o" in _netdev|nofail|x-systemd.*|defaults) continue ;; esac
  if [ -n "\${STUB_CLAMP:-}" ]; then case "$o" in rsize=*) o="rsize=$STUB_CLAMP" ;; wsize=*) o="wsize=$STUB_CLAMP" ;; esac; fi
  live="\${live:+$live,}$o"
done
printf '%s\\n' "$live,addr=46.38.248.210" > "$SIM/$(printf '%s' "$mp" | tr '/' '_')"
`,
  umount: `#!/bin/bash
echo "umount $*" >> "$SIM/calls"
mp="\${!#}"
if [ "\${STUB_UMOUNT:-}" = "busy" ]; then echo "umount: $mp: target is busy." >&2; exit 32; fi
f="$SIM/$(printf '%s' "$mp" | tr '/' '_')"
[ -f "$f" ] || { echo "umount: $mp: not mounted." >&2; exit 32; }
rm -f "$f"
`,
  systemctl: `#!/bin/bash
echo "systemctl $*" >> "$SIM/calls"
`,
};

const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mount-helper-"));
  const bin = path.join(dir, "bin");
  const sim = path.join(dir, "sim");
  const state = path.join(dir, "state");
  for (const d of [bin, sim]) fs.mkdirSync(d);
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  const fstab = path.join(dir, "fstab");
  fs.writeFileSync(fstab, FSTAB_TEXT);
  // mounted as the line says today
  fs.writeFileSync(path.join(sim, "_mnt_storagespace"), "rw,relatime,vers=3,rsize=65536,wsize=65536,namlen=255,hard,nolock,proto=tcp,timeo=600,retrans=2,sec=sys,addr=46.38.248.210\n");
  const sb = {
    dir, bin, sim, state, fstab,
    env: (extra = {}) => {
      const env = {
        PATH: process.env.PATH,
        AURORA_MOUNT_HELPER_TEST: "1",
        AURORA_MOUNT_HELPER_FSTAB: bashPath(fstab),
        AURORA_MOUNT_HELPER_STATE: bashPath(state),
        AURORA_MOUNT_HELPER_BIN: bashPath(bin),
        AURORA_MOUNT_HELPER_STEP_TIMEOUT: "20",
        SIM: bashPath(sim),
        ...extra,
      };
      if (WIN) { env.SYSTEMROOT = process.env.SYSTEMROOT; env.TEMP = process.env.TEMP; env.TMP = process.env.TMP; }
      return env;
    },
    run: (args, extra = {}) => {
      // the arguments go through a file, NUL-separated: exactly as given, also
      // on Windows (whose one command line Git Bash would split again)
      const argsFile = path.join(dir, "args");
      fs.writeFileSync(argsFile, args.map((a) => a + "\0").join(""));
      const r = spawnSync(BASH, ["-c", 'A=(); while IFS= read -r -d "" a; do A+=("$a"); done < "$ARGS_FILE"; exec bash "$HELPER_FILE" "${A[@]}"'],
        { env: { ...sb.env(extra), ARGS_FILE: bashPath(argsFile), HELPER_FILE: bashPath(HELPER) }, encoding: "utf8", timeout: 60000, windowsHide: true });
      const line = String(r.stdout || "").trim().split(/\r?\n/).pop() || "";
      let json = null;
      try { json = JSON.parse(line); } catch {}
      assert.ok(json, `the helper printed no JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
      assert.equal(r.status, json.ok ? 0 : 1, `exit code ${r.status} for ${line}`);
      return json;
    },
    text: () => fs.readFileSync(fstab, "utf8"),
    live: (mp = "/mnt/storagespace") => { try { return fs.readFileSync(path.join(sim, mp.replace(/\//g, "_")), "utf8").trim(); } catch { return null; } },
    calls: () => { try { return fs.readFileSync(path.join(sim, "calls"), "utf8").trim().split(/\r?\n/).filter(Boolean); } catch { return []; } },
    done: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
  return sb;
};
const nfsLine = (text, mp = "/mnt/storagespace") => text.split("\n").find((l) => !/^\s*#/.test(l) && l.trim().split(/\s+/)[1] === mp);

test("status: the line's options, what is in force, and what 'tuned' would write", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const s = sb.run(["status", "/mnt/storagespace"]);
    assert.equal(s.ok, true);
    assert.equal(s.version, 1);
    assert.equal(s.fstype, "nfs");
    assert.equal(s.mounted, true);
    assert.equal(s.fstabOptions, "rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536");
    assert.match(s.liveOptions, /rsize=65536/);
    // hard, rsize and wsize go; vers, proto, nolock and rw stay, in their order; the preset follows
    assert.equal(s.tunedOptions, TUNED_OPTS);
    assert.equal(s.isTuned, false);
    assert.equal(s.canRevert, false);
    assert.equal(sb.text(), FSTAB_TEXT, "status changes nothing");
    assert.deepEqual(sb.calls(), [], "status mounts nothing");
  } finally { sb.done(); }
});

test("refuses other mounts, non-nfs lines, a commented line, other presets and anything odd in the mount point — the fstab untouched", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const cases = [
      [["apply", "/mnt/elsewhere", "tuned"], "not-found"],
      [["apply", "/mnt/old", "tuned"], "not-found"], // only a commented line
      [["apply", "/data", "tuned"], "not-nfs"],
      [["apply", "/", "tuned"], "bad-mountpoint"],
      [["apply", "/mnt/storagespace", "fast"], "bad-preset"],
      [["apply", "/mnt/storagespace", "rsize=1048576"], "bad-preset"],
      [["apply", "/mnt/storagespace"], "usage"],
      [["apply", "/mnt/storagespace", "tuned", "extra"], "usage"],
      [["status"], "usage"],
      [["remount", "/mnt/storagespace"], "usage"],
      [["revert", "/mnt/storagespace"], "nothing-to-revert"],
    ];
    const odd = [
      "/mnt/storagespace;id", "/mnt/storagespace && id", "/mnt/$(id)", "/mnt/`id`", "/mnt/storage space", "mnt/storagespace",
      "/mnt/../etc", "/mnt/./storagespace", "/mnt/storagespace/", "/mnt//storagespace", "/etc", "/etc/fstab", "/proc/self",
      "/mnt/storagespace\n/data", "-l", "--all", "/mnt/stor*", "/mnt/storage?pace", "/mnt/storagespace'", "/mnt/storagespace\"", "/mnt/x|id", "/mnt/x>y", "",
      "/" + "a".repeat(250),
    ];
    for (const mp of odd) cases.push([["apply", mp, "tuned"], "bad-mountpoint"], [["status", mp], "bad-mountpoint"]);
    for (const [args, code] of cases) {
      const r = sb.run(args);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.equal(r.code, code, `${JSON.stringify(args)} -> ${r.code}: ${r.error}`);
    }
    assert.equal(sb.text(), FSTAB_TEXT);
    assert.deepEqual(sb.calls(), [], "nothing was mounted or unmounted");
    assert.ok(!fs.existsSync(sb.state) || fs.readdirSync(sb.state).filter((f) => f.startsWith("fstab.")).length === 0, "no backup: nothing was about to change");
  } finally { sb.done(); }
});

test("apply then revert: one line changes (spacing kept, the rest byte for byte), the mount follows, and revert gives the original back", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const a = sb.run(["apply", "/mnt/storagespace", "tuned"]);
    assert.equal(a.ok, true, a.error);
    assert.equal(a.changed, true);
    assert.equal(a.fstabBefore, "rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536");
    assert.equal(a.fstabAfter, TUNED_OPTS);
    assert.match(a.liveBefore, /rsize=65536/);
    assert.match(a.liveAfter, /rsize=1048576/);
    assert.match(a.liveAfter, /nconnect=4/);
    assert.match(a.liveAfter, /(^|,)soft(,|$)/);
    assert.deepEqual(a.clamped, []);
    assert.deepEqual(a.missing, []);
    const text = sb.text();
    assert.equal(nfsLine(text), `46.38.248.210:/voln1117606a1  /mnt/storagespace  nfs  ${TUNED_OPTS}  0  0`);
    const before = FSTAB_TEXT.split("\n");
    const after = text.split("\n");
    assert.equal(after.length, before.length);
    assert.deepEqual(after.filter((l, i) => l !== before[i]).length, 1, "exactly one line changed");
    // a source with an escaped space, on another line: untouched
    assert.ok(text.includes("10.0.0.7:/media\\040files\t/mnt/second\tnfs4\trw,hard,vers=4.1\t0 0"));
    // the order: reload, a plain umount (never -l or -f), then mount
    const calls = sb.calls();
    assert.deepEqual(calls, ["systemctl daemon-reload", "umount /mnt/storagespace", "mount /mnt/storagespace"]);
    assert.ok(fs.existsSync(path.join(sb.state, a.backup.split("/").pop())), "a timestamped backup of the fstab");
    assert.equal(fs.readFileSync(path.join(sb.state, a.backup.split("/").pop()), "utf8"), FSTAB_TEXT, "the backup is the fstab as it was");

    const s = sb.run(["status", "/mnt/storagespace"]);
    assert.equal(s.isTuned, true);
    assert.equal(s.canRevert, true);
    assert.equal(s.originalOptions, "rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536");

    // a second apply: nothing to do, nothing unmounted
    const again = sb.run(["apply", "/mnt/storagespace", "tuned"]);
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(sb.calls().length, 3);

    const r = sb.run(["revert", "/mnt/storagespace"]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.changed, true);
    assert.equal(r.fstabAfter, "rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536");
    assert.equal(sb.text(), FSTAB_TEXT, "the fstab is exactly as it was");
    assert.match(sb.live(), /(^|,)hard(,|$)/);
    assert.match(sb.live(), /rsize=65536/);
    const s2 = sb.run(["status", "/mnt/storagespace"]);
    assert.equal(s2.canRevert, false);
    assert.equal(s2.isTuned, false);
    assert.equal(sb.run(["revert", "/mnt/storagespace"]).code, "nothing-to-revert");
  } finally { sb.done(); }
});

test("an nfs4 line whose source has an escaped space: only its options change", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const a = sb.run(["apply", "/mnt/second", "tuned"]); // not mounted: just mounted
    assert.equal(a.ok, true, a.error);
    assert.equal(nfsLine(sb.text(), "/mnt/second"), "10.0.0.7:/media\\040files\t/mnt/second\tnfs4\trw,vers=4.1,rsize=1048576,wsize=1048576,nconnect=4,_netdev,nofail,x-systemd.mount-timeout=30s,soft,timeo=100,retrans=2\t0 0");
    assert.deepEqual(sb.calls(), ["systemctl daemon-reload", "mount /mnt/second"], "it was not mounted, so no umount");
  } finally { sb.done(); }
});

test("the server agrees to a smaller rsize: ok, and the real figures are reported", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const a = sb.run(["apply", "/mnt/storagespace", "tuned"], { STUB_CLAMP: "262144" });
    assert.equal(a.ok, true);
    assert.deepEqual(a.clamped, ["rsize=262144", "wsize=262144"]);
    assert.deepEqual(a.missing, []);
    assert.match(a.message, /The server agreed to less: rsize=262144 wsize=262144\./);
  } finally { sb.done(); }
});

test("the new options do not mount: the old fstab comes back and the drive is mounted the old way", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const a = sb.run(["apply", "/mnt/storagespace", "tuned"], { STUB_MOUNT_FAIL_IF: "nconnect=" });
    assert.equal(a.ok, false);
    assert.equal(a.code, "mount-failed");
    assert.equal(a.fstabRestored, true);
    assert.equal(a.mountedOldWay, true);
    assert.match(a.detail, /incorrect mount option/);
    assert.equal(sb.text(), FSTAB_TEXT, "the fstab as it was");
    assert.match(sb.live(), /rsize=65536/);
    assert.match(sb.live(), /(^|,)hard(,|$)/);
    assert.deepEqual(sb.calls(), ["systemctl daemon-reload", "umount /mnt/storagespace", "mount /mnt/storagespace", "systemctl daemon-reload", "mount /mnt/storagespace"]);
  } finally { sb.done(); }
});

test("a busy drive is not unmounted (no lazy or forced unmount): nothing changes", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const a = sb.run(["apply", "/mnt/storagespace", "tuned"], { STUB_UMOUNT: "busy" });
    assert.equal(a.ok, false);
    assert.equal(a.code, "busy");
    assert.match(a.error, /still has a file open/);
    assert.equal(a.fstabRestored, true);
    assert.equal(a.mountedOldWay, true);
    assert.equal(sb.text(), FSTAB_TEXT);
    assert.match(sb.live(), /rsize=65536/, "still mounted the old way");
    const calls = sb.calls();
    assert.ok(!calls.some((c) => /^mount /.test(c)), "no mount after a refused umount");
    assert.ok(!calls.some((c) => /umount .*(-l|-f|--lazy|--force)/.test(c)), calls.join("\n"));
  } finally { sb.done(); }
});

test("test mode is refused under sudo, and the real mode refuses a non-root caller without reading /etc/fstab", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    for (const v of [{ SUDO_UID: "1000" }, { SUDO_USER: "elia" }, { SUDO_COMMAND: "/usr/local/sbin/aurora-mount-helper" }]) {
      const r = sb.run(["apply", "/mnt/storagespace", "tuned"], v);
      assert.equal(r.code, "refused", JSON.stringify(v));
    }
    const r = sb.run(["status", "/mnt/storagespace"], { AURORA_MOUNT_HELPER_TEST: "" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "not-root");
    assert.equal(sb.text(), FSTAB_TEXT);
  } finally { sb.done(); }
});

// Which drives this machine has — the candidates the admin's "Drives" card
// lists (lib/drives/index.js). PURE: text in, list out; reading the files and
// asking Windows happen elsewhere, so every rule here is tested with fixtures.
//
// Linux: /proc/self/mountinfo (preferred: it carries the device number, so a
// bind mount of the same disk is one drive), else /proc/mounts, else the
// output of `mount` ("<src> on <dir> type <fs> (<opts>)"). Real file systems
// only (KEEP below); the system's own mounts — /boot, /boot/efi, /proc, /sys,
// /dev, /run, snaps, docker layers, tmpfs — never.
// Windows: Win32_LogicalDisk rows (PowerShell, JSON): fixed, removable and
// network drives; never a CD drive or a drive with no size (an empty reader).
"use strict";

const LOCAL_FS = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "ntfs", "ntfs3", "fuseblk", "exfat", "vfat", "bcachefs"]);
const NETWORK_FS = new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "fuse.sshfs", "fuse.rclone", "glusterfs", "fuse.glusterfs", "ceph", "fuse.ceph", "9p", "davfs", "fuse.davfs2", "afs", "lustre"]);
const KEEP = (fstype) => LOCAL_FS.has(fstype) || NETWORK_FS.has(fstype);
// mount points that belong to the system, whatever their type
const SYSTEM_DIR = /^\/(boot|proc|sys|dev|snap|var\/lib\/docker|var\/lib\/containers|var\/snap|run(?!\/media\/))(\/|$)/;

// mountinfo and /proc/mounts escape space, tab, newline and backslash as \040 \011 \012 \134
const unescape = (s) => String(s).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

// One line of /proc/self/mountinfo:
//   36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue
//   (id parent major:minor root mountpoint options [optional fields…] - fstype source superoptions)
const parseMountinfoLine = (line) => {
  const dash = line.indexOf(" - ");
  if (dash < 0) return null;
  const left = line.slice(0, dash).trim().split(/\s+/);
  const right = line.slice(dash + 3).trim().split(/\s+/);
  if (left.length < 6 || right.length < 2) return null;
  return {
    dev: left[2],
    root: unescape(left[3]),
    mount: unescape(left[4]),
    options: left[5],
    fstype: right[0],
    source: unescape(right[1]),
    superOptions: right[2] || "",
  };
};
// One line of /proc/mounts (fstab format): "<src> <dir> <fs> <opts> 0 0"
const parseFstabLine = (line) => {
  const p = line.trim().split(/\s+/);
  if (p.length < 4) return null;
  return { dev: null, root: "/", mount: unescape(p[1]), options: p[3], fstype: p[2], source: unescape(p[0]), superOptions: "" };
};
// One line of `mount`'s output: "<src> on <dir> type <fs> (<opts>)"
const parseMountCmdLine = (line) => {
  const m = /^(.+?) on (.+?) type (\S+)(?: \((.*)\))?\s*$/.exec(line.trim());
  if (!m) return null;
  return { dev: null, root: "/", mount: m[2], options: m[4] || "", fstype: m[3], source: m[1], superOptions: "" };
};

// Any of the three formats, line by line (a line it cannot read is skipped).
const parseMounts = (text) => {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const e = / - /.test(line) && /^\d+ \d+ \d+:\d+ /.test(line)
      ? parseMountinfoLine(line)
      : / on .+ type /.test(line) ? parseMountCmdLine(line) : parseFstabLine(line);
    if (e && e.mount && e.fstype) out.push(e);
  }
  return out;
};

const isNetworkFs = (fstype) => NETWORK_FS.has(String(fstype || "").toLowerCase());
const optionsOf = (e) => new Set(`${e.options || ""},${e.superOptions || ""}`.split(",").map((s) => s.trim()).filter(Boolean));

// The mounts worth offering, one per drive: kept types, no system folders,
// grouped by device (mountinfo's major:minor; else the source) — the shortest
// mount point of a device stands for it (a bind mount of /srv/media under
// /home/x/media is the same disk).
const candidates = (entries) => {
  const byDev = new Map();
  for (const e of entries || []) {
    const fstype = String(e.fstype || "").toLowerCase();
    if (!KEEP(fstype)) continue;
    if (SYSTEM_DIR.test(e.mount)) continue;
    const network = isNetworkFs(fstype);
    const key = network ? `net:${e.source}` : e.dev ? `dev:${e.dev}` : `src:${e.source}`;
    const prev = byDev.get(key);
    if (prev && prev.mount.length <= e.mount.length) continue;
    const opts = optionsOf(e);
    byDev.set(key, {
      id: e.mount,
      mount: e.mount,
      source: e.source,
      fstype,
      network,
      readOnly: opts.has("ro"),
      // what the NFS safety advice looks at (docs/storage-drives.md)
      hard: network && !opts.has("soft") && !opts.has("softerr"),
      // (and what "Tune this network drive" changes: rsize, wsize, nconnect)
      options: [...opts].filter((o) => /^(hard|soft|softerr|timeo=|retrans=|vers=|nofail|_netdev|ro|rw|rsize=|wsize=|nconnect=|proto=)/.test(o)),
    });
  }
  return [...byDev.values()].sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.localeCompare(b.mount)));
};

// Win32_LogicalDisk → the same shape. DriveType 2 removable, 3 fixed, 4 network.
// (PowerShell's ConvertTo-Json gives one object, not a list, when there is one drive.)
const parseWindowsDisks = (json) => {
  let rows;
  try { rows = typeof json === "string" ? JSON.parse(json) : json; } catch { return []; }
  if (!rows) return [];
  if (!Array.isArray(rows)) rows = [rows];
  const out = [];
  for (const r of rows) {
    const letter = /^([A-Za-z]):?$/.exec(String(r.DeviceID || ""));
    const type = Number(r.DriveType);
    if (!letter || ![2, 3, 4].includes(type)) continue;
    if (!(Number(r.Size) > 0)) continue;
    const L = letter[1].toUpperCase();
    out.push({
      id: `${L}:`,
      mount: `${L}:\\`,
      source: r.ProviderName || r.VolumeName || `${L}:`,
      fstype: String(r.FileSystem || (type === 4 ? "network" : "")).toLowerCase(),
      network: type === 4,
      readOnly: false,
      hard: false,
      options: [],
      label: r.VolumeName || null,
      total: Number(r.Size) || null,
      free: Number(r.FreeSpace),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
};

// The drive a path lives on: the longest mount point that contains it. PURE.
const driveOf = (abs, drives, platform = process.platform) => {
  const win = platform === "win32";
  const norm = (p) => {
    let s = String(p || "");
    if (win) s = s.replace(/\//g, "\\").toLowerCase();
    return s;
  };
  const a = norm(abs);
  let best = null;
  for (const d of drives || []) {
    const m = norm(d.mount);
    const sep = win ? "\\" : "/";
    const inside = a === m || a === m.replace(/[\\/]+$/, "") || a.startsWith(m.endsWith(sep) ? m : m + sep);
    if (inside && (!best || m.length > norm(best.mount).length)) best = d;
  }
  return best;
};

module.exports = { parseMounts, parseMountinfoLine, candidates, parseWindowsDisks, driveOf, isNetworkFs, LOCAL_FS, NETWORK_FS };

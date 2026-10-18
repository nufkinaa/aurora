// What kind of disk a library file lives on — asked of the OS, once per
// disk, in the background. Direct play (lib/diskread.js) makes viewers take
// turns on a spinning disk and lets them read freely from an SSD.
//
//   "hdd"      a spinning disk: reads take turns (measured on the house
//              server's 7,200 rpm disk: 13 → 45 viewers at 12 Mbit/s)
//   "ssd"      SATA SSD / NVMe: no turns — a flash disk wants many reads in
//              flight, and there is no head to move
//   "network"  a share (SMB/NFS/…): a middle setting
//   "unknown"  not asked yet, or the OS would not say: the middle setting
//
// Windows: the volume's partition → its physical disk → MediaType and BusType
// (PowerShell's storage cmdlets; a mapped or UNC share is DriveType Network).
// Linux: the device's /sys/dev/block/<major>:<minor> (its parent disk for a
// partition) → queue/rotational; a path on an nfs/cifs/smb/sshfs mount
// (/proc/mounts) is a share. Anywhere else: unknown.
// Overridable per library root in config ("diskTypes": { "E:\\": "hdd" } —
// a prefix of the file's path → kind).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const KINDS = new Set(["hdd", "ssd", "network", "unknown"]);
const byDev = new Map(); // dev -> { kind, why, at }
const asking = new Set();

const deps = {
  platform: () => process.platform,
  overrides: () => {
    try { return require("../config").DISK_TYPES || null; } catch { return null; }
  },
  powershell: (script) => new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 }, (err, so) => resolve(err ? null : String(so || "").trim()));
  }),
  readFile: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
};

const fromOverride = (file) => {
  const o = deps.overrides();
  if (!o || typeof o !== "object") return null;
  const f = String(file).toLowerCase();
  let best = null;
  for (const [prefix, kind] of Object.entries(o)) {
    if (!KINDS.has(kind)) continue;
    const p = String(prefix).toLowerCase();
    if (f.startsWith(p) && (!best || p.length > best.p.length)) best = { p, kind };
  }
  return best ? { kind: best.kind, why: `set in config for ${best.p}` } : null;
};

// ---------- Windows ----------
const askWindows = async (file) => {
  const abs = path.win32.resolve(file);
  if (/^\\\\/.test(abs)) return { kind: "network", why: "a network share (UNC path)" };
  const letter = /^([a-zA-Z]):/.exec(abs);
  if (!letter) return { kind: "unknown", why: "no drive letter" };
  const L = letter[1].toUpperCase();
  const out = await deps.powershell(
    `$ErrorActionPreference='Stop'; try { $t=([System.IO.DriveInfo]::new('${L}')).DriveType; if ($t -eq 'Network') { 'network' ; exit } ; $p=Get-Partition -DriveLetter ${L}; $d=Get-PhysicalDisk | Where-Object { $_.DeviceId -eq [string]$p.DiskNumber } | Select-Object -First 1; "$($d.MediaType)|$($d.BusType)|$($d.FriendlyName)" } catch { 'error' }`,
  );
  return parseWindows(out, L);
};
const parseWindows = (out, L = "?") => {
  if (!out || out === "error") return { kind: "unknown", why: `Windows would not say what drive ${L}: is` };
  if (out === "network") return { kind: "network", why: `drive ${L}: is a network drive` };
  const [media, bus, name] = out.split("|");
  const m = String(media || "").toUpperCase();
  const b = String(bus || "").toUpperCase();
  if (m === "HDD") return { kind: "hdd", why: `drive ${L}: is a spinning disk (${name || "HDD"})` };
  if (m === "SSD" || b === "NVME") return { kind: "ssd", why: `drive ${L}: is ${b === "NVME" ? "an NVMe" : "a solid-state"} disk (${name || "SSD"})` };
  return { kind: "unknown", why: `Windows says drive ${L}: is "${media || "?"}" on ${bus || "?"}` };
};

// ---------- Linux ----------
const NET_FS = /^(nfs4?|cifs|smb3?|smbfs|fuse\.sshfs|9p|fuse\.rclone|glusterfs|ceph|afs)$/;
const mountOf = (file, mounts) => {
  let best = null;
  for (const line of String(mounts || "").split("\n")) {
    const [, mnt, type] = line.split(" ");
    if (!mnt) continue;
    const m = mnt.replace(/\\040/g, " ");
    if ((file === m || file.startsWith(m.endsWith("/") ? m : `${m}/`)) && (!best || m.length > best.m.length)) best = { m, type };
  }
  return best;
};
const askLinux = async (file, dev) => {
  const real = deps.realpath(file) || file;
  const mnt = mountOf(real, deps.readFile("/proc/mounts"));
  if (mnt && NET_FS.test(mnt.type)) return { kind: "network", why: `${mnt.m} is a ${mnt.type} share` };
  if (dev == null) return { kind: "unknown", why: "no device number" };
  const major = Number((BigInt(dev) >> 8n) & 0xfffn) | Number((BigInt(dev) >> 32n) & ~0xfffn);
  const minor = Number(BigInt(dev) & 0xffn) | Number((BigInt(dev) >> 12n) & ~0xffn);
  const sys = deps.realpath(`/sys/dev/block/${major}:${minor}`);
  if (!sys) return { kind: "unknown", why: `no block device ${major}:${minor}${mnt ? ` (${mnt.type} at ${mnt.m})` : ""}` };
  let disk = sys;
  let rot = deps.readFile(path.posix.join(sys, "queue", "rotational"));
  if (rot == null) { disk = path.posix.dirname(sys); rot = deps.readFile(path.posix.join(disk, "queue", "rotational")); } // a partition: its disk
  const name = path.posix.basename(disk);
  if (rot == null) return { kind: "unknown", why: `${name} does not say whether it spins` };
  if (String(rot).trim() !== "1") return { kind: "ssd", why: `${name} is not rotational (SSD or NVMe)` };
  // A virtual machine's disk says "rotational" whatever is under it (a VPS's
  // virtio disk, Hyper-V's — WSL included): neither answer can be trusted.
  const vendor = `${deps.readFile(path.posix.join(disk, "device", "vendor")) || ""} ${deps.readFile(path.posix.join(disk, "device", "model")) || ""}`.trim();
  if (/^(vd|xvd)/.test(name) || /QEMU|Virtual|VMware|Msft|Google|Amazon|Xen|VBOX|BOCHS|virtio/i.test(vendor)) {
    return { kind: "unknown", why: `${name} is a virtual disk${vendor ? ` (${vendor.replace(/\s+/g, " ")})` : ""}: what is under it is not known` };
  }
  return { kind: "hdd", why: `${name} is a spinning disk (rotational)` };
};

// Which disk a file is on, as a key: the device number on Linux and macOS;
// on Windows the drive (C:\, E:\, \server\share\) — Node reports
// st.dev as 0 for NTFS volumes there (seen on this PC for both C: and E:),
// so the device number cannot tell two disks apart.
const diskKey = (file, dev) => {
  const P = deps.platform() === "win32" ? path.win32 : path;
  if (deps.platform() === "win32" || dev == null || dev === 0) return `root:${P.parse(P.resolve(String(file))).root.toUpperCase()}`;
  return String(dev);
};

// The kind for this file's disk: what is known now ("unknown" the first
// time), and the OS is asked in the background.
const kindFor = (file, dev) => {
  const key = diskKey(file, dev);
  const o = fromOverride(file);
  if (o) return o.kind;
  const hit = byDev.get(key);
  if (hit) return hit.kind;
  if (!asking.has(key)) {
    asking.add(key);
    const ask = deps.platform() === "win32" ? askWindows(file) : deps.platform() === "linux" ? askLinux(file, dev) : Promise.resolve({ kind: "unknown", why: `not asked on ${deps.platform()}` });
    ask.catch(() => ({ kind: "unknown", why: "asking failed" })).then((r) => {
      byDev.set(key, { ...r, at: Date.now(), file });
      asking.delete(key);
      try { console.log(`[disk] ${r.why} — direct play ${r.kind === "hdd" ? "takes turns on it" : r.kind === "ssd" ? "reads it freely" : "uses the middle setting"}`); } catch {}
    });
  }
  return "unknown";
};

const status = () => [...byDev].map(([dev, v]) => ({ dev, kind: v.kind, why: v.why }));

module.exports = { kindFor, diskKey, status, _internals: { deps, byDev, parseWindows, mountOf, askLinux, fromOverride, reset: () => { byDev.clear(); asking.clear(); } } };

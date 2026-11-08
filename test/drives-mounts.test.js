// Which drives the admin is offered (src/lib/drives/mounts.js): the mount
// list parsed from /proc/self/mountinfo, /proc/mounts or `mount`'s output,
// the system's own mounts left out, one entry per device; Windows drive
// letters; and which drive a path is on.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const m = require("../src/lib/drives/mounts");

// nufurora.com's own mounts (2026-11-08), as /proc/self/mountinfo has them
const MOUNTINFO = [
  "22 28 0:20 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw",
  "23 28 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw",
  "24 28 0:5 / /dev rw,nosuid,relatime shared:2 - devtmpfs udev rw,size=8123456k,nr_inodes=2030864,mode=755",
  "26 28 0:23 / /run rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=1631248k,mode=755",
  "28 1 252:3 / / rw,relatime shared:1 - ext4 /dev/vda3 rw",
  "30 28 0:25 / /dev/shm rw,nosuid,nodev shared:4 - tmpfs tmpfs rw",
  "40 28 252:2 / /boot rw,relatime shared:60 - ext4 /dev/vda2 rw",
  "41 40 252:1 / /boot/efi rw,relatime shared:62 - vfat /dev/vda1 rw,fmask=0077,dmask=0077",
  "60 28 7:1 / /snap/core22/1380 ro,nodev,relatime shared:31 - squashfs /dev/loop1 ro,errors=continue",
  "70 28 0:44 / /var/lib/docker/overlay2/abc/merged rw,relatime - overlay overlay rw,lowerdir=/x",
  "80 28 0:55 / /mnt/storagespace rw,relatime shared:80 - nfs 46.38.248.210:/voln1117606a1 rw,vers=3,rsize=65536,wsize=65536,namlen=255,hard,nolock,proto=tcp,timeo=600,retrans=2,sec=sys,mountaddr=46.38.248.210,mountvers=3,mountport=2049,mountproto=tcp,local_lock=all,addr=46.38.248.210",
  // a bind mount of the root disk elsewhere: the same drive, listed once
  "90 28 252:3 /srv/media /home/elia/media rw,relatime shared:1 - ext4 /dev/vda3 rw",
  // a space in a mount point is written \\040
  "95 28 8:17 / /media/elia/My\\040Disk rw,relatime - exfat /dev/sdb1 rw",
].join("\n");

test("mountinfo: the root disk and the NFS volume, nothing of the system's", () => {
  const list = m.candidates(m.parseMounts(MOUNTINFO));
  assert.deepEqual(list.map((d) => d.mount), ["/", "/media/elia/My Disk", "/mnt/storagespace"]);
  const root = list[0];
  assert.equal(root.network, false);
  assert.equal(root.fstype, "ext4");
  assert.equal(root.source, "/dev/vda3");
  const nfs = list.find((d) => d.mount === "/mnt/storagespace");
  assert.equal(nfs.network, true);
  assert.equal(nfs.fstype, "nfs");
  assert.equal(nfs.source, "46.38.248.210:/voln1117606a1");
  assert.equal(nfs.hard, true, "hard (no soft option) is what the NFS advice is about");
  assert.ok(nfs.options.includes("vers=3"));
  assert.ok(nfs.options.includes("timeo=600"));
});

test("elia's NFS line as `mount` prints it", () => {
  const text = [
    "/dev/vda3 on / type ext4 (rw,relatime)",
    "/dev/vda2 on /boot type ext4 (rw,relatime)",
    "/dev/vda1 on /boot/efi type vfat (rw,relatime,fmask=0077)",
    "tmpfs on /run type tmpfs (rw,nosuid,nodev,size=1631248k,mode=755)",
    "tmpfs on /dev/shm type tmpfs (rw,nosuid,nodev)",
    "46.38.248.210:/voln1117606a1 on /mnt/storagespace type nfs (rw,relatime,vers=3,rsize=65536,wsize=65536,namlen=255,hard,nolock,proto=tcp,timeo=600,retrans=2,sec=sys)",
  ].join("\n");
  const list = m.candidates(m.parseMounts(text));
  assert.deepEqual(list.map((d) => [d.mount, d.fstype, d.network]), [["/", "ext4", false], ["/mnt/storagespace", "nfs", true]]);
});

test("/proc/mounts (no device numbers): soft NFS, cifs, nfs4", () => {
  const text = [
    "/dev/vda3 / ext4 rw,relatime 0 0",
    "proc /proc proc rw,nosuid 0 0",
    "nas:/export /mnt/nas nfs4 rw,relatime,vers=4.2,soft,timeo=100,retrans=3 0 0",
    "//box/share /mnt/smb cifs rw,relatime,vers=3.0 0 0",
    "tmpfs /tmp tmpfs rw 0 0",
  ].join("\n");
  const list = m.candidates(m.parseMounts(text));
  assert.deepEqual(list.map((d) => d.mount), ["/", "/mnt/nas", "/mnt/smb"]);
  assert.equal(list[1].hard, false);
  assert.equal(list[2].network, true);
});

test("Windows drive letters: fixed, removable and network — never a CD drive or an empty reader", () => {
  const json = JSON.stringify([
    { DeviceID: "C:", DriveType: 3, Size: 1022555582464, FreeSpace: 50472759296, FileSystem: "NTFS", VolumeName: "Windows" },
    { DeviceID: "D:", DriveType: 5, Size: null, FreeSpace: null },
    { DeviceID: "E:", DriveType: 3, Size: 1000068870144, FreeSpace: 360125358080, FileSystem: "NTFS", VolumeName: "Media" },
    { DeviceID: "F:", DriveType: 2, Size: 0, FreeSpace: 0 },
    { DeviceID: "Z:", DriveType: 4, Size: 4000000000000, FreeSpace: 1000000000000, ProviderName: "\\\\nas\\films" },
  ]);
  const list = m.parseWindowsDisks(json);
  assert.deepEqual(list.map((d) => [d.id, d.network]), [["C:", false], ["E:", false], ["Z:", true]]);
  assert.equal(list[1].label, "Media");
  assert.equal(list[2].source, "\\\\nas\\films");
  // one drive: PowerShell gives an object, not a list
  assert.equal(m.parseWindowsDisks(JSON.stringify({ DeviceID: "C:", DriveType: 3, Size: 10, FreeSpace: 5 })).length, 1);
  assert.deepEqual(m.parseWindowsDisks("not json"), []);
});

test("driveOf: the longest mount point that holds the path", () => {
  const list = m.candidates(m.parseMounts(MOUNTINFO));
  assert.equal(m.driveOf("/mnt/storagespace/Aurora/Movies/X (2020)/x.mkv", list, "linux").mount, "/mnt/storagespace");
  assert.equal(m.driveOf("/mnt/storagespace", list, "linux").mount, "/mnt/storagespace");
  assert.equal(m.driveOf("/mnt/storagespace2/x", list, "linux").mount, "/", "a name that only starts the same is another folder");
  assert.equal(m.driveOf("/opt/aurora/data", list, "linux").mount, "/");
  const win = m.parseWindowsDisks(JSON.stringify([{ DeviceID: "C:", DriveType: 3, Size: 10, FreeSpace: 5 }, { DeviceID: "E:", DriveType: 3, Size: 10, FreeSpace: 5 }]));
  assert.equal(m.driveOf("e:\\Movies\\x.mkv", win, "win32").id, "E:");
  assert.equal(m.driveOf("C:/Users/x", win, "win32").id, "C:");
  assert.equal(m.driveOf("Q:\\x", win, "win32"), null);
});

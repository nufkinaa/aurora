// What kind of disk a library file is on (lib/disktype.js), and how direct
// play reads it (lib/diskread.js limitFor): turns on a spinning disk, free
// reads on a flash disk, the middle for a share or an unknown.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const dt = require("../src/lib/disktype");
const diskread = require("../src/lib/diskread");

const { deps } = dt._internals;
const real = { ...deps };
beforeEach(() => { Object.assign(deps, real); dt._internals.reset(); });
const settle = () => new Promise((r) => setTimeout(r, 20));

test("read pattern by kind: big reads in turns only on a spinning disk; an SSD as before", () => {
  assert.deepEqual(diskread.policyFor("hdd"), { read: 1024 * 1024, limit: 2 });
  assert.equal(diskread.policyFor("ssd"), null, "the plain reader");
  assert.deepEqual(diskread.policyFor("network"), { read: 512 * 1024, limit: 4 });
  assert.deepEqual(diskread.policyFor("unknown"), { read: 512 * 1024, limit: 4 });
  assert.deepEqual(diskread.policyFor(undefined), diskread.policyFor("unknown"));
});

test("Windows: the physical disk's media type and bus", () => {
  const p = dt._internals.parseWindows;
  assert.equal(p("HDD|SATA|ST1000DM003-1SB102", "E").kind, "hdd");
  assert.equal(p("SSD|NVMe|INTEL SSDPEKNW010T9", "C").kind, "ssd");
  assert.equal(p("Unspecified|NVMe|Some disk", "F").kind, "ssd", "NVMe is flash whatever MediaType says");
  assert.equal(p("Unspecified|USB|ADATA", "D").kind, "unknown");
  assert.equal(p("network", "Z").kind, "network");
  assert.equal(p(null, "Z").kind, "unknown");
});

test("Windows: asked once per drive, in the background; a UNC path is a share", async () => {
  deps.platform = () => "win32";
  let asked = 0;
  deps.powershell = async () => { asked++; return "HDD|SATA|Disk"; };
  assert.equal(dt.kindFor("E:\\films\\a.mkv", 0), "unknown", "not known on the first ask");
  assert.equal(dt.kindFor("E:\\films\\b.mkv", 0), "unknown");
  await settle();
  assert.equal(dt.kindFor("e:\\shows\\c.mkv", 0), "hdd");
  assert.equal(asked, 1, "one question for the drive");
  // C: and E: both report st.dev 0 on Windows: they are told apart by drive
  assert.notEqual(dt.diskKey("C:\\x", 0), dt.diskKey("E:\\x", 0));
  dt.kindFor("\\\\nas\\films\\a.mkv", 0);
  await settle();
  assert.equal(dt.kindFor("\\\\nas\\films\\b.mkv", 0), "network");
});

test("Linux: rotational of the device (or its disk, for a partition); network mounts", async () => {
  deps.platform = () => "linux";
  const files = {
    "/proc/mounts": "/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /media/films ext4 rw 0 0\nnas:/v /mnt/nas nfs4 rw 0 0\n/dev/nvme0n1p2 /srv ext4 rw 0 0\n",
    "/sys/devices/pci/ata1/block/sdb/queue/rotational": "1\n",
    "/sys/devices/pci/nvme/nvme0n1/queue/rotational": "0\n",
  };
  const links = {
    "/sys/dev/block/8:17": "/sys/devices/pci/ata1/block/sdb/sdb1",
    "/sys/dev/block/259:2": "/sys/devices/pci/nvme/nvme0n1/nvme0n1p2",
  };
  deps.readFile = (p) => (p in files ? files[p] : null);
  deps.realpath = (p) => links[p] || (p.startsWith("/sys") ? null : p);
  links["/sys/dev/block/252:1"] = "/sys/devices/virtio1/block/vda/vda1";
  files["/sys/devices/virtio1/block/vda/queue/rotational"] = "1\n";
  links["/sys/dev/block/8:64"] = "/sys/devices/vmbus/host0/block/sde";
  files["/sys/devices/vmbus/host0/block/sde/queue/rotational"] = "1\n";
  files["/sys/devices/vmbus/host0/block/sde/device/vendor"] = "Msft    \n";
  files["/sys/devices/vmbus/host0/block/sde/device/model"] = "Virtual Disk    \n";
  files["/proc/mounts"] += "/dev/vda1 /vps ext4 rw 0 0\n/dev/sde /wsl ext4 rw 0 0\n";
  const dev = (major, minor) => major * 256 + minor;
  dt.kindFor("/vps/a.mkv", dev(252, 1));
  dt.kindFor("/wsl/a.mkv", dev(8, 64));
  dt.kindFor("/media/films/a.mkv", dev(8, 17));
  dt.kindFor("/srv/b.mkv", dev(259, 2));
  dt.kindFor("/mnt/nas/c.mkv", dev(0, 50));
  dt.kindFor("/elsewhere/d.mkv", dev(9, 9));
  await settle();
  assert.equal(dt.kindFor("/media/films/x.mkv", dev(8, 17)), "hdd");
  assert.equal(dt.kindFor("/srv/x.mkv", dev(259, 2)), "ssd");
  assert.equal(dt.kindFor("/mnt/nas/x.mkv", dev(0, 50)), "network");
  assert.equal(dt.kindFor("/elsewhere/x.mkv", dev(9, 9)), "unknown");
  assert.equal(dt.kindFor("/vps/x.mkv", dev(252, 1)), "unknown", "a VPS's virtio disk says rotational whatever it is");
  assert.equal(dt.kindFor("/wsl/x.mkv", dev(8, 64)), "unknown", "so does Hyper-V's (WSL)");
  assert.equal(dt._internals.mountOf("/media/filmsx/a", files["/proc/mounts"]).m, "/", "a prefix that is not a folder boundary is not that mount");
});

test("config overrides the OS, by the longest matching prefix", async () => {
  deps.platform = () => "linux";
  deps.overrides = () => ({ "/media": "ssd", "/media/films": "hdd", "/bad": "floppy" });
  assert.equal(dt.kindFor("/media/films/a.mkv", 1), "hdd");
  assert.equal(dt.kindFor("/media/other/a.mkv", 2), "ssd");
  assert.equal(dt._internals.fromOverride("/bad/x"), null, "an unknown kind is ignored");
});

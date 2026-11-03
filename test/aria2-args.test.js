// The engine's options (media/aria2.js engineArgs): what config.json's
// "downloadEngine" turns into, and what is always there. Pure.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const aria2 = require("../src/media/aria2");

const plan = { maxConcurrent: 13, btMaxPeers: 90 };
const base = { plan, dataDir: "/data", port: 6801, secret: "s", stagingRoot: "/tmp/aurora-downloads", pid: 42 };
const has = (args, flag) => args.includes(flag);
const val = (args, name) => (args.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3) || null;

test("the defaults: not a seedbox, seeding never holds a place, a bigger write cache, resume file every 30 s, DHT on", () => {
  const a = aria2.engineArgs(base);
  assert.ok(has(a, "--seed-time=0"));
  assert.ok(has(a, "--bt-detach-seed-only=true"));
  assert.equal(val(a, "disk-cache"), "64M");
  assert.equal(val(a, "auto-save-interval"), "30");
  assert.equal(val(a, "file-allocation"), "none");
  assert.equal(val(a, "enable-dht"), "true");
  assert.equal(val(a, "dht-entry-point"), "router.bittorrent.com:6881");
  assert.equal(val(a, "bt-request-peer-speed-limit"), "10M");
  assert.equal(val(a, "max-concurrent-downloads"), "13");
  assert.equal(val(a, "bt-max-peers"), "90");
  assert.equal(val(a, "stop-with-process"), "42", "no orphan engine if the server dies");
  assert.equal(val(a, "listen-port"), null, "no fixed port unless asked");
  assert.equal(val(a, "bt-tracker"), null);
});

test("downloadEngine: a fixed port the firewall lets in, more peers on a fast line, falloc, extra trackers", () => {
  const a = aria2.engineArgs({ ...base, eng: { listenPort: 51413, peerSpeedTarget: "50M", fileAllocation: "falloc", diskCache: "128M", trackers: ["udp://a:1/announce", "http://b:2/announce"] } });
  assert.equal(val(a, "listen-port"), "51413");
  assert.equal(val(a, "dht-listen-port"), "51413", "the DHT on the same port (UDP)");
  assert.equal(val(a, "bt-request-peer-speed-limit"), "50M");
  assert.equal(val(a, "file-allocation"), "falloc");
  assert.equal(val(a, "disk-cache"), "128M");
  assert.equal(val(a, "bt-tracker"), "udp://a:1/announce,http://b:2/announce");
});

test("downloadEngine: a closed test rig — no DHT, no peer exchange, only its own tracker", () => {
  const a = aria2.engineArgs({ ...base, eng: { dht: false, peerExchange: false, excludeTrackers: "*", trackers: "http://127.0.0.1:9/announce", listenPort: 40001, dhtListenPort: 40002 } });
  assert.equal(val(a, "enable-dht"), "false");
  assert.equal(val(a, "enable-dht6"), "false");
  assert.equal(val(a, "dht-entry-point"), null);
  assert.equal(val(a, "enable-peer-exchange"), "false");
  assert.equal(val(a, "bt-exclude-tracker"), "*");
  assert.equal(val(a, "bt-tracker"), "http://127.0.0.1:9/announce");
  assert.equal(val(a, "dht-listen-port"), "40002");
});

test("nonsense in downloadEngine is ignored, never passed to the engine", () => {
  const a = aria2.engineArgs({ ...base, eng: { fileAllocation: "rm -rf", peerSpeedTarget: "fast", diskCache: "lots", listenPort: 99999 } });
  assert.equal(val(a, "file-allocation"), "none");
  assert.equal(val(a, "bt-request-peer-speed-limit"), "10M");
  assert.equal(val(a, "disk-cache"), "64M");
  assert.equal(val(a, "listen-port"), null);
});

#!/usr/bin/env node
// TORRENT STREAMING'S MEMORY, on a private two-client swarm on this machine
// (no tracker, no DHT, nothing leaves the PC): a seeder process holds a
// generated file; the leecher (this process, configured like the server's
// client — media/torrent.js) streams it with file.createReadStream at a
// steady rate, and its memory is sampled. Run with --slots 20 (webtorrent's
// default) and --slots 4 (the server's) to compare.
//
//   node tools/streamload/torrentmem.js --mb 1500 --slots 4 --rate 40
//   (--rate: MB/s the "player" reads at)
"use strict";
const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { SCRATCH, arg, sleep, round } = require("./lib");

const MB = parseInt(arg("mb", "1500"), 10);
const slots = parseInt(arg("slots", "20"), 10);
const rate = parseFloat(arg("rate", "40"));
const pieceKB = parseInt(arg("piece", "8192"), 10);
const work = path.join(SCRATCH, "torrentmem");

if (process.argv.includes("--seeder")) {
  (async () => {
    const { default: WebTorrent } = await import("webtorrent");
    const c = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false, webSeeds: false });
    const file = path.join(work, "seed", "film.bin");
    c.seed(file, { announce: [], pieceLength: pieceKB * 1024, private: true }, (t) => {
      process.send({ torrent: Buffer.from(t.torrentFile).toString("base64"), port: c.torrentPort });
    });
  })();
  return;
}

(async () => {
  fs.mkdirSync(path.join(work, "seed"), { recursive: true });
  const file = path.join(work, "seed", "film.bin");
  if (!fs.existsSync(file) || fs.statSync(file).size !== MB * 1048576) {
    const fd = fs.openSync(file, "w");
    const chunk = Buffer.alloc(1048576);
    for (let i = 0; i < MB; i++) { for (let j = 0; j < chunk.length; j += 4) chunk.writeUInt32LE((i * 2654435761 + j) >>> 0, j); fs.writeSync(fd, chunk); }
    fs.closeSync(fd);
  }
  const seeder = fork(__filename, ["--seeder", "--piece", String(pieceKB)], { stdio: "inherit" });
  const { torrent, port } = await new Promise((r) => seeder.once("message", r));
  const { default: WebTorrent } = await import("webtorrent");
  const dl = path.join(work, `dl-${slots}-${Date.now()}`);
  const c = new WebTorrent({ maxConns: 40, seedOutgoingConnections: false, utp: false, dht: false, tracker: false, lsd: false });
  const t = c.add(Buffer.from(torrent, "base64"), { path: dl, storeCacheSlots: slots, announce: [] });
  await new Promise((r) => t.once("metadata", r).once("ready", r));
  t.addPeer(`127.0.0.1:${port}`);
  const f = t.files[0];
  const samples = [];
  const base = process.memoryUsage();
  let got = 0;
  const t0 = Date.now();
  const s = f.createReadStream();
  s.on("data", (d) => {
    got += d.length;
    const ahead = got / 1048576 - ((Date.now() - t0) / 1000) * rate;
    if (ahead > 0) { s.pause(); setTimeout(() => s.resume(), (ahead / rate) * 1000); }
  });
  const timer = setInterval(() => {
    if (global.gc && process.argv.includes("--gc")) global.gc();
    if (process.argv.includes("--nudge")) require("../../src/lib/memnudge").check();
    const m = process.memoryUsage();
    samples.push({ rss: m.rss, ab: m.arrayBuffers, heap: m.heapUsed, dl: t.downloaded, got });
  }, 500);
  await new Promise((r) => s.on("end", r).on("error", r));
  clearInterval(timer);
  const el = (Date.now() - t0) / 1000;
  const mx = (k) => Math.max(...samples.map((x) => x[k])) / 1048576;
  console.log(JSON.stringify({
    slots, pieceKB, MB, rateMBs: rate, secs: round(el, 1), MBs: round(got / 1048576 / el, 1),
    aheadMaxMb: round(Math.max(...samples.map((x) => x.dl - x.got)) / 1048576, 0),
    nudge: process.argv.includes("--nudge") ? require("../../src/lib/memnudge").stats() : null,
    rssBaseMb: round(base.rss / 1048576, 0), rssMaxMb: round(mx("rss"), 0), arrayBuffersMaxMb: round(mx("ab"), 0), heapMaxMb: round(mx("heap"), 0),
  }));
  c.destroy();
  seeder.kill();
  await sleep(500);
  fs.rmSync(dl, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });

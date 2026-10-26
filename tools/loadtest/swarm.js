#!/usr/bin/env node
// A torrent swarm on this machine only, for torrent viewers in the load
// harness (tools/loadtest/capacity.js --mix worst / typical): a tracker on
// 127.0.0.1 and one seeder holding the given files. The private instance keeps
// its network fence (loopback is allowed); it finds the seeder through the
// .torrent the harness drops into its metadata cache (data/cache/torrents/
// <infoHash>.torrent — the server's own "cached .torrent first" path), whose
// announce list names this tracker. Nothing here talks to the internet: no
// DHT, no local-peer discovery, no uTP, an HTTP tracker bound to 127.0.0.1.
//
//   node tools/loadtest/swarm.js <file> [<file> …]
//   stdout: one JSON line per torrent { infoHash, name, length, torrent (base64) }, then {"ready":true,"tracker":…}
//   it runs until stdin closes (its parent went away) or it is killed.
//
// A swarm on loopback is as fast as the disk: the server fetches a whole film
// in seconds. That is a well-seeded torrent; a real swarm is slower and its
// time to first frame is mostly the swarm's (see the capacity report).
"use strict";
const path = require("path");

const main = async () => {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("no files");
  const { Server } = await import("bittorrent-tracker");
  const WebTorrent = (await import("webtorrent")).default;
  const tracker = new Server({ udp: false, http: true, ws: false, stats: false, trustProxy: false });
  await new Promise((resolve, reject) => { tracker.once("error", reject); tracker.listen(0, "127.0.0.1", resolve); });
  const port = tracker.http.address().port;
  const announce = [`http://127.0.0.1:${port}/announce`];
  const client = new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, webSeeds: false, maxConns: 200 });
  client.on("error", (e) => process.stderr.write(`[swarm] client error ${e && e.message}\n`));
  for (const f of files) {
    const t = await new Promise((resolve, reject) => {
      client.seed(f, { announce, name: path.basename(f), createdBy: "aurora-loadtest" }, resolve);
      setTimeout(() => reject(new Error(`seeding ${f} took too long`)), 10 * 60000);
    });
    process.stdout.write(JSON.stringify({ infoHash: t.infoHash, name: t.name, length: t.length, file: path.basename(f), torrent: Buffer.from(t.torrentFile).toString("base64") }) + "\n");
  }
  process.stdout.write(JSON.stringify({ ready: true, tracker: announce[0], torrents: client.torrents.length }) + "\n");
  // report the seeder's upload now and then (stderr): the parent may log it
  setInterval(() => process.stderr.write(`[swarm] up ${(client.uploadSpeed / 1048576).toFixed(1)} MB/s, peers ${client.torrents.reduce((a, t) => a + t.numPeers, 0)}\n`), 60000).unref();
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
};
main().catch((e) => { process.stderr.write(`[swarm] ${e.stack || e}\n`); process.exit(1); });

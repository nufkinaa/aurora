#!/usr/bin/env node
// A torrent played straight through for longer than half an hour, on a
// private instance, from a swarm that lives entirely on this machine:
//
//   node tools/stall-rig/torrent-rig.js --file "E:/aurora-stall-media/torrent/Rig Film (2020).mkv" --minutes 36
//
//   a tracker      bittorrent-tracker on 127.0.0.1 (no DHT, nothing leaves the PC)
//   a seeder       a WebTorrent client in this process, seeding --file
//   the instance   scripts/ui-test-server.js, its data seeded with the .torrent
//                  (the server reads a cached .torrent before it asks any peer)
//   the viewer     Chrome, a <video> on the instance's /stream/torrent/<hash>/0
//                  — one long Range request, as a TV or a browser plays a file
//
// Every freeze of the picture is written down with the server's log around it.
// Output: tools/stall-rig/.runs/<label>.json
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const ttff = require("../ttff/lib");

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : argv[i + 1]; };
const FILE = String(arg("file", "E:/aurora-stall-media/torrent/Rig Film (2020).mkv"));
const MINUTES = Number(arg("minutes", 36));
const LABEL = String(arg("label", `torrent-${Date.now().toString(36)}`));
const OUT_DIR = path.join(__dirname, ".runs");
fs.mkdirSync(OUT_DIR, { recursive: true });
const T0 = Date.now();
const stamp = (t = Date.now()) => `${((t - T0) / 1000).toFixed(1).padStart(7)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  const { default: Server } = await import("bittorrent-tracker/server");
  const { default: WebTorrent } = await import("webtorrent");
  // tracker
  const tracker = new Server({ udp: false, ws: false, http: true, stats: false });
  await new Promise((r) => tracker.listen(0, "127.0.0.1", r));
  const announce = `http://127.0.0.1:${tracker.http.address().port}/announce`;
  // seeder (a slow-ish line, like a real swarm: the viewer is fed about 3x the film's rate)
  const seeder = new WebTorrent({ dht: false, lsd: false, utp: false, uploadLimit: 900 * 1024 });
  const seeded = await new Promise((res) => seeder.seed(FILE, { announce: [announce], pieceLength: 512 * 1024 }, res));
  const infoHash = seeded.infoHash;
  console.log(`[torrent-rig] seeding ${path.basename(FILE)} ${infoHash} via ${announce}`);
  // the instance, with the .torrent where the server looks first
  // --tree <name>: the app from a frozen snapshot (node tools/ttff/snapshot.js <name> [<rev>]) — a "before"
  const TREE = (() => { const i = process.argv.indexOf("--tree"); return i < 0 ? null : process.argv[i + 1]; })();
  const server = require(TREE ? path.join(require("../ttff/snapshot").treeDir(TREE), "scripts", "ui-test-server.js") : "../../scripts/ui-test-server");
  if (TREE) console.log(`[rig] the app from snapshot ${TREE}`);
  const srv = await server.start({
    waitForLibrary: false,
    preload: [path.join(__dirname, "tracker-preload.js")],
    env: { RIG_TRACKER_PORT: String(tracker.http.address().port) },
    seed: { [`cache/torrents/${infoHash}.torrent`]: Buffer.from(seeded.torrentFile) },
  });
  const slog = [];
  let seen = 0;
  const poll = setInterval(() => {
    const all = srv.log();
    const fresh = all.length >= seen ? all.slice(seen) : all;
    seen = all.length;
    for (const line of fresh) {
      slog.push({ t: Date.now(), line });
      if (/\[torrent|error|evict|destroy/i.test(line)) console.log(`${stamp()} srv ${line.slice(0, 200)}`);
    }
  }, 300);
  // the viewer
  const browser = await ttff.launch({});
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const src = `${srv.url}/stream/torrent/${infoHash}/0`;
  await page.setContent(`<video id=v muted autoplay src="${src}" style="width:640px"></video>`);
  await page.evaluate(() => {
    const R = (window.__r = { stalls: [], events: [], played: 0, open: null, last: null });
    const v = document.getElementById("v");
    for (const ev of ["waiting", "stalled", "error", "playing", "emptied"]) v.addEventListener(ev, () => R.events.push({ t: Date.now(), ev, ct: v.currentTime, err: v.error && v.error.code }));
    setInterval(() => {
      const ct = v.currentTime;
      if (R.last != null) {
        const d = ct - R.last;
        if (d > 0 && d < 2) R.played += d;
        const frozen = R.played > 1 && !v.paused && !v.ended && Math.abs(d) < 0.01;
        if (frozen && !R.open) R.open = { start: Date.now(), ct, rs: v.readyState, ns: v.networkState };
        else if (!frozen && R.open) { R.open.ms = Date.now() - R.open.start; if (R.open.ms >= 700) R.stalls.push(R.open); R.open = null; }
      }
      R.last = ct;
    }, 250);
  });
  const until = Date.now() + MINUTES * 60000;
  while (Date.now() < until) {
    await sleep(60000);
    const st = await page.evaluate(() => { const v = document.getElementById("v"); const R = window.__r; return { ct: Math.round(v.currentTime), rs: v.readyState, err: v.error && v.error.code, stalls: R.stalls.length, open: R.open ? Date.now() - R.open.start : 0 }; });
    console.log(`${stamp()} ct ${st.ct} rs ${st.rs} stalls ${st.stalls}${st.open ? ` FROZEN ${st.open} ms` : ""}${st.err ? ` ERROR ${st.err}` : ""}`);
  }
  const R = await page.evaluate(() => { const R = window.__r; if (R.open) { R.open.ms = Date.now() - R.open.start; R.open.unfinished = true; R.stalls.push(R.open); } return R; });
  const out = { label: LABEL, minutes: MINUTES, played: Math.round(R.played), stalls: R.stalls.map((s) => ({ ...s, server: slog.filter((l) => l.t >= s.start - 20000 && l.t <= s.start + (s.ms || 0) + 2000).map((l) => `${Math.round(l.t - s.start)} ${l.line.slice(0, 200)}`) })), events: R.events, serverLog: slog.filter((l) => /\[torrent|evict|error/i.test(l.line)).map((l) => `${stamp(l.t)} ${l.line.slice(0, 200)}`) };
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.json`), JSON.stringify(out, null, 1));
  console.log(`\n== torrent straight play: ${out.played}s played, ${out.stalls.length} stalls, ${(out.stalls.reduce((n, s) => n + s.ms, 0) / 1000).toFixed(1)} s frozen`);
  for (const s of out.stalls) console.log(`   stall ${stamp(s.start)} ${s.ms} ms at ${s.ct.toFixed(1)}s${s.unfinished ? " (UNFINISHED)" : ""}`);
  clearInterval(poll);
  await browser.close();
  await srv.stop();
  seeder.destroy();
  tracker.close();
};
run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// A watch party on a VPS-sized private instance (tools/ttff/vps.js's
// instance): a host and three guests — a desktop, a browser WITHOUT HEVC (the
// server CPU-encodes for it: the ladder), an iPhone (native HLS) — on one
// film. Measured: how long each joins in, and for each of the host's jumps,
// how long until EVERYBODY is moving again at the new spot (the party waits
// for its slowest member: a slow CPU encode holds four people).
//
//   node tools/ttff/party.js --label base --tree base --cores8 --title about --jumps 4
//
// Output: tools/ttff/.runs/party-<label>.jsonl, a line per run.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ttff = require("./lib");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); if (i < 0) return d; const v = argv[i + 1]; return v == null || v.startsWith("--") ? true : v; };
const LABEL = String(arg("label", "party"));
const TREE = arg("tree", null);
const MEDIA = String(arg("media", "E:/aurora-stall-media"));
const TITLE = String(arg("title", "about"));
const JUMPS = Number(arg("jumps", 4));
const MASK = argv.includes("--cores8") ? 0x5555 : Number(arg("mask", 0)) || 0;
const OUT = path.join(__dirname, ".runs", `party-${LABEL}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const server = require(TREE ? path.join(require("./snapshot").treeDir(TREE), "scripts", "ui-test-server.js") : "../../scripts/ui-test-server");
  const preload = [];
  if (MASK) {
    const f = path.join(__dirname, ".runs", `party-affinity-${MASK}.js`);
    fs.writeFileSync(f, `"use strict";\ntry { require("child_process").spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + process.pid + ").ProcessorAffinity = ${MASK}"], { windowsHide: true, timeout: 20000 }); } catch (e) {}\n`);
    preload.push(f);
  }
  const srv = await server.start({ preload, waitForLibrary: false, config: { libraries: { movies: [path.join(MEDIA, "movies")], shows: [path.join(MEDIA, "shows")] }, hwEncode: "off" } });
  const admin = { "X-Admin-Password": srv.adminPassword };
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let j = null; try { j = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(j)}`);
    return j;
  };
  const browsers = [];
  try {
    let lib = null;
    for (const until = Date.now() + 600000; Date.now() < until; await sleep(1000)) {
      try { lib = await call("GET", "/api/library"); } catch { lib = null; }
      if (lib && lib.enriched && lib.movies.some((m) => m.title.toLowerCase().startsWith(TITLE) && m.duration > 0)) break;
    }
    const film = lib.movies.find((m) => m.title.toLowerCase().startsWith(TITLE));
    const mk = async (name) => {
      const { request } = await call("POST", "/api/profiles", { name, realName: name, avatar: "🦊", color: "#2c9fe0" });
      const p = await call("POST", `/api/admin/profile-requests/${request.id}/approve`, {}, admin);
      await call("PUT", `/api/profiles/${p.id}`, { lookNoticeSeen: true, prefs: { subsDefault: false } }).catch(() => {});
      return p;
    };
    const people = [
      { who: "host", flavour: "std" },
      { who: "desktop", flavour: "std" },
      { who: "no-HEVC (CPU encode)", flavour: "nohevc" },
      { who: "iPhone", flavour: "iphone" },
    ];
    const std = await ttff.launch({});
    const nohevc = await ttff.launch({ noHevc: true });
    browsers.push(std, nohevc);
    const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    for (const [i, m] of people.entries()) {
      const p = await mk(`P${i}${Date.now().toString(36).slice(-3)}`);
      const b = m.flavour === "nohevc" ? nohevc : std;
      m.ctx = await b.newContext({ viewport: m.flavour === "iphone" ? { width: 390, height: 844 } : { width: 1280, height: 720 }, ...(m.flavour === "iphone" ? { userAgent: UA, isMobile: true, hasTouch: true } : {}), serviceWorkers: "block" });
      await m.ctx.addInitScript(({ id }) => { try { if (sessionStorage.getItem("p-seeded")) return; sessionStorage.setItem("p-seeded", "1"); localStorage.setItem("aurora-profile", id); localStorage.setItem("aurora-kbd-hint", "1"); localStorage.setItem("aurora-nav-hinted", "1"); localStorage.setItem("aurora-player", JSON.stringify({ subsDefault: false })); } catch {} }, { id: p.id });
      m.page = await m.ctx.newPage();
      m.page.setDefaultTimeout(60000);
    }
    const host = people[0];
    const moving = (pg) => pg.waitForFunction(() => { const v = document.querySelector(".player video"); if (!v) return false; const a = v.currentTime; return new Promise((r) => setTimeout(() => r(!v.paused && v.currentTime > a + 0.2), 300)); }, null, { timeout: 120000, polling: 400 }).then(() => true, () => false);
    await host.page.goto(`${srv.url}/#/movies`);
    await host.page.evaluate((h) => { location.hash = h; }, `#/play/${film.id}`);
    await moving(host.page);
    await host.page.mouse.move(500, 250);
    await host.page.click('.player .pbtn[aria-label="Watch together"]').catch(async () => { await host.page.mouse.move(520, 260); await host.page.click('.player .pbtn[aria-label="Watch together"]'); });
    await host.page.click('.player [data-ui="player.party.start"]');
    await host.page.waitForSelector(".player .party-code");
    const code = (await host.page.textContent(".player .party-code")).replace(/\s/g, "");
    const row = { label: LABEL, tree: TREE || "working", title: film.title, mask: MASK, joins: {}, jumps: [] };
    // the guests join, all at once
    await Promise.all(people.slice(1).map(async (m) => {
      const t0 = Date.now();
      await m.page.goto(`${srv.url}/#/party/${code}`);
      const ok = await moving(m.page);
      row.joins[m.who] = ok ? Date.now() - t0 : null;
    }));
    console.log(`  joins: ${Object.entries(row.joins).map(([k, v]) => `${k} ${v} ms`).join(" · ")}`);
    await sleep(8000);
    // the host jumps: how long until everyone is moving at the new spot
    for (let j = 0; j < JUMPS; j++) {
      const box = await host.page.locator(".player .scrubber").boundingBox().catch(() => null);
      await host.page.mouse.move(500, 250);
      await sleep(400);
      const b2 = await host.page.locator(".player .scrubber").boundingBox().catch(() => box);
      const frac = 0.15 + (j * 0.17) % 0.7;
      const t0 = Date.now();
      if (b2) await host.page.mouse.click(b2.x + b2.width * frac, b2.y + b2.height / 2);
      await sleep(1500);
      const each = {};
      await Promise.all(people.map(async (m) => {
        const ok = await m.page.waitForFunction((want) => { const v = document.querySelector(".player video"); if (!v) return false; const a = v.currentTime; return new Promise((r) => setTimeout(() => r(!v.paused && v.currentTime > a + 0.2 && Math.abs(v.currentTime - want) < 60), 300)); }, frac * film.duration, { timeout: 120000, polling: 400 }).then(() => true, () => false);
        each[m.who] = ok ? Date.now() - t0 : null;
      }));
      const all = Object.values(each).some((x) => x == null) ? null : Math.max(...Object.values(each));
      row.jumps.push({ to: Math.round(frac * film.duration), each, all });
      console.log(`  jump ${j + 1} to ${Math.round(frac * film.duration)} s: everyone moving after ${all} ms (${Object.entries(each).map(([k, v]) => `${k} ${v}`).join(", ")})`);
      await sleep(15000);
    }
    // choppiness over the last minute: frames each one dropped
    row.dropped = {};
    for (const m of people) row.dropped[m.who] = await m.page.evaluate(() => { const v = document.querySelector(".player video"); const q = v && v.getVideoPlaybackQuality && v.getVideoPlaybackQuality(); return q ? `${q.droppedVideoFrames}/${q.totalVideoFrames}` : null; }).catch(() => null);
    fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
    console.log(`  dropped frames: ${JSON.stringify(row.dropped)}`);
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    await srv.stop();
  }
};
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

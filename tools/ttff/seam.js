#!/usr/bin/env node
// Where a CPU encode's fast first segment hands over to the ladder's own
// encoder (media/jit.js fastArgs → handOver): does the picture go on? A
// direct-play film on a VPS-sized private instance (tools/ttff/vps.js's
// media), for each spot: open the player, jump there, pick 480p in the
// player's menu (a step-down onto a CPU encode, the fast segment first),
// watch through the seam. Written down: the element's errors (code, message),
// hls.js's errors, hitches (a frame > 100 ms after the last), whether it
// was still moving at the end.
//
//   node tools/ttff/seam.js --tree after8 --cores8 --title arrival --at 3380,1200,2400,4600,5800
//
// Output: tools/ttff/.runs/seam-<label>.jsonl, a line per spot.
"use strict";
const fs = require("fs");
const path = require("path");
const ttff = require("./lib");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); if (i < 0) return d; const v = argv[i + 1]; return v == null || v.startsWith("--") ? true : v; };
const TREE = arg("tree", null);
const LABEL = String(arg("label", TREE || "working"));
const MEDIA = String(arg("media", "E:/aurora-stall-media"));
const TITLE = String(arg("title", "arrival"));
const AT = String(arg("at", "3380,1200,2400,4600,5800")).split(",").map(Number);
const PICK = String(arg("pick", "480p"));
const WATCH = Number(arg("watch", 35)) * 1000;
// --fill <s> --rate <x>: first play that much of the film at that speed (the browser holds it, as after half an hour of watching)
const FILL = Number(arg("fill", 0));
const RATE = Number(arg("rate", 4));
const MASK = argv.includes("--cores8") ? 0x5555 : Number(arg("mask", 0)) || 0;
const OUT = path.join(__dirname, ".runs", `seam-${LABEL}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const server = require(TREE ? path.join(require("./snapshot").treeDir(TREE), "scripts", "ui-test-server.js") : "../../scripts/ui-test-server");
  const preload = [];
  if (MASK) {
    const f = path.join(__dirname, ".runs", `seam-affinity-${MASK}.js`);
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
  const slog = [];
  const poll = setInterval(() => { for (const l of srv.drainLog ? srv.drainLog() : []) slog.push({ t: Date.now(), line: l }); }, 500);
  let browser = null;
  try {
    let lib = null;
    for (const until = Date.now() + 600000; Date.now() < until; await sleep(1000)) {
      try { lib = await call("GET", "/api/library"); } catch { lib = null; }
      if (lib && lib.enriched && lib.movies.some((m) => m.title.toLowerCase().startsWith(TITLE) && m.duration > 0)) break;
    }
    const film = lib.movies.find((m) => m.title.toLowerCase().startsWith(TITLE));
    const name = `S${Date.now().toString(36).slice(-4)}`;
    const username = name.toLowerCase();
    const password = `pass-${username}`;
    const { request } = await call("POST", "/api/profiles", { name, password, realName: `${name} Tester`, avatar: "🦊", color: "#2c9fe0" });
    const p = await call("POST", `/api/admin/profile-requests/${request.id}/approve`, {}, admin);
    const token = (await call("POST", `/api/profiles/${p.id}/unlock`, { password })).token;
    const th = token ? { "X-Profile-Token": token } : {};
    await call("PUT", `/api/profiles/${p.id}`, { lookNoticeSeen: true }, th).catch(() => {});
    await call("POST", "/api/auth/claim", { profileId: p.id, username, password }, th).catch(async () => call("POST", "/api/auth/claim", { profileId: p.id, username }, th));
    await call("POST", "/api/admin/auth-mode", { mode: "closed" }, admin);
    browser = await ttff.launch({});
    for (const at of AT) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
      const login = await ctx.request.post(`${srv.url}/api/auth/login`, { data: { username, password } });
      if (login.status() !== 200) throw new Error(`sign-in ${login.status()}`);
      await ctx.addInitScript(({ id }) => { try { localStorage.setItem("aurora-profile", id); localStorage.setItem("aurora-kbd-hint", "1"); localStorage.setItem("aurora-nav-hinted", "1"); localStorage.setItem("aurora-player", JSON.stringify({ subsDefault: false })); } catch {} }, { id: p.id });
      await ctx.addInitScript(ttff.PAGE_PROBE);
      await ctx.addInitScript(() => {
        window.__errs = [];
        document.addEventListener("error", (e) => { const v = e.target; if (v && v.tagName === "VIDEO") window.__errs.push({ t: performance.timeOrigin + performance.now(), ct: +v.currentTime.toFixed(2), code: v.error && v.error.code, msg: v.error && String(v.error.message || "").slice(0, 200) }); }, true);
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(60000);
      const row = { label: LABEL, tree: TREE || "working", title: film.title, at, pick: PICK };
      try {
        await page.goto(`${srv.url}/#/movies`);
        await page.evaluate((h) => { location.hash = h; }, `#/play/${film.id}`);
        await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 0.5; }, null, { timeout: 60000 });
        if (FILL) {
          await page.evaluate((r) => { document.querySelector(".player video").playbackRate = r; }, RATE);
          await page.waitForFunction((f) => { const v = document.querySelector(".player video"); return v && v.currentTime >= f; }, FILL, { timeout: (FILL / RATE) * 2000 + 120000, polling: 2000 });
          await page.evaluate(() => { document.querySelector(".player video").playbackRate = 1; });
          row.held = await page.evaluate(() => { const b = document.querySelector(".player video").buffered; let n = 0; for (let i = 0; i < b.length; i++) n += b.end(i) - b.start(i); return Math.round(n); });
        }
        // jump: a click on the timeline
        await page.mouse.move(500, 250);
        await sleep(400);
        const box = await page.locator(".player .scrubber").boundingBox();
        await page.mouse.click(box.x + box.width * (at / film.duration), box.y + box.height / 2);
        await page.waitForFunction((want) => { const v = document.querySelector(".player video"); return v && !v.paused && !v.seeking && Math.abs(v.currentTime - want) < 30; }, at, { timeout: 60000 });
        await sleep(3000);
        // the pick in the player's own menu
        const t0 = Date.now();
        await page.mouse.move(520, 260);
        await page.click('.player .pbtn[aria-label="Settings"]').catch(async () => { await page.mouse.move(500, 250); await page.click('.player .pbtn[aria-label="Settings"]'); });
        await page.locator(".player .menu .menu-item", { hasText: PICK }).first().click();
        await sleep(WATCH);
        const got = await page.evaluate((since) => {
          const v = document.querySelector(".player video");
          const vids = window.__ttff.dump(since - 2000);
          const vv = vids.sort((a, b) => b.events.length - a.events.length)[0];
          return {
            errs: window.__errs.filter((e) => e.t >= since - 2000).map((e) => ({ ...e, t: Math.round(e.t - since) })),
            hls: window.__ttff.hlsSince(since).filter((x) => x.what === "error" || x.what === "new").map((x) => ({ ...x, t: Math.round(x.t - since) })),
            gaps: vv ? (vv.gaps || []).filter((g) => g.t >= since + 3000).map((g) => ({ t: Math.round(g.t - since), ms: g.ms, mt: g.mt })) : [],
            ct: v ? +v.currentTime.toFixed(1) : null, paused: v ? v.paused : null, h: v ? v.videoHeight : null,
            card: !!document.querySelector(".player .player-error"),
          };
        }, t0);
        Object.assign(row, got);
        // still moving at the end?
        row.moving = await page.evaluate(() => new Promise((r) => { const v = document.querySelector(".player video"); if (!v) return r(false); const a = v.currentTime; setTimeout(() => r(!v.paused && v.currentTime > a + 0.5), 1500); }));
      } catch (e) {
        row.failed = e.message.split("\n")[0];
      }
      fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
      console.log(`  ${LABEL} at ${at}${row.held != null ? ` (held ${row.held} s)` : ""}: ${row.failed ? `FAILED ${row.failed}` : `${row.moving ? "moving" : "NOT MOVING"} at ${row.ct} (${row.h}p${row.card ? ", error card" : ""}) · element errors ${row.errs.length}${row.errs.length ? ` ${JSON.stringify(row.errs)}` : ""} · hls errors ${row.hls.filter((x) => x.what === "error").length}${row.hls.some((x) => x.what === "error") ? ` ${row.hls.filter((x) => x.what === "error").map((x) => `${x.details}${x.fatal ? "!" : ""}@${x.t}${x.msg ? `(${x.msg.slice(0, 80)})` : ""}`).join(" ")}` : ""} · hitches ${row.gaps.map((g) => `${g.ms}ms@${g.mt}`).join(" ")}`}`);
      await ctx.close().catch(() => {});
    }
  } finally {
    clearInterval(poll);
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
  }
};
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

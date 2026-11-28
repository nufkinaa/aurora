#!/usr/bin/env node
// A far seek on a jit stream, through a throttled line, with every segment
// hls.js asks for printed (sn, level, start): the repro of the "backtrack"
// found in streaming round 2 (docs/qa/streaming-round-2/web.md §3, "found, not
// fixed") — with progressive loading on and a line slower than a LAN, the
// seek's segment is followed by the WHOLE previous one, then by itself again.
//
//   node tools/stream-net-rig/seek-backtrack.js [--title "Rig Jit"] [--frac 0.5] [--down 8000]
//        [--progressive 1|0] [--worker 1|0] [--media E:/aurora-agents/research-stream-efficiency/media]
//
// --progressive 0: the player's own switch (localStorage aurora-hls-progressive=0) — no backtrack,
// the first frame of every start waits for its whole first segment instead.
// --worker 0: hls.js transmuxes on the main thread (enableWorker: false).
"use strict";
const path = require("path");
const server = require("../../scripts/ui-test-server");
const throttle = require("../throttle-proxy");
const { chromium } = require("playwright-core");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TITLE = arg("title", "Rig Jit");
const FRAC = Number(arg("frac", 0.5));
const DOWN = Number(arg("down", 8000));
const PROGRESSIVE = arg("progressive", "1") !== "0";
const WORKER = arg("worker", "1") !== "0";
const MEDIA = String(arg("media", "E:/aurora-agents/research-stream-efficiency/media"));

(async () => {
  const srv = await server.start({ config: { libraries: { movies: [path.join(MEDIA, "movies")], shows: [path.join(MEDIA, "shows")] }, hwEncode: "off" } });
  const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  let pr = null;
  try {
    const call = async (m, u, body, h = {}) => { const r = await fetch(srv.url + u, { method: m, headers: { "Content-Type": "application/json", ...h }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => null); };
    const pw = "pass-seekbt";
    const r0 = await call("POST", "/api/profiles", { name: "Seekbt", password: pw, realName: "Seek Tester", avatar: "🦊", color: "#2c9fe0" });
    const p = await call("POST", `/api/admin/profile-requests/${r0.request.id}/approve`, {}, { "X-Admin-Password": srv.adminPassword });
    const tok = (await call("POST", `/api/profiles/${p.id}/unlock`, { password: pw })).token;
    const th = tok ? { "X-Profile-Token": tok } : {};
    await call("PUT", `/api/profiles/${p.id}`, { lookNoticeSeen: true }, th);
    await call("POST", `/api/profiles/${p.id}/password`, { newPassword: "", currentPassword: pw }, th);
    const lib = await call("GET", "/api/library");
    const m = lib.movies.find((x) => x.title === TITLE);
    if (!m) throw new Error(`no "${TITLE}" in ${MEDIA}`);
    pr = await throttle.start({ listen: 0, host: "127.0.0.1", to: srv.port, quiet: true, handshake: true, slowstart: true, down: DOWN, up: 2000, latency: 35 });
    const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    const t0 = Date.now();
    page.on("console", (c) => { if (/^SB /.test(c.text())) console.log(`${String(Date.now() - t0).padStart(6)} ms  ${c.text().slice(3)}`); });
    await page.addInitScript(({ id, progressive, worker, kbps }) => {
      localStorage.setItem("aurora-profile", id);
      localStorage.setItem("aurora-kbd-hint", "1");
      localStorage.setItem("aurora-nav-hinted", "1");
      localStorage.setItem("aurora-line-kbps", JSON.stringify({ kbps, at: Date.now() }));
      if (!progressive) localStorage.setItem("aurora-hls-progressive", "0");
      let W;
      Object.defineProperty(window, "Hls", { configurable: true, get: () => W, set: (H) => {
        W = H && class extends H {
          constructor(c) {
            super(worker ? c : { ...c, enableWorker: false });
            window.__sb = this;
            this.on(H.Events.FRAG_LOADING, (_e, d) => console.log(`SB load sn ${d.frag.sn} level ${d.frag.level} start ${d.frag.start.toFixed(3)}`));
          }
        };
      } });
      const set = HTMLMediaElement.prototype.__lookupSetter__("currentTime");
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { set(v) { console.log(`SB currentTime = ${Number(v).toFixed(3)}`); set.call(this, v); }, get: HTMLMediaElement.prototype.__lookupGetter__("currentTime") });
    }, { id: p.id, progressive: PROGRESSIVE, worker: WORKER, kbps: Math.round(DOWN * 0.9) });
    await page.goto(`http://127.0.0.1:${pr.port}/#/play/${m.id}`);
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 3; }, null, { timeout: 60000 });
    await page.mouse.move(600, 380); await page.waitForTimeout(150); await page.mouse.move(640, 400); await page.waitForTimeout(300);
    const box = await page.locator(".player .scrubber").boundingBox();
    console.log(`--- click at ${FRAC} (progressive ${PROGRESSIVE ? "on" : "off"}, worker ${WORKER ? "on" : "off"}, ${DOWN} kbit/s)`);
    await page.mouse.click(box.x + FRAC * box.width, box.y + box.height / 2);
    await page.waitForTimeout(10000);
  } finally {
    await b.close();
    if (pr) await pr.close();
    await srv.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });

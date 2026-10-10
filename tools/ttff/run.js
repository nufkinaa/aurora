#!/usr/bin/env node
// Time to first frame, measured: the website on a private instance of THIS
// working tree, through a shaped line, in the Chrome on this machine.
//
//   node tools/ttff/run.js --label baseline
//   node tools/ttff/run.js --label try1 --conditions HL-LB,LL-LB --titles mkv-ac3 --modes cold,warm --runs 3
//
//   --label        names the result file: tools/ttff/.runs/<label>.jsonl (appended to)
//   --conditions   lines to test (lib.js CONDITIONS; default: the four corners)
//   --titles       which test files (media.js keys; default: a representative set)
//   --modes        cold,warm,resume,next,autonext (default cold,warm,resume)
//   --runs         how many times each (default 5)
//   --watch        seconds watched after the first frame on a thin line (default 30; 8 on a fast one)
//   --watch-all    watch that long on a fast line too (to see a climb from a lighter start)
//   --hover        ms the pointer rests on Play before the click (default 0)
//   --tree <name>  the app from a snapshot (node tools/ttff/snapshot.js <name> [<rev>]) —
//                  for a "before" that later edits cannot disturb
//   --front h2     put the TLS + HTTP/2 front (h2-front.js) between line and instance
//   --no-hevc      the browser cannot decode HEVC (the server then encodes H.264 for it)
//   --first-visit  the browser has never seen the site (nothing in its HTTP cache)
//   --set k=v      localStorage keys set before the app starts (e.g. aurora-data-mode=saver)
//   --line <x>     what the device remembers of its line before each play (the
//                  player keeps what its line carried last time and starts by it):
//                    forget   nothing — every play is this device's first
//                    known    the line's real rate (a device that has played here before)
//                    <kbps>   that figure
//                  (default: whatever the plays before it left — as a real session goes)
//   --headed       watch it
//   --verbose      the instance's log
//
// One instance and one browser profile per (line × run): every title's first
// play in it is COLD — the server has never been asked for that file (no
// segment table, no probe, no segments) and the page was just loaded (hls.js
// not in memory; in the HTTP cache unless --first-visit). WARM is the same
// title again; RESUME starts 40% in. See README.md for what each number is.
"use strict";
const fs = require("fs");
const path = require("path");
const { CONDITIONS, rttOf, sleep, startInstance, launch, PAGE_PROBE, netlog, digest, throttle } = require("./lib");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] != null && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const list = (name, def) => String(arg(name, def)).split(",").map((s) => s.trim()).filter(Boolean);

const LABEL = arg("label", "run");
const CONDS = list("conditions", "LL-HB,HL-HB,HL-LB,LL-LB");
const TITLES = list("titles", "mp4-fast,mp4-tail,mkv-aac,mkv-ac3,mkv-ac3-8m-g5,mkv-hevc10,ep1");
const MODES = list("modes", "cold,warm,resume");
// Two passes, each on its own fresh instance: a resume is only cold on a
// server that has not just played the same file from the top (its copy
// producer runs on to the end of the film and leaves every segment on disk).
const PASSES = [MODES.filter((m) => m !== "resume"), MODES.filter((m) => m === "resume")].filter((p) => p.length);
const RUNS = Number(arg("runs", 5));
const WATCH = Number(arg("watch", 30));
const HOVER = Number(arg("hover", 0));
const FRONT = arg("front", "");
const TREE = arg("tree", ""); // the app from a snapshot (snapshot.js) instead of the working tree
const FIRST_VISIT = flag("first-visit");
const LINE = arg("line", "");
const NO_HEVC = flag("no-hevc"); // a browser that cannot decode HEVC (as Firefox, or Chrome without the hardware)
const SETS = process.argv.map((a, i) => (a === "--set" ? process.argv[i + 1] : null)).filter(Boolean).map((kv) => kv.split("="));
const OUT_DIR = path.join(__dirname, ".runs");
const OUT = path.join(OUT_DIR, `${LABEL}.jsonl`);

const PRIMARY = ".detail-actions > .btn-primary";
const NEXT_BTN = '.player .pbtn[aria-label="Next episode"]';

const gotoHash = async (page, origin, hash, selector = "#app .screen", timeout = 60000) => {
  if (!page.url().startsWith(origin)) await page.goto(`${origin}/${hash}`, { waitUntil: "domcontentloaded", timeout });
  else await page.evaluate((h) => { if (location.hash === h) window.dispatchEvent(new HashChangeEvent("hashchange")); else location.hash = h; }, hash);
  await page.waitForFunction((sel) => {
    const app = document.getElementById("app");
    return !!app && !!app.querySelector(sel) && !app.querySelector(".route-skel");
  }, selector, { timeout });
};

// Nothing in flight for `quiet` ms (the screen has finished asking for things).
const idle = async (net, quiet = 700, max = 25000) => {
  const t0 = Date.now();
  let since = Date.now();
  while (Date.now() - t0 < max) {
    const busy = net.all().some((r) => r.end == null && !/\/ws(\?|$)/.test(r.path) && Date.now() - r.start < 20000);
    if (busy) since = Date.now();
    else if (Date.now() - since >= quiet) return;
    await sleep(50);
  }
};

const pageNow = (page) => page.evaluate(() => performance.timeOrigin + performance.now());

// How busy this machine was while a play was measured (all cores, 0–100):
// other work on the box makes the server's part of a start look slower than
// it is, and a row measured on a saturated machine says so.
const os = require("os");
const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { idle: 0, all: 0 });
const cpuBusy = (a, b) => (b.all > a.all ? Math.round(100 * (1 - (b.idle - a.idle) / (b.all - a.all))) : null);

// Wait until a video created after `since` is really playing (or give up).
const waitPlaying = (page, since, timeout) =>
  page.waitForFunction((since) => {
    const T = window.__ttff;
    return T.videos.some((r) => {
      if (r.created < since - 5) return false;
      const s = r.samples;
      const n = s.length;
      return n > 6 && s[n - 1].ct - s[n - 6].ct >= 0.3 && !s[n - 1].p;
    });
  }, since, { timeout, polling: 100 }).then(() => true, () => false);

const collect = async (page, net, since, { t0Kind = "click", watchMs, expectFrom = 0 }) => {
  const dump = await page.evaluate((since) => ({ clicks: window.__ttff.clicks.filter((c) => c.t >= since - 5), nav: window.__ttff.nav.filter((n) => n.t >= since - 5), videos: window.__ttff.dump(since), hls: window.__ttff.hlsSince(since) }), since);
  let t0 = null;
  if (t0Kind === "nav") t0 = (dump.nav.find((n) => /#\/play\//.test(n.hash)) || {}).t;
  else t0 = (dump.clicks.filter((c) => c.type === "click").pop() || {}).t;
  if (t0 == null) return { ok: false, why: `no ${t0Kind} was seen` };
  const row = digest({ t0, videos: dump.videos.filter((v) => v.created >= t0 - 5), requests: net.all(), watchMs, expectFrom });
  // what hls.js said while it played: errors, level moves, loads given up
  const h = dump.hls.filter((x) => x.t >= t0 - 5);
  row.hls = h.map((x) => `${x.what}${x.details ? `:${x.details}` : ""}${x.fatal ? "!" : ""}${x.code ? `(${x.code})` : ""}${x.uri ? `:${x.uri}` : ""}${x.what === "gave-up" ? `:sn${x.sn}` : ""}@${Math.round(x.t - t0)}`);
  row.hlsErrors = h.filter((x) => x.what === "error").length;
  row.hlsFatal = h.filter((x) => x.what === "error" && x.fatal).length;
  row.rebuilds = Math.max(0, h.filter((x) => x.what === "new").length - 1);
  return row;
};

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launch({ headed: flag("headed"), noHevc: NO_HEVC });
  const meta = { label: LABEL, at: new Date().toISOString(), tree: TREE || "working tree", front: FRONT || "http/1.1", firstVisit: FIRST_VISIT, line: LINE || "as left", noHevc: NO_HEVC, hover: HOVER, sets: SETS, chrome: browser.version() };
  console.log(`ttff ${LABEL}: ${CONDS.join(", ")} × ${TITLES.join(", ")} × ${MODES.join(", ")} × ${RUNS} runs  (${meta.front}, Chrome ${meta.chrome})`);
  const write = (row) => fs.appendFileSync(OUT, JSON.stringify({ ...meta, ...row }) + "\n");

  for (const condName of CONDS) {
    const cond = CONDITIONS[condName];
    if (!cond) throw new Error(`unknown line "${condName}" — one of ${Object.keys(CONDITIONS).join(", ")}`);
    const thin = cond.down <= 5000 || cond.pktloss;
    const watchMs = (thin || flag("watch-all") ? WATCH : Math.min(WATCH, 8)) * 1000;
    for (let run = 1; run <= RUNS; run++) for (const PASS of PASSES) {
      const inst = await startInstance({ verbose: flag("verbose"), tree: TREE || null });
      let front = null;
      let proxy = null;
      let context = null;
      try {
        if (FRONT === "h2") front = await require("./h2-front").start({ to: inst.srv.port });
        proxy = await throttle.start({ listen: 0, host: "127.0.0.1", to: front ? front.port : inst.srv.port, quiet: true, handshake: true, slowstart: true, ...cond });
        const origin = `${front ? "https" : "http"}://127.0.0.1:${proxy.port}`;
        context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block", ignoreHTTPSErrors: true });
        const page = await context.newPage();
        page.setDefaultTimeout(60000);
        const profile = await inst.api.createProfile(`T${Date.now().toString(36).slice(-6)}`);
        await page.addInitScript(({ id, sets }) => {
          try {
            if (!sessionStorage.getItem("ttff-seeded")) {
              sessionStorage.setItem("ttff-seeded", "1");
              localStorage.setItem("aurora-profile", id);
              localStorage.setItem("aurora-kbd-hint", "1");
              localStorage.setItem("aurora-nav-hinted", "1");
              for (const [k, v] of sets) localStorage.setItem(k, v);
            }
          } catch {}
        }, { id: profile.id, sets: SETS });
        await page.addInitScript(PAGE_PROBE);
        const net = await netlog(context, page);
        await gotoHash(page, origin, "#/");
        await idle(net);
        // a returning visitor: the player's code and hls.js are in the HTTP cache
        if (!FIRST_VISIT) {
          await page.evaluate(() => Promise.all(["/js/vendor/hls.min.js", "/js/screens/player.js"].map((u) => fetch(u).then((r) => r.arrayBuffer()).catch(() => null))));
        }

        const play = async (title, mode, opts) => {
          const row = { cond: condName, rtt: rttOf(cond), down: cond.down, run, title: title.key, mode };
          const cpu0 = cpuTimes();
          try {
            const r = await opts();
            Object.assign(row, r);
            row.cpuBusy = cpuBusy(cpu0, cpuTimes());
          } catch (e) {
            Object.assign(row, { ok: false, why: String(e.message).split("\n")[0] });
          }
          write(row);
          const kb = (n) => (n == null ? "-" : `${Math.round(n / 1024)}K`);
          console.log(`  ${condName.padEnd(6)} #${run} ${title.key.padEnd(15)} ${mode.padEnd(8)} ${row.ok ? `ttff ${String(row.ttff).padStart(6)} ms  play ${String(row.ttplay).padStart(6)}  path ${String(row.path).padEnd(7)} lvl ${String(row.firstLevel || "-").padEnd(8)} rt ${row.roundTrips} srv ${row.serverMs}ms  bytes ${kb(row.mediaBytesBeforeFF)}  rebuf ${row.rebufferMs}ms/${row.rebuffers}${row.hlsErrors ? `  hls errors ${row.hlsErrors}${row.hlsFatal ? ` (${row.hlsFatal} fatal)` : ""}` : ""}${row.rebuilds ? `  rebuilt x${row.rebuilds}` : ""}${row.cpuBusy >= 85 ? `  (machine ${row.cpuBusy}% busy)` : ""}` : `FAILED: ${row.why}`}`);
          return row;
        };

        // From the title's page: press the main button, time it, watch a while.
        const fromPage = async (title, { expectFrom = 0 } = {}) => {
          const hash = title.showId ? `#/show/${title.showId}` : `#/movie/${title.id}`;
          await gotoHash(page, origin, "#/");
          await gotoHash(page, origin, hash, PRIMARY);
          await idle(net);
          if (LINE) {
            const kbps = LINE === "forget" ? 0 : LINE === "known" ? Math.round(cond.down * 0.95) : Number(LINE) || 0;
            await page.evaluate((k) => {
              if (k > 0) localStorage.setItem("aurora-line-kbps", JSON.stringify({ kbps: k, at: Date.now() }));
              else localStorage.removeItem("aurora-line-kbps");
            }, kbps);
          }
          net.reset();
          const since = await pageNow(page);
          if (HOVER > 0) { await page.hover(PRIMARY); await sleep(HOVER); }
          await page.click(PRIMARY);
          const started = await waitPlaying(page, since, 120000);
          await sleep(started ? watchMs : 1000);
          return collect(page, net, since, { watchMs, expectFrom });
        };
        const leave = async () => {
          await gotoHash(page, origin, "#/");
          await page.waitForFunction(() => !document.querySelector(".player"), null, { timeout: 15000 }).catch(() => {});
          await sleep(300);
        };

        for (const key of TITLES) {
          const title = inst.titles[key];
          if (!title) { console.log(`  (no title "${key}" in the library)`); continue; }
          for (const mode of PASS) {
            if (mode === "cold") {
              // a page just loaded: nothing of the player in memory
              await page.reload({ waitUntil: "domcontentloaded" });
              await gotoHash(page, origin, "#/");
              await idle(net);
              await sleep(thin ? 6500 : 2500); // the line is measured by the page itself (net.js) in its first seconds
              await play(title, mode, () => fromPage(title));
              // (an episode stays in its player when the next mode presses Next episode from it)
              if (!(title.showId && PASS.includes("next"))) await leave();
            } else if (mode === "warm") {
              await leave();
              await inst.api.clearProgress(profile, title.id).catch(() => {});
              await play(title, mode, () => fromPage(title));
              await leave();
            } else if (mode === "resume") {
              // 40% in, on a server that has not been asked for this file and a page just loaded
              const at = Math.round(title.duration * 0.4);
              await inst.api.setProgress(profile, title.id, at, title.duration);
              await page.reload({ waitUntil: "domcontentloaded" });
              await gotoHash(page, origin, "#/");
              await idle(net);
              await sleep(thin ? 6500 : 2500);
              await play(title, mode, () => fromPage(title, { expectFrom: at - 4 }));
              await leave();
              await inst.api.clearProgress(profile, title.id).catch(() => {});
            } else if (mode === "next" && title.showId) {
              // in the player of this episode: press Next episode
              if (!(await page.$(".player video"))) await fromPage(title);
              await play(title, mode, async () => {
                await page.mouse.move(500 + Math.random() * 40, 250);
                await page.waitForSelector(`${NEXT_BTN}:not(.hidden)`, { timeout: 20000 });
                await idle(net, 400, 8000);
                net.reset();
                const since = await pageNow(page);
                await page.mouse.move(520, 260);
                await page.click(NEXT_BTN);
                const started = await waitPlaying(page, since, 120000);
                await sleep(started ? Math.min(watchMs, 8000) : 1000);
                return collect(page, net, since, { watchMs });
              });
              await leave();
              for (const t of Object.values(inst.titles)) if (t.showId === title.showId) await inst.api.clearProgress(profile, t.id).catch(() => {});
            } else if (mode === "autonext" && title.showId) {
              // let the episode run out: Up next counts down and starts the next one
              await leave();
              await fromPage(title);
              await play(title, mode, async () => {
                net.reset();
                const since = await pageNow(page);
                await page.evaluate(() => { const v = document.querySelector(".player video"); v.currentTime = Math.max(0, v.duration - 24); });
                const moved = await page.waitForFunction((since) => window.__ttff.nav.some((n) => n.t >= since && /#\/play\//.test(n.hash)), since, { timeout: 60000 }).then(() => true, () => false);
                if (!moved) return { ok: false, why: "the next episode never started by itself" };
                const started = await waitPlaying(page, (await page.evaluate((since) => window.__ttff.nav.filter((n) => n.t >= since).pop().t, since)), 120000);
                await sleep(started ? Math.min(watchMs, 8000) : 1000);
                return collect(page, net, since, { t0Kind: "nav", watchMs });
              });
              await leave();
              for (const t of Object.values(inst.titles)) if (t.showId === title.showId) await inst.api.clearProgress(profile, t.id).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.log(`  ${condName} #${run}: ${String(e.stack || e).split("\n").slice(0, 3).join(" | ")}`);
        write({ cond: condName, run, title: "*", mode: "*", ok: false, why: String(e.message).split("\n")[0] });
      } finally {
        try { if (context) await context.close(); } catch {}
        try { if (proxy) await proxy.close(); } catch {}
        try { if (front) await front.close(); } catch {}
        await inst.srv.stop();
      }
    }
  }
  await browser.close();
  console.log(`\nresults: ${OUT}\ntables:  node tools/ttff/report.js ${LABEL}`);
};

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// The subtitle timing rig: how far off is a subtitle, path by path?
//
//   node tools/subs-rig/run.js            every scenario, a table at the end
//   node tools/subs-rig/run.js jit late   only scenarios whose name has one of the words
//   HEADED=1 node tools/subs-rig/run.js   watch it
//
// It boots a private instance (scripts/ui-test-server.js — never the live
// server), adds the rig's films (media.js: every frame carries its own time,
// every cue says which frame it belongs to), plays each in the installed
// Chrome through a real path of the website player — the file itself, the
// repackaged stream (jit / hls.js), the offset copy job a seek or a resume
// takes when jit is refused, the h264 encode — and measures, from the frames
// actually presented, when each cue is scheduled against when it belongs.
// Nothing leaves the machine. Results: docs/qa/subtitles/REPORT.md.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..", "..");
const server = require(path.join(REPO, "scripts", "ui-test-server.js"));
const { makeApi, launchBrowser, signIn, player } = require(path.join(REPO, "test", "ui", "helpers.js"));
const media = require("./media");
const { measure } = require("./sampler");

const CACHE = path.join(REPO, "test", "ui", ".cache", "subs-rig");

const findFfmpeg = () => {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const { execFileSync } = require("child_process");
  const win = process.platform === "win32";
  return execFileSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { encoding: "utf-8" }).split(/\r?\n/)[0].trim();
};

// Boot an instance with the rig's films in its library. -> srv (+ srv.rig: key -> item)
const boot = async (opts = {}) => {
  const dir = media.build(CACHE, findFfmpeg());
  const srv = await server.start(opts);
  srv.api = makeApi(srv);
  fs.cpSync(path.join(dir, "movies"), srv.library.movies, { recursive: true });
  await srv.api.rescan();
  const deadline = Date.now() + 60000;
  for (;;) {
    const lib = await srv.api.library();
    const ours = Object.entries(media.TITLES).map(([k, t]) => [k, lib.movies.find((m) => m.title === t.title)]);
    if (lib.enriched && ours.every(([, m]) => m && m.duration > 0)) {
      srv.rig = {};
      for (const [k, m] of ours) srv.rig[k] = await srv.api.item(m.id);
      // the MKVs' embedded track only appears once the probe has landed
      if (srv.rig.jit.subtitles.some((s) => s.embedded) && srv.rig.late.subtitles.some((s) => s.embedded)) return srv;
    }
    if (Date.now() > deadline) throw new Error("the rig's films never finished probing");
    await new Promise((r) => setTimeout(r, 300));
  }
};

// Which track of an item: "sidecar" or "embedded"
const trackOf = (item, kind) => (item.subtitles || []).find((s) => (kind === "embedded" ? s.embedded : !s.embedded));

// Pick a subtitle track through the menu, by its exact label.
const pickTrack = async (page, label) => {
  await player.menu(page, "Subtitles");
  await page.evaluate((label) => {
    const b = [...document.querySelectorAll(".player .menu .menu-item")].find((x) => (x.childNodes[0].textContent || "").trim() === label);
    if (!b) throw new Error(`no menu item "${label}"`);
    b.click();
  }, label);
  await page.waitForFunction((label) => {
    const t = [...document.querySelector(".player video").textTracks].find((x) => x.label === label);
    return t && t.mode === "showing" && t.cues && t.cues.length > 5;
  }, label, { timeout: 15000 });
};

const nudge = async (page, ariaLabel, times = 1) => {
  await player.menu(page, "Subtitles");
  for (let i = 0; i < times; i++) await page.click(`.player .menu [aria-label="${ariaLabel}"]`);
  await page.keyboard.press("Escape");
};

// Every scenario: { name, title, kind, block (refuse jit), resume (s), seek (fraction), nudge }
const SCENARIOS = [
  { name: "direct mp4 · sidecar", title: "direct", kind: "sidecar" },
  { name: "direct mp4 · sidecar · resume 50s", title: "direct", kind: "sidecar", resume: 50 },
  { name: "jit · embedded", title: "jit", kind: "embedded" },
  { name: "jit · sidecar", title: "jit", kind: "sidecar" },
  { name: "jit · embedded · far seek", title: "jit", kind: "embedded", seek: 0.7 },
  { name: "jit · sidecar · resume 50s", title: "jit", kind: "sidecar", resume: 50 },
  { name: "late start 1.5s · jit · embedded", title: "late", kind: "embedded" },
  { name: "late start 1.5s · jit · sidecar", title: "late", kind: "sidecar" },
  { name: "offset copy (jit refused) · embedded · resume 47s", title: "jit", kind: "embedded", block: true, resume: 47 },
  { name: "offset copy (jit refused) · sidecar · resume 47s", title: "jit", kind: "sidecar", block: true, resume: 47 },
  { name: "offset copy (jit refused) · late start · embedded · resume 47s", title: "late", kind: "embedded", block: true, resume: 47 },
  { name: "offset copy (jit refused) · late start · sidecar · resume 47s", title: "late", kind: "sidecar", block: true, resume: 47 },
  { name: "offset copy (jit refused) · sidecar · far seek", title: "jit", kind: "sidecar", block: true, seek: 0.7 },
  { name: "h264 encode (data saver, jit refused) · sidecar · resume 47s", title: "jit", kind: "sidecar", block: true, saver: true, resume: 47 },
  { name: "nudge +2.0s · direct · sidecar", title: "direct", kind: "sidecar", nudge: { label: "Subtitles later", times: 4 }, expect: 2 },
  { name: "nudge −1.0s · jit · embedded", title: "jit", kind: "embedded", nudge: { label: "Subtitles earlier", times: 2 }, expect: -1 },
];

const runScenario = async (browser, srv, sc) => {
  const item = srv.rig[sc.title];
  const track = trackOf(item, sc.kind);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
  const marks = [];
  try {
    await context.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (r) => r.fulfill({ status: 404, body: "" }).catch(() => {}));
    if (sc.block) await context.route(/\/stream\/transcode\/[^/]+\/jit\//, (r) => r.fulfill({ status: 500, body: "refused by the rig" }).catch(() => {}));
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on("request", (req) => {
      if (/\/api\/play-mark\//.test(req.url())) { try { marks.push(JSON.parse(req.postData() || "null")); } catch {} }
    });
    const me = await srv.api.createProfile(`R${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, { open: true });
    if (sc.resume) await srv.api.setProgress(me, item.id, sc.resume, item.duration);
    if (sc.saver) await page.addInitScript(() => { try { localStorage.setItem("aurora-data-mode", "saver"); } catch {} });
    await signIn(page, srv, me);
    await player.open(page, srv, item.id, { min: 0.2 });
    await pickTrack(page, track.label);
    if (sc.seek) {
      await player.scrubTo(page, sc.seek);
      await player.waitClock(page, media.SECONDS * sc.seek - 4, media.SECONDS * sc.seek + 5, 30000);
      await player.playing(page, { min: 0 });
    }
    if (sc.nudge) await nudge(page, sc.nudge.label, sc.nudge.times);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1200);
    const r = await page.evaluate(measure, { label: track.label, frames: 30 });
    const path_ = (marks.filter((m) => m && m.name === "path").pop() || {}).path || "?";
    const ff = marks.filter((m) => m && m.name === "first-frame").pop() || {};
    return { ...r, path: path_, v: ff.v || null, label: track.label };
  } finally {
    await context.close().catch(() => {});
  }
};

const main = async () => {
  const words = process.argv.slice(2).map((w) => w.toLowerCase());
  const list = SCENARIOS.filter((s) => !words.length || words.some((w) => s.name.toLowerCase().includes(w)));
  const srv = await boot();
  const browser = await launchBrowser();
  const rows = [];
  try {
    for (const sc of list) {
      let r;
      try { r = await runScenario(browser, srv, sc); } catch (e) { r = { error: String(e.message).split("\n")[0] }; }
      const want = sc.expect || 0;
      const ok = r.error ? "ERR" : Math.abs(r.err - want) <= 0.15 ? "ok" : "OFF";
      rows.push({ sc, r, ok });
      console.log(`${ok.padEnd(3)} ${sc.name.padEnd(62)} ${r.error ? r.error : `err ${r.err >= 0 ? "+" : ""}${r.err.toFixed(2)}s (min ${r.errMin.toFixed(2)} max ${r.errMax.toFixed(2)}, file ${r.file >= 0 ? "+" : ""}${r.file.toFixed(2)}, n ${r.n}, at ${r.at}s, path ${r.path}${r.v ? "/" + r.v : ""})`}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await srv.stop();
  }
  const bad = rows.filter((x) => x.ok !== "ok").length;
  console.log(`\n${rows.length - bad}/${rows.length} within ±0.15 s of where they belong`);
  process.exitCode = bad ? 1 : 0;
};

module.exports = { boot, trackOf, pickTrack, nudge, SCENARIOS, runScenario, measure, CACHE };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

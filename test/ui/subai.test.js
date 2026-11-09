// Hebrew subtitles for anything (2026-11-09): a title with no Hebrew gets one
// translated with AI (src/media/subai.js), named "עברית (AI)" in the menu,
// and switched on for the viewer who wanted Hebrew — in real Chrome, on a
// private server whose "model" is the test aid AURORA_AI_MOCK (made-up Hebrew
// words in place of each word, never the network; never set in production).
//
//   desktop  a Hebrew viewer opens a film with English only: told it is being
//            translated, then "עברית (AI)" arrives in the menu WHILE the film
//            plays and switches on by itself, its cues on the English timing
//   phone    the next Hebrew viewer gets it at the start; the name fits the menu
//   English  a viewer whose subtitles are English causes no translation
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const assert = require("node:assert/strict");
const { suite, player, DESKTOP, PHONE } = require("./helpers");

const ffmpegPath = () => {
  const win = process.platform === "win32";
  const r = spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { encoding: "utf-8" });
  return process.env.FFMPEG_PATH || (r.stdout || "").split(/\r?\n/)[0].trim();
};

const FILMS = { he: "Quiet Harbour (2037)", en: "Loud Valley (2038)" };
const DUR = 120;
const LINES = Array.from({ length: 40 }, (_, i) => ({ start: 2 + i * 2.7, end: 2 + i * 2.7 + 2.1 }));
const ts = (v) => {
  const ms = Math.round(v * 1000);
  return `00:${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
const english = LINES.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${i % 5 === 2 ? "- Who's there?\n- Only me." : `This is what line ${i} says out loud.`}\n`).join("\n");

const build = (dir, ffmpeg, title) => {
  const d = path.join(dir, title);
  const file = path.join(d, `${title}.mp4`);
  if (fs.existsSync(file)) return d;
  fs.mkdirSync(d, { recursive: true });
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=0x302040:size=320x180:rate=10:duration=${DUR}`,
    "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=16000:duration=${DUR}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "20", "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", file], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  fs.writeFileSync(path.join(d, `${title}.English.srt`), english);
  return d;
};

const ui = suite({
  server: { env: { AURORA_AI_MOCK: "1" } },
  setup: async (srv) => {
    const cache = path.join(__dirname, ".cache", "subai");
    for (const t of Object.values(FILMS)) fs.cpSync(build(cache, ffmpegPath(), t), path.join(srv.library.movies, t), { recursive: true });
    await srv.api.rescan();
    const deadline = Date.now() + 60000;
    srv.films = {};
    for (;;) {
      const lib = await srv.api.library();
      for (const [k, t] of Object.entries(FILMS)) {
        const m = lib.movies.find((x) => `${x.title} (${x.year})` === t || x.title === t.replace(/ \(\d+\)$/, ""));
        if (m && m.duration > 0) srv.films[k] = m.id;
      }
      if (Object.keys(srv.films).length === 2) break;
      if (Date.now() > deadline) throw new Error("the films never finished probing");
      await new Promise((r) => setTimeout(r, 300));
    }
  },
});

const ART = path.join(__dirname, "artifacts");
// every toast the page shows, from the start
const recordToasts = (page) => page.addInitScript(() => {
  window.__toasts = [];
  const watch = () => {
    const root = document.getElementById("toasts");
    if (!root) return setTimeout(watch, 50);
    new MutationObserver(() => { for (const n of root.children) { const t = n.textContent; if (!window.__toasts.includes(t)) window.__toasts.push(t); } })
      .observe(root, { childList: true, subtree: true });
  };
  watch();
});
const showing = (page) => page.evaluate(() => {
  const t = [...document.querySelector(".player video").textTracks].find((x) => x.mode === "showing");
  return t ? { label: t.label, cues: t.cues ? [...t.cues].map((c) => [c.startTime, c.endTime, c.text]) : null } : null;
});
const hebrewViewer = async (api, freshProfile) => {
  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { subLang: "he", subsDefault: true } }, await api.as(me));
  return me;
};

ui.test("desktop: no Hebrew anywhere — told it is being translated, then עברית (AI) arrives while the film plays and switches on", async ({ page, srv, signIn, freshProfile, api }) => {
  const me = await hebrewViewer(api, freshProfile);
  await signIn(me);
  await recordToasts(page);
  await player.open(page, srv, srv.films.he);
  // the menu has "Fix timing" and the English track, and (soon) the translation
  await page.waitForFunction(() => window.__toasts.some((t) => t.includes("Hebrew subtitles translated with AI — switched on")), null, { timeout: 60000 });
  const toasts = await page.evaluate(() => window.__toasts);
  assert.ok(toasts.some((t) => t.includes("No Hebrew subtitles yet — translating with AI, ready in a few minutes")), JSON.stringify(toasts));
  // still playing — nothing reloaded
  assert.equal(await page.evaluate(() => !document.querySelector(".player video").paused), true);
  await page.waitForFunction(() => { const t = [...document.querySelector(".player video").textTracks].find((x) => x.mode === "showing"); return t && t.cues && t.cues.length >= 40; }, null, { timeout: 20000 });
  const s = await showing(page);
  assert.equal(s.label, "עברית (AI)");
  // every cue on the English file's timing, in Hebrew, the dialogue one line per speaker
  s.cues.forEach(([a, b, text], i) => {
    assert.ok(Math.abs(a - LINES[i].start) < 0.002 && Math.abs(b - LINES[i].end) < 0.002, `cue ${i}: ${a}–${b}`);
    assert.match(text, /[֐-׿]/);
  });
  assert.match(s.cues[2][2], /^- .+\n- .+$/);
  const items = await player.menu(page, "Subtitles");
  const texts = items.map((x) => x.text);
  assert.equal(texts[0], "⟲ Fix timing");
  assert.deepEqual(texts.slice(1), ["Off", "English", "עברית (AI)"]);
  assert.equal(items.find((x) => x.text === "עברית (AI)").active, true);
  await page.screenshot({ path: path.join(ART, "subai-desktop-menu.png") }).catch(() => {});
  await page.keyboard.press("Escape");
  // a two-speaker cue on screen, right to left (for the eye: the artifact)
  await player.jump(page, LINES[2].start + 0.5);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(ART, "subai-desktop-cue.png") }).catch(() => {});
  // what any other device is told: the same name, Hebrew, after the English
  const it = await srv.api.item(srv.films.he);
  assert.deepEqual(it.subtitles.map((t) => [t.label, t.lang, !!t.ai]), [["English", "en", false], ["עברית (AI)", "he", true]]);
});

for (const [name, viewport] of [["phone", PHONE], ["320 px", { width: 320, height: 640 }]]) ui.test(`${name}: the next Hebrew viewer gets עברית (AI) at the start, and its name fits the menu`, { viewport }, async ({ page, srv, signIn, freshProfile, api }) => {
  const me = await hebrewViewer(api, freshProfile);
  await signIn(me);
  await player.open(page, srv, srv.films.he);
  await page.waitForFunction(() => [...document.querySelector(".player video").textTracks].some((t) => t.mode === "showing"), null, { timeout: 20000 });
  assert.equal((await showing(page)).label, "עברית (AI)");
  const items = await player.menu(page, "Subtitles");
  assert.ok(items.some((x) => x.text === "עברית (AI)" && x.active), JSON.stringify(items));
  const fit = await page.evaluate(() => {
    const m = document.querySelector(".player .menu");
    const row = [...m.querySelectorAll(".menu-item")].find((b) => b.textContent.includes("עברית (AI)"));
    const r = row.getBoundingClientRect();
    return { left: r.left, right: r.right, vw: innerWidth, scroll: row.scrollWidth <= row.clientWidth + 1 };
  });
  assert.ok(fit.left >= 0 && fit.right <= fit.vw && fit.scroll, JSON.stringify(fit));
  await page.screenshot({ path: path.join(ART, `subai-${viewport.width}-menu.png`) }).catch(() => {});
});

ui.test("a viewer whose subtitles are English causes no translation", async ({ page, srv, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { subLang: "en", subsDefault: true } }, await api.as(me));
  await signIn(me);
  await player.open(page, srv, srv.films.en, { min: 3 });
  assert.equal((await showing(page)).label, "English");
  // (the player has saved its place by now: the server heard it play)
  await page.waitForTimeout(3000);
  const it = await srv.api.item(srv.films.en);
  assert.deepEqual(it.subtitles.map((t) => t.label), ["English"]);
});

ui.run({ concurrency: 1 });

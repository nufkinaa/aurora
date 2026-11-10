// A copy keeps EVERY subtitle track the title has, each selectable offline
// (a copy used to keep 6, then 8, and drop the rest — a film with Hebrew 9th
// lost it), and carries ONE sound, chosen on the size sheet: the person's
// own language by default (the dub they pick in the player), else the
// file's first. (js/offline.js, offlinePicker.js, src/media/offline.js —
// 2026-11-10 round 2)
//
// The film is made here with ffmpeg: three sounds (English, Hebrew, French,
// AC-3) and eleven subtitle tracks (ten inside, one beside it), dropped into
// the private instance's library and rescanned (test/ui/live.test.js's way).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const assert = require("node:assert/strict");
const { suite, PHONE } = require("./helpers");

const LANGS = ["eng", "heb", "fre", "spa", "ger", "ita", "por", "ara", "rus", "jpn"];
const FOLDER = "Test Babel (2023)";
let filmId = null;

const ffmpeg = () => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
};
const srt = (tag) => [1, 2, 3, 4].map((n) => `${n}\n00:00:0${(n - 1) * 2},000 --> 00:00:0${(n - 1) * 2 + 1},500\n${tag} line ${n}\n`).join("\n");

const ui = suite({
  setup: async (srv) => {
    const dir = path.join(srv.library.movies, FOLDER);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(srv.root, "tmp", "babel");
    fs.mkdirSync(tmp, { recursive: true });
    const subs = LANGS.map((l) => { const f = path.join(tmp, `${l}.srt`); fs.writeFileSync(f, srt(l.toUpperCase())); return f; });
    const args = ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=12", "-f", "lavfi", "-i", "sine=frequency=550:duration=12", "-f", "lavfi", "-i", "sine=frequency=770:duration=12",
      ...subs.flatMap((f) => ["-i", f]),
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:a", ...subs.map((_, i) => ["-map", `${i + 4}:0`]).flat(),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "ac3", "-b:a", "96k", "-c:s", "srt",
      "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=heb", "-metadata:s:a:2", "language=fre",
      ...LANGS.flatMap((l, i) => [`-metadata:s:s:${i}`, `language=${l}`]),
      "-shortest", path.join(dir, `${FOLDER}.mkv`)];
    const r = spawnSync(ffmpeg(), args, { encoding: "utf-8", windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
    fs.writeFileSync(path.join(dir, `${FOLDER}.Hebrew.srt`), srt("HE-SIDECAR"));
    await srv.api.adminPost("/api/admin/rescan");
    for (let i = 0; i < 200; i++) {
      const lib = await srv.api.get("/api/library");
      const m = lib.movies.find((x) => x.title === "Test Babel");
      if (m && m.duration > 0) {
        const it = await srv.api.get(`/api/item/${m.id}`);
        if ((it.subtitles || []).length >= 11) { filmId = m.id; break; }
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    if (!filmId) throw new Error("the test film did not come into the library");
  },
});

const open = async (srv, profile) => {
  const ctx = await ui.browser.newContext({ viewport: PHONE, serviceWorkers: "allow", hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.stack) || e)));
  await page.addInitScript(({ id }) => {
    try {
      if (sessionStorage.getItem("ui-test-seeded")) return;
      sessionStorage.setItem("ui-test-seeded", "1");
      localStorage.setItem("aurora-profile", id);
      localStorage.setItem("aurora-kbd-hint", "1");
      localStorage.setItem("aurora-nav-hinted", "1");
    } catch {}
  }, { id: profile.id });
  await page.goto(`${srv.url}/#/movie/${filmId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-ui="detail.offline"]', { timeout: 30000 });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  return { context: ctx, page, errors };
};
const saved = (page) => page.evaluate(async (id) => (await import("/js/offline.js")).getSaved(id), filmId);
const until = async (fn, what, ms = 90000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};
const probeCopy = (srv, audio) => {
  const dir = path.join(srv.dataDir, "cache", "offline");
  const f = fs.readdirSync(dir).find((n) => n.startsWith(filmId) && n.endsWith(audio ? `-original-a${audio}.mp4` : "-original.mp4"));
  assert.ok(f, `the server's copy (${fs.readdirSync(dir).join(", ")})`);
  const r = spawnSync(ffmpeg().replace(/ffmpeg(\.exe)?$/i, (m) => m.replace("ffmpeg", "ffprobe")), ["-v", "error", "-show_entries", "stream=codec_type,codec_name:stream_tags=language", "-of", "json", path.join(dir, f)], { encoding: "utf-8" });
  return JSON.parse(r.stdout).streams;
};

ui.test("phone, Hebrew is this person's language: the sheet offers the three sounds with Hebrew chosen; the copy carries Hebrew only, and all eleven subtitle tracks play offline", { allow: [/Failed to load resource/, /ERR_INTERNET_DISCONNECTED/, /WebSocket/] }, async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  await srv.api.ok("PUT", `/api/profiles/${profile.id}`, { prefs: { audioLang: "he" } }, await srv.api.as(profile));
  const { context, page, errors } = await open(srv, profile);
  try {
    await page.locator('[data-ui="detail.offline"]').first().click();
    await page.waitForSelector(".offline-sheet .offline-sound");
    const chips = await page.$$eval(".offline-sheet .offline-sound", (els) => els.map((e) => [e.textContent.trim(), e.getAttribute("aria-pressed")]));
    assert.deepEqual(chips.map((c) => c[0]), ["English", "Hebrew", "French"]);
    assert.deepEqual(chips.map((c) => c[1]), ["false", "true", "false"], "the person's own language, chosen for them");
    await page.locator(".offline-sheet .offline-opt", { hasText: "Original" }).first().click();
    await until(async () => { const s = await saved(page); return s && !s.pending; }, "saved");
    const s = await saved(page);
    assert.equal(s.audio, 1);
    assert.equal(s.audioLang, "heb");
    assert.equal(s.audioLabel, "Hebrew");
    assert.equal(s.subtitles.length, 11, `every subtitle track kept (${s.subtitles.map((t) => t.label).join(", ")})`);
    // the server's copy: the picture and ONE sound — the Hebrew one
    const streams = probeCopy(srv, 1);
    assert.deepEqual(streams.filter((x) => x.codec_type === "audio").map((x) => x.tags && x.tags.language), ["heb"]);
    // offline: every track is there to pick
    await context.setOffline(true);
    await page.evaluate((id) => { location.hash = `#/play/${id}?offline=1`; }, filmId);
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 0.3; }, null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector(".player video").textTracks.length >= 11, null, { timeout: 15000 });
    // and a track in the middle of the list really shows its cues
    const cue = await page.evaluate(async () => {
      const v = document.querySelector(".player video");
      const t = [...v.textTracks].find((x) => /jap|jpn|Japanese/i.test(x.label + x.language)) || v.textTracks[9];
      for (const x of v.textTracks) x.mode = x === t ? "showing" : "disabled";
      v.currentTime = 2.5;
      for (let i = 0; i < 40 && !(t.cues && t.cues.length); i++) await new Promise((r) => setTimeout(r, 100));
      return t.cues && t.cues.length ? t.cues[0].text : null;
    });
    assert.match(cue || "", /line 1/, "the 10th track's cues load from the device");
    await context.setOffline(false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("phone, no language on file for the person: the file's first sound is chosen; picking French saves French", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile);
  try {
    await page.locator('[data-ui="detail.offline"]').first().click();
    await page.waitForSelector(".offline-sheet .offline-sound");
    assert.equal(await page.locator('.offline-sheet .offline-sound[aria-pressed="true"]').innerText(), "English");
    await page.locator(".offline-sheet .offline-sound", { hasText: "French" }).click();
    assert.equal(await page.locator('.offline-sheet .offline-sound[aria-pressed="true"]').innerText(), "French");
    await page.locator(".offline-sheet .offline-opt", { hasText: "Original" }).first().click();
    await until(async () => { const s = await saved(page); return s && !s.pending; }, "saved");
    const s = await saved(page);
    assert.equal(s.audio, 2);
    assert.equal(s.audioLang, "fre");
    assert.deepEqual(probeCopy(srv, 2).filter((x) => x.codec_type === "audio").map((x) => x.tags && x.tags.language), ["fre"]);
    // the old clients' way (no sound asked): the first, as before
    const old = await srv.api.post(`/api/offline/prepare/${filmId}?q=original`);
    assert.ok(["queued", "working", "ready"].includes(old.state), JSON.stringify(old));
    assert.equal(old.audio, undefined);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.run({ concurrency: 1 });

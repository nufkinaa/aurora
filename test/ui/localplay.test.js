// "Play a file from this device" (public/js/localplay.js): a video and its
// subtitles picked from the computer or phone play in Aurora's own player
// from object URLs — nothing is uploaded, no server is needed.
//
// The media is made here with ffmpeg: a short MP4 (H.264 + AAC), a Hebrew +
// English SRT (UTF-8), a Hebrew SRT in Windows-1255, an English .ass, an
// MKV whose video no browser decodes (MPEG-4 Part 2) and a file that is not
// a video at all. Screenshots land in test/ui/artifacts/local-play-*.png.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const assert = require("node:assert/strict");
const { suite, player, goto, signIn: seedSignIn, DESKTOP, PHONE, ARTIFACTS } = require("./helpers");

const RLM = "‏";
const SECONDS = 60;
const ffmpegPath = () => {
  const win = process.platform === "win32";
  const r = spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { encoding: "utf-8" });
  return process.env.FFMPEG_PATH || (r.stdout || "").split(/\r?\n/)[0].trim();
};
const ts = (s) => `00:00:${String(Math.floor(s)).padStart(2, "0")},${String(Math.round((s % 1) * 1000)).padStart(3, "0")}`;
// Windows-1255: Hebrew letters U+05D0..U+05EA are bytes 0xE0..0xFA
const cp1255 = (text) => Buffer.from([...text].map((c) => {
  const u = c.codePointAt(0);
  if (u >= 0x5d0 && u <= 0x5ea) return 0xe0 + (u - 0x5d0);
  if (u < 0x80) return u;
  throw new Error(`not in the 1255 table: ${c}`);
}));

const MEDIA_V = 3;
const buildMedia = () => {
  const dir = path.join(__dirname, ".cache", `localplay-v${MEDIA_V}`);
  if (fs.existsSync(path.join(dir, ".ready"))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ffmpeg = ffmpegPath();
  const ff = (args) => {
    const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf-8", windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  };
  const v = ["-f", "lavfi", "-i", `testsrc=size=320x180:rate=25:duration=${SECONDS}`, "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`];
  const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "25"];
  ff([...v, ...h264, "-c:a", "aac", "-b:a", "64k", "-ac", "2", "-movflags", "+faststart", "-shortest", path.join(dir, "Holiday.Film.2024.mp4")]);
  ff([...v, "-c:v", "mpeg4", "-q:v", "8", "-c:a", "aac", "-b:a", "64k", "-shortest", path.join(dir, "Old.Xvid.Rip.mkv")]);
  ff([...v, ...h264, "-c:a", "ac3", "-b:a", "128k", "-ac", "2", "-shortest", path.join(dir, "Dolby.Sound.mkv")]);
  // a cue every two seconds, Hebrew over English
  let srt = "";
  for (let i = 0, n = 1; i + 2 <= SECONDS; i += 2, n++) srt += `${n}\n${ts(i)} --> ${ts(i + 1.9)}\nמה שלומך היום? ${n}\nHow are you today? ${n}\n\n`;
  fs.writeFileSync(path.join(dir, "Holiday.Film.2024.he.srt"), srt, "utf-8");
  let heb = "";
  for (let i = 0, n = 1; i + 2 <= SECONDS; i += 2, n++) heb += `${n}\r\n${ts(i)} --> ${ts(i + 1.9)}\r\nבדיקה בעברית ${n}\r\n\r\n`;
  fs.writeFileSync(path.join(dir, "Holiday.Film.2024.heb.srt"), cp1255(heb));
  const ass = ["[Script Info]", "ScriptType: v4.00+", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...Array.from({ length: SECONDS / 2 }, (_, i) => `Dialogue: 0,0:00:${String(i * 2).padStart(2, "0")}.00,0:00:${String(i * 2 + 1).padStart(2, "0")}.90,Default,,0,0,0,,{\\i1}English ass ${i + 1}{\\i0}`)].join("\r\n");
  fs.writeFileSync(path.join(dir, "Holiday.Film.2024.en.ass"), ass, "utf-8");
  // bytes that are no video at all (a fixed seed: the same file every run)
  fs.writeFileSync(path.join(dir, "Not.A.Video.mp4"), crypto.createHash("sha512").update("aurora").digest().toString("hex").repeat(4000));
  fs.writeFileSync(path.join(dir, ".ready"), new Date().toISOString());
  return dir;
};
const MEDIA = buildMedia();
const F = (name) => path.join(MEDIA, name);
const FILM = "Holiday.Film.2024.mp4";

const ui = suite();

const shot = async (page, name) => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.waitForTimeout(700); // (a screen fades in: the picture after it)
  return page.screenshot({ path: path.join(ARTIFACTS, `local-play-${name}.png`) }).catch(() => {});
};

// Every request the page makes to the server, for the "nothing is uploaded" checks.
const recordRequests = (page, srv) => {
  const all = [];
  page.on("request", (req) => {
    if (!req.url().startsWith(srv.url)) return;
    all.push({ method: req.method(), url: req.url(), body: req.postData() || "" });
  });
  return all;
};

// Chrome's cue boxes (the user-agent shadow DOM, through the DevTools
// protocol — the only honest answer to where a cue is DRAWN) and the
// direction the cue display was laid out in.
const cueLayout = async (page) => {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const cues = [];
    const displays = [];
    const walk = (n) => {
      const a = n.attributes || [];
      const i = a.indexOf("pseudo");
      if (i >= 0 && a[i + 1] === "cue") cues.push(n.backendNodeId);
      if (i >= 0 && a[i + 1] === "-webkit-media-text-track-display") displays.push(n.backendNodeId);
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
    };
    walk(root);
    const boxes = [];
    for (const id of cues) {
      try {
        const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: id });
        boxes.push({ top: model.border[1], bottom: model.border[5] });
      } catch {}
    }
    const dirs = [];
    for (const id of displays) {
      try {
        const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: id });
        const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function () { return getComputedStyle(this).direction; }", returnByValue: true });
        dirs.push(result.value);
      } catch {}
    }
    return { boxes, dirs };
  } finally {
    await cdp.detach().catch(() => {});
  }
};
const dockTop = (page) => page.evaluate(() => document.querySelector(".player .player-bottom").getBoundingClientRect().top);

// The Saved screen's picker: a video (+ subtitles in the same pick), more
// subtitles in the second input, then Play.
const pickAndPlay = async (page, video, subs = [], moreSubs = []) => {
  await page.waitForSelector(".local-play");
  await page.setInputFiles(".local-play .local-video-input", [F(video), ...subs.map(F)]);
  if (moreSubs.length) await page.setInputFiles(".local-play .local-sub-input", moreSubs.map(F));
  await page.waitForSelector(".local-play .local-play-go:not(.hidden)");
  await page.click(".local-play .local-play-go");
  await page.waitForSelector(".player video");
};
const showingCue = (page) => page.evaluate(() => {
  const t = [...document.querySelector(".player video").textTracks].find((x) => x.mode === "showing");
  return t ? { label: t.label, cue: t.activeCues && t.activeCues[0] ? t.activeCues[0].text : null, count: t.cues ? t.cues.length : 0 } : null;
});
const waitCue = (page, test = "true") => page.waitForFunction(new Function(`
  const t = [...document.querySelector(".player video").textTracks].find((x) => x.mode === "showing");
  const cue = t && t.activeCues && t.activeCues[0] ? t.activeCues[0].text : null;
  return !!cue && (${test});`));

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`${name}: a video and its subtitles from this device play in Aurora's player — cues above the dock, Hebrew right to left, the delay buttons, nothing sent to the server`, { viewport }, async ({ page, srv, signIn, freshProfile }) => {
    await signIn(await freshProfile());
    const reqs = recordRequests(page, srv);
    await goto(page, srv, "#/saved");
    const card = page.locator(".local-play");
    assert.match(await card.innerText(), /Play a file from this device/);
    assert.match(await card.innerText(), /stays on this device — nothing is uploaded/);
    await page.setInputFiles(".local-play .local-video-input", [F(FILM), F("Holiday.Film.2024.he.srt")]);
    await page.setInputFiles(".local-play .local-sub-input", [F("Holiday.Film.2024.heb.srt"), F("Holiday.Film.2024.en.ass")]);
    const chips = await page.locator(".local-play .local-chip-name").allTextContents();
    assert.deepEqual(chips, [FILM, "Holiday.Film.2024.he.srt", "Holiday.Film.2024.heb.srt", "Holiday.Film.2024.en.ass"]);
    await shot(page, `${name}-picker`);
    const before = reqs.length;
    await page.click(".local-play .local-play-go");
    await player.playing(page, { min: 0.5 });

    // the player, with what needs a server left out
    assert.match(page.url(), /#\/play\/local-[a-z0-9]+\?local=1$/);
    assert.match(await page.locator(".player").getAttribute("class"), /player/);
    assert.equal((await page.textContent(".player .player-title")).trim(), "Holiday Film 2024");
    assert.equal(await page.locator(".player .local-badge").count(), 1);
    for (const gone of ["Watch together", "AirPlay", "X-Ray"]) assert.equal(await page.locator(player.ctrl(gone)).count(), 0, `${gone} is not offered for a local file`);
    for (const there of ["Subtitles", "Settings", "Fullscreen", "Back 10 seconds", "Forward 10 seconds"]) assert.equal(await page.locator(player.ctrl(there)).count(), 1, `${there} is there`);
    assert.match(await page.evaluate(() => document.querySelector(".player video").currentSrc), /^blob:/);
    // its sound (AAC) is decoded: no "No sound" note
    // (desktop: on the phone the dock would fade meanwhile, and the helpers wake it with a mouse)
    if (name === "desktop") {
      await page.waitForTimeout(3000);
      assert.equal(await page.locator("#toasts .toast", { hasText: "No sound" }).count(), 0);
    }

    // the first subtitle picked with it is on, Hebrew over English
    await waitCue(page);
    let s = await showingCue(page);
    assert.equal(s.label, "Hebrew · Holiday.Film.2024.he.srt");
    assert.ok(s.cue.startsWith(`${RLM}מה שלומך היום?`), JSON.stringify(s.cue));
    assert.match(s.cue, /\nHow are you today\? \d+$/);

    // the menu: every track by language and file, no Resync, the timing row
    const items = await player.menu(page, "Subtitles");
    const texts = items.map((i) => i.text);
    assert.ok(!texts.some((t) => /Resync/.test(t)), `no Resync for a local file: ${texts.join(" | ")}`);
    assert.deepEqual(texts.filter((t) => / · /.test(t)), ["Hebrew · Holiday.Film.2024.he.srt", "Hebrew · Holiday.Film.2024.heb.srt", "English · Holiday.Film.2024.en.ass"]);
    await shot(page, `${name}-menu`);

    // the delay buttons move the cues
    const cueStart = () => page.evaluate(() => {
      const t = [...document.querySelector(".player video").textTracks].find((x) => x.mode === "showing");
      return [...t.cues].find((c) => /היום\? 6\u200f?\n/.test(c.text)).startTime;
    });
    assert.equal(await cueStart(), 10);
    await page.click('.player .menu [aria-label="Subtitles later"]');
    await page.click('.player .menu [aria-label="Subtitles later"]');
    assert.equal((await page.textContent(".player .menu .sub-sync .tag")).trim(), "+1.0s");
    assert.equal(await cueStart(), 11);
    await page.click('.player .menu [aria-label="Reset subtitle timing"]');
    assert.equal(await cueStart(), 10);
    await page.keyboard.press("Escape");

    // paused on a cue with the controls up: drawn ABOVE the dock, right to left
    await page.evaluate(() => { const v = document.querySelector(".player video"); v.pause(); v.currentTime = 6.5; });
    await waitCue(page, "/היום\\? 4/.test(cue)");
    await player.wake(page);
    const top = await dockTop(page);
    let layout = { boxes: [], dirs: [] };
    for (let i = 0; i < 30; i++) {
      layout = await cueLayout(page);
      if (layout.boxes.length && layout.boxes.every((b) => b.bottom <= top)) break;
      await page.waitForTimeout(150);
    }
    assert.ok(layout.boxes.length, "a cue is drawn");
    for (const b of layout.boxes) assert.ok(b.bottom <= top, `the cue ends at ${b.bottom.toFixed(0)}px, the dock begins at ${top.toFixed(0)}px`);
    assert.ok(layout.dirs.includes("rtl"), `the Hebrew cue is laid out right to left (${layout.dirs.join(",")})`);
    await shot(page, `${name}-hebrew-cue`);

    // the Windows-1255 file reads as Hebrew, the .ass as English
    await player.pick(page, "Subtitles", "Holiday.Film.2024.heb.srt");
    await waitCue(page, "/בדיקה בעברית 4/.test(cue)");
    await player.pick(page, "Subtitles", "Holiday.Film.2024.en.ass");
    await waitCue(page, "cue === 'English ass 4'");
    await shot(page, `${name}-ass-cue`);

    // the keys (desktop): Space plays and pauses, the arrows move 10 s
    if (name === "desktop") {
      await page.evaluate(() => document.querySelector(".player video").play());
      await player.playing(page, { min: 6 });
      const t0 = await page.evaluate(() => document.querySelector(".player video").currentTime);
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction((t0) => document.querySelector(".player video").currentTime >= t0 + 8, t0);
      await page.keyboard.press("Space");
      await page.waitForFunction(() => document.querySelector(".player video").paused);
    }

    // nothing about the file went to the server: no stream, no play marks,
    // no progress, nothing with its name, nothing the size of a file
    const sent = reqs.slice(before);
    const bad = sent.filter((r) => /Holiday|local-|\/stream\/|play-mark|\/progress/.test(decodeURIComponent(r.url)) || /Holiday/.test(r.body) || r.body.length > 4000);
    assert.deepEqual(bad, [], `requests about the local file: ${JSON.stringify(bad).slice(0, 600)}`);
  });
}

ui.test("the place a file was left is kept on this device: opening it again resumes there", async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto(page, srv, "#/saved");
  await pickAndPlay(page, FILM);
  await player.playing(page, { min: 0.3 });
  await player.jump(page, 15);
  await page.waitForFunction(() => document.querySelector(".player video").currentTime >= 15.5);
  await player.press(page, "Back");
  await page.waitForSelector(".local-play");
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("aurora-local-positions") || "{}"));
  const entry = Object.entries(kept).find(([k]) => k.startsWith(`${FILM}|`));
  assert.ok(entry && entry[1].position >= 15, `position kept by name and size: ${JSON.stringify(kept)}`);
  await pickAndPlay(page, FILM);
  await player.playing(page, { min: 10 });
  const t = await page.evaluate(() => document.querySelector(".player video").currentTime);
  assert.ok(t >= 10 && t < 18, `resumed near 15 s (four seconds early): ${t}`);
  assert.match(await page.locator(".player .resume-pill").innerText(), /Resumed at 0:1\d/);
});

ui.test("a file this browser can't play gets a sentence that says why — never a broken player", async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto(page, srv, "#/saved");
  // not a video at all
  await pickAndPlay(page, "Not.A.Video.mp4");
  await page.waitForSelector(".player .player-error");
  assert.equal((await page.textContent(".player .player-error h3")).trim(), "Can't play this file here");
  assert.match(await page.textContent(".player .player-error p"), /^This browser can't play this file\. A \.mp4 with H\.264 video and AAC sound plays in every browser/);
  assert.equal(await page.locator('.player .player-error [data-ui="player.retry"]').count(), 0, "no Try again: nothing would change");
  await shot(page, "desktop-unplayable");
  await page.click(".player .player-error .btn-primary");
  await page.waitForSelector(".local-play");
  // MPEG-4 Part 2 (Xvid) video: the sound decodes, the picture never does
  await pickAndPlay(page, "Old.Xvid.Rip.mkv");
  await page.waitForSelector(".player .player-error", { timeout: 15000 });
  assert.match(await page.textContent(".player .player-error p"), /can't play this file's video \(MPEG-4 Part 2 \(Xvid\/DivX\)\)/);
  await shot(page, "desktop-xvid");
  await page.click(".player .player-error .btn-primary");
  await page.waitForSelector(".local-play");
  // H.264 picture, AC-3 sound: the browser either plays it silently (a note says
  // why) or refuses the file (the card says why) — AC-3 named either way
  await pickAndPlay(page, "Dolby.Sound.mkv");
  const said = page.locator("#toasts .toast", { hasText: "No sound" }).or(page.locator(".player .player-error p"));
  await said.first().waitFor({ timeout: 20000 });
  assert.match(await said.first().innerText(), /AC-3/);
  await shot(page, "desktop-ac3");
});

ui.test("with the server out of reach after the app loaded, a file still plays — with its subtitles", { allow: [/Failed to load resource/, /ERR_INTERNET_DISCONNECTED/, /WebSocket/] }, async ({ page, context, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto(page, srv, "#/saved");
  // (the picker fetches the player's code as it appears — the reason a dropped
  // connection after this point still plays)
  await page.waitForFunction(() => performance.getEntriesByType("resource").some((e) => /\/js\/screens\/player\.js/.test(e.name) && e.responseEnd > 0));
  await page.waitForLoadState("networkidle"); // (and the modules it imports)
  await context.setOffline(true);
  await pickAndPlay(page, FILM, ["Holiday.Film.2024.he.srt"]);
  await player.playing(page, { min: 1 });
  await waitCue(page);
  assert.ok((await showingCue(page)).cue.startsWith(RLM));
  await shot(page, "desktop-offline-playing");
  await context.setOffline(false);
});

ui.test("the app coming up with no server to answer lands on On this device — the server named as out of reach, Try again, and a file still plays", { allow: [/Failed to load resource/, /ERR_FAILED/] }, async ({ page, context, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  // the profile list cannot be had: what boot does when the server is gone
  await context.route("**/api/profiles", (r) => r.abort("failed"));
  await page.goto(`${srv.url}/#/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".local-noserver");
  assert.match(page.url(), /#\/saved$/);
  assert.match(await page.textContent(".local-noserver"), /Can't reach the Aurora server[\s\S]*Try again/);
  await shot(page, "desktop-no-server-boot");
  await pickAndPlay(page, FILM, ["Holiday.Film.2024.he.srt"]);
  await player.playing(page, { min: 0.5 });
  await waitCue(page);
});

ui.test("My downloads sums up what is on this device and leads there", async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto(page, srv, "#/downloads");
  assert.match(await page.textContent(".device-summary"), /On this device[\s\S]*Nothing saved here yet[\s\S]*play a video from this computer or phone/);
  const link = page.locator(".device-summary button", { hasText: "Open On this device" });
  await link.click();
  await page.waitForSelector(".local-play");
  assert.match(page.url(), /#\/saved$/);
});

ui.test("a page reload forgets the file: the player sends you back to pick it again, without an error", async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto(page, srv, "#/saved");
  await pickAndPlay(page, FILM);
  await player.playing(page, { min: 0.3 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".local-play", { timeout: 15000 });
  assert.match(page.url(), /#\/saved$/);
  await page.locator("#toasts .toast", { hasText: "pick it again" }).first().waitFor();
});

// ---------- the service worker: the whole app from its cache, no server ----------
// (the suite's contexts block service workers; this one has its own)
ui.test("fully offline: the worker's precache holds the player and the picker, and a fresh load with no server still plays a file", { allow: [/Failed to load resource/, /ERR_INTERNET_DISCONNECTED/, /WebSocket/] }, async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const context = await ui.browser.newContext({ viewport: DESKTOP, serviceWorkers: "allow" });
  try {
    await context.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e && e.stack || e)));
    await seedSignIn(page, srv, profile);
    await page.goto(`${srv.url}/#/saved`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".local-play");
    // the worker controls the page and has stamped a complete precache
    // (polled by hand: waitForFunction takes an async predicate's promise for "true")
    for (let i = 0; ; i++) {
      const ready = await page.evaluate(async () => {
        if (!navigator.serviceWorker.controller) return false;
        const c = await caches.open("aurora-shell-v1");
        return !!(await c.match("/__shell-version"));
      });
      if (ready) break;
      assert.ok(i < 120, "the worker never finished its precache");
      await page.waitForTimeout(500);
    }
    const cached = await page.evaluate(async () => {
      const c = await caches.open("aurora-shell-v1");
      const out = {};
      for (const p of ["/js/localplay.js", "/js/localsubs.js", "/js/screens/player.js", "/js/screens/saved.js", "/js/main.js", "/"]) out[p] = !!(await c.match(p));
      out.keys = (await c.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
      return out;
    });
    const keys = cached.keys;
    delete cached.keys;
    for (const [p, ok] of Object.entries(cached)) assert.ok(ok, `${p} is in the worker's precache (it holds ${keys.length}: ${keys.slice(0, 80).join(" ")})`);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".local-play", { timeout: 30000 });
    await shot(page, "desktop-offline-fresh-load");
    await pickAndPlay(page, FILM, ["Holiday.Film.2024.he.srt"]);
    await player.playing(page, { min: 1 });
    await waitCue(page);
    await shot(page, "desktop-offline-fresh-playing");
    assert.deepEqual(errors, []);
  } finally {
    await context.setOffline(false).catch(() => {});
    await context.close().catch(() => {});
  }
});

// ---------- "On this device" while ONLINE: saves under way, the saved titles ----------
// elia, 2026-10-18: "a user can't see, while he's connected, his offline
// library … and also download status and progress". A save needs the
// service worker (it is what plays the copy), so these pages have one.
const swPage = async (srv, profile, viewport) => {
  const phone = viewport.width < 600;
  const context = await ui.browser.newContext({ viewport, serviceWorkers: "allow", ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.stack) || e)));
  await seedSignIn(page, srv, profile);
  return { context, page, errors };
};
const jobRow = (page, state) => page.locator(`.device-job[data-state="${state}"]`);

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`${name}: on this device, online — a save shows its progress there, outlives leaving the page and a reload (Resume), fails with Retry, and the copy plays from the device`, async ({ srv, freshProfile }) => {
    const profile = await freshProfile();
    const { context, page, errors } = await swPage(srv, profile, viewport);
    try {
      const film = srv.lib.film1;
      await page.goto(`${srv.url}/#/movie/${film.id}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
      const saveBtn = page.locator('[data-ui="detail.offline"]').first();
      await saveBtn.waitFor();

      // 1. the server can't make the copy: the save fails, and says why, with Retry
      await page.route("**/api/offline/prepare/**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the disk is full" }) }));
      await saveBtn.click();
      await page.locator(".offline-sheet .offline-opt").first().click();
      await page.locator("#toasts .toast", { hasText: "Couldn't save" }).first().waitFor();
      await page.unroute("**/api/offline/prepare/**");
      await page.evaluate(() => { location.hash = "#/saved"; });
      await jobRow(page, "failed").waitFor();
      assert.match(await jobRow(page, "failed").innerText(), /Didn't save[\s\S]*disk is full/);
      assert.match(await page.textContent(".browse-head h1"), /On this device/);
      await shot(page, `${name}-device-failed`);

      // 2. Retry, with the bytes held back: "Saving to this device", with its bar
      let release;
      const held = new Promise((r) => { release = r; });
      const hold = async (route) => { await held; route.continue().catch(() => {}); };
      await page.route("**/stream/video/**", hold);
      await page.route("**/offline/file/**", hold);
      await jobRow(page, "failed").locator("button", { hasText: "Retry" }).click();
      await jobRow(page, "saving").waitFor();
      assert.match(await jobRow(page, "saving").innerText(), /Saving to this device · \d+%/);
      assert.equal(await jobRow(page, "saving").locator(".dl-bar").count(), 1);
      // leaving and coming back: it is still there
      await page.evaluate(() => { location.hash = "#/downloads"; });
      await page.locator(".device-jobs:not(.hidden) .device-job").first().waitFor();
      await shot(page, `${name}-downloads-device`);
      await page.evaluate(() => { location.hash = "#/saved"; });
      await jobRow(page, "saving").waitFor();
      await shot(page, `${name}-device-saving`);

      // 3. a reload cuts it off: "Stopped", with Resume
      await page.reload({ waitUntil: "domcontentloaded" });
      release();
      await page.unroute("**/stream/video/**");
      await page.unroute("**/offline/file/**");
      await jobRow(page, "interrupted").waitFor();
      assert.match(await jobRow(page, "interrupted").innerText(), /Interrupted[\s\S]*the page was closed or reloaded[\s\S]*Resume starts it again/);
      await shot(page, `${name}-device-interrupted`);
      await jobRow(page, "interrupted").locator("button", { hasText: "Resume" }).click();

      // 4. done: the row goes, the title is in the list, with its size and Remove
      await page.locator(".dl-row", { hasText: film.title }).locator('[data-ui="saved.play"]').waitFor({ timeout: 60000 });
      assert.equal(await page.locator(".device-job").count(), 0);
      assert.match(await page.textContent(".saved-head"), /Saved titles\s*1/);
      await shot(page, `${name}-device-saved`);

      // 5. played from the device while the server is right there
      const streamed = [];
      page.on("request", (r) => { if (/\/stream\//.test(r.url())) streamed.push(r.url()); });
      await page.locator('[data-ui="saved.play"]').first().click();
      await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 0.5; }, null, { timeout: 30000 });
      assert.match(await page.evaluate(() => document.querySelector(".player video").currentSrc), /\/offline\/media\//);
      assert.deepEqual(streamed, [], "nothing streamed from the server");
      await shot(page, `${name}-device-playing`);
      await page.goBack();
      await page.waitForSelector('[data-ui="saved.remove"]');

      // 6. reachable from the profile menu; Remove frees it
      await page.click("#nav-profile");
      await page.locator(".nav-menu-item", { hasText: "On this device" }).waitFor();
      await page.keyboard.press("Escape");
      await page.click('[data-ui="saved.remove"]');
      await page.locator(".saved-empty").waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close().catch(() => {});
    }
  });
}

ui.run({ concurrency: 2 });

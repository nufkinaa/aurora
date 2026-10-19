// "Your files" on "On this device" (public/js/localview.js, localplay.js): any
// mix of videos, subtitles and folders from this computer or phone — one
// pick, one drop — becomes a small library: one card per title (a thumbnail
// from the video, the cleaned title, episodes grouped by show and season),
// each subtitle paired with its video by name, whether the file plays here
// told before Play, and Aurora's own player from object URLs — nothing is
// uploaded, no server is needed. Kept across reloads: the list itself (and in
// Chrome the files too, through their handles).
//
// The media is made here with ffmpeg: short MP4s (H.264 + AAC) — a film and
// two episodes of a show — a Hebrew + English SRT (UTF-8), a Hebrew SRT in
// Windows-1255, an English .ass, subtitles named every which way, an MKV
// whose video no browser decodes (MPEG-4 Part 2), one with AC-3 sound, a
// file that is not a video at all, and a folder of a film and a season.
// Screenshots land in test/ui/artifacts/local-play-*.png.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const assert = require("node:assert/strict");
const { suite, player, goto, signIn: seedSignIn, assertNoHorizontalOverflow, DESKTOP, PHONE, ARTIFACTS } = require("./helpers");

const RLM = "‏";
const SECONDS = 60;
const EP_SECONDS = 14;
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
const srtOf = (seconds, line) => {
  let srt = "";
  for (let i = 0, n = 1; i + 2 <= seconds; i += 2, n++) srt += `${n}\n${ts(i)} --> ${ts(i + 1.9)}\n${line} ${n}\n\n`;
  return srt;
};

const EP1 = "The.Office.US.S01E01.720p.WEB-DL.x264-GRP.mp4";
const EP2 = "The.Office.US.S01E02.720p.WEB-DL.x264-GRP.mp4";
const FILM = "Holiday.Film.2024.mp4";
const MEDIA_V = 4;
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
  const src = (pic, s) => ["-f", "lavfi", "-i", `${pic}=size=320x180:rate=25:duration=${s}`, "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${s}`];
  const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "25"];
  const aac = ["-c:a", "aac", "-b:a", "64k", "-ac", "2"];
  ff([...src("testsrc", SECONDS), ...h264, ...aac, "-movflags", "+faststart", "-shortest", path.join(dir, FILM)]);
  ff([...src("testsrc", SECONDS), "-c:v", "mpeg4", "-q:v", "8", ...aac, "-shortest", path.join(dir, "Old.Xvid.Rip.mkv")]);
  ff([...src("testsrc", SECONDS), ...h264, "-c:a", "ac3", "-b:a", "128k", "-ac", "2", "-shortest", path.join(dir, "Dolby.Sound.mkv")]);
  ff([...src("testsrc2", EP_SECONDS), ...h264, ...aac, "-movflags", "+faststart", "-shortest", path.join(dir, EP1)]);
  ff([...src("smptebars", EP_SECONDS), ...h264, ...aac, "-movflags", "+faststart", "-shortest", path.join(dir, EP2)]);
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
  // subtitles named every which way, for the episodes and the film
  fs.writeFileSync(path.join(dir, "The.Office.US.S01E01.720p.WEB-DL.x264-GRP.he.srt"), srtOf(EP_SECONDS, "פרק ראשון"), "utf-8");
  fs.writeFileSync(path.join(dir, "The Office - 1x02 - Hebrew.srt"), srtOf(EP_SECONDS, "פרק שני"), "utf-8");
  fs.writeFileSync(path.join(dir, "Holiday.Film.2024.en.forced.srt"), srtOf(SECONDS, "Forced English"), "utf-8");
  fs.writeFileSync(path.join(dir, "subs-from-a-friend.srt"), srtOf(EP_SECONDS, "Привет, как дела сегодня"), "utf-8");
  // bytes that are no video at all (a fixed seed: the same file every run)
  fs.writeFileSync(path.join(dir, "Not.A.Video.mp4"), crypto.createHash("sha512").update("aurora").digest().toString("hex").repeat(4000));
  // a folder: a film beside its Subs folder, a season by its folders, a
  // sample clip and a text file that are left out, a film with a Hebrew name
  const F = path.join(dir, "folder");
  const put = (rel, from, text) => {
    fs.mkdirSync(path.dirname(path.join(F, rel)), { recursive: true });
    if (from) fs.copyFileSync(path.join(dir, from), path.join(F, rel));
    else fs.writeFileSync(path.join(F, rel), text, "utf-8");
  };
  put("Some Movie (2020)/Some.Movie.2020.1080p.mp4", EP1);
  put("Some Movie (2020)/Subs/Hebrew.srt", null, srtOf(EP_SECONDS, "סרט בתיקייה"));
  put("Lost/Season 1/01 - Pilot.mp4", EP1);
  put("Lost/Season 1/02 - Walkabout.mp4", EP2);
  put("Lost/Season 1/sample.mp4", EP2);
  put("notes.txt", null, "not a video");
  put("סרט חג 2023.mp4", EP2);
  fs.writeFileSync(path.join(dir, ".ready"), new Date().toISOString());
  return dir;
};
const MEDIA = buildMedia();
const F = (name) => path.join(MEDIA, name);
const MANY = [EP2, FILM, EP1, "The.Office.US.S01E01.720p.WEB-DL.x264-GRP.he.srt", "The Office - 1x02 - Hebrew.srt", "Holiday.Film.2024.en.forced.srt", "subs-from-a-friend.srt"];

const ui = suite();

const shot = async (page, name) => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.waitForTimeout(700); // (a screen fades in: the picture after it)
  return page.screenshot({ path: path.join(ARTIFACTS, `local-play-${name}.png`) }).catch(() => {});
};
const setLook = (api, profile, look) => api.call("PUT", `/api/profiles/${profile.id}`, { look });

// Every request the page makes to the server, for the "nothing is uploaded" checks.
const recordRequests = (page, srv) => {
  const all = [];
  page.on("request", (req) => {
    if (!req.url().startsWith(srv.url)) return;
    all.push({ method: req.method(), url: req.url(), body: req.postData() || "" });
  });
  return all;
};
const nothingAbout = (reqs, words) => {
  const re = new RegExp(`${words.join("|")}|local-|/stream/|play-mark|/progress`);
  const bad = reqs.filter((r) => re.test(decodeURIComponent(r.url)) || words.some((w) => r.body.includes(w)) || r.body.length > 4000);
  assert.deepEqual(bad, [], `requests about the local files: ${JSON.stringify(bad).slice(0, 600)}`);
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

// ---------- the screen's side ----------
const card = (page, name) => page.locator(`.lf-card[data-key^="${name}|"]`);
// every card looked at (its length, its thumbnail, whether it plays)
const settled = (page, n) => page.waitForFunction((n) => {
  const cards = [...document.querySelectorAll(".lf-card")];
  return cards.length >= n && cards.every((c) => !["new", "checking"].includes(c.dataset.state));
}, n, { timeout: 30000 });
const addFiles = async (page, names, n = null) => {
  await page.waitForSelector(".lf-drop");
  await page.setInputFiles(".lf-input", names.map(F));
  if (n) await settled(page, n);
};
const playCard = async (page, name) => {
  await card(page, name).locator(".lf-play").click();
  await page.waitForSelector(".player video");
};
const pickAndPlay = async (page, video, subs = []) => {
  await addFiles(page, [video, ...subs], 1);
  await playCard(page, video);
};
const chips = (page, name) => card(page, name).locator(".lf-lang").allTextContents();
const showingCue = (page) => page.evaluate(() => {
  const t = [...document.querySelector(".player video").textTracks].find((x) => x.mode === "showing");
  return t ? { label: t.label, cue: t.activeCues && t.activeCues[0] ? t.activeCues[0].text : null, count: t.cues ? t.cues.length : 0 } : null;
});
const waitCue = (page, test = "true") => page.waitForFunction(new Function(`
  const t = [...document.querySelector(".player video").textTracks].find((x) => x.mode === "showing");
  const cue = t && t.activeCues && t.activeCues[0] ? t.activeCues[0].text : null;
  return !!cue && (${test});`));
const thumbsDrawn = (page) => page.evaluate(() => [...document.querySelectorAll(".lf-card")].map((c) => {
  const img = c.querySelector("img.lf-img");
  return { key: c.dataset.key.split("|")[0], w: img ? img.naturalWidth : 0, h: img ? img.naturalHeight : 0 };
}));

// ---------- many files at once ----------
for (const [name, viewport, look] of [["desktop", DESKTOP, "glass"], ["desktop-legacy", DESKTOP, "legacy"], ["phone", PHONE, "glass"], ["phone-legacy", PHONE, "legacy"]]) {
  ui.test(`${name}: three videos and four subtitles in one pick become a library — paired by name and episode, cleaned titles, the episodes in order, thumbnails, attach by hand, remove, add more without doubles, Next episode in the player`, { viewport }, async ({ page, srv, api, signIn, freshProfile }) => {
    const profile = await freshProfile();
    if (look === "legacy") await setLook(api, profile, "legacy");
    await signIn(profile);
    const reqs = recordRequests(page, srv);
    await goto(page, srv, "#/saved");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.look || "legacy"), look);
    // the empty page: a header, the big drop zone that is a button, the sections
    assert.match(await page.textContent(".browse-head h1"), /On this device/);
    const drop = page.locator(".lf-drop");
    assert.match(await drop.innerText(), viewport === PHONE ? /Choose videos and subtitles/ : /Drop videos and subtitles here/);
    assert.match(await drop.innerText(), /Nothing is uploaded/);
    assert.equal(await drop.evaluate((n) => n.tagName), "BUTTON");
    assert.match(await page.textContent(".saved-section"), /Saved for offline[\s\S]*Nothing saved for offline yet/);
    await assertNoHorizontalOverflow(page, `${name} empty`);
    await shot(page, `${name}-empty`);

    await addFiles(page, MANY, 3);
    // paired: by name with its flags, by the episode code, a forced one; one waits
    assert.deepEqual(await chips(page, EP1), ["HE"]);
    assert.deepEqual(await chips(page, EP2), ["HE"]);
    assert.deepEqual(await chips(page, FILM), ["EN forced"]);
    assert.equal(await page.locator(".lf-loose-row").count(), 1);
    assert.match(await page.textContent(".lf-loose-row"), /subs-from-a-friend\.srt[\s\S]*Russian/);
    // cleaned titles, the year kept, the show grouped by season, in episode order
    assert.match(await card(page, FILM).locator(".card-label").innerText(), /^Holiday Film$/);
    assert.match(await card(page, FILM).locator(".lf-meta").innerText(), /^2024 · 1:00 · /);
    assert.match(await page.locator('.lf-group[data-group^="the office us"] .lf-group-title').innerText(), /The Office US[\s\S]*Season 1 · 2 episodes/);
    const order = await page.locator('.lf-group[data-group^="the office us"] .lf-card').evaluateAll((cs) => cs.map((c) => c.dataset.key.split("|")[0]));
    assert.deepEqual(order, [EP1, EP2], "E1 before E2, whatever order they were picked in");
    assert.match(await card(page, EP2).locator(".card-label").innerText(), /The Office US\s*S1 E2/);
    assert.match(await card(page, EP2).locator(".lf-meta").innerText(), /^0:14 · /);
    // a thumbnail drawn from each video, poster-shaped; the card did not move when it came
    // (each card's state is settled; its thumbnail <img> may still be decoding)
    await page.waitForFunction(() => [...document.querySelectorAll(".lf-card")].every((c) => { const i = c.querySelector("img.lf-img"); return i && i.complete && i.naturalWidth > 0; }), null, { timeout: 30000 });
    for (const t of await thumbsDrawn(page)) assert.ok(t.w === 240 && t.h === 360, `thumbnail of ${t.key}: ${t.w}x${t.h}`);
    const box = await card(page, FILM).locator(".lf-play").boundingBox();
    assert.ok(Math.abs(box.height / box.width - 1.5) < 0.02, `a 2:3 card: ${box.width}x${box.height}`);
    if (viewport === PHONE) {
      const cols = await page.locator(".lf-grid").first().evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(" ").length);
      assert.equal(cols, 3, "three columns on a phone, as on Movies");
    }
    assert.equal(await page.textContent(".lf-count"), "3");
    await assertNoHorizontalOverflow(page, `${name} with files`);
    await shot(page, `${name}-library`);

    // attach the waiting one by hand: it lands on that card, the strip goes
    await page.selectOption(".lf-loose-row select", { label: "The Office US · S1 E1" });
    await page.waitForSelector(".lf-loose-row", { state: "detached" });
    assert.deepEqual(await chips(page, EP1), ["HE", "RU"]);

    // the ⋯ menu, by keyboard: opens, arrows move, Escape closes and gives the focus back
    const more = card(page, FILM).locator(".lf-more");
    await more.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".lf-menu[role=menu] .menu-item");
    assert.equal(await more.getAttribute("aria-expanded"), "true");
    const items = await page.locator(".lf-menu .menu-item").allInnerTexts();
    assert.deepEqual(items.map((t) => t.trim()), ["Play", "Add subtitles…", "Unpair English (forced) (Holiday.Film.2024.en.forced.srt)", "Remove from Your files"]);
    await page.keyboard.press("ArrowDown");
    assert.equal((await page.evaluate(() => document.activeElement.textContent)).trim(), "Add subtitles…");
    await shot(page, `${name}-menu`);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".lf-menu", { state: "detached" });
    assert.ok(await more.evaluate((n) => n === document.activeElement), "the focus is back on ⋯");

    // remove one (Undo is offered), then add everything again: nothing doubles
    await more.click();
    await page.locator(".lf-menu .menu-item", { hasText: "Remove from Your files" }).click();
    await card(page, FILM).waitFor({ state: "detached" });
    await page.locator("#toasts .toast", { hasText: "Removed “Holiday Film”" }).first().waitFor();
    assert.equal(await page.textContent(".lf-count"), "2");
    await addFiles(page, MANY, 3);
    assert.equal(await page.locator(".lf-card").count(), 3, "added again, de-duplicated by name and size");
    assert.deepEqual(await chips(page, EP1), ["HE", "RU"], "subtitles already paired are not paired twice");
    assert.deepEqual(await chips(page, FILM), ["EN forced"]);
    assert.equal(await page.locator(".lf-loose-row").count(), 0);

    // the first episode, then the next one from the player
    const ep2Id = await card(page, EP2).getAttribute("data-id");
    await playCard(page, EP1);
    await player.playing(page, { min: 0.3 });
    assert.equal((await page.textContent(".player .player-title")).trim(), "The Office US");
    assert.equal((await page.textContent(".player .player-subtitle")).trim(), "S1 E1 · Episode 1");
    await page.waitForSelector(`${player.ctrl("Next episode")}:not(.hidden)`, { state: "attached" });
    await player.tag(page);
    await player.press(page, "Next episode");
    await page.waitForFunction((id) => location.hash === `#/play/${id}?local=1`, ep2Id);
    await player.playing(page, { id: ep2Id, min: 0.3, fresh: true });
    assert.equal((await page.textContent(".player .player-subtitle")).trim(), "S1 E2 · Episode 2");
    await waitCue(page, "/פרק שני/.test(cue)");
    await shot(page, `${name}-next-episode`);

    // nothing about any of it went to the server
    nothingAbout(reqs, ["Office", "Holiday", "friend"]);
  });
}

// ---------- one drop: the page takes it anywhere, and folders ----------
ui.test("a drop anywhere on the page (a DataTransfer of files) adds them, with the page lit up while dragging; a picked folder is walked — subfolders, Subs, seasons by their folders, samples and other files left out, a Hebrew title right to left", async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto(page, srv, "#/saved");
  await page.waitForSelector(".lf-drop");
  // the files, as the browser hands them over in a drop
  await page.evaluate(() => { const i = document.createElement("input"); i.type = "file"; i.multiple = true; i.id = "test-files"; i.hidden = true; document.body.append(i); });
  await page.setInputFiles("#test-files", MANY.map(F));
  const lit = await page.evaluate(() => {
    const dt = new DataTransfer();
    for (const f of document.getElementById("test-files").files) dt.items.add(f);
    window.__fire = (type) => document.querySelector(".browse-head").dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    window.__fire("dragenter");
    window.__fire("dragover");
    return { veil: getComputedStyle(document.querySelector(".lf-veil")).display, drop: document.querySelector(".lf").classList.contains("dragging") };
  });
  assert.deepEqual(lit, { veil: "grid", drop: true });
  await shot(page, "desktop-dragging");
  const after = await page.evaluate(() => {
    window.__fire("drop");
    document.getElementById("test-files").remove();
    return document.querySelector(".lf").classList.contains("dragging");
  });
  assert.equal(after, false);
  await settled(page, 3);
  assert.deepEqual(await chips(page, EP2), ["HE"]);
  assert.deepEqual(await chips(page, FILM), ["EN forced"]);
  assert.equal(await page.locator(".lf-loose-row").count(), 1);

  // a folder, through the folder picker
  await page.setInputFiles(".lf-input-folder", path.join(MEDIA, "folder"));
  await settled(page, 7);
  const keys = await page.locator(".lf-card").evaluateAll((cs) => cs.map((c) => c.dataset.key.split("|")[0]));
  assert.ok(!keys.includes("sample.mp4"), "the sample clip is left out");
  assert.equal(keys.length, 7, keys.join(", "));
  assert.deepEqual(await chips(page, "Some.Movie.2020.1080p.mp4"), ["HE"], "a lone subtitle in the Subs folder beside a lone video");
  assert.match(await card(page, "Some.Movie.2020.1080p.mp4").locator(".card-label").innerText(), /^Some Movie$/);
  const lost = await page.locator('.lf-group[data-group^="lost"] .lf-card .card-label').allInnerTexts();
  assert.deepEqual(lost.map((t) => t.replace(/\s+/g, " ").trim()), ["Lost S1 E1 · Pilot", "Lost S1 E2 · Walkabout"]);
  const he = card(page, "סרט חג 2023.mp4");
  assert.equal(await he.locator(".lf-name").innerText(), "סרט חג");
  assert.equal(await he.locator(".lf-name").evaluate((n) => getComputedStyle(n).direction), "rtl");
  assert.match(await he.locator(".lf-meta").innerText(), /^2023 · /);
  await page.locator("#toasts .toast", { hasText: /Added 4 titles/ }).first().waitFor();
  await shot(page, "desktop-folder");
});

// ---------- kept across reloads ----------
ui.test("kept across a reload where the browser keeps no file: the cards stay (title, thumbnail, subtitles, resume) and ask for the file again — picked again, matched by name and size, it resumes with its subtitles", async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  // the browser of a Firefox or a Safari: no file handles to keep
  await page.addInitScript(() => { delete window.showOpenFilePicker; delete window.showDirectoryPicker; try { delete DataTransferItem.prototype.getAsFileSystemHandle; } catch {} });
  await goto(page, srv, "#/saved");
  await pickAndPlay(page, FILM, ["Holiday.Film.2024.he.srt", "Holiday.Film.2024.en.ass"]);
  await player.playing(page, { min: 0.3 });
  await player.jump(page, 20);
  await page.waitForFunction(() => document.querySelector(".player video").currentTime >= 20.5);
  await player.press(page, "Back");
  await page.waitForSelector(".lf-card");
  // a new visit: the list is there, the file is not
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('.lf-card[data-state="missing"]', { timeout: 15000 });
  const c = card(page, FILM);
  assert.equal(await c.getAttribute("data-state"), "missing");
  assert.equal(await c.locator(".lf-tag").getAttribute("data-t"), "PICK AGAIN");
  assert.deepEqual(await chips(page, FILM), ["HE", "EN"], "the pairing is kept");
  assert.equal((await thumbsDrawn(page))[0].w, 240, "the thumbnail is kept");
  assert.ok(await c.locator(".card-progress").count(), "the resume bar is kept");
  assert.match(await c.locator(".lf-play").getAttribute("aria-label"), /pick the file again to keep watching/);
  await shot(page, "desktop-pick-again");
  // the card asks for the file; the same name and size is the same title
  const chooser = page.waitForEvent("filechooser");
  await c.locator(".lf-play").click();
  await (await chooser).setFiles(F(FILM));
  await page.waitForSelector(".player video");
  await player.playing(page, { min: 10 });
  const t = await page.evaluate(() => document.querySelector(".player video").currentTime);
  assert.ok(t >= 14 && t < 24, `resumed near 20 s: ${t}`);
  await waitCue(page);
  assert.equal((await showingCue(page)).label, "Hebrew · Holiday.Film.2024.he.srt");
  // a reload ON the player: back to the screen, without an error — "pick it again"
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".lf-card", { timeout: 15000 });
  assert.match(page.url(), /#\/saved$/);
  await page.locator("#toasts .toast", { hasText: "pick it again" }).first().waitFor();
});

ui.test("kept across a reload in Chrome: files from a drop (their handles) and from the file picker reopen by themselves and play — no picking again", async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto(page, srv, "#/saved");
  await page.waitForSelector(".lf-drop");
  // real file handles: the page's own private folder (the browser grants it always)
  await page.evaluate(() => { const i = document.createElement("input"); i.type = "file"; i.multiple = true; i.id = "test-files"; i.hidden = true; document.body.append(i); });
  await page.setInputFiles("#test-files", [F(EP1), F(EP2), F("The Office - 1x02 - Hebrew.srt"), F(FILM)]);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const show = await root.getDirectoryHandle("Dropped Show", { create: true });
    const season = await show.getDirectoryHandle("Season 2", { create: true });
    const files = [...document.getElementById("test-files").files];
    const write = async (dir, name, f) => { const h = await dir.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(f); await w.close(); return h; };
    await write(season, "01.mp4", files[0]);
    await write(season, "02.mp4", files[1]);
    await write(season, "02.he.srt", files[2]);
    window.__filmHandle = await write(root, files[3].name, files[3]);
    document.getElementById("test-files").remove();
    // a folder dropped: the browser hands over its handle
    const item = { kind: "file", getAsFileSystemHandle: async () => show, webkitGetAsEntry: () => null, getAsFile: () => null };
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { types: ["Files"], items: [item], files: [] } });
    document.body.dispatchEvent(ev);
    // and a file through the browser's own picker
    window.showOpenFilePicker = async () => [window.__filmHandle];
  });
  await settled(page, 2);
  await page.click(".lf-add");
  await settled(page, 3);
  assert.deepEqual((await page.locator('.lf-group[data-group^="dropped show"] .lf-card .card-label').allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()), ["Dropped Show S2 E1", "Dropped Show S2 E2"]);
  assert.deepEqual(await chips(page, "02.mp4"), ["HE"]);
  // a fresh load: every card is ready again by itself, and plays
  await page.reload({ waitUntil: "domcontentloaded" });
  await settled(page, 3);
  const states = await page.locator(".lf-card").evaluateAll((cs) => cs.map((c) => c.dataset.state));
  assert.deepEqual(states, ["ok", "ok", "ok"]);
  assert.equal(await page.locator(".lf-reconnect.hidden").count(), 1, "nothing to reconnect");
  await playCard(page, "02.mp4");
  await player.playing(page, { min: 0.5 });
  await waitCue(page, "/פרק שני/.test(cue)");
  await player.press(page, "Back");
  await playCard(page, FILM);
  await player.playing(page, { min: 0.5 });
});

// ---------- the first version's checks, through the new screen ----------
for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`${name}: a video and its subtitles from this device play in Aurora's player — cues above the dock, Hebrew right to left, the delay buttons, nothing sent to the server`, { viewport }, async ({ page, srv, signIn, freshProfile }) => {
    await signIn(await freshProfile());
    const reqs = recordRequests(page, srv);
    await goto(page, srv, "#/saved");
    assert.match(await page.locator(".lf").innerText(), /Your files/);
    assert.match(await page.locator(".lf").innerText(), /Nothing is uploaded — your files play straight from this device/);
    await addFiles(page, [FILM, "Holiday.Film.2024.he.srt", "Holiday.Film.2024.heb.srt", "Holiday.Film.2024.en.ass"], 1);
    assert.deepEqual(await chips(page, FILM), ["HE", "HE", "EN"]);
    assert.equal(await card(page, FILM).getAttribute("data-state"), "ok", "it plays here — known before Play");
    const before = reqs.length;
    await playCard(page, FILM);
    await player.playing(page, { min: 0.5 });

    // the player, with what needs a server left out
    assert.match(page.url(), /#\/play\/local-[a-z0-9]+\?local=1$/);
    assert.equal((await page.textContent(".player .player-title")).trim(), "Holiday Film");
    assert.equal((await page.textContent(".player .player-subtitle")).trim(), "2024");
    assert.equal(await page.locator(".player .local-badge").count(), 1);
    for (const gone of ["Watch together", "AirPlay", "X-Ray", "Next episode"]) assert.equal(await page.locator(`${player.ctrl(gone)}:not(.hidden)`).count(), 0, `${gone} is not offered for a local film`);
    for (const there of ["Subtitles", "Settings", "Fullscreen", "Back 10 seconds", "Forward 10 seconds"]) assert.equal(await page.locator(player.ctrl(there)).count(), 1, `${there} is there`);
    assert.match(await page.evaluate(() => document.querySelector(".player video").currentSrc), /^blob:/);
    if (name === "desktop") {
      await page.waitForTimeout(3000);
      assert.equal(await page.locator("#toasts .toast", { hasText: "No sound" }).count(), 0);
    }

    // the first subtitle picked with it is on, Hebrew over English
    await waitCue(page);
    const s = await showingCue(page);
    assert.equal(s.label, "Hebrew · Holiday.Film.2024.he.srt");
    assert.ok(s.cue.startsWith(`${RLM}מה שלומך היום?`), JSON.stringify(s.cue));
    assert.match(s.cue, /\nHow are you today\? \d+$/);

    // the menu: every track by language and file, no Resync, the timing row
    const items = await player.menu(page, "Subtitles");
    const texts = items.map((i) => i.text);
    assert.ok(!texts.some((t) => /Resync/.test(t)), `no Resync for a local file: ${texts.join(" | ")}`);
    assert.deepEqual(texts.filter((t) => / · /.test(t)), ["Hebrew · Holiday.Film.2024.he.srt", "Hebrew · Holiday.Film.2024.heb.srt", "English · Holiday.Film.2024.en.ass"]);
    await shot(page, `${name}-subtitle-menu`);

    // the delay buttons move the cues
    const cueStart = () => page.evaluate(() => {
      const t = [...document.querySelector(".player video").textTracks].find((x) => x.mode === "showing");
      return [...t.cues].find((c) => /היום\? 6‏?\n/.test(c.text)).startTime;
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
    nothingAbout(reqs.slice(before), ["Holiday"]);
  });
}

ui.test("the place a file was left is kept on this device: its card shows how far, and opening it again resumes there", async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto(page, srv, "#/saved");
  await pickAndPlay(page, FILM);
  await player.playing(page, { min: 0.3 });
  await player.jump(page, 15);
  await page.waitForFunction(() => document.querySelector(".player video").currentTime >= 15.5);
  await player.press(page, "Back");
  await page.waitForSelector(".lf-card");
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("aurora-local-positions") || "{}"));
  const entry = Object.entries(kept).find(([k]) => k.startsWith(`${FILM}|`));
  assert.ok(entry && entry[1].position >= 15, `position kept by name and size: ${JSON.stringify(kept)}`);
  const bar = await card(page, FILM).locator(".card-progress > div").evaluate((n) => parseFloat(n.style.width));
  assert.ok(bar > 20 && bar < 40, `the resume bar: ${bar}%`);
  await playCard(page, FILM);
  await player.playing(page, { min: 10 });
  const t = await page.evaluate(() => document.querySelector(".player video").currentTime);
  assert.ok(t >= 10 && t < 18, `resumed near 15 s (four seconds early): ${t}`);
  assert.match(await page.locator(".player .resume-pill").innerText(), /Resumed at 0:1\d/);
});

ui.test("a file this browser can't play says so on its card before Play — and the player says why, never a broken player", async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto(page, srv, "#/saved");
  await addFiles(page, ["Not.A.Video.mp4", "Old.Xvid.Rip.mkv", "Dolby.Sound.mkv", FILM], 4);
  // found before pressing play
  assert.equal(await card(page, "Not.A.Video.mp4").getAttribute("data-state"), "refused");
  assert.equal(await card(page, "Not.A.Video.mp4").locator(".lf-tag").getAttribute("data-t"), "WON'T PLAY");
  assert.match(await card(page, "Not.A.Video.mp4").locator(".lf-play").getAttribute("title"), /^This browser can't play this file\./);
  assert.equal(await card(page, "Old.Xvid.Rip.mkv").getAttribute("data-state"), "novideo");
  assert.match(await card(page, "Old.Xvid.Rip.mkv").locator(".lf-play").getAttribute("title"), /MPEG-4 Part 2 \(Xvid\/DivX\)/);
  const dolby = await card(page, "Dolby.Sound.mkv").getAttribute("data-state");
  assert.ok(["noaudio", "refused", "ok"].includes(dolby), dolby);
  if (dolby !== "ok") assert.match(await card(page, "Dolby.Sound.mkv").locator(".lf-play").getAttribute("title"), /AC-3/);
  assert.equal(await card(page, FILM).getAttribute("data-state"), "ok");
  await shot(page, "desktop-unplayable-cards");
  // and pressing play anyway: the sentence
  await playCard(page, "Not.A.Video.mp4");
  await page.waitForSelector(".player .player-error");
  assert.equal((await page.textContent(".player .player-error h3")).trim(), "Can't play this file here");
  assert.match(await page.textContent(".player .player-error p"), /^This browser can't play this file\. A \.mp4 with H\.264 video and AAC sound plays in every browser/);
  assert.equal(await page.locator('.player .player-error [data-ui="player.retry"]').count(), 0, "no Try again: nothing would change");
  await shot(page, "desktop-unplayable");
  await page.click(".player .player-error .btn-primary");
  await page.waitForSelector(".lf-card");
  await playCard(page, "Old.Xvid.Rip.mkv");
  await page.waitForSelector(".player .player-error", { timeout: 15000 });
  assert.match(await page.textContent(".player .player-error p"), /can't play this file's video \(MPEG-4 Part 2 \(Xvid\/DivX\)\)/);
  await page.click(".player .player-error .btn-primary");
  await page.waitForSelector(".lf-card");
  // H.264 picture, AC-3 sound: the browser either plays it silently (a note says
  // why) or refuses the file (the card says why) — AC-3 named either way
  await playCard(page, "Dolby.Sound.mkv");
  const said = page.locator("#toasts .toast", { hasText: "No sound" }).or(page.locator(".player .player-error p"));
  await said.first().waitFor({ timeout: 20000 });
  assert.match(await said.first().innerText(), /AC-3/);
});

ui.test("with the server out of reach after the app loaded, files still go in and play — with their subtitles", { allow: [/Failed to load resource/, /ERR_INTERNET_DISCONNECTED/, /WebSocket/] }, async ({ page, context, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto(page, srv, "#/saved");
  // (the screen fetches the player's code as it appears — the reason a dropped
  // connection after this point still plays)
  await page.waitForFunction(() => performance.getEntriesByType("resource").some((e) => /\/js\/screens\/player\.js/.test(e.name) && e.responseEnd > 0));
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  await addFiles(page, MANY, 3);
  assert.deepEqual(await chips(page, EP2), ["HE"]);
  await playCard(page, EP2);
  await player.playing(page, { min: 1 });
  await waitCue(page, "/פרק שני/.test(cue)");
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
  await page.waitForSelector(".lf-drop");
  assert.match(page.url(), /#\/saved$/);
});

// ---------- the service worker: the whole app from its cache, no server ----------
// (the suite's contexts block service workers; this one has its own)
ui.test("fully offline: the worker's precache holds the player and every module of Your files, and a fresh load with no server still adds files and plays one", { allow: [/Failed to load resource/, /ERR_INTERNET_DISCONNECTED/, /WebSocket/] }, async ({ srv, freshProfile }) => {
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
    await page.waitForSelector(".lf-drop");
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
      for (const p of ["/js/localplay.js", "/js/localview.js", "/js/localnames.js", "/js/localsubs.js", "/js/screens/player.js", "/js/screens/saved.js", "/js/main.js", "/"]) out[p] = !!(await c.match(p));
      out.keys = (await c.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
      return out;
    });
    const keys = cached.keys;
    delete cached.keys;
    for (const [p, ok] of Object.entries(cached)) assert.ok(ok, `${p} is in the worker's precache (it holds ${keys.length}: ${keys.slice(0, 80).join(" ")})`);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".lf-drop", { timeout: 30000 });
    await shot(page, "desktop-offline-fresh-load");
    await page.setInputFiles(".lf-input", MANY.map(F));
    await settled(page, 3);
    await playCard(page, EP1);
    await player.playing(page, { min: 1 });
    await waitCue(page, "/פרק ראשון/.test(cue)");
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
  ui.test(`${name}: on this device, online — a save shows its progress under Saving now, outlives leaving the page and a reload (Resume), fails with Retry, and the copy plays from the device`, async ({ srv, freshProfile }) => {
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
      assert.match(await page.textContent(".device-jobs .row-title"), /Saving now/);
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
      await page.evaluate(() => { location.hash = "#/saved"; });
      await jobRow(page, "saving").waitFor();
      await shot(page, `${name}-device-saving`);

      // 3. a reload cuts it off: "Interrupted", with Resume
      await page.reload({ waitUntil: "domcontentloaded" });
      release();
      await page.unroute("**/stream/video/**");
      await page.unroute("**/offline/file/**");
      await jobRow(page, "interrupted").waitFor();
      assert.match(await jobRow(page, "interrupted").innerText(), /Interrupted[\s\S]*the page was closed or reloaded[\s\S]*Resume starts it again/);
      await jobRow(page, "interrupted").locator("button", { hasText: "Resume" }).click();

      // 4. done: the row goes, the title is in the list, with its size and Remove
      await page.locator(".dl-row", { hasText: film.title }).locator('[data-ui="saved.play"]').waitFor({ timeout: 60000 });
      assert.equal(await page.locator(".device-job").count(), 0);
      assert.match(await page.textContent(".saved-head"), /Saved for offline\s*1/);
      await shot(page, `${name}-device-saved`);

      // 5. played from the device while the server is right there
      const streamed = [];
      page.on("request", (r) => { if (/\/stream\//.test(r.url())) streamed.push(r.url()); });
      await page.locator('[data-ui="saved.play"]').first().click();
      await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 0.5; }, null, { timeout: 30000 });
      assert.match(await page.evaluate(() => document.querySelector(".player video").currentSrc), /\/offline\/media\//);
      assert.deepEqual(streamed, [], "nothing streamed from the server");
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

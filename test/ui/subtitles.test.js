// Subtitles in the website player, as the household reported them broken
// (the admin inbox, 2026-10):
//   "subs appear behind the timeline on the video and not above it"
//   "subs sync btn does not work"
//   "embedded tracks show up as track 1 and track 2 and not by language"
//   "subs are almost always out of sync"
// Where a cue is DRAWN is read from Chrome's own cue boxes (the user-agent
// shadow DOM, through the DevTools protocol) — the only honest answer, since
// a page cannot see them. Timing is measured from presented frames by the
// subtitle rig (tools/subs-rig): films whose frames carry their own time.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const assert = require("node:assert/strict");
const { suite, player, DESKTOP, PHONE } = require("./helpers");
const rigMedia = require("../../tools/subs-rig/media");
const { measure } = require("../../tools/subs-rig/sampler");

const ffmpegPath = () => {
  const win = process.platform === "win32";
  const r = spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { encoding: "utf-8" });
  return process.env.FFMPEG_PATH || (r.stdout || "").split(/\r?\n/)[0].trim();
};

// An MKV whose two text tracks carry NO language tag (what 209 tracks of the
// real library look like): one English, one Hebrew, told apart only by the text.
const UNTAGGED = "Untagged Tracks (2034)";
const buildUntagged = (dir, ffmpeg) => {
  const d = path.join(dir, UNTAGGED);
  const file = path.join(d, `${UNTAGGED}.mkv`);
  if (fs.existsSync(file)) return d;
  fs.mkdirSync(d, { recursive: true });
  const lines = {
    en: ["I don't know what you want from me.", "We have to go now, it's late.", "Is that what you think? You were there.", "This is not the way it was supposed to be."],
    he: ["אני לא יודע מה אתה רוצה ממני.", "אנחנו חייבים ללכת עכשיו, כבר מאוחר.", "זה מה שאתה חושב? היית שם.", "זה לא היה אמור להיות ככה."],
  };
  const srt = (k) => Array.from({ length: 24 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, "0")},100 --> 00:00:${String(i).padStart(2, "0")},900\n${lines[k][i % 4]}\n`).join("\n");
  fs.writeFileSync(path.join(dir, "u-en.srt"), srt("en"));
  fs.writeFileSync(path.join(dir, "u-he.srt"), srt("he"));
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=gray:size=160x90:rate=10:duration=25",
    "-i", path.join(dir, "u-en.srt"), "-i", path.join(dir, "u-he.srt"),
    "-map", "0:v", "-map", "1:0", "-map", "2:0", "-c:v", "libx264", "-preset", "ultrafast", "-c:s", "srt", file], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  return d;
};

// An MKV with its own English track and a Hebrew sidecar timed 3.4 s late (a
// provider's file made for another release): the server lines the sidecar up
// against the embedded track in the background and serves it in time.
const OFFSET = "Offset Sidecar (2035)";
const dialogue = (n, shift = 0, text = (i) => `line ${i}`) => {
  let x = 11;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const cues = [];
  let t = 2;
  for (let i = 0; i < n; i++) {
    const len = 0.8 + rnd() * 1.6;
    cues.push([t + shift, t + len + shift, text(i)]);
    t += len + 0.2 + rnd() * 1.5;
  }
  const ts = (v) => {
    const ms = Math.round(v * 1000);
    return `00:${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return { srt: cues.map(([a, b, tx], i) => `${i + 1}\n${ts(a)} --> ${ts(b)}\n${tx}\n`).join("\n"), first: cues[0][0], end: t };
};
const buildOffset = (dir, ffmpeg) => {
  const d = path.join(dir, OFFSET);
  const file = path.join(d, `${OFFSET}.mkv`);
  if (fs.existsSync(file)) return d;
  fs.mkdirSync(d, { recursive: true });
  const en = dialogue(120, 0, (i) => `English line number ${i}`);
  fs.writeFileSync(path.join(dir, "o-en.srt"), en.srt);
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=gray:size=160x90:rate=10:duration=${Math.ceil(en.end + 5)}`, "-i", path.join(dir, "o-en.srt"),
    "-map", "0:v", "-map", "1:0", "-c:v", "libx264", "-preset", "ultrafast", "-c:s", "srt", "-metadata:s:s:0", "language=eng", file], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  fs.writeFileSync(path.join(d, `${OFFSET}.Hebrew.srt`), dialogue(120, 3.4, (i) => `שורה מספר ${i} בעברית`).srt);
  return d;
};

const ui = suite({
  setup: async (srv) => {
    const ffmpeg = ffmpegPath();
    const dir = rigMedia.build(path.join(__dirname, ".cache", "subs-rig"), ffmpeg);
    fs.cpSync(path.join(dir, "movies"), srv.library.movies, { recursive: true });
    fs.cpSync(buildUntagged(path.join(__dirname, ".cache", "subs-untagged"), ffmpeg), path.join(srv.library.movies, UNTAGGED), { recursive: true });
    fs.cpSync(buildOffset(path.join(__dirname, ".cache", "subs-offset"), ffmpeg), path.join(srv.library.movies, OFFSET), { recursive: true });
    await srv.api.rescan();
    const deadline = Date.now() + 60000;
    for (;;) {
      const lib = await srv.api.library();
      const want = [...Object.values(rigMedia.TITLES).map((t) => t.title), "Offset Sidecar", "Untagged Tracks"];
      const ours = want.map((t) => lib.movies.find((m) => m.title === t));
      if (lib.enriched && ours.every((m) => m && m.duration > 0)) {
        srv.rig = {};
        for (const [k, t] of Object.entries(rigMedia.TITLES)) srv.rig[k] = await srv.api.item(lib.movies.find((m) => m.title === t.title).id);
        srv.rig.untagged = ours[ours.length - 1];
        srv.rig.offset = ours[ours.length - 2];
        if (srv.rig.jit.subtitles.some((s) => s.embedded) && srv.rig.late.subtitles.some((s) => s.embedded)) break;
      }
      if (Date.now() > deadline) throw new Error("the subtitle films never finished probing");
      await new Promise((r) => setTimeout(r, 300));
    }
  },
});

// ---------- where a cue is drawn ----------
// Chrome's cue boxes, through the user-agent shadow root: [{top, bottom}] in CSS px.
const cueBoxes = async (page) => {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const ids = [];
    const walk = (n) => {
      const a = n.attributes || [];
      const i = a.indexOf("pseudo");
      if (i >= 0 && a[i + 1] === "cue") ids.push(n.backendNodeId);
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
    };
    walk(root);
    const out = [];
    for (const id of ids) {
      try {
        const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: id });
        out.push({ top: model.border[1], bottom: model.border[5] });
      } catch {}
    }
    return out;
  } finally {
    await cdp.detach().catch(() => {});
  }
};
const dockTop = (page) => page.evaluate(() => document.querySelector(".player .player-bottom").getBoundingClientRect().top);
const controlsShown = (page) => page.evaluate(() => !document.querySelector(".player").classList.contains("controls-hidden"));

// Film One paused on a cue, the controls up: the cue's box must end above the dock.
const pauseOnCue = async (page, at = 10.5) => {
  await page.evaluate((at) => { const v = document.querySelector(".player video"); v.pause(); v.currentTime = at; }, at);
  await page.waitForFunction(() => {
    const t = [...document.querySelector(".player video").textTracks].find((x) => x.mode === "showing");
    return t && t.activeCues && t.activeCues.length > 0;
  });
};
const waitCueAbove = (page, limit) =>
  page.waitForFunction(() => true).then(async () => {
    const deadline = Date.now() + 5000;
    let boxes = [];
    while (Date.now() < deadline) {
      boxes = await cueBoxes(page);
      if (boxes.length && boxes.every((b) => b.bottom <= limit)) return boxes;
      await page.waitForTimeout(150);
    }
    return boxes;
  });

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE], ["phone-landscape", { width: 844, height: 390 }]]) {
  ui.test(`${name}: with the controls up a cue sits ABOVE the timeline, one line or two; hidden, it goes back down`, { viewport }, async ({ page, srv, signIn, freshProfile, lib }) => {
    await signIn(await freshProfile());
    await player.open(page, srv, lib.film1.id);
    await player.pick(page, "Subtitles", "English");
    await page.keyboard.press("Escape");
    await pauseOnCue(page);
    await player.wake(page);
    assert.ok(await controlsShown(page));
    const top = await dockTop(page);
    const boxes = await waitCueAbove(page, top);
    assert.ok(boxes.length > 0, "a cue is drawn");
    for (const b of boxes) assert.ok(b.bottom <= top, `cue box ends at ${b.bottom.toFixed(1)}px, the dock begins at ${top.toFixed(1)}px`);
    await page.screenshot({ path: path.join(__dirname, "artifacts", `subtitles-lift-${name}.png`) }).catch(() => {});

    // a two-line cue (a longer line of dialogue) clears the dock too
    await page.evaluate(() => {
      const v = document.querySelector(".player video");
      const t = [...v.textTracks].find((x) => x.mode === "showing");
      const c = t.activeCues[0];
      t.removeCue(c);
      c.text = "A first line of dialogue\nand a second one under it";
      c.line = "auto"; // as a file gives it
      t.addCue(c);
      v.currentTime = v.currentTime + 0.001; // the lift re-aims cues as they change
    });
    await player.wake(page);
    const boxes2 = await waitCueAbove(page, await dockTop(page));
    for (const b of boxes2) assert.ok(b.bottom <= (await dockTop(page)), `two-line cue ends at ${b.bottom.toFixed(1)}px`);

    // the controls go away: the cue drops back to the foot of the picture
    // (measured while it plays — a pause would bring the controls back)
    await page.evaluate(() => document.querySelector(".player video").play());
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => document.querySelector(".player").classList.contains("controls-hidden"), null, { timeout: 15000 });
    let low = [];
    for (let i = 0; i < 30 && !low.length; i++) { low = await cueBoxes(page); if (!low.length) await page.waitForTimeout(100); }
    assert.ok(await page.evaluate(() => document.querySelector(".player").classList.contains("controls-hidden")));
    assert.ok(low.length, "a cue is drawn with the controls hidden");
    assert.ok(low[0].bottom > top, `with the controls hidden the cue is back near the bottom (${low[0].bottom.toFixed(0)}px, the dock began at ${top.toFixed(0)}px)`);
  });
}

// ---------- the timing buttons ----------
const firstCueStart = (page, label) => page.evaluate((label) => {
  const t = [...document.querySelector(".player video").textTracks].find((x) => x.label === label);
  const c = t && t.cues && [...t.cues].find((x) => x.text === "EN cue 6");
  return c ? c.startTime : null;
}, label);

ui.test("the timing buttons move the cues at once, the delay is remembered for that title and track, and Reset forgets it", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  await player.pick(page, "Subtitles", "English");
  await page.waitForFunction(() => { const t = [...document.querySelector(".player video").textTracks].find((x) => x.label === "English"); return t && t.cues && t.cues.length > 5; });
  assert.equal(await firstCueStart(page, "English"), 10, "cue 6 begins at 10 s in the file");

  await player.menu(page, "Subtitles");
  await page.click('.player .menu [aria-label="Subtitles later"]');
  await page.click('.player .menu [aria-label="Subtitles later"]');
  assert.equal((await page.textContent(".player .menu .sub-sync .tag")).trim(), "+1.0s");
  assert.equal(await firstCueStart(page, "English"), 11, "+1.0 s, applied to the cues at once");
  // no toast on top of the buttons while the menu shows the value itself
  assert.equal(await page.locator("#toasts .toast", { hasText: "Subtitle delay" }).count(), 0);
  await page.keyboard.press("Escape");

  // a fresh page: the same title and track come back with the delay
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".player video");
  await player.playing(page, { min: 0.2 });
  await player.pick(page, "Subtitles", "English");
  await page.waitForFunction(() => {
    const t = [...document.querySelector(".player video").textTracks].find((x) => x.label === "English");
    const c = t && t.cues && [...t.cues].find((x) => x.text === "EN cue 6");
    return c && Math.abs(c.startTime - 11) < 0.001;
  }, null, { timeout: 10000 });
  await page.waitForSelector("#toasts .toast >> text=as you left it");
  assert.equal((await player.menu(page, "Subtitles")).length > 0, true);
  assert.equal((await page.textContent(".player .menu .sub-sync .tag")).trim(), "+1.0s");
  // …the other track is not touched
  await page.click('.player .menu [aria-label="Reset subtitle timing"]');
  assert.equal(await firstCueStart(page, "English"), 10);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("aurora-subdelay") || "{}"));
  assert.deepEqual(Object.keys(stored), [], "Reset forgets it");
  await page.keyboard.press("Escape");
});

ui.test("the timing buttons work on the repackaged (hls.js) stream as well", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film2.id);
  await player.pick(page, "Subtitles", "English");
  await page.waitForFunction(() => { const t = [...document.querySelector(".player video").textTracks].find((x) => x.label === "English"); return t && t.cues && t.cues.length > 5; });
  const before = await firstCueStart(page, "English");
  await player.menu(page, "Subtitles");
  await page.click('.player .menu [aria-label="Subtitles 5 seconds earlier"]');
  await page.keyboard.press("Escape");
  const after = await firstCueStart(page, "English");
  assert.ok(Math.abs(after - (before - 5)) < 0.001, `${before} -> ${after}`);
});

// ---------- names ----------
ui.test("tracks the file left untagged are named by the language of their text", async ({ srv }) => {
  const deadline = Date.now() + 60000;
  let labels = [];
  while (Date.now() < deadline) {
    const it = await srv.api.item(srv.rig.untagged.id);
    labels = (it.subtitles || []).map((t) => [t.label, t.lang || null]);
    if (labels.length === 2 && labels.every(([, l]) => l)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.deepEqual(labels, [["English", "en"], ["Hebrew", "he"]]);
});

ui.test("embedded tracks carry their language code and the menu names them by it", async ({ page, srv, signIn, freshProfile, lib }) => {
  const it = await srv.api.item(lib.film2.id);
  assert.deepEqual(it.subtitles.map((t) => [t.label, t.lang, !!t.embedded]), [["English", "en", true], ["Hebrew", "he", true]]);
  assert.deepEqual(it.audioTracks.map((t) => t.label), ["English", "Hebrew"]);
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film2.id);
  const items = (await player.menu(page, "Subtitles")).filter((i) => !/Resync/.test(i.text));
  assert.deepEqual(items.map((i) => i.text), ["Off", "English", "Hebrew"]);
});

ui.test("a sidecar timed for another release is lined up against the video's own track, without touching the file", async ({ srv }) => {
  const it = await srv.api.item(srv.rig.offset.id);
  const he = it.subtitles.find((t) => t.label === "Hebrew");
  assert.ok(he, JSON.stringify(it.subtitles));
  const first = (vtt) => {
    const m = /(\d{2}):(\d{2}):(\d{2})\.(\d{3}) -->/.exec(vtt);
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : null;
  };
  const deadline = Date.now() + 60000;
  let res;
  let text = "";
  while (Date.now() < deadline) {
    res = await fetch(srv.url + he.url);
    text = await res.text();
    if (res.headers.get("x-aurora-subtitle-repair")) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.match(res.headers.get("x-aurora-subtitle-repair") || "", /constant offset/);
  assert.ok(Math.abs(first(text) - 2) < 0.06, `first cue at ${first(text)} s, should be 2.0 (was 5.4 in the file)`);
  const onDisk = fs.readFileSync(path.join(srv.library.movies, OFFSET, `${OFFSET}.Hebrew.srt`), "utf-8");
  assert.match(onDisk, /^1\n00:00:05,400 -->/, "the file itself is left as it was");
});

// ---------- timing, path by path (tools/subs-rig) ----------
const timed = async (page, srv, { key, kind, block = false, resume = 0 }, signIn, freshProfile) => {
  const item = srv.rig[key];
  const track = item.subtitles.find((s) => (kind === "embedded" ? s.embedded : !s.embedded));
  if (block) await page.context().route(/\/stream\/transcode\/[^/]+\/jit\//, (r) => r.fulfill({ status: 500, body: "refused by the test" }).catch(() => {}));
  const me = await freshProfile();
  if (resume) await srv.api.setProgress(me, item.id, resume, item.duration);
  await signIn(me);
  await player.open(page, srv, item.id, { min: 0.2 });
  await player.pick(page, "Subtitles", track.label);
  await page.keyboard.press("Escape");
  await page.mouse.move(3, 3);
  await page.waitForTimeout(1200);
  return page.evaluate(measure, { label: track.label, frames: 25 });
};
for (const sc of [
  { name: "the file itself, sidecar", key: "direct", kind: "sidecar" },
  { name: "the repackaged stream, embedded track", key: "jit", kind: "embedded" },
  { name: "a file whose clock starts at 1.5 s, resumed on the offset copy job, embedded track", key: "late", kind: "embedded", block: true, resume: 47 },
  { name: "a file whose clock starts at 1.5 s, resumed on the offset copy job, sidecar", key: "late", kind: "sidecar", block: true, resume: 47 },
]) {
  ui.test(`in time: ${sc.name}`, { allow: [/refused by the test|status of 500/] }, async ({ page, srv, signIn, freshProfile }) => {
    const r = await timed(page, srv, sc, signIn, freshProfile);
    assert.ok(!r.error, r.error);
    assert.ok(Math.abs(r.err) <= 0.15, `cues ${r.err >= 0 ? "late" : "early"} by ${Math.abs(r.err).toFixed(2)} s (n ${r.n}, at ${r.at} s)`);
    if (sc.resume) assert.ok(r.at > sc.resume - 10, `resumed (measured at ${r.at} s)`);
  });
}

ui.run({ concurrency: 1 });

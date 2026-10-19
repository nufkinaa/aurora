// The subtitle Resync button that REALLY syncs (2026-10-17):
//   "Subs resync btn: this btn was broken because it did not use a real
//    method of trying to match what was said to a text in the subs track…
//    it needs to really sync the subs." (the owner)
// and the menu's ★ — one track per language, "Matches this release".
//
// A generated film whose sound has voice-like bursts (a buzzing pitch with
// syllable-rate swells) at known times, with a burst of noise and a held
// music chord in between where nobody talks. Its subtitles:
//   English    inside the file, exactly on the bursts
//   Hebrew     a sidecar 2.6 s LATE (made for another release)
//   Hebrew 2   a sidecar of another film's lines (matches nothing)
// The server listens for real (ffmpeg → media/speech.js → media/vad.js) and
// lines the cues up (media/audiosync.js); nothing is stubbed.
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

const TITLE = "Talking Film (2036)";
const LATE = 2.6;
const RATE = 16000;
const DUR = 240;
const QUIET = [[96, 118], [168, 172]]; // a held chord, a burst of noise: nobody talks

const seeded = (seed) => {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
};
// the lines: 1-3 s each, 0.5-3 s apart, none in the quiet stretches
const linesOf = (seed, from = 4) => {
  const rnd = seeded(seed);
  const out = [];
  let t = from;
  while (t < DUR - 8) {
    const len = 1 + rnd() * 2;
    const q = QUIET.find(([a, b]) => t + len > a - 0.5 && t < b + 0.5);
    if (q) { t = q[1] + 1; continue; }
    out.push({ start: Math.round(t * 100) / 100, end: Math.round((t + len) * 100) / 100 });
    t += len + 0.5 + rnd() * 2.5;
  }
  return out;
};
const LINES = linesOf(5);
const srt = (cues, shift, text) => cues.map((c, i) => {
  const ts = (v) => {
    const ms = Math.round(v * 1000);
    return `00:${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return `${i + 1}\n${ts(c.start + shift)} --> ${ts(c.end + shift)}\n${text(i)}\n`;
}).join("\n");

// the sound, as a 16 kHz mono WAV
const wavOf = () => {
  const rnd = seeded(11);
  const n = DUR * RATE;
  const pcm = new Int16Array(n);
  const put = (i, v) => { pcm[i] = Math.max(-32767, Math.min(32767, pcm[i] + v * 32767)); };
  for (let i = 0; i < n; i++) put(i, (rnd() - 0.5) * 0.01); // a quiet room
  LINES.forEach((c, k) => {
    const f0 = 110 + ((k * 37) % 100);
    const a = Math.round(c.start * RATE);
    const b = Math.round(c.end * RATE);
    const ph = rnd() * 6;
    for (let i = a; i < b; i++) {
      const t = i / RATE;
      const edge = Math.min(1, (i - a) / (0.03 * RATE), (b - i) / (0.03 * RATE));
      const syl = Math.max(0, 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.5 * t + ph));
      const f = f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 1.3 * t));
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * h * f * t) / h;
      put(i, 0.12 * edge * syl * v);
    }
  });
  // a held chord, loud
  for (let i = QUIET[0][0] * RATE; i < QUIET[0][1] * RATE; i++) {
    const t = i / RATE;
    put(i, 0.12 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t)));
  }
  // an explosion: loud noise
  for (let i = QUIET[1][0] * RATE; i < QUIET[1][1] * RATE; i++) put(i, (rnd() - 0.5) * 0.6 * Math.exp(-(i / RATE - QUIET[1][0])));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + n * 2, 4); head.write("WAVE", 8); head.write("fmt ", 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(n * 2, 40);
  return Buffer.concat([head, Buffer.from(pcm.buffer)]);
};

const build = (dir, ffmpeg) => {
  const d = path.join(dir, TITLE);
  const file = path.join(d, `${TITLE}.mp4`);
  if (fs.existsSync(file)) return d;
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dir, "talk.wav"), wavOf());
  fs.writeFileSync(path.join(dir, "talk-en.srt"), srt(LINES, 0, (i) => `EN line ${i}`));
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=0x203040:size=320x180:rate=10:duration=${DUR}`,
    "-i", path.join(dir, "talk.wav"), "-i", path.join(dir, "talk-en.srt"),
    "-map", "0:v", "-map", "1:a", "-map", "2:0", "-c:v", "libx264", "-preset", "ultrafast", "-g", "20",
    "-c:a", "aac", "-b:a", "64k", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-movflags", "+faststart", file], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  fs.writeFileSync(path.join(d, `${TITLE}.Hebrew.srt`), srt(LINES, LATE, (i) => `שורה ${i}`));
  fs.writeFileSync(path.join(d, `${TITLE}.Hebrew 2.srt`), srt(linesOf(77, 6), 0, (i) => `סרט אחר ${i}`));
  return d;
};

const ui = suite({
  setup: async (srv) => {
    const dir = build(path.join(__dirname, ".cache", "subresync"), ffmpegPath());
    fs.cpSync(dir, path.join(srv.library.movies, TITLE), { recursive: true });
    await srv.api.rescan();
    const deadline = Date.now() + 60000;
    for (;;) {
      const lib = await srv.api.library();
      const m = lib.movies.find((x) => x.title === "Talking Film");
      if (m && m.duration > 0) {
        const it = await srv.api.item(m.id);
        if (it.subtitles.length === 3 && it.subtitles.some((t) => t.embedded)) { srv.talk = it; break; }
      }
      if (Date.now() > deadline) throw new Error("the talking film never finished probing");
      await new Promise((r) => setTimeout(r, 300));
    }
  },
});

const ART = path.join(__dirname, "artifacts");
const cueStarts = (page, label) => page.evaluate((label) => {
  const t = [...document.querySelector(".player video").textTracks].find((x) => x.label === label);
  return t && t.cues ? [...t.cues].map((c) => c.startTime) : null;
}, label);
// every text the Resync pill shows, from the moment of the press
const watchPill = (page) => page.evaluate(() => {
  window.__pill = [];
  const p = document.querySelector(".player .sub-resync");
  new MutationObserver(() => { if (!p.classList.contains("hidden")) window.__pill.push(p.textContent); })
    .observe(p, { childList: true, characterData: true, subtree: true, attributes: true });
});
// pick the track by its exact name ("Hebrew", not "Hebrew 2")
const pickExact = async (page, label) => {
  const items = await player.menu(page, "Subtitles");
  const i = items.findIndex((x) => x.text === label);
  assert.ok(i >= 0, `${label} is in the menu: ${JSON.stringify(items.map((x) => x.text))}`);
  await page.locator(".player .menu .menu-item").nth(i).click();
};
const resync = async (page, label) => {
  await pickExact(page, label);
  await page.waitForFunction((label) => { const t = [...document.querySelector(".player video").textTracks].find((x) => x.label === label); return t && t.cues && t.cues.length > 20; }, label);
  await watchPill(page);
  await player.menu(page, "Subtitles");
  await page.click('.player .menu [data-ui="player.subtitles.resync"]');
  await page.waitForFunction(() => {
    const p = document.querySelector(".player .sub-resync");
    return p && p.classList.contains("done");
  }, null, { timeout: 180000 }); // (the urgent decode runs below normal priority: a loaded box starves it)
  return { seen: await page.evaluate(() => window.__pill), words: (await page.textContent(".player .sub-resync")).trim() };
};

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`${name}: Resync listens to the film and moves a late subtitle onto what is said, at once and for every device`, { viewport }, async ({ page, srv, signIn, freshProfile }) => {
    await signIn(await freshProfile());
    await player.open(page, srv, srv.talk.id);
    const { seen, words } = await resync(page, "Hebrew");
    assert.ok(seen.some((s) => /^Listening to the film…/.test(s)), `progress was shown: ${JSON.stringify(seen)}`);
    // (the detector reads speech ~80 ms after its onset on purpose — real
    // subtitles lead the voice by that much — so these exact bursts read 2.5)
    // (2.4 seen too on a loaded machine: within the 0.2 s a "fixed" result allows)
    assert.match(words, /^Moved 2\.[456] s earlier$/);
    await page.screenshot({ path: path.join(ART, `subresync-${name}-done.png`) }).catch(() => {});
    // the cues on the page are the corrected ones
    await page.waitForFunction((label) => {
      const t = [...document.querySelector(".player video").textTracks].find((x) => x.label === label);
      return t && t.cues && t.cues.length > 20 && Math.abs(t.cues[0].startTime - 4) < 0.25;
    }, "Hebrew", { timeout: 30000 });
    const got = await cueStarts(page, "Hebrew");
    const err = got.map((s, i) => Math.abs(s - LINES[i].start)).sort((a, b) => a - b);
    assert.ok(err[Math.floor(err.length * 0.9)] <= 0.25, `p90 cue error after Resync ${err[Math.floor(err.length * 0.9)]} s`);
    // …and so is what any other device is served
    const he = (await srv.api.item(srv.talk.id)).subtitles.find((t) => t.label === "Hebrew");
    const res = await fetch(srv.url + he.url);
    assert.match(res.headers.get("x-aurora-subtitle-repair") || "", /^audio: Moved 2\.[456] s earlier \(resync\)/);
    assert.equal(he.timing.verdict, "moved");
    // the file itself is left as it was
    const onDisk = fs.readFileSync(path.join(srv.library.movies, TITLE, `${TITLE}.Hebrew.srt`), "utf-8");
    assert.match(onDisk, /^1\n00:00:06,600 -->/);
    // the delay buttons are still there for fine tuning, at 0 after the Resync
    await player.menu(page, "Subtitles");
    assert.equal((await page.textContent(".player .menu .sub-sync .tag")).trim(), "+0.0s");
    await page.screenshot({ path: path.join(ART, `subresync-${name}-menu.png`) }).catch(() => {});
    await page.keyboard.press("Escape");
  });
}

ui.test("Resync of a subtitle that matches nothing says so and leaves it exactly as it was", async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, srv.talk.id);
  await pickExact(page, "Hebrew 2");
  await page.waitForFunction(() => { const t = [...document.querySelector(".player video").textTracks].find((x) => x.label === "Hebrew 2"); return t && t.cues && t.cues.length > 20; });
  const before = await cueStarts(page, "Hebrew 2");
  const { words } = await resync(page, "Hebrew 2");
  assert.equal(words, "Couldn't match — kept as it was");
  await page.waitForTimeout(800);
  assert.deepEqual(await cueStarts(page, "Hebrew 2"), before);
});

ui.test("the embedded track: Resync finds it in time; the menu marks ONE ★ per language, and the ★ Hebrew is the one switched on", async ({ page, srv, signIn, freshProfile, api }) => {
  // (the late Hebrew file is lined up by now — by the Resync above or by the
  // background on its own; the other matches nothing)
  const deadline = Date.now() + 90000;
  let it;
  for (;;) {
    it = await srv.api.item(srv.talk.id);
    if (it.subtitles.some((t) => t.lang === "he" && t.star)) break;
    if (Date.now() > deadline) throw new Error(`no Hebrew ★: ${JSON.stringify(it.subtitles)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const stars = it.subtitles.filter((t) => t.star).map((t) => t.label).sort();
  assert.deepEqual(stars, ["English", "Hebrew"], JSON.stringify(it.subtitles.map((t) => [t.label, t.timing, t.star])));

  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { subLang: "he", subsDefault: true } }, await api.as(me));
  await signIn(me);
  await player.open(page, srv, srv.talk.id);
  await page.waitForFunction(() => [...document.querySelector(".player video").textTracks].some((t) => t.mode === "showing"));
  assert.equal(await page.evaluate(() => [...document.querySelector(".player video").textTracks].find((t) => t.mode === "showing").label), "Hebrew");
  const items = await player.menu(page, "Subtitles");
  const starred = await page.evaluate(() => [...document.querySelectorAll(".player .menu .menu-item.starred")].map((b) => b.textContent));
  assert.equal(starred.length, 2, JSON.stringify(items));
  assert.ok(starred.every((t) => /★Matches this release/.test(t)), JSON.stringify(starred));
  assert.ok(!(await page.evaluate(() => [...document.querySelectorAll(".player .menu .menu-item")].find((b) => b.textContent.startsWith("Hebrew 2")).classList.contains("starred"))));
  await page.screenshot({ path: path.join(ART, "subresync-star-menu.png") }).catch(() => {});
  await page.keyboard.press("Escape");

  const { words } = await resync(page, "English");
  assert.equal(words, "Already in time — nothing to move");
});

ui.test("phone: the ★ and its words fit the subtitle menu", { viewport: PHONE }, async ({ page, srv, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, srv.talk.id);
  await player.menu(page, "Subtitles");
  const fit = await page.evaluate(() => {
    const m = document.querySelector(".player .menu");
    const r = m.getBoundingClientRect();
    const rows = [...m.querySelectorAll(".menu-item.starred")].map((b) => {
      const s = b.querySelector(".sub-star").getBoundingClientRect();
      return { right: s.right, inside: s.right <= b.getBoundingClientRect().right + 0.5 };
    });
    return { left: r.left, right: r.right, vw: innerWidth, rows };
  });
  assert.ok(fit.left >= 0 && fit.right <= fit.vw, `the menu is on screen: ${JSON.stringify(fit)}`);
  assert.ok(fit.rows.length >= 1 && fit.rows.every((r) => r.inside), `the ★ is inside its row: ${JSON.stringify(fit.rows)}`);
  await page.screenshot({ path: path.join(ART, "subresync-phone-star.png") }).catch(() => {});
});

ui.run({ concurrency: 1 });

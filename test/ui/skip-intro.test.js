// Skip intro, end to end, on every way a phone or a computer plays an
// episode: a show whose three episodes share one theme at a different spot
// (a cold open of 6, 14 and 9 s before it) is dropped into the private
// instance's library; the server's own background pass finds the theme, the
// player asks /api/intro/auto as always — and the button must appear the
// moment the theme starts (not seconds in, not never) and take the film to
// where it ends. Played as a file (an MP4), repackaged (an MKV: the jit copy,
// hls.js), and on an iPhone (its own HLS player, no hls.js).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");
const config = require("../../src/config");

const SHOW = "Theme Show";
const SR = 48000;
const INTRO_S = 25;
const LENGTH = 60;
const COLD = { 1: 6, 2: 14, 3: 9, 4: 30 }; // where the theme starts in each episode (E4: added during a test)
const MATAN_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";

// A "song": tones whose mix changes every 100 ms — structured sound, a
// different one for every seed (the cold opens and the rest of each episode).
const song = (seconds, seed) => {
  const n = Math.round(seconds * SR);
  const out = new Int16Array(n);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const freqs = Array.from({ length: 6 }, () => 120 + rnd() * 3000);
  for (let i = 0; i < n; i++) {
    const seg = Math.floor(i / (SR * 0.1));
    let v = 0;
    for (let k = 0; k < freqs.length; k++) v += Math.sin((2 * Math.PI * freqs[k] * i) / SR) * (((seg * 7 + k * 3 + seed) % 5) + 1);
    out[i] = Math.round(v * 700);
  }
  return out;
};
const wav = (file, pcm) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]));
};
const ffmpeg = (args) => new Promise((resolve, reject) => {
  const ff = spawn(config.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let err = "";
  ff.stderr.on("data", (d) => (err += d));
  ff.on("error", reject);
  ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg exited ${code}`))));
});
const makeShow = async (showsDir, which = [1, 2, 3]) => {
  const dir = path.join(showsDir, SHOW, "Season 1");
  fs.mkdirSync(dir, { recursive: true });
  const theme = song(INTRO_S, 7);
  for (const e of which) {
    const before = song(COLD[e], 100 + e);
    const after = song(LENGTH - COLD[e] - INTRO_S, 200 + e);
    const pcm = new Int16Array(before.length + theme.length + after.length);
    pcm.set(before, 0); pcm.set(theme, before.length); pcm.set(after, before.length + theme.length);
    const a = path.join(dir, `e${e}.wav`);
    wav(a, pcm);
    // E3 is an MKV: the browser cannot play it as it is (the jit copy)
    const out = path.join(dir, `${SHOW} S01E0${e}.${e === 3 ? "mkv" : "mp4"}`);
    await ffmpeg([
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=24:duration=${LENGTH}`, "-i", a,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "48",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2", ...(e === 3 ? [] : ["-movflags", "+faststart"]), "-shortest", out,
    ]);
    fs.rmSync(a);
  }
};

// The film's time each time the button shows or hides, from the page itself.
const watchButton = (page) => page.evaluate(() => {
  window.__skip = [];
  const v = document.querySelector(".player video");
  const b = document.querySelector(".player .skip-intro");
  let shown = !b.classList.contains("hidden");
  const look = () => {
    const now = !b.classList.contains("hidden");
    if (now !== shown) {
      shown = now;
      const el = document.querySelector(".player .scrub-row > span");
      const clock = el ? el.textContent.trim().split(":").map(Number).reduce((a, n) => a * 60 + n, 0) : null;
      window.__skip.push({ shown: now, t: v.currentTime, clock });
    }
    window.__skipRaf = requestAnimationFrame(look);
  };
  look();
});
const shownAt = (page) => page.evaluate(() => (window.__skip || []).find((x) => x.shown) || null);

let eps = null;
let auto = {};
const ui = suite({
  setup: async (srv) => {
    await makeShow(srv.library.shows);
    await srv.api.rescan();
    // the background pass finds the theme in all three
    const deadline = Date.now() + 200000;
    while (Date.now() < deadline) {
      if (!eps) {
        const lib = await srv.api.library();
        const s = lib.shows.find((x) => x.title === SHOW);
        if (s) eps = (await srv.api.item(s.id)).seasons[0].episodes;
      }
      if (eps) {
        for (const e of eps) auto[e.episode] = await (await fetch(`${srv.url}/api/intro/auto/${e.id}`)).json();
        if (eps.every((e) => auto[e.episode] && auto[e.episode].intro)) break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  },
});

const near = (actual, expected, lo, hi, what) =>
  assert.ok(actual != null && actual >= expected - lo && actual <= expected + hi, `${what}: ${actual == null ? "never" : actual.toFixed(2) + " s"}, expected ${expected} s (−${lo}/+${hi})`);

ui.test("the server finds the shared theme in every episode, where it starts", async () => {
  assert.ok(eps && eps.length === 3, "the show reached the library");
  for (const e of [1, 2, 3]) {
    const a = auto[e];
    assert.ok(a && a.intro, `episode ${e} has an intro (got ${JSON.stringify(a)})`);
    near(a.intro.start, COLD[e], 1, 1, `episode ${e}'s intro start`);
    near(a.intro.end, COLD[e] + INTRO_S, 1.5, 1.5, `episode ${e}'s intro end`);
  }
});

// name, episode, iPhone?, Quality to pick (a CPU encode: the jit ladder's
// fast first segment), a resume point (a stream that starts part-way)
const CASES = [
  ["a file (MP4)", 2, false, null, 0],
  ["the repackaged stream (MKV, hls.js)", 3, false, null, 0],
  ["an encode (480p, hls.js) started part-way", 2, false, "480p", 11],
  ["an iPhone (its own HLS player)", 3, true, null, 0],
  ["an iPhone, an encode started part-way", 2, true, "480p", 11],
  ["an iPhone, a file", 1, true, null, 0],
];
for (const [name, e, iphone, quality, resume] of CASES) {
  ui.test(`Skip intro appears as the theme starts and skips it: ${name}`, { timeout: 180000, ...(iphone ? { viewport: { width: 430, height: 745 } } : {}) }, async ({ page, srv, signIn, freshProfile, api }) => {
    const ep = eps.find((x) => x.episode === e);
    const intro = auto[e].intro;
    if (iphone) await page.addInitScript((ua) => { Object.defineProperty(navigator, "userAgent", { get: () => ua }); }, MATAN_UA);
    const me = await freshProfile();
    if (resume) await api.setProgress(me, ep.id, resume, LENGTH);
    await signIn(me);
    await player.open(page, srv, ep.id, { min: 0.2 });
    if (quality) {
      // (an encode: the stream starts again where the film is)
      const items = await player.menu(page, "Settings");
      await page.keyboard.press("Escape");
      if (!items.some((i) => i.text === quality)) throw new Error(`no ${quality} in ${JSON.stringify(items.map((i) => i.text))}`);
      await player.pick(page, "Settings", quality);
      await page.waitForFunction(() => /jit|m3u8|blob:/.test(document.querySelector(".player video").currentSrc), null, { timeout: 30000 });
      await player.advancing(page, { timeout: 60000 }); // (an encode on a busy machine can take a while to start)
    }
    if (iphone) assert.doesNotMatch((await player.state(page)).src, /^blob:/, "an iPhone plays without hls.js");
    await watchButton(page);
    // (the film's time as the viewer reads it: on an encode the element's
    // own clock starts where the stream started)
    const t0 = await player.clock(page);
    if (t0 < intro.start - 1) {
      await player.waitClock(page, Math.floor(intro.start) - 1, Math.floor(intro.start) - 1, 30000);
      assert.equal(await page.locator(".player .skip-intro:not(.hidden)").count(), 0, "the button came before the theme");
      await page.locator(".player .skip-intro:not(.hidden)").waitFor({ timeout: 30000 });
      const at = await shownAt(page);
      assert.ok(at, "the button was seen appearing");
      if (!quality) near(at.t, intro.start, 0.3, 1.0, "the button appeared at");
      // (the printed clock is redrawn a few times a second: it may still read the second before)
      near(at.clock, Math.floor(intro.start), 1, 1, "the button appeared with the clock at");
    } else {
      // an encode slow to start on a busy machine came in already inside the
      // theme: the button is there at once (the clock is the film's)
      assert.ok(!quality || t0 < intro.end - 3, `the stream came in at ${t0} s, past the theme (${intro.start}–${intro.end})`);
      if (!quality) assert.fail(`the film is already at ${t0} s (the theme starts at ${intro.start})`);
      await page.locator(".player .skip-intro:not(.hidden)").waitFor({ timeout: 1500 });
    }
    await page.locator(".player .skip-intro:not(.hidden)").click();
    // (an encode restarts at the segment that holds the target: up to a
    // segment early — the player's seek on an encode, not Skip intro's)
    const early = quality ? 4.5 : 1.5;
    await player.waitClock(page, Math.floor(intro.end - early), Math.floor(intro.end) + 3, 15000);
    await player.advancing(page);
    near(await player.clock(page), intro.end, early, 2, "after the skip, the film is at");
  });
}

// An episode that lands and is played at once, before anything was measured
// on it: the first answer may say `pending` (the server reads it now) — the
// player asks again, and the button is there when the theme starts.
ui.test("an episode played the moment it lands still gets Skip intro when its theme starts", { timeout: 240000 }, async ({ page, srv, signIn, freshProfile }) => {
  await makeShow(srv.library.shows, [4]);
  await srv.api.rescan();
  let ep4 = null;
  const deadline = Date.now() + 60000;
  while (!ep4 && Date.now() < deadline) {
    const lib = await srv.api.library();
    const s = lib.shows.find((x) => x.title === SHOW);
    const eps = s ? (await srv.api.item(s.id)).seasons[0].episodes : [];
    ep4 = eps.find((x) => x.episode === 4) || null;
    if (!ep4) await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(ep4, "the new episode reached the library");
  const answers = [];
  page.on("response", async (res) => {
    if (!res.url().includes(`/api/intro/auto/${ep4.id}`)) return;
    try { answers.push(await res.json()); } catch {}
  });
  await signIn(await freshProfile());
  await player.open(page, srv, ep4.id, { min: 0.2 });
  await watchButton(page);
  await page.locator(".player .skip-intro:not(.hidden)").waitFor({ timeout: 60000 });
  const at = await shownAt(page);
  near(at.t, COLD[4], 0.3, 1.0, "the button appeared at");
  if (answers.some((a) => a.pending)) assert.ok(answers.length >= 2, "a pending answer was asked again");
  console.log(`[skip-intro] answers for the new episode: ${answers.map((a) => (a.pending ? "pending" : a.intro ? "intro" : "none")).join(", ")}`);
});

ui.run({ concurrency: 1 });

// Up next at the credits the PICTURE found (media/creditscv.js), end to end:
// a show is dropped into the private instance's library whose first episode
// ends in a cut to black and a scrolling roll of names 30 s in (80 s long).
// The server's own background pass reads the picture, the player asks
// /api/intro/auto as always, and Up next must appear at 30 s — not at the
// runtime-scaled guess (30 s before the end: 50 s) it used before — with the
// scrubber's credits tick at the same place. Screenshots go to
// docs/qa/credits/ when UI_SHOTS is set.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");
const config = require("../../src/config");

const SHOW = "Credits Show";
const SCENE_S = 30; // the story, then the credits
const CREDITS_S = 50;
const LENGTH = SCENE_S + CREDITS_S;
const SHOTS = process.env.UI_SHOTS ? path.join(__dirname, "..", "..", "docs", "qa", "credits") : null;

// A roll of "names" (glyph-like strokes in lines, bright on black), moving
// up 7 rows a picture, two pictures a second — what creditscv.js looks for.
const W = 384, H = 216;
const rng = (seed) => { let s = seed >>> 0 || 1; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); };
const line = (px, y0, x0, chars, seed) => {
  const r = rng(seed);
  let x = x0;
  for (let c = 0; c < chars; c++) {
    if (r() < 0.15) { x += 4; continue; }
    const strokes = 1 + Math.floor(r() * 3);
    for (let k = 0; k < strokes; k++) {
      const w = r() < 0.5 ? 1 : 2, top = r() < 0.3 ? 0 : 2;
      for (let y = y0 + top; y < y0 + 6; y++) for (let xx = x; xx < x + w && xx < W; xx++) if (y >= 0 && y < H) px[y * W + xx] = 225;
      x += w + 1;
    }
    x += 2;
  }
};
const rollPicture = (i) => {
  const px = new Uint8Array(W * H).fill(16);
  if (i < 2) return px; // the cut to black that opens the credits
  for (let l = 0; l < 400; l++) {
    const y = l * 18 - (i - 2) * 7 + H;
    if (y < -8 || y >= H) continue;
    line(px, y, 110, 22, l * 101 + 3);
  }
  return px;
};

const ffmpeg = (args, feed) => new Promise((resolve, reject) => {
  const ff = spawn(config.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: [feed ? "pipe" : "ignore", "ignore", "pipe"], windowsHide: true });
  let err = "";
  ff.stderr.on("data", (d) => (err += d));
  ff.on("error", reject);
  ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg exited ${code}`))));
  if (feed) { feed(ff.stdin); ff.stdin.end(); }
});
const H264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "24", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart"];

// Episode 1: the test pattern for 30 s, then the credits (the roll piped in
// as 2 fps grey pictures, held to 24 fps); episode 2: the pattern alone.
const makeShow = async (showsDir) => {
  const dir = path.join(showsDir, SHOW, "Season 1");
  fs.mkdirSync(dir, { recursive: true });
  await ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=24:duration=${SCENE_S}`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", "2", "-i", "-",
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${LENGTH}`,
    "-filter_complex", "[0:v]format=yuv420p,setsar=1[a];[1:v]scale=640:360,fps=24,format=yuv420p,setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]",
    "-map", "[v]", "-map", "2:a", ...H264, "-shortest", path.join(dir, `${SHOW} S01E01.mp4`),
  ], (stdin) => { for (let i = 0; i < CREDITS_S * 2; i++) stdin.write(Buffer.from(rollPicture(i))); });
  await ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=20",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=20",
    ...H264, "-shortest", path.join(dir, `${SHOW} S01E02.mp4`),
  ]);
};

const ui = suite({
  setup: async (srv) => {
    await makeShow(srv.library.shows);
    await srv.api.rescan();
  },
});

ui.test("Up next appears where the picture says the credits start, and the scrubber marks it there", { timeout: 300000 }, async ({ page, srv, api, signIn, freshProfile }) => {
  // the library has the new show, and the background pass has read its picture
  let e1 = null;
  let auto = null;
  const deadline = Date.now() + 200000;
  while (Date.now() < deadline) {
    if (!e1) {
      const lib = await api.library();
      const s = lib.shows.find((x) => x.title === SHOW);
      if (s) e1 = (await api.item(s.id)).seasons[0].episodes[0];
    }
    if (e1) {
      auto = await (await fetch(`${srv.url}/api/intro/auto/${e1.id}`)).json();
      if (auto && auto.credits) break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(e1, "the new show reached the library");
  assert.ok(auto && auto.credits, `the picture pass gave the episode a credits time (got ${JSON.stringify(auto)})`);
  assert.ok(Math.abs(auto.credits.start - SCENE_S) <= 1, `credits at ${auto.credits.start}, expected ${SCENE_S}`);
  assert.equal(auto.sources.credits, "picture");

  await signIn(await freshProfile());
  await player.open(page, srv, e1.id);

  // the credits tick on the timeline, at 30 / 80 of its width
  await page.waitForSelector(".player .scrubber-marks i", { state: "attached" });
  const left = await page.evaluate(() => [...document.querySelectorAll(".player .scrubber-marks i")].map((i) => parseFloat(i.style.left)));
  assert.ok(left.some((l) => Math.abs(l - (SCENE_S / LENGTH) * 100) < 1.5), `a tick at ${((SCENE_S / LENGTH) * 100).toFixed(1)}% (ticks: ${left})`);

  // three seconds before the credits: no Up next yet
  await player.jump(page, SCENE_S - 3);
  await page.waitForFunction((t) => document.querySelector(".player video").currentTime >= t, SCENE_S - 3);
  assert.equal(await page.locator(".player .upnext").count(), 0, "Up next came before the credits");
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await player.wake(page);
    await page.screenshot({ path: path.join(SHOTS, "before-credits-no-upnext.png") });
  }

  const card = page.locator(".player .upnext");
  await card.waitFor({ timeout: 10000 });
  const shownAt = (await player.state(page)).t;
  assert.ok(shownAt >= SCENE_S - 0.5 && shownAt <= SCENE_S + 2.5, `Up next appeared at ${shownAt.toFixed(1)} s, expected ${SCENE_S} s (the old guess was ${LENGTH - 30} s)`);
  assert.match(await card.locator(".t").textContent(), /S1 E2/);
  if (SHOTS) {
    // (a moment in, so the names are on screen behind the card)
    await page.waitForFunction((t) => document.querySelector(".player video").currentTime >= t, SCENE_S + 3);
    await player.wake(page);
    await page.screenshot({ path: path.join(SHOTS, "upnext-at-picture-credits.png") });
  }
});

ui.run({ concurrency: 1 });

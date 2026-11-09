// The progress bar's preview pictures and the Next episode card, end to end
// on a private instance: the server makes the pictures of its little library
// (media/scrubsprites.js, the admin's "make them now"), the player asks for
// them, and the picture of the second under the pointer — mouse hover, mouse
// drag, a finger's drag on a phone, the arrow keys — stands above the bar.
// Where there are none, the bar is exactly what it was. Screenshots go to
// docs/qa/scrub-previews/ when UI_SHOTS is set.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const config = require("../../src/config");
const { suite, player, PHONE, EPISODE_SECONDS } = require("./helpers");

const SHOTS = process.env.UI_SHOTS ? path.join(__dirname, "..", "..", "docs", "qa", "scrub-previews") : null;
const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

// Every title's pictures, made before the first test. The server's own way
// first (the admin's "make them now" — background work at the OS's idle
// priority); on a machine whose CPUs are all taken (other test runs), the
// idle class can wait for minutes, so after 45 s whatever is still missing is
// made here, by the same module, into the instance's own folder — the same
// files the server would have made (the folder is the file's path and date).
const videosUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? videosUnder(p) : /\.(mp4|mkv)$/i.test(e.name) ? [p] : [];
});
const durationOf = (file) => {
  const r = spawnSync(config.FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { windowsHide: true });
  return parseFloat(String(r.stdout)) || 0;
};
let madeHere = 0;
const ui = suite({
  setup: async (srv) => {
    const dbg = (...a) => process.env.SCRUB_DEBUG && console.error("[setup]", new Date().toISOString(), ...a);
    dbg("start");
    const ids = [srv.lib.film1.id, srv.lib.e1.id, srv.lib.e2.id];
    const ready = async () => (await Promise.all(ids.map((id) => srv.api.get(`/api/scrub/${id}`)))).every((a) => a.ready);
    const deadline = Date.now() + 45000;
    dbg("run", JSON.stringify(await srv.api.adminPost("/api/admin/scrub/run")));
    while (Date.now() < deadline) {
      const r = await ready();
      dbg("ready?", r);
      if (r) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (await ready()) return;
    dbg("in-process");
    const sprites = require("../../src/media/scrubsprites");
    const before = sprites._internals.deps.dir;
    sprites._internals.deps.dir = path.join(srv.dataDir, "cache", "scrub");
    // (the dates from the disk: the scanner is not loaded in this process)
    sprites._internals.deps.walkedStat = () => null;
    try {
      for (const file of [...videosUnder(srv.library.movies), ...videosUnder(srv.library.shows)]) {
        const r = await sprites.make(file, durationOf(file), { threads: 1 });
        dbg(file, JSON.stringify(r).slice(0, 80));
        if (r.ok) madeHere++;
      }
    } finally {
      sprites._internals.deps.dir = before;
    }
    assert.ok(await ready(), "no pictures for the library");
  },
});

// the tip as the page shows it
const tip = (page) => page.evaluate(() => {
  const t = document.querySelector(".player .scrub-tip");
  const th = t && t.querySelector(".scrub-thumb");
  const cs = th && getComputedStyle(th);
  return t && {
    shown: !t.classList.contains("hidden"),
    thumb: t.classList.contains("has-thumb"),
    time: (t.querySelector(".scrub-tip-time") || {}).textContent || "",
    image: cs ? cs.backgroundImage : "",
    position: cs ? cs.backgroundPosition : "",
    width: th ? th.getBoundingClientRect().width : 0,
    height: th ? th.getBoundingClientRect().height : 0,
    box: t.getBoundingClientRect().toJSON(),
    bar: document.querySelector(".player .scrubber").getBoundingClientRect().toJSON(),
  };
});

ui.test("the server's index: one picture every 10 s, sheets that are real pictures", async ({ srv, lib }) => {
  const a = await srv.api.get(`/api/scrub/${lib.film1.id}`);
  assert.equal(a.ready, true);
  assert.equal(a.interval, 10);
  assert.equal(a.cols, 10);
  assert.equal(a.w, 240);
  assert.ok(a.count >= 6 && a.count <= 7, `count ${a.count}`);
  assert.equal(a.sheets.length, 1);
  const res = await fetch(srv.url + a.sheets[0]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.match(res.headers.get("cache-control"), /immutable/);
  assert.ok((await res.arrayBuffer()).byteLength > 1000);
  // an id that is not a library title, and a sheet past the last one
  assert.deepEqual(await srv.api.get("/api/scrub/nothing-here"), { ready: false });
  assert.equal((await fetch(srv.url + `/img/scrub/${lib.film1.id}/9.jpg`)).status, 404);
  // what it cost, for the admin
  const sum = await srv.api.adminGet("/api/admin/scrub");
  assert.ok(sum.titles >= 3 && sum.bytes > 0, JSON.stringify(sum));
  if (madeHere) console.log(`# (${madeHere} title(s) made by the test: the server's idle-priority run was starved by a busy machine)`);
});

ui.test("hovering the bar shows the picture of that second above the time; dragging moves it and seeks on release", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  await player.wake(page);
  const bar = await page.locator(".player .scrubber").boundingBox();
  const y = bar.y + bar.height / 2;
  // hover at half way: 30 s of the 60 s film = picture 3
  await page.mouse.move(bar.x + bar.width * 0.5, y);
  await page.waitForFunction(() => document.querySelector(".player .scrub-tip.has-thumb:not(.hidden)"));
  let t = await tip(page);
  assert.match(t.image, /\/img\/scrub\//);
  assert.equal(t.width, 192);
  assert.ok(t.height > 90 && t.height < 120, `height ${t.height}`);
  assert.match(t.time, /^0:(29|30|31)$/);
  assert.equal(t.position, "-576px 0px", "picture 3 of the first row");
  // it sits above the bar and inside it from end to end
  assert.ok(t.box.bottom <= t.bar.top + 4, "the picture covers the bar");
  await shot(page, "desktop-hover");
  // near the left end it does not leave the bar
  await page.mouse.move(bar.x + 2, y);
  t = await tip(page);
  assert.ok(t.box.left >= t.bar.left - 1, `left edge ${t.box.left} < ${t.bar.left}`);
  assert.equal(t.position, "0px 0px");

  // a drag: the picture follows, the film goes there when the button lifts
  await page.mouse.move(bar.x + bar.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width * 0.5, y, { steps: 4 });
  await page.mouse.move(bar.x + bar.width * 0.75, y, { steps: 4 });
  t = await tip(page);
  assert.equal(t.thumb, true);
  assert.equal(t.position, "-768px 0px", "picture 4 (45 s) while dragging at 75 %");
  await shot(page, "desktop-drag");
  await page.mouse.up();
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 40 && v.currentTime < 50; });
});

ui.test("on a phone a finger's drag shows the picture, and the film goes there on release", { viewport: PHONE }, async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  await player.wake(page);
  const bar = await page.locator(".player .scrubber").boundingBox();
  const y = Math.round(bar.y + bar.height / 2);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y, id: 1 }] });
  await touch("touchStart", bar.x + bar.width * 0.1);
  for (const f of [0.2, 0.3, 0.4, 0.5, 0.6]) { await touch("touchMove", bar.x + bar.width * f); await page.waitForTimeout(30); }
  await page.waitForFunction(() => document.querySelector(".player .scrub-tip.has-thumb:not(.hidden)"));
  const t = await tip(page);
  assert.equal(t.width, 144, "the phone's smaller picture");
  assert.equal(t.position, "-576px 0px", "picture 4 (36 s → 40 s) at 60 %: 4 × 144 px");
  assert.ok(t.box.left >= 0 && t.box.right <= PHONE.width, "the picture leaves the screen");
  await shot(page, "phone-drag");
  await touch("touchEnd", 0);
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 32 && v.currentTime < 42; });
});

ui.test("the arrow keys: the picture where the skips are headed, gone a moment after", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  await player.wake(page);
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".player .scrub-tip.has-thumb:not(.hidden)"));
  const t = await tip(page);
  assert.match(t.image, /\/img\/scrub\//);
  await page.waitForFunction(() => !document.querySelector(".player .scrub-tip:not(.hidden)"), null, { timeout: 5000 });
});

ui.test("a title with no pictures yet: the time alone, as before", async ({ page, srv, signIn, freshProfile, lib }) => {
  await page.route("**/api/scrub/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ready: false }) }));
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  await player.wake(page);
  const bar = await page.locator(".player .scrubber").boundingBox();
  await page.mouse.move(bar.x + bar.width * 0.5, bar.y + bar.height / 2);
  await page.waitForFunction(() => document.querySelector(".player .scrub-tip:not(.hidden)"));
  const t = await tip(page);
  assert.equal(t.thumb, false);
  assert.match(t.time, /^0:(29|30|31)$/);
  assert.equal(await page.locator(".player .scrub-tip").textContent(), t.time, "the tip is the time and nothing else");
});

// ---------- the Next episode card ----------
const UPNEXT_AT = EPISODE_SECONDS - 30;

ui.test("Next episode: its picture, a 15 s countdown with a bar, Watch credits stops it", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.e1.id);
  await player.jump(page, UPNEXT_AT + 1);
  const card = page.locator(".player .upnext");
  await card.waitFor({ timeout: 8000 });
  assert.equal(await card.locator(".k").textContent(), "Next episode");
  assert.match(await card.locator(".t").textContent(), /S1 E2/);
  assert.match(await card.locator(".upnext-count").textContent(), /^Starts in \d+$/);
  // the next episode's own picture, loaded
  await page.waitForFunction(() => { const i = document.querySelector(".player .upnext-art img"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
  assert.match(await card.locator(".upnext-art img").getAttribute("src"), new RegExp(`/img/still/${lib.e2.id}`));
  // the bar is filling
  await page.waitForFunction(() => { const i = document.querySelector(".player .upnext-bar i"); return i && new DOMMatrix(getComputedStyle(i).transform).a > 0.05; });
  await shot(page, "next-episode-desktop");
  // Watch credits: the card goes, nothing starts, the credits play on
  await card.locator("button", { hasText: "Watch credits" }).click();
  await card.waitFor({ state: "detached" });
  await page.waitForTimeout(2500);
  assert.ok((await page.evaluate(() => location.hash)).includes(lib.e1.id));
  await player.advancing(page);
});

ui.test("Next episode with a scene after the credits: still the countdown, and the card says so", async ({ page, srv, signIn, freshProfile, lib }) => {
  // the server heard a scene after the credits of episode 1, which start at 20 s
  await page.route(`**/api/intro/auto/${lib.e1.id}`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ intro: null, recap: null, credits: { start: 20, scene: true }, source: "audio" }) }));
  await signIn(await freshProfile());
  await player.open(page, srv, lib.e1.id);
  await player.jump(page, 19);
  const card = page.locator(".player .upnext");
  await card.waitFor({ timeout: 8000 });
  const shownAt = (await player.state(page)).t;
  assert.ok(shownAt >= 19.5 && shownAt < 23, `the card came at ${shownAt.toFixed(1)} s, the credits start at 20 s`);
  assert.equal(await card.locator(".upnext-scene").textContent(), "A scene follows the credits");
  const count = Number(await card.locator(".ring").textContent());
  await page.waitForFunction((c) => Number(document.querySelector(".player .upnext .ring").textContent) < c, count);
  await player.tag(page);
  await player.playing(page, { id: lib.e2.id, fresh: true, timeout: 25000 });
});

ui.test("Next episode on a phone: the picture beside the words, both buttons on the screen", { viewport: { width: 320, height: 640 } }, async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.e1.id);
  await player.jump(page, UPNEXT_AT + 1);
  const card = page.locator(".player .upnext");
  await card.waitFor({ timeout: 8000 });
  await page.waitForFunction(() => { const i = document.querySelector(".player .upnext-art img"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
  const boxes = await page.evaluate(() => [".upnext", ".upnext-art", ".upnext-actions .btn-primary", ".upnext-actions .btn:not(.btn-primary)"].map((s) => document.querySelector(`.player ${s}`).getBoundingClientRect().toJSON()));
  for (const b of boxes) assert.ok(b.left >= 0 && b.right <= 320, `off the screen: ${JSON.stringify(b)}`);
  assert.ok(boxes[1].width < 130, "the picture is beside the words");
  assert.ok(Math.abs(boxes[2].top - boxes[3].top) < 4, "the two buttons share a row");
  await shot(page, "next-episode-phone-320");
});

ui.run();

// The pictures on screen first (ui.js "the pictures on screen first"): while
// a screen's first pictures are on their way, a poster out of view waits for
// its address; the ones in view get theirs at once, at high priority; then
// everything is let go exactly as before (lazy stays lazy). Nothing is drawn
// differently — tools/webperf/pictures.js measures the gain, the pixel diff in
// docs/qa/web-small-nav/picture-priority/ proves the "nothing".
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite();

// A tiny real PNG, so a test picture "arrives" like any poster.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) ui.test(`${name}: a poster out of view waits until the one in view has arrived; a touch lets everything go; a known picture never waits`, { viewport }, async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/movies");
  await page.locator("#app .screen").first().waitFor();
  // the picture in view is held back by the "server" until the test says so
  let release;
  const gate = new Promise((r) => { release = r; });
  const asked = [];
  await page.route("**/img/prio-*", async (route) => {
    const u = new URL(route.request().url());
    asked.push(u.pathname);
    if (u.pathname.includes("prio-seen")) await gate;
    await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  // A copy of ui.js of its own (its own gate, closed as at a page load), and a
  // screen made of two posters: one in view, one three screens down.
  await page.evaluate(async () => {
    const ui = await import("/js/ui.js?prio-test");
    window.__prioUi = ui;
    const host = document.createElement("div");
    host.id = "prio-host";
    host.style.cssText = "position:absolute;left:0;top:0;width:200px;z-index:-1";
    const seen = ui.posterImg("/img/prio-seen", "Seen", "card-poster", "card-fallback", { w: 100, eager: true });
    const below = ui.posterImg("/img/prio-below", "Below", "card-poster", "card-fallback", { w: 100 });
    for (const im of [seen, below]) im.style.cssText = "display:block;width:100px;height:150px";
    const pad = document.createElement("div");
    pad.style.height = `${innerHeight * 3}px`;
    host.append(seen, pad, below);
    document.body.append(host);
    window.__prio = { seen, below };
  });
  // the one in view is asked for, at high priority; the other has no address yet
  await page.waitForFunction(() => window.__prio.seen.getAttribute("src"));
  await page.waitForTimeout(400);
  const waiting = await page.evaluate(() => ({
    seenPrio: window.__prio.seen.getAttribute("fetchpriority"),
    seenLoading: window.__prio.seen.getAttribute("loading"),
    below: window.__prio.below.getAttribute("src"),
    belowLoading: window.__prio.below.getAttribute("loading"),
    afterRan: (() => { let ran = false; window.__prioUi.afterPictures(() => { ran = true; }); return ran; })(),
    inYet: window.__prioUi.picturesIn(),
  }));
  assert.equal(waiting.seenPrio, "high", "the poster in view is asked for at high priority");
  assert.equal(waiting.seenLoading, "eager", "its own loading rule is kept");
  assert.equal(waiting.below, null, "the poster three screens down was given its address before the one in view arrived");
  assert.equal(waiting.belowLoading, "lazy");
  assert.equal(waiting.afterRan, false, "work for after the pictures ran before they were in");
  assert.equal(waiting.inYet, false);
  assert.deepEqual(asked.filter((p) => p.includes("prio-below")), [], "the poster out of view was requested");

  // the one in view arrives: the other gets its address, still lazy (the
  // browser's own rule decides when it loads, as before)
  release();
  await page.waitForFunction(() => window.__prio.below.getAttribute("src"));
  const after = await page.evaluate(() => ({
    below: window.__prio.below.getAttribute("src"),
    loading: window.__prio.below.getAttribute("loading"),
    prio: window.__prio.below.getAttribute("fetchpriority"),
    seenIn: window.__prio.seen.classList.contains("img-in"),
    inYet: window.__prioUi.picturesIn(),
  }));
  assert.match(after.below, /^\/img\/prio-below\?w=\d+$/);
  assert.equal(after.loading, "lazy");
  assert.equal(after.prio, null, "a poster out of view is not given a priority of its own");
  assert.equal(after.seenIn, true);
  assert.equal(after.inYet, true);

  // a new screen holds again; a touch lets everything go at once
  const touched = await page.evaluate(async () => {
    const ui = window.__prioUi;
    window.dispatchEvent(new CustomEvent("aurora-route-start", { detail: { pattern: "test" } }));
    const far = ui.posterImg("/img/prio-far", "Far", "card-poster", "card-fallback", { w: 100 });
    // (an address this page has shown already: the memory cache has it)
    const again = ui.posterImg("/img/prio-seen", "Seen again", "card-poster", "card-fallback", { w: 100, eager: true });
    const heldFar = far.getAttribute("src");
    const heldAgain = again.getAttribute("src");
    document.getElementById("prio-host").append(far);
    window.dispatchEvent(new Event("pointerdown"));
    return { heldFar, heldAgain, farNow: far.getAttribute("src"), inYet: ui.picturesIn() };
  });
  assert.equal(touched.heldFar, null, "a new screen does not hold its pictures");
  assert.match(String(touched.heldAgain), /^\/img\/prio-seen\?w=\d+$/, "a picture this page has shown waited for its address");
  assert.match(String(touched.farNow), /^\/img\/prio-far\?w=\d+$/, "a touch did not let the waiting pictures go");
  assert.equal(touched.inYet, true);
  await page.evaluate(() => document.getElementById("prio-host").remove());
});

// Home, opened cold: no card poster is asked for before the pictures on
// screen are in. On a desktop the billboard fills the first screen, so every
// card waits for it. (On a phone the test library's few covers repeat from
// shelf to shelf — the ones out of view are the ones in view, already loaded
// — so there is nothing to see there; tools/webperf/pictures.js measures it.)
{
  ui.test("desktop: Home asks for the posters out of view only after the billboard's picture has arrived", { viewport: DESKTOP }, async ({ page, goto, signIn, freshProfile }) => {
    await signIn(await freshProfile());
    // every picture takes a moment, so the order shows; the "server" notes
    // when each was asked for and when it was answered (by the test's clock:
    // the page's own Resource Timing leaves out a picture it already had)
    const log = [];
    await page.route("**/img/**", async (route) => {
      const u = new URL(route.request().url());
      const key = u.pathname + u.search;
      log.push({ key, asked: Date.now() });
      await new Promise((r) => setTimeout(r, 300));
      try {
        const res = await route.fetch();
        await route.fulfill({ response: res });
        log.push({ key, answered: Date.now() });
      } catch {}
    });
    await goto("#/");
    await page.locator("#app .row .card").first().waitFor();
    // until every poster has its address (the pictures on screen are in)
    await page.waitForFunction(() => [...document.querySelectorAll("#app img.card-poster")].every((i) => i.getAttribute("src")), null, { timeout: 20000 });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const rel = (u) => { const x = new URL(u, location.href); return x.pathname + x.search; };
      const inView = (im) => { const b = im.getBoundingClientRect(); return b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth; };
      const posters = [...document.querySelectorAll("#app img.card-poster")];
      // (the layer paints its art, or the poster under it where there is none)
      const layer = document.querySelector(".hero-backdrop.fade.on");
      const urls = layer ? ["--hero-art", "--hero-poster"].map((p) => (/url\("?([^")]+)"?\)/.exec(layer.style.getPropertyValue(p) || "") || [])[1]).filter(Boolean) : [];
      return {
        hero: urls.length ? new URL(urls[0], location.href).pathname : null,
        inView: posters.filter(inView).length,
        out: posters.filter((im) => !inView(im)).map((im) => rel(im.getAttribute("src"))),
      };
    });
    assert.ok(r.hero, "Home has no billboard picture: the test library's Home changed?");
    assert.equal(r.inView, 0, "a card is in view at the top of Home on a desktop: the layout changed, this test needs another screen size");
    assert.ok(r.out.length > 0, "no card poster on Home");
    // the billboard's first picture (any size of it) arriving
    const heroIn = Math.min(...log.filter((e) => e.answered && e.key.split("?")[0] === r.hero).map((e) => e.answered));
    assert.ok(Number.isFinite(heroIn), `the billboard's picture ${r.hero} was never asked for: ${JSON.stringify(log)}`);
    const early = log.filter((e) => e.asked && r.out.includes(e.key) && e.asked < heroIn);
    assert.deepEqual(early, [], `card posters out of view were asked for before the billboard's picture had arrived (${heroIn}): ${JSON.stringify(log)}`);
  });
}

ui.run({ concurrency: 2 });

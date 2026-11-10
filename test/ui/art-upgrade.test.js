// The sharper hero picture comes in ON TOP of the one that is there
// (public/js/artUpgrade.js "HOW IT COMES IN"; elia, 2026-11-10: "can we make
// the transition to the higher res image smoother?"). Pinned here:
//   - while the sharper picture is on its way and while it comes in, the
//     element keeps drawing the old one: never an empty background, and it
//     takes the new address only under a layer that already shows it;
//   - the layer is gone afterwards (nothing extra stays alive);
//   - reduced motion and the light graphics tier get it in one step, no fade;
//   - an element given another picture meanwhile drops the layer at once and
//     keeps that other picture; nothing is laid over a page behind the player;
//   - on a phone's title page the layer takes the box of the cover the
//     heading paints (two selector lists: responsive.css, glass.css).
// What it looks like, frame by frame: tools/webperf/artswap.js, and the
// strips in docs/qa/ui-audit-2026-11-10/img-smooth/.
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite();

// A tiny real PNG: the test's pictures "arrive" and decode like any other.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// The "server" for the test pictures: the small one at once, the sharp one
// (any address with w=1200 or more) when the test says so.
const pictures = async (page) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const asked = [];
  await page.route("**/img/up-*", async (route) => {
    const u = new URL(route.request().url());
    asked.push(u.pathname + u.search);
    if (Number(u.searchParams.get("w")) >= 1200) await gate;
    await route.fulfill({ status: 200, contentType: "image/png", body: PNG }).catch(() => {});
  });
  return { release, asked };
};

// In the page: a copy of the module, something that draws a picture the way
// the billboard's slide does, and a note of every frame (and of the very
// moment the element's own address changes).
const stage = (page, { node = null } = {}) => page.evaluate(async ({ node }) => {
  const up = await import("/js/artUpgrade.js?up-test");
  let host = node ? document.querySelector(node) : null;
  if (!host) {
    host = document.createElement("div");
    host.id = "up-host";
    host.style.cssText = "position:fixed;left:0;top:0;width:300px;height:200px;z-index:5;background-image:var(--hero-art, none), var(--hero-poster, none);background-size:cover;background-position:50% 18%";
    document.body.append(host);
  }
  const prop = node ? "--hero-poster" : "--hero-art";
  host.style.setProperty(prop, 'url("/img/up-art?w=300")');
  const look = () => [...document.querySelectorAll(".art-up")].map((l) => {
    const cs = getComputedStyle(l);
    return { parent: l.parentElement === host ? "host" : l.parentElement.className, opacity: Number(cs.opacity), inline: l.style.opacity, fades: l.classList.contains("in"), duration: cs.transitionDuration, picture: l.style.backgroundImage };
  });
  const rec = { frames: [], swaps: [], added: 0, on: true };
  const frame = () => {
    if (!rec.on) return;
    rec.frames.push({ t: Math.round(performance.now()), address: host.style.getPropertyValue(prop), drawn: getComputedStyle(host).backgroundImage, layers: look() });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new MutationObserver(() => {
    const address = host.style.getPropertyValue(prop);
    if (rec.swaps.length && rec.swaps[rec.swaps.length - 1].address === address) return;
    rec.swaps.push({ address, layers: look() });
  }).observe(host, { attributes: true, attributeFilter: ["style"] });
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.classList && n.classList.contains("art-up")) rec.added++;
  }).observe(document.body, { childList: true, subtree: true });
  window.__up = { up, host, prop, rec, look };
  // (asked for at once, as a phone's hero does: no waiting for a still viewer)
  up.upgradeArt(host, prop, "/img/up-art", () => 1920, { now: true });
}, { node });

const SMALL = 'url("/img/up-art?w=300")';
const address = (page) => page.evaluate(() => window.__up.host.style.getPropertyValue(window.__up.prop));
const layerCount = (page) => page.evaluate(() => document.querySelectorAll(".art-up").length);
const record = (page) => page.evaluate(() => { const r = window.__up.rec; r.on = false; return { frames: r.frames, swaps: r.swaps, added: r.added }; });
// until the sharp picture has been asked for (the test's server holds it)
const askedForSharp = async (page, asked) => {
  const until = Date.now() + 15000;
  while (Date.now() < until && !asked.some((a) => /w=1[2-9]\d\d|w=[2-9]\d{3}/.test(a))) await page.waitForTimeout(50);
  assert.ok(asked.some((a) => /w=1[2-9]\d\d|w=[2-9]\d{3}/.test(a)), `the sharp picture was never asked for: ${JSON.stringify(asked)}`);
};
const open = async ({ page, goto, signIn, freshProfile, api }, hash = "#/movies", look = "glass") => {
  const me = await freshProfile();
  if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
  await signIn(me);
  await goto(hash);
  await page.locator("#app .screen").first().waitFor();
};

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) ui.test(`${name}: the sharper picture fades in over the old one — never an empty background, and the layer is gone afterwards`, { viewport }, async (h) => {
  const { page } = h;
  await open(h);
  const { release, asked } = await pictures(page);
  await stage(page);
  // on its way: the old picture, untouched, and nothing over it
  await askedForSharp(page, asked);
  await page.waitForTimeout(400);
  assert.equal(await address(page), SMALL, "the element lost its picture before the sharp one had arrived");
  assert.equal(await layerCount(page), 0, "a layer was laid before the sharp picture had arrived");

  release();
  await page.waitForFunction(() => window.__up.host.style.getPropertyValue(window.__up.prop).includes("w=1920") && !document.querySelector(".art-up"), null, { timeout: 15000 });
  await page.waitForTimeout(200);
  const { frames, swaps, added } = await record(page);

  // never empty: in every frame the element itself draws the picture
  const empty = frames.filter((f) => !/up-art\?w=(300|1920)/.test(f.drawn));
  assert.deepEqual(empty, [], "the element drew no picture in some frame");
  // one layer, inside the element, carrying the sharp picture; it came while
  // the element still had the old one
  assert.equal(added, 1, "exactly one layer is used for one swap");
  const covered = frames.filter((f) => f.layers.length);
  assert.ok(covered.length > 0, "no frame saw the layer");
  for (const f of covered) {
    assert.equal(f.layers.length, 1);
    assert.equal(f.layers[0].parent, "host", "the layer is not inside the element that draws the picture");
    assert.match(f.layers[0].picture, /up-art\?w=1920/, "the layer does not carry the sharp picture");
  }
  assert.equal(covered[0].address, SMALL, "the element changed its address before the layer was there");
  // it fades: nearly nothing first, values in between, then all of it — and never back
  const seen = covered.map((f) => f.layers[0].opacity);
  assert.ok(seen[0] <= 0.02, `the layer was laid at ${seen[0]}, not unseen`);
  assert.ok(seen.some((o) => o > 0.02 && o < 0.99), `the layer did not fade (${seen.join(" ")})`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1] - 0.001, `the layer went back (${seen.join(" ")})`);
  assert.ok(covered.some((f) => f.layers[0].fades && f.layers[0].duration === "0.42s"), "the fade is not the 420 ms one of glass.css");
  // the element took the new address once, under the layer at full strength
  assert.equal(swaps.length, 1, `the element's address changed ${swaps.length} times: ${JSON.stringify(swaps)}`);
  assert.match(swaps[0].address, /up-art\?w=1920/);
  assert.equal(swaps[0].layers.length, 1, "the element took the sharp picture with no layer over it");
  assert.equal(swaps[0].layers[0].inline, "1");
  assert.ok(swaps[0].layers[0].opacity > 0.9, `the element took the sharp picture under a layer at ${swaps[0].layers[0].opacity}`);
  // and afterwards nothing extra is alive
  assert.equal(frames[frames.length - 1].layers.length, 0);
  assert.equal(await layerCount(page), 0, "the layer stayed");
});

for (const mode of ["reduced motion", "the light graphics tier"]) ui.test(`${mode}: the sharper picture comes in one step, without a fade, and the layer is gone afterwards`, async (h) => {
  const { page } = h;
  if (mode === "reduced motion") await page.emulateMedia({ reducedMotion: "reduce" });
  await open(h);
  if (mode !== "reduced motion") await page.evaluate(() => { document.documentElement.dataset.fx = "lite"; });
  const { release, asked } = await pictures(page);
  await stage(page);
  await askedForSharp(page, asked);
  release();
  await page.waitForFunction(() => window.__up.host.style.getPropertyValue(window.__up.prop).includes("w=1920") && !document.querySelector(".art-up"), null, { timeout: 15000 });
  const { frames, swaps } = await record(page);
  assert.deepEqual(frames.filter((f) => !/up-art\?w=(300|1920)/.test(f.drawn)), [], "the element drew no picture in some frame");
  const layers = frames.flatMap((f) => f.layers);
  assert.ok(layers.length > 0, "no frame saw the layer");
  for (const l of layers) {
    assert.equal(l.fades, false, "the layer was set to fade");
    assert.equal(l.duration, "0s", "the layer has a transition");
    assert.ok(l.opacity <= 0.02 || l.opacity >= 0.99, `a frame in between was shown (${l.opacity})`);
  }
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].layers.length, 1, "the element took the sharp picture with no layer over it");
  assert.equal(swaps[0].layers[0].inline, "1");
  // sooner than the fade would have been over
  const first = frames.find((f) => f.layers.length).t;
  const took = frames.find((f) => f.address.includes("w=1920")).t;
  assert.ok(took - first < 420, `one step took ${took - first} ms`);
  assert.equal(await layerCount(page), 0, "the layer stayed");
});

ui.test("an element given another picture while the sharper one comes in drops the layer at once and keeps the other picture", async (h) => {
  const { page } = h;
  await open(h);
  const { release, asked } = await pictures(page);
  await stage(page);
  await askedForSharp(page, asked);
  release();
  await page.waitForFunction(() => document.querySelector("#up-host > .art-up"), null, { timeout: 15000 });
  // the billboard reuses the slide for the next title
  const left = await page.evaluate(async () => {
    const { host, prop } = window.__up;
    host.style.setProperty(prop, 'url("/img/up-other?w=300")');
    await new Promise((r) => setTimeout(r, 0)); // (the page's own notice of the change has run)
    return document.querySelectorAll(".art-up").length;
  });
  assert.equal(left, 0, "the layer stayed over the next title's picture");
  await page.waitForTimeout(1200); // well past the fade and the hold
  assert.equal(await address(page), 'url("/img/up-other?w=300")', "the old title's sharp picture was put on the next title");
  assert.equal(await layerCount(page), 0);
});

ui.test("behind the player nothing is laid over the page: the address is simply replaced", async (h) => {
  const { page } = h;
  await open(h);
  const { release, asked } = await pictures(page);
  await stage(page);
  await askedForSharp(page, asked);
  // a film starts while the sharp picture is on its way
  await page.evaluate(() => { const p = document.createElement("div"); p.className = "player"; p.id = "up-player"; p.style.display = "none"; document.body.append(p); });
  release();
  await page.waitForFunction(() => window.__up.host.style.getPropertyValue(window.__up.prop).includes("w=1920"), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const { frames, added } = await record(page);
  assert.equal(added, 0, "a layer was laid behind the player");
  assert.deepEqual(frames.filter((f) => f.layers.length), []);
  await page.evaluate(() => document.getElementById("up-player").remove());
});

// A phone's title page: the cover is painted by the heading (.detail-head::before),
// so the layer sits beside it and must have that cover's own box — in both looks.
for (const look of ["glass", "legacy"]) ui.test(`phone, ${look} look: on a title page the layer takes the box of the cover the heading paints`, { viewport: PHONE }, async (h) => {
  const { page, lib } = h;
  await open(h, `#/movie/${lib.film1.id}`, look);
  await page.locator(".detail-hero .detail-head").first().waitFor();
  await page.waitForTimeout(1200); // (the page's own pictures are in; nothing of its own is on the way)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.look || "legacy"), look);
  const { release, asked } = await pictures(page);
  await stage(page, { node: ".detail-hero" });
  await askedForSharp(page, asked);
  release();
  await page.waitForFunction(() => document.querySelector(".detail-head > .art-up"), null, { timeout: 15000 });
  const box = await page.evaluate(() => {
    const head = document.querySelector(".detail-head");
    // (size, place and repeat: of the first picture — the cover lists one per picture it draws, the layer draws the top one alone)
    const pick = (cs) => ({ position: cs.position, top: cs.top, right: cs.right, bottom: cs.bottom, left: cs.left, width: cs.width, height: cs.height, transform: cs.transform, origin: cs.transformOrigin, size: cs.backgroundSize.split(", ")[0], place: cs.backgroundPosition.split(", ")[0], repeat: cs.backgroundRepeat.split(", ")[0], z: cs.zIndex });
    const layer = head.querySelector(":scope > .art-up");
    return { cover: pick(getComputedStyle(head, "::before")), layer: pick(getComputedStyle(layer)), coverPicture: getComputedStyle(head, "::before").backgroundImage, layerPicture: layer.style.backgroundImage };
  });
  assert.match(box.coverPicture, /up-art\?w=300/, "the heading does not paint the cover on this screen: the test needs another page");
  assert.match(box.layerPicture, /up-art\?w=1920/);
  assert.deepEqual(box.layer, box.cover, "the layer is not where the cover is");
  await page.waitForFunction(() => window.__up.host.style.getPropertyValue("--hero-poster").includes("w=1920") && !document.querySelector(".art-up"), null, { timeout: 15000 });
  const { frames } = await record(page);
  assert.equal(frames[frames.length - 1].layers.length, 0);
  assert.equal(await layerCount(page), 0, "the layer stayed");
});

ui.run({ concurrency: 2 });

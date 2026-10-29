// /install — the public product page (public/install.html, src/lib/installpage.js):
// open to anyone, also on a server that requires sign-in; shows every app's
// version and how to install it; says nothing about the household; and
// leaves /download (what TVs and the Downloader app use) exactly as it was.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const REPO = path.join(__dirname, "..", "..");
const APK = path.join(REPO, "public", "aurora-tv.apk");
const PKG = require(path.join(REPO, "package.json"));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// People whose names must never reach the page, and a release note that
// names them and a library title (the CHANGELOG the instance reads is its own
// copy: the note is added there, beside a line that must still show).
const PEOPLE = ["Zelphine", "Quorrow"];
const NOTE_KEPT = "The remote now remembers the last TV it controlled.";

const ui = suite({
  setup: async (srv) => {
    // the published TV build, as the live server has it (the instance leaves the 45 MB file out)
    fs.copyFileSync(APK, path.join(srv.root, "public", "aurora-tv.apk"));
    for (const name of PEOPLE) srv.profiles[name] = await srv.api.createProfile(name, { open: true });
    const log = path.join(srv.root, "CHANGELOG.md");
    const text = fs.readFileSync(log, "utf8");
    const note = [
      "## 99.0.0 — 2099-01-01",
      "",
      `- **${NOTE_KEPT}**`,
      `- **Zelphine asked for this: Test Film One now starts faster.**`,
      `- **On Test Show every intro is now found.**`,
      "",
    ].join("\n");
    fs.writeFileSync(log, text.replace(/\n## /, `\n${note}\n## `));
    await srv.api.adminPost("/api/admin/auth-mode", { mode: "closed" });
  },
});

const get = (srv, url, opts = {}) => fetch(srv.url + url, { redirect: "manual", ...opts });

ui.test("signed out, on a server that requires sign-in: the page opens and shows the apps' versions", async ({ srv }) => {
  const res = await get(srv, "/install");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  // (the wall really is up: data needs a session)
  assert.equal((await get(srv, "/api/library")).status, 401);
  const tv = await (await get(srv, "/tv-version.json")).json();
  assert.ok(tv.versionName, "the TV build announces a version");
  assert.ok(html.includes(`Android TV <b>${tv.versionName}</b>`), "the hero names the TV app's version");
  assert.match(html, new RegExp(`Version ${tv.versionName.replace(/\./g, "\\.")} · <time datetime="\\d{4}-\\d{2}-\\d{2}">`), "the TV card has the version and its date");
  assert.ok(html.includes(`Website <b>${PKG.version}</b>`), "the hero names the website's version");
  assert.ok(html.includes(`>Coming soon<`), "no phone build yet: the phone slot says so");
  assert.ok(!/\{\{/.test(html), "every token was filled");
  // the stylesheets carry their content hash like every other shell's
  assert.match(html, /href="\/css\/install\.css\?v=[0-9a-f]{10}"/);
  // and the full list
  const changes = await get(srv, "/install/changes");
  assert.equal(changes.status, 200);
  assert.ok((await changes.text()).includes(NOTE_KEPT));
});

ui.test("/download is untouched: the APK itself, as an attachment; /aurora-tv.apk still points at it", async ({ srv }) => {
  const res = await get(srv, "/download");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /attachment; filename="aurora-tv\.apk"/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(sha(body), sha(fs.readFileSync(APK)), "the bytes are the published APK's");
  const old = await get(srv, "/aurora-tv.apk");
  assert.equal(old.status, 302);
  assert.equal(old.headers.get("location"), "/download");
});

ui.test("the page says nothing about the household: no profile names, no library titles, no notes that name them", async ({ srv }) => {
  // the private instance's library, and its people
  const titles = ["Test Film One", "Test Film Two", "Test Show"];
  for (const url of ["/install", "/install/changes"]) {
    const html = await (await get(srv, url)).text();
    for (const n of PEOPLE) assert.ok(!new RegExp(`\\b${n}\\b`, "i").test(html), `${url} names the profile ${n}`);
    for (const t of titles) assert.ok(!html.includes(t), `${url} names the library title ${t}`);
    assert.ok(html.includes(NOTE_KEPT), `${url}: the note that names no one is shown`);
    // nothing but the page itself: no data from the API in it
    assert.ok(!/"(profiles|movies|shows)"\s*:/.test(html), `${url} carries data`);
  }
});

ui.test("desktop: every picture loads, the QR code is drawn for this server's /download, tabs switch, nothing overflows", async ({ page, srv }) => {
  const missing = [];
  page.on("response", (r) => { if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${srv.url}/install`, { waitUntil: "load" });
  // every lazy picture, by scrolling the page through
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += innerHeight * 0.7) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
  });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20000 });
  const imgs = await page.evaluate(() => [...document.images].map((i) => ({ src: i.currentSrc, w: i.naturalWidth, alt: i.getAttribute("alt"), lazy: i.loading, width: i.getAttribute("width"), height: i.getAttribute("height") })));
  assert.ok(imgs.length >= 12, `${imgs.length} pictures`);
  for (const i of imgs) {
    assert.ok(i.w > 0, `${i.src} did not load`);
    assert.ok(i.alt !== null, `${i.src} has no alt`);
    assert.ok(i.width && i.height, `${i.src} has no size (layout would shift)`);
  }
  // the browser picked a modern format
  assert.ok(imgs.some((i) => /\.(avif|webp)$/.test(i.src)));
  assert.deepEqual(missing, [], "nothing on the page is missing");
  // the QR
  const qr = await page.locator("#qr svg").getAttribute("aria-label");
  assert.equal(qr, `QR code for ${srv.url}/download`);
  assert.ok(await page.locator("#qr svg path").count());
  // the address to type, as this browser reached the server
  assert.equal(await page.textContent("#tv-addr"), `${new URL(srv.url).host}/download`);
  // the tabs: one panel at a time, arrows move between them
  await page.click("#tab-tv");
  assert.equal(await page.isVisible("#notes-tv"), true);
  assert.equal(await page.isVisible("#notes-web"), false);
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getAttribute("#tab-web", "aria-selected"), "true");
  assert.equal(await page.isVisible("#notes-web"), true);
  // the Download button is the very /download
  assert.equal(await page.getAttribute("#tv-download", "href"), "/download");
  for (const w of [1024, 1440, 1920]) {
    await page.setViewportSize({ width: w, height: 900 });
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    assert.ok(m.sw <= m.iw, `${w}px: the page is ${m.sw}px wide`);
  }
});

for (const width of [360, 390, 430, 820]) {
  ui.test(`phone and tablet (${width}px): no sideways scroll, the apps and the steps are there`, { viewport: { width, height: 800 } }, async ({ page, srv }) => {
    await page.goto(`${srv.url}/install`, { waitUntil: "load" });
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += innerHeight * 0.7) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
      scrollTo(0, 0);
    });
    const m = await page.evaluate(() => {
      const wide = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== "fixed").map((e) => e.className || e.tagName).slice(0, 5);
      return { sw: document.documentElement.scrollWidth, iw: innerWidth, wide };
    });
    assert.ok(m.sw <= m.iw, `${width}px: the page is ${m.sw}px wide (${m.wide.join(", ")})`);
    for (const sel of ["#tv-download", "#ios .ios-steps", "#computer .steps", "#android .soon-badge"]) {
      assert.ok(await page.locator(sel).isVisible(), `${sel} at ${width}px`);
    }
  });
}

ui.test("the phone slot lights up by itself once an Android phone build is published", async ({ page, srv }) => {
  const apk = path.join(srv.root, "public", "aurora-phone.apk");
  const json = path.join(srv.root, "public", "phone-version.json");
  fs.copyFileSync(APK, apk); // (any APK: the version is read out of the file)
  fs.writeFileSync(json, JSON.stringify({ date: "2099-02-03" }));
  try {
    await new Promise((r) => setTimeout(r, 2100)); // (the page is kept two seconds)
    await page.goto(`${srv.url}/install`, { waitUntil: "load" });
    assert.equal(await page.getAttribute("#android", "data-state"), "ready");
    assert.ok(await page.locator('#android a[href="/download/phone"]').isVisible());
    assert.equal(await page.locator("#android .soon-badge").isVisible(), false);
    assert.match(await page.textContent("#android .ver"), /Version \d+\.\d+\.\d+ · February 3, 2099/);
  } finally {
    fs.rmSync(apk, { force: true });
    fs.rmSync(json, { force: true });
  }
});

ui.test("the classic look and the other themes: the page follows the visitor's own look", async ({ page, srv }) => {
  await page.addInitScript(() => { try { localStorage.setItem("aurora-look", "legacy"); localStorage.setItem("aurora-theme", "warm"); } catch {} });
  await page.goto(`${srv.url}/install`, { waitUntil: "load" });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.look), "legacy");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "warm");
  assert.equal(await page.locator("#sky").isVisible(), false, "no sky in the classic look");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(19, 16, 9)");
});

ui.test("Settings links to the page (What's new), and so does the TV sign-in code screen", async ({ page, srv, signIn }) => {
  await srv.api.adminPost("/api/admin/auth-mode", { mode: "open" });
  try {
    const p = srv.profiles[PEOPLE[0]];
    await signIn(p);
    await page.goto(`${srv.url}/#/preferences`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('#app a[href="/install"]', { state: "attached", timeout: 20000 });
    await page.evaluate(() => { location.hash = "#/pair"; });
    await page.waitForSelector('#app .pair-card a[href="/install#tv"]');
  } finally {
    await srv.api.adminPost("/api/admin/auth-mode", { mode: "closed" });
  }
});

ui.run({ concurrency: 1 });

// /install — the public product page (public/install.html, src/lib/installpage.js):
// open to anyone, also on a server that requires sign-in; shows every app's
// version and how to install it; says nothing about the household; and
// leaves /download (what TVs and the Downloader app use) exactly as it was.
// Its Download section (src/lib/releases.js): a tile per release that can be
// had, one click = the file by name (/download/<id>/latest), Verify with its
// SHA-256, the visitor's own device first, 320–1920 px, by keyboard.
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

// ---- the Download section (lib/releases.js) ----
const releases = require(path.join(REPO, "src", "lib", "releases"));
const TV_V = require(path.join(REPO, "src", "lib", "apkinfo")).read(APK, { hash: false }).versionName;
const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  googletv: "Mozilla/5.0 (Linux; Android 11; MiTV-AXSO0 Build/RTM6.230109.067; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Safari/537.36 GoogleTV",
};
// the browser says it is that device (navigator.userAgent included), before the page loads
const asDevice = async (page, ua) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setUserAgentOverride", { userAgent: ua });
  // a Mac has no touch screen (a "Macintosh" with one is an iPad), whatever this machine has
  await page.addInitScript((touch) => { try { Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => touch, configurable: true }); } catch {} }, /Mobile|iPhone|Android/.test(ua) ? 5 : 0);
};
// The page once every published file's checksum is known (worked out in the
// background after a new build; until then the page is not kept).
const settled = async (srv, ids = ["tv"]) => {
  const end = Date.now() + 30000;
  for (;;) {
    const html = await (await get(srv, "/install")).text();
    if (ids.every((id) => html.includes(`id="sha-${id}"`))) return html;
    if (Date.now() > end) throw new Error(`no checksum on the page for ${ids.join(", ")}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const tiles = (page) => page.$$eval("#dl-grid > .dl", (els) => els.map((e) => ({ id: e.dataset.id, here: e.classList.contains("here") })));
// an Android phone build on the instance (any APK: the version is read out of the file)
const publishPhone = async (srv) => {
  fs.copyFileSync(APK, path.join(srv.root, "public", "aurora-phone.apk"));
  fs.writeFileSync(path.join(srv.root, "public", "phone-version.json"), JSON.stringify({ date: "2099-02-03" }));
  await new Promise((r) => setTimeout(r, 2100)); // (the page is kept two seconds)
  await settled(srv, ["tv", "phone"]);
};
const unpublishPhone = async (srv) => {
  fs.rmSync(path.join(srv.root, "public", "aurora-phone.apk"), { force: true });
  fs.rmSync(path.join(srv.root, "public", "phone-version.json"), { force: true });
  await new Promise((r) => setTimeout(r, 2100));
};

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

ui.test("Download: a tile for each release of the one list that can be had today, the rest on one quiet line", async ({ srv }) => {
  const html = await settled(srv);
  const live = releases.list({ root: srv.root }).filter((r) => r.state === "available").map((r) => r.id);
  assert.deepEqual(live, ["tv", "ios", "web"], "no phone build on this instance yet");
  const shown = [...html.matchAll(/<li class="dl" data-id="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(shown, live, "the tiles, in the list's order (the page moves the visitor's own first)");
  // the TV's tile: its version and size from the APK, and the link that names the file
  const tv = /<li class="dl" data-id="tv"[\s\S]*?<\/li>/.exec(html)[0];
  assert.ok(tv.includes(`href="/download/tv/latest" download="Aurora-TV-${TV_V}.apk"`));
  assert.ok(tv.includes(`<span class="dl-meta">${TV_V} · 45 MB`));
  assert.ok(tv.includes(`<code id="sha-tv">${sha(fs.readFileSync(APK))}</code>`), "Verify shows the file's SHA-256");
  // the website: its version, nothing to download
  const web = /<li class="dl" data-id="web"[\s\S]*?<\/li>/.exec(html)[0];
  assert.ok(web.includes('href="/"') && web.includes(`Version ${PKG.version}`) && !web.includes("download="));
  // what is not here yet: the phone (no build) and the planned ones, as names on one line, no tiles
  const later = /<div class="dl-later">[\s\S]*?<\/div>/.exec(html)[0];
  for (const n of ["Android phone", "Windows", "macOS", "Linux", "Fire TV", "Samsung TV", "LG TV", "Apple TV"]) assert.ok(later.includes(`<span>${n}</span>`), n);
  assert.ok(!/<a |<button/.test(later), "nothing on that line pretends to be a download");
  // the hero's "Get the apps" and the top bar lead to it
  assert.ok(html.includes('<a class="btn btn-primary" href="#download">Get the apps</a>'));
  assert.ok(html.includes('<a href="#download">Get the apps</a>'));
});

ui.test("/download/tv/latest: the file as Aurora-TV-<version>.apk, no session needed; /download and /download/phone are as they were", async ({ srv }) => {
  for (const method of ["GET", "HEAD"]) {
    const res = await get(srv, "/download/tv/latest", { method });
    assert.equal(res.status, 200, method);
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="Aurora-TV-${TV_V}.apk"`);
    assert.equal(res.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal(Number(res.headers.get("content-length")), fs.statSync(APK).size);
    if (method === "GET") assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(fs.readFileSync(APK)));
  }
  // (the wall is up: this was without a session)
  assert.equal((await get(srv, "/api/library")).status, 401);
  // nothing published, nothing made, nothing known: plainly not there
  const none = await get(srv, "/download/phone/latest");
  assert.equal(none.status, 404);
  assert.equal(await none.text(), "No Android phone build has been published yet.");
  for (const id of ["windows", "web", "x"]) assert.equal((await get(srv, `/download/${id}/latest`)).status, 404, id);
  // the doors TVs and Downloader know are untouched
  assert.match((await get(srv, "/download", { method: "HEAD" })).headers.get("content-disposition"), /attachment; filename="aurora-tv\.apk"/);
  const phone = await get(srv, "/download/phone");
  assert.equal(phone.status, 404);
  assert.equal(await phone.text(), "No Android phone build has been published yet.");
});

ui.test("desktop Chrome: one click on the TV tile downloads Aurora-TV-<version>.apk, the right bytes; Verify shows the same SHA-256", async ({ page, srv }) => {
  await settled(srv);
  await asDevice(page, UA.windows);
  await page.goto(`${srv.url}/install`, { waitUntil: "load" });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('.dl[data-id="tv"] .dl-hit')]);
  assert.equal(dl.suggestedFilename(), `Aurora-TV-${TV_V}.apk`);
  const got = sha(fs.readFileSync(await dl.path()));
  assert.equal(got, sha(fs.readFileSync(APK)));
  await dl.delete();
  // Verify: closed until asked, then the checksum of that very file
  const sum = page.locator('.dl[data-id="tv"] .dl-sum');
  assert.equal(await sum.isVisible(), false);
  await page.click('.dl[data-id="tv"] .dl-verify summary');
  assert.equal(await sum.isVisible(), true);
  assert.equal((await page.textContent("#sha-tv")).trim(), got);
  assert.ok((await sum.textContent()).includes(`Aurora-TV-${TV_V}.apk`));
  // the panel stays inside its tile
  const [t, p] = await Promise.all([page.locator('.dl[data-id="tv"]').boundingBox(), sum.boundingBox()]);
  assert.ok(p.x >= t.x && p.y >= t.y && p.x + p.width <= t.x + t.width + 0.5 && p.y + p.height <= t.y + t.height + 0.5, "the checksum panel stays within its tile");
  // "Release notes" opens What's new on that app's tab
  await page.click('.dl[data-id="web"] a[data-notes]');
  assert.equal(await page.getAttribute("#tab-web", "aria-selected"), "true");
  await page.click('.dl[data-id="tv"] a[data-notes]');
  assert.equal(await page.getAttribute("#tab-tv", "aria-selected"), "true");
  assert.equal(await page.isVisible("#notes-tv"), true);
});

ui.test("This device: its tile comes first (on screen and in Tab order) and is the highlighted one", async ({ page, srv }) => {
  await settled(srv);
  // (no phone build on this instance yet: an Android phone gets the website first)
  const cases = [["windows", "web"], ["mac", "web"], ["iphone", "ios"], ["googletv", "tv"], ["android", "web"]];
  for (const [device, first] of cases) {
    await asDevice(page, UA[device]);
    await page.goto(`${srv.url}/install`, { waitUntil: "load" });
    const list = await tiles(page);
    assert.equal(list[0].id, first, `${device}: ${list.map((x) => x.id)}`);
    assert.deepEqual(list.filter((x) => x.here).map((x) => x.id), [first], `${device}: one tile is this device`);
    assert.equal(await page.locator(`.dl[data-id="${first}"] .dl-here`).isVisible(), true, `${device}: and says so`);
    assert.equal(await page.$$eval(".dl-here", (els) => els.filter((e) => e.offsetParent).length), 1);
    assert.match(await page.getAttribute(`.dl[data-id="${first}"] .dl-hit`, "aria-label"), /\(this device\)$/, "a screen reader hears it too");
    // the first Tab-stop in the grid is that tile's, and what is seen is the DOM's order
    assert.equal(await page.$eval("#dl-grid a", (a) => a.closest(".dl").dataset.id), first);
    const at = await page.$$eval("#dl-grid > .dl", (els) => els.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.top), Math.round(r.left)]));
    assert.deepEqual(at, [...at].sort((a, b) => a[0] - b[0] || a[1] - b[1]), `${device}: on screen as in the DOM`);
  }
});

ui.test("keyboard: Tab goes tile by tile through their small links, Enter downloads, Verify opens with Enter and closes with Escape", async ({ page, srv }) => {
  await settled(srv);
  await asDevice(page, UA.windows);
  await page.goto(`${srv.url}/install`, { waitUntil: "load" });
  // the skip link leads here
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("href")), "#download");
  await page.focus("#dl-grid .dl:first-child .dl-hit");
  const stops = [];
  for (let i = 0; i < 9; i++) {
    stops.push(await page.evaluate(() => {
      const a = document.activeElement;
      const t = a.closest(".dl");
      if (!t) return a.tagName;
      return `${t.dataset.id}:${a.classList.contains("dl-hit") ? "tile" : a.tagName === "SUMMARY" ? "Verify" : a.innerText.trim()}`;
    }));
    await page.keyboard.press("Tab");
  }
  // (at 1280px the small links say their long words)
  assert.deepEqual(stops, ["web:tile", "web:How to install", "web:Release notes", "tv:tile", "tv:How to install", "tv:Release notes", "tv:Verify", "ios:tile", "ios:Release notes"]);
  // every stop shows where it is
  await page.focus('.dl[data-id="tv"] .dl-hit');
  assert.notEqual(await page.$eval('.dl[data-id="tv"] .dl-hit', (a) => getComputedStyle(a).outlineStyle), "none");
  // Enter on the tile: the download
  const [dl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  assert.equal(dl.suggestedFilename(), `Aurora-TV-${TV_V}.apk`);
  await dl.delete();
  // Verify, by keyboard
  await page.focus('.dl[data-id="tv"] .dl-verify summary');
  await page.keyboard.press("Enter");
  assert.equal(await page.$eval('.dl[data-id="tv"] .dl-verify', (d) => d.open), true);
  await page.keyboard.press("Tab"); // into the panel: its Copy button
  assert.equal(await page.evaluate(() => document.activeElement.dataset.copy), "sha-tv");
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval('.dl[data-id="tv"] .dl-verify', (d) => d.open), false);
  assert.equal(await page.evaluate(() => document.activeElement.tagName), "SUMMARY", "focus goes back to Verify");
});

for (const width of [320, 360, 390, 430, 600, 820, 1024, 1280, 1440, 1920]) {
  ui.test(`Download at ${width}px: two columns on a phone, one row on a computer, nothing spills, every target is big enough`, { viewport: { width, height: 900 } }, async ({ page, srv }) => {
    await settled(srv);
    await asDevice(page, width < 600 ? UA.android : UA.windows);
    await page.goto(`${srv.url}/install#download`, { waitUntil: "load" });
    // and once with a checksum open (the widest content a tile has)
    for (const open of [false, true]) {
      if (open) await page.click('.dl[data-id="tv"] .dl-verify summary');
      const m = await page.evaluate(() => {
        const grid = document.getElementById("dl-grid");
        const els = [...grid.children];
        const rects = els.map((e) => e.getBoundingClientRect());
        const seen = (e) => e.checkVisibility(); // (a closed Verify's panel is not drawn at all)
        const spill = [...document.querySelectorAll("#download *")].filter((e) => seen(e) && e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.className || e.tagName).slice(0, 5);
        const inside = els.flatMap((e) => {
          const b = e.getBoundingClientRect();
          const out = [...e.querySelectorAll("*")].filter((c) => { if (!seen(c)) return false; const r = c.getBoundingClientRect(); return r.width && (r.left < b.left - 0.5 || r.right > b.right + 0.5); });
          return e.scrollWidth > e.clientWidth + 1 || out.length ? [`${e.dataset.id} ${out.map((c) => c.className || c.tagName).slice(0, 3)}`] : [];
        });
        const targets = [...grid.querySelectorAll(".dl-hit, .dl-more > a, .dl-more > button:not([hidden]), summary")].map((e) => { const r = e.getBoundingClientRect(); return { what: `${e.closest(".dl").dataset.id} ${e.className || e.tagName}`, w: r.width, h: r.height }; });
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, cols: new Set(rects.map((r) => Math.round(r.left))).size, rows: new Set(rects.map((r) => Math.round(r.top))).size, spill, inside, targets };
      });
      assert.ok(m.sw <= m.iw, `${width}px: the page is ${m.sw}px wide`);
      assert.deepEqual(m.spill, [], `${width}px: nothing in the section reaches past the screen`);
      assert.deepEqual(m.inside, [], `${width}px${open ? ", Verify open" : ""}: everything in a tile stays within it`);
      if (width < 600) assert.equal(m.cols, 2, "two columns on a phone");
      if (width >= 1000) assert.equal(m.rows, 1, "one row on a computer");
      for (const t of m.targets) {
        assert.ok(t.h >= 44, `${width}px, ${t.what}: ${t.h}px tall`);
        assert.ok(t.w >= (/dl-hit/.test(t.what) ? 120 : 30), `${width}px, ${t.what}: ${t.w}px wide`);
      }
    }
    // the Coming later line stays one quiet line on a computer
    if (width >= 1024) assert.ok(await page.$eval(".dl-later", (e) => e.getBoundingClientRect().height) < 40);
  });
}

ui.test("Chrome on an Android phone: once a phone build is published its tile comes first and one tap downloads Aurora-Phone-<version>.apk", { viewport: { width: 390, height: 844 } }, async ({ page, srv }) => {
  await publishPhone(srv);
  try {
    await asDevice(page, UA.android);
    await page.goto(`${srv.url}/install`, { waitUntil: "load" });
    const list = await tiles(page);
    assert.deepEqual(list.map((x) => x.id), ["phone", "tv", "ios", "web"]);
    assert.equal(list[0].here, true);
    assert.ok(!(await page.textContent(".dl-later")).includes("Android phone"), "no longer on the Coming later line");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.tap('.dl[data-id="phone"] .dl-hit')]);
    assert.equal(dl.suggestedFilename(), `Aurora-Phone-${TV_V}.apk`);
    assert.equal(sha(fs.readFileSync(await dl.path())), sha(fs.readFileSync(APK)));
    await dl.delete();
    assert.equal((await page.textContent("#sha-phone")).trim(), sha(fs.readFileSync(APK)));
    // and the old door is as it was
    assert.match((await get(srv, "/download/phone", { method: "HEAD" })).headers.get("content-disposition"), /attachment; filename="aurora-phone\.apk"/);
  } finally {
    await unpublishPhone(srv);
  }
});

ui.test("Safari on an iPhone (as far as Chrome can stand in): its own tile leads to the Home Screen steps; a file link downloads on the server's word alone", { viewport: { width: 390, height: 844 } }, async ({ page, srv }) => {
  await settled(srv);
  await asDevice(page, UA.iphone);
  await page.goto(`${srv.url}/install`, { waitUntil: "load" });
  assert.equal((await tiles(page))[0].id, "ios");
  await page.click('.dl[data-id="ios"] .dl-hit');
  await page.waitForFunction(() => location.hash === "#ios");
  // (Safari honours Content-Disposition with or without the download
  // attribute: the response names the file by itself, whoever asks)
  const res = await get(srv, "/download/tv/latest", { method: "HEAD", headers: { "User-Agent": UA.iphone } });
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="Aurora-TV-${TV_V}.apk"`);
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

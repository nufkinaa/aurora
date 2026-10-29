// The one list of releases (src/lib/releases.js) and what /install draws from
// it (src/lib/installpage.js tileHtml / laterHtml): every entry well formed,
// a file "available" exactly when it exists and reads, its checksum worked
// out, /download/<id>/latest handing it over by name — and the glyphs
// (src/lib/platform-icons.js) inline, monochrome, one per entry.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const releases = require("../src/lib/releases");
const icons = require("../src/lib/platform-icons");
const { _internals: ip } = require("../src/lib/installpage");

const REPO = path.join(__dirname, "..");
const TV_APK = path.join(REPO, "public", "aurora-tv.apk");
const haveApk = fs.existsSync(TV_APK);
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// a throwaway root with a package.json, and whichever files a test puts there
const tmpRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-releases-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
  return root;
};
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("every entry is well formed: a unique id, a family, a glyph, and what its kind needs", () => {
  const ids = new Set();
  for (const e of releases.RELEASES) {
    assert.match(e.id, /^[a-z][a-z0-9-]*$/, `${e.id}: an id that can be a path word`);
    assert.ok(!ids.has(e.id), `${e.id} twice`);
    ids.add(e.id);
    assert.ok(e.name && typeof e.name === "string", `${e.id}: a name`);
    assert.ok(["tv", "phone", "computer", "web"].includes(e.family), `${e.id}: family ${e.family}`);
    assert.ok(icons.TILE[e.icon] || icons.LATER[e.icon], `${e.id}: the glyph ${e.icon} exists`);
    if (e.planned) {
      assert.ok(!e.file && !e.href, `${e.id}: a planned entry has nothing to hand over yet`);
      continue;
    }
    assert.ok(["file", "web", "webapp"].includes(e.kind), `${e.id}: kind ${e.kind}`);
    assert.ok(Array.isArray(e.for) && e.for.length, `${e.id}: the devices it is first on`);
    assert.ok(e.action, `${e.id}: the words on its button`);
    if (e.kind === "file") {
      assert.ok(e.file && ["apk", "sidecar"].includes(e.read), `${e.id}: a file and how to read it`);
      assert.match(e.filename, /^Aurora-[A-Za-z-]+-\{version\}\.\w+$/, `${e.id}: its name on the disk carries the version`);
      assert.ok(icons.TILE[e.icon], `${e.id}: a tile glyph`);
    } else {
      assert.ok(e.href, `${e.id}: where it is`);
    }
  }
  // today's: the TV, the phone, the iPhone's web app and the website; and the planned ones elia named
  const live = releases.RELEASES.filter((e) => !e.planned).map((e) => e.id);
  assert.deepEqual(live, ["tv", "phone", "ios", "web"]);
  const planned = releases.RELEASES.filter((e) => e.planned).map((e) => e.id);
  for (const id of ["windows", "macos", "linux", "firetv", "samsung", "lg", "appletv"]) assert.ok(planned.includes(id), id);
  // the two doors that TVs, phones and Downloader know stay where they are
  assert.equal(releases.RELEASES.find((e) => e.id === "tv").door, "/download");
  assert.equal(releases.RELEASES.find((e) => e.id === "phone").door, "/download/phone");
  // the website is the fallback for every device that has no app of its own
  const web = releases.RELEASES.find((e) => e.id === "web");
  for (const d of ["windows", "mac", "linux", "chromeos", "android", "ios", "smarttv", "other"]) assert.ok(web.for.includes(d), d);
});

test("states: a file is 'soon' until it exists, then 'available' with its version, size, date and name", { skip: !haveApk && "no APK in public/" }, async () => {
  const root = tmpRoot();
  try {
    const entry = { id: "tv", name: "Android TV", family: "tv", icon: "android-tv", for: ["tv"], kind: "file", file: "public/aurora-tv.apk", read: "apk", filename: "Aurora-TV-{version}.apk", action: "Download" };
    let r = releases.resolve(entry, { root });
    assert.equal(r.state, "soon");
    assert.equal(r.href, null);

    // not an APK at all: still not offered
    fs.writeFileSync(path.join(root, "public", "aurora-tv.apk"), "not a zip");
    assert.equal(releases.resolve(entry, { root }).state, "soon");

    const apk = path.join(root, "public", "aurora-tv.apk");
    fs.copyFileSync(TV_APK, apk);
    const info = require("../src/lib/apkinfo").read(apk, { hash: false });
    r = releases.resolve(entry, { root, dateFor: () => "2026-10-29" });
    assert.equal(r.state, "available");
    assert.equal(r.version, info.versionName);
    assert.equal(r.sizeBytes, fs.statSync(apk).size);
    assert.equal(r.href, "/download/tv/latest");
    assert.equal(r.filename, `Aurora-TV-${info.versionName}.apk`);
    assert.equal(r.date, "2026-10-29", "dated by its release, when there is one");
    // the checksum: worked out in the background, then there on every read
    const hex = await until(() => releases.resolve(entry, { root }).sha256);
    assert.equal(hex, sha(apk));
    // no release note for it: the file's own day
    r = releases.resolve({ ...entry, dated: "changelog" }, { root, dateFor: () => null });
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("states: a sidecar-read file (how a Windows or Mac build would come in), a planned entry, the website", async () => {
  const root = tmpRoot();
  try {
    const entry = { id: "windows", name: "Windows", family: "computer", icon: "windows", for: ["windows"], kind: "file", file: "public/Aurora-Setup.exe", read: "sidecar", meta: "public/windows-version.json", filename: "Aurora-Windows-{version}.exe", action: "Download" };
    assert.equal(releases.resolve(entry, { root }).state, "soon");
    fs.writeFileSync(path.join(root, "public", "Aurora-Setup.exe"), Buffer.alloc(4096, 7));
    assert.equal(releases.resolve(entry, { root }).state, "soon", "no version known yet");
    fs.writeFileSync(path.join(root, "public", "windows-version.json"), JSON.stringify({ version: "1.0.0", date: "2027-01-02" }));
    const r = releases.resolve(entry, { root });
    assert.deepEqual([r.state, r.version, r.sizeBytes, r.date, r.filename, r.href], ["available", "1.0.0", 4096, "2027-01-02", "Aurora-Windows-1.0.0.exe", "/download/windows/latest"]);
    assert.equal(await until(() => releases.resolve(entry, { root }).sha256), sha(path.join(root, "public", "Aurora-Setup.exe")));

    const planned = releases.resolve(releases.RELEASES.find((e) => e.id === "linux"), { root });
    assert.equal(planned.state, "planned");
    const web = releases.resolve(releases.RELEASES.find((e) => e.id === "web"), { root });
    assert.deepEqual([web.state, web.version, web.href, web.sha256], ["available", "9.8.7", "/", null]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a version becomes a safe file name, whatever is in it", () => {
  const e = { filename: "Aurora-TV-{version}.apk" };
  assert.equal(releases.fileName(e, "5.8.1"), "Aurora-TV-5.8.1.apk");
  assert.equal(releases.fileName(e, '5.8"/../x'), "Aurora-TV-5.8..x.apk");
  assert.equal(releases.fileName(e, ""), "Aurora-TV-latest.apk");
});

// ---------- /download/<id>/latest ----------
const serve = (opts) => new Promise((resolve) => {
  const app = express();
  app.get("/download/:id/latest", releases.sendLatest(opts));
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const get = (s, url, method = "GET") => new Promise((resolve, reject) => {
  const req = http.request(`http://127.0.0.1:${s.address().port}${url}`, { method, agent: false }, (res) => {
    const chunks = [];
    res.on("data", (d) => chunks.push(d));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on("error", reject);
  req.end();
});

test("/download/<id>/latest: the file as an attachment named for its version; nothing for what is not there", { skip: !haveApk && "no APK in public/" }, async () => {
  const root = tmpRoot();
  const list = [
    { id: "tv", name: "Android TV", family: "tv", icon: "android-tv", for: ["tv"], kind: "file", file: "public/aurora-tv.apk", read: "apk", filename: "Aurora-TV-{version}.apk", action: "Download" },
    { id: "phone", name: "Android phone", family: "phone", icon: "android-phone", for: ["android"], kind: "file", file: "public/aurora-phone.apk", read: "apk", filename: "Aurora-Phone-{version}.apk", action: "Download" },
    { id: "web", name: "Web", family: "web", icon: "web", for: ["other"], kind: "web", href: "/", read: "package", action: "Open" },
    { id: "linux", name: "Linux", family: "computer", icon: "linux", planned: true },
  ];
  fs.copyFileSync(TV_APK, path.join(root, "public", "aurora-tv.apk"));
  const s = await serve({ root, releases: list });
  try {
    const v = require("../src/lib/apkinfo").read(path.join(root, "public", "aurora-tv.apk"), { hash: false }).versionName;
    let r = await get(s, "/download/tv/latest");
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-disposition"], `attachment; filename="Aurora-TV-${v}.apk"`);
    assert.equal(r.headers["content-type"], "application/vnd.android.package-archive");
    assert.equal(r.headers["cache-control"], "no-cache", "latest moves: always asked again");
    assert.equal(crypto.createHash("sha256").update(r.body).digest("hex"), sha(TV_APK), "the bytes are the file's");
    r = await get(s, "/download/tv/latest", "HEAD");
    assert.equal(r.status, 200);
    assert.equal(Number(r.headers["content-length"]), fs.statSync(TV_APK).size);
    // not published, not a file, not made, not in the list
    r = await get(s, "/download/phone/latest");
    assert.equal(r.status, 404);
    assert.equal(r.body.toString(), "No Android phone build has been published yet.");
    for (const id of ["web", "linux", "nothing", "..%2F..%2Fpackage.json"]) {
      r = await get(s, `/download/${id}/latest`);
      assert.equal(r.status, 404, id);
    }
  } finally {
    s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- what the page draws ----------
const sample = (over = {}) => ({
  id: "tv", name: "Android TV", detail: "and Google TV", family: "tv", icon: "android-tv", for: ["tv"], kind: "file", action: "Download",
  steps: "#tv", notes: "tv", note: "", short: "", installable: false, state: "available", version: "5.8.1", sizeBytes: 47081389,
  date: "2026-10-29", sha256: "ab".repeat(32), href: "/download/tv/latest", filename: "Aurora-TV-5.8.1.apk", door: "/download", ...over,
});

test("a file's tile: one link that downloads it by name, its facts, and the small links with Verify", () => {
  const html = ip.tileHtml(sample());
  assert.match(html, /^<li class="dl" data-id="tv" data-family="tv" data-for="tv">/);
  assert.match(html, /<a class="dl-hit" href="\/download\/tv\/latest" download="Aurora-TV-5\.8\.1\.apk"[^>]*aria-label="Download Aurora for Android TV, version 5\.8\.1, 45 MB">/);
  assert.match(html, /<span class="dl-meta">5\.8\.1 · 45 MB <time datetime="2026-10-29">October 29, 2026<\/time><\/span>/);
  assert.match(html, /<a href="#tv">.*How to install.*<\/a>/);
  assert.match(html, /<a href="#new" data-notes="tab-tv">/);
  assert.match(html, /<details class="dl-verify"><summary>Verify<\/summary>.*<code id="sha-tv">(ab){32}<\/code>/);
  assert.match(html, /data-copy="sha-tv"/);
  // the glyph is inline and says nothing to a screen reader
  assert.match(html, /<span class="dl-icon"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">/);
  // no checksum yet: no Verify (the page is then not kept, the next one has it)
  assert.ok(!ip.tileHtml(sample({ sha256: null })).includes("dl-verify"));
});

test("the other tiles: the website opens, the iPhone's goes to its steps; everything is escaped", () => {
  const web = ip.tileHtml(sample({ id: "web", kind: "web", icon: "web", name: "Web", action: "Open", href: "/", sizeBytes: null, sha256: null, filename: null, steps: "#computer", notes: "web", installable: true, for: ["windows", "mac"] }));
  assert.match(web, /<a class="dl-hit" href="\/" aria-label="Open Aurora in the browser, version 5\.8\.1">/);
  assert.ok(!/download=/.test(web) && !/dl-verify/.test(web));
  assert.match(web, /<button class="install-pwa" type="button" hidden>/);
  assert.match(web, /data-for="windows mac"/);
  const ios = ip.tileHtml(sample({ id: "ios", kind: "webapp", icon: "apple-phone", name: "iPhone & iPad", action: "Add to Home Screen", short: "Add to Home", href: "#ios", sizeBytes: null, sha256: null, filename: null, steps: "#ios", notes: "web" }));
  assert.match(ios, /href="#ios"/);
  assert.match(ios, /iPhone &amp; iPad/);
  assert.match(ios, /<span class="l">Add to Home Screen<\/span><span class="s">Add to Home<\/span>/);
  assert.ok(!ios.includes('href="#ios">'), "no Steps link: the tile itself is the steps");
  const evil = ip.tileHtml(sample({ name: '<img src=x onerror=alert(1)>', filename: 'a"b.apk' }));
  assert.ok(!evil.includes("<img"), "names are escaped");
  assert.ok(evil.includes('download="a&quot;b.apk"'));
});

test("the Coming later line: names and small glyphs, nothing to click", () => {
  const html = ip.laterHtml(releases.list().filter((r) => r.state === "planned"));
  assert.match(html, /^<div class="dl-later"><p class="dl-later-t" id="dl-later-t">Coming later<\/p><ul aria-labelledby="dl-later-t">/);
  for (const n of ["Windows", "macOS", "Linux", "Fire TV", "Samsung TV", "LG TV", "Apple TV"]) assert.ok(html.includes(`<span>${n}</span>`), n);
  assert.ok(!/<a |<button/.test(html));
  assert.equal(ip.laterHtml([]), "");
});

test("the glyphs: inline SVG in currentColor, no outside reference, one weight", () => {
  for (const [name, svg] of Object.entries({ ...icons.TILE, ...icons.LATER })) {
    assert.match(svg, /^<svg viewBox="[-\d. ]+" aria-hidden="true" focusable="false">.*<\/svg>$/, name);
    assert.ok(!/href|url\(|https?:/.test(svg), `${name} refers to nothing outside`);
    assert.ok(!/#[0-9a-f]{3,6}\b/i.test(svg), `${name}: no colour of its own`);
    for (const w of svg.match(/stroke-width="([\d.]+)"/g) || []) assert.ok(/1\.6|1\.3/.test(w), `${name}: ${w}`);
  }
  // Android TV and the Android phone are told apart (a TV and a phone around the same mark)
  assert.notEqual(icons.TILE["android-tv"], icons.TILE["android-phone"]);
  assert.ok(icons.TILE["android-tv"].includes(icons._paths.android) && icons.TILE["android-phone"].includes(icons._paths.android));
  assert.equal(icons.icon("no-such-glyph"), icons.LATER.tv);
});

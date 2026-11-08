// Admin → Downloads → On disk: the storage drives card (lib/drives,
// docs/storage-drives.md). One calm card per drive: local or network, a bar
// of what is Aurora's / everything else / free (GB and %), the speed score,
// and the button that matters — "Use this drive too", "Stop using for new
// downloads", "Test again". The headline counts the drives in use together.
//
// The first tests hand the page a made-up answer (GET /api/admin/drives) and
// catch the presses, at desktop and phone width. The last two go through the
// private instance for real: a temp folder made into a drive of its own
// (AURORA_DRIVES_EXTRA), "Use this drive too" on it, and then that drive
// stopping answering (AURORA_DRIVES_FAKE_HANG with a switch file) — the
// viewer's 503 with the sentence, other titles still playing, the summary's
// Needs you, and everything back by itself.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, openDetails, DESKTOP, PHONE } = require("./helpers");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-drives-ui-"));
const EXTRA = path.join(SCRATCH, "extra-drive"); // a local folder: "Use this drive too" for real
const NET = path.join(SCRATCH, "net-drive"); // a "network" folder that can stop answering
const SWITCH = path.join(SCRATCH, "hang-now");
fs.mkdirSync(EXTRA, { recursive: true });
fs.mkdirSync(NET, { recursive: true });

const ui = suite({
  server: {
    env: {
      AURORA_DRIVES_EXTRA: JSON.stringify([{ path: EXTRA, label: "Extra drive" }, { path: NET, network: true, label: "Net drive" }]),
      AURORA_DRIVES_FAKE_HANG: NET,
      AURORA_DRIVES_FAKE_HANG_SWITCH: SWITCH,
    },
  },
});
process.on("exit", () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

const SHOTS = process.env.DRV_SHOTS || path.join(os.tmpdir(), "aurora-agents", "storage-drives", "shots");
const shot = async (page, name, el = null) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await (el ? page.locator(el) : page).screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const GIB = 1024 ** 3;
const TIB = 1024 ** 4;
const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};
const toastSays = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll("#toasts .toast")].some((t) => new RegExp(src).test(t.textContent)), re.source);

// nufurora.com the day the storage volume came: the NVMe in use, the NFS volume new
const NVME = {
  id: "/", name: "System disk", mount: "/", source: "/dev/vda3", fstype: "ext4", network: false, readOnly: false, hardMount: false, options: [],
  total: 500 * GIB, free: 100 * GIB, used: 400 * GIB, answering: true, downSince: null, inUse: true, holds: ["movies", "shows", "data", "staging"],
  newDownloads: true, aurora: { bytes: 300 * GIB, files: 1800, partial: false, at: Date.now() - 3600e3 },
  score: { value: 92, word: "Fast", streams: 180, measured: { readMBps: 2300, writeMBps: 1500, iops: 21000, latencyMs: 0.08, readMethod: "direct (O_DIRECT, page cache bypassed)", randomMethod: "cache dropped first" }, at: Date.now() - 7200e3 },
  scoreError: null, testing: null, titles: 412, reserve: 50 * GIB,
};
const NFS = {
  id: "/mnt/storagespace", name: "storagespace", mount: "/mnt/storagespace", source: "46.38.248.210:/voln1117606a1", fstype: "nfs", network: true, readOnly: false, hardMount: true, options: ["rw", "vers=3", "hard"],
  total: 1 * TIB, free: 0.99 * TIB, used: 0.01 * TIB, answering: true, downSince: null, inUse: false, holds: [],
  newDownloads: false, aurora: null, score: null, scoreError: null, testing: null, titles: 0, reserve: null,
};
const answer = (drives) => ({ drives, reservePct: 10, reserveMaxBytes: 50e9 });
const stubDisk = (page) => page.route((u) => u.pathname === "/api/admin/disk", (route) => route.fulfill({ json: { disks: [{ root: "/opt/aurora/media/Movies", free: 100 * GIB, total: 500 * GIB }], minFreePct: 0, forecast: null } }));
const stubDrives = async (page, answers) => {
  let n = 0;
  await page.route((u) => u.pathname === "/api/admin/drives", (route) => route.fulfill({ json: answers[Math.min(n++, answers.length - 1)] }));
};
const catchPosts = async (page) => {
  const posts = [];
  await page.route((u) => /^\/api\/admin\/drives\/(use|new-downloads|test)$/.test(u.pathname), (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    const what = new URL(route.request().url()).pathname.split("/").pop();
    posts.push([what, body]);
    return route.fulfill({ json: what === "use" ? { ok: true, movies: "/mnt/storagespace/Aurora/Movies", shows: "/mnt/storagespace/Aurora/Shows" } : { ok: true, waiting: null } });
  });
  return posts;
};
const openDisk = async (page) => {
  await page.click('.tab[data-tab="downloads"]');
  await openDetails(page, "d-disk");
  await page.waitForSelector("#drives-card .drv");
};
const card = (page, id) => page.locator(`#drives-card .drv[data-drive="${id}"]`);

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`a card per drive: local/network, Aurora's share, free, the score, the right buttons (${name})`, { viewport }, async ({ page, srv }) => {
    await stubDisk(page);
    const inUse = { ...NFS, inUse: true, newDownloads: true, holds: ["movies", "shows"], aurora: { bytes: 0, files: 0, partial: false, at: Date.now() }, testing: "running", reserve: 50 * GIB };
    await stubDrives(page, [answer([NVME, NFS]), answer([NVME, inUse]), answer([NVME, { ...inUse, newDownloads: false, testing: null }])]);
    const posts = await catchPosts(page);
    await enter(page, srv);
    await openDisk(page);

    assert.equal(await page.locator("#drives-card .drv").count(), 2);
    const nvme = await card(page, "/").innerText();
    assert.match(nvme, /System disk/);
    assert.match(nvme, /Local/);
    assert.match(nvme, /In use/);
    assert.match(nvme, /Aurora 300\.0 GB · 60%/);
    assert.match(nvme, /Other 100\.0 GB · 20%/);
    assert.match(nvme, /Free 100\.0 GB · 20%/);
    assert.match(nvme, /Used 400\.0 GB of 500\.0 GB \(80%\) · keeps 50\.0 GB free/);
    assert.match(nvme, /New downloads can go here\. 412 titles here\./);
    assert.match(nvme, /Speed 92 Fast · read 2300 MB\/s · write 1500 MB\/s · 21000 small reads\/s · about 180 4K streams at once/);
    assert.equal(await card(page, "/").locator('[data-drv-act="stop"]').innerText(), "Stop using for new downloads");
    assert.equal(await card(page, "/").locator('[data-drv-act="test"]').innerText(), "Test again");
    // the bar: Aurora's part and the rest, as wide as they are
    const widths = await card(page, "/").locator(".drv-bar i").evaluateAll((els) => els.map((e) => e.style.width));
    assert.deepEqual(widths, ["60%", "20%"]);

    const nfs = await card(page, "/mnt/storagespace").innerText();
    assert.match(nfs, /storagespace/);
    assert.match(nfs, /Network/);
    assert.match(nfs, /Not in use/);
    assert.match(nfs, /Free 1\.0 TB · 99%/);
    assert.match(nfs, /Speed: tested when you start using it\./);
    assert.match(nfs, /Mounted “hard”/);
    assert.equal(await card(page, "/mnt/storagespace").locator('[data-drv-act="use"]').innerText(), "Use this drive too");
    // the in-use drive first
    assert.deepEqual(await page.locator("#drives-card .drv").evaluateAll((els) => els.map((e) => e.dataset.drive)), ["/", "/mnt/storagespace"]);
    // the old bars give way to the cards
    assert.equal(await page.locator("#disk-bars").isVisible(), false);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(sw <= 1, `the page scrolls sideways by ${sw}px`);
    await shot(page, `drives-${name}`, "#drives-card");

    // "Use this drive too": one question, then the press
    await card(page, "/mnt/storagespace").locator('[data-drv-act="use"]').click();
    const dlg = page.locator("dialog.ask");
    await dlg.waitFor();
    assert.match(await dlg.innerText(), /Use \/mnt\/storagespace for Aurora too\?[\s\S]*\/mnt\/storagespace\/Aurora\/Movies and \/mnt\/storagespace\/Aurora\/Shows[\s\S]*Nothing already on the drive is moved or deleted\./);
    await shot(page, `drives-ask-${name}`, "dialog.ask");
    await dlg.locator(".ask-yes").click();
    await toastSays(page, /Now using \/mnt\/storagespace/);
    assert.deepEqual(posts[0], ["use", { id: "/mnt/storagespace" }]);
    await page.waitForFunction(() => /In use/.test(document.querySelector('#drives-card .drv[data-drive="/mnt/storagespace"]').innerText));
    // both in use: the headline counts them together
    await page.waitForFunction(() => /free on 2 drives/.test(document.getElementById("disk-headline").textContent));
    assert.match(await page.textContent("#disk-headline"), /^1\.1 TB free on 2 drives/);
    assert.match(await card(page, "/mnt/storagespace").innerText(), /Speed check: running now/);
    assert.equal(await card(page, "/mnt/storagespace").locator('[data-drv-act="test"]').isDisabled(), true, "no second test while one runs");

    // "Stop using for new downloads"
    await card(page, "/mnt/storagespace").locator('[data-drv-act="stop"]').click();
    await toastSays(page, /No new downloads to \/mnt\/storagespace — what is there stays/);
    assert.deepEqual(posts[1], ["new-downloads", { id: "/mnt/storagespace", on: false }]);
    await page.waitForFunction(() => /No new downloads/.test(document.querySelector('#drives-card .drv[data-drive="/mnt/storagespace"]').innerText));
    assert.equal(await card(page, "/mnt/storagespace").locator('[data-drv-act="resume"]').innerText(), "Use for new downloads again");
    // "Test again"
    await card(page, "/").locator('[data-drv-act="test"]').click();
    await toastSays(page, /Speed check started/);
    assert.deepEqual(posts[2], ["test", { id: "/" }]);
  });
}

ui.test("a drive that is not answering: said on its card and in the headline", async ({ page, srv }) => {
  await stubDisk(page);
  const since = new Date(); since.setHours(15, 42, 0, 0);
  const down = { ...NFS, inUse: true, newDownloads: true, holds: ["movies", "shows"], answering: false, downSince: since.getTime(), why: "no answer in 6 s", total: null, free: null, used: null, titles: 37 };
  await stubDrives(page, [answer([NVME, down])]);
  await enter(page, srv);
  await openDisk(page);
  const text = await card(page, "/mnt/storagespace").innerText();
  assert.match(text, /Not answering/);
  assert.match(text, /Not answering since 15:42 — 37 titles can't play\. New downloads go to the other drives; everything resumes by itself when it answers\./);
  assert.match(text, /No numbers while it does not answer\./);
  assert.equal(await card(page, "/mnt/storagespace").getAttribute("data-down"), "1");
  assert.equal(await card(page, "/mnt/storagespace").locator('[data-drv-act="test"]').isDisabled(), true);
  assert.match(await page.textContent("#disk-headline"), /100\.0 GB free on 1 drive · 1 drive not answering/);
  await shot(page, "drives-down", "#drives-card");
});

ui.test("Copy for Claude on On disk starts with the drives", { permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
  await stubDisk(page);
  await stubDrives(page, [answer([NVME, NFS])]);
  await enter(page, srv);
  await openDisk(page);
  await page.click('details.more[data-more="d-disk"] [data-copy-for="d-disk"]');
  await page.waitForFunction(async () => /Drives:/.test(await navigator.clipboard.readText()), null, { timeout: 15000 });
  const text = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  assert.match(text, /Drives:\n\| drive \| kind \| fs \| state \| used \| Aurora \| free \| speed \| mount options \|/);
  assert.match(text, /\| \/ \| local \| ext4 \| in use \| 400\.0 GB of 500\.0 GB \(80%\) \| 300\.0 GB \(60%\) \| 100\.0 GB \| 92 Fast \(read 2300 MB\/s, write 1500 MB\/s, 21000 small reads\/s; read direct \(O_DIRECT, page cache bypassed\)\) \|/);
  assert.match(text, /\| \/mnt\/storagespace \| network \| nfs \| not in use \| .* \| - \| 1\.0 TB \| not tested \| hard \[rw,vers=3,hard\] \|/);
  assert.match(text, /Library folders:\n\| drive \| free \| size \|/);
});

// ---- for real, on the private instance ----
ui.test("for real: Use this drive too makes the folders, updates config.json, and the card says In use", { timeout: 90000 }, async ({ page, srv }) => {
  await enter(page, srv);
  await openDisk(page);
  const id = path.resolve(EXTRA);
  const c = card(page, id.replace(/\\/g, "\\\\"));
  await c.waitFor();
  assert.match(await c.innerText(), /Extra drive[\s\S]*Not in use/);
  await c.locator('[data-drv-act="use"]').click();
  await page.locator("dialog.ask .ask-yes").click();
  await toastSays(page, /Now using/);
  for (const f of ["Movies", "Shows"]) assert.ok(fs.statSync(path.join(EXTRA, "Aurora", f)).isDirectory(), `${f} made`);
  const cfg = JSON.parse(fs.readFileSync(path.join(srv.root, "config.json"), "utf8"));
  assert.ok(cfg.libraries.movies.includes(path.join(EXTRA, "Aurora", "Movies")));
  assert.ok(cfg.libraries.shows.includes(path.join(EXTRA, "Aurora", "Shows")));
  assert.equal(cfg.adminName, "Test Admin", "the rest of config.json is kept");
  assert.ok(fs.readdirSync(srv.root).some((f) => f.startsWith("config.json.before-drive-")), "a copy of the old config.json is kept");
  assert.equal(fs.readdirSync(path.join(EXTRA, "Aurora")).filter((f) => f.startsWith(".aurora-")).length, 0, "the write check cleaned up");
  await page.waitForFunction((d) => /In use/.test(document.querySelector(`#drives-card .drv[data-drive="${CSS.escape(d)}"]`).innerText), id);
  assert.match(await c.innerText(), /New downloads can go here\./);
  // two drives in use now: the headline counts them together
  await page.waitForFunction(() => /free on \d drives/.test(document.getElementById("disk-headline").textContent));
  // the second press is refused: it is in use already
  const again = await srv.api.call("POST", "/api/admin/drives/use", { id }, srv.api.admin);
  assert.equal(again.status, 409);
  // Stop using for new downloads, for real
  await c.locator('[data-drv-act="stop"]').click();
  await toastSays(page, /No new downloads to/);
  const list = await srv.api.adminGet("/api/admin/drives");
  assert.equal(list.drives.find((d) => d.id === id).newDownloads, false);
  await shot(page, "drives-real", "#drives-card");
});

ui.test("for real: a network drive stops answering — viewers told at once, other titles play, Needs you, then back by itself", { timeout: 150000 }, async ({ srv }) => {
  // the "network" drive in use, with a film on it
  const use = await srv.api.adminPost("/api/admin/drives/use", { id: path.resolve(NET) });
  assert.equal(use.ok, true);
  const src = path.join(srv.library.movies, "Test Film One (2020)");
  const dst = path.join(NET, "Aurora", "Movies", "Net Film (2019)");
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(src, "Test Film One (2020).mp4"), path.join(dst, "Net Film (2019).mp4"));
  await srv.api.rescan();
  let netFilm = null;
  for (let i = 0; i < 40 && !netFilm; i++) {
    netFilm = (await srv.api.library()).movies.find((m) => m.title === "Net Film");
    if (!netFilm) await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(netFilm, "the film on the network drive is in the library");
  const other = srv.lib.film1;
  const first = await srv.api.call("GET", `/api/item/${netFilm.id}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.unavailable, undefined);

  // it stops answering
  fs.writeFileSync(SWITCH, "1");
  const t0 = Date.now();
  let item = null;
  while (Date.now() - t0 < 45000) {
    item = (await srv.api.call("GET", `/api/item/${netFilm.id}`)).body;
    if (item.unavailable) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.deepEqual(item.unavailable, { code: "drive-down", message: "This title is on a storage drive that isn't answering right now. The admin has been told — try again a little later." });
  // playing it: refused at once, with the sentence
  const t1 = Date.now();
  const r = await fetch(`${srv.url}/stream/video/${netFilm.id}`, { headers: { Range: "bytes=0-1023" } });
  assert.ok(Date.now() - t1 < 1500, `answered in ${Date.now() - t1} ms`);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("x-aurora-error"), "drive-down");
  assert.equal((await r.json()).message, item.unavailable.message);
  // another title, on the local disk, plays as ever
  const ok = await fetch(`${srv.url}/stream/video/${other.id}`, { headers: { Range: "bytes=0-1023" } });
  assert.equal(ok.status, 206);
  await ok.arrayBuffer();
  // the admin: Needs you, with the reason
  const sum = await srv.api.adminGet("/api/admin/summary");
  assert.equal(sum.state, "needs-you");
  const need = sum.needs.find((n) => n.id.startsWith("drive-down:"));
  assert.ok(need, JSON.stringify(sum.needs));
  assert.match(need.why, /^Storage drive .*net-drive isn't answering since \d\d:\d\d — 1 title can't play\. New downloads go to the other drives until it answers again\.$/);
  const drv = (await srv.api.adminGet("/api/admin/drives")).drives.find((d) => d.id === path.resolve(NET));
  assert.equal(drv.answering, false);

  // a minute on: ONE alert (the instance has no ntfy: it goes to the log and the alert list)
  const alertLines = () => srv.log().filter((l) => /\[health\] ALERT critical drive:/.test(l));
  const t2 = Date.now();
  while (Date.now() - t2 < 80000 && alertLines().length === 0) await new Promise((res) => setTimeout(res, 1000));
  assert.equal(alertLines().length, 1, srv.log().filter((l) => /drives|health/.test(l)).slice(-20).join("\n"));
  assert.match(alertLines()[0], /isn't answering since \d\d:\d\d — 1 title can't play\. 1 person tried to watch\./);

  // it answers again: back by itself, said once
  fs.rmSync(SWITCH);
  const t3 = Date.now();
  let back = null;
  while (Date.now() - t3 < 45000) {
    back = (await srv.api.call("GET", `/api/item/${netFilm.id}`)).body;
    if (!back.unavailable) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  assert.equal(back.unavailable, undefined);
  const played = await fetch(`${srv.url}/stream/video/${netFilm.id}`, { headers: { Range: "bytes=0-1023" } });
  assert.equal(played.status, 206);
  await played.arrayBuffer();
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(srv.log().filter((l) => /\[health\] RECOVERED drive:/.test(l)).length, 1);
  assert.equal(alertLines().length, 1, "no second alert");
  const sum2 = await srv.api.adminGet("/api/admin/summary");
  assert.ok(!sum2.needs.some((n) => n.id.startsWith("drive-down:")));
});

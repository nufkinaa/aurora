// Admin → Server → Actions → Backups → "Copies on every drive"
// (lib/drivecopies.js): the switch (off until the admin allows it) and the
// time, a row per drive (last copy, size, OK / skipped / failed / full), "Make
// a copy now", "Check the copies", and the restore (pick a copy, see what it
// holds, type RESTORE).
//
// The first tests hand the page a made-up answer, at desktop and phone width.
// The last one is the real thing on a private instance run by its keeper (so
// a restart is a real restart): temp folders as drives (AURORA_DRIVES_EXTRA),
// a copy on each, a network one that stops answering and is skipped, a copy
// damaged on purpose and caught, then a restore of the first copy — the server
// restarts, and the household's data is back the way it was.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, openDetails, DESKTOP, PHONE } = require("./helpers");
const server = require("../../scripts/ui-test-server");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-drivecopies-ui-"));
const A = path.join(SCRATCH, "drive-a"); // a local drive
const N = path.join(SCRATCH, "drive-n"); // a "network" drive that can stop answering
const SYS = path.join(SCRATCH, "on-system-disk"); // a library folder on the disk the data is on
const SWITCH = path.join(SCRATCH, "hang-now");
// the library goes onto the drives, so they are "in use" from the start
const media = server.mediaDir();
fs.cpSync(path.join(media, "movies"), path.join(A, "Aurora", "Movies"), { recursive: true });
fs.cpSync(path.join(media, "shows"), path.join(N, "Aurora", "Shows"), { recursive: true });
fs.mkdirSync(path.join(SYS, "movies"), { recursive: true });
process.on("exit", () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });
const score = { value: 80, word: "Fast", streams: 40, measured: {}, at: Date.now() };

const ui = suite({
  server: {
    keeper: true,
    config: { libraries: { movies: [path.join(A, "Aurora", "Movies"), path.join(SYS, "movies")], shows: [path.join(N, "Aurora", "Shows")] } },
    // (a speed score already: no 256 MB speed check of the temp folders)
    seed: { "drives.json": { scores: { [path.resolve(A)]: score, [path.resolve(N)]: score }, noNew: {}, usage: {}, added: {}, alerts: {}, evacuate: {}, removed: {}, moves: {}, tunes: {} } },
    env: {
      AURORA_DRIVES_EXTRA: JSON.stringify([{ path: A, label: "Drive A", space: { total: 2e12, free: 1.5e12 } }, { path: N, network: true, label: "Net drive" }]),
      AURORA_DRIVES_FAKE_HANG: N,
      AURORA_DRIVES_FAKE_HANG_SWITCH: SWITCH,
    },
  },
});

const SHOTS = process.env.DC_SHOTS || path.join(os.tmpdir(), "aurora-agents", "data-backups", "shots");
const shot = async (page, name, el = null) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await (el ? page.locator(el) : page).screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};
const openCard = async (page) => {
  await page.click('.tab[data-tab="server"]');
  await page.click('#subtabs [data-sub="actions"]');
  await page.waitForSelector('#pane-actions.active [data-action="versions"]');
  await openDetails(page, "ac-backups");
  await page.waitForSelector("#dc-card");
};
const toastSays = (page, re, timeout = 15000) => page.waitForFunction((src) => [...document.querySelectorAll("#toasts .toast")].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout });
const row = (page, id) => page.locator(`#dc-rows tr[data-dc-drive="${id}"]`);

// ---------------------------------------------------------------- made up
const H = 3600e3;
const NOW = Date.now();
const copy = (agoH, ok = true, size = 181234) => ({ name: `aurora-backup-${new Date(NOW - agoH * H).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}.tar.gz`, size, createdAt: NOW - agoH * H, ok, error: ok ? null : "cannot be read: unexpected end of file" });
const MADE_UP = (over = {}) => ({
  label: "Keep a copy of the household's data on every drive",
  enabled: false, time: "04:00", serverClock: "12:00", nextAt: null, running: false, waiting: null, restoring: false,
  keep: { daily: 7, weekly: 4, monthly: 0 }, lastRun: null, supervised: "keeper", confirmWord: "RESTORE", lastRestore: null,
  drives: [
    { id: "C:\\", name: "System disk", mount: "C:\\", network: false, dir: "C:\\aurora\\data\\backups", covered: true, answering: true, status: "ok", lastOkAt: NOW - 5 * H, lastSize: 181000, note: "The daily backups are on this drive already.", copies: [copy(5)] },
    { id: "/mnt/storagespace", name: "storagespace", mount: "/mnt/storagespace", network: true, dir: "/mnt/storagespace/Aurora/.backups", covered: false, answering: false, status: "skipped", why: "not-answering", note: "The drive isn't answering — tried again every half hour.", lastOkAt: NOW - 29 * H, lastSize: 180500, copies: [copy(29), copy(53, false)] },
    { id: "E:\\", name: "Backup disk", mount: "E:\\", network: false, dir: "E:\\Aurora\\.backups", covered: false, answering: true, status: "skipped", why: "full", note: "The drive is full — no copy today; older copies are kept.", lastOkAt: NOW - 50 * H, lastSize: 179000, copies: [copy(50)] },
    { id: "F:\\", name: "Old disk", mount: "F:\\", network: false, dir: "F:\\Aurora\\.backups", covered: false, answering: true, status: "failed", error: "EIO: i/o error, write", lastOkAt: null, lastSize: null, copies: [] },
    { id: "G:\\", name: "Fast NVMe", mount: "G:\\", network: false, dir: "G:\\Aurora\\.backups", covered: false, answering: true, status: "ok", lastOkAt: NOW - 1 * H, lastSize: 181234, copies: [copy(1), copy(25), copy(49)] },
  ],
  ...over,
});
const LOOK = { ok: true, location: "G:\\", locationName: "Fast NVMe", name: copy(25).name, createdAt: NOW - 25 * H, size: 181234, version: "1.15.16", summary: { profiles: 9, historyRows: 1234, sessions: 17 },
  secretsLeftOut: [".env", "adminPassword", "tmdbApiKey"], files: [{ path: "data/profiles.json", size: 62000 }, { path: "data/sessions.json", size: 23000 }, { path: "data/usage/events.jsonl", size: 4000 }] };

const stub = async (page, answers) => {
  const posts = [];
  let state = answers;
  await page.route((u) => u.pathname === "/api/admin/backups/drives", (route) => route.fulfill({ json: state }));
  await page.route((u) => /^\/api\/admin\/backups\/drives\/(settings|run|check|summary|restore)$/.test(u.pathname), (route) => {
    const what = new URL(route.request().url()).pathname.split("/").pop();
    const body = JSON.parse(route.request().postData() || "{}");
    posts.push([what, body]);
    if (what === "settings") { state = { ...state, ...body, enabled: body.enabled != null ? body.enabled : state.enabled }; return route.fulfill({ json: state }); }
    if (what === "summary") return route.fulfill({ json: LOOK });
    if (what === "restore") return route.fulfill({ status: 400, json: { error: "stub" } });
    return route.fulfill({ json: { ...state, run: { made: 2, drives: 4, skipped: 2, failed: 0 } } });
  });
  return posts;
};

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`a row per drive with its last copy, size and state; the switch is off until the admin allows it (${name})`, { viewport }, async ({ page, srv }) => {
    const posts = await stub(page, MADE_UP());
    await enter(page, srv);
    await openCard(page);
    await page.waitForFunction(() => document.querySelectorAll("#dc-rows tr").length === 5);
    assert.equal(await page.isChecked("#dc-enabled"), false);
    assert.equal(await page.textContent("#dc-enabled-label"), "Keep a copy of the household's data on every drive");
    assert.match(await page.textContent("#dc-state"), /off\s*Switched off — no copies are made until you switch it on/);
    assert.equal(await page.inputValue("#dc-time"), "04:00");
    assert.match(await row(page, "C:\\").innerText(), /System disk[\s\S]*OK[\s\S]*The daily backups are on this drive already/);
    const net = await row(page, "/mnt/storagespace").innerText();
    assert.match(net, /storagespace[\s\S]*network[\s\S]*\/mnt\/storagespace\/Aurora\/\.backups/);
    assert.match(net, /skipped[\s\S]*1 damaged[\s\S]*isn't answering — tried again every half hour · 2 copies kept/);
    assert.match(await row(page, "E:\\").innerText(), /full[\s\S]*The drive is full — no copy today; older copies are kept\./);
    const failed = await row(page, "F:\\").innerText();
    assert.match(failed, /never[\s\S]*failed[\s\S]*EIO: i\/o error, write · 0 copies kept/);
    assert.match(await row(page, "G:\\").innerText(), /Fast NVMe[\s\S]*177\.0 KB[\s\S]*OK[\s\S]*3 copies kept/);
    // the picker: every copy by drive; the damaged one can't be picked
    const opts = await page.locator("#dc-pick option").evaluateAll((els) => els.map((o) => ({ v: o.value, d: o.disabled, t: o.textContent })));
    assert.equal(opts.length, 7);
    assert.equal(opts.filter((o) => o.d).length, 1);
    assert.match(opts.find((o) => o.d).t, /damaged/);
    assert.ok(opts[0].v.startsWith("main|"), "the daily backups' own copies are picked as main");
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(sw <= 1, `the page scrolls sideways by ${sw}px`);
    await shot(page, `card-off-${name}`, "#dc-card");

    // switch on: saved at once; the time too
    await page.check("#dc-enabled");
    await toastSays(page, /On — a copy on every drive each day at 04:00/);
    await page.fill("#dc-time", "03:30");
    await page.locator("#dc-time").dispatchEvent("change");
    await toastSays(page, /The daily copy is at 03:30 now/);
    assert.deepEqual(posts.filter((p) => p[0] === "settings").map((p) => p[1]), [{ enabled: true }, { time: "03:30" }]);
    assert.match(await page.textContent("#dc-state"), /on\s*Daily at 03:30/);
    await page.click("#dc-run");
    await toastSays(page, /Copied to 2 of 4 drives, 2 skipped/);
    await page.click("#dc-check");
    await toastSays(page, /1 damaged copy found/);
  });

  ui.test(`restore: see what a copy holds, and nothing happens without the typed word (${name})`, { viewport }, async ({ page, srv }) => {
    const posts = await stub(page, MADE_UP({ enabled: true, lastRestore: { status: "done", name: "x", createdAt: NOW - 30 * H, locationName: "Fast NVMe", files: 18, aside: "before-restore-20261108-101500", beforeSnapshot: "aurora-backup-20261108-101500.tar.gz", at: NOW - 2 * H, endedAt: NOW - 2 * H } }));
    await enter(page, srv);
    await openCard(page);
    await page.waitForFunction(() => document.querySelectorAll("#dc-rows tr").length === 5);
    assert.match(await page.textContent("#dc-last-restore"), /restored[\s\S]*Fast NVMe is in place \(18 files\)\. The data from before is kept in data\/before-restore-20261108-101500 and in the daily backups as aurora-backup-20261108-101500\.tar\.gz — restore that one to undo\./);
    await page.selectOption("#dc-pick", `G:\\|${copy(25).name}`);
    await page.click("#dc-look");
    await page.waitForSelector("#dc-restore");
    const look = await page.textContent("#dc-look-out");
    assert.match(look, /intact[\s\S]*Made[\s\S]*Fast NVMe by Aurora 1\.15\.16 · 177\.0 KB/);
    assert.match(look, /Holds 9 profiles, 1,234 history rows, 17 sign-ins · 3 files/);
    assert.match(look, /Left out of this copy: \.env, adminPassword, tmdbApiKey\. A restore never changes the server's own settings\./);
    assert.deepEqual(posts.find((p) => p[0] === "summary")[1], { location: "G:\\", name: copy(25).name });
    await shot(page, `look-${name}`, "#dc-card");
    // the strong question: the wrong word restores nothing, and nothing is sent
    await page.click("#dc-restore");
    const dlg = page.locator("dialog.ask");
    await dlg.waitFor();
    assert.match(await dlg.innerText(), /Restore the household's data from[\s\S]*Everything since then goes back[\s\S]*copied aside first, so this can be undone[\s\S]*Type RESTORE to go ahead/);
    assert.equal(await dlg.locator(".ask-yes").innerText(), "Restore and restart");
    await shot(page, `ask-${name}`);
    await dlg.locator("input").fill("yes");
    await dlg.locator(".ask-yes").click();
    await toastSays(page, /Nothing was restored — type RESTORE to confirm/);
    assert.equal(posts.filter((p) => p[0] === "restore").length, 0);
    // "Never mind" restores nothing either
    await page.click("#dc-restore");
    await dlg.waitFor();
    await dlg.locator(".ask-no").click();
    assert.equal(posts.filter((p) => p[0] === "restore").length, 0);
  });
}

ui.test("a server nothing supervises offers no restore from the page", async ({ page, srv }) => {
  await stub(page, MADE_UP({ supervised: null }));
  await enter(page, srv);
  await openCard(page);
  await page.waitForFunction(() => document.querySelectorAll("#dc-rows tr").length === 5);
  await page.selectOption("#dc-pick", `G:\\|${copy(25).name}`);
  await page.click("#dc-look");
  await page.waitForSelector("#dc-restore");
  assert.equal(await page.isDisabled("#dc-restore"), true);
  assert.match(await page.textContent("#dc-look-out"), /Nothing supervises this server/);
});

// ---------------------------------------------------------------- for real
const namesIn = (dir) => { try { return fs.readdirSync(dir).filter((x) => /^aurora-backup-\d{8}-\d{6}\.tar\.gz$/.test(x)).sort(); } catch { return []; } };

ui.test("for real: copies on each drive, a network drive that stops answering skipped, a damaged copy caught, a restore through a real restart brings the data back", { timeout: 240000 }, async ({ page, srv }) => {
  const api = srv.api;
  const dirA = path.join(A, "Aurora", ".backups");
  const dirN = path.join(N, "Aurora", ".backups");
  // the household before the first copy: one person, part-way through a film
  const noa = await api.createProfile("Noa", { open: true });
  await api.setProgress(noa, srv.lib.film1.id, 30, 60);
  await enter(page, srv);
  await openCard(page);
  await page.waitForFunction(() => document.querySelectorAll("#dc-rows tr").length >= 3, null, { timeout: 30000 });
  assert.equal(await page.isChecked("#dc-enabled"), false, "off until the admin allows it");
  await page.check("#dc-enabled");
  await toastSays(page, /On — a copy on every drive each day at/);

  // 1. a copy on each drive
  await page.click("#dc-run");
  await toastSays(page, /Copied to 2 of 2 drives/, 60000);
  assert.equal(namesIn(dirA).length, 1);
  assert.equal(namesIn(dirN).length, 1);
  assert.match(await row(page, path.resolve(A)).innerText(), /Drive A[\s\S]*OK[\s\S]*1 copy kept/);
  assert.match(await row(page, path.resolve(N)).innerText(), /Net drive[\s\S]*network[\s\S]*OK/);
  const sysRow = page.locator("#dc-rows tr").filter({ hasText: "The daily backups are on this drive already" });
  assert.equal(await sysRow.count(), 1, "the drive with the data and its daily backups is covered by them");
  const first = namesIn(dirA)[0];

  // 2. the network drive stops answering: skipped, the other copied; nothing deleted on it
  await new Promise((r) => setTimeout(r, 1100)); // (a new second: a new name)
  fs.writeFileSync(SWITCH, "1");
  try {
    // (the drives module notices within its 15 s round; until then a copy would wait out its 2 min deadline)
    for (const end = Date.now() + 60000; ;) {
      const d = (await api.adminGet("/api/admin/drives")).drives.find((x) => x.id === path.resolve(N));
      if (d && d.answering === false) break;
      assert.ok(Date.now() < end, "the network drive was never marked as not answering");
      await new Promise((r) => setTimeout(r, 1000));
    }
    await page.click("#dc-run");
    await toastSays(page, /Copied to 1 of 2 drives, 1 skipped/, 150000);
    assert.match(await row(page, path.resolve(N)).innerText(), /skipped[\s\S]*(isn't answering|did not answer)/);
  } finally { fs.rmSync(SWITCH, { force: true }); }
  assert.equal(namesIn(dirA).length, 2);
  assert.equal(namesIn(dirN).length, 1);
  await shot(page, "real-after-copies", "#dc-card");

  // 3. the newest copy on drive A is damaged on the disk: "Check the copies" finds it
  const newest = namesIn(dirA)[1];
  const p = path.join(dirA, newest);
  const b = fs.readFileSync(p); b[Math.floor(b.length / 2)] ^= 0xff; b[b.length - 30] ^= 0xff; fs.writeFileSync(p, b);
  await page.click("#dc-check");
  await toastSays(page, /1 damaged copy found/, 60000);
  assert.match(await row(page, path.resolve(A)).innerText(), /1 damaged/);
  const dis = await page.locator("#dc-pick option[disabled]").evaluateAll((els) => els.map((o) => o.value));
  assert.deepEqual(dis, [`${path.resolve(A)}|${newest}`]);
  // the server refuses it too
  const refused = await api.call("POST", "/api/admin/backups/drives/restore", { location: path.resolve(A), name: newest, confirm: "RESTORE" }, api.admin);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /damaged/);
  await shot(page, "real-damaged", "#dc-card");

  // 4. the household changes after the first copy
  await api.setProgress(noa, srv.lib.film1.id, 50, 60);
  const ari = await api.createProfile("Ari", { open: true });
  assert.ok((await api.profiles()).some((x) => x.id === ari.id));

  // 5. restore the first copy: see what it holds, type RESTORE, the server restarts
  await page.selectOption("#dc-pick", `${path.resolve(A)}|${first}`);
  await page.click("#dc-look");
  await page.waitForSelector("#dc-restore");
  assert.match(await page.textContent("#dc-look-out"), /intact[\s\S]*Drive A[\s\S]*Holds 1 profile/);
  await page.click("#dc-restore");
  const dlg = page.locator("dialog.ask");
  await dlg.waitFor();
  await dlg.locator("input").fill("RESTORE");
  await dlg.locator(".ask-yes").click();
  await page.waitForFunction(() => /restoring…/.test(document.getElementById("dc-look-out").textContent));
  await toastSays(page, /Restored — the household's data is back to that copy/, 150000);
  assert.match(await page.textContent("#dc-last-restore"), /restored[\s\S]*is in place[\s\S]*The data from before is kept in data\/before-restore-/);
  await shot(page, "real-restored", "#dc-card");

  // a new process, and the data the way it was at the first copy
  const people = await api.profiles();
  assert.ok(people.some((x) => x.id === noa.id), "Noa is there");
  assert.ok(!people.some((x) => x.id === ari.id), "Ari came after the copy, so is gone");
  const st = await api.state(noa);
  const prog = (st.progress || {})[srv.lib.film1.id];
  assert.equal(Math.round(prog.position), 30, "progress is back to where it was at the copy");
  // the data from before is kept aside, and as a backup
  const last = JSON.parse(fs.readFileSync(path.join(srv.dataDir, "restore-last.json"), "utf8"));
  assert.equal(last.status, "done");
  const aside = JSON.parse(fs.readFileSync(path.join(srv.dataDir, last.aside, "profiles.json"), "utf8"));
  assert.ok(aside.profiles.some((x) => x.id === ari.id), "the aside copy still has Ari");
  assert.ok(fs.existsSync(path.join(srv.dataDir, "backups", last.beforeSnapshot)));
  assert.ok(srv.log().some((l) => /\[restore\] .* is in place/.test(l)), "the boot said it");
});

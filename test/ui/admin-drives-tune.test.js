// Admin → Downloads → On disk → a network drive's card: "Tune this network
// drive" (lib/drives/tune.js, docs/storage-drives.md). The page gets made-up
// answers (the drives list, the preview, the run) and its presses are caught:
//   - the preview: the line now, what changes, the pause note → Tune it now →
//     the card follows the run → before → after;
//   - not faster → "Put it back" (one question, then the revert);
//   - the helper not installed: the two one-time commands and Copy;
//   - someone watching: said, and the run can't be started.
// At desktop and phone width, with screenshots of each state.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, openDetails, DESKTOP, PHONE } = require("./helpers");

const ui = suite({});

const SHOTS = process.env.DRV_SHOTS || path.join(os.tmpdir(), "aurora-agents", "drives-tune", "shots");
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

const OLD = "rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536";
const TUNED = "rw,vers=3,proto=tcp,nolock,rsize=1048576,wsize=1048576,nconnect=4,_netdev,nofail,x-systemd.mount-timeout=30s,soft,timeo=100,retrans=2";
const NVME = {
  id: "/", name: "System disk", mount: "/", source: "/dev/vda3", fstype: "ext4", network: false, readOnly: false, hardMount: false, options: [],
  total: 500 * GIB, free: 100 * GIB, used: 400 * GIB, answering: true, downSince: null, inUse: true, holds: ["movies", "shows", "data", "staging"],
  newDownloads: true, aurora: { bytes: 300 * GIB, files: 1800, partial: false, at: Date.now() - 3600e3 },
  score: { value: 92, word: "Fast", streams: 180, measured: { readMBps: 2300, writeMBps: 1500, iops: 21000 }, at: Date.now() - 7200e3 },
  scoreError: null, testing: null, titles: 412, reserve: 50 * GIB, paused: false, tune: null,
};
const score = (parallelMBps, hd, uhd, value, word) => ({ value, word, scale: "network", streams: uhd, streams1080: hd, streams4k: uhd, meaning: "", measured: { readMBps: 22, directMBps: 22, bufferedMBps: 41, parallelMBps, parallelReaders: 4, writeMBps: 45, iops: 300 }, at: Date.now() });
const NFS = {
  id: "/mnt/storagespace", name: "storagespace", mount: "/mnt/storagespace", source: "46.38.248.210:/voln1117606a1", fstype: "nfs", network: true, readOnly: false, hardMount: true,
  options: ["rw", "vers=3", "proto=tcp", "hard", "rsize=65536", "wsize=65536"],
  total: 1 * TIB, free: 0.9 * TIB, used: 0.1 * TIB, answering: true, downSince: null, inUse: true, holds: ["movies", "shows"],
  newDownloads: true, aurora: { bytes: 90 * GIB, files: 60, partial: false, at: Date.now() },
  score: score(22, 10, 1, 31, "Fine for 1080p"), scoreError: null, testing: null, titles: 37, reserve: 50 * GIB, paused: false,
  tune: { supported: true, running: null, elsewhere: false, last: null },
};
const answer = (drives) => ({ drives, reservePct: 10, reserveMaxBytes: 50e9 });
const PREVIEW = {
  id: NFS.id, mount: NFS.mount, inUse: true, watching: false, running: null, installed: true, version: 1, outdated: false, setup: null, mounted: true,
  fstabOptions: OLD, liveOptions: "rw,relatime,vers=3,rsize=65536,wsize=65536,hard,proto=tcp,timeo=600,retrans=2",
  tunedOptions: TUNED, remove: ["hard", "rsize=65536", "wsize=65536"],
  add: ["rsize=1048576", "wsize=1048576", "nconnect=4", "_netdev", "nofail", "x-systemd.mount-timeout=30s", "soft", "timeo=100", "retrans=2"],
  already: false, canRevert: false, originalOptions: null,
  pauseNote: "Aurora pauses this drive for about three minutes: nobody can watch from it meanwhile and new downloads wait. It measures the speed before and after.",
};
const SETUP = {
  user: "elia",
  commands: [
    "sudo install -o root -g root -m 0755 /home/elia/aurora/scripts/nufurora/aurora-mount-helper /usr/local/sbin/aurora-mount-helper",
    "t=$(mktemp) && echo 'elia ALL=(root) NOPASSWD: /usr/local/sbin/aurora-mount-helper' > \"$t\" && sudo visudo -cf \"$t\" && sudo install -o root -g root -m 0440 \"$t\" /etc/sudoers.d/aurora-mount; rm -f \"$t\"",
  ],
};
const running = (stepWords) => ({ ...NFS, paused: true, newDownloads: false, tune: { supported: true, running: { action: "apply", step: "before", words: stepWords, startedAt: Date.now() }, elsewhere: false, last: null } });
const done = (last, extra = {}) => ({ ...NFS, ...extra, tune: { supported: true, running: null, elsewhere: false, last: { action: "apply", ok: true, at: Date.now(), ...last } } });

// the page asks for the list as often as it likes; the answer moves on only when the test says so
const stub = async (page, { lists, preview = PREVIEW, run = { ok: true, started: true, action: "apply" } }) => {
  const st = { list: 0, posts: [] };
  await page.route((u) => u.pathname === "/api/admin/disk", (route) => route.fulfill({ json: { disks: [{ root: "/opt/aurora/media/Movies", free: 100 * GIB, total: 500 * GIB }], minFreePct: 0, forecast: null } }));
  await page.route((u) => u.pathname === "/api/admin/drives", (route) => route.fulfill({ json: answer(lists[Math.min(st.list, lists.length - 1)]) }));
  await page.route((u) => /^\/api\/admin\/drives\/tune(\/preview|\/revert)?$/.test(u.pathname), (route) => {
    const what = new URL(route.request().url()).pathname.replace("/api/admin/drives/", "");
    st.posts.push([what, JSON.parse(route.request().postData() || "{}")]);
    if (what === "tune/preview") return route.fulfill({ json: preview });
    const r = typeof run === "function" ? run(what) : run;
    if (r.ok) st.list++;
    return route.fulfill({ status: r.error ? 409 : 200, json: r });
  });
  return st;
};
const openDisk = async (page) => {
  await page.click('.tab[data-tab="downloads"]');
  await openDetails(page, "d-disk");
  await page.waitForSelector("#drives-card .drv");
};
const card = (page) => page.locator('#drives-card .drv[data-drive="/mnt/storagespace"]');
const noSideScroll = async (page) => {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(sw <= 1, `the page scrolls sideways by ${sw}px`);
};

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`tune: the preview, Tune it now, the card follows the run, before → after (${name})`, { viewport, timeout: 60000 }, async ({ page, srv }) => {
    const st = await stub(page, {
      lists: [
        [NVME, NFS],
        [NVME, running("measuring the speed before")],
        [NVME, done({ before: { parallelMBps: 22, readers: 4 }, after: { parallelMBps: 95, readers: 4 }, better: true, message: "Faster: read 22 → 95 MB/s for 4 viewers together." }, { score: score(95, 44, 6, 78, "Good"), hardMount: false })],
      ],
    });
    await enter(page, srv);
    await openDisk(page);
    // only the network drive has it; the local disk does not
    assert.equal(await page.locator('#drives-card .drv[data-drive="/"] [data-drv-act="tune"]').count(), 0);
    const btn = card(page).locator('[data-drv-act="tune"]');
    assert.equal(await btn.innerText(), "Tune this network drive");
    assert.match(await card(page).innerText(), /“Tune this network drive” sets the safer options too/);
    await btn.click();
    const panel = card(page).locator('.drv-tune[data-drv-tune="preview"]');
    await panel.waitFor();
    const text = await panel.innerText();
    assert.match(text, /Now in \/etc\/fstab: rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536/);
    assert.match(text, /In force: rw,relatime,vers=3,rsize=65536/);
    assert.match(text, /− hard[\s\S]*− rsize=65536[\s\S]*\+ rsize=1048576[\s\S]*\+ nconnect=4[\s\S]*\+ soft/);
    assert.match(text, /Aurora pauses this drive for about three minutes: nobody can watch from it meanwhile and new downloads wait\./);
    assert.deepEqual(st.posts[0], ["tune/preview", { id: "/mnt/storagespace" }]);
    await noSideScroll(page);
    await shot(page, `tune-preview-${name}`, '#drives-card .drv[data-drive="/mnt/storagespace"]');

    await panel.locator('[data-drv-act="tune-run"]').click();
    await toastSays(page, /Tuning \/mnt\/storagespace — about three minutes/);
    assert.deepEqual(st.posts[1], ["tune", { id: "/mnt/storagespace" }]);
    await page.waitForSelector('#drives-card .drv[data-drive="/mnt/storagespace"] [data-drv-tune-state="running"]');
    assert.equal(await card(page).locator(".drv-tune").count(), 0, "the preview closed");
    assert.match(await card(page).innerText(), /Tuning the mount: measuring the speed before… Nobody can watch from this drive until it is done/);
    // (new downloads are off during the run: the button reads "Use for new downloads again")
    for (const a of ["tune", "test", "resume"]) assert.equal(await card(page).locator(`[data-drv-act="${a}"]`).isDisabled(), true, `${a} waits while it runs`);
    await shot(page, `tune-running-${name}`, '#drives-card .drv[data-drive="/mnt/storagespace"]');

    // the run ends: the card (polled every 4 s) says before → after, once as a toast
    st.list = 2;
    await page.waitForSelector('#drives-card .drv[data-drive="/mnt/storagespace"] [data-drv-tune-state="done"]', { timeout: 15000 });
    await toastSays(page, /Faster: read 22 → 95 MB\/s for 4 viewers together\./);
    const after = await card(page).innerText();
    assert.match(after, /Tuned at \d\d:\d\d: Faster: read 22 → 95 MB\/s for 4 viewers together\./);
    assert.match(after, /read 95 MB\/s for 4 viewers/);
    assert.equal(await card(page).locator('[data-drv-act="revert"]').count(), 0, "faster: nothing to put back");
    await noSideScroll(page);
    await shot(page, `tune-done-${name}`, '#drives-card .drv[data-drive="/mnt/storagespace"]');
  });

  ui.test(`tune: the helper isn't installed — the two one-time commands and Copy (${name})`, { viewport, permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
    await stub(page, { lists: [[NVME, NFS]], preview: { ...PREVIEW, installed: false, missing: "helper", why: "/usr/local/sbin/aurora-mount-helper is not installed.", setup: SETUP } });
    await enter(page, srv);
    await openDisk(page);
    await card(page).locator('[data-drv-act="tune"]').click();
    const panel = card(page).locator('.drv-tune[data-drv-tune="setup"]');
    await panel.waitFor();
    const text = await panel.innerText();
    assert.match(text, /One-time setup on the server/);
    assert.match(text, /The mount helper isn't installed on this server yet\. Run these two commands once on the server \(over SSH\)\. After that, Aurora tunes the drive by itself — no SSH again\./);
    assert.equal((await panel.locator(".drv-cmd").innerText()).trim(), SETUP.commands.join("\n"));
    assert.equal(await panel.locator('[data-drv-act="tune-run"]').count(), 0, "no run without the helper");
    await noSideScroll(page);
    await shot(page, `tune-setup-${name}`, '#drives-card .drv[data-drive="/mnt/storagespace"]');
    await panel.locator('[data-drv-act="tune-copy"]').click();
    await toastSays(page, /Copied the setup commands/);
    const clip = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
    assert.equal(clip, SETUP.commands.join("\n") + "\n");
    await panel.locator('[data-drv-act="tune-close"]').click();
    assert.equal(await card(page).locator(".drv-tune").count(), 0);
  });
}

ui.test("tune: not faster — said so, and Put it back asks once, then reverts", { timeout: 60000 }, async ({ page, srv }) => {
  const notBetter = done({ before: { parallelMBps: 22, readers: 4 }, after: { parallelMBps: 23, readers: 4 }, better: false, message: "Not faster: read 22 → 23 MB/s for 4 viewers together. \"Put it back\" returns the old options." });
  const reverting = { ...NFS, paused: true, tune: { supported: true, running: { action: "revert", step: "changing", words: "changing the mount", startedAt: Date.now() }, elsewhere: false, last: null } };
  const st = await stub(page, { lists: [[NVME, notBetter], [NVME, reverting]], run: { ok: true, started: true, action: "revert" } });
  await enter(page, srv);
  await openDisk(page);
  const line = card(page).locator('[data-drv-tune-state="not-better"]');
  await line.waitFor();
  assert.match(await line.innerText(), /Tuned at \d\d:\d\d: Not faster: read 22 → 23 MB\/s for 4 viewers together\. "Put it back" returns the old options\./);
  const back = card(page).locator('[data-drv-act="revert"]');
  assert.equal(await back.innerText(), "Put it back");
  await shot(page, "tune-not-better", '#drives-card .drv[data-drive="/mnt/storagespace"]');
  await back.click();
  const dlg = page.locator("dialog.ask");
  await dlg.waitFor();
  assert.match(await dlg.innerText(), /Put the old mount options back on \/mnt\/storagespace\?[\s\S]*goes back to what it was before the first tune[\s\S]*about three minutes/);
  await dlg.locator(".ask-yes").click();
  await toastSays(page, /Putting the old options back on \/mnt\/storagespace/);
  assert.deepEqual(st.posts, [["tune/revert", { id: "/mnt/storagespace" }]]);
  await page.waitForSelector('#drives-card .drv[data-drive="/mnt/storagespace"] [data-drv-tune-state="running"]');
  assert.match(await card(page).innerText(), /Putting the old mount options back: changing the mount…/);
});

ui.test("tune: someone watching — said in the preview, and a run the server refuses says why", { allow: [/status of 409 .*\/api\/admin\/drives\/tune/] }, async ({ page, srv }) => {
  const WATCHING = "Someone is watching a title from this drive right now — try again when nobody is.";
  const st = await stub(page, { lists: [[NVME, NFS]], preview: { ...PREVIEW, watching: true }, run: { error: WATCHING, watching: true } });
  await enter(page, srv);
  await openDisk(page);
  await card(page).locator('[data-drv-act="tune"]').click();
  const panel = card(page).locator('.drv-tune[data-drv-tune="preview"]');
  await panel.waitFor();
  assert.match(await panel.innerText(), new RegExp(WATCHING));
  assert.equal(await panel.locator('[data-drv-act="tune-run"]').isDisabled(), true);
  await shot(page, "tune-watching", '#drives-card .drv[data-drive="/mnt/storagespace"]');
  // (someone started watching after the preview: the server says no)
  await page.evaluate(() => { document.querySelector('[data-drv-act="tune-run"]').disabled = false; });
  await panel.locator('[data-drv-act="tune-run"]').click();
  await toastSays(page, /Someone is watching a title from this drive right now/);
  assert.deepEqual(st.posts.map((p) => p[0]), ["tune/preview", "tune"]);
  assert.equal(await card(page).locator('[data-drv-tune-state="running"]').count(), 0);
});

ui.test("tune: a failed run is said in red on the card; a drive tuned already offers to put the old options back", async ({ page, srv }) => {
  const failed = done({ ok: false, message: "The new options did not mount (mount.nfs: an incorrect mount option was specified). The old line is back and the drive is mounted the old way." });
  await stub(page, { lists: [[NVME, failed]], preview: { ...PREVIEW, fstabOptions: TUNED, already: true, canRevert: true, originalOptions: OLD, liveOptions: "rw,vers=3,rsize=1048576,wsize=1048576,soft,nconnect=4" } });
  await enter(page, srv);
  await openDisk(page);
  const line = card(page).locator('[data-drv-tune-state="failed"]');
  await line.waitFor();
  assert.match(await line.innerText(), /Tuned at \d\d:\d\d — did not work: The new options did not mount \(mount\.nfs: an incorrect mount option was specified\)\. The old line is back/);
  assert.equal(await line.evaluate((e) => e.classList.contains("bad")), true);
  await card(page).locator('[data-drv-act="tune"]').click();
  const panel = card(page).locator('.drv-tune[data-drv-tune="already"]');
  await panel.waitFor();
  assert.match(await panel.innerText(), /This drive already has the tuned options\.[\s\S]*Before: rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536/);
  assert.equal(await panel.locator('[data-drv-act="revert"]').innerText(), "Put back the old options");
  await shot(page, "tune-failed-already", '#drives-card .drv[data-drive="/mnt/storagespace"]');
});

ui.run({ concurrency: 1 });

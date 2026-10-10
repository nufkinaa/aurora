// The admin page (public/admin.html), a smoke test: the password gate, the
// People tab, approving a waiting profile, the kids controls.
//
// The password is the private instance's own: scripts/ui-test-server.js makes
// one up for every boot and writes it into that instance's config.json. The
// real server's password is never read or used.
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

let kidsAvailable = true;
const ui = suite({
  setup: async (srv) => {
    srv.profiles.anna = await srv.api.createProfile("Anna");
    srv.profiles.ben = await srv.api.createProfile("Ben", { open: true });
    const status = await srv.api.call("GET", "/api/kids/status");
    kidsAvailable = status.status === 200 && Array.isArray(status.body.ages);
  },
});

const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};
const people = async (page) => {
  await page.click('.tab[data-tab="profiles"]');
  await page.waitForSelector("#people-table tr.person-row");
};
const names = (page) => page.evaluate(() => [...document.querySelectorAll("#people-table tr.person-row .pwho b")].map((b) => b.textContent).sort());
const toastSays = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), re.source);

ui.test("the gate refuses a wrong password and shows nothing behind it", { allow: [/Failed to load resource.*403.*\/api\/admin\//] }, async ({ page, srv }) => {
  const adminCalls = [];
  page.on("response", (r) => { if (/\/api\/admin\//.test(r.url())) adminCalls.push(r.status()); });
  await page.goto(`${srv.url}/admin`);
  await page.waitForSelector(".gate input");
  assert.deepEqual(adminCalls, [], "the page asked the admin API for something before the password was given");

  await page.fill('.gate input[aria-label="Admin password"]', "not-the-password");
  await page.click(".gate button");
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".gate .pw-err")).visibility === "visible");
  assert.equal(await page.locator(".gate").count(), 1);
  assert.equal(await page.inputValue(".gate input"), "");
  assert.deepEqual(adminCalls, [403], "one refused check of the password, and nothing else");
});

ui.test("the right password opens the panel, and the People tab lists everyone", async ({ page, srv, api }) => {
  await enter(page, srv);
  assert.equal(await page.locator(".tab.active").getAttribute("data-tab"), "overview");
  await people(page);
  const everyone = (await api.profiles()).map((p) => p.name).sort();
  assert.deepEqual(await names(page), everyone);
  assert.equal(await page.textContent("#profiles-count"), String(everyone.length));
  // nobody is waiting: the requests card stays out of the way
  assert.ok(await page.locator("#req-card").evaluate((c) => c.classList.contains("hidden")));
  // the sign-in switch is there, on "Open"
  assert.match(await page.textContent("#auth-modes"), /Open/);

  // the search box narrows the table
  await page.fill("#people-search", "ann");
  await page.waitForFunction(() => document.querySelectorAll("#people-table tr.person-row").length === 1);
  assert.deepEqual(await names(page), ["Anna"]);
  await page.fill("#people-search", "zzzz");
  await page.waitForFunction(() => !document.getElementById("people-empty").classList.contains("hidden"));
});

ui.test("a profile request shows up in the requests card by itself, and Approve makes it a profile", async ({ page, srv, api }) => {
  await enter(page, srv);
  await people(page);
  const card = page.locator("#req-card");
  assert.ok(await card.evaluate((c) => c.classList.contains("hidden")));

  // someone at the profile wall asks for a profile while the admin is looking
  await api.requestProfile("Cleo");
  await page.waitForFunction(() => !document.getElementById("req-card").classList.contains("hidden"));
  const row = page.locator("#profile-requests tr", { hasText: "Cleo" });
  await row.waitFor();
  assert.match(await row.textContent(), /Cleo Tester/, "the real name the person gave");
  assert.equal(await page.textContent("#req-count"), "1");
  assert.ok(!(await names(page)).includes("Cleo"), "a request is not a profile until it is approved");
  assert.ok(!(await api.profiles()).some((p) => p.name === "Cleo"));

  await row.locator("button[data-req-ok]").click();
  await toastSays(page, /Approved "Cleo"/);
  await page.waitForFunction(() => document.getElementById("req-card").classList.contains("hidden"));
  await page.waitForFunction(() => [...document.querySelectorAll("#people-table tr.person-row .pwho b")].some((b) => b.textContent === "Cleo"));
  assert.ok((await api.profiles()).some((p) => p.name === "Cleo" && p.hasPassword), "the approved profile is not on the wall");
});

ui.test("a request can be rejected, and then it is gone", async ({ page, srv, api }) => {
  await api.requestProfile("Dora");
  await enter(page, srv);
  await people(page);
  const row = page.locator("#profile-requests tr", { hasText: "Dora" });
  await row.waitFor();
  await row.locator("button[data-req-no]").click();
  // (rejecting asks first)
  const ask = page.locator("dialog.ask");
  if (await ask.count()) await ask.locator(".ask-yes").click();
  await toastSays(page, /Rejected "Dora"/);
  await page.waitForFunction(() => !document.querySelector("#profile-requests tr") || !/Dora/.test(document.getElementById("profile-requests").innerText));
  assert.ok(!(await api.profiles()).some((p) => p.name === "Dora"));
  assert.deepEqual(await api.adminGet("/api/admin/profile-requests"), []);
});

ui.test("a person's sheet has the kids controls: set the household PIN, make the profile a kids one, switch it off", async ({ page, srv, api, profiles, t }) => {
  if (!kidsAvailable) return t.skip("this server has no kids profiles (GET /api/kids/status)");
  await enter(page, srv);
  await people(page);
  await page.click(`#people-table tr.person-row[data-person="${profiles.ben.id}"]`);
  const sheet = page.locator("#person-sheet[open]");
  await sheet.waitFor();
  const kids = sheet.locator(".kids-admin");
  assert.deepEqual((await kids.locator("button[data-kids]").allTextContents()).map((s) => s.trim()), ["Off", "All ages", "7+", "12+", "16+"]);
  assert.equal(await kids.locator("button[data-kids].active").getAttribute("data-kids"), "off");
  assert.match(await kids.textContent(), /Household PIN:\s*not set/);

  // the PIN first (the sheet says so, loudly, while there is none)
  await kids.locator("button[data-kids-pin]").click();
  const ask = page.locator("dialog.ask");
  await ask.locator("input").fill("2468");
  await ask.locator(".ask-yes").click();
  await toastSays(page, /Household PIN saved/);
  assert.equal((await api.get("/api/kids/status")).pinSet, true);
  await page.waitForFunction(() => /Household PIN:\s*set/.test((document.querySelector("#person-sheet .kids-admin") || {}).textContent || ""));

  // then the limit
  await page.locator('#person-sheet .kids-admin button[data-kids="7"]').click();
  await toastSays(page, /"Ben" is a kids profile now/);
  await page.waitForFunction(() => (document.querySelector("#person-sheet .kids-admin button[data-kids].active") || {}).dataset?.kids === "7");
  assert.deepEqual((await api.profile(profiles.ben.id)).kids, { maxAge: 7 });
  // the table says so too
  await page.waitForFunction((id) => /kids · up to 7\+/.test(document.querySelector(`#people-table tr[data-person="${id}"]`).textContent), profiles.ben.id);

  // and off again
  await page.locator('#person-sheet .kids-admin button[data-kids="off"]').click();
  await toastSays(page, /Kids mode off for "Ben"/);
  await page.waitForFunction(async (id) => (await (await fetch("/api/profiles")).json()).find((p) => p.id === id).kids === null, profiles.ben.id);
  assert.equal((await api.profile(profiles.ben.id)).kids, null);
});

ui.test("every tab of the panel opens without an error", async ({ page, srv }) => {
  await enter(page, srv);
  const tabs = await page.evaluate(() => [...document.querySelectorAll(".tab[data-tab]")].map((t) => t.dataset.tab));
  assert.ok(tabs.length >= 5, JSON.stringify(tabs));
  for (const tab of tabs) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForFunction((t) => document.querySelector(`.tab[data-tab="${t}"]`).classList.contains("active"), tab);
    await page.waitForTimeout(400); // each tab fetches its own data on opening
  }
});

// ---- Server → Actions (src/lib/adminactions.js) ----
const actionsTab = async (page) => {
  await page.click('.tab[data-tab="server"]');
  await page.click('#subtabs [data-sub="actions"]');
  await page.waitForSelector('#pane-actions.active [data-action="versions"]');
};
const runAction = async (page, id, { confirm = false, timeout = 60000 } = {}) => {
  // the output card keeps the previous run until this one answers: wait for THIS action's title
  const title = await page.textContent(`#ac-groups .ac-row:has([data-action="${id}"]) b`);
  await page.evaluate(() => { document.querySelector("#ac-out-title").textContent = ""; document.querySelector("#ac-out-state").textContent = ""; });
  await page.click(`#pane-actions [data-action="${id}"]`);
  if (confirm) await page.click("dialog.ask .ask-yes");
  await page.waitForFunction((t) => document.querySelector("#ac-out-title").textContent === t && /done|failed/.test(document.querySelector("#ac-out-state").textContent), title, { timeout });
  return { state: await page.textContent("#ac-out-state"), output: await page.textContent("#ac-out") };
};

ui.test("Server → Actions lists the fixed actions in their groups, each saying what it runs", async ({ page, srv }) => {
  await enter(page, srv);
  await actionsTab(page);
  const groups = await page.evaluate(() => [...document.querySelectorAll("#ac-groups .card > h2")].map((h) => h.textContent.trim()));
  assert.deepEqual(groups, ["Update", "Checks", "Library and data", "Caches", "Repair"]);
  const cmd = await page.textContent('#ac-groups .ac-row:has([data-action="npm-install"]) .ac-cmd');
  assert.match(cmd, /npm(\.cmd)? install --omit=dev/);
  assert.equal(await page.locator("#ac-groups [data-action]").count(), (await srv.api.adminGet("/api/admin/actions")).actions.length);
});

ui.test("an action runs from its button: the output shows, and it lands in Recent runs", async ({ page, srv }) => {
  await enter(page, srv);
  await actionsTab(page);
  const r = await runAction(page, "versions");
  assert.match(r.state, /done/);
  assert.match(r.output, /node v\d+\./);
  await page.waitForFunction(() => /Tool versions/.test(document.querySelector("#ac-runs").textContent));
  // a recorded run opens again from the list
  await page.click("#ac-runs .ac-run");
  await page.waitForFunction(() => /node v\d+\./.test(document.querySelector("#ac-out").textContent));
});

ui.test("Back up now makes a snapshot that shows in the Backups table as intact, and Verify agrees", async ({ page, srv }) => {
  await enter(page, srv);
  await actionsTab(page);
  const made = await runAction(page, "backup-now");
  assert.match(made.state, /done/, made.output);
  assert.match(made.output, /Made aurora-backup-\d{8}-\d{6}\.tar\.gz/);
  await page.waitForSelector("#ac-bk-rows tr");
  assert.match(await page.textContent("#ac-bk-rows tr"), /aurora-backup-.*intact/s);
  const verify = await runAction(page, "backup-verify");
  assert.match(verify.state, /done/, verify.output);
  assert.match(verify.output, /All \d+ snapshots? are intact/);
});

ui.test("the health checks run from the page and the Alerts card fills in", async ({ page, srv }) => {
  await enter(page, srv);
  await actionsTab(page);
  const r = await runAction(page, "health-run");
  assert.match(r.state, /done/, r.output);
  assert.match(r.output, /Disk/);
  await page.waitForFunction(() => document.querySelectorAll("#ac-al-checks > div").length > 0);
  assert.match(await page.textContent("#ac-al-delivery"), /server log/);
});

ui.test("the actions API refuses an id that is not on the list, and anyone without the password", { allow: [/Failed to load resource.*40[34]/] }, async ({ srv }) => {
  const bad = await srv.api.call("POST", `/api/admin/actions/${encodeURIComponent("versions; whoami")}/run`, {}, srv.api.admin);
  assert.equal(bad.status, 404);
  const anon = await srv.api.call("POST", "/api/admin/actions/versions/run", {});
  assert.equal(anon.status, 403);
  const list = await srv.api.call("GET", "/api/admin/actions");
  assert.equal(list.status, 403);
});

// ---------- Downloads tab: "Downloads at once" and the second-source line ----------
const downloadsTab = async (page) => {
  await page.click('.tab[data-tab="downloads"]');
  await page.waitForFunction(() => document.querySelector("#lim-slots") && document.querySelector("#lim-slots").value !== "");
};

ui.test("Downloads at once: shown beside the speed caps, a new value sticks across a reload, out-of-range is refused", { allow: [/Failed to load resource.*400.*aria2-limits/] }, async ({ page, srv, api }) => {
  await enter(page, srv);
  await downloadsTab(page);
  assert.equal(await page.inputValue("#lim-slots"), "4", "the default is four");
  assert.match(await page.textContent("#lim-slots-note"), /More at once means each one is slower, and playback can suffer/);
  // same card, same row, same button as the speed caps
  assert.ok(await page.evaluate(() => document.querySelector("#lim-slots").closest(".bar-row") === document.querySelector("#lim-down").closest(".bar-row")));

  await page.fill("#lim-slots", "6");
  await page.fill("#lim-down", "5M");
  await page.click("#lim-apply");
  await toastSays(page, /Limits (saved|applied)/);
  assert.equal((await api.adminGet("/api/admin/aria2-limits")).slots.maxActive, 6);

  await enter(page, srv);                 // a full reload of the page
  await downloadsTab(page);
  assert.equal(await page.inputValue("#lim-slots"), "6", "it stuck");
  assert.equal(await page.inputValue("#lim-down"), "5M", "and the speed cap saved with it");

  for (const bad of ["9", "0"]) {
    await page.fill("#lim-slots", bad);
    await page.fill("#lim-down", "1M");
    await page.click("#lim-apply");
    await toastSays(page, /whole number from 1 to 6/);
    const saved = await api.adminGet("/api/admin/aria2-limits");
    assert.equal(saved.slots.maxActive, 6, `${bad} was refused`);
    assert.equal(saved.saved.download, "5M", "a refused save changes nothing — not the speed cap either");
  }
  await enter(page, srv);
  await downloadsTab(page);
  assert.equal(await page.inputValue("#lim-slots"), "6");

  // the API says the same without the page, and an older page (no maxActive) still saves its caps
  const direct = await api.call("POST", "/api/admin/aria2-limits", { download: "0", upload: "0", maxActive: 2.5 }, api.admin);
  assert.equal(direct.status, 400);
  const old = await api.call("POST", "/api/admin/aria2-limits", { download: "0", upload: "0" }, api.admin);
  assert.equal(old.status, 200);
  assert.equal((await api.adminGet("/api/admin/aria2-limits")).slots.maxActive, 6);
  await api.adminPost("/api/admin/aria2-limits", { download: "0", upload: "0", maxActive: 4 });
});

ui.test("In flight: a job trying a second source gets one line under it; holding for viewers is said in the card", async ({ page, srv }) => {
  const racing = {
    id: "aaaaaaaaaaaa", infoHash: "a".repeat(40), fileIdx: 0, imdbId: "tt9000001", title: "Slow Film", label: "Slow Film", type: "movie",
    quality: "1080p", sizeBytes: 4e9, status: "downloading", phase: "downloading", progress: 0.12, downloadSpeed: 150000, peers: 2, at: new Date().toISOString(),
    race: {
      state: "racing", why: "projected to take 6.8 h more (a download this size should take under 2.0 h)",
      attempts: [
        { role: "original", infoHash: "a".repeat(40), provider: "FirstProvider", progress: 0.12, downloadSpeed: 150000, etaSec: 24500, peers: 2 },
        { role: "challenger", infoHash: "b".repeat(40), provider: "SecondProvider", progress: 0.03, downloadSpeed: 4200000, etaSec: 930, peers: 31 },
      ],
    },
    raceNote: null,
  };
  const noted = { ...racing, id: "bbbbbbbbbbbb", title: "Stuck Film", label: "Stuck Film", race: null, raceNote: "No healthy source was found at 1080p — still trying the original." };
  const plain = { ...racing, id: "cccccccccccc", title: "Fine Film", label: "Fine Film", race: null, raceNote: null };
  await page.route("**/api/downloads", (route) => route.fulfill({ json: [racing, noted, plain] }));
  await page.route("**/api/admin/aria2-limits", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    body.slots = { ...body.slots, maxActive: 4, cap: 2, holding: true, watching: 1, holdAt: 2, queued: 3 };
    await route.fulfill({ json: body });
  });
  await enter(page, srv);
  await downloadsTab(page);
  await page.waitForSelector("#dl-jobs tr.race-row");
  assert.equal(await page.locator("#dl-jobs tr.race-row").count(), 2, "the racing job and the one with a note — not the ordinary one");
  const line = await page.locator("#dl-jobs tr.race-row").first().innerText();
  assert.match(line, /trying a second source/);
  assert.match(line, /both running/);
  assert.match(line, /the first was slow: projected to take 6\.8 h more/);
  assert.match(line, /first FirstProvider · 12% · 146 KB\/s · ~6\.8h left/);
  assert.match(line, /second SecondProvider · 3% · 4\.0 MB\/s · ~16m left/);
  assert.match(await page.locator("#dl-jobs tr.race-row").nth(1).innerText(), /No healthy source was found at 1080p/);
  assert.equal(await page.locator("#dl-jobs > tr:not(.race-row)").count(), 3, "still one row per download");
  assert.match(await page.textContent("#lim-holding"), /holding at 2 while someone is watching/);
  assert.match(await page.textContent("#lim-status"), /3 queued — they start when viewing stops/);
});

// ---------- Downloads tab: a My List download on hold (src/media/dlslots.js) ----------
ui.test("In flight: a My List download on hold says so with what it has; 'Start now' moves it to the front; Cancel is still there", async ({ page, srv }) => {
  const base = {
    infoHash: "a".repeat(40), fileIdx: 0, type: "movie", quality: "1080p", sizeBytes: 4e9, peers: 0, downloadSpeed: 0, phase: null,
    at: new Date().toISOString(), race: null, raceNote: null, holdReason: null,
  };
  const jobs = [
    { ...base, id: "aaaaaaaaaaaa", title: "Held Film", label: "Held Film", status: "approved", progress: 0.42, smart: true, auto: "mylist", held: true, heldReason: "downloads" },
    { ...base, id: "bbbbbbbbbbbb", title: "Waiting Film", label: "Waiting Film", status: "approved", progress: 0, smart: true, auto: "mylist", held: false },
    { ...base, id: "cccccccccccc", title: "Asked Film", label: "Asked Film", status: "downloading", phase: "downloading", progress: 0.2, downloadSpeed: 3e6, smart: false, auto: null, held: false },
    { ...base, id: "dddddddddddd", title: "Queued Film", label: "Queued Film", status: "approved", progress: 0, smart: false, auto: null, held: false },
  ];
  await page.route("**/api/downloads", (route) => route.fulfill({ json: jobs }));
  const started = [];
  await page.route("**/api/admin/downloads/*/start", (route) => {
    started.push(new URL(route.request().url()).pathname);
    jobs[0] = { ...jobs[0], status: "downloading", phase: "finding", held: false, heldReason: null };
    route.fulfill({ json: { job: jobs[0] } });
  });
  await enter(page, srv);
  await downloadsTab(page);
  await page.waitForSelector('#dl-jobs tr[data-dl-id="aaaaaaaaaaaa"]');
  const row = (id) => page.locator(`#dl-jobs tr[data-dl-id="${id}"]`);
  assert.equal(await row("aaaaaaaaaaaa").locator(".pill").last().innerText(), "on hold");
  assert.match(await row("aaaaaaaaaaaa").innerText(), /42%/, "its progress so far stays on the row");
  assert.equal(await row("aaaaaaaaaaaa").getAttribute("data-dl-held"), "1");
  const notes = await page.locator("#dl-jobs tr.hold-row").allInnerTexts();
  assert.equal(notes.length, 2, "the held one and the My List one that has not started — not the others");
  assert.match(notes[0], /On hold — waiting for other downloads\. It carries on from 42%\./);
  assert.match(notes[1], /From My List — it starts after the other downloads\./);
  assert.equal(await row("bbbbbbbbbbbb").locator(".pill").last().innerText(), "approved", "a queued job reads as it always did");
  // the buttons: Start now only on My List jobs that wait; Cancel on every row
  assert.equal(await page.locator("#dl-jobs [data-dl-start]").count(), 2);
  assert.equal(await row("cccccccccccc").locator("[data-dl-start]").count(), 0);
  assert.equal(await row("dddddddddddd").locator("[data-dl-start]").count(), 0);
  assert.equal(await page.locator("#dl-jobs button.danger").count(), 4);

  await row("aaaaaaaaaaaa").locator("[data-dl-start]").click();
  await page.waitForFunction(() => !document.querySelector('#dl-jobs tr[data-dl-id="aaaaaaaaaaaa"][data-dl-held]'));
  assert.deepEqual(started, ["/api/admin/downloads/aaaaaaaaaaaa/start"]);
  assert.equal(await page.locator("#dl-jobs tr.hold-row").count(), 1);
});

// ---------- Downloads tab: My List downloads (src/media/mylistdl.js) ----------
const myListCard = async (page) => {
  await page.waitForSelector("#ml-card:not(.hidden)", { state: "attached" });
  if (!(await page.evaluate(() => document.querySelector("#ml-card").open))) await page.click("#ml-card > summary");
  await page.waitForFunction(() => document.querySelector("#ml-stale").value !== "");
};

ui.test("My List downloads: the owner's defaults, a change sticks across a reload, a refused value changes nothing", { allow: [/Failed to load resource.*400.*mylist\/settings/] }, async ({ page, srv, api }) => {
  await enter(page, srv);
  await downloadsTab(page);
  await myListCard(page);
  assert.equal(await page.isChecked("#ml-on"), true, "on, as asked");
  assert.equal(await page.isChecked("#ml-shows"), true);
  assert.equal(await page.isChecked("#ml-autodelete"), true);
  assert.equal(await page.inputValue("#ml-stale"), "14");
  assert.equal(await page.inputValue("#ml-delete"), "21");
  assert.equal(await page.inputValue("#ml-cap"), "5");
  assert.equal(await page.inputValue("#ml-retries"), "1");
  assert.equal(await page.inputValue("#ml-yield"), "always", "on hold while any other download is waiting or running");
  assert.match(await page.textContent("#ml-empty"), /Nothing has been fetched from a list yet/);

  await page.fill("#ml-stale", "10");
  await page.fill("#ml-delete", "30");
  await page.uncheck("#ml-shows");
  await page.selectOption("#ml-yield", "slots");
  await page.click("#ml-apply");
  await toastSays(page, /My List downloads: saved/);
  const saved = (await api.adminGet("/api/admin/mylist")).settings;
  assert.equal(saved.myListYield, "slots");
  assert.equal(saved.myListStaleDays, 10);
  assert.equal(saved.myListDeleteDays, 30);
  assert.equal(saved.myListShows, false);
  assert.equal(saved.myListDownloads, true, "what was not touched stays");

  await enter(page, srv);
  await downloadsTab(page);
  await myListCard(page);
  assert.equal(await page.inputValue("#ml-stale"), "10", "it stuck");
  assert.equal(await page.inputValue("#ml-yield"), "slots");
  assert.equal(await page.isChecked("#ml-shows"), false);

  // deleting before it was ever stale makes no sense, and neither does day 0
  await page.fill("#ml-delete", "5");
  await page.click("#ml-apply");
  await toastSays(page, /Delete after must not be sooner than Stale after/);
  await page.fill("#ml-delete", "30");
  await page.fill("#ml-stale", "0");
  await page.click("#ml-apply");
  await toastSays(page, /Stale after must be a whole number from 1 to 365/);
  const after = (await api.adminGet("/api/admin/mylist")).settings;
  assert.equal(after.myListStaleDays, 10);
  assert.equal(after.myListDeleteDays, 30);
  await api.adminPost("/api/admin/mylist/settings", { myListStaleDays: 14, myListDeleteDays: 21, myListShows: true });
});

// A stale copy cannot be staged in the private instance (it has no network to
// download with, and no clock to wind): the server's answers are made up here,
// in the shapes the routes really send (test/mylistdl-queue.test.js pins those).
ui.test("My List downloads: a job is tagged, a stale copy is marked on disk and is the first delete suggestion, with why", async ({ page, srv }) => {
  const DAY = 86400e3;
  const now = Date.now();
  const mark = { state: "stale", why: "added to My List on 2026-09-20, never watched", by: "Ann", addedAt: now - 16 * DAY, staleAt: now - 2 * DAY, deleteAt: now + 5 * DAY };
  const fresh = { state: "fresh", why: "added to My List on 2026-10-08", by: "Ben", addedAt: now - 2 * DAY, staleAt: now + 12 * DAY, deleteAt: now + 19 * DAY };
  const job = {
    id: "dddddddddddd", infoHash: "d".repeat(40), fileIdx: 0, imdbId: "tt9000009", title: "Listed Film", label: "Listed Film", type: "movie",
    quality: "1080p", sizeBytes: 3e9, status: "downloading", phase: "downloading", progress: 0.4, downloadSpeed: 2e6, peers: 9, at: new Date().toISOString(),
    smart: true, auto: "mylist", race: null, raceNote: null,
  };
  await page.route("**/api/downloads", (route) => route.fulfill({ json: [job, { ...job, id: "eeeeeeeeeeee", title: "Asked Film", label: "Asked Film", smart: false, auto: null }] }));
  await page.route("**/api/admin/library/tree", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.movies = [
      { id: "m-stale", title: "Stale Film", year: 2020, cover: null, addedAt: now - 16 * DAY, mylist: mark, watched: 0, midway: 0, lastWatched: 0, sizeBytes: 4 * 1024 ** 3 },
      { id: "m-fresh", title: "Fresh Film", year: 2021, cover: null, addedAt: now - 2 * DAY, mylist: fresh, watched: 0, midway: 0, lastWatched: 0, sizeBytes: 3 * 1024 ** 3 },
      { id: "m-watched", title: "Watched Film", year: 2019, cover: null, addedAt: now - 90 * DAY, mylist: null, watched: 1, midway: 0, lastWatched: now - 30 * DAY, sizeBytes: 2 * 1024 ** 3 },
      { id: "m-plain", title: "Plain Film", year: 2018, cover: null, addedAt: now - 200 * DAY, mylist: null, watched: 0, midway: 0, lastWatched: 0, sizeBytes: 5 * 1024 ** 3 },
    ];
    body.shows = [];
    await route.fulfill({ json: body });
  });
  await page.route("**/api/admin/mylist", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.records = [
      { key: "tt1", label: "Stale Film", by: "Ann", addedAt: mark.addedAt, state: "stale", due: false, why: mark.why, staleAt: mark.staleAt, deleteAt: mark.deleteAt },
      { key: "tt2", label: "Fresh Film", by: "Ben", addedAt: fresh.addedAt, state: "fresh", why: fresh.why, staleAt: fresh.staleAt, deleteAt: fresh.deleteAt },
      { key: "tt3:1:1", label: "Some Show · S1 E1", by: "Ann", addedAt: now - 40 * DAY, state: "deleted", why: "added to My List on 2026-08-30, never watched", staleAt: null, deleteAt: null },
      { key: "tt4", label: "No Source Film", by: "Ben", addedAt: now - DAY, state: "failed", why: "no source", staleAt: null, deleteAt: null },
    ];
    await route.fulfill({ json: body });
  });
  let deletes = 0;
  await page.route("**/api/admin/library/movie/*", (route) => { deletes++; return route.fulfill({ status: 500, json: { error: "not in this test" } }); });

  await enter(page, srv);
  await downloadsTab(page);
  // the queue: the list's job says so, somebody's own does not
  await page.waitForSelector("#dl-jobs tr");
  assert.match(await page.locator("#dl-jobs tr", { hasText: "Listed Film" }).innerText(), /My List/);
  assert.doesNotMatch(await page.locator("#dl-jobs tr", { hasText: "Asked Film" }).innerText(), /My List/);

  // the card: one row per copy, with its state and its clock
  await myListCard(page);
  await page.waitForSelector('#ml-rows tr[data-ml-key="tt1"]');
  const row = (key) => page.locator(`#ml-rows tr[data-ml-key="${key}"]`).innerText();
  assert.match(await row("tt1"), /Stale Film\s+Ann\s+\d{4}-\d\d-\d\d\s+stale deleted in 5 d — added to My List on 2026-09-20, never watched/);
  assert.match(await row("tt2"), /on disk stale in 12 d, deleted in 19 d/);
  assert.match(await row("tt3:1:1"), /Some Show · S1 E1[\s\S]*deleted/);
  assert.match(await row("tt4"), /failed no source/);
  assert.equal(await page.locator("#ml-rows [data-ml-keep]").count(), 2, "Keep is offered for the copies still on disk, nothing else");

  // on disk: the two copies carry their mark, the others none
  await page.waitForSelector("#lib-tree .lib-row");
  const lib = (name) => page.locator("#lib-tree .lib-row", { hasText: name }).innerText();
  assert.match(await lib("Stale Film"), /My List · stale/);
  assert.match(await lib("Fresh Film"), /My List · 12 d/);
  assert.doesNotMatch(await lib("Watched Film"), /My List/);
  assert.doesNotMatch(await lib("Plain Film"), /My List/);

  // "Suggest what to delete": the stale copy first, with why; then the watched film; never the fresh or the plain one
  await page.fill("#free-gb", "5");
  await page.click("#free-suggest");
  await page.waitForSelector("dialog.ask");
  const text = await page.locator("dialog.ask").innerText();
  assert.match(text, /Delete 2 items to free 6\.0 GB\?/);
  assert.ok(text.indexOf("Stale Film (2020)") >= 0 && text.indexOf("Stale Film (2020)") < text.indexOf("Watched Film (2019)"), "the stale one is offered first");
  assert.match(text, /Stale Film \(2020\) — 4\.0 GB \(added to My List on 2026-09-20, never watched\)/);
  assert.match(text, /1 of them was fetched because it was added to My List and has not been watched since/);
  assert.doesNotMatch(text, /Fresh Film|Plain Film/);
  await page.click("dialog.ask .ask-no");
  await page.waitForSelector("dialog.ask", { state: "detached" });
  assert.equal(deletes, 0, "nothing is deleted without a yes");

  // a small target is met by the stale copy alone
  await page.fill("#free-gb", "3");
  await page.click("#free-suggest");
  await page.waitForSelector("dialog.ask");
  const one = await page.locator("dialog.ask").innerText();
  assert.match(one, /Delete 1 item to free 4\.0 GB\?/);
  assert.match(one, /Each was fetched because it was added to My List/);
  assert.doesNotMatch(one, /Watched Film/);
  await page.click("dialog.ask .ask-no");
});

// ---------- Server → Status: the Healer card (src/lib/healer.js) ----------
// The card is painted from GET /api/admin/healer. These tests hand it a made-up
// round (the private instance is healthy, and a real fault cannot be staged
// from here), and stop the live "healer_update" pushes so the minute's real
// round cannot repaint the card in the middle of an assertion.
const HL_GROUPS = ["Process & memory", "Logs", "Playback", "Streaming & transcoding", "Downloads", "Library & data", "Updates & delivery"];
const hlCheck = (id, name, group, o = {}) => ({ id, name, group, ms: 1, status: "ok", summary: `${name} is fine`, ...o });
const healerFixture = () => {
  const now = Date.now();
  const checks = [
    hlCheck("process", "Process", "Process & memory", { summary: "412 MB resident · 20 ms lag · 1 ffmpeg · up 3 d" }),
    hlCheck("memtrend", "Memory and load trend", "Process & memory"),
    hlCheck("helpers", "Helper processes", "Process & memory"),
    hlCheck("errors", "Errors in the log", "Logs", {
      status: "warn", summary: "0 errors, 12 warnings in the last 15 min · 1 known problem",
      findings: [{ level: "warn", title: "A provider is rate-limiting", text: "Cinemeta (the catalogue) is turning this server away for asking too often (12 refusals in 15 minutes). It recovers by itself when the requests slow down.", evidence: "counted 12 (cinemeta:429)" }],
    }),
    hlCheck("newerrors", "New kinds of error", "Logs", {
      status: "warn", summary: "1 new kind of error in the last day · 14 kinds on record",
      findings: [{ level: "warn", title: "Never seen before", text: "[xray] the cast list came back in an unexpected shape", evidence: "4 times in 15 min when first noticed, 9 in all", ai: "The cast service answered in a shape Aurora did not expect. <b>It usually clears by itself.</b>", press: { action: "clear-meta", label: "Server → Actions → Clear metadata and subtitle caches" } }],
    }),
    hlCheck("offenders", "Repeat offenders", "Logs"),
    hlCheck("errtrend", "Error rate", "Logs"),
    hlCheck("playback", "Playback health", "Playback", { summary: "23 plays in 24 h · first frame 1.2 s median, 3.4 s p90 · 0 failed to start · 0.4 stalls per hour watched" }),
    hlCheck("sessions", "Viewers and sessions", "Playback"),
    hlCheck("realtime", "Devices", "Playback", { status: "info", summary: "3 devices connected" }),
    hlCheck("encoding", "Encoding", "Streaming & transcoding"),
    hlCheck("transcoding", "Transcoding", "Streaming & transcoding"),
    hlCheck("streaming", "Streaming client", "Streaming & transcoding"),
    hlCheck("upstream", "Upstream providers", "Streaming & transcoding"),
    hlCheck("downloads", "Download queue", "Downloads"),
    hlCheck("aria2", "Download engine", "Downloads"),
    hlCheck("staging", "Staging", "Downloads"),
    hlCheck("dlstats", "Download results", "Downloads"),
    hlCheck("disk", "Disk", "Library & data"),
    hlCheck("library", "Library folders and files", "Library & data", {
      status: "fail", summary: "1 of 2 library folders is away: D:\\Shows",
      findings: [
        { level: "fail", title: "A library folder is not there", text: "The shows folder D:\\Shows cannot be read — the drive is unplugged, asleep or not mounted. Its titles are NOT deleted.", evidence: "38 titles in the library come from it", setting: "Plug the drive back in (or wake / mount it). Nothing else is needed." },
        { level: "warn", title: "Files in the library that are no longer on disk", text: "“Old Film.mkv” is listed in the library but the file is gone (its folder is fine).", evidence: "1 file", did: "tried 6 times today, needs you — Server → Actions → Rescan the library", press: { action: "rescan", label: "Server → Actions → Rescan the library" } },
      ],
    }),
    hlCheck("scanner", "Library scan", "Library & data"),
    hlCheck("temp", "Temporary files", "Library & data"),
    hlCheck("data", "Data files", "Library & data"),
    hlCheck("growth", "Data growth", "Library & data"),
    hlCheck("backups", "Backups", "Library & data", { healed: "started a backup" }),
    hlCheck("updates", "Update state", "Updates & delivery"),
    hlCheck("delivery", "Alert delivery", "Updates & delivery"),
    hlCheck("clock", "Clock", "Updates & delivery"),
    hlCheck("tvapp", "TV app", "Updates & delivery", { status: "info", summary: "no APK has been published" }),
  ];
  return {
    last: { at: now - 20000, tookMs: 7, overall: "fail", checks },
    history: Array.from({ length: 40 }, (_, i) => ({ at: now - (40 - i) * 60000, overall: i > 36 ? "fail" : i > 30 ? "warn" : "ok", fail: 0, warn: 0 })),
    events: [{ at: now - 90000, kind: "temp cleared", detail: "1.2 GB" }],
    everyMs: 60000,
    groups: HL_GROUPS,
    repairs: [
      { at: now - 5 * 60000, repair: "backup-now", action: "backup-now", title: "Back up now", subject: "stale", why: "the newest working backup is 3 d (line: 48 h)", runId: "x-1", outcome: "ok", said: "Made aurora-backup-20261008-120000.tar.gz." },
      { at: now - 50 * 60000, repair: "sweep-streams", action: "sweep-streams", title: "Tidy stream leftovers", subject: "stuck helpers", why: "2 converters running with no viewer for 40 min", runId: "x-0", outcome: "failed", said: "library streams: EBUSY" },
    ],
    autoRepair: { on: true, off: [], may: ["sweep-streams", "patch-webtorrent", "rescan", "backup-now", "jit-forget-changed"] },
    ai: false,
  };
};
const healerCard = async (page, srv, fixture = healerFixture()) => {
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      try { if (JSON.parse(m).type === "healer_update") return; } catch {}
      ws.send(m);
    });
  });
  await page.route("**/api/admin/healer", (route) => (route.request().method() === "GET" ? route.fulfill({ json: fixture }) : route.continue()));
  await enter(page, srv);
  await page.click('.tab[data-tab="server"]');
  await page.waitForSelector("#hl-checks .hl-group");
  return fixture;
};
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

ui.test("the Healer card groups ~30 checks: groups with a problem first and open, healthy groups folded to one line, the history strip kept", { viewport: { width: 1440, height: 900 } }, async ({ page, srv }) => {
  const fx = await healerCard(page, srv);
  const groups = await page.evaluate(() => [...document.querySelectorAll("#hl-checks .hl-group")].map((g) => ({ name: g.dataset.group, open: g.open, cls: g.className, line: g.querySelector("summary").innerText.replace(/\s+/g, " ").trim(), checks: g.querySelectorAll(".hl-check").length })));
  assert.equal(groups.length, 7);
  assert.deepEqual(groups.map((g) => g.name).slice(0, 2), ["Library & data", "Logs"], "the failing group first, then the one with warnings");
  assert.deepEqual(groups.slice(2).map((g) => g.name), HL_GROUPS.filter((n) => n !== "Library & data" && n !== "Logs"), "the healthy ones after, in their fixed order");
  assert.equal(groups.reduce((n, g) => n + g.checks, 0), fx.last.checks.length, "every check is in exactly one group");
  assert.deepEqual(groups.map((g) => g.open), [true, true, false, false, false, false, false]);
  assert.match(groups[0].line, /^Library & data — 1 failing, 6 fine/);
  assert.match(groups[1].line, /^Logs — 2 warnings, 2 fine/);
  assert.match(groups.find((g) => g.name === "Playback").line, /^Playback — 3 checks fine/);
  assert.match(groups.find((g) => g.name === "Downloads").line, /^Downloads — 4 checks fine/);
  // inside an open group the problem check comes first
  assert.equal(await page.locator('.hl-group[data-group="Library & data"] .hl-check').first().getAttribute("data-check"), "library");
  // the headline counts, and the history strip is still there
  assert.match(await page.innerText("#hl-overall"), /Something is wrong.*29 checks.*in 7 ms.*1 failing.*2 warnings/s);
  assert.equal(await page.locator("#hl-history i").count(), 40);
  // a folded group opens on a click and shows its checks; the next repaint leaves it open
  const playback = page.locator('.hl-group[data-group="Playback"]');
  assert.ok(!(await playback.locator(".hl-check").first().isVisible()));
  await playback.locator("summary").click();
  await playback.locator('.hl-check[data-check="playback"]').waitFor();
  assert.match(await playback.innerText(), /23 plays in 24 h · first frame 1\.2 s median/);
  await page.evaluate(() => loadHealer());
  await page.waitForTimeout(300);
  assert.ok(await page.locator('.hl-group[data-group="Playback"]').evaluate((g) => g.open), "opened by hand: it stays open");
  assert.ok(await noSidewaysScroll(page));
});

ui.test("a finding shows its sentence, its evidence, what the healer did, and the button to press; a model's guess is shown as text only", async ({ page, srv }) => {
  await healerCard(page, srv);
  const gone = page.locator('.hl-check[data-check="library"] .hl-find', { hasText: "no longer on disk" });
  const text = await gone.innerText();
  assert.match(text, /“Old Film\.mkv” is listed in the library but the file is gone/);
  assert.match(text, /EVIDENCE\s*1 file/i);
  assert.match(text, /THE HEALER\s*tried 6 times today, needs you — Server → Actions → Rescan the library/i);
  assert.equal((await gone.locator(".hl-press").innerText()).trim(), "Server → Actions → Rescan the library →");
  // the unreachable drive says what to do, and has no button (nothing to press)
  const away = page.locator('.hl-check[data-check="library"] .hl-find.fail');
  assert.match(await away.innerText(), /cannot be read — the drive is unplugged/);
  assert.match(await away.innerText(), /WHAT TO DO\s*Plug the drive back in/i);
  assert.equal(await away.locator(".hl-press").count(), 0);
  // a check that fixed something says so on its own line
  await page.locator('.hl-group[data-group="Library & data"] .hl-check[data-check="backups"]').waitFor();
  assert.match(await page.innerText('.hl-check[data-check="backups"]'), /Did: started a backup/);
  // the model's words are text: the markup in them is not rendered
  const guess = page.locator('.hl-check[data-check="newerrors"] .hl-find');
  assert.match(await guess.innerText(), /A MODEL'S GUESS\s*The cast service answered in a shape Aurora did not expect\. <b>It usually clears by itself\.<\/b>/i);
  assert.equal(await guess.locator("b").count(), 0, "nothing the model wrote became an element");
});

ui.test("“What the healer did” lists the automatic repairs with how each ended", async ({ page, srv }) => {
  await healerCard(page, srv);
  const rows = page.locator("#hl-repairs .hl-rep");
  assert.equal(await rows.count(), 2);
  const first = await rows.nth(0).innerText();
  assert.match(first, /done\s+Back up now/);
  assert.match(first, /the newest working backup is 3 d \(line: 48 h\)/);
  assert.match(first, /→ Made aurora-backup-20261008-120000\.tar\.gz\./);
  assert.match(await rows.nth(1).innerText(), /failed\s+Tidy stream leftovers.*2 converters running with no viewer.*EBUSY/s);
  assert.match(await page.innerText("#hl-repairs"), /What the healer did/);
  // with nothing done yet it says what it MAY do, and switched off says so
  const none = healerFixture();
  none.repairs = [];
  none.autoRepair.on = false;
  await page.unroute("**/api/admin/healer");
  await page.route("**/api/admin/healer", (route) => route.fulfill({ json: none }));
  await page.evaluate(() => loadHealer());
  await page.waitForFunction(() => /has not pressed any action by itself yet/.test(document.querySelector("#hl-repairs").innerText));
  assert.match(await page.innerText("#hl-overall"), /Automatic repairs are switched off in config\.json/);
});

ui.test("a finding's button lands on that action in Server → Actions, lit — and does not run it", async ({ page, srv, api }) => {
  await healerCard(page, srv);
  const before = (await api.adminGet("/api/admin/actions")).runs.length;
  const posts = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/admin\/actions\//.test(r.url())) posts.push(r.url()); });
  await page.click('.hl-check[data-check="library"] .hl-press[data-press="rescan"]');
  await page.waitForSelector("#pane-actions.active");
  await page.waitForSelector("#ac-groups .ac-row.ac-hot");
  assert.equal(await page.locator("#ac-groups .ac-row.ac-hot").count(), 1, "one action is lit");
  assert.equal(await page.locator('#ac-groups .ac-row.ac-hot [data-action]').getAttribute("data-action"), "rescan");
  assert.match(await page.innerText("#ac-groups .ac-row.ac-hot"), /Rescan the library/);
  assert.equal(await page.locator('#subtabs [data-sub="actions"]').getAttribute("class"), "active");
  // …and scrolled to (smoothly, so it is waited for, not sampled)
  await page.waitForFunction(() => { const r = document.querySelector("#ac-groups .ac-row.ac-hot"); if (!r) return false; const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; });
  await page.waitForTimeout(600);
  assert.deepEqual(posts, [], "nothing was started");
  assert.equal((await api.adminGet("/api/admin/actions")).runs.length, before);
  // the actions the healer may press by itself are marked; the dangerous ones are not
  assert.match(await page.innerText('#ac-groups .ac-row:has([data-action="rescan"]) .ac-tag'), /the healer may run this/);
  assert.match(await page.innerText('#ac-groups .ac-row:has([data-action="sweep-streams"]) .ac-tag'), /the healer may run this/);
  for (const id of ["restart", "update-all", "npm-install", "git-pull", "notify-test", "clear-images"]) {
    assert.equal(await page.locator(`#ac-groups .ac-row:has([data-action="${id}"]) .ac-tag`).count(), 0, id);
  }
  // a second finding points at another action: the light moves
  await page.click('.tab[data-tab="server"]');
  await page.click('.hl-check[data-check="newerrors"] .hl-press');
  await page.waitForFunction(() => { const r = document.querySelector("#ac-groups .ac-row.ac-hot [data-action]"); return r && r.dataset.action === "clear-meta"; });
  assert.equal(await page.locator("#ac-groups .ac-row.ac-hot").count(), 1);
});

ui.test("Recent runs says who ran it: “by the healer — why”", async ({ page, srv }) => {
  await page.route("**/api/admin/actions", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const body = await (await route.fetch()).json();
    const now = Date.now();
    body.runs = [
      { id: "h-1", action: "rescan", title: "Rescan the library", startedAt: now - 60000, endedAt: now - 58000, status: "ok", code: null, output: "Scanned.", by: "healer", why: "D:\\Shows came back after 3 h" },
      { id: "a-1", action: "versions", title: "Tool versions", startedAt: now - 120000, endedAt: now - 119000, status: "ok", code: null, output: "Done.", by: "admin", why: null },
    ];
    await route.fulfill({ json: body });
  });
  await enter(page, srv);
  await actionsTab(page);
  await page.waitForSelector('#ac-runs .ac-run[data-by="healer"]');
  assert.match(await page.innerText('#ac-runs .ac-run[data-by="healer"]'), /Rescan the library.*by the healer — D:\\Shows came back after 3 h/s);
  assert.doesNotMatch(await page.innerText('#ac-runs .ac-run[data-by="admin"]'), /healer/);
});

ui.test("the Healer card on a phone: nothing runs off the side, and the button is a full-width target", { viewport: { width: 390, height: 844 } }, async ({ page, srv }) => {
  await healerCard(page, srv);
  assert.ok(await noSidewaysScroll(page), "no sideways scroll at 390 px");
  const card = await page.locator("#hl-checks").boundingBox();
  for (const sel of [".hl-group", ".hl-check", ".hl-find", ".hl-press"]) {
    const boxes = await page.locator(`#hl-checks ${sel}`).evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => { const b = e.getBoundingClientRect(); return [b.left, b.right]; }));
    assert.ok(boxes.length > 0, sel);
    for (const [l, r] of boxes) assert.ok(l >= card.x - 1 && r <= card.x + card.width + 1, `${sel} sticks out: ${l}–${r} of ${card.x}–${card.x + card.width}`);
  }
  const press = await page.locator(".hl-press").first().boundingBox();
  assert.ok(press.height >= 40, `a thumb-sized button (${press.height}px)`);
  await page.locator('.hl-press[data-press="rescan"]').click();
  await page.waitForSelector("#ac-groups .ac-row.ac-hot");
  assert.equal(await page.locator('#ac-groups .ac-row.ac-hot [data-action]').getAttribute("data-action"), "rescan");
  assert.ok(await noSidewaysScroll(page));
});

ui.test("a real round on the private instance: every check lands in one of the seven groups, and the round is quick", async ({ page, srv, api }) => {
  await enter(page, srv);
  await page.click('.tab[data-tab="server"]');
  await page.click("#healer-run-btn");
  await page.waitForFunction(() => document.querySelectorAll("#hl-checks .hl-group").length >= 5 && document.querySelector("#healer-run-btn").textContent === "Run all checks now");
  const h = await api.adminGet("/api/admin/healer");
  assert.ok(h.last.checks.length >= 28, `${h.last.checks.length} checks`);
  assert.deepEqual(h.groups, HL_GROUPS);
  for (const c of h.last.checks) assert.ok(HL_GROUPS.includes(c.group), `${c.id} is in no group`);
  assert.equal(await page.locator("#hl-checks .hl-check").count(), h.last.checks.length);
  for (const id of ["errors", "newerrors", "offenders", "errtrend", "playback", "sessions", "transcoding", "dlstats", "library", "backups", "memtrend", "helpers", "updates", "delivery", "clock", "growth"]) {
    assert.ok(h.last.checks.some((c) => c.id === id), `the ${id} check did not run`);
  }
  assert.ok(!h.last.checks.some((c) => /the check threw|took more than 20 s/.test(c.summary)), JSON.stringify(h.last.checks.filter((c) => /threw|20 s/.test(c.summary))));
  assert.ok(h.last.tookMs < 3000, `the round took ${h.last.tookMs} ms`);
  assert.deepEqual(h.repairs, [], "a healthy instance: the healer pressed nothing");
});

// one at a time: these tests share the admin's queue and the list of people

// ---- Insights → the TV app's frame timings (lib/usage.js perf) ----
ui.test("Insights shows the TV frames and TV boxes tables from a stubbed usage summary, and hides them when there is none", async ({ page, srv }) => {
  const perf = {
    screens: [
      { screen: "home", v: "92", impl: "-", n: 412, frames: 180000, p50: 29, p90: 41, p90hi: 58, jank: 3.4, low: 74, lite: 16 },
      { screen: "home", v: "93", impl: "F", n: 120, frames: 52000, p50: 24, p90: 33, p90hi: 40, jank: 1.1, low: 0, lite: 0 },
    ],
    devices: [{ model: "MiTV-AFMU0", n: 30, sdk: { 34: 28, 30: 2 }, mem_mb: 2048, heap_mb: 256, gpu: "Mali-G31", lowram: 0, low: { no: 18, android: 0, mem: 0, heap: 0, frames: 12, trim: 0 } }],
    trims: { 15: 3 },
  };
  let withPerf = true;
  await page.route("**/api/admin/usage", (route) => route.fulfill({ json: { summary: { events: 9, batches: 2, devices: { tv: 9 }, looks: { tv: 9 }, routes: [], features: [], nav: [], plays: [], errors: [], activeByDay: [], perf: withPerf ? perf : { screens: [], devices: [], trims: {} } }, text: "stub" } }));
  await enter(page, srv);
  await page.click('.tab[data-tab="analytics"]');
  await page.waitForFunction(() => !document.getElementById("usage-tv").classList.contains("hidden"));
  const rows = await page.evaluate(() => [...document.querySelectorAll("#usage-tv-screens tr")].map((tr) => [...tr.cells].map((c) => c.textContent)));
  assert.deepEqual(rows[0], ["home", "92", "-", "412", "180000", "29ms", "41ms", "58ms", "3.4%", "18%", "4%"]);
  assert.deepEqual(rows[1].slice(0, 3), ["home", "93", "F"]);
  assert.equal(rows[1][9], "–", "no low sessions reads as a dash");
  const box = await page.evaluate(() => [...document.querySelector("#usage-tv-boxes tr").cells].map((c) => c.textContent));
  assert.deepEqual(box, ["MiTV-AFMU0", "30 / 34", "2048", "256", "Mali-G31", "0 / 30", "no 18, frames 12"]);
  // without perf data the block hides again
  withPerf = false;
  await page.click('.tab[data-tab="overview"]');
  await page.click('.tab[data-tab="analytics"]');
  await page.waitForFunction(() => document.getElementById("usage-tv").classList.contains("hidden"));
});

ui.run({ concurrency: 1 });

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

// one at a time: these tests share the admin's queue and the list of people
ui.run({ concurrency: 1 });

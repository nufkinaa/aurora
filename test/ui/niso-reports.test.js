// Three reports from Niso, 2026-10-31 (TV 5.8.1), and what they asked of the website:
//
//   * how many downloads this person has, by where they are (a count: no limit)
//   * Cancel: from My downloads and from a title's page, always asked first
//   * "Wrong language → another version → canceled": a list that knows the reason,
//     a plain line for how the last try ended, the next candidates, and the report
//     carrying the client's version
//
// Nothing here downloads anything: the queue's and the sheet's answers are stubbed
// in the browser, in the shapes the server sends (test/replace-version.test.js and
// test/copylang.test.js hold the server's side).
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite();

const FILM = "tt7700002";
const job = (over = {}) => ({
  id: "aaaaaaaaaaaa", infoHash: "a".repeat(40), fileIdx: 0, imdbId: FILM, title: "Some Film", label: "Some Film", type: "movie",
  season: null, episode: null, quality: "1080p", sizeBytes: 4e9, poster: null, provider: null,
  status: "downloading", phase: "downloading", copyProgress: null, progress: 0, downloadSpeed: 0, peers: 0,
  error: null, at: new Date().toISOString(), approvedAt: null, doneAt: null,
  holdReason: null, autoApproved: true, seenAt: null, smart: false, resolvedAt: null, libraryId: null,
  race: null, raceNote: null, mine: true, replaces: null, canceledBy: null, ...over,
});
const stubQueue = async (page, jobs) => {
  const cancels = [];
  await page.route((url) => url.pathname === "/api/downloads", (route) => route.fulfill({ json: jobs }));
  await page.route((url) => /^\/api\/downloads\/[^/]+\/cancel$/.test(url.pathname), (route) => {
    cancels.push({ url: route.request().url(), body: route.request().postDataJSON() });
    route.fulfill({ json: { ok: true } });
  });
  return cancels;
};
const ask = ".look-notice-wrap:not(.replace-wrap) .look-notice.sheet";

for (const [vp, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`${vp}: My downloads counts this person's downloads, what is moving comes first, and Cancel always asks`, { viewport }, async ({ page, goto, signIn, freshProfile }) => {
    const running = job({ id: "111111111111", title: "Running Film", label: "Running Film", progress: 0.02 });
    const jobs = [
      job({ id: "000000000001", title: "Ready One", label: "Ready One", status: "done", libraryId: "lib1", doneAt: new Date().toISOString() }),
      job({ id: "000000000002", title: "Ready Two", label: "Ready Two", status: "done", libraryId: "lib2", doneAt: new Date().toISOString() }),
      running,
      job({ id: "222222222222", title: "Queued Film", label: "Queued Film", status: "approved", phase: null }),
      // somebody else's: not counted, no Cancel
      job({ id: "333333333333", title: "Dor's Film", label: "Dor's Film", mine: false, by: "Dor" }),
    ];
    const cancels = await stubQueue(page, jobs);
    await signIn(await freshProfile());
    await goto("#/downloads");
    await page.waitForSelector('.dl-row[data-id="111111111111"]');
    assert.equal((await page.locator(".dl-summary").innerText()).trim(), "1 downloading · 1 queued · 2 ready");
    // moving, then waiting, then what is ready
    const sections = await page.locator(".dl-moving h2, .dl-queued h2, .dl-ready h2").allInnerTexts();
    assert.deepEqual(sections.map((s) => s.replace(/\d+/g, "").trim()), ["Downloading now", "Waiting", "Ready to play"]);
    assert.equal(await page.locator('.dl-row[data-id="333333333333"] button', { hasText: "Cancel" }).count(), 0, "someone else's stays theirs");

    // 2%: it used to go straight through
    const btn = page.locator('.dl-row[data-id="111111111111"] [data-ui="downloads.cancel"]');
    await btn.click();
    const sheet = page.locator(ask);
    await sheet.waitFor();
    assert.match(await sheet.innerText(), /Cancel “Running Film”\?/);
    assert.match(await sheet.innerText(), /It's 2% down\./);
    await sheet.locator("button", { hasText: "Keep going" }).click();
    await sheet.waitFor({ state: "detached" });
    assert.equal(cancels.length, 0);
    await page.waitForFunction(() => !document.querySelector('.dl-row[data-id="111111111111"] [data-ui="downloads.cancel"]').disabled);

    // a queued one asks too
    await page.locator('.dl-row[data-id="222222222222"] [data-ui="downloads.cancel"]').click();
    await sheet.waitFor();
    assert.match(await sheet.innerText(), /You can always ask for it again\./);
    await sheet.locator("button", { hasText: "Cancel the download" }).click();
    await page.locator('.toast:has-text("Cancelled “Queued Film”")').first().waitFor();
    assert.equal(cancels.length, 1);
    assert.ok(cancels[0].url.endsWith("/api/downloads/222222222222/cancel"));
    assert.ok(cancels[0].body.profile, "the profile goes with it");
  });
}

ui.test("My downloads opened by its address: the list is read for this profile, not as someone else's", async ({ page, goto, signIn, freshProfile }) => {
  // the server's rule: with no session, `mine` depends on the profile named
  await page.route((url) => url.pathname === "/api/downloads", (route) => {
    const named = new URL(route.request().url()).searchParams.get("profile");
    route.fulfill({ json: [job({ mine: !!named }), job({ id: "b", status: "done", libraryId: "lib1", mine: !!named })] });
  });
  await signIn(await freshProfile());
  await goto("#/downloads");
  await page.waitForFunction(() => /1 downloading · 1 ready/.test(document.querySelector(".dl-summary")?.textContent || ""));
  assert.equal(await page.locator(".dl-others .dl-row").count(), 0);
});

ui.test("the profile menu says the same count under My downloads", async ({ page, goto, signIn, freshProfile }) => {
  await stubQueue(page, [job(), job({ id: "b", status: "done", libraryId: "lib1" }), job({ id: "c", mine: false })]);
  await signIn(await freshProfile());
  await goto("#/downloads");
  await page.waitForSelector(".dl-summary:not(.hidden)");
  await page.click("#nav-profile");
  const item = page.locator(".nav-menu-dl");
  await item.waitFor();
  assert.match(await item.innerText(), /My downloads\s+1 downloading · 1 ready/);
});

ui.test("a cancelled row says who did it; another version that ended offers the next ones, not the same request again", async ({ page, goto, signIn, freshProfile, lib }) => {
  const replaces = { id: "r1", libraryId: lib.film1.id, reason: "language", reasonLabel: "Wrong language" };
  await stubQueue(page, [
    job({ id: "444444444444", title: "By The Admin", label: "By The Admin", status: "canceled", canceledBy: "admin" }),
    job({ id: "555555555555", title: "By Me", label: "By Me", status: "canceled", canceledBy: "self" }),
    job({ id: "666666666666", title: "Test Film One", label: "Test Film One — another version", status: "canceled", canceledBy: "self", replaces }),
    job({ id: "777777777777", title: "Test Film One", label: "Test Film One — another version", status: "error", error: "no peers", replaces }),
  ]);
  await page.route((url) => /^\/api\/replace\/[^/]+$/.test(url.pathname), async (route) => {
    const real = await route.fetch();
    const json = await real.json();
    route.fulfill({ json: { ...json, last: { status: "canceled", reason: "language", reasonLabel: "Wrong language", canceledBy: "self", why: null, release: "Test.Film.One.BONE", quality: "1080p", line: "You cancelled it — your copy stays as it was." } } });
  });
  await signIn(await freshProfile());
  await goto("#/downloads");
  await page.waitForSelector('.dl-row[data-id="444444444444"]');
  const status = async (id) => (await page.locator(`.dl-row[data-id="${id}"] .dl-status`).innerText()).split(/\s+/).join(" ");
  assert.match(await status("444444444444"), /^Cancelled by /);
  assert.match(await status("555555555555"), /^Cancelled by you/);
  assert.match(await status("666666666666"), /^Cancelled by you · Your copy stays as it was/);
  assert.match(await status("777777777777"), /^Failed · Your copy stays as it was · no peers/);
  assert.equal(await page.locator('.dl-row[data-id="666666666666"] [data-ui="downloads.retry"]').count(), 0);
  assert.equal(await page.locator('.dl-row[data-id="555555555555"] [data-ui="downloads.retry"]').count(), 1, "an ordinary download is simply asked for again");
  await page.locator('.dl-row[data-id="666666666666"] [data-ui="downloads.another"]').click();
  const sheet = page.locator(".replace-wrap .replace-copy");
  await sheet.waitFor();
  await page.waitForFunction(() => /didn't come through/.test(document.querySelector(".replace-copy").innerText));
  assert.match(await sheet.innerText(), /You cancelled it — your copy stays as it was\./);
  assert.match(await sheet.innerText(), /That was: Test\.Film\.One\.BONE \(1080p\)/);
});

ui.test("Wrong language: the sheet asks for that list, says what it left out, marks the language; the report carries the version", async ({ page, api, signIn, freshProfile, goto, lib }) => {
  const stream = (c, o = {}) => ({ infoHash: String(c).repeat(40), fileIdx: 0, quality: "1080p", qualityLabel: "1080p", sizeBytes: 2e9, seeders: 90, provider: "x", release: `Test.Film.One.${c}`, ...o });
  const urls = [];
  const posts = [];
  await page.route((url) => /^\/api\/replace\/[^/]+\/sources$/.test(url.pathname), (route) => {
    urls.push(route.request().url());
    route.fulfill({ json: {
      streams: [stream("b", { recommended: true, langFit: "right", langLabel: "English" }), stream("c", { langFit: "unknown", langLabel: null }), stream("d", { langFit: "other", langLabel: "Hindi", tried: { status: "canceled", label: "Tried here: cancelled" } })],
      note: "Versions in English first. 2 in Russian left out.",
      current: { quality: "1080p", sizeBytes: 1.5e9, release: "Test.Film.One.RUS" },
    } });
  });
  await page.route((url) => /^\/api\/replace\/[^/]+$/.test(url.pathname), async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, replacement: { id: "r1", reason: "language", reasonLabel: "Wrong language", status: "approved", progress: 0, mine: true }, job: { id: "j1", status: "approved" } } });
    }
    return route.fallback();
  });
  await signIn(await freshProfile());
  await goto(`#/movie/${lib.film1.id}`);
  await page.click('[data-ui="detail.replace"]');
  const sheet = ".replace-wrap .replace-copy";
  await page.click(`${sheet} [data-ui="replace.reason"]:has-text("Wrong language")`);
  await page.waitForSelector(`${sheet} [data-ui="replace.pick"]`);
  assert.match(urls[0], /reason=language/);
  const text = await page.locator(sheet).innerText();
  assert.match(text, /Versions in English first\. 2 in Russian left out\./);
  assert.match(text, /Tried here: cancelled/);
  assert.equal(await page.locator(`${sheet} .rc-lang`).first().innerText(), "English");
  await page.locator(`${sheet} [data-ui="replace.pick"]`).first().click();
  await page.waitForSelector(`${sheet} [data-ui="replace.cancel"]`);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].context.version, "the report knows the version");
  assert.ok(posts[0].context.ua);
  assert.ok(posts[0].context.viewport);

  // the first focus is Close, not Cancel: a stray Enter must not end it
  await page.waitForFunction(() => document.activeElement && document.activeElement.textContent === "Close");
});

ui.test("a title's page: your own download can be cancelled from it, asked first; someone else's cannot", async ({ page, goto, signIn, freshProfile }) => {
  const H = "f".repeat(40);
  const src = { infoHash: H, fileIdx: 0, filename: "Some.Film.2026.mkv", release: "Some.Film.2026.WEB-DL", provider: "test", quality: "1080p", qualityLabel: "1080p", tags: [], cam: false, prerelease: null, hardsub: false, badge: null, warning: null, dubbed: false, seeders: 40, sizeString: "2.0 GB", sizeBytes: 2e9, languages: [], pack: false, recommended: true };
  await page.route(`**/api/discover/meta/movie/${FILM}`, (route) =>
    route.fulfill({ json: { imdbId: FILM, type: "movie", title: "Some Film", year: 2026, synopsis: "A film.", genres: ["Drama"], cast: [], trailers: [] } }));
  await page.route(/\/api\/torrents\/sources\?/, (route) => route.fulfill({ json: { imdbId: FILM, streams: [src] } }));
  const cancels = await stubQueue(page, [job({ id: "888888888888", infoHash: H, progress: 0.3 })]);
  await signIn(await freshProfile());
  await goto(`#/discover/movie/${FILM}`);
  const btn = page.locator('[data-ui="detail.download.cancel"]');
  await btn.waitFor();
  await btn.click();
  const sheet = page.locator(ask);
  await sheet.waitFor();
  assert.match(await sheet.innerText(), /It's 30% down\./);
  await sheet.locator("button", { hasText: "Keep going" }).click();
  await sheet.waitFor({ state: "detached" });
  assert.equal(cancels.length, 0);
  // the row's Save button: the same question, for the same job
  await page.locator(".sources-section .src-save").first().click();
  await sheet.waitFor();
  await sheet.locator("button", { hasText: "Cancel the download" }).click();
  await page.locator('.toast:has-text("Cancelled")').first().waitFor();
  assert.equal(cancels.length, 1);
  assert.ok(cancels[0].url.endsWith("/api/downloads/888888888888/cancel"));
});

ui.run({ concurrency: 3 });

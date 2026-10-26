// "Has it really come out, and is there a good copy?" on a film's page (elia,
// 2026-10-26: "You immediately run to download it even if it's a CAM").
//
//   * only cinema recordings: the page says so plainly where "Save & watch"
//     was; the copies are still listed, last, each marked in words; pressing
//     one asks first, and nothing downloads until the person says yes
//   * good copies too: "Save & watch" as always — and it saves the ★ Best,
//     never the cinema recording, however well it is seeded
//   * burned-in subtitles: marked, below the clean copies
//
// The private instance has no network: the film's metadata and its sources
// are answered here, in the shapes the server sends (test/releasekind.test.js
// pins those), and every POST to the downloads API is caught — none is real.
// Desktop and phone, both looks.
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite();

const FILM = "tt7700001";
const H = (c) => String(c).repeat(40);
const CAM_LINE = "Not out in good quality yet — only cinema recordings so far";
const src = (c, o = {}) => ({
  infoHash: H(c), fileIdx: 0, filename: `Nowhere.Film.2026.${o.quality || "1080p"}.mkv`, release: `Nowhere.Film.2026.${o.rel || "WEB-DL"}`,
  provider: "test", quality: "1080p", qualityLabel: "1080p", tags: [], cam: false, prerelease: null, hardsub: false, badge: null, warning: null,
  dubbed: false, seeders: 40, sizeString: "2.0 GB", sizeBytes: 2e9, languages: ["EN"], pack: false, ...o,
});
const CAM = src("c", { rel: "HDCAM", cam: true, prerelease: "cam", badge: "CAM", warning: "CAM — filmed in a cinema", seeders: 2400 });
const TS = src("t", { rel: "HDTS", quality: "720p", cam: true, prerelease: "telesync", badge: "TS", warning: "TS — recorded in a cinema", seeders: 300 });

const stage = async (page, { streams, release = null }) => {
  const posted = [];
  await page.route(`**/api/discover/meta/movie/${FILM}`, (route) =>
    route.fulfill({ json: { imdbId: FILM, type: "movie", title: "Nowhere Film", year: 2026, synopsis: "A film still in cinemas.", genres: ["Drama"], cast: [], trailers: [] } }));
  await page.route(/\/api\/torrents\/sources\?/, (route) =>
    route.fulfill({ json: { imdbId: FILM, streams, ...(release ? { release } : {}) } }));
  await page.route(/\/api\/downloads(\?|$)/, (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fulfill({ json: [] });
    const body = req.postDataJSON();
    posted.push(body);
    return route.fulfill({ json: { job: { id: `job${posted.length}`, status: "approved", progress: 0, infoHash: body.infoHash, fileIdx: body.fileIdx, imdbId: body.imdbId, title: body.title, mine: true } } });
  });
  return posted;
};
const open = async ({ page, goto, signIn, freshProfile, api }, look) => {
  const me = await freshProfile();
  if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
  await signIn(me);
  await goto(`#/discover/movie/${FILM}`, { selector: "#app .screen .detail-title" });
  await page.locator(".sources-section .src-card").first().waitFor();
};

for (const [name, viewport, look] of [["desktop", DESKTOP, "glass"], ["desktop classic", DESKTOP, "legacy"], ["phone", PHONE, "glass"], ["phone classic", PHONE, "legacy"]]) {
  ui.test(`${name}: only cinema recordings — the page says so instead of Save & watch; a copy downloads only after a yes`, { viewport }, async (h) => {
    const { page } = h;
    const posted = await stage(page, {
      streams: [CAM, TS],
      release: { state: "early-only", line: CAM_LINE, note: "In cinemas since 3 Oct 2026" },
    });
    await open(h, look);
    // the hero: the sentence, and no big download button
    const hero = page.locator(".detail-actions .hero-release");
    await hero.waitFor();
    assert.equal(await hero.locator("b").innerText(), CAM_LINE);
    assert.equal(await hero.locator(".release-sub").innerText(), "In cinemas since 3 Oct 2026");
    assert.equal(await page.locator('[data-ui="detail.save"]').count(), 0, "no Save & watch for a cinema recording");
    assert.ok(await hero.isVisible());
    // the list says it too, and every copy is marked in words — no ★ Best
    assert.equal(await page.locator(".sources-section .release-note b").innerText(), CAM_LINE);
    const cards = page.locator(".sources-section .src-card");
    assert.equal(await cards.count(), 2, "still listed");
    assert.equal(await page.locator(".sources-section .src-badge.best").count(), 0);
    assert.deepEqual(await page.locator(".sources-section .src-badge.warn").allInnerTexts(), ["CAM", "TS"]);
    assert.deepEqual(await page.locator(".sources-section .src-warn").allInnerTexts(), ["CAM — filmed in a cinema", "TS — recorded in a cinema"]);
    assert.equal(await page.locator(".sources-section .src-card.early").count(), 2);
    // nothing on the page fits worse than the screen
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the page scrolls sideways");

    // Save on the CAM: asked first; "Cancel" saves nothing
    await cards.first().locator(".src-save").click();
    const sheet = page.locator(".look-notice.sheet");
    await sheet.waitFor();
    assert.equal(await sheet.locator(".look-notice-title").innerText(), "This is not the real release");
    assert.equal(await sheet.locator(".look-notice-text").innerText(),
      "CAM — filmed in a cinema. Picture and sound are usually poor — a good copy normally follows once the film is out to stream or buy.");
    assert.equal(await sheet.locator(".btn-primary").innerText(), "Download it anyway");
    await sheet.locator(".btn:not(.btn-primary)").click();
    await sheet.waitFor({ state: "detached" });
    await page.waitForTimeout(200);
    assert.deepEqual(posted, [], "nothing was downloaded");
    // Stream asks too (and Cancel plays nothing)
    await cards.nth(1).locator(".src-stream").click();
    await sheet.waitFor();
    assert.equal(await sheet.locator(".btn-primary").innerText(), "Play it anyway");
    await sheet.locator(".btn:not(.btn-primary)").click();
    await sheet.waitFor({ state: "detached" });
    assert.ok(!/#\/play/.test(await page.evaluate(() => location.hash)));
    // …and a yes downloads exactly that copy
    await cards.first().locator(".src-save").click();
    await sheet.waitFor();
    await sheet.locator(".btn-primary").click();
    for (let i = 0; i < 50 && !posted.length; i++) await page.waitForTimeout(50);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].infoHash, CAM.infoHash);
  });

  ui.test(`${name}: good copies too — Save & watch saves the ★ Best, never the cinema recording`, { viewport }, async (h) => {
    const { page } = h;
    const best = src("g", { recommended: true, seeders: 12 });
    const hard = src("k", { rel: "KORSUB.HDRip", hardsub: true, badge: "BURNED-IN SUBS", warning: "Subtitles burned into the picture", seeders: 800 });
    const posted = await stage(page, { streams: [best, hard, CAM], release: { state: "good", line: null, note: null } });
    await open(h, look);
    await page.locator('[data-ui="detail.save"]').waitFor();
    assert.equal(await page.locator(".hero-release").count(), 0);
    assert.equal(await page.locator(".sources-section .release-note").count(), 0, "nothing to say when there are good copies");
    // burned-in subtitles are marked; the clean copy is the Best
    assert.deepEqual(await page.locator(".sources-section .src-warn").allInnerTexts(), ["Subtitles burned into the picture", "CAM — filmed in a cinema"]);
    assert.equal(await page.locator(".sources-section .src-badge.best").count(), 1);
    await page.locator('[data-ui="detail.save"]').click();
    await page.waitForFunction(() => document.querySelector('[data-ui="detail.save"]')?.classList.contains("busy"));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].infoHash, best.infoHash, "the ★ Best — not the much better seeded cinema recording");
    assert.equal(await page.locator(".look-notice.sheet").count(), 0, "a good copy is not asked about");
  });
}

// An older server (no `release`, no `warning`): the page still never saves a
// cinema recording by itself — the first row is not a fallback any more.
ui.test("an older server's answer: no ★ Best, only a CAM — Save & watch saves nothing and says to pick one", async (h) => {
  const { page } = h;
  const old = { ...CAM, prerelease: undefined, badge: undefined, warning: undefined };
  const posted = await stage(page, { streams: [old] });
  await open(h, "glass");
  await page.locator('[data-ui="detail.save"]').click();
  await page.locator('.toast:has-text("pick one below")').first().waitFor();
  assert.deepEqual(posted, []);
  assert.deepEqual((await page.locator(".sources-section .src-badge.warn").allInnerTexts()).map((t) => t.toLowerCase()), ["cam"], "the old badge, from `cam` alone");
});

ui.run();

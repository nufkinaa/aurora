// The AI page keeps its last answer so that coming back to it costs nothing —
// for the profile that asked, and nobody else.
// The recommender itself needs the outside world; its answer is stubbed.
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite({
  setup: async (srv) => {
    srv.profiles.asker = await srv.api.createProfile("Asker", { open: true });
    srv.profiles.next = await srv.api.createProfile("Nextone", { open: true });
  },
});

const picksOf = (lib) => ({
  items: [
    { ...lib.film1, why: "Because the test asked for it." },
    { ...lib.film2, why: "And this one for good measure." },
  ],
  cached: false,
});
const switchTo = async (page, profile) => {
  await page.click("#nav-profile");
  await page.click('.nav-menu-item:has-text("Switch profile")');
  await page.click(`.profiles-gate .profile-tile[title="${profile.name}"]`);
  await page.waitForSelector(".profiles-gate", { state: "detached" });
  await page.waitForFunction((name) => document.getElementById("nav-profile-name").textContent === name, profile.name);
};
const ask = async (page, vibe) => {
  await page.fill(".pfm-input", vibe);
  await page.click(".pfm-ask button");
};

ui.test("the last answer is there when the same profile comes back, and gone for the next profile", async ({ page, goto, signIn, profiles, lib }) => {
  await page.route("**/api/ai/recommend", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(picksOf(lib)) }));
  await signIn(profiles.asker);
  await goto("#/pick");
  await ask(page, "something quiet for a test");
  await page.waitForSelector(".pfm-pick");
  assert.equal(await page.locator(".pfm-pick").count(), 2);

  // same profile, away and back: still there (the point of remembering it)
  await goto("#/movies");
  await goto("#/pick");
  assert.equal(await page.locator(".pfm-pick").count(), 2);
  assert.equal(await page.inputValue(".pfm-input"), "something quiet for a test");

  // the next person on this tab starts from an empty page
  await switchTo(page, profiles.next);
  await goto("#/pick");
  assert.equal(await page.locator(".pfm-pick").count(), 0, "the previous profile's picks are showing");
  assert.equal(await page.inputValue(".pfm-input"), "", "the previous profile's question is in the box");
  assert.doesNotMatch(await page.textContent("#app"), /something quiet for a test|Because the test asked/);

  // and going back to the first profile does not bring it back either (it was dropped, not hidden)
  await switchTo(page, profiles.asker);
  await goto("#/pick");
  assert.equal(await page.locator(".pfm-pick").count(), 0);
});

ui.test("an answer that lands after the profile was switched is not kept for the new profile", async ({ page, goto, signIn, profiles, lib }) => {
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/api/ai/recommend", async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(picksOf(lib)) });
  });
  await signIn(profiles.asker);
  await goto("#/pick");
  await ask(page, "slow answer for a test");
  await page.waitForSelector(".pfm-wait, .pfm-waiting, .pfm-stage, .skeleton", { state: "attached" }).catch(() => {});

  await switchTo(page, profiles.next);
  const answered = page.waitForResponse((r) => /\/api\/ai\/recommend$/.test(r.url()));
  release();
  await answered;
  await page.waitForTimeout(300);
  await goto("#/pick");
  assert.equal(await page.locator(".pfm-pick").count(), 0, "the answer to the previous profile's question is showing");
  assert.equal(await page.inputValue(".pfm-input"), "");
});

ui.run({ concurrency: 1 });

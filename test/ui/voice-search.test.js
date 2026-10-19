// Voice search on the website (public/js/voice.js), with a fake recogniser in
// the page standing in for the browser's (window.webkitSpeechRecognition): the
// mic is there only where a recogniser is, the words stand in the field as
// they are said, the final words run the same server search as typing
// (/api/search?voice=1 — the server tidies "search for the movie …"), the
// person's language is the one listened in and the switch changes it for them
// everywhere, and refusals and silences are said in words. Desktop and phone,
// both looks.
//
// VOICE_SHOTS=<folder> keeps a screenshot of each look/size while listening
// and after the answer (for a person to look at).
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { suite, PHONE, DESKTOP } = require("./helpers");

const ui = suite();
const BOX = '.screen input[type="search"]';
const MIC = "#app .search-box .search-mic";
const PANEL = "#app .voice-panel";
const SHOTS = process.env.VOICE_SHOTS || "";

// The fake: every recogniser the page makes is kept on window.__voice, and the
// test says what it "hears".
const FAKE = () => {
  const made = [];
  class FakeRecognition {
    constructor() {
      this.lang = "";
      this.interimResults = false;
      this.continuous = true;
      this.started = false;
      this.aborted = false;
      this.stopped = false;
      made.push(this);
    }
    start() {
      if (this.started) throw new Error("InvalidStateError");
      this.started = true;
      setTimeout(() => this.onstart && this.onstart(), 10);
    }
    stop() {
      this.stopped = true;
      setTimeout(() => this.onend && this.onend(), 10);
    }
    abort() {
      this.aborted = true;
    }
    // the test's side
    _results(list) {
      const results = list.map(([t, isFinal]) => Object.assign([{ transcript: t, confidence: 0.9 }], { isFinal }));
      this.onresult && this.onresult({ resultIndex: 0, results });
    }
    partial(t) { this._results([[t, false]]); }
    final(t) { this._results([[t, true]]); setTimeout(() => this.onend && this.onend(), 10); }
    fail(error) { this.onerror && this.onerror({ error }); setTimeout(() => this.onend && this.onend(), 10); }
    end() { this.onend && this.onend(); }
  }
  // (Chrome has both names; the page takes the unprefixed one first)
  window.webkitSpeechRecognition = FakeRecognition;
  window.SpeechRecognition = FakeRecognition;
  window.__voice = { made, get last() { return made[made.length - 1]; } };
};
const withFake = (page) => page.addInitScript(FAKE);
const last = (page) => page.evaluate(() => {
  const r = window.__voice.last;
  return r ? { lang: r.lang, interim: r.interimResults, continuous: r.continuous, started: r.started, aborted: r.aborted, stopped: r.stopped, count: window.__voice.made.length } : null;
});
const hear = (page, how, text) => page.evaluate(([how, text]) => window.__voice.last[how](text), [how, text]);
const listening = (page) => page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains("listening"), MIC);
const resultsAre = (page, want) =>
  page.waitForFunction((w) => JSON.stringify([...document.querySelectorAll("#app .screen > .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0])) === JSON.stringify(w), want);
const panelText = (page) => page.evaluate((sel) => {
  const p = document.querySelector(sel);
  return p && !p.classList.contains("hidden") ? p.querySelector(".voice-text").textContent : null;
}, PANEL);
const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

for (const viewport of [DESKTOP, PHONE]) {
  for (const look of ["glass", "legacy"]) {
    const where = `${viewport === PHONE ? "phone" : "desktop"}, ${look}`;
    ui.test(`(${where}) the mic: words as they are said, then the search — the sentence tidied by the server`, { viewport }, async ({ page, goto, signIn, freshProfile, api }) => {
      const me = await freshProfile();
      if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
      await withFake(page);
      await signIn(me);
      await goto("#/search");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.look || "legacy"), look);

      // the mic sits in the field, inside the box, and nothing is wider than the screen
      const mic = page.locator(MIC);
      await mic.waitFor();
      const [boxRect, micRect] = await Promise.all([page.locator("#app .search-box").boundingBox(), mic.boundingBox()]);
      assert.ok(micRect.x >= boxRect.x && micRect.x + micRect.width <= boxRect.x + boxRect.width + 1, "the mic is outside the field");
      assert.ok(micRect.width >= 36 && micRect.height >= 36, `the mic is too small to press: ${micRect.width}x${micRect.height}`);
      assert.equal(await mic.getAttribute("aria-label"), "Search by voice");
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      assert.ok(m.sw <= m.iw + 1, `the page overflows sideways: ${m.sw} > ${m.iw}`);

      await mic.click();
      await listening(page);
      const r = await last(page);
      assert.deepEqual({ lang: r.lang, interim: r.interim, continuous: r.continuous }, { lang: "en-US", interim: true, continuous: false });
      assert.equal(await mic.getAttribute("aria-pressed"), "true");
      await page.waitForFunction((sel) => /Listening in English… say a title/.test(document.querySelector(sel).textContent), PANEL);

      // the words, as they come, in the field
      await hear(page, "partial", "search for the");
      await page.waitForFunction((b) => document.querySelector(b).value === "search for the", BOX);
      await hear(page, "partial", "search for the movie test film");
      await page.waitForFunction((b) => document.querySelector(b).value === "search for the movie test film", BOX);
      assert.equal(await page.locator(BOX).evaluate((n) => n.classList.contains("voice-interim")), true);
      assert.equal(await panelText(page), "Listening in English", "while words are coming, they are the message; the line says the language");
      await shot(page, `listening-${viewport === PHONE ? "phone" : "desktop"}-${look}`);

      // the final words: the server's search, and its tidied words in the field
      const asked = page.waitForRequest((req) => /\/api\/search\?v=2&q=search%20for%20the%20movie%20test%20film%20one&commit=1&voice=1/.test(req.url()));
      await hear(page, "final", "search for the movie test film one");
      await asked;
      await resultsAre(page, ["Test Film One"]);
      await page.waitForFunction((b) => document.querySelector(b).value === "test film one", BOX);
      assert.equal(await mic.evaluate((n) => n.classList.contains("listening")), false);
      assert.equal(await page.locator(PANEL).evaluate((n) => n.classList.contains("hidden")), true);
      assert.equal(await page.locator(BOX).evaluate((n) => n.classList.contains("voice-interim")), false);
      // remembered as a recent search, as the server searched it
      await page.waitForFunction(async (id) => {
        const r = await fetch(`/api/profiles/${id}/searches`).then((x) => x.json()).catch(() => null);
        return r && r.items && r.items[0] === "test film one";
      }, me.id);
      await shot(page, `answered-${viewport === PHONE ? "phone" : "desktop"}-${look}`);
    });
  }
}

ui.test("no recogniser in this browser: no mic at all", async ({ page, goto, signIn, freshProfile }) => {
  await page.addInitScript(() => { delete window.webkitSpeechRecognition; delete window.SpeechRecognition; });
  await signIn(await freshProfile());
  await goto("#/search");
  await page.locator(BOX).waitFor();
  assert.equal(await page.locator(MIC).count(), 0);
  assert.equal(await page.locator(PANEL).count(), 0);
});

ui.test("a season and an episode find the show; numbers said as words are digits", async ({ page, goto, signIn, freshProfile }) => {
  await withFake(page);
  await signIn(await freshProfile());
  await goto("#/search");
  await page.click(MIC);
  await listening(page);
  await hear(page, "final", "play test show season one episode two");
  await resultsAre(page, ["Test Show"]);
  assert.equal(await page.inputValue(BOX), "test show");
  await page.click(MIC);
  await listening(page);
  await hear(page, "final", "test film two");
  await resultsAre(page, ["Test Film Two"]);
});

ui.test("the language: the person's, else the browser's; the switch changes it for them everywhere", async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await page.addInitScript(() => Object.defineProperty(navigator, "language", { get: () => "he-IL" }));
  await withFake(page);
  await signIn(me);
  await goto("#/search");
  await page.click(MIC);
  await listening(page);
  assert.equal((await last(page)).lang, "he-IL", "no choice on the profile: the browser's language");
  await page.waitForFunction((sel) => /Listening in Hebrew/.test(document.querySelector(sel).textContent), PANEL);
  // the switch names the other language in its own script
  const sw = page.locator(`${PANEL} .voice-lang`);
  assert.equal((await sw.textContent()).trim(), "English");
  await sw.click();
  await page.waitForFunction(() => window.__voice.made.length === 2 && window.__voice.made[1].started);
  const first = await page.evaluate(() => window.__voice.made[0].aborted);
  assert.equal(first, true, "the Hebrew recogniser was let go");
  assert.equal((await last(page)).lang, "en-US");
  await page.waitForFunction((sel) => /Listening in English/.test(document.querySelector(sel).textContent), PANEL);
  assert.equal((await sw.textContent()).trim(), "עברית");
  // on the profile, for every device
  await page.waitForFunction(async (id) => {
    const list = await fetch("/api/profiles").then((r) => r.json());
    const p = list.find((x) => x.id === id);
    return p && p.prefs && p.prefs.voiceLang === "en";
  }, me.id);
  // Escape with the focus on the switch: stops listening, and is not the app's Back
  await sw.focus();
  await page.keyboard.press("Escape");
  await page.waitForFunction((sel) => !document.querySelector(sel).classList.contains("listening"), MIC);
  await page.waitForTimeout(300);
  assert.match(page.url(), /#\/search$/);
  // a profile that chose Hebrew elsewhere is listened to in Hebrew, whatever the browser says
  // (set on another device: the server tells this page, which reads the profile again)
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { voiceLang: "he" } }, await api.as(me));
  let lang = null;
  for (let i = 0; i < 20 && lang !== "he-IL"; i++) {
    await page.waitForTimeout(250);
    await page.click(MIC);
    await listening(page);
    lang = (await last(page)).lang;
    await page.locator(BOX).press("Escape");
    await page.waitForFunction((sel) => !document.querySelector(sel).classList.contains("listening"), MIC);
  }
  assert.equal(lang, "he-IL");
});

ui.test("refused, blocked, silence: said in words; Escape stops listening and puts the field back", async ({ page, goto, signIn, freshProfile }) => {
  await withFake(page);
  await signIn(await freshProfile());
  await goto("#/search");
  await page.locator(BOX).fill("dune");
  await page.click(MIC);
  await listening(page);
  await hear(page, "fail", "not-allowed");
  await page.waitForFunction((sel) => {
    const p = document.querySelector(sel);
    return !p.classList.contains("hidden") && p.classList.contains("voice-error");
  }, PANEL);
  assert.match(await panelText(page), /isn't allowed to use the microphone|blocked for this site/);
  assert.equal(await page.locator(MIC).evaluate((n) => n.classList.contains("listening")), false);

  await page.click(MIC);
  await listening(page);
  await hear(page, "fail", "no-speech");
  await page.waitForFunction((sel) => /Didn't hear anything/.test(document.querySelector(sel).textContent), PANEL);

  // words, then the recogniser gives up: the words stand and are searched
  await page.click(MIC);
  await listening(page);
  await hear(page, "partial", "test show");
  await hear(page, "fail", "no-speech");
  await resultsAre(page, ["Test Show"]);

  // Escape while listening: back to what was typed, nothing searched
  await page.locator(BOX).fill("dune");
  await page.click(MIC);
  await listening(page);
  await hear(page, "partial", "something else");
  await page.locator(BOX).press("Escape");
  await page.waitForFunction((sel) => !document.querySelector(sel).classList.contains("listening"), MIC);
  assert.equal(await page.inputValue(BOX), "dune");
  assert.equal((await last(page)).aborted, true);
  assert.equal(await page.locator(PANEL).evaluate((n) => n.classList.contains("hidden")), true);

  // the mic pressed again while listening: what was heard is the answer
  await page.click(MIC);
  await listening(page);
  await hear(page, "partial", "test film one");
  await page.click(MIC);
  await resultsAre(page, ["Test Film One"]);

  // typing takes over from the microphone
  await page.click(MIC);
  await listening(page);
  await page.locator(BOX).pressSequentially("x");
  await page.waitForFunction((sel) => !document.querySelector(sel).classList.contains("listening"), MIC);
});

ui.test("leaving Search while listening lets the microphone go", async ({ page, goto, signIn, freshProfile }) => {
  await withFake(page);
  await signIn(await freshProfile());
  await goto("#/search");
  await page.click(MIC);
  await listening(page);
  await goto("#/movies");
  await page.waitForFunction(() => window.__voice.last.aborted === true);
});

ui.run({ concurrency: 2 });

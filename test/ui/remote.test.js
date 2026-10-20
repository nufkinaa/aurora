// The phone as a remote, and Play on TV (screens/remote.js, js/remote.js,
// src/lib/devices.js) — the real phone UI in real Chrome (phone viewport,
// touch), against a simulated TV (test/ui/support/sim-tv.js: the TV app's
// side of the protocol, in node, over a real socket). And the website as the
// device being controlled ("Play on this computer"), from a second page.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite } = require("./helpers");
const { SimTV } = require("./support/sim-tv");

const ui = suite();
const PHONE = { width: 390, height: 844 };
const PHONE_LANDSCAPE = { width: 844, height: 390 };
const DESKTOP = { width: 1280, height: 720 };
const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "phone-remote");
const shot = async (page, name) => {
  if (process.env.REMOTE_SHOTS !== "1") return; // opt-in: a test run must not rewrite tracked files
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(650); // (sheets and the art fade in)
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
};
const setLook = (api, profile, look) => api.call("PUT", `/api/profiles/${profile.id}`, { look });
const until = async (what, fn, ms = 10000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 60));
  }
};
const lastCmd = (tv, cmd) => [...tv.log].reverse().find((l) => l.cmd === cmd) || null;
const goto = async (page, srv, hash, selector) => {
  if (!page.url().startsWith(srv.url)) await page.goto(`${srv.url}/${hash}`, { waitUntil: "domcontentloaded" });
  else await page.evaluate((h) => { location.hash = h; }, hash);
  if (selector) await page.waitForSelector(selector, { timeout: 20000 });
};
// a real touch swipe (CDP touch events: what a finger sends), and a tap
const swipe = async (page, sel, dx, dy) => {
  const box = await page.locator(sel).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
};
const tapAt = async (page, sel) => {
  const box = await page.locator(sel).boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 3);
};

for (const look of ["glass", "legacy"]) {
  ui.test(`phone (${look}): Play on TV from a title page, then the whole remote — pause, ±10/±30, scrub, subtitles and their timing, audio, touchpad swipes and taps, D-pad buttons, Back, volume, mute, Stop, Continue watching`, { viewport: PHONE }, async ({ page, srv, api, lib, signIn, freshProfile }) => {
    const profile = await freshProfile();
    if (look === "legacy") await setLook(api, profile, "legacy");
    await api.setProgress(profile, lib.film1.id, 20, 60);
    const tv = new SimTV({ url: srv.url, profile, name: "Living room TV" });
    await tv.start();
    try {
      await signIn(profile);
      await goto(page, srv, `#/movie/${lib.film2.id}`, ".rm-playon:not([hidden])");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.look || "legacy"), look);
      assert.match(await page.locator(".rm-playon").innerText(), /Play on Living room TV/);
      await shot(page, `phone-${look}-title-page`);
      // the nav's Remote button is there while a TV is on
      assert.equal(await page.locator("#nav-remote").isVisible(), true);

      await page.locator(".rm-playon").click();
      await until("the TV to be told", () => lastCmd(tv, "play_item"));
      const play = lastCmd(tv, "play_item");
      assert.equal(play.args.item.id, lib.film2.id);
      assert.equal(play.first, true);
      assert.match(tv.toasts[0], new RegExp(`^Controlled from ${profile.name}'s phone$`));
      await page.waitForSelector('.remote-screen[data-state="playing"]');
      assert.match(page.url(), new RegExp(`#/remote/${tv.deviceId}$`));
      assert.equal(await page.locator(".rm-playing .rm-title").innerText(), "Test Film Two");
      assert.match(await page.locator(".rm-eyebrow").innerText(), /playing on living room tv/i);
      assert.match(await page.locator(".rm-pick-name").innerText(), /Living room TV/);
      await until("a tick a second while watched", () => tv.watched);
      await shot(page, `phone-${look}-now-playing`);

      // pause / play
      await page.locator(".rm-play").click();
      await until("the TV to pause", () => tv.now && tv.now.paused);
      await until("the button to say Play", async () => (await page.locator(".rm-play").getAttribute("aria-label")) === "Play");
      await page.locator(".rm-play").click();
      await until("the TV to play again", () => tv.now && !tv.now.paused);

      // ±30 / ±10
      const before = tv.position();
      await page.getByRole("button", { name: "Forward 30 seconds" }).click();
      await until("+30 to land", () => lastCmd(tv, "skip") && lastCmd(tv, "skip").args.by === 30);
      assert.ok(Math.abs(tv.position() - Math.min(tv.now.item.duration, before + 30)) < 3, `+30 from ${before}: ${tv.position()}`);
      await page.getByRole("button", { name: "Back 10 seconds" }).click();
      await until("-10", () => lastCmd(tv, "skip") && lastCmd(tv, "skip").args.by === -10);

      // scrub: the thumb let go at a third of the film is one seek there
      await page.locator(".rm-scrub-input").evaluate((n) => {
        n.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        n.value = "333";
        n.dispatchEvent(new Event("input", { bubbles: true }));
        n.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await until("the seek", () => lastCmd(tv, "seek"));
      const dur = tv.now.item.duration;
      assert.ok(Math.abs(lastCmd(tv, "seek").args.to - dur * 0.333) < 1, `seek to ${lastCmd(tv, "seek").args.to} of ${dur}`);
      assert.equal(tv.log.filter((l) => l.cmd === "seek").length, 1, "one seek for one scrub");
      // the time on the phone follows
      await until("the phone's clock near the seek", async () => {
        const t = await page.locator(".rm-times .rm-time").first().innerText();
        const [m, s] = t.split(":").map(Number);
        return Math.abs(m * 60 + s - dur * 0.333) < 4;
      });

      // subtitles: a track, then its timing
      await page.getByRole("button", { name: "Subtitles", exact: true }).click();
      await page.waitForSelector(".rm-sheet-wrap.on .rm-sheet-row");
      await shot(page, `phone-${look}-subtitles-sheet`);
      const subs = tv.state().now.subs;
      assert.ok(subs.length >= 1, "the film has subtitle tracks");
      await page.locator(".rm-sheet-wrap.on .rm-sheet-row", { hasText: subs[0].label }).first().click();
      await until("the TV's subtitles on", () => tv.now.sub === subs[0].id);
      await until("the chip lit", async () => (await page.locator(".rm-chip.on", { hasText: "Subtitles" }).count()) === 1);
      await page.getByRole("button", { name: "Subtitles", exact: true }).click();
      await page.getByRole("button", { name: "Subtitles later" }).click();
      await until("the delay on the TV", () => tv.now.subDelay === 0.5);
      await page.keyboard.press("Escape");
      await page.waitForSelector(".rm-sheet-wrap", { state: "detached" });

      // audio: Film Two carries two dubs
      const audios = tv.state().now.audios;
      assert.equal(audios.length, 2);
      await page.getByRole("button", { name: "Audio", exact: true }).click();
      await page.locator(".rm-sheet-wrap.on .rm-sheet-row", { hasText: audios[1].label }).first().click();
      await until("the TV's dub", () => tv.now.audio === audios[1].id);

      // the pad: a swipe is an arrow, a tap is OK — a real finger
      await page.getByRole("tab", { name: "Touchpad" }).click();
      await page.waitForSelector(".rm-touch", { state: "visible" });
      await shot(page, `phone-${look}-touchpad`);
      tv.keys.length = 0;
      await swipe(page, ".rm-touch", 160, 0);
      await until("right", () => tv.keys.includes("right"));
      await swipe(page, ".rm-touch", 0, -60);
      await until("up", () => tv.keys.includes("up"));
      await tapAt(page, ".rm-touch");
      await until("ok", () => tv.keys.includes("ok"));
      // a long swipe keeps stepping
      const n0 = tv.keys.length;
      await swipe(page, ".rm-touch", 0, 300);
      await until("several downs", () => tv.keys.slice(n0).filter((k) => k === "down").length >= 2);
      // the buttons
      await page.getByRole("tab", { name: "Buttons" }).click();
      await shot(page, `phone-${look}-dpad-buttons`);
      tv.keys.length = 0;
      for (const name of ["Left", "Down", "OK", "Back"]) await page.getByRole("button", { name, exact: true }).click();
      await until("the four keys", () => tv.keys.length === 4);
      assert.deepEqual(tv.keys, ["left", "down", "ok", "back"]);
      await page.getByRole("tab", { name: "Swipe" }).click(); // (remembered on this device)

      // volume and mute (the TV's own)
      await page.getByRole("button", { name: "Volume up" }).click();
      await until("louder", () => Math.abs(tv.volume.level - 0.6) < 0.01);
      await page.getByRole("button", { name: "Mute", exact: true }).click();
      await until("muted", () => tv.volume.muted === true);
      await until("the button says Unmute", async () => (await page.getByRole("button", { name: "Unmute", exact: true }).count()) === 1);
      await page.getByRole("button", { name: "Unmute", exact: true }).click();
      await until("unmuted", () => tv.volume.muted === false);

      // Stop: nothing playing — the profile's Continue Watching, played there with a tap
      await page.getByRole("tab", { name: "Now playing" }).click();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await until("the TV back home", () => tv.now === null);
      await page.waitForSelector('.remote-screen[data-state="idle"] .rm-cw-card');
      assert.match(await page.locator(".rm-idle .rm-title").innerText(), /Nothing playing on Living room TV/);
      await shot(page, `phone-${look}-nothing-playing`);
      tv.log.length = 0;
      await page.locator(".rm-cw-card").first().click();
      await until("Continue watching played on the TV", () => lastCmd(tv, "play_item"));
      assert.equal(lastCmd(tv, "play_item").args.item.id, lib.film1.id);
      assert.ok(Math.abs(lastCmd(tv, "play_item").args.position - 20) < 0.5, "from where it was left");
      await page.waitForSelector('.remote-screen[data-state="playing"]');

      // nothing ran into anything: every command was answered ok
      const errs = await page.locator("#toasts .toast").allInnerTexts();
      assert.ok(!errs.some((t) => /didn't|couldn't|Nothing is playing/i.test(t)), errs.join(" | "));
      // and the page is no wider than the phone
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      assert.ok(m.sw <= m.iw + 1);
      // leaving: the TV is told nobody watches any more
      await page.getByRole("button", { name: "Close the remote" }).click();
      await until("not watched", () => !tv.watched);
    } finally {
      await tv.stop();
    }
  });
}

ui.test("phone: an episode plays on the TV from the show's page, Next episode moves the TV on; a landscape phone shows both halves", { viewport: PHONE }, async ({ page, srv, lib, signIn, freshProfile }) => {
  const profile = await freshProfile();
  const tv = new SimTV({ url: srv.url, profile, name: "Bedroom TV" });
  await tv.start();
  try {
    await signIn(profile);
    await goto(page, srv, `#/show/${lib.show.id}`, ".episode-wrap .rm-playon:not([hidden])");
    const epBtn = page.locator(".episode-wrap .rm-playon").first();
    assert.match(await epBtn.getAttribute("aria-label"), /Play on Bedroom TV — episode 1/);
    await epBtn.click();
    await until("episode 1 on the TV", () => lastCmd(tv, "play_item"));
    const p = lastCmd(tv, "play_item").args.item;
    assert.equal(p.id, lib.e1.id);
    assert.equal(p.season, 1);
    assert.equal(p.episode, 1);
    await page.waitForSelector('.remote-screen[data-state="playing"]');
    assert.equal(await page.locator(".rm-playing .rm-title").innerText(), "Test Show");
    assert.match(await page.locator(".rm-playing .rm-subtitle").innerText(), /^S1 E1/);
    await until("Next episode offered", async () => page.getByRole("button", { name: "Next episode", exact: true }).isVisible());
    await page.getByRole("button", { name: "Next episode", exact: true }).click();
    await until("the TV on episode 2", () => tv.now && tv.now.item.id === lib.e2.id);
    await until("the phone says so", async () => /^S1 E2/.test(await page.locator(".rm-playing .rm-subtitle").innerText()));
    await shot(page, "phone-glass-episode");
    await page.setViewportSize(PHONE_LANDSCAPE);
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".rm-touch").isVisible(), true, "landscape: the pad beside the transport");
    assert.equal(await page.locator(".rm-play").isVisible(), true);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    assert.ok(m.sw <= m.iw + 1);
    await shot(page, "phone-landscape");
  } finally {
    await tv.stop();
  }
});

// An episode on disk has three buttons on the phone's glass card — Download to
// this device, Play on TV, Watched. Each must be its own target: they once sat
// on two slots, so the download hid under the Watched tick (elia, 2026-10-20).
ui.test("phone (glass): an episode on disk keeps Download, Play on TV and Watched apart and each one tappable — with a TV on and with none", { viewport: PHONE }, async ({ page, srv, lib, signIn, freshProfile }) => {
  const profile = await freshProfile();
  const tv = new SimTV({ url: srv.url, profile, name: "Bedroom TV" });
  await tv.start();
  const check = async (when, playOn) => {
    await page.evaluate(() => document.querySelector(".episode-wrap").scrollIntoView({ block: "center", inline: "nearest" }));
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const wrap = document.querySelector(".episode-wrap");
      const btns = [...wrap.querySelectorAll(":scope > .ep-action")].filter((b) => getComputedStyle(b).display !== "none" && b.getBoundingClientRect().width > 0); // what is drawn, hidden or not
      const boxes = btns.map((b) => { const r = b.getBoundingClientRect(); return { ui: b.dataset.ui || b.className, l: r.left, r: r.right, t: r.top, b: r.bottom }; });
      const hits = btns.map((b) => { const r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && (at === b || b.contains(at)); });
      const facts = wrap.querySelector(".episode-sub");
      const factsRight = facts ? Math.max(...[...facts.children].filter((c) => !c.classList.contains("ep-overview")).map((c) => c.getBoundingClientRect().right)) : 0;
      return { boxes, hits, factsRight };
    });
    // (on a phone that button saves the episode offline inside Aurora — offline.test.js)
    assert.ok(r.boxes.some((b) => /download|offline/.test(b.ui)), `${when}: the Download / Save offline button is there`);
    for (const b of r.boxes) assert.ok(b.r - b.l >= 40 && b.b - b.t >= 40, `${when}: ${b.ui} is at least 40 px to the finger (${Math.round(b.r - b.l)}×${Math.round(b.b - b.t)})`);
    assert.equal(r.boxes.some((b) => /playontv/.test(b.ui)), playOn, `${when}: Play on TV ${playOn ? "shown" : "hidden"}`);
    for (let i = 0; i < r.boxes.length; i++) {
      assert.ok(r.hits[i], `${when}: ${r.boxes[i].ui} is covered by something else`);
      for (let j = i + 1; j < r.boxes.length; j++) {
        const a = r.boxes[i], b = r.boxes[j];
        const overlap = Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
        assert.ok(!overlap, `${when}: ${a.ui} and ${b.ui} overlap`);
      }
    }
    const leftmost = Math.min(...r.boxes.map((b) => b.l));
    assert.ok(r.factsRight <= leftmost + 1, `${when}: the episode's facts end before the buttons (${r.factsRight} > ${leftmost})`);
  };
  try {
    await signIn(profile);
    await goto(page, srv, `#/show/${lib.show.id}`, ".episode-wrap .rm-playon:not([hidden])");
    await check("with a TV on", true);
    await shot(page, "phone-glass-episode-buttons");
    await tv.stop();
    await page.waitForSelector(".episode-wrap .rm-playon[hidden]", { state: "attached", timeout: 10000 });
    await check("with no TV", false);
    // and a page that never saw a TV (the remote's stylesheet never loaded)
    await page.reload();
    await page.waitForSelector(".episode-wrap", { timeout: 30000 });
    await page.waitForTimeout(1200);
    await check("no TV since the page opened", false);
  } finally {
    await tv.stop().catch(() => {});
  }
});

ui.test("scoping: another profile's TV is not offered (no button, no Remote); with no TV the remote says how to get one; a TV that does not answer is said so", { viewport: PHONE, allow: [] }, async ({ page, srv, lib, signIn, freshProfile }) => {
  const mine = await freshProfile();
  const other = await freshProfile();
  const otherTv = new SimTV({ url: srv.url, profile: other, name: "Dana's TV" });
  await otherTv.start();
  let silent = null;
  try {
    await signIn(mine);
    await goto(page, srv, `#/movie/${lib.film1.id}`, ".detail-actions, .hero-actions, .btn-primary");
    await page.waitForTimeout(1200); // the device list has come by now
    assert.equal(await page.locator(".rm-playon:not([hidden])").count(), 0, "no Play on TV for someone else's TV");
    assert.equal(await page.locator("#nav-remote:not([hidden])").count(), 0);
    await goto(page, srv, "#/remote", ".remote-screen");
    await page.waitForSelector('.remote-screen[data-state="empty"]');
    assert.match(await page.locator(".rm-empty").innerText(), /No TV is on[\s\S]*signed in as/);
    await shot(page, "phone-glass-no-tv");
    // a TV of mine that never answers: the phone is told, not left hanging
    silent = new SimTV({ url: srv.url, profile: mine, name: "Quiet TV", silent: true });
    await silent.start();
    await page.waitForSelector('.remote-screen[data-state="idle"]');
    await page.getByRole("tab", { name: "Touchpad" }).click();
    await page.getByRole("tab", { name: "Buttons" }).click();
    await page.getByRole("button", { name: "OK", exact: true }).click();
    await page.waitForSelector("#toasts .toast:has-text(\"didn't answer\")", { timeout: 12000 });
    // and it goes away: the remote says so
    await silent.stop();
    await page.waitForSelector('.remote-screen[data-state="empty"]');
  } finally {
    await otherTv.stop();
    if (silent) await silent.stop();
  }
});

ui.test("Play on this computer: a phone starts a film on a desktop browser of the same profile, pauses it, moves its focus, and Stop leaves the player", { viewport: PHONE }, async ({ page, srv, api, lib, signIn, freshProfile }) => {
  const profile = await freshProfile();
  await api.setProgress(profile, lib.film1.id, 20, 60);
  // the computer: its own browser context, the same profile
  const desk = await ui.browser.newContext({ viewport: DESKTOP, serviceWorkers: "block" });
  await desk.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (r) => r.fulfill({ status: 404, body: "" }).catch(() => {}));
  const dp = await desk.newPage();
  const deskErrors = [];
  dp.on("pageerror", (e) => deskErrors.push(String(e && e.message)));
  try {
    await dp.addInitScript(({ id }) => {
      try {
        if (sessionStorage.getItem("seed")) return;
        sessionStorage.setItem("seed", "1");
        localStorage.setItem("aurora-profile", id);
        localStorage.setItem("aurora-kbd-hint", "1");
        localStorage.setItem("aurora-nav-hinted", "1");
        localStorage.setItem("aurora-device-name", "Office PC");
      } catch {}
    }, { id: profile.id });
    await dp.goto(`${srv.url}/#/`, { waitUntil: "domcontentloaded" });
    await dp.waitForSelector("#app .screen");
    // the phone
    await signIn(profile);
    await goto(page, srv, "#/remote", '.remote-screen[data-state="idle"]');
    assert.match(await page.locator(".rm-pick-name").innerText(), /Office PC/);
    await shot(page, "phone-glass-computer-picked");
    // play Film One there, from where it was left (Continue watching on the remote)
    await page.waitForSelector(".rm-cw-card");
    await page.locator(".rm-cw-card").first().click();
    await dp.waitForFunction((id) => location.hash.startsWith(`#/play/${id}`), lib.film1.id);
    await dp.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime >= 19; }, null, { timeout: 20000 });
    await dp.waitForSelector("#toasts .toast:has-text(\"Controlled from\")");
    assert.match(await dp.locator("#toasts").innerText(), new RegExp(`Controlled from ${profile.name}'s phone`));
    await page.waitForSelector('.remote-screen[data-state="playing"]');
    assert.equal(await page.locator(".rm-playing .rm-title").innerText(), "Test Film One");
    await page.locator(".rm-play").click();
    await dp.waitForFunction(() => document.querySelector(".player video").paused);
    // the volume is this player's own, and it moves
    await page.getByRole("button", { name: "Volume down" }).click();
    await dp.waitForFunction(() => document.querySelector(".player video").volume < 0.95);
    await shot(page, "phone-glass-controlling-computer");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await dp.waitForFunction(() => !location.hash.startsWith("#/play/"));
    await page.waitForSelector('.remote-screen[data-state="idle"]');
    // arrows move the computer's focus the way its keyboard would
    await dp.waitForSelector("#app .screen");
    await dp.waitForTimeout(500);
    const focus0 = await dp.evaluate(() => document.activeElement && document.activeElement.outerHTML.slice(0, 80));
    await page.getByRole("tab", { name: "Touchpad" }).click();
    await swipe(page, ".rm-touch", 0, 120);
    await dp.waitForFunction((f) => document.activeElement && document.activeElement.outerHTML.slice(0, 80) !== f, focus0, { timeout: 5000 });
    assert.deepEqual(deskErrors, []);
  } finally {
    await desk.close().catch(() => {});
  }
});

ui.test("desktop: the remote side by side; the web player hands its film to the TV at the same second (Play on TV in the player)", { viewport: DESKTOP }, async ({ page, srv, lib, signIn, freshProfile }) => {
  const profile = await freshProfile();
  const tv = new SimTV({ url: srv.url, profile, name: "Living room TV" });
  await tv.start();
  try {
    await signIn(profile);
    await goto(page, srv, `#/play/${lib.film1.id}`, ".player video");
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 2; }, null, { timeout: 20000 });
    await page.mouse.move(640, 400);
    const tvBtn = page.locator(".player .tv-btn");
    await until("the Play on TV button in the player", async () => !(await tvBtn.evaluate((n) => n.classList.contains("hidden"))));
    await tvBtn.click();
    await until("handed over", () => lastCmd(tv, "play_item"));
    const at = lastCmd(tv, "play_item").args.position;
    assert.equal(lastCmd(tv, "play_item").args.item.id, lib.film1.id);
    assert.ok(at > 2, `at the same second (${at})`);
    await page.waitForSelector('.remote-screen[data-state="playing"]');
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".rm-touch").isVisible(), true, "desktop shows the pad beside");
    await shot(page, "desktop-glass-remote");
  } finally {
    await tv.stop();
  }
});

ui.test("Continue Watching on Home: the peek sheet of a card offers Play on <TV>, from where it was left", { viewport: DESKTOP }, async ({ page, srv, api, lib, signIn, freshProfile }) => {
  const profile = await freshProfile();
  await api.setProgress(profile, lib.e1.id, 30, 45);
  const tv = new SimTV({ url: srv.url, profile, name: "Living room TV" });
  await tv.start();
  try {
    await signIn(profile);
    await goto(page, srv, "#/", "#app .screen .card");
    const card = page.locator(".card", { hasText: "S1 E1" }).first();
    await card.waitFor();
    await card.click({ button: "right" });
    const btn = page.locator(".peek .rm-playon:not([hidden])");
    await btn.waitFor({ timeout: 10000 });
    assert.match(await btn.innerText(), /Play on Living room TV/);
    await shot(page, "desktop-glass-peek-play-on-tv");
    await btn.click();
    await until("the episode on the TV", () => lastCmd(tv, "play_item"));
    const a = lastCmd(tv, "play_item").args;
    assert.equal(a.item.id, lib.e1.id);
    assert.ok(Math.abs(a.position - 26) < 0.5, `four seconds before where it was left: ${a.position}`);
    await page.waitForSelector('.remote-screen[data-state="playing"]');
    await page.waitForSelector(".peek", { state: "detached", timeout: 5000 }); // the sheet closed
  } finally {
    await tv.stop();
  }
});

ui.run({ concurrency: 1 });

// Watch parties in real browsers: three people (two desktops and a phone)
// watching one film, measured against the SERVER's clock (how far each
// one's picture is from where the party's film is at that instant).
//
// The rule (elia, 2026-10-27): "sync once on join, then send each action
// (stop / play / skip); fix alignment only when someone stops, or once every
// 20 minutes" — and the film's speed is never touched. So this checks:
// joining lands on the party; three minutes of ordinary watching with no
// seeks and no speed changes at all; each play / pause / jump followed
// within about a second, a pause on the same frame; a member whose film
// stalls is waited for and everyone starts again together; a dropped
// connection comes back by itself; a host who leaves hands the party over.
//
// The film is a half-hour copy of the test film (looped, no metadata, so it
// is also the "own file" case): long enough that a jump far ahead has to be
// fetched, which is how the stall is made — one guest's video requests are
// held for a few seconds.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { suite, player, signIn: signInAs, goto: gotoOn, PHONE, DESKTOP } = require("./helpers");

const NORMAL_PLAY_S = Number(process.env.PARTY_NORMAL_S || 180);

const ui = suite({
  setup: async (srv) => {
    const src = path.join(srv.library.movies, "Test Film One (2020)", "Test Film One (2020).mp4");
    const dir = path.join(srv.library.movies, "My Own Film (2026)");
    fs.mkdirSync(dir, { recursive: true });
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-nostdin", "-v", "error", "-y", "-stream_loop", "29", "-i", src, "-c", "copy", path.join(dir, "My Own Film (2026).mp4")], { stdio: ["ignore", "ignore", "pipe"], timeout: 60000 });
    await srv.api.rescan();
    for (let i = 0; i < 120; i++) {
      const lib = await srv.api.library();
      const f = lib.movies.find((m) => m.title === "My Own Film");
      if (f && f.duration > 1000) { srv.lib.long = f; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(srv.lib.long, "the long film is in the library");
  },
});

// One sample of a page: its picture's time, and where the party's film is
// at the same instant by the server's clock (the app's own modules).
const sample = (page) => page.evaluate(async () => {
  const m = await import("/js/party.js");
  const s = await import("/js/partySync.js");
  const v = document.querySelector(".player video");
  const st = m.party.current && m.party.current.state;
  const now = m.serverNow();
  return {
    t: v ? v.currentTime : null,
    target: st ? s.targetOf(st, now) : null,
    moving: !!(st && st.playing && s.startsIn(st, now) === 0),
    paused: v ? v.paused : null,
    rate: v ? v.playbackRate : null,
    wall: performance.timeOrigin + performance.now(),
  };
});
const pct = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN; };
const ms = (x) => (x == null ? "?" : `${Math.round(x * 1000)} ms`);
const note = (...a) => console.log("  [party]", ...a);
// Seeks and speed changes on a page's video, counted from now.
const countMoves = (page) => page.evaluate(() => {
  const v = document.querySelector(".player video");
  window.__partyMoves = { seeks: 0, rates: 0 };
  if (!window.__partyMovesArmed) {
    window.__partyMovesArmed = true;
    v.addEventListener("seeking", () => window.__partyMoves.seeks++);
    v.addEventListener("ratechange", () => window.__partyMoves.rates++);
  }
});
const movesOf = (page) => page.evaluate(() => window.__partyMoves);

ui.test("three people watch together: land on join, calm while watching, every action followed, a stall waited for, a dropped line and a host who hands over", { timeout: 540000 }, async ({ page, srv, context, signIn, freshProfile }) => {
  const film = srv.lib.long;
  const [host, guestA, guestB] = [await freshProfile(), await freshProfile(), await freshProfile()];
  await signIn(host);
  await player.open(page, srv, film.id);
  await player.advancing(page);
  await player.press(page, "Watch together");
  await page.click('.player [data-ui="player.party.start"]');
  await page.waitForSelector(".player .party-code");
  const code = (await page.textContent(".player .party-code")).replace(/\s/g, "");
  assert.match(code, /^[A-Z0-9]{4}$/);
  assert.ok(await page.locator('.player [data-ui="player.party.share"]').isVisible(), "the invite can be shared");

  const browser = context.browser();
  const ctxA = await browser.newContext({ viewport: DESKTOP, serviceWorkers: "block" });
  const ctxB = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  // (the phone's sockets, so the test can drop its connection)
  await ctxB.addInitScript(() => {
    const W = window.WebSocket;
    window.__partySockets = [];
    window.WebSocket = function (...a) { const w = new W(...a); window.__partySockets.push(w); return w; };
    window.WebSocket.prototype = W.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });
  const errors = [];
  try {
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    for (const p of [pageA, pageB]) {
      p.setDefaultTimeout(20000);
      p.on("pageerror", (e) => errors.push(String(e)));
    }
    await signInAs(pageA, srv, guestA);
    await signInAs(pageB, srv, guestB);
    // by the invite link
    for (const p of [pageA, pageB]) {
      await gotoOn(p, srv, `#/party/${code}`, { selector: "#app .player video" });
      await p.waitForFunction(() => /Joined/.test(document.getElementById("toasts").innerText), null, { timeout: 20000 });
    }
    const pages = [page, pageA, pageB];
    const guests = [pageA, pageB];
    const settle = (t = 2500) => new Promise((r) => setTimeout(r, t));
    const until = (p, fn, timeout = 15000) => p.waitForFunction(fn, null, { timeout });
    const isPlaying = () => !document.querySelector(".player video").paused;
    const isPaused = () => document.querySelector(".player video").paused;
    // how long until every page in `list` satisfies fn (ms)
    const followed = async (list, fn) => { const t0 = Date.now(); await Promise.all(list.map((p) => until(p, fn))); return Date.now() - t0; };
    // everyone's error against the party's line, at one instant
    const errorsNow = async () => (await Promise.all(pages.map(sample))).map((x) => (x.moving && !x.paused ? Math.abs(x.t - x.target) : null));

    // ---- joining lands on the party (sync once, and its one check)
    await Promise.all(pages.map((p) => until(p, isPlaying)));
    await settle(7000);
    const landed = await errorsNow();
    note(`landed: host ${ms(landed[0])}, guest ${ms(landed[1])}, phone ${ms(landed[2])} from the party's line`);
    assert.ok(landed.every((x) => x != null && x < 0.5), `everyone landed within half a second: ${landed}`);

    // ---- ordinary watching: nobody is moved, nobody's speed is touched
    await Promise.all(guests.map(countMoves));
    const errs = [];
    const spreads = [];
    const end = Date.now() + NORMAL_PLAY_S * 1000;
    while (Date.now() < end) {
      const s = await Promise.all(pages.map(sample));
      if (s.every((x) => x.moving && !x.paused)) {
        s.forEach((x) => errs.push(Math.abs(x.t - x.target)));
        const ref = s[0].wall;
        const adj = s.map((x) => x.t + (ref - x.wall) / 1000);
        spreads.push(Math.max(...adj) - Math.min(...adj));
      }
      assert.ok(s.every((x) => x.rate === 1), `the film's speed is never touched: ${s.map((x) => x.rate)}`);
      await settle(1000);
    }
    const moves = await Promise.all(guests.map(movesOf));
    note(`${NORMAL_PLAY_S} s of watching: ${errs.length} samples, from the line p50 ${ms(pct(errs, 0.5))}, p95 ${ms(pct(errs, 0.95))}, max ${ms(Math.max(...errs))}; between people p95 ${ms(pct(spreads, 0.95))}; guests' seeks ${moves.map((m) => m.seeks)}, speed changes ${moves.map((m) => m.rates)}`);
    assert.deepEqual(moves, [{ seeks: 0, rates: 0 }, { seeks: 0, rates: 0 }], "no seeks and no speed changes while watching");
    assert.ok(errs.length > NORMAL_PLAY_S, `samples: ${errs.length}`);
    assert.ok(pct(spreads, 0.95) < 0.5, `in step while watching: p95 ${pct(spreads, 0.95)}`);

    // ---- the host pauses: everyone, within about a second, on one frame
    await player.press(page, "Play/Pause");
    const pauseMs = await followed(guests, isPaused);
    await settle(1200);
    const frames = await Promise.all(pages.map((p) => p.evaluate(() => document.querySelector(".player video").currentTime)));
    note(`pause followed in ${pauseMs} ms; frames ${frames.map((x) => x.toFixed(3)).join(" / ")}`);
    assert.ok(pauseMs < 1500, `pause followed in ${pauseMs} ms`);
    assert.ok(Math.max(...frames) - Math.min(...frames) < 0.1, `paused on one frame: ${frames}`);

    // ---- the phone presses play: the others follow at once
    await pageB.$eval('.player .pbtn[aria-label="Play/Pause"]', (b) => b.click());
    const playMs = await followed([page, pageA], isPlaying);
    await settle(3000);
    const afterPlay = await errorsNow();
    note(`the phone's play followed in ${playMs} ms; then ${afterPlay.map((x) => ms(x)).join(" / ")} from the line`);
    assert.ok(playMs < 1500, `play followed in ${playMs} ms`);

    // ---- the host jumps (the scrubber): everyone lands and goes on together
    const before = (await sample(page)).t;
    await player.scrubTo(page, 0.2);
    const jumpMs = await followed(guests, () => Math.abs(document.querySelector(".player video").currentTime - 360) < 30);
    await Promise.all(pages.map((p) => until(p, isPlaying)));
    await settle(3000);
    const afterJump = await errorsNow();
    note(`jump from ${before.toFixed(1)} s followed in ${jumpMs} ms; then ${afterJump.map((x) => ms(x)).join(" / ")} from the line`);
    assert.ok(afterJump.every((x) => x != null && x < 0.5), `together after the jump: ${afterJump}`);

    // ---- a stall: guest A's video requests are held while the host jumps far
    const held = [];
    const pattern = (url) => /\/stream\//.test(url.pathname) || /\.(mp4|m4s|ts)$/.test(url.pathname);
    await pageA.route(pattern, (route) => { held.push(route); });
    await player.scrubTo(page, 0.75);
    await until(page, () => { const w = document.querySelector(".player .party-wait"); return w && !w.classList.contains("hidden") && /Waiting for/.test(w.textContent); });
    assert.match(await page.textContent(".player .party-wait"), new RegExp(`Waiting for ${guestA.name}`));
    await Promise.all([page, pageB].map((p) => until(p, isPaused, 8000)));
    await settle(2500);
    await pageA.unroute(pattern);
    for (const r of held.splice(0)) r.continue().catch(() => {});
    await Promise.all(pages.map((p) => until(p, isPlaying)));
    await until(page, () => document.querySelector(".player .party-wait").classList.contains("hidden"));
    await settle(3000);
    const afterStall = await errorsNow();
    note(`after the stall everyone started together: ${afterStall.map((x) => ms(x)).join(" / ")} from the line`);
    assert.ok(afterStall.every((x) => x != null && x < 0.5), `together after the stall: ${afterStall}`);

    // ---- the phone's connection drops: it comes back by itself, and follows
    const closed = await pageB.evaluate(() => { const l = window.__partySockets || []; l.forEach((w) => w.close()); return l.length; });
    assert.ok(closed > 0, "the phone's socket was closed");
    await settle(5000);
    const party = await srv.api.get(`/api/party/${code}`);
    assert.equal(party.members.length, 3);
    assert.ok(party.members.every((m) => !m.away), "the phone is back in the party");
    await player.press(page, "Play/Pause");
    const pause2 = await followed(guests, isPaused);
    note(`after the phone's dropped line: back in the party; a pause followed in ${pause2} ms`);
    await player.press(page, "Play/Pause");
    await Promise.all(guests.map((p) => until(p, isPlaying)));

    // ---- the host leaves the player: the party goes on, guest A hosts
    await gotoOn(page, srv, "#/movies");
    await until(pageA, () => /host now/.test(document.getElementById("toasts").innerText));
    const after = await srv.api.get(`/api/party/${code}`);
    assert.equal(after.host.name, guestA.name);
    assert.equal(after.members.length, 2);
    await player.press(pageA, "Play/Pause");
    await until(pageB, isPaused, 10000);
    assert.deepEqual(errors, []);
  } finally {
    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});
  }
});

ui.run();

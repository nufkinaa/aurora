// Shared plumbing for the browser tests. See docs/testing.md.
//
//   const { suite } = require("./helpers");
//   const ui = suite();                       // boots a private server + a browser for this file
//   ui.test("opens a film", async ({ page, lib, signIn, freshProfile, goto }) => {
//     await signIn(await freshProfile());
//     await goto(`#/movie/${lib.film1.id}`);
//     ...
//   });
//   ui.run({ concurrency: 3 });               // last line: how many tests at once
//
// Every test gets a fresh browser context (its own storage and cookies) and
// FAILS on any uncaught page error or console.error that is not explicitly
// allowed. On failure a screenshot, the page's console and the server's log
// are written to test/ui/artifacts/.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { test, describe, before, after } = require("node:test");
const { chromium } = require("playwright-core");
const server = require("../../scripts/ui-test-server");

const ARTIFACTS = path.join(__dirname, "artifacts");
const HEADED = !!process.env.HEADED && process.env.HEADED !== "0";

const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };

// ---------- browser ----------
// The Chrome (or Edge) already on the machine: nothing is downloaded.
const CHANNELS = (process.env.UI_BROWSER ? [process.env.UI_BROWSER] : ["chrome", "msedge"]);
const launchBrowser = async () => {
  const errors = [];
  for (const channel of CHANNELS) {
    try {
      return await chromium.launch({
        channel,
        headless: !HEADED,
        args: [
          "--autoplay-policy=no-user-gesture-required",
          "--mute-audio",
          "--disable-features=Translate,MediaRouter",
        ],
      });
    } catch (e) {
      errors.push(`${channel}: ${String(e.message).split("\n")[0]}`);
    }
  }
  throw new Error(`No installed browser could be launched (tried ${CHANNELS.join(", ")}).\n${errors.join("\n")}`);
};

// ---------- the private instance, with the calls tests need ----------
const makeApi = (srv) => {
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const ok = async (method, url, body, headers) => {
    const r = await call(method, url, body, headers);
    assert.ok(r.status >= 200 && r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const admin = { "X-Admin-Password": srv.adminPassword };
  const api = {
    call, ok, admin,
    get: (url, headers) => ok("GET", url, undefined, headers),
    post: (url, body = {}, headers) => ok("POST", url, body, headers),
    adminGet: (url) => ok("GET", url, undefined, admin),
    adminPost: (url, body = {}) => ok("POST", url, body, admin),

    profiles: () => ok("GET", "/api/profiles"),
    profile: async (id) => (await api.profiles()).find((p) => p.id === id),
    // An unlock token for a profile (the header every profile route wants).
    token: async (profile) =>
      (await ok("POST", `/api/profiles/${profile.id}/unlock`, { password: profile.password || "", ...(profile.pin ? { pin: profile.pin } : {}) })).token || null,
    as: async (profile) => {
      const token = await api.token(profile);
      return token ? { "X-Profile-Token": token } : {};
    },
    // File a profile request the way the wall does, and leave it waiting.
    requestProfile: (name, password = "pass-" + name.toLowerCase()) =>
      ok("POST", "/api/profiles", { name, password, realName: `${name} Tester`, avatar: "🦊", color: "#2c9fe0" }),
    // ...or see it all the way through: request, approve, optionally drop the
    // password again (open: true), optionally make it a kids profile.
    //   -> { id, name, password }
    createProfile: async (name, { password = "pass-" + name.toLowerCase(), open = false, kids = null, seenNotice = true } = {}) => {
      const { request } = await api.requestProfile(name, password);
      const p = await api.adminPost(`/api/admin/profile-requests/${request.id}/approve`);
      const profile = { id: p.id, name, password };
      const headers = await api.as(profile);
      if (seenNotice) await ok("PUT", `/api/profiles/${p.id}`, { lookNoticeSeen: true }, headers);
      if (open) {
        await ok("POST", `/api/profiles/${p.id}/password`, { newPassword: "", currentPassword: password }, headers);
        profile.password = "";
      }
      if (kids) {
        await api.adminPost(`/api/admin/profiles/${p.id}/kids`, { kids });
        profile.kids = kids;
      }
      return profile;
    },
    state: async (profile) => ok("GET", `/api/profiles/${profile.id}/state`, undefined, await api.as(profile)),
    setProgress: async (profile, itemId, position, duration) =>
      ok("POST", `/api/profiles/${profile.id}/progress`, { itemId, position, duration }, await api.as(profile)),
    clearProgress: async (profile, itemId) =>
      ok("DELETE", `/api/profiles/${profile.id}/progress/${itemId}`, undefined, await api.as(profile)),
    rescan: () => api.adminPost("/api/admin/rescan"),
    library: () => ok("GET", "/api/library"),
    item: (id) => ok("GET", `/api/item/${id}`),
  };
  return api;
};

// Ask the server for every segment of a title's repackaged ("jit") stream,
// one after another, so they are all on its disk before any page plays it.
// Why: the server keeps ONE segment producer per title and re-aims it at
// whatever is asked for, so several pages playing the same film at different
// positions make it thrash and answer 504 (a reported server bug — see
// player-hls.test.js). With the segments already made, a request is a file
// read and the tests do not depend on that.
const warmJit = async (srv, id) => {
  const base = `${srv.url}/stream/transcode/${id}/jit`;
  const playlist = await (await fetch(`${base}/index.m3u8`)).text();
  const segments = playlist.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  assert.ok(segments.length > 0, `no segments in the jit playlist of ${id}`);
  for (const seg of segments) {
    const res = await fetch(`${base}/${seg}`);
    await res.arrayBuffer();
    assert.equal(res.status, 200, `warming ${seg}`);
  }
  return segments;
};

// The titles in the generated library, by a short name tests can read.
const describeLibrary = async (api) => {
  const lib = await api.library();
  const film = (title) => lib.movies.find((m) => m.title === title);
  const show = await api.item(lib.shows.find((s) => s.title === "Test Show").id);
  const episodes = show.seasons[0].episodes;
  return {
    film1: film("Test Film One"), // MP4, plays as the file itself; sidecar subtitles
    film2: film("Test Film Two"), // MKV, two audio tracks, embedded subtitles; hls.js
    show,
    e1: episodes[0], e2: episodes[1], e3: episodes[2],
  };
};

// ---------- console / page-error capture ----------
// The explicit allow-list. A console.error or uncaught error that matches
// nothing here (and nothing the test itself passed as `allow`) fails the test.
//
// OFFLINE: the private instance has no way out, so the routes that ask the
// outside world for something (catalogue, metadata, stream sources, X-Ray,
// artwork fetched on demand) answer 502/504/404, and the browser prints its
// own "Failed to load resource" line for each. The app is expected to cope
// (and the tests assert that it does); the line itself is not a defect.
const OFFLINE = /Failed to load resource.*\/(api\/(discover|catalog|torrents|xray|segments|subtitles|popular|ai)\b|img\/(ext|poster|meta)\b)/;
const ALWAYS_ALLOWED = [OFFLINE];

const watch = (page, origin, allowed) => {
  const problems = [];
  const lines = [];
  const isAllowed = (text) => [...ALWAYS_ALLOWED, ...allowed].some((p) => (p instanceof RegExp ? p.test(text) : text.includes(p)));
  page.on("console", (msg) => {
    const text = msg.text();
    const where = (msg.location() && msg.location().url) || "";
    lines.push(`[${msg.type()}] ${text}${where ? `  (${where})` : ""}`);
    if (msg.type() !== "error") return;
    // "Failed to load resource" for a host the suite fenced off on purpose
    if (where && !where.startsWith(origin) && /Failed to load resource/.test(text)) return;
    if (isAllowed(`${text} ${where}`)) return;
    problems.push(`console.error: ${text}${where ? ` (${where})` : ""}`);
  });
  page.on("pageerror", (err) => {
    const text = (err && (err.stack || err.message)) || String(err);
    lines.push(`[pageerror] ${text}`);
    if (!isAllowed(text)) problems.push(`uncaught: ${text}`);
  });
  page.on("requestfailed", (req) => {
    lines.push(`[requestfailed] ${req.method()} ${req.url()} ${req.failure() ? req.failure().errorText : ""}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) lines.push(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
  });
  return { problems, lines };
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

// ---------- the suite ----------
// opts.server: passed to scripts/ui-test-server start() (seed, config)
// opts.setup(srv): runs once after boot — create the profiles the file needs
let counter = 0;
const suite = (opts = {}) => {
  const file = path.basename(require.main ? require.main.filename : "ui", ".test.js");
  const ctx = { srv: null, browser: null };
  const queue = [];

  before(async () => {
    const srv = await server.start(opts.server || {});
    srv.api = makeApi(srv);
    srv.lib = await describeLibrary(srv.api);
    srv.profiles = {};
    ctx.srv = srv;
    if (opts.setup) await opts.setup(srv);
    ctx.browser = await launchBrowser();
  });

  after(async () => {
    try { if (ctx.browser) await ctx.browser.close(); } catch {}
    if (ctx.srv) await ctx.srv.stop();
  });

  // ui.test(name, [options], fn)
  //   options.viewport        DESKTOP (default) or PHONE, or any { width, height }
  //   options.allow           console.error / page-error texts (string or RegExp) this test expects
  //   options.permissions     e.g. ["notifications"] — granted to the page's origin
  //   options.todo / skip     as in node:test
  const uiTest = (name, options, fn) => {
    if (typeof options === "function") { fn = options; options = {}; }
    const { viewport = DESKTOP, allow = [], permissions = null, ...nodeOpts } = options;
    // (a page that hangs must not hang the run: two minutes is far beyond
    // the slowest test here, the real-time stall ladder at ~45 s)
    queue.push([name, { timeout: 120000, ...nodeOpts }, async (t) => {
      const { srv, browser } = ctx;
      const phone = viewport.width < 600;
      const context = await browser.newContext({
        viewport,
        // a phone is a touch device with a coarse pointer: the app branches on both
        ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
        // The service worker would answer requests from its own cache and
        // hide them from page.route; offline copies are out of scope here.
        serviceWorkers: "block",
        ...(permissions ? { permissions } : {}),
      });
      // Nothing leaves this machine: anything that is not the private
      // instance is answered at once with an empty 404.
      const blocked = new Set();
      await context.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => {
        try { blocked.add(new URL(route.request().url()).host); } catch {}
        route.fulfill({ status: 404, body: "" }).catch(() => {});
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const watched = watch(page, srv.url, allow);

      const h = {
        page, context, srv, t, blocked,
        api: srv.api, lib: srv.lib, profiles: srv.profiles,
        signIn: (profile, o) => signIn(page, srv, profile, o),
        // a brand-new open profile, for a test whose state must be its own
        freshProfile: (o) => srv.api.createProfile(`T${(++counter).toString(36)}${Date.now().toString(36).slice(-4)}`, { open: true, ...o }),
        goto: (hash, o) => goto(page, srv, hash, o),
        allow: (...patterns) => allow.push(...patterns),
        problems: watched.problems,
      };

      let failure = null;
      try {
        await fn(h);
        if (watched.problems.length) {
          throw new Error(`The page reported ${watched.problems.length} error(s):\n  ${watched.problems.join("\n  ")}`);
        }
      } catch (err) {
        failure = err;
      }
      // (a `todo` is a failure we already know about: no artifacts for those)
      if (failure && !nodeOpts.todo) {
        try {
          fs.mkdirSync(ARTIFACTS, { recursive: true });
          const base = path.join(ARTIFACTS, `${file}--${slug(name)}`);
          await page.screenshot({ path: `${base}.png` }).catch(() => {});
          // a player on screen: what the element itself says
          const video = await page.evaluate(() => {
            const v = document.querySelector(".player video");
            if (!v) return null;
            const buffered = [];
            for (let i = 0; i < v.buffered.length; i++) buffered.push([+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)]);
            return {
              currentTime: v.currentTime, duration: v.duration, paused: v.paused, ended: v.ended, seeking: v.seeking,
              readyState: v.readyState, networkState: v.networkState, playbackRate: v.playbackRate, buffered,
              error: v.error ? `${v.error.code} ${v.error.message}` : null, src: v.currentSrc,
              clock: (document.querySelector(".player .scrub-row > span") || {}).textContent,
              spinner: !!document.querySelector(".player > .spinner:not(.hidden)"),
              card: (document.querySelector(".player .player-error") || {}).innerText || null,
              pill: (document.querySelector(".player .quality-pill") || {}).innerText || null,
            };
          }).catch(() => null);
          fs.writeFileSync(`${base}.log`, [
            `TEST   ${file} › ${name}`,
            `URL    ${page.url()}`,
            `ERROR  ${failure && failure.stack ? failure.stack : failure}`,
            "",
            ...(video ? ["---- <video> ----", JSON.stringify(video, null, 1), ""] : []),
            "---- page console ----",
            ...watched.lines,
            "",
            "---- hosts fenced off ----",
            [...blocked].join(", ") || "(none)",
            "",
            "---- server log (last 200 lines) ----",
            ...srv.log().slice(-200),
          ].join("\n"), "utf-8");
          failure.message += `\n  artifacts: ${base}.png / .log`;
        } catch {}
      }
      await context.close().catch(() => {});
      if (failure) throw failure;
    }]);
  };

  // ui.run({ concurrency }) — the LAST line of a test file: hands the tests
  // declared above to node:test. `concurrency` is how many of them may run
  // at once, each in its own browser context (its own cookies and storage)
  // against the file's one server. Tests that share server state other than
  // through their own fresh profile (the library on disk, the admin's
  // queue) want 1.
  let ran = false;
  const run = ({ concurrency = 1 } = {}) => {
    ran = true;
    describe(file, { concurrency }, () => {
      for (const [name, o, body] of queue.splice(0)) test(name, o, body);
    });
  };
  // a file that declares tests and never hands them over would "pass" with
  // nothing run: make that loud
  process.on("exit", () => {
    if (!ran && queue.length) {
      process.stderr.write(`
${file}.test.js declared ${queue.length} test(s) but never called ui.run() — none of them ran.
`);
      process.exitCode = 1;
    }
  });

  return {
    test: uiTest,
    run,
    get srv() { return ctx.srv; },
    get browser() { return ctx.browser; },
  };
};

// ---------- page helpers ----------
// Enter the app as `profile` without walking the wall: the browser is given
// what a returning device already holds (the remembered profile and, for a
// protected one, this session's unlock token). The wall itself is tested in
// wall.test.js. Must be called before the first goto().
const signIn = async (page, srv, profile, { hints = true } = {}) => {
  const token = profile.password || profile.pin ? await srv.api.token(profile) : null;
  await page.addInitScript(({ id, token, hints }) => {
    try {
      if (sessionStorage.getItem("ui-test-seeded")) return; // once per tab: later reloads keep what the app stored
      sessionStorage.setItem("ui-test-seeded", "1");
      localStorage.setItem("aurora-profile", id);
      if (token) sessionStorage.setItem(`aurora-token-${id}`, token);
      if (hints) {
        // one-time coach marks, already seen
        localStorage.setItem("aurora-kbd-hint", "1");
        localStorage.setItem("aurora-nav-hinted", "1");
      }
    } catch {}
  }, { id: profile.id, token, hints });
};

// The screen for the current route has painted: a .screen (or the player) is
// in #app and the route skeleton is gone.
const waitForScreen = async (page, { selector = "#app .screen, #app .player", timeout = 15000 } = {}) => {
  await page.waitForFunction((sel) => {
    const app = document.getElementById("app");
    return !!app && !!app.querySelector(sel) && !app.querySelector(".route-skel");
  }, selector, { timeout });
};

// Open the app at a hash route. The first call loads the page; later calls
// navigate inside the running app, the way a click on a link does.
const goto = async (page, srv, hash = "#/", { wait = true, selector } = {}) => {
  if (!hash.startsWith("#")) hash = "#" + hash;
  if (!page.url().startsWith(srv.url)) {
    await page.goto(`${srv.url}/${hash}`, { waitUntil: "domcontentloaded" });
  } else {
    await page.evaluate((h) => { if (location.hash === h) window.dispatchEvent(new HashChangeEvent("hashchange")); else location.hash = h; }, hash);
  }
  if (wait) await waitForScreen(page, selector ? { selector } : {});
};

// No sideways scroll: the page is no wider than the window.
const assertNoHorizontalOverflow = async (page, label = "") => {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(m.sw <= m.iw + 1, `${label} overflows sideways: scrollWidth ${m.sw} > innerWidth ${m.iw}`);
};

// Nothing may be reported for `ms` after this point — used after leaving a
// screen that has timers and listeners to tear down.
const quietFor = async (page, problems, ms) => {
  const before = problems.length;
  await page.waitForTimeout(ms);
  assert.deepEqual(problems.slice(before), [], `errors within ${ms} ms`);
};

// ---------- the player ----------
// Everything here goes through what a viewer has: the controls by their
// aria-labels, the clock printed beside the timeline, the <video> element.
const CTRL = (label) => `.player .pbtn[aria-label="${label}"]`;
const player = {
  ctrl: CTRL,
  // The marks the player posts to the server's [play] log (/api/play-mark):
  // which path it took, first frame, the stall ladder. Start recording BEFORE
  // opening the player.  -> { all: [...], wait(predicate, timeout) }
  marks: (page) => {
    const all = [];
    const waiters = [];
    page.on("request", (req) => {
      if (!/\/api\/play-mark\//.test(req.url()) || req.method() !== "POST") return;
      let m = null;
      try { m = JSON.parse(req.postData() || "null"); } catch {}
      if (!m) return;
      all.push(m);
      for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    });
    return {
      all,
      named: (name) => all.filter((m) => m.name === name),
      wait: (test, timeout = 15000, what = "a play mark") => {
        const hit = all.find(test);
        if (hit) return Promise.resolve(hit);
        return new Promise((resolve, reject) => {
          const w = { test, resolve };
          waiters.push(w);
          setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timed out after ${timeout} ms waiting for ${what}; marks so far: ${JSON.stringify(all)}`)); } }, timeout);
        });
      },
    };
  },
  // Open #/play/<id> and wait until the picture is really moving.
  // (From a screen of the app, as a viewer gets there: leaving the player
  // goes back in history, and a tab that began on the player has nothing of
  // the app to go back to.)
  open: async (page, srv, id, { query = "", min = 0.5 } = {}) => {
    if (!page.url().startsWith(srv.url)) await goto(page, srv, "#/movies");
    await goto(page, srv, `#/play/${id}${query}`, { selector: "#app .player video" });
    await player.playing(page, { id, min });
  },
  // Playing: this title's player is up, not paused, and the clock has moved.
  // `fresh`: after player.tag() — wait for a NEW <video>, not the one that
  // was on the page when the tag was put on (going episode to episode, the
  // old player is still there for a moment after the address has changed).
  playing: async (page, { id = null, min = 0.3, timeout = 30000, fresh = false } = {}) => {
    await page.waitForFunction(({ id, min, fresh }) => {
      if (id && !location.hash.includes(id)) return false;
      const v = document.querySelector(".player video");
      if (!v || (fresh && v.dataset.uiSeen)) return false;
      return !v.paused && !v.ended && v.readyState >= 2 && v.currentTime > min;
    }, { id, min, fresh }, { timeout });
    await player.advancing(page);
  },
  tag: (page) => page.evaluate(() => { const v = document.querySelector(".player video"); if (v) v.dataset.uiSeen = "1"; }),
  // The media clock is RUNNING: it moves forward in small steps, the way a
  // playing film does, for `by` seconds in all. A jump (a seek landing, a
  // stream restarting at 0) is not progress and starts the count again, so
  // this can be called right after a seek was asked for.
  advancing: async (page, { by = 0.5, timeout = 15000 } = {}) => {
    await page.evaluate(() => { window.__uiRun = null; });
    await page.waitForFunction((by) => {
      const v = document.querySelector(".player video");
      if (!v) { window.__uiRun = null; return false; }
      const r = window.__uiRun || (window.__uiRun = { el: v, t: v.currentTime, run: 0 });
      if (r.el !== v) { window.__uiRun = null; return false; }
      const d = v.currentTime - r.t;
      r.t = v.currentTime;
      if (d > 0 && d < 1.2) r.run += d;
      else if (d !== 0) r.run = 0;
      return r.run >= by && !v.paused && !v.seeking;
    }, by, { timeout, polling: 100 });
  },
  state: (page) => page.evaluate(() => {
    const v = document.querySelector(".player video");
    if (!v) return null;
    const tracks = [...v.textTracks].map((t) => ({ label: t.label, mode: t.mode, cue: t.activeCues && t.activeCues[0] ? t.activeCues[0].text : null }));
    return {
      t: v.currentTime, duration: v.duration, paused: v.paused, ended: v.ended, rate: v.playbackRate, readyState: v.readyState,
      src: v.currentSrc || "", tracks, showing: tracks.filter((t) => t.mode === "showing").map((t) => t.label),
    };
  }),
  // Where the FILM is, in seconds, as the viewer reads it: the time printed
  // left of the timeline. On a repackaged stream the media element's own
  // clock can restart from zero after a seek; this one never does.
  clock: (page) => page.evaluate(() => {
    const el = document.querySelector(".player .scrub-row > span");
    const parts = el ? el.textContent.trim().split(":").map(Number) : [];
    return parts.length && parts.every((n) => Number.isFinite(n)) ? parts.reduce((a, n) => a * 60 + n, 0) : null;
  }),
  waitClock: (page, min, max, timeout = 15000) =>
    page.waitForFunction(({ min, max }) => {
      const el = document.querySelector(".player .scrub-row > span");
      if (!el) return false;
      const t = el.textContent.trim().split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
      return t >= min && t <= max;
    }, { min, max }, { timeout }),
  // The controls fade while a film plays; a pointer move brings them back.
  wake: async (page) => {
    wakeX = wakeX === 500 ? 520 : 500;
    await page.mouse.move(wakeX, 250);
    await page.waitForFunction(() => { const p = document.querySelector(".player"); return !!p && !p.classList.contains("controls-hidden"); });
  },
  press: async (page, label) => {
    await player.wake(page);
    await page.click(CTRL(label));
  },
  // Open one of the three menus (Subtitles / Speed / Settings); -> its items' text
  menu: async (page, label) => {
    if (await page.locator(".player .menu").count()) { await page.keyboard.press("Escape"); await page.waitForSelector(".player .menu", { state: "detached" }); }
    await player.press(page, label);
    await page.waitForSelector(".player .menu .menu-item");
    return page.evaluate(() => [...document.querySelectorAll(".player .menu .menu-item")].map((b) => ({
      text: (b.childNodes[0].textContent || "").trim() || b.textContent.trim(),
      tag: (b.querySelector(".tag") || {}).textContent || "",
      active: b.classList.contains("active"),
    })));
  },
  pick: async (page, label, itemText) => {
    await player.menu(page, label);
    await page.locator(".player .menu .menu-item").filter({ hasText: itemText }).first().click();
  },
  // Click the timeline at a fraction of its width.
  scrubTo: async (page, fraction) => {
    await player.wake(page);
    const box = await page.locator(".player .scrubber").boundingBox();
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
  },
  // Move the film without touching anything a viewer would touch (so it does
  // not count as "someone is there"): for getting near the end of an episode.
  jump: (page, seconds) => page.evaluate((s) => { document.querySelector(".player video").currentTime = s; }, seconds),
  mediaSession: (page) => page.evaluate(() => {
    const m = navigator.mediaSession && navigator.mediaSession.metadata;
    return m ? { title: m.title, artist: m.artist, album: m.album, artwork: m.artwork.length } : null;
  }),
};
let wakeX = 500;

module.exports = {
  suite, signIn, goto, waitForScreen, assertNoHorizontalOverflow, quietFor, player,
  launchBrowser, makeApi, describeLibrary, warmJit,
  DESKTOP, PHONE, ARTIFACTS,
  FILM_SECONDS: server.FILM_SECONDS, EPISODE_SECONDS: server.EPISODE_SECONDS, IDS: server.IDS, certificatesSeed: server.certificatesSeed,
};

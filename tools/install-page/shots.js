#!/usr/bin/env node
// The screenshots on the /install page, made on a private, throwaway Aurora
// (scripts/ui-test-server.js: its own folder, a free port, no network out)
// with an invented catalogue and painted artwork (catalogue.js, make-art.py),
// a small library made here with ffmpeg from that artwork, and made-up
// people — Dana, Avi, Noa and Ben. Never the live server, never anyone's data.
//
//   node tools/install-page/shots.js [--only home,title,…] [--keep]
//       writes tools/install-page/.cache/raw/<name>.png
//   python tools/install-page/optimize.py
//       turns them (and the TV photos from docs/qa) into public/install/*
//
// --keep leaves the instance running at the end (CTRL-C ends it), to look around.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { chromium } = require("playwright-core");

const REPO = path.join(__dirname, "..", "..");
const server = require(path.join(REPO, "scripts", "ui-test-server.js"));
const { SimTV } = require(path.join(REPO, "test", "ui", "support", "sim-tv.js"));
const cat = require("./catalogue");

const CACHE = path.join(__dirname, ".cache");
const ART = path.join(CACHE, "art-v3");
const MEDIA = path.join(CACHE, "media-v3");
const RAW = path.join(CACHE, "raw");
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = arg("only") ? new Set(arg("only").split(",")) : null;
const want = (name) => !ONLY || ONLY.has(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[shots]", ...a);

// ---------- artwork ----------
const ensureArt = () => {
  if (fs.existsSync(path.join(ART, ".ready"))) return;
  fs.mkdirSync(CACHE, { recursive: true });
  const list = path.join(CACHE, "titles.json");
  fs.writeFileSync(list, JSON.stringify(cat.artList()));
  log("painting the artwork…");
  const r = spawnSync(process.platform === "win32" ? "python" : "python3", [path.join(__dirname, "make-art.py"), ART, list], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("make-art.py failed (needs Python 3 with Pillow)");
};

// ---------- the library: four films and a show, made from the artwork ----------
const film = (name) => cat.CATALOGUE.movie.find((m) => m.name === name);
const show = (name) => cat.CATALOGUE.series.find((m) => m.name === name);
// (lengths that read like films: the pictures are a still frame, so a film of
// an hour and a half is a few megabytes)
const LIB_FILMS = [["Northbound", 104], ["Copper Sky", 97], ["Salt & Ember", 112], ["The Long Signal", 121]].map(([n, min]) => ({ ...film(n), seconds: min * 60 }));
const EPISODE_S = 48 * 60;
const LIB_SHOW = show("Glass Harbour");
const year = (m) => parseInt(m.releaseInfo, 10);
const LINES = [
  "You kept the light burning every night.", "Even when no ships came?", "Especially then.",
  "The logbook doesn't lie, Elin.", "Then who wrote tomorrow's date in it?", "Look — the tide's turning early.",
  "Ten years on this rock and I've never seen the sea this still.", "Something's out there.", "Ring the bell. Now.",
  "If the storm comes from the north, we lose the boats.", "Then we don't lose the light.", "Come up to the gallery. You'll want to see this.",
  "That's not a ship.", "No. It's waiting.", "Keep the lamp turning. Whatever happens.",
  "I read the last page.", "And?", "It's in your handwriting.",
  "We could leave on the morning ferry.", "And who would keep the light?",
  "You hear that?", "The fog horn from the mainland. Two short, one long.", "That's the signal for us.",
  "Hold the rope!", "I've got you.", "Don't let go.", "Never.", "Morning, keeper.", "Morning.", "The sea is quiet now.",
];
const srt = (seconds) => {
  const two = (n) => String(Math.floor(n)).padStart(2, "0");
  const t = (s) => `${two(s / 3600)}:${two((s % 3600) / 60)}:${two(s % 60)},${s % 1 ? "500" : "000"}`;
  let out = "";
  let n = 1;
  for (let s = 1; s + 2.2 <= seconds; s += 3, n++) out += `${n}\n${t(s)} --> ${t(s + 2.5)}\n${LINES[(n - 1) % LINES.length]}\n\n`;
  return out;
};
const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
};
// the title's backdrop as a 1080p film: H.264 + AAC. A still picture, so one
// minute is made and repeated (stream copy) to a feature's length — a few
// seconds of work and ~7 MB per ten minutes instead of an hour of encoding.
const video = (backdrop, out, seconds) => {
  const unit = `${out}.unit.mp4`;
  ff([
    "-loop", "1", "-framerate", "5", "-i", backdrop,
    "-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=0.02:sample_rate=24000:duration=60",
    "-map", "0:v", "-map", "1:a", "-t", "60", "-vf", "scale=1920:1080,gblur=sigma=0.8,format=yuv420p",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage", "-crf", "30", "-g", "150", "-keyint_min", "150", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "24k", "-ac", "1", unit,
  ]);
  const list = `${out}.txt`;
  const name = path.basename(unit); // (the list sits beside it: a plain name, no quoting)
  fs.writeFileSync(list, Array.from({ length: Math.ceil(seconds / 60) }, () => `file '${name.replace(/'/g, "")}'`).join("\n"));
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-t", String(seconds), "-metadata:s:a:0", "language=eng", "-movflags", "+faststart", out]);
  fs.rmSync(unit);
  fs.rmSync(list);
};
const ensureMedia = () => {
  if (fs.existsSync(path.join(MEDIA, ".ready"))) return;
  fs.rmSync(MEDIA, { recursive: true, force: true });
  log("making the library…");
  for (const [i, m] of LIB_FILMS.entries()) {
    const dir = path.join(MEDIA, "movies", `${m.name} (${year(m)})`);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${m.name} (${year(m)})`);
    video(path.join(ART, `backdrop-${m.id}.jpg`), `${base}.mp4`, m.seconds);
    fs.writeFileSync(`${base}.English.srt`, srt(m.seconds));
    fs.copyFileSync(path.join(ART, `poster-${m.id}.jpg`), path.join(dir, "cover.jpg"));
  }
  const sdir = path.join(MEDIA, "shows", LIB_SHOW.name, "Season 1");
  fs.mkdirSync(sdir, { recursive: true });
  for (let e = 1; e <= 3; e++) {
    const base = path.join(sdir, `${LIB_SHOW.name} S01E0${e}`);
    // each episode its own picture (another title's world), the show's poster on the show
    const world = [LIB_SHOW, show("After the Tide"), show("Brightwater")][e - 1];
    video(path.join(ART, `backdrop-${world.id}.jpg`), `${base}.mp4`, EPISODE_S);
    fs.writeFileSync(`${base}.English.srt`, srt(EPISODE_S));
  }
  fs.copyFileSync(path.join(ART, `poster-${LIB_SHOW.id}.jpg`), path.join(MEDIA, "shows", LIB_SHOW.name, "cover.jpg"));
  fs.writeFileSync(path.join(MEDIA, ".ready"), "ok");
};

// ---------- the instance ----------
const PEOPLE = [
  { name: "Dana", avatar: "🦊", color: "#8b7bff" },
  { name: "Avi", avatar: "🐻", color: "#e0a72c" },
  { name: "Noa", avatar: "🌸", color: "#e05c8a" },
  { name: "Ben", avatar: "🐧", color: "#2c9fe0" },
];

const boot = async () => {
  ensureArt();
  ensureMedia();
  const at = Date.now();
  const imdbMap = {};
  for (const m of LIB_FILMS) imdbMap[`movie|${m.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${year(m)}`] = { imdbId: m.id, at };
  imdbMap[`show|${LIB_SHOW.name.toLowerCase()}|`] = { imdbId: LIB_SHOW.id, at };
  const srv = await server.start({
    preload: [path.join(__dirname, "fixture-preload.js")],
    env: { IP_ART_DIR: ART, IP_CATALOGUE: path.join(__dirname, "catalogue.js") },
    // (profiles.json empty: no default profile — only the made-up people below)
    seed: { "cache/discover.json": cat.discoverSeed(), "imdb-map.json": imdbMap, "settings.json": {}, "profiles.json": { profiles: [], state: {} } },
    config: { onlineMetadata: true },
  });
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const admin = { "X-Admin-Password": srv.adminPassword };

  // the test library out, ours in
  for (const kind of ["movies", "shows"]) {
    // (the server may still be reading a file it just found: Windows refuses
    // to delete an open one, so ask again for a while)
    for (const e of fs.readdirSync(srv.library[kind])) {
      for (let i = 0; ; i++) {
        try { fs.rmSync(path.join(srv.library[kind], e), { recursive: true, force: true }); break; } catch (err) {
          if (i > 60) throw err;
          await sleep(500);
        }
      }
    }
    fs.cpSync(path.join(MEDIA, kind), srv.library[kind], { recursive: true });
  }
  await call("POST", "/api/admin/rescan", {}, admin);
  for (let i = 0; ; i++) {
    const lib = await call("GET", "/api/library");
    if (lib.movies.length === LIB_FILMS.length && lib.movies.every((m) => m.duration > 0) && lib.shows.length === 1 && lib.shows[0].title === LIB_SHOW.name) break;
    if (i > 200) throw new Error("the library did not settle: " + JSON.stringify(lib.movies.map((m) => m.title)));
    await sleep(250);
  }
  const library = await call("GET", "/api/library");
  const libFilm = (name) => library.movies.find((m) => m.title === name);
  const showItem = await call("GET", `/api/item/${library.shows[0].id}`);
  const eps = showItem.seasons[0].episodes;

  // the people
  const people = {};
  for (const p of PEOPLE) {
    const { request } = await call("POST", "/api/profiles", { name: p.name, password: `pass-${p.name}`, realName: p.name, avatar: p.avatar, color: p.color });
    const made = await call("POST", `/api/admin/profile-requests/${request.id}/approve`, {}, admin);
    const { token } = await call("POST", `/api/profiles/${made.id}/unlock`, { password: `pass-${p.name}` });
    const h = { "X-Profile-Token": token };
    await call("PUT", `/api/profiles/${made.id}`, { lookNoticeSeen: true, look: "glass", avatar: p.avatar, color: p.color }, h);
    await call("POST", `/api/profiles/${made.id}/password`, { newPassword: "", currentPassword: `pass-${p.name}` }, h);
    people[p.name] = { id: made.id, name: p.name };
  }
  const dana = people.Dana;
  // a lived-in Dana: half-watched, a list, ratings, liked genres
  await call("POST", `/api/profiles/${dana.id}/progress`, { itemId: libFilm("The Long Signal").id, position: 3720, duration: 121 * 60 });
  await call("POST", `/api/profiles/${dana.id}/progress`, { itemId: eps[1].id, position: 1260, duration: EPISODE_S });
  for (const m of [...cat.CATALOGUE.movie.slice(4, 12), ...cat.CATALOGUE.series.slice(2, 8)]) {
    await call("POST", `/api/profiles/${dana.id}/watchlist`, { add: true, stream: { imdbId: m.id, type: m.type === "series" ? "show" : "movie", title: m.name, poster: m.poster, year: year(m) } });
  }
  for (const [i, m] of cat.CATALOGUE.movie.slice(26, 32).entries()) await call("POST", `/api/profiles/${dana.id}/rating`, { itemId: m.id, stars: i % 2 ? 5 : 4 });
  await call("POST", `/api/profiles/${dana.id}/preferences`, { likedGenres: ["Drama", "Sci-Fi", "Mystery"] });
  // the household recommends
  const rec = async (from, m, note) => {
    const r = await call("POST", `/api/profiles/${people[from].id}/recommend`, {
      to: [dana.id], note,
      title: m.libId ? { id: m.libId } : { imdbId: m.id, type: m.type === "series" ? "show" : "movie", title: m.name, year: year(m), poster: m.poster },
    });
    if (!r.sent || !r.sent.length) log(`recommend ${m.name} from ${from}: ${r.line}`);
  };
  await rec("Avi", { ...film("Copper Sky"), libId: libFilm("Copper Sky").id }, "That ending. You'll want to talk about it.");
  await rec("Noa", { ...film("Copper Sky"), libId: libFilm("Copper Sky").id }, "");
  await rec("Noa", film("Velvet Hour"), "The piano scene!");
  await rec("Ben", show("Halcyon Drift"), "");
  await rec("Avi", film("The Summit Hotel"), "");
  await rec("Ben", film("Little Comet"), "For movie night with the kids");
  await rec("Noa", show("The Night Kitchen"), "");

  // a manual intro mark on the show: Skip intro on every episode
  await call("POST", `/api/intro/show:${library.shows[0].id}`, { start: 62, end: 118, by: "Dana" });
  // warm Home the way a server that has been up a while has it
  for (let i = 0; i < 3; i++) { await call("GET", `/api/home?profile=${dana.id}`); await sleep(600); }
  return {
    srv, call, admin, people,
    lib: { films: Object.fromEntries(LIB_FILMS.map((m) => [m.name, libFilm(m.name)])), show: showItem, eps },
  };
};

// ---------- the browser ----------
const UA_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA_PHONE };

const newPage = async (browser, env, device, profile) => {
  const context = await browser.newContext({ ...device, serviceWorkers: "block" });
  await context.route((url) => url.origin !== env.srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  await context.addInitScript(({ id }) => {
    try {
      if (sessionStorage.getItem("ip-seeded")) return;
      sessionStorage.setItem("ip-seeded", "1");
      localStorage.setItem("aurora-profile", id);
      localStorage.setItem("aurora-look", "glass");
      localStorage.setItem("aurora-kbd-hint", "1");
      localStorage.setItem("aurora-nav-hinted", "1");
      localStorage.setItem("aurora-seen-version", "9.9.9");
    } catch {}
    // the clock: a calm evening (the greeting, the NEW tags)
    const RealDate = Date;
    const t0 = RealDate.now();
    const fixed = new RealDate("2026-10-24T20:40:00").getTime();
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(fixed + (RealDate.now() - t0)); }
      static now() { return fixed + (RealDate.now() - t0); }
    }
    window.Date = FakeDate;
  }, { id: profile.id });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => log("pageerror:", String(e).slice(0, 200)));
  return { context, page };
};

const settle = async (page, ms = 900) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  // every picture in view has arrived
  await page.waitForFunction(() => [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; }).every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
  await sleep(ms);
};
const open = async (page, env, hash, selector = "#app .screen, #app .player") => {
  if (!page.url().startsWith(env.srv.url)) await page.goto(`${env.srv.url}/${hash}`, { waitUntil: "domcontentloaded" });
  else await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector(selector, { timeout: 30000 });
};
const shot = async (page, name, opts = {}) => {
  fs.mkdirSync(RAW, { recursive: true });
  await page.screenshot({ path: path.join(RAW, `${name}.png`), ...opts });
  log("wrote", name);
};
const playing = (page, min = 0.5) => page.waitForFunction((min) => {
  const v = document.querySelector(".player video");
  return v && !v.paused && v.readyState >= 2 && v.currentTime > min;
}, min, { timeout: 30000 });
const wake = async (page) => { await page.mouse.move(700, 420); await page.mouse.move(720, 430); await sleep(250); };
const seekTo = (page, t) => page.evaluate((t) => { const v = document.querySelector(".player video"); v.currentTime = t; }, t);
const pauseAt = async (page, t) => {
  await seekTo(page, t);
  await page.waitForFunction((t) => { const v = document.querySelector(".player video"); return v && Math.abs(v.currentTime - t) < 1.5 && v.readyState >= 2; }, t);
  await page.evaluate(() => document.querySelector(".player video").pause());
};

const BRIGHT = ["Copper Sky", "Ashfall", "Harvest Moon", "The Midnight Atlas", "Hollowgate", "Northern Lights", "Distant Shores", "The Atlas Files",
  "Cold Water Rising", "Fault Lines", "Wildfire Season", "Paper Moons", "Northbound", "Wolf Creek Rangers", "Starlight Motel"];
// Home's billboard rotates through a pool: show one of the brighter pictures
// (the dots step through it; the first of `prefer` that is in the pool wins)
const pickBillboard = async (page, prefer = BRIGHT) => {
  const n = await page.locator(".hero-dot").count();
  const seen = [];
  for (let i = 0; i < n; i++) {
    await page.locator(".hero-dot").nth(i).click().catch(() => {});
    await sleep(700);
    seen.push((await page.locator(".hero-title").first().textContent().catch(() => "")) || "");
  }
  const want = prefer.find((t) => seen.includes(t));
  if (want) {
    await page.locator(".hero-dot").nth(seen.indexOf(want)).click().catch(() => {});
    await sleep(900);
  }
  await page.evaluate(() => scrollTo(0, 0)); // (a press on a dot can scroll it into view)
  await page.mouse.move(5, 890); // (away from the dots: no hover ring in the picture)
  log("billboard:", want || seen[0], "of", seen.join(", "));
};

const main = async () => {
  const env = await boot();
  log("instance up at", env.srv.url);
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--force-color-profile=srgb", "--disable-features=Translate,MediaRouter"] });
  const dana = env.people.Dana;
  const copper = env.lib.films["Copper Sky"];
  const northbound = env.lib.films["Northbound"];
  try {
    if (want("home")) {
      const { context, page } = await newPage(browser, env, DESKTOP, dana);
      await open(page, env, "#/");
      await page.waitForSelector("#app .card img");
      await pickBillboard(page);
      await settle(page, 2600); // (the sky fades in)
      await shot(page, "home-desktop");
      await page.mouse.wheel(0, 620);
      await settle(page, 1200);
      await shot(page, "home-desktop-rows");
      await context.close();
    }
    if (want("phone")) {
      const { context, page } = await newPage(browser, env, PHONE, dana);
      await open(page, env, "#/");
      await page.waitForSelector("#app .card img");
      await pickBillboard(page, ["Cold Water Rising", "Harvest Moon", "Ashfall", "The Midnight Atlas", "Hollowgate", "The Atlas Files", "Northern Lights", "Copper Sky", ...BRIGHT]);
      await settle(page, 2600);
      await shot(page, "home-phone");
      await open(page, env, `#/movie/${copper.id}`);
      await settle(page, 1500);
      await shot(page, "title-phone");
      await context.close();
    }
    if (want("title")) {
      const { context, page } = await newPage(browser, env, DESKTOP, dana);
      await open(page, env, `#/movie/${copper.id}`);
      await settle(page, 1800);
      await shot(page, "title-desktop");
      await context.close();
    }
    if (want("household")) {
      const { context, page } = await newPage(browser, env, DESKTOP, dana);
      await open(page, env, "#/");
      await page.waitForSelector("#app .card img");
      const row = page.locator(".row", { hasText: "Recommended by your household" }).first();
      await row.scrollIntoViewIfNeeded().catch(() => {});
      await page.evaluate(() => {
        const h = [...document.querySelectorAll("h2, h3")].find((x) => /Recommended by your household/.test(x.textContent));
        if (h) window.scrollBy(0, h.getBoundingClientRect().top - 140);
      });
      await settle(page, 1500);
      await shot(page, "household-desktop");
      // and the Recommend sheet on a title page, with faces to pick from
      await open(page, env, `#/movie/${northbound.id}`);
      await settle(page, 1200);
      const btn = page.getByRole("button", { name: /^Recommend/ }).first();
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(900);
        const face = page.locator(".rec-person, [data-ui*='recommend'] button", { hasText: "Avi" }).first();
        if (await face.count()) await face.click().catch(() => {});
        await page.waitForTimeout(600);
        await shot(page, "recommend-desktop");
      } else log("no Recommend button on the title page");
      await context.close();
    }
    if (want("player")) {
      const { context, page } = await newPage(browser, env, DESKTOP, dana);
      await open(page, env, "#/movies");
      await open(page, env, `#/play/${northbound.id}`, "#app .player video");
      await playing(page);
      await page.waitForFunction(() => { const v = document.querySelector(".player video"); return [...v.textTracks].some((t) => t.mode === "showing"); }, null, { timeout: 20000 }).catch(() => log("no subtitle track showing"));
      await pauseAt(page, 1510.2);
      await sleep(700);
      await wake(page);
      await sleep(500);
      await shot(page, "player-desktop");
      await context.close();
    }
    if (want("intro")) {
      const { context, page } = await newPage(browser, env, DESKTOP, dana);
      await open(page, env, "#/shows");
      await open(page, env, `#/play/${env.lib.eps[0].id}`, "#app .player video");
      await playing(page);
      await seekTo(page, 70);
      await page.waitForSelector(".player .skip-intro:not(.hidden)", { timeout: 15000 }).catch(() => log("no Skip intro button"));
      await sleep(600);
      await wake(page);
      await sleep(300);
      await shot(page, "skipintro-desktop");
      await context.close();
    }
    if (want("party")) {
      const host = await newPage(browser, env, DESKTOP, dana);
      const page = host.page;
      await open(page, env, "#/movies");
      await open(page, env, `#/play/${env.lib.films["Salt & Ember"].id}`, "#app .player video");
      await playing(page);
      await wake(page);
      await page.click('.player .pbtn[aria-label="Watch together"]');
      await page.click('.player [data-ui="player.party.start"]');
      await page.waitForSelector(".player .party-code");
      const code = (await page.textContent(".player .party-code")).replace(/\s/g, "");
      const guests = [];
      for (const who of ["Avi", "Noa"]) {
        const g = await newPage(browser, env, { viewport: { width: 1024, height: 640 } }, env.people[who]);
        await open(g.page, env, `#/party/${code}`, "#app .player video");
        guests.push(g);
      }
      await sleep(5000);
      await page.evaluate(() => document.querySelector(".player video").pause());
      await sleep(1200);
      await wake(page);
      if (!(await page.locator(".player .party-panel:not(.hidden)").count())) await page.click(".player .party-pill").catch(() => {});
      await sleep(900);
      await shot(page, "party-desktop");
      for (const g of guests) await g.context.close();
      await host.context.close();
    }
    if (want("remote")) {
      const tv = new SimTV({ url: env.srv.url, profile: dana, name: "Living room TV" });
      await tv.start();
      const { context, page } = await newPage(browser, env, PHONE, dana);
      try {
        await open(page, env, `#/movie/${copper.id}`, ".rm-playon:not([hidden])");
        await settle(page, 600);
        await page.locator(".rm-playon").click();
        await page.waitForSelector('.remote-screen[data-state="playing"]');
        await settle(page, 2200);
        await shot(page, "remote-phone");
      } finally {
        await context.close();
        await tv.stop();
      }
    }
  } finally {
    await browser.close();
    if (process.argv.includes("--keep")) {
      log(`keeping the instance: ${env.srv.url} (Dana ${dana.id}) — CTRL-C ends it`);
      await new Promise(() => {});
    }
    await env.srv.stop();
  }
};

main().catch((e) => { console.error(e.stack || e); process.exit(1); });

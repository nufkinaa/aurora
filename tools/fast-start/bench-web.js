#!/usr/bin/env node
// Home's first screen on the website, timed: how long a returning visitor's
// reload takes to show Home's shelves, and how many cards on screen change
// place when the server's newer answer arrives (the fast-start work,
// docs/qa/fast-start/REPORT.md).
//
//   node tools/fast-start/bench-web.js [--repo <dir>] [--runs 5] [--lines fast,slow3g] [--out file.json]
//
// --repo: the Aurora tree to time (default: this one). To time another build
// — the code before a change — extract it somewhere and point at it; its own
// scripts/ui-test-server.js starts its own private instance.
//
// For each line and run, in a fresh browser (real Chrome, playwright-core):
//   1. the first visit: Home answers at once (answer A) — the browser keeps
//      whatever it keeps;
//   2. a reload, the server's next answer (B: shelves re-ranked, a new shelf
//      on top, one shelf gone, a NEW tag) arriving after the time the line
//      takes to bring it (the round trip, the compressed size at the line's
//      speed, the server's compose time).
// Everything else — the page, its code, the pictures, the boot questions —
// goes through tools/throttle-proxy.js at the line's speed.
//
// Measured, from the reload's navigation start (performance.now()):
//   cards      the first shelf card is in the page
//   lcp        largest contentful paint
//   answer     /api/home's answer has arrived
//   moved      cards on screen whose slot holds another title (or that moved)
//              after the answer, compared with just before it
//
// Private instance only: the live server is never contacted.
"use strict";
const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]] : a), []),
);
const REPO = path.resolve(args.repo || path.join(__dirname, "..", ".."));
const RUNS = Number(args.runs || 5);
const LINES = String(args.lines || "fast,busy,slow3g").split(",");
const HERE = path.join(__dirname, "..", "..");

// The lines. slow3g: Chrome's "Slow 3G" (400 kbps, 400 ms round trip).
// busy: a fast line to a server that takes 1.5 s over Home (after a restart,
// under load, a far server: /api/home is the heaviest answer it makes).
const LINE = {
  fast: { down: 0, up: 0, latency: 0, handshake: 0, server: 0 },
  busy: { down: 0, up: 0, latency: 0, handshake: 0, server: 1500 },
  slow3g: { down: 400, up: 400, latency: 200, handshake: 1, server: 0 },
};
// /api/home for a household profile (2026-10-19): ~160 KB, ~30 KB brotli;
// the server composes it in 20–50 ms.
const HOME_BR_BYTES = 30 * 1024;
const COMPOSE_MS = 40;
// (served by page.route, so it does not share the line with the page's code:
// on slow3g this flatters the answer's arrival — both builds alike)
const answerDelay = (l) => COMPOSE_MS + (l.server || 0) + 2 * l.latency + (l.down ? (HOME_BR_BYTES * 8) / l.down : 0);

const { start } = require(path.join(REPO, "scripts", "ui-test-server.js"));
const { makeApi, describeLibrary, launchBrowser } = require(path.join(HERE, "test", "ui", "helpers.js"));
const proxy = require(path.join(HERE, "tools", "throttle-proxy.js"));

const ROW_IDS = ["recs", "because", "new-movies", "trending", "upcoming", "genre-drama", "genre-comedy", "genre-crime", "genre-action", "genre-adventure", "genre-thriller", "movies", "next-watch", "stretch", "recent", "upcoming-2"];
const answers = (lib) => {
  const covers = [lib.film1.cover, lib.film2.cover, lib.film3 && lib.film3.cover, lib.show.cover].filter(Boolean);
  const item = (rowId, i, extra = {}) => ({
    id: `fake-${rowId}-${i}`, type: i % 3 ? "movie" : "show", title: `${rowId.toUpperCase()} Title ${i}`, year: 2000 + (i % 20),
    cover: covers[i % covers.length], genres: ["Drama", "Thriller"], rating: 7.1,
    synopsis: "A synopsis of about the length the catalogue carries, so the answer is the size the household's is. ".repeat(2),
    ...extra,
  });
  const hero = [lib.film1, lib.film2, lib.show].map((x) => ({ id: x.id, type: x.seasons ? "show" : "movie", title: x.title, year: x.year, cover: x.cover, backdrop: x.backdrop || null }));
  const A = { hero, rows: ROW_IDS.map((id) => ({ id, title: `Shelf ${id}`, items: Array.from({ length: 21 }, (_, i) => item(id, i)) })) };
  const rows = A.rows.map((r) => ({ ...r, items: r.items.slice() }));
  rows[0].items.reverse();
  rows[1].items.reverse();
  rows[0].items[3] = { ...rows[0].items[3], badge: { text: "NEW", tone: "new" } };
  const [r0, r1, , ...rest] = rows;
  const B = { hero, rows: [{ id: "party", title: "Shelf party", items: Array.from({ length: 6 }, (_, i) => item("party", i)) }, r0, r1, ...rest.reverse()] };
  return { A, B };
};

const OBSERVE = () => {
  window.__bench = { cards: null, lcp: 0, before: null };
  new MutationObserver((_, obs) => {
    if (document.querySelector("#app [data-row-id] .card")) {
      window.__bench.cards = performance.now();
      obs.disconnect();
    }
  }).observe(document, { childList: true, subtree: true });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__bench.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
};
const VIEW = () => {
  const vh = innerHeight;
  const vw = innerWidth;
  const out = [];
  for (const row of document.querySelectorAll("#app [data-row-id]")) {
    const r = row.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || !r.height) continue;
    [...row.querySelectorAll(".row-scroller > .card")].forEach((c, i) => {
      const b = c.getBoundingClientRect();
      if (b.width > 0 && b.right > 0 && b.left < vw) out.push(`${row.dataset.rowId}|${i}|${(c.getAttribute("aria-label") || "").split(",")[0]}|${Math.round(b.left)}|${Math.round(b.top)}`);
    });
  }
  return out;
};

const once = async (browser, srv, port, lib, lineName, viewport) => {
  const line = LINE[lineName];
  const api = srv.api;
  const me = await api.createProfile(`B${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, { open: true });
  const context = await browser.newContext({ viewport, serviceWorkers: "block", ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript(({ id }) => {
    try {
      if (!sessionStorage.getItem("bench-seeded")) {
        sessionStorage.setItem("bench-seeded", "1");
        localStorage.setItem("aurora-profile", id);
        localStorage.setItem("aurora-kbd-hint", "1");
        localStorage.setItem("aurora-nav-hinted", "1");
      }
    } catch {}
  }, { id: me.id });
  await context.addInitScript(OBSERVE);
  const page = await context.newPage();
  const { A, B } = answers(lib);
  const st = { body: A, delay: 0, answeredAt: 0 };
  await page.route(/\/api\/home\?/, async (route) => {
    const body = JSON.stringify(st.body);
    if (st.delay) await new Promise((r) => setTimeout(r, st.delay));
    st.answeredAt = Date.now();
    await route.fulfill({ status: 200, contentType: "application/json", body }).catch(() => {});
  });
  const origin = `http://127.0.0.1:${port}`;
  // 1. the first visit, at the line's speed, Home at once
  await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app [data-row-id] .card", { timeout: 60000 });
  await page.waitForTimeout(2500); // the page's idle work (and whatever it keeps)
  // 2. the reload, the next answer on its way
  st.body = B;
  st.delay = Math.round(answerDelay(line));
  st.answeredAt = 0;
  await page.reload({ waitUntil: "domcontentloaded" });
  // just before the answer: what is on screen
  const before = await (async () => {
    const t0 = Date.now();
    let v = [];
    while (!st.answeredAt && Date.now() - t0 < 60000) {
      v = await page.evaluate(VIEW).catch(() => v);
      await new Promise((r) => setTimeout(r, 40));
    }
    return v;
  })();
  await page.waitForSelector("#app [data-row-id] .card", { timeout: 60000 });
  for (const t0 = Date.now(); !st.answeredAt && Date.now() - t0 < 30000; ) await new Promise((r) => setTimeout(r, 50));
  await page.waitForTimeout(1200);
  const after = await page.evaluate(VIEW);
  const m = await page.evaluate(() => {
    const res = performance.getEntriesByType("resource").find((e) => /\/api\/home\?/.test(e.name));
    return { cards: window.__bench.cards, lcp: window.__bench.lcp, answer: res ? res.responseEnd : null, src: (document.querySelector("#app .screen") || {}).dataset?.homeSrc || null };
  });
  // moved: slots on screen before the answer whose title or place is not the same after it
  const afterSet = new Set(after);
  const moved = before.length ? before.filter((x) => !afterSet.has(x)).length : 0;
  await context.close();
  return { ...m, moved, onScreenBefore: before.length };
};

// Back to Home from another page while the server's answer has changed: the
// page paints the answer it kept in memory, then the new one lands — the
// moment the old code rebuilt every changed shelf under the viewer's eyes.
const onceReturn = async (browser, srv, lib, viewport) => {
  const me = await srv.api.createProfile(`R${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, { open: true });
  const context = await browser.newContext({ viewport, serviceWorkers: "block", ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript(({ id }) => {
    try {
      localStorage.setItem("aurora-profile", id);
      localStorage.setItem("aurora-kbd-hint", "1");
      localStorage.setItem("aurora-nav-hinted", "1");
    } catch {}
  }, { id: me.id });
  const page = await context.newPage();
  const { A, B } = answers(lib);
  const st = { body: A, delay: 0, answeredAt: 0 };
  await page.route(/\/api\/home\?/, async (route) => {
    const body = JSON.stringify(st.body);
    if (st.delay) await new Promise((r) => setTimeout(r, st.delay));
    st.answeredAt = Date.now();
    await route.fulfill({ status: 200, contentType: "application/json", body }).catch(() => {});
  });
  await page.goto(`${srv.url}/#/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app [data-row-id] .card", { timeout: 60000 });
  await page.evaluate(() => {
    const r = document.querySelector('#app [data-row-id="recs"]');
    window.scrollTo({ top: Math.max(0, r.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.25), behavior: "instant" });
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { location.hash = "#/movies"; });
  await page.waitForTimeout(1200);
  st.body = B;
  st.delay = 1500;
  st.answeredAt = 0;
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForSelector("#app [data-row-id] .card", { timeout: 60000 });
  await page.waitForTimeout(400);
  let before = [];
  const t0 = Date.now();
  while (!st.answeredAt && Date.now() - t0 < 15000) {
    before = await page.evaluate(VIEW).catch(() => before);
    await new Promise((r) => setTimeout(r, 40));
  }
  await page.waitForTimeout(1200);
  const after = new Set(await page.evaluate(VIEW));
  await context.close();
  return { moved: before.filter((x) => !after.has(x)).length, onScreenBefore: before.length };
};

const median = (a) => {
  const v = a.filter((x) => typeof x === "number").sort((x, y) => x - y);
  return v.length ? Math.round(v[Math.floor((v.length - 1) / 2)]) : null;
};

(async () => {
  const srv = await start({});
  srv.api = makeApi(srv);
  const lib = await describeLibrary(srv.api);
  const browser = await launchBrowser();
  const out = { repo: REPO, runs: RUNS, at: new Date().toISOString(), results: {} };
  try {
    for (const lineName of LINES) {
      const l = LINE[lineName];
      const p = await proxy.start({ listen: 0, host: "127.0.0.1", to: srv.port, down: l.down, up: l.up, latency: l.latency, handshake: l.handshake, quiet: true });
      try {
        for (const [vpName, viewport] of [["desktop", { width: 1280, height: 720 }], ["phone", { width: 390, height: 844 }]]) {
          const runs = [];
          for (let i = 0; i < RUNS; i++) runs.push(await once(browser, srv, p.port, lib, lineName, viewport));
          const key = `${lineName}/${vpName}`;
          out.results[key] = {
            cards: median(runs.map((r) => r.cards)),
            lcp: median(runs.map((r) => r.lcp)),
            answer: median(runs.map((r) => r.answer)),
            moved: median(runs.map((r) => r.moved)),
            movedMax: Math.max(...runs.map((r) => r.moved)),
            src: [...new Set(runs.map((r) => r.src))].join("|"),
            runs,
          };
          console.log(key, JSON.stringify({ cards: out.results[key].cards, lcp: out.results[key].lcp, answer: out.results[key].answer, moved: out.results[key].moved, movedMax: out.results[key].movedMax, src: out.results[key].src }));
        }
      } finally {
        await p.close();
      }
    }
    for (const [vpName, viewport] of [["desktop", { width: 1280, height: 720 }], ["phone", { width: 390, height: 844 }]]) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(await onceReturn(browser, srv, lib, viewport));
      const key = `return/${vpName}`;
      out.results[key] = { moved: median(runs.map((r) => r.moved)), movedMax: Math.max(...runs.map((r) => r.moved)), onScreen: median(runs.map((r) => r.onScreenBefore)), runs };
      console.log(key, JSON.stringify({ moved: out.results[key].moved, movedMax: out.results[key].movedMax, onScreen: out.results[key].onScreen }));
    }
  } finally {
    await browser.close().catch(() => {});
    await srv.stop();
  }
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

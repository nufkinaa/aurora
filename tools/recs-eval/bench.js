#!/usr/bin/env node
// The recommender end to end, in a PRIVATE copy of the server (src/ copied to
// a temp root with its own config.json and data/, the way the queue tests do
// it) — so nothing here can read or write the real data/ or reach the live
// server. What it measures and shows:
//
//   * index load + vector build: time and memory on the real title index
//   * GET /api/home per synthetic profile: first (cold) and repeat latency,
//     and the same request with the recommender switched off (the old path)
//   * the rows themselves, with titles — these profiles are personas
//   * invariants: no title twice across the personalised rows, nothing the
//     profile has watched, identical output within the day
//   * /api/discover/similar with NO TMDB key (the title-index fallback) and
//     with ?profile=
//
//   node tools/recs-eval/bench.js [--rows] [--kids 7]
//
// Needs data/cache/recs-titles.json (build-index.js). Makes no network calls:
// the private copy has no TMDB key and fetch is refused.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..", "..");
const flag = (n) => process.argv.includes(`--${n}`);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-recs-bench-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  for (const f of ["recs-titles.json", "discover.json", "availability.json", "certificates.json"]) {
    const from = path.join(REPO, "data", "cache", f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(root, "data", "cache", f));
  }
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [], shows: [] }, onlineMetadata: false, skipDatabases: false,
    autoOcrSubtitles: false, notifications: {}, authMode: "open",
  }));
  delete process.env.TMDB_API_KEY;
  const realFetch = global.fetch;
  global.fetch = async (url, ...rest) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, ...rest);
    throw new Error("network is not allowed in the bench");
  };
  const S = (p) => require(path.join(root, "src", p));
  const config = S("config");
  if (!config.DATA_DIR.startsWith(root)) throw new Error("not in the private root");

  const scanner = S("media/scanner");
  // the library, as title cards (no files): what build-index.js saved
  try {
    const lib = JSON.parse(fs.readFileSync(path.join(REPO, "data", "recs-eval-library.json"), "utf8"));
    scanner.index.movies = lib.filter((i) => i.type === "movie").map((i) => ({ ...i, addedAt: 1 }));
    scanner.index.shows = lib.filter((i) => i.type === "show").map((i) => ({ ...i, seasons: [], addedAt: 1 }));
    scanner.index.scannedAt = Date.now();
  } catch {}

  const mem0 = process.memoryUsage();
  const recs = S("media/recs");
  const titleindex = S("media/recs/titleindex");
  let t = process.hrtime.bigint();
  const n = titleindex.size();
  const loadMs = Number(process.hrtime.bigint() - t) / 1e6;
  t = process.hrtime.bigint();
  await recs.warm();
  const buildMs = Number(process.hrtime.bigint() - t) / 1e6;
  if (global.gc) global.gc();
  const mem1 = process.memoryUsage();
  const mb = (x) => (x / 1048576).toFixed(1);
  console.log(`index: ${n} titles; read from disk ${loadMs.toFixed(0)} ms (${mb(fs.statSync(path.join(root, "data", "cache", "recs-titles.json")).size)} MB file); vectors built in ${buildMs.toFixed(0)} ms`);
  console.log(`memory: heap ${mb(mem0.heapUsed)} -> ${mb(mem1.heapUsed)} MB (+${mb(mem1.heapUsed - mem0.heapUsed)}), rss ${mb(mem0.rss)} -> ${mb(mem1.rss)} MB`);

  // synthetic profiles from the personas
  const profiles = S("profiles");
  const personas = require("./personas");
  const resolved = JSON.parse(fs.readFileSync(path.join(__dirname, "personas.resolved.json"), "utf8"));
  // a shared profile's two histories are interleaved in time, as two people's viewing would be
  const zip = (lists) => { const out = []; for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]); return out; };
  const idsOf = (p) => (p.mix ? zip(p.mix.map((m) => idsOf(personas.find((x) => x.id === m)))) : p.titles.map(([title, year, kind]) => (resolved[`${kind}|${title}|${year}`] || {}).imdbId).filter(Boolean));
  const DAY = 86400000;
  const store = profiles._internals.store;
  const made = [];
  for (const p of personas) {
    const id = `bench-${p.id}`.slice(0, 40);
    store.data.profiles.push({ id, name: p.name, color: "#888", avatar: "x" });
    const st = profiles.stateOf(id);
    const ids = idsOf(p);
    ids.forEach((imdbId, i) => {
      const at = Date.now() - (ids.length - i) * 9 * DAY;
      const rec = titleindex.get(imdbId);
      if (rec && rec.k === "tv") for (let e = 1; e <= 8; e++) st.titles[`${imdbId}:1:${e}`] = { position: 3000, duration: 3000, finished: true, updatedAt: at - (8 - e) * 2 * DAY };
      else st.titles[imdbId] = { position: 6000, duration: 6000, finished: true, updatedAt: at };
    });
    made.push({ id, p, ids });
  }
  // a brand-new profile that only picked genres, and one with nothing at all
  store.data.profiles.push({ id: "bench-newcomer", name: "Newcomer (picked Sci-Fi + Comedy)", color: "#888", avatar: "x" });
  profiles.stateOf("bench-newcomer").likedGenres = ["Sci-Fi", "Comedy"];
  made.push({ id: "bench-newcomer", p: { name: "Newcomer: no history, picked Sci-Fi + Comedy in Settings" }, ids: [] });
  const kidsAge = parseInt(arg("kids", "7"), 10);
  store.data.profiles.push({ id: "bench-kid", name: "Kid", color: "#888", avatar: "x", kids: { maxAge: kidsAge } });
  const kidIds = idsOf(personas.find((x) => x.id === "family-animation"));
  kidIds.forEach((imdbId, i) => { profiles.stateOf("bench-kid").titles[imdbId] = { position: 6000, duration: 6000, finished: true, updatedAt: Date.now() - i * 5 * DAY }; });
  made.push({ id: "bench-kid", p: { name: `Kids profile (limit ${kidsAge}+) with the family-animation history` }, ids: kidIds, kid: true });

  const express = S("../node_modules/express");
  const app = express();
  app.use(express.json());
  app.use(S("routes/api"));
  app.use(S("routes/requests"));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const timed = async (url) => {
    const t0 = process.hrtime.bigint();
    const r = await realFetch(base + url);
    const body = await r.json();
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, body };
  };

  const PERSONAL = /^(recommended|because-|theme-|person-|stretch$|next-watch$|liked-)/;
  const cold = []; // the rows are re-ranked (model + scoring + rows): a new signal arrived
  const warm = []; // served from the per-profile cache: every other visit
  let violations = 0;
  // "a new signal arrived": the profile's model and rows are rebuilt; what does
  // not depend on the person (the candidate list of the day) stays cached
  const dropPersonal = () => { for (const k of [...recs._internals.caches.keys()]) if (k.startsWith("rows|") || k.startsWith("model|") || k.startsWith("house|")) recs._internals.caches.delete(k); };
  // warm the JIT so the numbers are steady-state, not first-call
  for (const m of made.slice(0, 3)) { await timed(`/api/home?profile=${m.id}`); }
  for (const m of made) {
    dropPersonal();
    const first = await timed(`/api/home?profile=${m.id}`);
    const again = await timed(`/api/home?profile=${m.id}`);
    const third = await timed(`/api/home?profile=${m.id}&slim=1`);
    cold.push(first.ms);
    warm.push(again.ms, third.ms);
    for (let k = 0; k < 2; k++) {
      dropPersonal();
      cold.push((await timed(`/api/home?profile=${m.id}`)).ms);
      warm.push((await timed(`/api/home?profile=${m.id}`)).ms);
    }
    const rows = first.body.rows.filter((r) => PERSONAL.test(r.id));
    // invariants
    const seen = new Set();
    let dup = 0;
    let watched = 0;
    for (const r of rows) for (const i of r.items) {
      const key = i.imdbId || i.id;
      if (seen.has(key)) dup++;
      seen.add(key);
      if (m.ids.includes(i.imdbId)) watched++;
    }
    const same = JSON.stringify(first.body) === JSON.stringify(again.body);
    if (dup || watched || !same) violations++;
    console.log(`\n${m.p.name}`);
    console.log(`  /api/home ${first.ms.toFixed(0)} ms re-ranked, ${again.ms.toFixed(0)} ms cached, ${third.ms.toFixed(0)} ms slim; ${first.body.rows.length} rows (${rows.length} personalised); repeats ${dup}; watched ${watched}; stable ${same}`);
    if (flag("rows")) {
      for (const r of rows) {
        console.log(`  [${r.id}] ${r.title}${r.sub ? `  (${r.sub})` : ""}`);
        console.log(`      ${r.items.slice(0, 10).map((i) => `${i.title} (${i.year || "?"})`).join(" | ")}`);
      }
      const rec = rows.find((r) => r.id === "recommended");
      if (rec) console.log(`      why: ${rec.items.slice(0, 3).map((i) => `${i.title} ← ${i.why || "-"}`).join("; ")}`);
    }
    if (m.kid) {
      const certs = S("media/discover");
      const over = rows.flatMap((r) => r.items).filter((i) => { const a = certs.certificateAge(i.imdbId); return a == null || a > kidsAge; });
      console.log(`  kids check: ${rows.flatMap((r) => r.items).length} titles in personalised rows, ${over.length} without a known rating at or under ${kidsAge}`);
      if (over.length) violations++;
    }
  }
  const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))].toFixed(0);
  console.log(`\n/api/home over ${made.length} profiles (${cold.length} + ${warm.length} requests):`);
  console.log(`  re-ranked (a new signal arrived): median ${pct(cold, 0.5)} ms, p90 ${pct(cold, 0.9)} ms, worst ${pct(cold, 1)} ms`);
  console.log(`  cached (every other visit):       median ${pct(warm, 0.5)} ms, p90 ${pct(warm, 0.9)} ms, worst ${pct(warm, 1)} ms`);

  // the old path, for comparison: the recommender not ready
  recs._internals.state.gen = 0;
  const realWarm = recs._internals.state.stamp;
  recs._internals.state.building = new Promise(() => {}); // hold it "building"
  const old = [];
  for (let k = 0; k < 3; k++) for (const m of made) old.push((await timed(`/api/home?profile=${m.id}`)).ms);
  console.log(`  the old path (recommender off):   median ${pct(old, 0.5)} ms, p90 ${pct(old, 0.9)} ms, worst ${pct(old, 1)} ms`);
  recs._internals.state.building = null;
  recs._internals.state.gen = 1;
  recs._internals.state.stamp = realWarm;

  // more like this without TMDB: the title-index fallback, then per profile
  const probe = idsOf(personas.find((x) => x.id === "heists-cons"))[0];
  const plain = await timed(`/api/discover/similar/movie/${probe}`);
  const personal = await timed(`/api/discover/similar/movie/${probe}?profile=bench-heists-cons`);
  const name = (titleindex.get(probe) || {}).title;
  console.log(`\nMore like this, no TMDB key — "${name}": source "${plain.body.source}", ${plain.body.items.length} items in ${plain.ms.toFixed(0)} ms`);
  console.log(`  ${plain.body.items.slice(0, 10).map((i) => i.title).join(" | ")}`);
  console.log(`  for the heist persona (personalised=${!!personal.body.personalised}, ${personal.ms.toFixed(0)} ms): ${personal.body.items.slice(0, 10).map((i) => i.title).join(" | ")}`);
  const leaked = personal.body.items.filter((i) => made.find((m) => m.id === "bench-heists-cons").ids.includes(i.imdbId)).length;
  console.log(`  already-watched titles in the personalised row: ${leaked}`);
  if (leaked) violations++;

  console.log(`\ninvariant violations: ${violations}`);
  server.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(violations ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

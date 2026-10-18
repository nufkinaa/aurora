#!/usr/bin/env node
// A realistically sized household for the private instance: a library of
// 1,000-2,000 files, eight profiles with years of history, and the caches at
// the sizes the live server's data folder has (read for their SIZES AND SHAPES
// only on 2026-10-11 — every value here is synthetic, nothing personal is
// copied). Built once per shape under EFF_WORK and reused.
//
//   node tools/backend-perf/dataset.js [--films 1200] [--shows 60] [--episodes 10]
//                                      [--profiles 8] [--rows 1500] [--usage-mb 0.5]
//
//   const ds = require("./dataset").build({ films: 1200, shows: 60 });
//   ds.library = { movies, shows }   folders (hard links of ONE tiny file)
//   ds.seedDir                       a ready data/ folder (copied into each instance)
//   ds.sessions[i] = { profileId, sid }
//
// Sizes it is modelled on (live data folder, 2026-10-11):
//   profiles.json 62 KB today (5 profiles, 44 rows the busiest) — the default
//     here is "a year or two on": 8 profiles x up to 1,500 rows = about 3 MB
//   sessions.json 19 KB / 76 sessions      watch-sessions.json 93 KB / 269 (cap 8,000)
//   telemetry-hours.json 106 KB / 992 hours (cap 90 days = 2,160)
//   cache/discover.json 183 KB (198 films + 200 shows)
//   cache/meta.json 1.57 MB / 108 titles   cache/torrent-streams.json 3.0 MB / 228 titles
//   cache/similar.json 467 KB / 59 rows    cache/xray.json 155 KB / 26 titles
//   cache/certificates.json 64 KB / 650    cache/availability.json 39 KB / 358
//   usage/events-<month>.jsonl 0.46 MB     metadata-cache.json 188 KB / 293 files
//   cache/recs-titles.json: 2,418 titles = 3.6 MB (titleindex.js's own figure)
//   cache/search-known.json: 5,000 titles (wellknown.js DEPTH)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { WORK, which, rng, arg } = require("./lib");

const FFMPEG = which("ffmpeg");
const W1 = ["Silent", "Broken", "Golden", "Last", "Hidden", "Crimson", "Electric", "Paper", "Midnight", "Northern", "Hollow", "Burning", "Quiet", "Wild", "Glass", "Iron", "Distant", "Velvet", "Frozen", "Lucky", "Scarlet", "Bitter", "Gentle", "Savage", "Borrowed", "Final", "Secret", "Lonely", "Restless", "Painted"];
const W2 = ["River", "Empire", "Garden", "Signal", "Harbor", "Kingdom", "Mirror", "Orchard", "Station", "Voyage", "Shadow", "Promise", "Engine", "Theory", "Summer", "Witness", "Machine", "Canyon", "Lantern", "Parade", "Winter", "Compass", "Ocean", "Letter", "Thunder", "Circus", "Bridge", "Island", "Motel", "Orbit"];
const W3 = ["", " Returns", " Rising", " Legacy", " Reborn", " Unbound", " Protocol", " Affair"];
const GENRES = ["Drama", "Comedy", "Action", "Thriller", "Crime", "Adventure", "Sci-Fi", "Romance", "Mystery", "Animation", "Horror", "Family", "Fantasy", "Documentary", "History"];
const NAMES = ["Ava Stone", "Liam Park", "Noa Levi", "Omar Haddad", "Mia Chen", "Ethan Cole", "Sara Klein", "Jonas Berg", "Lena Fox", "Tariq Aziz", "Ivy Moreno", "Hugo Laurent", "Nina Petrova", "Kai Tanaka", "Zoe Abrams", "Marco Ricci", "Dana Shapiro", "Felix Braun", "Rosa Diaz", "Yuki Sato"];
const title = (i) => `${W1[i % W1.length]} ${W2[Math.floor(i / W1.length) % W2.length]}${W3[Math.floor(i / (W1.length * W2.length)) % W3.length]}`;
const LOREM = "A synthetic title for the efficiency runs. It carries a synopsis of about the usual length so that every answer and every cache that holds it weighs what it weighs on the real server, give or take a sentence or two of plot.";
const syn = (t) => `${t}: ${LOREM}`;
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const makeId = (kind, rel) => md5(`${kind}|${rel}`).slice(0, 12); // scanner.makeId
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim(); // imdb.js norm

const JIT_NAME = "Zz Repackage Sample (2020)";
const ff = (args) => execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const link = (from, to) => { try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); } };

const buildLibrary = ({ films, shows, episodes }) => {
  const dir = path.join(WORK, `library2-${films}-${shows}x${episodes}`);
  const movies = path.join(dir, "movies");
  const showsDir = path.join(dir, "shows");
  const done = path.join(dir, ".ready");
  if (fs.existsSync(done)) return { dir, movies, shows: showsDir };
  if (!FFMPEG) throw new Error("ffmpeg was not found on PATH (or FFMPEG_PATH)");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(movies, { recursive: true });
  fs.mkdirSync(showsDir, { recursive: true });
  const small = path.join(WORK, "small.mkv");
  const cover = path.join(WORK, "cover.jpg");
  // 6 s of H.264 + AAC with one embedded text subtitle: what a probe has to read.
  if (!fs.existsSync(small)) {
    const srt = path.join(WORK, "small.srt");
    fs.writeFileSync(srt, "1\n00:00:00,000 --> 00:00:02,000\nhello\n\n2\n00:00:02,000 --> 00:00:04,000\nworld\n\n");
    ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6", "-i", srt,
      "-map", "0:v", "-map", "1:a", "-map", "2:0", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-c:s", "srt",
      "-metadata:s:a:0", "language=eng", "-metadata:s:s:0", "language=eng", "-shortest", small]);
  }
  if (!fs.existsSync(cover)) ff(["-f", "lavfi", "-i", "testsrc2=size=600x900:rate=1:duration=1", "-frames:v", "1", "-q:v", "5", cover]);
  const sub = "1\n00:00:00,000 --> 00:00:02,000\nhello\n\n";
  for (let i = 0; i < films; i++) {
    const name = `${title(i)} (${1975 + (i % 50)})`;
    const d = path.join(movies, name);
    fs.mkdirSync(d, { recursive: true });
    link(small, path.join(d, `${name}.mkv`));
    link(cover, path.join(d, "cover.jpg"));
    if (i % 2 === 0) fs.writeFileSync(path.join(d, `${name}.English.srt`), sub);
    if (i % 4 === 0) fs.writeFileSync(path.join(d, `${name}.Hebrew.srt`), sub);
  }
  // One film with what the repackaging path needs: 60 s of MKV with a keyframe
  // every second (so it has an index to cut by) and AC-3 sound (which no
  // browser decodes, so players ask for it repackaged).
  {
    const jit = path.join(WORK, "jit-sample.mkv");
    if (!fs.existsSync(jit)) {
      ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=60", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=60",
        "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-keyint_min", "24", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "ac3", "-b:a", "128k", "-ac", "2",
        "-metadata:s:a:0", "language=eng", "-shortest", jit]);
    }
    const d = path.join(movies, JIT_NAME);
    fs.mkdirSync(d, { recursive: true });
    link(jit, path.join(d, `${JIT_NAME}.mkv`));
    link(cover, path.join(d, "cover.jpg"));
  }
  for (let s = 0; s < shows; s++) {
    const name = `${title(s + 11)} Chronicles`;
    fs.mkdirSync(path.join(showsDir, name), { recursive: true });
    link(cover, path.join(showsDir, name, "cover.jpg"));
    // two seasons, so a season folder holds half the episodes (and their subtitles)
    for (let e = 0; e < episodes; e++) {
      const season = e < Math.ceil(episodes / 2) ? 1 : 2;
      const ep = season === 1 ? e + 1 : e - Math.ceil(episodes / 2) + 1;
      const sd = path.join(showsDir, name, `Season ${season}`);
      fs.mkdirSync(sd, { recursive: true });
      const base = `${name} S0${season}E${String(ep).padStart(2, "0")}`;
      link(small, path.join(sd, `${base}.mkv`));
      if (s % 2 === 0) fs.writeFileSync(path.join(sd, `${base}.English.srt`), sub);
    }
  }
  fs.writeFileSync(done, new Date().toISOString());
  return { dir, movies, shows: showsDir };
};

// ---------- the data folder ----------
const build = (opts = {}) => {
  const films = +(opts.films ?? 1200);
  const shows = +(opts.shows ?? 60);
  const episodes = +(opts.episodes ?? 10);
  const nProfiles = +(opts.profiles ?? 8);
  const rows = +(opts.rows ?? 1500);
  const usageMb = +(opts.usageMb ?? 0.5);
  const lib = buildLibrary({ films, shows, episodes });
  const key = `seed3-${films}-${shows}x${episodes}-p${nProfiles}-r${rows}-u${usageMb}`;
  const seedDir = path.join(WORK, key);
  const infoFile = path.join(seedDir, ".dataset.json");
  const blurReady = path.join(WORK, `blur2-${films}-${shows}x${episodes}`);
  if (fs.existsSync(infoFile) && fs.existsSync(path.join(blurReady, ".ready")) && !opts.rebuild) return { ...JSON.parse(fs.readFileSync(infoFile, "utf8")), library: { movies: lib.movies, shows: lib.shows }, seedDir, blurDir: blurReady };
  fs.rmSync(seedDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(seedDir, "cache"), { recursive: true });
  fs.mkdirSync(path.join(seedDir, "usage"), { recursive: true });
  const R = rng(20261011);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const hex = (n) => Array.from({ length: n }, () => Math.floor(R() * 16).toString(16)).join("");
  const now = Date.now();
  const DAY = 86400000;
  const write = (rel, value) => fs.writeFileSync(path.join(seedDir, rel), typeof value === "string" ? value : JSON.stringify(value));

  // --- what is on disk, with the ids the scanner will give it
  const lf = [];
  for (let i = 0; i < films; i++) {
    const t = title(i);
    const year = 1975 + (i % 50);
    const name = `${t} (${year})`;
    lf.push({ type: "movie", title: t, year, imdbId: `tt1${String(i).padStart(6, "0")}`, id: makeId("video", path.join(name, `${name}.mkv`)), abs: path.join(lib.movies, name, `${name}.mkv`) });
  }
  const ls = [];
  for (let s = 0; s < shows; s++) {
    const t = `${title(s + 11)} Chronicles`;
    const eps = [];
    for (let e = 0; e < episodes; e++) {
      const season = e < Math.ceil(episodes / 2) ? 1 : 2;
      const ep = season === 1 ? e + 1 : e - Math.ceil(episodes / 2) + 1;
      const rel = path.join(t, `Season ${season}`, `${t} S0${season}E${String(ep).padStart(2, "0")}.mkv`);
      eps.push({ season, episode: ep, id: makeId("video", rel), abs: path.join(lib.shows, rel) });
    }
    ls.push({ type: "show", title: t, year: null, imdbId: `tt2${String(s).padStart(6, "0")}`, id: makeId("show", t), eps });
  }

  const imdbMap = {};
  for (const f of lf) imdbMap[`movie|${norm(f.title)}|${f.year}`] = { imdbId: f.imdbId, at: now };
  for (const s of ls) imdbMap[`show|${norm(s.title)}|`] = { imdbId: s.imdbId, at: now };
  write("imdb-map.json", imdbMap);

  const online = {};
  for (const it of [...lf, ...ls]) {
    online[`${it.type}|${it.title.toLowerCase().trim()}`] = {
      matchedTitle: it.title, genres: [pick(GENRES), pick(GENRES), pick(GENRES)], synopsis: syn(it.title), rating: Math.round((5 + R() * 4) * 10) / 10,
      certificate: pick(["PG", "PG-13", "R", "12+", "16+"]), year: it.year || 2000 + Math.floor(R() * 25), poster: null, fetchedAt: now - 3600e3, checkedAt: now - 3600e3,
    };
  }
  write("online-metadata.json", online);

  // --- the catalogue (discover.json v3): a quarter of it is also in the library
  const card = (type, i) => {
    const own = i % 4 === 0 ? (type === "movie" ? lf[(i * 7) % Math.max(1, lf.length)] : ls[(i * 3) % Math.max(1, ls.length)]) : null;
    const id = own ? own.imdbId : `tt9${type === "movie" ? 1 : 2}${String(i).padStart(5, "0")}`;
    const name = own ? own.title : `${title(i * 13 + 400)} ${type === "movie" ? "Story" : "Files"}`;
    return {
      type, title: name, year: own && own.year ? own.year : 2000 + (i % 26),
      poster: `https://images.metahub.space/poster/small/${id}/img`, backdrop: `https://images.metahub.space/background/medium/${id}/img`,
      synopsis: syn(name), rating: 5 + ((i * 7) % 40) / 10, genres: [GENRES[i % GENRES.length], GENRES[(i * 5 + 3) % GENRES.length]], imdbId: id, inLibrary: null,
    };
  };
  const uniq = (list) => { const seen = new Set(); return list.filter((c) => !seen.has(c.imdbId) && seen.add(c.imdbId)); };
  const cat = { fetchedAt: now, v: 3, movies: uniq(Array.from({ length: 198 }, (_, i) => card("movie", i))), shows: uniq(Array.from({ length: 200 }, (_, i) => card("show", i))) };
  write("cache/discover.json", cat);
  const catAll = [...cat.movies, ...cat.shows];

  // --- title-page metadata for everything on disk + part of the catalogue (meta.json, META_V 4)
  const meta = {};
  const metaOf = (it, isShow, nEps) => ({
    id: it.imdbId, type: isShow ? "show" : "movie", imdbId: it.imdbId, title: it.title, year: it.year || 2015,
    poster: `https://images.metahub.space/poster/small/${it.imdbId}/img`, backdrop: `https://images.metahub.space/background/medium/${it.imdbId}/img`,
    logo: `https://images.metahub.space/logo/medium/${it.imdbId}/img`, synopsis: syn(it.title), genres: [pick(GENRES), pick(GENRES)], rating: 7.1, runtime: "112 min",
    cast: [pick(NAMES), pick(NAMES), pick(NAMES), pick(NAMES)], director: pick(NAMES),
    seasons: isShow ? [1, 2, 3].map((n) => ({ number: n, episodes: Array.from({ length: nEps }, (_, e) => ({ season: n, episode: e + 1, title: `${pick(W1)} ${pick(W2)}`, overview: `${it.title} ${n}x${e + 1}: ${LOREM}`, thumbnail: `https://episodes.metahub.space/${it.imdbId}/${n}/${e + 1}/w780.jpg`, released: "2021-03-04T00:00:00.000Z" })) })) : null,
    episodeCount: isShow ? nEps * 3 : null, tmdbId: 100000 + Math.floor(R() * 800000), trailers: ["dQw4w9WgXcQ"], certificate: "12+", kidsAge: 12, originalLanguage: "en",
  });
  for (const f of lf) meta[`movie|${f.imdbId}`] = { at: now, v: 4, data: metaOf(f, false) };
  for (const s of ls) meta[`series|${s.imdbId}`] = { at: now, v: 4, data: metaOf(s, true, 12) };
  for (const c of catAll.filter((c, i) => i % 5 === 0)) meta[`${c.type === "show" ? "series" : "movie"}|${c.imdbId}`] = { at: now, v: 4, data: metaOf(c, c.type === "show", 10) };
  write("cache/meta.json", meta);

  // --- age ratings (650 live): library + catalogue
  const certs = {};
  for (const it of [...lf.slice(0, 400), ...ls, ...catAll.slice(0, 250)]) {
    const age = pick([0, 7, 12, 12, 16, 18]);
    certs[it.imdbId] = { c: age === 0 ? "ALL" : `${age}+`, a: age, t: it.type === "show" ? "show" : "movie", n: norm(it.title), y: it.year || null, at: now, v: 2 };
  }
  write("cache/certificates.json", certs);

  // --- stream source lists (torrent-streams.json: 228 titles x ~45 rows = 3 MB)
  const streams = {};
  for (let i = 0; i < 228; i++) {
    const c = catAll[i % catAll.length];
    streams[`${c.type === "show" ? "series" : "movie"}|${c.imdbId}${c.type === "show" ? `:1:${(i % 8) + 1}` : ""}`] = {
      // as on the live server (228 lists, 12 of them under six hours old, the median 73 days):
      // one in nineteen is fresh, the rest are from the last eighty days
      at: i % 19 === 0 ? now - Math.floor(R() * 5 * 3600e3) : now - Math.floor((1 + R() * 79) * DAY), v: 4,
      streams: Array.from({ length: 45 }, (_, k) => ({
        infoHash: hex(40), fileIdx: k % 3, filename: `${c.title.replace(/ /g, ".")}.${c.year}.1080p.WEB-DL.DDP5.1.H.264-GRP${k}.mkv`,
        release: `${c.title.replace(/ /g, ".")}.${c.year}.1080p.WEB-DL.DDP5.1.H.264-GRP${k}`, provider: "Provider", quality: "1080p", qualityLabel: "1080p",
        tags: ["WEB-DL", "DDP5.1", "H.264"], cam: false, dubbed: false, seeders: Math.floor(R() * 900), sizeString: "4.2 GB", sizeBytes: 4509715660, languages: [], pack: false, recommended: k === 0,
      })),
    };
  }
  write("cache/torrent-streams.json", { torrents: {}, streams, ids: {} });

  // --- More like this (59 rows x 14 cards), X-Ray (26), availability (358)
  const similar = { v: 3, ids: {}, rows: {} };
  for (let i = 0; i < 59; i++) {
    const c = catAll[(i * 5) % catAll.length];
    similar.ids[c.imdbId] = { tmdbId: 5000 + i, at: now };
    similar.rows[`${c.type}|${c.imdbId}`] = { source: "tmdb", at: now, items: Array.from({ length: 14 }, (_, k) => ({ ...card(c.type, i * 14 + k + 501), tmdbId: 9000 + k })) };
  }
  write("cache/similar.json", similar);
  const xray = {};
  for (let i = 0; i < 26; i++) {
    const c = catAll[(i * 9) % catAll.length];
    xray[`t|${c.type}|${c.imdbId}`] = { at: now, v: 3, empty: false, data: {
      title: c.title, cast: Array.from({ length: 30 }, () => ({ name: pick(NAMES), role: pick(W1), photo: `https://image.tmdb.org/t/p/w185/${hex(27)}.jpg` })),
      crew: [{ name: pick(NAMES), job: "Director" }], ratings: [{ source: "imdb", value: 7.4, scale: 10 }], facts: Array.from({ length: 6 }, () => ({ label: "Budget", value: LOREM.slice(0, 56) })),
      anthology: false, billed: [pick(NAMES), pick(NAMES), pick(NAMES)], tvmazeId: null, episodes: [], _videos: [], sources: ["tmdb", "cinemeta"] } };
  }
  write("cache/xray.json", xray);
  const avail = { v: 2, titles: {} };
  for (const c of catAll.slice(0, 358)) avail.titles[c.imdbId] = { home: true, homeAt: now - 30 * DAY, theatricalAt: now - 120 * DAY, streamed: null, at: now };
  write("cache/availability.json", avail);

  // --- the recommender's knowledge (recs-titles.json V 1): 2,400 full records = about 3.6 MB
  const recs = { v: 1, titles: {}, tm: {}, miss: {}, lists: {} };
  const recIds = [...lf.map((f) => [f, "movie"]), ...ls.map((s) => [s, "tv"]), ...catAll.map((c) => [c, c.type === "show" ? "tv" : "movie"])];
  for (let i = 0; recIds.length < 2400 + lf.length; i++) recIds.push([{ imdbId: `tt8${String(i).padStart(6, "0")}`, title: title(i * 3 + 77), year: 1990 + (i % 35) }, i % 3 ? "movie" : "tv"]);
  let tm = 1000;
  let nRecs = 0;
  for (const [it, k] of recIds) {
    if (recs.titles[it.imdbId] || nRecs >= 2400) continue;
    nRecs++;
    tm++;
    recs.titles[it.imdbId] = {
      id: it.imdbId, tm, k, title: it.title, year: it.year || 2012, rel: `${it.year || 2012}-05-14`, st: "Released", g: [pick(GENRES), pick(GENRES)], gid: [18, 53],
      kw: Array.from({ length: 14 }, () => [Math.floor(R() * 300000), `${pick(W1)} ${pick(W2)}`.toLowerCase()]), dir: [[Math.floor(R() * 90000), pick(NAMES)]], wr: [[Math.floor(R() * 90000), pick(NAMES)], [Math.floor(R() * 90000), pick(NAMES)]],
      cre: [], cast: Array.from({ length: 8 }, () => [Math.floor(R() * 90000), pick(NAMES)]), col: null, net: null, lang: "en", cc: ["US"], rt: 108, eps: null, age: 12, cert: "PG-13",
      va: 6 + R() * 3, vc: Math.floor(R() * 20000), pop: R() * 200, poster: `https://image.tmdb.org/t/p/w342/${hex(27)}.jpg`, backdrop: `https://image.tmdb.org/t/p/w780/${hex(27)}.jpg`,
      ov: (syn(it.title) + " " + LOREM).slice(0, 420), recs: Array.from({ length: 20 }, () => 1000 + Math.floor(R() * 2400)), sim: Array.from({ length: 20 }, () => 1000 + Math.floor(R() * 2400)), at: now - Math.floor(R() * 20 * DAY),
    };
    recs.tm[`${k}:${tm}`] = it.imdbId;
  }
  write("cache/recs-titles.json", recs);

  // --- the well-known titles (search-known.json V 1): 3,000 films + 2,000 series
  const known = { v: 1, at: now - DAY, tried: now - DAY, titles: [] };
  for (let i = 0; i < 5000; i++) {
    const type = i < 3000 ? "movie" : "show";
    const id = `tt7${String(i).padStart(6, "0")}`;
    known.titles.push({ imdbId: id, type, title: `${title(i * 7 + 3)}${i % 9 === 0 ? `: Part ${1 + (i % 4)}` : ""}`, year: 1960 + (i % 66), poster: `https://images.metahub.space/poster/small/${id}/img`,
      rating: 6.5, genres: [pick(GENRES), pick(GENRES)], cast: [pick(NAMES), pick(NAMES), pick(NAMES), pick(NAMES)], director: [pick(NAMES)], k: i < 3000 ? i : i - 3000 });
  }
  write("cache/search-known.json", known);

  // --- probe results for every file (metadata-cache.json, PROBE_VERSION 6): a
  // WARM library. The cold-scan run starts without this file so the server probes.
  const probes = {};
  const first = lf.length ? lf[0].abs : ls[0].eps[0].abs;
  const mtime = fs.statSync(first).mtimeMs; // hard links share one mtime
  const probe = () => ({ v: 6, mtime, duration: 6, width: 320, height: 180, video: { codec: "h264", bitDepth: 8, hdr: null },
    audioStreams: [{ index: 0, language: "eng", title: null, codec: "aac", channels: 1, layout: "mono", profile: "LC", atmos: false, dtsx: false, compatible: true }],
    subtitleStreams: [{ index: 0, codec: "subrip", text: true, language: "eng", title: null }] });
  for (const f of lf) probes[f.abs] = probe();
  const jitAbs = path.join(lib.movies, JIT_NAME, `${JIT_NAME}.mkv`);
  const jitId = makeId("video", path.join(JIT_NAME, `${JIT_NAME}.mkv`));
  probes[jitAbs] = { v: 6, mtime: fs.statSync(jitAbs).mtimeMs, duration: 60.032, width: 640, height: 360, video: { codec: "h264", bitDepth: 8, hdr: null },
    audioStreams: [{ index: 0, language: "eng", title: null, codec: "ac3", channels: 2, layout: "stereo", profile: null, atmos: false, dtsx: false, compatible: false }], subtitleStreams: [] };
  for (const s of ls) for (const e of s.eps) probes[e.abs] = probe();
  write("metadata-cache.json", probes);
  // --- a SETTLED library: every episode already analysed for intros (ANALYSIS_V 2)
  // and already asked about in the skip databases, and the daily jobs run today.
  // (Six-second test episodes cannot be fingerprinted, and an instance with no
  // network cannot reach the databases: without these records the server would
  // start both again after every scan, which is the rig's behaviour and not a
  // settled server's. The first-pass cost is measured on its own, scan.js.)
  const intro = {};
  for (const s of ls) for (const e of s.eps) intro[e.id] = { mtime: Math.floor(mtime), at: now - 3600e3, v: 2, intro: { start: 1, end: 3 }, credits: null, source: "audio", db: { at: now - 600e3, intro: null, recap: null, credits: null, preview: null, source: null } };
  write("intro-auto.json", intro);
  write("daily.json", Object.fromEntries(["skip-timestamps", "library-metadata", "backup", "my-list-downloads", "recommendations"].map((k) => [k, { at: now - 600e3, ms: 1000, summary: null }])));

  // --- the household: profiles, history, sign-ins
  const colors = ["#e05f2c", "#3a7a4c", "#2c5f8b", "#8b3a2c", "#7a3a8b", "#8b7a2c"];
  const profiles = Array.from({ length: nProfiles }, (_, i) => ({ id: `eff${String(i).padStart(9, "0")}`, name: `Viewer ${i + 1}`, color: colors[i % colors.length], avatar: "🍿", theme: "aurora",
    ...(i === nProfiles - 1 && nProfiles > 1 ? { kids: { maxAge: 12 } } : {}) }));
  const state = {};
  const access = {};
  const allEps = ls.flatMap((s) => s.eps.map((e) => ({ ...e, show: s })));
  profiles.forEach((p, pi) => {
    const s = { progress: {}, watchlist: [], ratings: {}, likedGenres: [pick(GENRES), pick(GENRES), pick(GENRES)], streamItems: {}, upNextDismissed: {}, titles: {}, likedTitles: [], searches: [] };
    const n = pi === 0 ? rows : Math.round(rows * (0.4 + 0.6 * R()));
    for (let k = 0; k < n; k++) {
      const at = now - Math.floor(R() * 600 * DAY) - 3600e3;
      const fin = R() < 0.8;
      const dur = 5400 + Math.floor(R() * 3000);
      const row = { position: fin ? dur - 30 : Math.floor(R() * dur * 0.9) + 20, duration: dur, finished: fin, updatedAt: at };
      const r = R();
      if (r < 0.35 && lf.length) {
        const f = lf[Math.floor(R() * lf.length)];
        s.progress[f.id] = row;
        s.titles[f.imdbId] = { ...row, itemId: f.id };
      } else if (r < 0.6 && allEps.length) {
        const e = allEps[Math.floor(R() * allEps.length)];
        s.progress[e.id] = row;
        s.titles[`${e.show.imdbId}:${e.season}:${e.episode}`] = { ...row, itemId: e.id };
      } else {
        const c = catAll[Math.floor(R() * catAll.length)];
        const isShow = c.type === "show";
        const se = 1 + Math.floor(R() * 3), ep = 1 + Math.floor(R() * 10);
        const id = `torrent|${hex(40)}|${Math.floor(R() * 4)}`;
        s.progress[id] = row;
        s.streamItems[id] = { id, type: isShow ? "episode" : "movie", stream: true, title: isShow ? `Episode ${ep}` : c.title, showTitle: isShow ? c.title : undefined, imdbId: c.imdbId, season: isShow ? se : undefined, episode: isShow ? ep : undefined,
          year: c.year, cover: c.poster, backdrop: c.backdrop, infoHash: id.split("|")[1], fileIdx: 0, filename: `${c.title.replace(/ /g, ".")}.1080p.WEB-DL.mkv`, quality: "1080p", duration: dur };
        s.titles[isShow ? `${c.imdbId}:${se}:${ep}` : c.imdbId] = { ...row, itemId: id };
      }
    }
    for (let k = 0; k < 40; k++) {
      if (k % 2 && lf.length) s.watchlist.push(lf[Math.floor(R() * lf.length)].id);
      else { const c = catAll[Math.floor(R() * catAll.length)]; s.watchlist.push({ stream: true, imdbId: c.imdbId, type: c.type, title: c.title, poster: c.poster, year: c.year }); }
    }
    for (let k = 0; k < 80 && lf.length; k++) s.ratings[lf[Math.floor(R() * lf.length)].id] = 1 + Math.floor(R() * 5);
    state[p.id] = s;
    access[p.id] = Array.from({ length: 6 }, (_, k) => ({ key: `192.168.1.${20 + k}|Chrome/Windows`, ip: `192.168.1.${20 + k}`, device: { browser: "Chrome", os: "Windows", device: "💻" }, first: now - 200 * DAY, last: now - k * DAY, count: 40, fails: 0 }));
  });
  write("profiles.json", { profiles, state, pending: [], access });

  const sessions = {};
  const handed = [];
  for (let i = 0; i < 76; i++) {
    const p = profiles[i % profiles.length];
    const sid = sha256(`eff-session-${i}`); // 64 hex chars, like a real sid
    sessions[sha256(sid)] = { profileId: p.id, createdAt: now - 30 * DAY, lastSeenAt: now, expiresAt: now + 90 * DAY, device: { browser: "Chrome", os: "Windows", device: "💻" }, ip: `192.168.1.${20 + (i % 30)}` };
    if (i < profiles.length) handed.push({ profileId: p.id, sid });
  }
  write("sessions.json", sessions);
  write("settings.json", { authMode: "closed" });

  // --- viewing sessions (2,000 of the 8,000 cap), hourly telemetry (90 days), who-watched-what
  const iso = (t) => new Date(t).toISOString();
  write("watch-sessions.json", Array.from({ length: 2000 }, (_, i) => {
    const st = now - (i + 1) * 5 * 3600e3;
    return { id: hex(12), clientId: hex(12), profile: `Viewer ${1 + (i % nProfiles)}`, ip: `192.168.1.${20 + (i % 30)}`, device: { device: "💻", browser: "Chrome 141.0.0.0", os: "Windows 10/11 x64" },
      content: `${title(i)} (${1975 + (i % 50)})`, startedAt: iso(st), updatedAt: iso(st + 3000e3), endedAt: iso(st + 3000e3), watchedSec: 3000, position: 3000, duration: 5400, live: false };
  }));
  const hours = {};
  for (let h = 1; h <= 2160; h++) hours[iso(now - h * 3600e3).slice(0, 13)] = { samples: 120, maxClients: 4, sumClients: 210, maxWatching: 2, sumWatching: 90, downKB: 1234 };
  write("telemetry-hours.json", hours);
  write("watch-history.json", Array.from({ length: 300 }, (_, i) => ({ id: hex(12), ip: `192.168.1.${20 + (i % 30)}`, device: { device: "💻", browser: "Chrome", os: "Windows" }, profile: `Viewer ${1 + (i % nProfiles)}`, content: title(i), timestamp: iso(now - i * 7 * 3600e3), lastSeen: iso(now - i * 7 * 3600e3 + 60e3), count: 3 })));

  // --- this month's usage log (appended JSONL; replayed at boot)
  {
    const month = new Date(now).toISOString().slice(0, 7);
    const routesSeen = ["/", "/movie/:id", "/show/:id", "/search", "/browse", "/mylist", "/watch/:id"];
    const parts = [];
    let bytes = 0;
    const target = usageMb * 1024 * 1024;
    let t = now - 9 * DAY;
    while (bytes < target) {
      const p = profiles[Math.floor(R() * profiles.length)];
      const events = Array.from({ length: 1 + Math.floor(R() * 6) }, () => {
        t += 900 + Math.floor(R() * 4000);
        const r = R();
        const at = Math.min(t, now - 1000);
        return r < 0.6 ? { n: "route", t: at, p: { r: pick(routesSeen), ms: Math.floor(R() * 300) } }
          : r < 0.8 ? { n: "feat", t: at, p: { f: pick(["hero_play", "row_scroll", "search_open", "mylist_add"]) } }
          : { n: "net", t: at, p: { tier: "fast", src: "measured", kbps: 393216 } };
      });
      const line = JSON.stringify({ profile: p.id, sid: hex(8), device: pick(["phone", "desktop", "tv"]), look: "glass", events }) + "\n";
      parts.push(line);
      bytes += line.length;
    }
    write(path.join("usage", `events-${month}.jsonl`), parts.join(""));
  }

  // --- blur-up placeholders already made (cache/blur/<md5 of the picture's address>.b64):
  // on a settled server every picture a list names has one, and an answer's
  // "_blur" map stops changing. Without them the first list a client asks for
  // sets the server making thousands (two ffmpeg runs each) — a first-run cost
  // that is measured on its own, not inside every other figure. Kept in a
  // folder of their own (one per library shape), shared by the instances.
  const blurDir = path.join(WORK, `blur2-${films}-${shows}x${episodes}`);
  if (!fs.existsSync(path.join(blurDir, ".ready"))) {
    fs.rmSync(blurDir, { recursive: true, force: true });
    fs.mkdirSync(blurDir, { recursive: true });
    const tiny = path.join(WORK, "tiny.webp");
    if (!fs.existsSync(tiny)) ff(["-i", path.join(WORK, "cover.jpg"), "-vf", "scale=16:-2", "-frames:v", "1", "-c:v", "libwebp", "-quality", "40", tiny]);
    const uri = `data:image/webp;base64,${fs.readFileSync(tiny).toString("base64")}`;
    const urls = new Set();
    for (const f of lf) {
      const name = `${f.title} (${f.year})`;
      urls.add(`/img/${makeId("image", path.join(name, "cover.jpg"))}`);
      urls.add(`/img/still/${f.id}`);
      urls.add(`https://images.metahub.space/poster/small/${f.imdbId}/img`);
      urls.add(`https://images.metahub.space/background/medium/${f.imdbId}/img`);
    }
    urls.add(`/img/${makeId("image", path.join(JIT_NAME, "cover.jpg"))}`);
    urls.add(`/img/still/${jitId}`);
    for (const s of ls) {
      urls.add(`/img/${makeId("image", path.join(s.title, "cover.jpg"))}`);
      urls.add(`/img/still/${s.eps[0].id}`);
      urls.add(`https://images.metahub.space/poster/small/${s.imdbId}/img`);
      urls.add(`https://images.metahub.space/background/medium/${s.imdbId}/img`);
    }
    for (const c of catAll) { urls.add(c.poster); urls.add(c.backdrop); }
    for (const r of Object.values(recs.titles)) { urls.add(r.poster); urls.add(r.backdrop); }
    for (const row of Object.values(similar.rows)) for (const c of row.items) { urls.add(c.poster); urls.add(c.backdrop); }
    for (const u of urls) if (u) fs.writeFileSync(path.join(blurDir, `${md5(u)}.b64`), uri);
    fs.writeFileSync(path.join(blurDir, ".ready"), String(urls.size));
  }

  const sizes = {};
  const walk = (d, rel = "") => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (e.name !== ".dataset.json") sizes[r] = fs.statSync(path.join(d, e.name)).size; } };
  walk(seedDir);
  const info = {
    key, films, shows, episodes, files: films + shows * episodes + 1, titles: films + shows + 1, profiles: profiles.map((p) => ({ id: p.id, kids: !!p.kids, rows: Object.keys(state[p.id].progress).length })),
    sessions: handed, sizes,
    sample: { jit: jitId, film: lf[0] && { id: lf[0].id, imdbId: lf[0].imdbId, title: lf[0].title }, show: ls[0] && { id: ls[0].id, imdbId: ls[0].imdbId }, episode: ls[0] && ls[0].eps[0].id,
      films: lf.slice(0, 200).map((f) => f.id), episodes: allEps.slice(0, 200).map((e) => e.id), catalogue: catAll.slice(0, 50).map((c) => ({ type: c.type, imdbId: c.imdbId, title: c.title })) },
  };
  fs.writeFileSync(infoFile, JSON.stringify(info));
  return { ...info, library: { movies: lib.movies, shows: lib.shows }, seedDir, blurDir };
};

module.exports = { build, buildLibrary, title };

if (require.main === module) {
  const ds = build({ films: arg("films"), shows: arg("shows"), episodes: arg("episodes"), profiles: arg("profiles"), rows: arg("rows"), usageMb: arg("usage-mb"), rebuild: !!arg("rebuild") });
  console.log(`library  ${ds.films} films + ${ds.shows} shows x ${ds.episodes} = ${ds.files} files   ${ds.library.movies}`);
  console.log(`data     ${ds.seedDir}`);
  for (const [f, b] of Object.entries(ds.sizes).sort((a, b) => b[1] - a[1])) console.log(`  ${String((b / 1024).toFixed(0)).padStart(7)} KB  ${f}`);
}

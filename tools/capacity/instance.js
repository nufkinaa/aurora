#!/usr/bin/env node
// A private Aurora instance for the capacity runs: this worktree's code, a
// throwaway data folder, its own port, a library made here. Built on the UI
// tests' own harness (scripts/ui-test-server.js), so the same fences apply:
// nothing of the owner's is read, the live server is never contacted, and
// every outbound connection the instance tries is refused.
//
//   const { start } = require("./instance");
//   const srv = await start({ films: 150, shows: 30, profiles: 20 });
//   ... srv.url, srv.pid, srv.adminPassword, srv.sessions[i] = { profileId, sid } ...
//   await srv.stop();
//
//   node tools/capacity/instance.js [--films 150] [--shows 30] [--profiles 20] [--mode closed|open]
//       the same by hand: prints the address, CTRL-C tears it down
//
// The library: the five bench files from make-media.js (as films, three of
// the HEVC one under different names so three DIFFERENT titles can ask for an
// encode at once), plus `films` small films and `shows` shows of 8 episodes
// (a 6-second clip each) so the catalogue endpoints carry a realistic number
// of titles. A synthetic catalogue of 198 films + 200 shows is seeded where
// the server keeps the streamable one (the size the live server's cache had
// on 2026-10-10), so /api/home composes the rows it composes in production.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { REPO, WORK, MEDIA, FFMPEG } = require("./lib");

const W1 = ["Silent", "Broken", "Golden", "Last", "Hidden", "Crimson", "Electric", "Paper", "Midnight", "Northern", "Hollow", "Burning", "Quiet", "Wild", "Glass", "Iron", "Distant", "Velvet", "Frozen", "Lucky"];
const W2 = ["River", "Empire", "Garden", "Signal", "Harbor", "Kingdom", "Mirror", "Orchard", "Station", "Voyage", "Shadow", "Promise", "Engine", "Theory", "Summer", "Witness", "Machine", "Canyon", "Lantern", "Parade"];
const GENRES = ["Drama", "Comedy", "Action", "Thriller", "Crime", "Adventure", "Sci-Fi", "Romance", "Mystery", "Animation", "Horror", "Family"];
const title = (i) => `${W1[i % W1.length]} ${W2[Math.floor(i / W1.length) % W2.length]}${i >= 400 ? ` ${Math.floor(i / 400) + 1}` : ""}`;

const ff = (args) => execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const link = (from, to) => { try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); } };

// The library folder, built once per shape under CAP_WORK.
const buildLibrary = ({ films, shows }) => {
  const dir = path.join(WORK, `library-${films}-${shows}`);
  const movies = path.join(dir, "movies");
  const showsDir = path.join(dir, "shows");
  if (fs.existsSync(path.join(dir, ".ready"))) return { dir, movies, shows: showsDir };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(movies, { recursive: true });
  fs.mkdirSync(showsDir, { recursive: true });
  const small = path.join(WORK, "small.mkv");
  const cover = path.join(WORK, "cover.jpg");
  if (!fs.existsSync(small)) {
    ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-shortest", small]);
  }
  if (!fs.existsSync(cover)) ff(["-f", "lavfi", "-i", "testsrc2=size=600x900:rate=1:duration=1", "-frames:v", "1", "-q:v", "5", cover]);
  const film = (name, year, file) => {
    const d = path.join(movies, `${name} (${year})`);
    fs.mkdirSync(d, { recursive: true });
    link(file, path.join(d, `${name} (${year})${path.extname(file)}`));
    link(cover, path.join(d, "cover.jpg"));
  };
  const need = (n) => { const f = path.join(MEDIA, n); if (!fs.existsSync(f)) throw new Error(`missing ${f} — run tools/capacity/make-media.js first`); return f; };
  film("Cap Direct Mp4", 2020, need("h264-1080p-8M.mp4"));
  film("Cap Remux Ac3", 2020, need("h264-1080p-8M.mkv"));
  film("Cap Hevc One", 2021, need("hevc-1080p-10bit-6M.mkv"));
  film("Cap Hevc Two", 2021, need("hevc-1080p-10bit-6M.mkv"));
  film("Cap Hevc Three", 2021, need("hevc-1080p-10bit-6M.mkv"));
  film("Cap Uhd Sdr", 2022, need("hevc-2160p-10bit-25M.mkv"));
  film("Cap Uhd Hdr", 2023, need("hevc-2160p-hdr10-40M.mkv"));
  for (let i = 0; i < films; i++) film(title(i), 1980 + (i % 45), small);
  for (let s = 0; s < shows; s++) {
    const name = `${title(s + 7)} Chronicles`;
    const sd = path.join(showsDir, name, "Season 1");
    fs.mkdirSync(sd, { recursive: true });
    link(cover, path.join(showsDir, name, "cover.jpg"));
    for (let e = 1; e <= 8; e++) link(small, path.join(sd, `${name} S01E${String(e).padStart(2, "0")}.mkv`));
  }
  fs.writeFileSync(path.join(dir, ".ready"), new Date().toISOString());
  return { dir, movies, shows: showsDir };
};

// The streamable catalogue, in the shape media/discover.js caches it (v 3).
const catalogueSeed = () => {
  const mk = (type, i) => {
    const id = `tt9${String(type === "movie" ? 100000 + i : 200000 + i)}`;
    return {
      type, title: `${title(i + 40)} ${type === "movie" ? "Story" : "Files"}`, year: 2000 + (i % 26),
      poster: `https://images.metahub.space/poster/small/${id}/img`,
      backdrop: `https://images.metahub.space/background/medium/${id}/img`,
      synopsis: "A synthetic title for the capacity runs. It has a synopsis of about the usual length so that the answers that carry it weigh what they weigh on the real server, give or take a sentence.",
      rating: 5 + ((i * 7) % 40) / 10, genres: [GENRES[i % GENRES.length], GENRES[(i * 5 + 3) % GENRES.length]], imdbId: id, inLibrary: null,
    };
  };
  return { fetchedAt: Date.now(), v: 3, movies: Array.from({ length: 198 }, (_, i) => mk("movie", i)), shows: Array.from({ length: 200 }, (_, i) => mk("show", i)) };
};

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const start = async (opts = {}) => {
  const films = opts.films ?? 150;
  const shows = opts.shows ?? 30;
  const nProfiles = opts.profiles ?? 20;
  const mode = opts.mode || "closed";
  const lib = buildLibrary({ films, shows });

  // Profiles with a session each (the X-Session header is the TV app's transport).
  const colors = ["#e05f2c", "#3a7a4c", "#2c5f8b", "#8b3a2c", "#7a3a8b", "#8b7a2c"];
  const profiles = Array.from({ length: nProfiles }, (_, i) => ({ id: `cap${String(i).padStart(4, "0")}`, name: `Viewer ${i + 1}`, color: colors[i % colors.length], avatar: "🍿" }));
  const now = Date.now();
  const sessions = {};
  const handed = profiles.map((p) => {
    const sid = crypto.randomBytes(32).toString("hex");
    sessions[sha256(sid)] = { profileId: p.id, createdAt: now, lastSeenAt: now, expiresAt: now + 90 * 24 * 3600 * 1000, device: "capacity", ip: "127.0.0.1" };
    return { profileId: p.id, sid };
  });

  const { start: startUi } = require(path.join(REPO, "scripts", "ui-test-server"));
  const srv = await startUi({
    waitForLibrary: false,
    verbose: !!opts.verbose,
    config: {
      libraries: { movies: [lib.movies], shows: [lib.shows] },
      authMode: mode,
      backups: false,
      torrents: false,
      preconvert: false,
      ...(opts.config || {}),
    },
    seed: {
      "imdb-map.json": null,
      "profiles.json": { profiles, state: {}, pending: [], access: {} },
      "sessions.json": sessions,
      "settings.json": { authMode: mode },
      "cache/discover.json": catalogueSeed(),
      ...(opts.seed || {}),
    },
  });

  // "Up" = every file probed (the server probes with a blocking ffprobe per file).
  const t0 = Date.now();
  const get = (p, headers = {}) => fetch(srv.url + p, { headers: { "X-Session": handed[0].sid, ...headers } }).then((r) => r.json());
  let library = null;
  for (;;) {
    try {
      library = await get("/api/library");
      if (library && library.enriched && library.movies.length >= films + 7 && library.movies.every((m) => m.duration > 0)) break;
    } catch {}
    if (Date.now() - t0 > 10 * 60 * 1000) throw new Error("library not ready in 10 minutes");
    await new Promise((r) => setTimeout(r, 500));
  }
  const byTitle = (t) => library.movies.find((m) => m.title.toLowerCase().startsWith(t.toLowerCase()));
  const vid = (m) => (m && (m.videoId || (m.video && m.video.id) || m.id)) || null;
  return {
    ...srv, mode, films, shows, sessions: handed, library,
    enrichMs: Date.now() - t0,
    titles: {
      direct: byTitle("Cap Direct Mp4"), remux: byTitle("Cap Remux Ac3"),
      hevc: [byTitle("Cap Hevc One"), byTitle("Cap Hevc Two"), byTitle("Cap Hevc Three")],
      uhd: byTitle("Cap Uhd Sdr"), hdr: byTitle("Cap Uhd Hdr"),
    },
    vid,
  };
};

module.exports = { start, buildLibrary };

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
  start({ films: +arg("films", 150), shows: +arg("shows", 30), profiles: +arg("profiles", 20), mode: arg("mode", "closed"), verbose: process.argv.includes("--verbose") })
    .then((srv) => {
      console.log(`\n  Private Aurora instance (capacity)\n\n    App      ${srv.url}\n    Admin    ${srv.url}/admin  (password in ${path.join(srv.root, "config.json")})\n    pid      ${srv.pid}\n    library  ${srv.library.movies.length} films, ${srv.library.shows.length} shows — probed in ${(srv.enrichMs / 1000).toFixed(1)}s\n    session  X-Session: ${srv.sessions[0].sid.slice(0, 8)}… (profile ${srv.sessions[0].profileId})\n\n  CTRL-C stops it and removes the folder.\n`);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}

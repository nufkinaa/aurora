#!/usr/bin/env node
// Fetch Hebrew and English subtitles for everything already in the library.
//
// Downloads get their sidecars automatically, but titles added by hand never had
// that step run — which is why most of a hand-built library has no Hebrew track.
// This walks the library, resolves each title's IMDb id, and writes the same
// sidecar files a download would.
//
// Pure Node, no server required, identical on Windows and Linux:
//
//   node tools/backfill-subtitles.js --dry-run          # see what it would do
//   node tools/backfill-subtitles.js                    # do it
//   node tools/backfill-subtitles.js --lang=heb         # Hebrew only
//   node tools/backfill-subtitles.js --only="how i met" # one title
//   node tools/backfill-subtitles.js --limit=10         # first 10 items
//   node tools/backfill-subtitles.js --force            # rewrite existing files
//
// Safe to re-run: an item that already has a sidecar for a language is skipped
// unless --force, and it never touches the video files.
const fs = require("fs");
const path = require("path");

const scanner = require("../src/media/scanner");
const websubs = require("../src/media/websubs");
const imdb = require("../src/media/imdb");

// ---------- arguments ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY = flag("dry-run");
const FORCE = flag("force");
const LIMIT = parseInt(value("limit", ""), 10) || Infinity;
const ONLY = (value("only", "") || "").toLowerCase();
const WANT_LANGS = (value("lang", "") || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

if (flag("help") || flag("h")) {
  console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 21).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}

// The language names websubs uses for its sidecar labels.
const langName = (key) => (websubs.LANGS.find((l) => l.key === key) || {}).name;
const wantedNames = WANT_LANGS.length
  ? WANT_LANGS.map(langName).filter(Boolean)
  : websubs.LANGS.map((l) => l.name);

if (WANT_LANGS.length && wantedNames.length !== WANT_LANGS.length) {
  console.error(`Unknown language. This server serves: ${websubs.LANGS.map((l) => l.key).join(", ")}`);
  process.exit(1);
}

// ---------- the work ----------

// Everything playable in the library, with the path of its video file and the
// identity needed to look subtitles up.
const libraryItems = () => {
  const out = [];
  for (const m of scanner.index.movies) {
    const entry = scanner.resolve(m.id);
    if (entry && entry.path) {
      out.push({ kind: "movie", title: m.title, year: m.year, file: entry.path, label: m.title });
    }
  }
  for (const s of scanner.index.shows) {
    for (const season of s.seasons || []) {
      for (const ep of season.episodes || []) {
        const entry = scanner.resolve(ep.id);
        if (!entry || !entry.path) continue;
        out.push({
          kind: "show", title: s.title, year: s.year, file: entry.path,
          season: season.number, episode: ep.episode,
          label: `${s.title} S${season.number}E${ep.episode}`,
        });
      }
    }
  }
  return out;
};

// Which of the wanted languages this video already has a sidecar for.
const existingLangs = (file) => {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const have = new Set();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return have; }
  for (const n of names) {
    // .srt AND .vtt: the scanner offers both, so a .vtt already there means this
    // language is covered — writing an .srt beside it just doubles the menu.
    if (!n.startsWith(base + ".") || !/\.(srt|vtt)$/i.test(n)) continue;
    for (const l of websubs.LANGS) {
      if (n.toLowerCase().includes(l.name.toLowerCase())) have.add(l.name);
    }
  }
  return have;
};

const main = async () => {
  console.log("Scanning the library…");
  scanner.scan();
  // scan() fills the index synchronously; enrichment is irrelevant here.
  const items = libraryItems()
    .filter((i) => !ONLY || i.label.toLowerCase().includes(ONLY))
    .slice(0, LIMIT);

  console.log(`${items.length} item(s) to consider · languages: ${wantedNames.join(", ")}` +
    `${DRY ? " · DRY RUN" : ""}${FORCE ? " · FORCE" : ""}\n`);

  let done = 0, skipped = 0, written = 0, noId = 0, noSubs = 0, failed = 0;

  for (const item of items) {
    done++;
    const prefix = `[${String(done).padStart(3)}/${items.length}] ${item.label}`;

    const missing = wantedNames.filter((n) => FORCE || !existingLangs(item.file).has(n));
    if (!missing.length) {
      skipped++;
      console.log(`${prefix} — already has ${wantedNames.join(" + ")}`);
      continue;
    }

    let imdbId;
    try {
      imdbId = await imdb.resolve(item.title, item.kind, item.year);
    } catch {
      imdbId = null;
    }
    if (!imdbId) {
      noId++;
      console.log(`${prefix} — no IMDb match, skipping`);
      continue;
    }

    let tracks = [];
    try {
      tracks = await websubs.list(
        item.kind === "show" ? "series" : "movie",
        imdbId, item.season, item.episode
      );
    } catch (e) {
      failed++;
      console.log(`${prefix} — lookup failed (${e.message})`);
      continue;
    }

    // Only the languages this run is after.
    const wanted = tracks.filter((t) => missing.includes(t.langName));
    if (!wanted.length) {
      noSubs++;
      console.log(`${prefix} — nothing available in ${missing.join("/")}`);
      continue;
    }

    if (DRY) {
      const by = {};
      for (const t of wanted) by[t.langName] = (by[t.langName] || 0) + 1;
      console.log(`${prefix} — would fetch ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ")}`);
      continue;
    }

    try {
      const res = await websubs.writeSidecars(wanted, item.file, { force: FORCE });
      written += res.written.length;
      console.log(
        `${prefix} — wrote ${res.written.length}` +
        (res.duplicates ? ` (${res.duplicates} duplicate${res.duplicates > 1 ? "s" : ""} skipped)` : "")
      );
    } catch (e) {
      failed++;
      console.log(`${prefix} — write failed (${e.message})`);
    }
  }

  console.log(
    `\nDone. ${written} subtitle file(s) written · ${skipped} already had them · ` +
    `${noId} without an IMDb match · ${noSubs} with nothing available · ${failed} failed.`
  );
  if (!DRY && written) console.log("Run a library rescan (admin → Rescan library) so the new tracks show up.");
  process.exit(0);
};

main().catch((e) => {
  console.error("backfill failed:", e && e.stack ? e.stack : e);
  process.exit(1);
});

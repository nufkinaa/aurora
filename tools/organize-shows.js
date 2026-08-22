// Organize a Shows library into  Show Name/Season NN/episode files
// like a streaming service expects.
//
//   node tools/organize-shows.js "D:\Media\Shows"           (dry run)
//   node tools/organize-shows.js "D:\Media\Shows" --apply   (do it)
//
// Rules:
//  - Folders like "Show 1", "Show 2" merge into one "Show" series,
//    each becoming its season (season number from episode filenames).
//  - Nested season folders ("...Season 1 to 5.../Season 1/") are flattened.
//  - Series name prefers the episode filename prefix ("Show - Title (1x2)").
//  - Files are MOVED (same-drive rename), never overwritten, never deleted.
//  - Covers follow their season; the first season's cover becomes the
//    series cover.
const fs = require("fs");
const path = require("path");

const root = process.argv[2];
const apply = process.argv.includes("--apply");

if (!root || !fs.existsSync(root)) {
  console.error("usage: node tools/organize-shows.js <shows-folder> [--apply]");
  process.exit(1);
}

const VIDEO_EXT = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"];
const SUB_EXT = [".srt", ".vtt"];
const IMG_EXT = [".jpg", ".jpeg", ".png", ".webp"];

const extOf = (f) => path.extname(f).toLowerCase();

const parseSeason = (fileName) => {
  const base = path.basename(fileName, path.extname(fileName));
  const m = base.match(/S(\d{1,2})[\s._-]*E\d{1,3}/i) || base.match(/\(?(\d{1,2})x\d{1,3}\)?/);
  return m ? parseInt(m[1], 10) : null;
};

const walkFiles = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, out);
    else out.push(abs);
  }
  return out;
};

// ---- group top-level folders into series ----
const groups = new Map(); // seriesKey(lower) -> {name, folders: [{dir, seasonHint}]}

for (const e of fs.readdirSync(root, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const dir = path.join(root, e.name);

  // trailing-number folder => that number is a season hint
  const m = e.name.match(/^(.*?)[\s._-]+(\d{1,2})$/);
  const baseName = m ? m[1].trim() : e.name.trim();
  const seasonHint = m ? parseInt(m[2], 10) : null;

  // prefer the episode filename prefix ("Show - Title (1x2)") for casing
  const videos = walkFiles(dir).filter((f) => VIDEO_EXT.includes(extOf(f)));
  const prefixes = {};
  for (const v of videos) {
    const b = path.basename(v);
    const pm = b.match(/^(.+?)\s+-\s+/);
    if (pm) prefixes[pm[1].trim()] = (prefixes[pm[1].trim()] || 0) + 1;
  }
  const bestPrefix = Object.entries(prefixes).sort((a, b) => b[1] - a[1])[0];
  const seriesName =
    bestPrefix && bestPrefix[1] >= Math.max(1, videos.length / 2) ? bestPrefix[0] : baseName;

  const key = seriesName.toLowerCase();
  if (!groups.has(key)) groups.set(key, { name: seriesName, folders: [] });
  const g = groups.get(key);
  // keep the best-cased name (prefer one with more uppercase letters)
  const upper = (s) => (s.match(/[A-Z]/g) || []).length;
  if (upper(seriesName) > upper(g.name)) g.name = seriesName;
  g.folders.push({ dir, seasonHint });
}

// ---- build the move plan ----
const moves = []; // {from, to}
const skipped = [];
const seasonDir = (series, n) => path.join(root, series, `Season ${String(n).padStart(2, "0")}`);

for (const g of groups.values()) {
  const seriesRoot = path.join(root, g.name);
  const coverBySeason = new Map();

  for (const f of g.folders) {
    for (const file of walkFiles(f.dir)) {
      const name = path.basename(file);
      const ext = extOf(file);
      const pm = path.basename(path.dirname(file)).match(/^season[\s._-]*(\d{1,2})$/i);
      const parentSeason = pm ? parseInt(pm[1], 10) : null;

      if (VIDEO_EXT.includes(ext) || SUB_EXT.includes(ext)) {
        const season = parseSeason(name) ?? parentSeason ?? f.seasonHint ?? 1;
        moves.push({ from: file, to: path.join(seasonDir(g.name, season), name) });
      } else if (IMG_EXT.includes(ext)) {
        const season = parentSeason ?? f.seasonHint ?? 1;
        const target = path.join(seasonDir(g.name, season), name);
        // remember where the cover will LIVE (post-move) for the series copy
        if (!coverBySeason.has(season)) coverBySeason.set(season, target);
        moves.push({ from: file, to: target });
      } else {
        // extras (apk etc.) go to the series root
        moves.push({ from: file, to: path.join(seriesRoot, name) });
      }
    }
  }

  // series-level cover: copy of the lowest season's cover
  const firstSeason = [...coverBySeason.keys()].sort((a, b) => a - b)[0];
  if (firstSeason !== undefined && !fs.existsSync(path.join(seriesRoot, "cover.jpg"))) {
    moves.push({
      from: coverBySeason.get(firstSeason),
      to: path.join(seriesRoot, "cover" + extOf(coverBySeason.get(firstSeason))),
      copy: true,
    });
  }
}

// drop no-op moves, refuse overwrites
const planned = [];
for (const mv of moves) {
  if (path.resolve(mv.from) === path.resolve(mv.to)) continue;
  if (fs.existsSync(mv.to)) {
    skipped.push(`${mv.to} already exists  <-  ${mv.from}`);
    continue;
  }
  planned.push(mv);
}

// ---- report ----
console.log(`Series detected: ${[...groups.values()].map((g) => g.name).join(", ")}\n`);
for (const mv of planned) {
  console.log(`${mv.copy ? "copy" : "move"}  ${path.relative(root, mv.from)}`);
  console.log(`  ->  ${path.relative(root, mv.to)}`);
}
if (skipped.length) {
  console.log("\nSKIPPED (target exists):");
  for (const s of skipped) console.log("  " + s);
}
console.log(`\n${planned.length} operations${apply ? "" : " (dry run - pass --apply to execute)"}`);

if (!apply) process.exit(0);

// ---- execute ----
let done = 0;
for (const mv of planned) {
  fs.mkdirSync(path.dirname(mv.to), { recursive: true });
  if (mv.copy) fs.copyFileSync(mv.from, mv.to);
  else fs.renameSync(mv.from, mv.to);
  done++;
}

// prune now-empty directories (bottom-up)
const pruneEmpty = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmpty(path.join(dir, e.name));
  }
  if (dir !== root && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
};
pruneEmpty(root);

console.log(`\nDone: ${done} operations executed, empty folders pruned.`);

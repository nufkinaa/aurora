// Deleting ONE library video file, done carefully (D1). The rules, in one
// place so they can be tested against real temp directories:
//  • the file must live INSIDE one of the given roots (subfolder or the
//    root itself) — anything else is refused before any I/O;
//  • sidecar subtitles ride along: same basename, any language infix
//    ("Name.srt", "Name.en.srt"), subtitle extensions only — but never the
//    sidecars of ANOTHER copy in the same folder ("Name.1080p.mkv" owns
//    "Name.1080p.en.srt", which also starts with "Name."; the longer
//    basename wins), and never subtitles a same-named copy in another
//    container still uses;
//  • directories the deletion leaves EMPTY are removed, sweeping upward,
//    but a root is never touched;
//  • any failure throws — the caller reports it instead of half-deleting
//    silently (a file can be locked mid-stream on Windows).
const fs = require("fs");
const path = require("path");

const SUB_EXTS = [".srt", ".vtt"];
// Every extension a video in the library may have (config.VIDEO_EXTENSIONS),
// so a sibling video's subtitles can be told apart from this one's.
const VIDEO_EXTS = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"];

// Strictly inside (a descendant of) one of the roots.
const insideARoot = (dir, roots) =>
  roots.some((root) => {
    const rel = path.relative(path.resolve(root), path.resolve(dir));
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  });

const isARoot = (dir, roots) => roots.some((r) => path.resolve(r) === path.resolve(dir));

// Delete a video file + its sidecar subtitles, then sweep empty dirs upward.
// Returns { deleted: [fileNames], freedBytes }. Throws on refusal or failure.
const deleteVideoFile = (absPath, roots, subExts = SUB_EXTS, videoExts = VIDEO_EXTS) => {
  const dir = path.dirname(absPath);
  if (!insideARoot(dir, roots) && !isARoot(dir, roots)) {
    throw new Error("Refusing to delete outside the library");
  }
  const videoName = path.basename(absPath);
  const base = path.basename(absPath, path.extname(absPath));
  const names = fs.readdirSync(dir);
  // Other videos here whose basename starts with ours ("Name.1080p" beside
  // "Name"): a subtitle that also matches THEIR basename is theirs.
  // And one with the SAME basename ("Name.mp4" beside "Name.mkv", which is
  // what two downloads of one title in different containers leave) shares
  // the subtitles: they stay for it.
  const siblings = names
    .filter((f) => f !== videoName && videoExts.includes(path.extname(f).toLowerCase()))
    .map((f) => path.basename(f, path.extname(f)));
  const shared = siblings.includes(base);
  const longer = siblings.filter((b) => b.length > base.length && b.startsWith(base + "."));
  const sidecars = names
    .filter(
      (f) =>
        !shared &&
        f !== videoName &&
        f.startsWith(base + ".") &&
        subExts.includes(path.extname(f).toLowerCase()) &&
        !longer.some((b) => f.startsWith(b + ".")),
    )
    .map((f) => path.join(dir, f));
  const deleted = [];
  let freedBytes = 0;
  for (const p of [absPath, ...sidecars]) {
    const st = fs.statSync(p);
    fs.unlinkSync(p);
    freedBytes += st.size;
    deleted.push(path.basename(p));
  }
  let d = dir;
  while (insideARoot(d, roots)) {
    try {
      if (fs.readdirSync(d).length > 0) break;
      fs.rmdirSync(d);
    } catch {
      break;
    }
    d = path.dirname(d);
  }
  return { deleted, freedBytes };
};

module.exports = { deleteVideoFile, insideARoot, VIDEO_EXTS };

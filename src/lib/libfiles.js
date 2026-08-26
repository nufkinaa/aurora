// Deleting ONE library video file, done carefully (D1). The rules, in one
// place so they can be tested against real temp directories:
//  • the file must live INSIDE one of the given roots (subfolder or the
//    root itself) — anything else is refused before any I/O;
//  • sidecar subtitles ride along: same basename, any language infix
//    ("Name.srt", "Name.en.srt"), subtitle extensions only;
//  • directories the deletion leaves EMPTY are removed, sweeping upward,
//    but a root is never touched;
//  • any failure throws — the caller reports it instead of half-deleting
//    silently (a file can be locked mid-stream on Windows).
const fs = require("fs");
const path = require("path");

const SUB_EXTS = [".srt", ".vtt"];

// Strictly inside (a descendant of) one of the roots.
const insideARoot = (dir, roots) =>
  roots.some((root) => {
    const rel = path.relative(path.resolve(root), path.resolve(dir));
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  });

const isARoot = (dir, roots) => roots.some((r) => path.resolve(r) === path.resolve(dir));

// Delete a video file + its sidecar subtitles, then sweep empty dirs upward.
// Returns { deleted: [fileNames], freedBytes }. Throws on refusal or failure.
const deleteVideoFile = (absPath, roots, subExts = SUB_EXTS) => {
  const dir = path.dirname(absPath);
  if (!insideARoot(dir, roots) && !isARoot(dir, roots)) {
    throw new Error("Refusing to delete outside the library");
  }
  const videoName = path.basename(absPath);
  const base = path.basename(absPath, path.extname(absPath));
  const sidecars = fs
    .readdirSync(dir)
    .filter(
      (f) =>
        f !== videoName &&
        f.startsWith(base + ".") &&
        subExts.includes(path.extname(f).toLowerCase()),
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

module.exports = { deleteVideoFile, insideARoot };

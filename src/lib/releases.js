// Every Aurora release there is, in one list: what /install's Download
// section shows (src/lib/installpage.js) and what /download/<id>/latest hands
// over (server.js). Adding a platform is one entry here.
//
// An entry:
//   id        a short word; a file's download is /download/<id>/latest
//   name      what the tile says; `detail` is the line under it
//   family    tv | phone | computer | web
//   icon      a glyph of lib/platform-icons.js
//   for       the devices it is the first choice on (the head script of
//             install.html names the visitor's: tv, android, ios, windows,
//             mac, linux, chromeos, smarttv) — that tile comes first
//   kind      "file"    a download: `file` (under the repo), its version read
//                       as `read` says, `filename` its name on the visitor's disk
//             "webapp"  no file: `href` is how to get it (the iPhone steps)
//             "web"     no file: `href` opens it (the website)
//   read      "apk"      versionName out of the APK itself (lib/apkinfo.js)
//             "sidecar"  { "version", "date" } from the JSON at `meta`
//             "package"  package.json's version (the website)
//   meta      a JSON beside the file whose `date` dates it (phone-version.json)
//   dated     "changelog": the CHANGELOG release that shipped it dates it
//             (the caller's `dateFor`), else `meta`'s date, else the file's
//   door      the short address that has always handed it over — kept as is
//   action    the tile's button (`short`: its words on a narrow tile)
//   steps     where the page explains installing it; `notes` the What's new tab
//   planned   true: not made yet — shown quietly on the "Coming later" line
//
// State: a file is "available" once it exists and reads, "soon" until then;
// a web entry is always available; a planned one is "planned". The page
// says no more than versions, sizes, dates and checksums.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const apkinfo = require("./apkinfo");

const ROOT = path.join(__dirname, "..", "..");

const RELEASES = [
  {
    id: "tv", name: "Android TV", detail: "and Google TV", family: "tv", icon: "android-tv", for: ["tv"],
    kind: "file", file: "public/aurora-tv.apk", read: "apk", dated: "changelog", filename: "Aurora-TV-{version}.apk",
    door: "/download", action: "Download", steps: "#tv", notes: "tv", note: "Installs with Downloader on the TV",
  },
  {
    id: "phone", name: "Android phone", detail: "Android 7 and later", family: "phone", icon: "android-phone", for: ["android"],
    kind: "file", file: "public/aurora-phone.apk", read: "apk", meta: "public/phone-version.json", filename: "Aurora-Phone-{version}.apk",
    door: "/download/phone", action: "Download", steps: "#android", notes: "phone", note: "Open the file to install it",
  },
  {
    id: "ios", name: "iPhone & iPad", detail: "Web app, no App Store", family: "phone", icon: "apple-phone", for: ["ios"],
    kind: "webapp", href: "#ios", read: "package", action: "Add to Home Screen", short: "Add to Home", steps: "#ios", notes: "web",
  },
  {
    id: "web", name: "Web", detail: "Any browser", family: "web", icon: "web",
    for: ["windows", "mac", "linux", "chromeos", "smarttv", "android", "ios", "other"],
    kind: "web", href: "/", read: "package", action: "Open", steps: "#computer", notes: "web", installable: true,
  },
  // ---- not made yet (the "Coming later" line)
  { id: "windows", name: "Windows", family: "computer", icon: "windows", planned: true },
  { id: "macos", name: "macOS", family: "computer", icon: "apple", planned: true },
  { id: "linux", name: "Linux", family: "computer", icon: "linux", planned: true },
  { id: "firetv", name: "Fire TV", family: "tv", icon: "tv", planned: true },
  { id: "samsung", name: "Samsung TV", family: "tv", icon: "tv", planned: true },
  { id: "lg", name: "LG TV", family: "tv", icon: "lg", planned: true },
  { id: "appletv", name: "Apple TV", family: "tv", icon: "appletv", planned: true },
];

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const isoDay = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
const abs = (rel, root) => path.join(root, rel);
// a version as it may appear in a file name
const safeVersion = (v) => String(v || "").replace(/[^\w.+-]/g, "").slice(0, 40);
const fileName = (entry, version) => entry.filename.replace("{version}", safeVersion(version) || "latest");

// ---------- the checksum ----------
// SHA-256 of each published file, worked out off the main thread's way (a
// stream, not a 45 MB read in one go) and kept per size + mtime: the first
// page after a new build may not have it yet — it says so and is not kept
// (installpage `complete`), the next one has it.
const hashes = new Map(); // abs path -> { key, hex }
const sha256 = (file, st, known) => {
  const key = `${st.size}|${Math.floor(st.mtimeMs)}`;
  const had = hashes.get(file);
  if (had && had.key === key) return had.hex;
  if (known) { hashes.set(file, { key, hex: known }); return known; }
  const slot = { key, hex: null };
  hashes.set(file, slot);
  const h = crypto.createHash("sha256");
  fs.createReadStream(file)
    .on("data", (d) => h.update(d))
    .on("end", () => { slot.hex = h.digest("hex"); })
    .on("error", () => { if (hashes.get(file) === slot) hashes.delete(file); });
  return null;
};

// ---------- one entry's facts ----------
const resolve = (entry, { root = ROOT, dateFor = null, pkg = null } = {}) => {
  const out = {
    id: entry.id, name: entry.name, detail: entry.detail || "", family: entry.family, icon: entry.icon,
    for: entry.for || [], kind: entry.kind || null, action: entry.action || "", steps: entry.steps || null,
    notes: entry.notes || null, note: entry.note || "", short: entry.short || "", installable: !!entry.installable,
    state: "planned", version: null, sizeBytes: null, date: null, sha256: null, href: null, filename: null, door: entry.door || null,
  };
  if (entry.planned) return out;
  if (entry.kind === "web" || entry.kind === "webapp") {
    const p = pkg || readJson(path.join(root, "package.json")) || {};
    out.state = "available";
    out.href = entry.href;
    out.version = p.version || null;
    if (dateFor && out.version) out.date = dateFor(entry, out.version) || null;
    return out;
  }
  // a file
  const file = abs(entry.file, root);
  let st;
  try { st = fs.statSync(file); } catch { out.state = "soon"; return out; }
  let version = null;
  let known = null;
  if (entry.read === "apk") {
    const info = apkinfo.read(file, { hash: false });
    if (info.error) { out.state = "soon"; return out; }
    version = info.versionName;
    known = info.sha256 || null; // (read with its hash elsewhere already: lib/tvapp.js)
  } else if (entry.read === "sidecar") {
    const j = readJson(abs(entry.meta, root));
    version = j && j.version;
    if (!version) { out.state = "soon"; return out; }
  }
  const meta = entry.meta ? readJson(abs(entry.meta, root)) || {} : {};
  out.state = "available";
  out.version = version;
  out.sizeBytes = st.size;
  out.date = (entry.dated === "changelog" && dateFor && dateFor(entry, version)) || (typeof meta.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(meta.date) ? meta.date : null) || isoDay(st.mtimeMs);
  out.href = `/download/${entry.id}/latest`;
  out.filename = fileName(entry, version);
  out.sha256 = sha256(file, st, known);
  return out;
};

// Every entry, resolved, in the list's order.
const list = (opts = {}) => {
  const root = opts.root || ROOT;
  const pkg = readJson(path.join(root, "package.json")) || {};
  return (opts.releases || RELEASES).map((e) => resolve(e, { ...opts, root, pkg }));
};

// ---------- /download/<id>/latest ----------
// The file itself, named for what it is (Aurora-TV-5.8.1.apk), as an
// attachment: one click in any browser and it is on the disk. "latest"
// moves with every build, so a cache must ask again each time. Open in
// every sign-in mode, like /download: no personal data in it.
const sendLatest = (opts = {}) => (req, res) => {
  const root = opts.root || ROOT;
  const entry = (opts.releases || RELEASES).find((e) => e.id === req.params.id && e.kind === "file" && !e.planned);
  if (!entry) return res.status(404).type("text/plain").send("There is no such download.");
  const r = resolve(entry, { root });
  if (r.state !== "available") {
    return res.status(404).type("text/plain").send(`No ${entry.name} build has been published yet.`);
  }
  res.download(abs(entry.file, root), r.filename, { headers: { "Cache-Control": "no-cache" } }, (err) => {
    if (err && !res.headersSent) res.status(404).type("text/plain").send(`No ${entry.name} build has been published yet.`);
  });
};

// Work out the checksums once the server is up, so the first visitor's page
// already has them.
const warm = (opts = {}) => { try { list(opts); } catch {} };

module.exports = { RELEASES, list, resolve, sendLatest, warm, fileName, _internals: { hashes, safeVersion } };

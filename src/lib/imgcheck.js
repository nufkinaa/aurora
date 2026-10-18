// Shared "is this actually an image?" checks for everything that caches
// artwork (online.js poster cache, the /img/ext proxy-cache). Sniffs bytes,
// never extensions — cached files carry lying extensions historically.
const fs = require("fs");

const MIN_IMAGE_BYTES = 1024;

const magicOk = (b) =>
  b.length >= 12 &&
  ((b[0] === 0xff && b[1] === 0xd8) || // JPEG
    (b[0] === 0x89 && b[1] === 0x50) || // PNG
    (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) || // WEBP
    (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)); // GIF

const sniffMime = (b) => {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  return "application/octet-stream";
};

// First 12 bytes of a file, or null. The fd is closed even when readSync
// throws — a leaked descriptor per failed request would add up.
const readHead = (file) => {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(12);
    const got = fs.readSync(fd, head, 0, 12, 0);
    return got === 12 ? head : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
};

// What a picture file is — is it a whole image, and of which type — answered
// from memory while the file on disk is the one that was looked at (same
// date, same size). A cached poster was otherwise opened, read and closed
// twice on EVERY request to be told the same thing: 9 blocking filesystem
// calls per picture where 4 stats do, on a route a Home page asks 300 times.
//   { valid, mime }   valid: validImageFile's answer; mime: the type its
//                     first bytes say, or null when they could not be read
//
// And within TRUST_MS of the last look, not even the stat (server round,
// 2026-10-18): a picture is asked for again and again in a burst (a Home
// page names the same posters in several rows; the TV asks the hero's
// backdrop at three sizes), and the files this checks only ever change by a
// rename (a new download) or a sweep — a sent file that has gone in the
// meantime is a 404 once, and asked about afresh the next time.
const known = new Map(); // file -> { mtimeMs, size, valid, mime, at }
const KNOWN_MAX = 12000;
const TRUST_MS = 30 * 1000;
const look = (file, now = Date.now()) => {
  const fresh = known.get(file);
  // (only a good picture is trusted: a bad one is looked at every time, so a
  // repaired download is served the moment it lands)
  if (fresh && fresh.valid && now - fresh.at < TRUST_MS) return fresh;
  let st;
  try { st = fs.statSync(file); } catch { known.delete(file); return { valid: false, mime: null }; }
  const hit = known.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { hit.at = now; return hit; }
  const head = readHead(file);
  const rec = { mtimeMs: st.mtimeMs, size: st.size, valid: st.size >= MIN_IMAGE_BYTES && !!head && magicOk(head), mime: head ? sniffMime(head) : null, at: now };
  if (known.size >= KNOWN_MAX) known.clear();
  known.set(file, rec);
  return rec;
};

const validImageFile = (file) => look(file).valid;
// The Content-Type for a picture file: what its first bytes say, or null.
const mimeOfFile = (file) => look(file).mime;

module.exports = { MIN_IMAGE_BYTES, magicOk, sniffMime, validImageFile, mimeOfFile, readHead, TRUST_MS, forget: (file) => known.delete(file), _internals: { known, look } };

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

const validImageFile = (file) => {
  try {
    const st = fs.statSync(file);
    if (st.size < MIN_IMAGE_BYTES) return false;
    const head = readHead(file);
    return !!head && magicOk(head);
  } catch {
    return false;
  }
};

module.exports = { MIN_IMAGE_BYTES, magicOk, sniffMime, validImageFile, readHead };

// What an APK file really is: its versionName and versionCode, read out of
// the file itself (the AndroidManifest.xml inside the zip, which Android
// stores as binary XML).
//
// Why: the TV app is told about updates by public/tv-version.json, a file
// written by hand, while the APK next to it is copied there by a build
// script. Nothing tied the two together — a JSON that says 5.0.2 beside an
// APK that is still 5.0.1 (the copy failed, the build was skipped, the pull
// brought one file and not the other) sends every TV into an update that
// installs the version it already has, and asks again half an hour later.
// With this, the server answers from the APK: the version it announces is
// always the version it will hand over.
//
// No dependencies: a zip central-directory walk and a minimal AXML reader,
// reading only the few kilobytes it needs from a 40 MB file.
const fs = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");

const RES_VERSION_CODE = 0x0101021b;
const RES_VERSION_NAME = 0x0101021c;

// ---- zip: pull one entry out by name ----
const readAt = (fd, pos, len) => {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
};

const zipEntry = (fd, size, name) => {
  // End of central directory: in the last 64 KB (a zip comment can pad it)
  const tailLen = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory)");
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = readAt(fd, cdOffset, cdSize);
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const entryName = cd.toString("utf8", p + 46, p + 46 + nameLen);
    if (entryName === name) {
      const local = readAt(fd, localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local header");
      const dataAt = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = readAt(fd, dataAt, compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`unsupported zip method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} not found in the archive`);
};

// ---- Android binary XML: the <manifest> element's attributes ----
const readStringPool = (buf, at) => {
  const headerSize = buf.readUInt16LE(at + 2);
  const count = buf.readUInt32LE(at + 8);
  const flags = buf.readUInt32LE(at + 16);
  const stringsStart = buf.readUInt32LE(at + 20);
  const utf8 = (flags & 0x100) !== 0;
  const strings = [];
  for (let i = 0; i < count; i++) {
    let p = at + stringsStart + buf.readUInt32LE(at + headerSize + i * 4);
    if (utf8) {
      // two lengths: characters (skipped), then bytes — each 1 or 2 bytes
      if (buf[p] & 0x80) p += 2; else p += 1;
      let len = buf[p];
      if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[p + 1]; p += 2; } else p += 1;
      strings.push(buf.toString("utf8", p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
      strings.push(buf.toString("utf16le", p, p + len * 2));
    }
  }
  return strings;
};

const parseManifest = (buf) => {
  if (buf.readUInt16LE(0) !== 0x0003) throw new Error("not binary XML");
  let strings = [];
  let resMap = [];
  let at = buf.readUInt16LE(2);
  while (at + 8 <= buf.length) {
    const type = buf.readUInt16LE(at);
    const size = buf.readUInt32LE(at + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = readStringPool(buf, at);
    else if (type === 0x0180) {
      resMap = [];
      for (let p = at + 8; p + 4 <= at + size; p += 4) resMap.push(buf.readUInt32LE(p));
    } else if (type === 0x0102) {
      const name = strings[buf.readUInt32LE(at + 20)];
      if (name === "manifest") {
        const attrStart = buf.readUInt16LE(at + 24);
        const attrSize = buf.readUInt16LE(at + 26) || 20;
        const attrCount = buf.readUInt16LE(at + 28);
        const out = { versionName: null, versionCode: null, package: null };
        for (let i = 0; i < attrCount; i++) {
          const p = at + 16 + attrStart + i * attrSize;
          const nameIdx = buf.readUInt32LE(p + 4);
          const rawIdx = buf.readInt32LE(p + 8);
          const dataType = buf[p + 15];
          const data = buf.readUInt32LE(p + 16);
          const attrName = strings[nameIdx];
          const res = resMap[nameIdx];
          const str = dataType === 0x03 ? strings[data] : rawIdx >= 0 ? strings[rawIdx] : null;
          if (res === RES_VERSION_CODE || attrName === "versionCode") out.versionCode = dataType === 0x03 ? parseInt(str, 10) || null : data;
          else if (res === RES_VERSION_NAME || attrName === "versionName") out.versionName = str != null ? str : String(data);
          else if (attrName === "package") out.package = str;
        }
        return out;
      }
    }
    at += size;
  }
  throw new Error("no <manifest> element");
};

// ---- the public face ----
// { versionName, versionCode, package, sizeBytes, mtimeMs, sha256 } or
// { error } — cached by size + mtime, so a republished file is re-read once.
let cache = { key: null, info: null };
const read = (apkPath, { hash = true } = {}) => {
  let st;
  try { st = fs.statSync(apkPath); } catch { return { error: "no APK has been published" }; }
  const key = `${apkPath}|${st.size}|${Math.floor(st.mtimeMs)}`;
  if (cache.key === key && (cache.info.sha256 || !hash)) return cache.info;
  let info;
  let fd = null;
  try {
    fd = fs.openSync(apkPath, "r");
    info = { ...parseManifest(zipEntry(fd, st.size, "AndroidManifest.xml")), sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } catch (e) {
    info = { error: `the APK could not be read: ${e.message}`, sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
  if (hash && !info.error) {
    try { info.sha256 = crypto.createHash("sha256").update(fs.readFileSync(apkPath)).digest("hex"); } catch {}
  }
  cache = { key, info };
  return info;
};

module.exports = { read, _internals: { parseManifest, zipEntry } };

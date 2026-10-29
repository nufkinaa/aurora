// Who signed an APK: the SHA-256 of its signing certificate, read out of the
// file itself — the fingerprint Android's App Links check compares against
// /.well-known/assetlinks.json (server.js), so a server that hands out the
// phone app also vouches for it without anyone copying a fingerprint by hand.
//
// Where it is: APK Signature Scheme v2/v3 put an "APK Signing Block" just
// before the zip's central directory:
//
//   uint64 size (of what follows, this field excluded)
//   ID-value pairs: uint64 length, uint32 id, value (length - 4 bytes)
//   uint64 size (the same)
//   "APK Sig Block 42"                                   ← ends at the central directory
//
// The v2 (0x7109871a) and v3 (0xf05368c0) values are a length-prefixed list of
// signers; a signer starts with its length-prefixed "signed data", which
// starts with a length-prefixed list of digests and then a length-prefixed
// list of certificates (each a length-prefixed X.509 DER). Every length is a
// little-endian uint32. The first signer's first certificate is the one.
//
// No dependencies, and only the few kilobytes of the block are read.
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const { readAt, zipLayout } = require("./apkinfo");

const MAGIC = "APK Sig Block 42";
const IDS = [["v2", 0x7109871a], ["v3", 0xf05368c0], ["v3.1", 0x1b93ad61]];
const MAX_BLOCK = 16 * 1024 * 1024;

// A length-prefixed slice at `at` inside `buf` → [slice, next offset].
const lp = (buf, at, what) => {
  if (at + 4 > buf.length) throw new Error(`${what}: truncated`);
  const len = buf.readUInt32LE(at);
  if (at + 4 + len > buf.length) throw new Error(`${what}: length ${len} runs past its container`);
  return [buf.subarray(at + 4, at + 4 + len), at + 4 + len];
};

// PURE: the pairs of a signing block (the bytes between the two size fields)
// → Map id -> value.
const pairsOf = (pairs) => {
  const out = new Map();
  let p = 0;
  while (p + 12 <= pairs.length) {
    const len = Number(pairs.readBigUInt64LE(p));
    if (len < 4 || p + 8 + len > pairs.length) throw new Error("a signing-block entry runs past the block");
    out.set(pairs.readUInt32LE(p + 8), pairs.subarray(p + 12, p + 8 + len));
    p += 8 + len;
  }
  return out;
};

// PURE: a v2/v3 value → the first signer's first certificate (DER).
const firstCert = (value) => {
  const [signers] = lp(value, 0, "signers");
  const [signer] = lp(signers, 0, "signer");
  const [signed] = lp(signer, 0, "signed data");
  const [, afterDigests] = lp(signed, 0, "digests");
  const [certs] = lp(signed, afterDigests, "certificates");
  const [cert] = lp(certs, 0, "certificate");
  if (!cert.length) throw new Error("an empty certificate");
  return cert;
};

// PURE: the bytes from the start of the signing block up to the central
// directory → { scheme, der }.
const certOfBlock = (block) => {
  if (block.length < 32 || block.toString("latin1", block.length - 16) !== MAGIC) throw new Error("no APK Signing Block (only a v1 signature, or none)");
  const size = Number(block.readBigUInt64LE(block.length - 24));
  if (size + 8 !== block.length || Number(block.readBigUInt64LE(0)) !== size) throw new Error("the APK Signing Block's two sizes disagree");
  const pairs = pairsOf(block.subarray(8, block.length - 24));
  for (const [scheme, id] of IDS) if (pairs.has(id)) return { scheme, der: firstCert(pairs.get(id)) };
  throw new Error("the APK Signing Block has no v2 or v3 signature");
};

// "ab:cd:…" / "ABCD…" / with spaces → "AB:CD:…" (32 bytes), or null.
const normalise = (s) => {
  const hex = String(s || "").replace(/[\s:]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/../g).join(":");
};
const fingerprintOf = (der) => normalise(crypto.createHash("sha256").update(der).digest("hex"));

// { sha256: "AB:CD:…", scheme } or { error } — cached per file by size + mtime.
const cache = new Map();
const read = (apkPath) => {
  let st;
  try { st = fs.statSync(apkPath); } catch { return { error: "no APK has been published" }; }
  const key = `${st.size}|${Math.floor(st.mtimeMs)}`;
  const hit = cache.get(apkPath);
  if (hit && hit.key === key) return hit.info;
  let info;
  let fd = null;
  try {
    fd = fs.openSync(apkPath, "r");
    const { cdOffset } = zipLayout(fd, st.size);
    if (cdOffset < 32 || cdOffset > st.size) throw new Error("no APK Signing Block (only a v1 signature, or none)");
    const foot = readAt(fd, cdOffset - 24, 24);
    if (foot.toString("latin1", 8) !== MAGIC) throw new Error("no APK Signing Block (only a v1 signature, or none)");
    const size = Number(foot.readBigUInt64LE(0));
    if (size < 24 || size + 8 > cdOffset || size > MAX_BLOCK) throw new Error("the APK Signing Block's size makes no sense");
    const { scheme, der } = certOfBlock(readAt(fd, cdOffset - size - 8, size + 8));
    info = { sha256: fingerprintOf(der), scheme };
  } catch (e) {
    info = { error: `the APK's signature could not be read: ${e.message}` };
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
  if (cache.size > 8) cache.clear();
  cache.set(apkPath, { key, info });
  return info;
};

module.exports = { read, normalise, _internals: { certOfBlock, pairsOf, firstCert, fingerprintOf, MAGIC, IDS } };

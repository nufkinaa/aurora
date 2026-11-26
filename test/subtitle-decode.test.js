// The server's subtitle reader (media/subtitles.js decodeSubtitle): what a
// sidecar file's bytes say, whatever it was saved as. UTF-16 was missing
// until 1.15.45 — Troy (2004).English.srt (UTF-16LE with a BOM) reached every
// player and Clipwave as "яю1" with no cues.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeSubtitle, srtToVtt } = require("../src/media/subtitles");

const SRT = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello שלום\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nПривет\r\n";
const be = (s) => { const le = Buffer.from(s, "utf16le"); const out = Buffer.alloc(le.length); for (let i = 0; i < le.length; i += 2) { out[i] = le[i + 1]; out[i + 1] = le[i]; } return out; };

test("UTF-16 with a byte-order mark, little and big endian", () => {
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SRT, "utf16le")])), SRT);
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xfe, 0xff]), be(SRT)])), SRT);
});

test("UTF-16 without a mark is told by its zero bytes", () => {
  assert.equal(decodeSubtitle(Buffer.from(SRT, "utf16le")), SRT);
  assert.equal(decodeSubtitle(be(SRT)), SRT);
});

test("what it read before still reads the same: UTF-8 (with a BOM), Windows-1255", () => {
  assert.equal(decodeSubtitle(Buffer.from(SRT, "utf8")), SRT);
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SRT, "utf8")])), SRT);
  const heb = Buffer.from([0x31, 0x0a, 0xf9, 0xec, 0xe5, 0xed]); // "1\nשלום" in Windows-1255
  assert.equal(decodeSubtitle(heb), "1\nשלום");
});

test("a UTF-16 SRT becomes cues", () => {
  const vtt = srtToVtt(decodeSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SRT, "utf16le")])));
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.500\r?\nHello שלום/);
});

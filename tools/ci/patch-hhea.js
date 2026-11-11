#!/usr/bin/env node
// Sets a TrueType font's hhea line metrics, in place — for the browser tests
// on Linux (.github/workflows/ui.yml). Chrome on Windows sizes a line of
// Segoe UI from its usWin metrics (2210 / 514 on 2048 units); Chrome on Linux
// reads hhea, and Selawik (Segoe UI's metric-compatible stand-in) has 2027 /
// -431 there, so every line came out shorter than at home. Giving Selawik's
// hhea the usWin numbers makes a line as tall as it is on the home PC.
//
//   node tools/ci/patch-hhea.js [--from-win] <font.ttf…>
//
// --from-win: copy each font's own OS/2 usWinAscent / usWinDescent into hhea
// (ascender = usWinAscent, descender = -usWinDescent, lineGap = 0).
const fs = require("fs");

const tables = (buf) => {
  const n = buf.readUInt16BE(4);
  const out = {};
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    out[buf.toString("latin1", at, at + 4)] = { entry: at, offset: buf.readUInt32BE(at + 8), length: buf.readUInt32BE(at + 12) };
  }
  return out;
};
const checksum = (buf, offset, length) => {
  let sum = 0;
  for (let i = 0; i < length; i += 4) {
    const b = [0, 1, 2, 3].map((k) => (offset + i + k < offset + length ? buf[offset + i + k] : 0));
    sum = (sum + ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]) >>> 0;
  }
  return sum;
};

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!process.argv.includes("--from-win") || !files.length) {
  console.error("usage: patch-hhea.js --from-win <font.ttf…>");
  process.exit(2);
}
for (const file of files) {
  const buf = fs.readFileSync(file);
  const t = tables(buf);
  if (!t.hhea || !t["OS/2"]) { console.error(`${file}: no hhea or OS/2 table, left as it is`); continue; }
  const os2 = t["OS/2"].offset;
  const winAscent = buf.readUInt16BE(os2 + 74);
  const winDescent = buf.readUInt16BE(os2 + 76);
  const h = t.hhea.offset;
  const before = [buf.readInt16BE(h + 4), buf.readInt16BE(h + 6), buf.readInt16BE(h + 8)];
  buf.writeInt16BE(winAscent, h + 4);
  buf.writeInt16BE(-winDescent, h + 6);
  buf.writeInt16BE(0, h + 8);
  buf.writeUInt32BE(checksum(buf, h, t.hhea.length), t.hhea.entry + 4);
  fs.writeFileSync(file, buf);
  console.log(`${file}: hhea ${before.join(" / ")} -> ${winAscent} / ${-winDescent} / 0`);
}

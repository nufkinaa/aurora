// list the ISOBMFF boxes of an AVIF (and the colr/av1C contents)
const fs = require("fs"); const b = fs.readFileSync(process.argv[2]);
const CONT = new Set(["meta", "iprp", "ipco", "dinf", "iinf"]);
const walk = (s, e, d) => { let o = s; while (o + 8 <= e) { let sz = b.readUInt32BE(o); const t = b.toString("latin1", o + 4, o + 8); if (sz === 1) sz = Number(b.readBigUInt64BE(o + 8)); if (sz === 0) sz = e - o;
  let extra = ""; if (t === "ftyp") extra = b.toString("latin1", o + 8, o + 12) + " compat " + b.toString("latin1", o + 16, o + sz);
  if (t === "colr") { const ct = b.toString("latin1", o + 8, o + 12); extra = ct === "nclx" ? `nclx prim=${b.readUInt16BE(o + 12)} trc=${b.readUInt16BE(o + 14)} matrix=${b.readUInt16BE(o + 16)} full=${b[o + 18] >> 7}` : ct; }
  if (t === "ispe") extra = `${b.readUInt32BE(o + 12)}x${b.readUInt32BE(o + 16)}`;
  if (t === "pixi") extra = `ch=${b[o + 12]} bits=${b[o + 13]}`;
  if (t === "av1C") { const x = b[o + 9], y = b[o + 10]; extra = `profile=${x >> 5} level=${x & 31} hbd=${(y >> 6) & 1} mono=${(y >> 4) & 1} subx=${(y >> 3) & 1} suby=${(y >> 2) & 1}`; }
  console.log("  ".repeat(d) + t, sz, extra);
  if (CONT.has(t)) walk(o + (t === "meta" ? 12 : t === "iinf" ? 14 : 8), o + sz, d + 1);
  o += sz; } };
walk(0, b.length, 0);

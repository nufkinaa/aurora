// Bakes the player's gradient scrims into PNGs.
//
// React Native has no equivalent of CSS `linear-gradient`, and pulling in a
// native gradient library for two static overlays is not worth a dependency.
// The site's scrims are pure black at varying alpha, so a stretched 8-bit
// grayscale+alpha PNG reproduces them exactly and costs one decode.
//
// Written with node's own zlib — no image library. Run:
//   node tools/gen-gradients.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', 'assets');

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = buf => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// RGBA (colour type 6). Grayscale+alpha (type 4) would be half the bytes, but
// these files are under a kilobyte either way and RGBA is the format every
// Android decoder handles without question — not worth risking a scrim that
// silently fails to appear on some device.
//
// `rgbAt` returns the [r,g,b] for a row; `alphaAt` its opacity.
const writePng = (file, width, height, alphaAt, rgbAt = () => [0, 0, 0]) => {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    const t = y / (height - 1);
    const a = Math.max(0, Math.min(255, Math.round(alphaAt(t) * 255)));
    const [r, g, b] = rgbAt(t);
    for (let x = 0; x < width; x++) {
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, {level: 9})),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
  console.log('wrote', path.basename(file), `${width}x${height}`);
};

// Interpolating between stops LINEARLY leaves a visible slope change at each
// stop — a Mach band, which on a dark TV panel reads as a hard line across the
// picture. Smoothstep makes the derivative zero at every stop, so the segments
// join invisibly.
const smoothstep = t => t * t * (3 - 2 * t);
const rampFrom = stops => t => {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [p1, a1] = stops[i];
    if (t <= p1) {
      const [p0, a0] = stops[i - 1];
      return a0 + (a1 - a0) * smoothstep((t - p0) / (p1 - p0));
    }
  }
  return stops[stops.length - 1][1];
};

// .player-top — linear-gradient(to bottom, rgba(0,0,0,.75), transparent)
writePng(
  path.join(OUT, 'player-top.png'),
  4,
  512,
  rampFrom([
    [0, 0.75],
    [1, 0],
  ]),
);

// .card-shade — linear-gradient(to top, rgba(5,6,12,0.92) 0%, transparent 45%).
// Always on for wide cards (it's what the label sits on), so the label stays
// readable over any still.
writePng(
  path.join(OUT, 'card-shade.png'),
  4,
  256,
  rampFrom([
    [0, 0],
    [0.55, 0],
    [1, 0.92],
  ]),
  () => [5, 6, 12],
);

// .player-bottom — linear-gradient(to top, rgba(0,0,0,.88) 0%,
//   rgba(0,0,0,.45) 55%, transparent 100%). Written top-down, so the site's
// "to top" stops are reversed here.
writePng(
  path.join(OUT, 'player-bottom.png'),
  4,
  512,
  rampFrom([
    [0, 0],
    [0.45, 0.45],
    [1, 0.88],
  ]),
);

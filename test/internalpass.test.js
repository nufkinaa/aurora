// The server's pass for its own loopback requests (lib/internalpass.js).
const test = require("node:test");
const assert = require("node:assert");
const pass = require("../src/lib/internalpass");

test("only the exact per-process value passes; anything else, or nothing, does not", () => {
  assert.equal(pass.ok({ headers: { [pass.HEADER]: pass.value } }), true);
  assert.equal(pass.ok({ headers: {} }), false);
  assert.equal(pass.ok({ headers: { [pass.HEADER]: "" } }), false);
  assert.equal(pass.ok({ headers: { [pass.HEADER]: "0".repeat(pass.value.length) } }), false);
  assert.equal(pass.ok({ headers: { [pass.HEADER]: pass.value + "0" } }), false);
  assert.equal(pass.ok({ headers: { [pass.HEADER]: [pass.value] } }), false);
  assert.equal(pass.ok(null), false);
  assert.match(pass.value, /^[0-9a-f]{64}$/);
});

// ffmpeg / ffprobe reading the server's own torrent route on a sign-in-required
// server: the pass rides as an input option (-headers), and every place that
// hands them a http://127.0.0.1:<port>/stream/torrent/… URL adds it (before
// 1.10.1 they were answered 401: the torrent probe failed, and a torrent not
// yet whole on disk could not be repackaged or encoded — capacity-2026-10).
test("ffArgs: one -headers option carrying exactly the pass, CRLF-terminated", () => {
  const a = pass.ffArgs();
  assert.equal(a.length, 2);
  assert.equal(a[0], "-headers");
  const line = a[1];
  assert.ok(line.endsWith(String.fromCharCode(13, 10)));
  const [name, ...rest] = line.trim().split(":");
  assert.equal(name.toLowerCase(), pass.HEADER);
  assert.equal(pass.ok({ headers: { [pass.HEADER]: rest.join(":").trim() } }), true);
});

test("every loopback read of /stream/torrent by ffmpeg / ffprobe carries the pass", () => {
  const fs = require("fs");
  const path = require("path");
  for (const f of ["src/media/streamprobe.js", "src/media/torrent-transcode.js", "src/routes/torrent.js", "src/media/tonemap.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.match(src, /internalpass"\)\.ffArgs\(\)/, `${f} hands ffmpeg/ffprobe our own URL without the pass`);
  }
  // tonemap.probeJson is the one probe the ladder and tone mapping share: the pass is on its http branch
  const tm = fs.readFileSync(path.join(__dirname, "..", "src/media/tonemap.js"), "utf8");
  assert.match(tm, /http \? \[[^\]]*ffArgs\(\)/);
});

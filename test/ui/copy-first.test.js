// A film the browser could play as the FILE, on a line not known to carry its
// busy stretches (research-stream-efficiency, 2026-11-28 — playstart.js
// fileNeedsBuffer): it opens as its own picture copied into the jit stream —
// the single playlist, so hls.js holds a deep buffer — and nothing is
// encoded: no master playlist, no lighter rendition asked for, until the
// stall rule's step-down would ask anyway (direct-buffer.test.js). A line
// known to be fast keeps the file; so does a device that switched it off.
// Test Film One: MP4, H.264 + AAC, ~0.35 Mbit/s.
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const ui = suite();

const watch = (page, srv) => {
  const asked = [];
  page.on("request", (r) => {
    const u = r.url().replace(srv.url, "");
    if (/\/stream\//.test(u)) asked.push(u);
  });
  return asked;
};

ui.test("a line known to be thin for the film: its own picture as a jit stream, nothing encoded", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile(), { line: 300 });
  const asked = watch(page, srv);
  const marks = player.marks(page);
  await player.open(page, srv, lib.film1.id);
  const path = await marks.wait((m) => m.name === "path", 8000, "the path mark");
  assert.equal(path.path, "jit", "opened as the stream");
  await player.advancing(page, { by: 1, timeout: 20000 });
  const s = await player.state(page);
  assert.ok(/\/jit\/index\.m3u8/.test(s.src) || asked.some((u) => /\/jit\/index\.m3u8/.test(u)), `the single jit playlist (${s.src})`);
  assert.deepEqual(asked.filter((u) => /\/jit\/master\.m3u8/.test(u)), [], "no master playlist: no lighter rendition is offered");
  assert.deepEqual(asked.filter((u) => /[?&]v=h264/.test(u)), [], "no encoded rendition was asked for");
  assert.deepEqual(asked.filter((u) => /\/stream\/video\//.test(u)), [], "the file itself was not opened");
  const d = marks.named("decision").map((m) => m.why || "").join(" | ");
  assert.match(d, /its own picture as a stream/);
});

ui.test("a line not known at all: the same — a first play is the deep-buffered stream", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile(), { line: 0 });
  const marks = player.marks(page);
  await player.open(page, srv, lib.film1.id);
  assert.equal((await marks.wait((m) => m.name === "path", 8000)).path, "jit");
  await player.advancing(page, { by: 1, timeout: 20000 });
});

ui.test("a line known to be fast keeps the file", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile(), { line: 100000 });
  const asked = watch(page, srv);
  const marks = player.marks(page);
  await player.open(page, srv, lib.film1.id);
  assert.equal((await marks.wait((m) => m.name === "path", 8000)).path, "direct");
  await player.advancing(page, { by: 1, timeout: 20000 });
  assert.deepEqual(asked.filter((u) => /\/jit\//.test(u)), [], "no jit stream");
});

ui.test("switched off on this device (aurora-ladder-first = 0): the file, whatever the line", async ({ page, srv, signIn, freshProfile, lib }) => {
  await page.addInitScript(() => { try { localStorage.setItem("aurora-ladder-first", "0"); } catch {} });
  await signIn(await freshProfile(), { line: 300 });
  const marks = player.marks(page);
  await player.open(page, srv, lib.film1.id);
  assert.equal((await marks.wait((m) => m.name === "path", 8000)).path, "direct");
});

ui.run({ concurrency: 2 });

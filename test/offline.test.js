// Offline copies: which qualities are offered, and that "original" is a
// repackage (video copied) rather than an encode when the device can play it.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const metadata = require("../src/media/metadata");
const offline = require("../src/media/offline");
const { originalMode, argsFor, normQuality, outFileFor } = offline._internals;

const withMeta = (file, meta, fn) => {
  const orig = metadata.getCached;
  metadata.getCached = (p) => (p === file ? meta : orig(p));
  try { return fn(); } finally { metadata.getCached = orig; }
};

test("an H.264 MKV is offered as original via a remux — video copied, audio to AAC", () => {
  const f = "/lib/Film (2020)/Film.mkv";
  withMeta(f, { duration: 6000, height: 1080, width: 1920, video: { codec: "h264", bitDepth: 8 }, audioStreams: [{ codec: "ac3" }] }, () => {
    assert.equal(originalMode(f, {}), "remux");
    const args = argsFor(f, "/tmp/out.part", "original", {});
    assert.ok(args.join(" ").includes("-c:v copy"), "the picture is not re-encoded");
    assert.ok(args.join(" ").includes("-c:a aac"), "AC-3 becomes AAC");
    assert.ok(!args.includes("libx264"));
  });
});

test("HEVC is original only where the device says it plays HEVC, and gets the hvc1 tag", () => {
  const f = "/lib/Film (2021)/Film.mkv";
  withMeta(f, { duration: 6000, height: 2160, video: { codec: "hevc", bitDepth: 10 }, audioStreams: [{ codec: "eac3" }] }, () => {
    assert.equal(originalMode(f, {}), null, "no HEVC support → no original");
    assert.equal(originalMode(f, { hevc: true }), "remux");
    assert.ok(argsFor(f, "/tmp/o.part", "original", { hevc: true }).join(" ").includes("-tag:v hvc1"));
  });
});

test("a sized copy is a real encode at that height, never upscaled", () => {
  const f = "/lib/Film (2022)/Film.mkv";
  withMeta(f, { duration: 6000, height: 1080, video: { codec: "hevc", bitDepth: 10 }, audioStreams: [{ codec: "dts" }] }, () => {
    const a = argsFor(f, "/tmp/o.part", "480", {}).join(" ");
    assert.ok(a.includes("libx264") && a.includes("min(480,ih)"));
  });
});

test("quality names: unknown falls back to 720, and 720 keeps the old file name", () => {
  assert.equal(normQuality("banana"), "720");
  assert.equal(normQuality("original"), "original");
  const f = "/nowhere/x.mkv";
  assert.ok(path.basename(outFileFor("abc", f, "720")).match(/^abc-\d+\.mp4$/));
  assert.ok(path.basename(outFileFor("abc", f, "1080")).match(/^abc-\d+-1080\.mp4$/));
});

test("copies on the server are temporary: old ones go, the folder has a cap, a copy being written stays", () => {
  const { toRemove } = offline._internals;
  const now = 1_000_000_000;
  const h = 3600 * 1000;
  const c = (name, size, hoursAgo) => ({ file: "/c/" + name, name, size, usedAt: now - hoursAgo * h });
  // unused for over half a day → gone; a crashed .part → gone
  let gone = toRemove([c("old.mp4", 10, 20), c("crash.mp4.part", 5, 1), c("fresh.mp4", 10, 1)], { now, maxBytes: 1000 });
  assert.deepEqual(gone.map((g) => g.name).sort(), ["crash.mp4.part", "old.mp4"]);
  // over the cap → the least recently used go first, only as many as needed
  gone = toRemove([c("a.mp4", 60, 5), c("b.mp4", 60, 3), c("c.mp4", 60, 1)], { now, maxBytes: 130 });
  assert.deepEqual(gone.map((g) => g.name), ["a.mp4"]);
  // the conversion in progress is never removed, whatever its age
  gone = toRemove([c("w.mp4.part", 500, 30)], { now, maxBytes: 10, busy: (f) => f === "/c/w.mp4.part" });
  assert.equal(gone.length, 0);
});

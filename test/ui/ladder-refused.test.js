// A quality ladder whose encoded rungs the server refuses one after the other
// (404 — jit declined the file's encodes: media/jit.js never bridges an encoded
// rendition). Each refused rung leaves the ladder BY ITS OWN RENDITION (the
// failed request's ?v=), not by a level index the previous drop has shifted;
// the film plays on its copy. (2026-11-28: a 4K film froze 57 s on 25 Mbit/s
// when the second refusal was read as the copy's.)
// Test Film Two (MKV, AC-3) plays on the jit ladder in this browser; a line
// remembered as thin makes the player begin on an encoded rung.
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const ui = suite();

ui.test("both encoded rungs refused: each leaves the ladder by name, the copy plays on", { allow: [/Failed to load resource.*404/] }, async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile(), { line: 300 });
  const refused = [];
  // The test films are 360p, so their real ladder is the copy alone: two lighter
  // H.264 rungs are written into its master here (the server would offer them for
  // a taller film), and every request for either is refused below.
  await page.route(/\/jit\/master\.m3u8/, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    const NL = String.fromCharCode(10);
    const extra = [
      '#EXT-X-STREAM-INF:BANDWIDTH=220000,AVERAGE-BANDWIDTH=180000,RESOLUTION=480x270,CODECS="avc1.64001e,mp4a.40.2"',
      "index.m3u8?v=h264-480",
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,AVERAGE-BANDWIDTH=250000,RESOLUTION=560x316,CODECS="avc1.64001e,mp4a.40.2"',
      "index.m3u8?v=h264-720",
    ].join(NL);
    return route.fulfill({ response: res, body: body.trimEnd() + NL + extra + NL });
  });
  await page.route(/\/stream\/transcode\/[^/]+\/jit\/[^?]+\?(.*&)?v=h264-(480|720)/, (route) => {
    refused.push(/v=(h264-\d+)/.exec(route.request().url())[1]);
    return route.fulfill({ status: 404, body: "This file cannot be re-encoded on the full timeline" });
  });
  const marks = player.marks(page);
  await player.open(page, srv, lib.film2.id, { min: 0.5 });
  await player.advancing(page, { by: 2, timeout: 30000 });
  assert.ok(refused.length > 0, "an encoded rung was asked for (the thin line's start)");
  const dropped = marks.named("ladder-drop").map((m) => m.v);
  for (const v of new Set(refused)) assert.ok(dropped.includes(v), `${v} was refused and left the ladder (dropped: ${dropped.join(", ")})`);
  assert.ok(!dropped.includes("copy"), "the copy stayed");
  assert.equal(marks.named("jit-refused").length, 0, "a refused encoded rung is not the stream refused");
  assert.equal(await page.locator(".player .error-card, .player-error").count(), 0, "no error card");
});

ui.run();

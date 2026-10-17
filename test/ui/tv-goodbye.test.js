// The TV app's goodbye, against a real server and a real ffmpeg (a private
// instance, scripts/ui-test-server.js): leaving the player stops the OFFSET
// transcode that TV was reading (the route the TV plays a remux through),
// and only that TV's — the request shape is the app's: ExoPlayer reads the
// playlist with its own user agent, the goodbye goes out through fetch with
// another, and both carry the app's X-Aurora-Viewer tag. No browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("../../scripts/ui-test-server");

let srv = null;
let film = null;
test.before(async () => {
  srv = await start();
  const lib = await (await fetch(`${srv.url}/api/library`)).json();
  film = lib.movies.find((m) => /Two/i.test(m.title)) || lib.movies[0];
});
test.after(async () => {
  if (srv) await srv.stop();
});

const TV = { "X-Aurora-Viewer": "tvrunAAAA1111", "User-Agent": "ExoPlayerLib/1.8 (Linux; Android 11)" };
const TV_FETCH = { "X-Aurora-Viewer": "tvrunAAAA1111", "User-Agent": "okhttp/4.12.0" };
const OTHER_TV = { "X-Aurora-Viewer": "tvrunBBBB2222", "User-Agent": "okhttp/4.12.0" };
const bye = (h) => fetch(`${srv.url}/stream/transcode/${film.id}/jit/bye`, { method: "POST", headers: h });
const stopped = () => srv.log().filter((l) => /\[remux\] its viewer left:/.test(l));

test("a TV's goodbye stops its own offset transcode at once; another TV's goodbye does not", async (t) => {
  const before = stopped().length;
  // a start through the re-encode (the TV's claim carries &seek=1)
  const r = await fetch(`${srv.url}/stream/transcode/${film.id}/0/index.m3u8?v=h264&seek=1`, { headers: TV });
  assert.equal(r.status, 200);
  const first = await r.text();
  // The film is short and ffmpeg is quick: what is asserted is only what a
  // goodbye did while the encode was still running.
  if (first.includes("#EXT-X-ENDLIST")) return t.skip("the encode had already finished");
  assert.equal((await bye(OTHER_TV)).status, 204);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(stopped().length, before, "a goodbye from a TV that never read it stops nothing");
  assert.equal((await bye(TV_FETCH)).status, 204);
  // the log line is written synchronously by the stop
  await new Promise((res) => setTimeout(res, 50));
  const lines = stopped().slice(before);
  if (!lines.length) {
    // the only honest way to get none: the encode reached its end first
    const now = await (await fetch(`${srv.url}/stream/transcode/${film.id}/0/index.m3u8?v=h264&seek=1`, { headers: TV })).text();
    assert.ok(now.includes("#EXT-X-ENDLIST"), "the goodbye stopped nothing while the encode was running");
    return;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`${film.id}-\\d+-h264-0`));
});

test("the goodbye still answers 204 for a film with nothing running, and for an unknown id", async () => {
  assert.equal((await bye(TV_FETCH)).status, 204);
  assert.equal((await fetch(`${srv.url}/stream/transcode/nosuchfilm/jit/bye`, { method: "POST", headers: TV_FETCH })).status, 204);
});

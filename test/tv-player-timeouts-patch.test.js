// The TV app's player reads films and segments through React Native's shared
// OkHttp client, which has NO timeouts (connect/read/write 0). A connection
// that goes silent without closing then held the player's loader for ever:
// measured on the Mi TV behind a proxy that freezes its connections, the
// picture froze for 29.8 s once the 100 s it had buffered ran out, until the
// app's own watchdog re-issued the stream. The patch to react-native-video
// gives the player's client its own connect and read timeouts, so the loader
// gives up on a dead connection and retries on a fresh one while the buffer
// still covers it. If the patch is ever lost in an upgrade, this fails before
// a release does.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

test("the react-native-video patch gives the player's HTTP client connect and read timeouts", () => {
  const dir = path.join(__dirname, "..", "tv-native", "patches");
  const files = fs.readdirSync(dir).filter((f) => /^react-native-video\+.*\.patch$/.test(f));
  assert.equal(files.length, 1, "one react-native-video patch file");
  const patch = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.match(patch, /DataSourceUtil\.kt/);
  assert.match(patch, /\+\s+val client = OkHttpClientProvider\.getOkHttpClient\(\)\.newBuilder\(\)/);
  assert.match(patch, /\+\s+\.connectTimeout\(10, java\.util\.concurrent\.TimeUnit\.SECONDS\)/);
  assert.match(patch, /\+\s+\.readTimeout\(20, java\.util\.concurrent\.TimeUnit\.SECONDS\)/);
});

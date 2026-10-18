// The owner, 2026-10-18: "No cap on downloads at all". The server round added
// a torrent upload cap setting (torrentUploadKBps); it is OFF unless the admin
// sets it, and nothing else from the round limits a torrent's speed or its
// connections.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("torrentUploadKBps: off (-1) by default; the client gets an uploadLimit only when it is set above 0", () => {
  // (the tests run without a config.json, or with one that does not set it)
  const config = require("../src/config");
  assert.equal(config.TORRENT_UPLOAD_KBPS, -1);
});

test("torrent.js: no new speed or connection limit — uploadLimit is conditional, the connection count is master's", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "media", "torrent.js"), "utf8");
  assert.match(src, /config\.TORRENT_UPLOAD_KBPS > 0 \? \{ uploadLimit: config\.TORRENT_UPLOAD_KBPS \* 1024 \} : \{\}/);
  assert.doesNotMatch(src, /downloadLimit\s*:/, "no download speed limit");
  const conns = [...src.matchAll(/maxConns:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(conns, [40], "the client's connection count is the one 1.7.2 had");
});

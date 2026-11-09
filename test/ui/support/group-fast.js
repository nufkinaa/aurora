// Preloaded (node -r, after the fence) into a private instance by the
// "What do we watch tonight?" tests: the session timeouts made short, so a
// code that expires can be watched expiring. Nothing else of the app changes.
//
//   UI_GROUP_FAST=1    turns it on (the instance's env, ui-test-server opts.env)
//   UI_GROUP_LOBBY_MS / UI_GROUP_KEEP_MS / UI_GROUP_AWAY_MS   the numbers (ms)
"use strict";
const path = require("path");

if (process.env.UI_GROUP_FAST === "1") {
  const gp = require(path.join(process.cwd(), "src", "lib", "grouppick.js"));
  const num = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d);
  gp.configure({
    lobbyMs: num("UI_GROUP_LOBBY_MS", 6000),
    keepMs: num("UI_GROUP_KEEP_MS", 4000),
    awayMs: num("UI_GROUP_AWAY_MS", 75000),
  });
}

// Preloaded into tv-instance.js's private server: every 2 s, config.TV_PLAYER
// (what GET /api/tv/tuning hands the TV app — src/lib/tvtuning.js) is read from
// the JSON file named by AURORA_RIG_TV_TUNING, so one running server can be
// switched between start-buffer settings without a restart (a restart would
// give it a new data folder, a new profile id, and send the TV back to its
// profile wall). The app re-asks on every launch.
"use strict";
const fs = require("fs");
const path = require("path");
const file = process.env.AURORA_RIG_TV_TUNING;
if (file) {
  let last = "";
  const tick = () => {
    try {
      const txt = fs.readFileSync(file, "utf8");
      if (txt === last) return;
      last = txt;
      const config = require(path.join(process.cwd(), "src", "config.js"));
      config.TV_PLAYER = JSON.parse(txt || "null");
      process.stdout.write(`[rig-tv] tvPlayer = ${txt.trim()}\n`);
    } catch {}
  };
  setTimeout(tick, 500);
  setInterval(tick, 2000).unref();
}

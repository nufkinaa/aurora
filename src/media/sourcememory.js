// What happened when a source was used HERE: per title, per torrent — did it
// stall, lose a second-source race, fail its probe, or win. The download
// queue reads it to avoid starting a race against a source that already let
// this title down, and getSources' ranking reads it as a small nudge.
//
//   { "<imdbId>[:<season>:<episode>]": { "<infoHash>": { o: "stalled", at: 1760000000000 } } }
//
// Entries expire (dlrace.DEFAULTS.memoryDays): swarms recover, and a release
// that had no seeders in its first hour is often the best one a week later.
// The rules are in media/dlrace.js; this is only the file.
const path = require("path");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");
const dlrace = require("./dlrace");

const store = new JsonStore(path.join(config.DATA_DIR, "dlsources.json"), {});
const cfg = () => dlrace.resolveConfig(config.DOWNLOAD_RACE);

const record = (key, infoHash, outcome, now = Date.now()) => {
  if (!key || !infoHash || !dlrace.OUTCOMES.includes(outcome)) return;
  const data = store.data && typeof store.data === "object" ? store.data : {};
  (data[key] = data[key] || {})[String(infoHash).toLowerCase()] = { o: outcome, at: now };
  store.data = dlrace.pruneMemory(data, now, cfg());
  store.save();
};

// One title's outcomes (expired ones included — every reader checks dates).
const forTitle = (key) => (key && store.data && store.data[key]) || null;

module.exports = { record, forTitle, _internals: { store } };

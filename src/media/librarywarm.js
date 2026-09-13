// Warm what the detail page needs for titles ON DISK, ahead of anyone
// opening them: the IMDb id (so a library title is recognised as the same
// title everywhere, and lists its other versions), and the Cinemeta metadata
// (backdrop, cast, episode titles) that used to cost the page a 5-10 second
// wait the first time. Runs after every scan, one title at a time with a
// breath between requests, and skips anything already cached — so a settled
// library costs nothing and a new download costs two requests.
const scanner = require("./scanner");
const imdb = require("./imdb");
const discover = require("./discover");

const SPACING_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;
let again = false; // a scan landed while a pass was running

const pass = async () => {
  let ids = 0;
  let metas = 0;
  for (const item of scanner.allItems()) {
    const type = item.type === "show" ? "show" : "movie";
    let imdbId = imdb.cachedIdFor(item.title, type, item.year);
    if (!imdbId) {
      // resolve() caches misses for a week, so an unknown title is asked
      // about once, not on every scan.
      imdbId = await imdb.resolve(item.title, type, item.year).catch(() => null);
      ids++;
      await sleep(SPACING_MS);
    }
    if (!imdbId) continue;
    if (!discover.metaCached(type, imdbId)) {
      await discover.meta(type, imdbId).catch(() => null);
      metas++;
      await sleep(SPACING_MS);
    }
  }
  if (ids || metas) console.log(`[warm] library: ${ids} ids resolved, ${metas} metadata fetched`);
};

const warm = async () => {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await pass();
    } while (again);
  } catch (e) {
    console.warn("[warm] library warm failed:", e && e.message ? e.message : e);
  } finally {
    running = false;
  }
};

// Deferred a little so boot (and the scan itself) finishes first.
scanner.events.on("scanned", () => setTimeout(warm, 3000));

module.exports = { warm, _internals: { pass } };

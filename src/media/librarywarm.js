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
// How old a title on disk's metadata may get before the warmer asks again.
// (It was every 12 hours — the meta cache's freshness — after every rescan:
// each title on disk asked about twice a day, and a title Cinemeta did not
// answer, six times an hour.)
const WARM_EVERY_MS = 7 * 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;
let again = false; // a scan landed while a pass was running

const pass = async () => {
  let ids = 0;
  let metas = 0;
  for (const item of scanner.allItems()) {
    const type = item.type === "show" ? "show" : "movie";
    // (a year the scanner only guessed is not the cache's key — identity.js)
    let imdbId =
      imdb.cachedIdFor(item.title, type, item.year) ||
      (item.yearGuessed ? imdb.cachedIdFor(item.title, type, null) : null);
    if (!imdbId) {
      // resolve() caches misses for a week, so an unknown title is asked
      // about once, not on every scan.
      imdbId = await imdb.resolve(item.title, type, item.year).catch(() => null);
      ids++;
      await sleep(SPACING_MS);
    }
    if (!imdbId) continue;
    // once a week per title on disk (a title page that is opened refreshes
    // its own answer after 12 hours: discover.js, stale while revalidate);
    // one Cinemeta would not answer waits out its back-off
    const age = discover.metaAge ? discover.metaAge(type, imdbId) : null;
    if ((age == null || age > WARM_EVERY_MS) && !(discover.metaRecentlyFailed && discover.metaRecentlyFailed(type, imdbId))) {
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

module.exports = { warm, _internals: { pass, WARM_EVERY_MS } };

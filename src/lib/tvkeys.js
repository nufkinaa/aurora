// The keyframes of a library file, for the TV (GET /api/tv/keyframes/:id).
//
// Why the TV asks: ExoPlayer seeks EXACTLY. To show the picture at a second
// that is not a keyframe it decodes every frame from the keyframe before it,
// unseen — on the Mi TV about 0.1 s per second of film (streaming round 2,
// docs/qa/streaming-round-2/tv.md: a seek to 10.3 s past a keyframe 1.3 s,
// to the keyframe itself 0.11 s). The films here have keyframes up to ~10 s
// apart, so a resume was often a second of black. A resume is already "a few
// seconds before where you stopped" (episodeRules.ts: 4 s back); the TV lands
// it on a keyframe inside that leeway (tv-native/src/playback/keyframes.ts),
// and the picture comes at once.
//
// The times come from the file's own index — the same readers jit uses
// (media/mkvindex.js: the Matroska Cues of the video track; media/mp4index.js:
// the sync samples): a few small reads of the file's head and its index, done
// once per file (kept here, by path + size + mtime). Anything the readers do
// not take (an AVI, a damaged index) answers `keys: null` and the TV seeks as
// it always did.
"use strict";

const fs = require("fs");
const { parseMkvIndex } = require("../media/mkvindex");
const { parseMp4Index } = require("../media/mp4index");

const MAX_FILES = 100;
// (a 2.5-hour film with keyframes every ~2 s is ~4,500 times; far above any
// real file, a list this long is not worth sending)
const MAX_KEYS = 20000;
const cache = new Map(); // path|size|mtime -> Promise<number[]|null>

const readKeys = async (filePath, size) => {
  const fh = await fs.promises.open(filePath, "r");
  try {
    const readRange = async (start, len) => {
      const b = Buffer.alloc(len);
      await fh.read(b, 0, len, start);
      return b;
    };
    let index = await parseMkvIndex(readRange, size);
    if (!index && /\.(mp4|m4v|mov)$/i.test(filePath)) index = await parseMp4Index(readRange, size);
    if (!index || !Array.isArray(index.cues) || index.cues.length < 2 || index.cues.length > MAX_KEYS) return null;
    return index.cues.map((c) => Math.round(c.t * 1000) / 1000);
  } finally {
    await fh.close().catch(() => {});
  }
};

/** The keyframe times (seconds, ascending) of the file at `filePath`, or null. */
const keyframesOf = async (filePath) => {
  let st;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  const key = `${filePath}|${st.size}|${st.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = readKeys(filePath, st.size).catch(() => null);
  while (cache.size >= MAX_FILES) cache.delete(cache.keys().next().value);
  cache.set(key, p);
  // a failure that may pass (a drive waking) is not kept
  p.then((v) => { if (v == null) cache.delete(key); });
  return p;
};

/** The answer for a library item id: {v: 1, keys: number[] | null}. */
const forItem = async (id, resolve = (x) => require("../media/scanner").resolve(x)) => {
  const entry = typeof id === "string" && id && !id.startsWith("torrent|") ? resolve(id) : null;
  if (!entry || entry.kind !== "video" || !entry.path) return { v: 1, keys: null };
  return { v: 1, keys: await keyframesOf(entry.path) };
};

module.exports = { keyframesOf, forItem, _cache: cache };

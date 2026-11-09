// The progress bar's preview pictures, the website's side. PURE — no imports
// (test/scrubpreview-web.test.js runs it as it is; screens/player.js draws).
// The server makes them (src/media/scrubsprites.js — its tileAt is this one)
// and answers GET /api/scrub/:id with { ready:false } until they exist, or
//   { ready:true, interval, w, h, cols, rows, count, sheets:[url…] }
// Sheet n holds pictures n·cols·rows … as a cols x rows grid of w x h tiles.
// The TV and the phone app carry the same arithmetic
// (tv-native/src/playback/scrubPreview.ts).

// The server's answer, read: the index, or null (no pictures: scrub as before).
export const readScrubIndex = (answer) => {
  if (!answer || typeof answer !== "object" || answer.ready !== true) return null;
  const n = (k) => Number(answer[k]);
  const idx = { interval: n("interval"), w: n("w"), h: n("h"), cols: n("cols"), rows: n("rows"), count: n("count"), sheets: Array.isArray(answer.sheets) ? answer.sheets.filter((s) => typeof s === "string" && s) : [] };
  for (const k of ["interval", "w", "h", "cols", "rows", "count"]) if (!(idx[k] > 0) || !Number.isFinite(idx[k])) return null;
  if (idx.sheets.length < Math.ceil(idx.count / (idx.cols * idx.rows))) return null;
  return idx;
};

// The picture for second t: { i, sheet, x, y, w, h } (sheet pixels), or null.
export const tileAt = (index, t) => {
  if (!index || !(index.count > 0) || !(index.interval > 0)) return null;
  const per = index.cols * index.rows;
  const i = Math.max(0, Math.min(index.count - 1, Math.round((Number(t) || 0) / index.interval)));
  const k = i % per;
  return { i, sheet: Math.floor(i / per), x: (k % index.cols) * index.w, y: Math.floor(k / index.cols) * index.h, w: index.w, h: index.h };
};

// The CSS of a box `boxW` px wide that shows the picture for second t:
// { url, width, height, size, position } — or null.
export const thumbCss = (index, t, boxW) => {
  const tile = tileAt(index, t);
  if (!tile) return null;
  const s = boxW / tile.w;
  const url = index.sheets[tile.sheet];
  if (!url) return null;
  return {
    url,
    width: Math.round(boxW),
    height: Math.round(tile.h * s),
    size: `${Math.round(index.cols * tile.w * s)}px ${Math.round(index.rows * tile.h * s)}px`,
    position: `${-Math.round(tile.x * s)}px ${-Math.round(tile.y * s)}px`,
  };
};

// Where the preview's centre goes along a track `trackW` px wide, as px from
// its left edge: under the scrub point, but never past the track's ends.
export const thumbLeft = (frac, trackW, boxW) => {
  const half = boxW / 2;
  const x = Math.max(0, Math.min(1, Number(frac) || 0)) * trackW;
  if (trackW <= boxW) return trackW / 2;
  return Math.max(half, Math.min(trackW - half, x));
};

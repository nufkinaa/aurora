// The pictures above the scrub point (TV scrubber, phone scrubber, the phone's
// sideways seek drag). PURE — no imports: the logic tests run it as it is.
//
// The server cuts one small picture every `interval` seconds of a library
// video and packs them into sheets (GET /api/scrub/:id):
//   {ready:false}                       nothing yet (ask again later)
//   {ready:true, v:1, interval:10, w:240, h:134, cols:10, rows:10, count:N,
//    sheets:["/img/scrub/<id>/0.jpg?k=<key>", ...]}
// A sheet is a JPEG of cols × rows tiles, each w × h pixels (cols·w by rows·h;
// the last sheet is padded). The website reads the same answer the same way
// (public/js/screens/player.js).

export type ScrubIndex = {
  interval: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
  count: number;
  /** server-relative sheet addresses, in order */
  sheets: string[];
};

export type Tile = {
  /** which picture (0 … count-1) */
  i: number;
  /** which sheet it is on */
  sheet: number;
  /** its top-left corner on that sheet, in sheet pixels */
  x: number;
  y: number;
};

const posInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && Math.floor(n) === n ? n : null;
};

/** The server's answer, read. null = no pictures (not ready, an older server's
 *  404 body, junk, a format this app does not know): the scrubber then shows
 *  the time only, as it always did. */
export const readScrubIndex = (answer: unknown): ScrubIndex | null => {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as Record<string, unknown>;
  if (a.ready !== true || Number(a.v) !== 1) return null;
  const interval = Number(a.interval);
  if (!Number.isFinite(interval) || interval <= 0) return null;
  const w = posInt(a.w);
  const h = posInt(a.h);
  const cols = posInt(a.cols);
  const rows = posInt(a.rows);
  const count = posInt(a.count);
  if (!w || !h || !cols || !rows || !count) return null;
  if (!Array.isArray(a.sheets) || !a.sheets.length) return null;
  const sheets = a.sheets.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (sheets.length !== a.sheets.length) return null;
  // every picture must be on a sheet that exists
  if (sheets.length < Math.ceil(count / (cols * rows))) return null;
  return {interval, w, h, cols, rows, count, sheets};
};

/** The picture for second `t`. */
export const tileAt = (index: ScrubIndex, t: number): Tile => {
  const raw = Math.round((Number.isFinite(t) ? t : 0) / index.interval);
  const i = Math.max(0, Math.min(index.count - 1, raw));
  const per = index.cols * index.rows;
  const sheet = Math.floor(i / per);
  const k = i % per;
  return {i, sheet, x: (k % index.cols) * index.w, y: Math.floor(k / index.cols) * index.h};
};

/** How the picture is drawn at `displayW` wide (aspect kept): the clip box,
 *  and where the WHOLE sheet sits inside it. */
export const tileLayout = (index: ScrubIndex, t: number, displayW: number) => {
  const tile = tileAt(index, t);
  const scale = displayW / index.w;
  return {
    tile,
    boxW: displayW,
    boxH: Math.round(index.h * scale),
    left: -tile.x * scale,
    top: -tile.y * scale,
    sheetW: index.cols * index.w * scale,
    sheetH: index.rows * index.h * scale,
  };
};

/** Where the preview's left edge goes: centred on the scrub point, kept
 *  inside the track [0, trackW]. */
export const thumbLeft = (pct: number, trackW: number, boxW: number): number => {
  const p = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  const want = p * trackW - boxW / 2;
  return Math.max(0, Math.min(Math.max(0, trackW - boxW), want));
};

/** How many sheets are fetched ahead (each ~100–250 KB, ~13 MB decoded at
 *  2400 × 1340): the one under the playhead and its neighbours, not the whole
 *  film — a low-memory box would only throw the rest out again. */
export const WARM_SHEETS = 3;
export const WARM_SHEETS_LOW_RAM = 2;

/** The sheets to have ready for a scrub from `t`: its own first, then the one
 *  in the direction of travel (`dir` 1 forward, -1 back, 0 unknown → forward
 *  first), then the other side. Each once, at most `max`. */
export const sheetsToWarm = (index: ScrubIndex, t: number, dir: number, max: number): number[] => {
  const here = tileAt(index, t).sheet;
  const ahead = dir < 0 ? -1 : 1;
  const order = [here, here + ahead, here - ahead, here + 2 * ahead, here - 2 * ahead];
  const out: number[] = [];
  for (const s of order) {
    if (out.length >= max) break;
    if (s >= 0 && s < index.sheets.length && !out.includes(s)) out.push(s);
  }
  return out;
};

/** The second ask for an index that was not ready at open: only once, and
 *  only after this long (the server cuts the pictures in the background). */
export const SCRUB_REASK_MS = 60000;

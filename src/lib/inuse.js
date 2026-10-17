// Which library files are being played RIGHT NOW, as far as the server can
// tell: every request for a file's bytes (the plain stream, HLS, the
// transcoders, a device saving it for offline) stamps its library id here.
// A player that is playing asks again every few seconds, so a stamp younger
// than WINDOW_MS means "someone is on it". The admin's "delete this copy"
// (routes/admin.js, media/copies.js) refuses a file stamped in that window:
// pulling a file out from under a viewer ends their film mid-scene (and on
// Windows the delete would fail half-way on the open handle anyway).
//
// In memory only, bounded: a restart forgets, which is right — a restart
// also ended every stream.
const WINDOW_MS = 5 * 60 * 1000;
const MAX = 5000;

const seen = new Map(); // library id -> last request (ms)

const touch = (id, t = Date.now()) => {
  if (!id) return;
  const key = String(id);
  seen.delete(key); // re-insert: the Map's order is oldest-first
  seen.set(key, t);
  if (seen.size > MAX) seen.delete(seen.keys().next().value);
};

// When this id was last asked for, or 0.
const lastAt = (id) => seen.get(String(id || "")) || 0;

const streamingNow = (id, t = Date.now()) => {
  const at = lastAt(id);
  return at > 0 && t - at < WINDOW_MS;
};

module.exports = { touch, lastAt, streamingNow, WINDOW_MS, _internals: { seen } };

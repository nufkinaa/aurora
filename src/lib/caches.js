// Bounds for what the server keeps in memory, and how big each of those is.
//
// A long-running server must not grow with its own age: a cache keyed by
// every picture address, every stream source list or every file ever probed
// gains entries for things long gone (server round, 2026-10-18 —
// docs/qa/server-round/EVENTLOOP.md). Two tools:
//
//   new BoundedMap({ max, ttlMs, name })
//     a Map that never holds more than `max` entries: setting one more drops
//     the least recently USED (a get() counts as a use), and — with ttlMs —
//     an entry older than that is not answered (and is dropped when seen).
//     Drop-in for the Maps it replaces: get / set / has / delete / clear /
//     size / keys / values / entries / iteration.
//
//   register(name, () => ({ entries, max?, bytes? }))
//     says how big something is, for the admin's health page (report()).
//     A BoundedMap given a `name` registers itself.
"use strict";

const sizes = new Map(); // name -> () => { entries, max, bytes }

const register = (name, fn) => {
  if (typeof fn === "function") sizes.set(String(name), fn);
};

// [{ name, entries, max, bytes, full }] — the biggest first
const report = () => {
  const out = [];
  for (const [name, fn] of sizes) {
    let r = null;
    try { r = fn(); } catch { r = null; }
    if (!r) continue;
    const entries = Number(r.entries) || 0;
    const max = r.max != null ? Number(r.max) : null;
    out.push({ name, entries, max, bytes: r.bytes != null ? Math.round(r.bytes) : null, full: max != null && entries >= max });
  }
  return out.sort((a, b) => b.entries - a.entries);
};

class BoundedMap {
  constructor({ max = 1000, ttlMs = 0, name = null, bytesOf = null } = {}) {
    this.max = Math.max(1, max);
    this.ttlMs = ttlMs || 0;
    this.map = new Map(); // key -> { v, at }
    this.dropped = 0;
    if (name) register(name, () => ({ entries: this.map.size, max: this.max, bytes: bytesOf ? this._bytes(bytesOf) : null, dropped: this.dropped }));
  }
  _bytes(bytesOf) {
    let b = 0;
    for (const [k, e] of this.map) { try { b += bytesOf(k, e.v); } catch {} }
    return b;
  }
  _live(key, e, now) {
    if (this.ttlMs && now - e.at > this.ttlMs) { this.map.delete(key); return false; }
    return true;
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (!this._live(key, e, Date.now())) return undefined;
    // a use: to the young end
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }
  has(key) {
    const e = this.map.get(key);
    return !!e && this._live(key, e, Date.now());
  }
  set(key, v) {
    this.map.delete(key);
    this.map.set(key, { v, at: Date.now() });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
      this.dropped++;
    }
    return this;
  }
  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
  *keys() { for (const k of this.map.keys()) yield k; }
  *values() { for (const e of this.map.values()) yield e.v; }
  *entries() { for (const [k, e] of this.map) yield [k, e.v]; }
  [Symbol.iterator]() { return this.entries(); }
  forEach(fn, self) { for (const [k, e] of this.map) fn.call(self, e.v, k, this); }
}

module.exports = { BoundedMap, register, report, _internals: { sizes } };

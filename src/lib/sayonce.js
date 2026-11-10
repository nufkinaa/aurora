// "Say it once a minute per key", with a bound on the keys (perf-server
// 2026-11-10). The sign-in wall's 401 log line (server.js) was throttled with
// a Map keyed by the start of every refused path — which a client with no
// session chooses — and never pruned. This keeps at most `max` keys; when
// they are all fresh, a new key is simply not said in that window.
//
//   const due = sayOnce({ max: 500, windowMs: 60000 });
//   if (due(key)) console.warn(...)
"use strict";

const sayOnce = ({ max = 500, windowMs = 60 * 1000 } = {}) => {
  const said = new Map(); // key -> last said at
  const due = (key, now = Date.now()) => {
    const last = said.get(key);
    if (last !== undefined && now - last <= windowMs) return false;
    if (last === undefined && said.size >= max) {
      for (const [k, at] of said) if (now - at > windowMs) said.delete(k);
      if (said.size >= max) return false;
    }
    said.set(key, now);
    return true;
  };
  due.size = () => said.size;
  return due;
};

module.exports = { sayOnce };

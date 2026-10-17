// The subtitle delay a viewer set with the timing buttons (−5 / −0.5 / +0.5 /
// +5 / Reset), remembered per title AND track on this device, so the film
// comes back with its subtitles where they were left — after a reload, a
// resume tomorrow, a far seek that rebuilds the stream. Per track because two
// files for one film are timed for different releases: the delay that fixes
// one is wrong for the next (measured: eight Hebrew tracks of one film, first
// cue anywhere from 0.0 s to 357.0 s).
//
// PURE apart from the storage it is handed (localStorage in the player, a
// plain object in the tests). Values are seconds, rounded to 0.1; a delay of
// 0 is no entry at all. The newest MAX entries are kept.
const KEY = "aurora-subdelay";
const MAX = 300;

// The same track whatever cache-buster a reload put on its address.
export const trackKey = (itemId, url) => {
  const u = String(url || "").replace(/([?&])retry=\d+(&|$)/, (m, a, b) => (b ? a : "")).replace(/[?&]$/, "");
  return itemId && u ? `${itemId}|${u}` : null;
};

const read = (storage) => {
  try {
    const all = JSON.parse(storage.getItem(KEY) || "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
};

// The remembered delay for a title's track, 0 when there is none.
export const savedDelay = (storage, itemId, url) => {
  const k = trackKey(itemId, url);
  if (!k || !storage) return 0;
  const e = read(storage)[k];
  const d = e && Number(e.d);
  return Number.isFinite(d) ? Math.round(d * 10) / 10 : 0;
};

// Remember (or, at 0, forget) a delay.
export const saveDelay = (storage, itemId, url, seconds, now = Date.now()) => {
  const k = trackKey(itemId, url);
  if (!k || !storage) return;
  const all = read(storage);
  const d = Math.round(Number(seconds) * 10) / 10;
  if (!Number.isFinite(d) || d === 0) delete all[k];
  else all[k] = { d, at: now };
  const keys = Object.keys(all);
  if (keys.length > MAX) {
    keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
    for (const old of keys.slice(0, keys.length - MAX)) delete all[old];
  }
  try {
    storage.setItem(KEY, JSON.stringify(all));
  } catch {}
};

export const SUBDELAY_KEY = KEY;
export const SUBDELAY_MAX = MAX;

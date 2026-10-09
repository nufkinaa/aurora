// Outcome counters: the things that go wrong WITHOUT a line in the log.
//
// A provider answering 429, a rejected TMDB key, a wrong password, a stream
// refused because both encoders were busy, a push the service turned away —
// each is one `hit(kind, key)` where it happens. Nothing is written to disk
// and nothing is printed; the healer reads the tallies ("how many of kind X
// in the last 15 minutes, by key") and turns them into findings. Bounded: a
// day at most, a few thousand entries per kind.
//
//   provider   "<name>:<status>"   every answer of an outside service (ok too)
//   auth-fail  "<ip>"              a refused sign-in / unlock
//   ws         "<ip>"              a websocket connection opened
//   no-encoder "<what>"            a 503 served because no encoder was free
//   push       "ok" | "gone" | "fail:<status>"
//   trailer-apple "wikidata:<status|code>" | "apple:<status|code>"  (media/trailers.js)
//   trailer-fail  "<apple|youtube>:<resolve|play>"  a TV reporting a trailer that failed
"use strict";

const KEEP_MS = 24 * 3600 * 1000;
const MAX_PER_KIND = 4000;
const kinds = new Map(); // kind -> [{ t, key }]

const hit = (kind, key = "", now = Date.now()) => {
  let list = kinds.get(kind);
  if (!list) kinds.set(kind, (list = []));
  list.push({ t: now, key: String(key).slice(0, 80) });
  if (list.length > MAX_PER_KIND) list.splice(0, list.length - MAX_PER_KIND);
  else if (list.length && now - list[0].t > KEEP_MS) {
    let i = 0;
    while (i < list.length && now - list[i].t > KEEP_MS) i++;
    list.splice(0, i);
  }
};

const list = (kind, sinceMs, now = Date.now()) => (kinds.get(kind) || []).filter((e) => now - e.t <= sinceMs);
const count = (kind, sinceMs, now = Date.now()) => list(kind, sinceMs, now).length;
// key -> n, for one kind over a window
const byKey = (kind, sinceMs, now = Date.now()) => {
  const out = new Map();
  for (const e of list(kind, sinceMs, now)) out.set(e.key, (out.get(e.key) || 0) + 1);
  return out;
};

// Which outside service a URL belongs to, in the words the admin page uses.
const PROVIDERS = [
  [/themoviedb\.org/i, "tmdb"],
  [/cinemeta|strem\.io/i, "cinemeta"],
  [/torrentio/i, "torrentio"],
  [/metahub/i, "artwork"],
  [/opensubtitles|wizdom|ktuvit|subs/i, "subtitles"],
  [/openrouter/i, "ai"],
  [/imdb/i, "imdb"],
  [/wikidata\.org/i, "wikidata"],
  [/uts-api\.itunes\.apple\.com/i, "apple-tv"],
];
const providerOf = (url) => {
  let host = "";
  try { host = new URL(String(url)).hostname; } catch { host = String(url || "").slice(0, 60); }
  for (const [re, name] of PROVIDERS) if (re.test(host)) return name;
  return host.split(".").slice(-2).join(".") || "other";
};
// One line where a module has just got an answer: never throws.
const provider = (url, status) => {
  try { hit("provider", `${providerOf(url)}:${status >= 200 && status < 400 ? "ok" : status}`); } catch {}
};

const _reset = () => kinds.clear();

module.exports = { hit, list, count, byKey, provider, providerOf, _reset };

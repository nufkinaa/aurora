// Releases a person said were BAD here — burned-in subtitles, a bad picture,
// the wrong dub — remembered per title so nothing automatic picks one of
// them again: smart downloads, My List downloads, follows (smartdl.pickSource)
// and the second-source race skip them, and the ★ BEST mark never lands on
// one. A person choosing by hand still sees them, at the foot of the list,
// marked "Reported here" with the reason.
//
//   data/badreleases.json
//   { "<imdbId>[:<season>:<episode>]": [
//       { h: "<infoHash>"|null, r: "<release name>"|null, why: "burned", at, by, byName, rid } ] }
//
// Written by "Get another version" (media/replace.js) when the request is
// made; a CANCELLED replacement takes its entry back out (cancel leaves
// everything as it was), a failed one keeps it (the copy was still bad).
// Entries do not expire: a release with subtitles burned into the picture
// does not get better.
"use strict";
const path = require("path");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "badreleases.json"), {});
const PER_TITLE = 20;
const MAX_TITLES = 3000;

// One reason vocabulary for the server, the website and the TV app.
const REASONS = [
  { id: "burned", label: "Burned-in subtitles" },
  { id: "picture", label: "Bad picture" },
  { id: "sound", label: "Bad sound" },
  { id: "language", label: "Wrong language" },
  { id: "other", label: "Other" },
];
const reasonLabel = (id) => (REASONS.find((r) => r.id === id) || REASONS[REASONS.length - 1]).label;
const validReason = (id) => REASONS.some((r) => r.id === id);

const lc = (s) => String(s || "").toLowerCase();
// Release names compare without case, dots, dashes or spaces — the same
// release is listed as "Film.2020.1080p.WEB" by one provider and
// "Film 2020 1080p WEB" by another.
const relKey = (s) => lc(s).replace(/[^a-z0-9]+/g, "");
const data = () => (store.data && typeof store.data === "object" && !Array.isArray(store.data) ? store.data : (store.data = {}));

const forTitle = (key) => (key && Array.isArray(data()[lc(key)]) ? data()[lc(key)] : []);

// The entry that marks this source bad for the title, or null.
const match = (key, src) => {
  const list = forTitle(key);
  if (!list.length || !src) return null;
  const h = lc(src.infoHash);
  const r = relKey(src.release);
  return list.find((e) => (e.h && h && e.h === h) || (e.r && r && e.r === r)) || null;
};

const record = (key, { infoHash, release, reason, by, byName, rid } = {}, now = Date.now()) => {
  if (!key || (!infoHash && !release)) return false;
  const k = lc(key);
  const d = data();
  const list = Array.isArray(d[k]) ? d[k] : [];
  const h = infoHash ? lc(infoHash) : null;
  const r = release ? relKey(release) : null;
  const rest = list.filter((e) => !((h && e.h === h) || (r && e.r === r)));
  rest.unshift({ h, r, rel: release ? String(release).slice(0, 200) : null, why: validReason(reason) ? reason : "other", at: now, by: by || null, byName: byName || null, rid: rid || null });
  d[k] = rest.slice(0, PER_TITLE);
  const keys = Object.keys(d);
  if (keys.length > MAX_TITLES) {
    // the titles touched longest ago go first
    keys.sort((a, b) => ((d[a][0] && d[a][0].at) || 0) - ((d[b][0] && d[b][0].at) || 0));
    for (const old of keys.slice(0, keys.length - MAX_TITLES)) delete d[old];
  }
  store.save();
  return true;
};

// A cancelled replacement takes back the mark it made (and only that one).
const unrecord = (key, rid) => {
  if (!key || !rid) return false;
  const k = lc(key);
  const d = data();
  const list = Array.isArray(d[k]) ? d[k] : [];
  const next = list.filter((e) => e.rid !== rid);
  if (next.length === list.length) return false;
  if (next.length) d[k] = next;
  else delete d[k];
  store.save();
  return true;
};

// A ranked source list with this title's bad releases marked (`badHere`)
// and moved below the others, CAM rips still last of all; the ★ pick moves
// to the first source that is neither CAM, dubbed nor bad. A list with no
// bad release in it comes back as it was given — same array, same order.
const apply = (key, streams) => {
  if (!Array.isArray(streams) || !streams.length || !forTitle(key).length) return streams;
  const marks = streams.map((s) => match(key, s));
  if (!marks.some(Boolean)) return streams;
  const rank = (s, m) => (s.cam ? 2 : m ? 1 : 0);
  const out = streams
    .map((s, i) => ({ s, m: marks[i], i }))
    .sort((a, b) => rank(a.s, a.m) - rank(b.s, b.m) || a.i - b.i)
    .map(({ s, m }) => {
      const c = { ...s };
      delete c.recommended;
      if (m) c.badHere = { reason: m.why, label: reasonLabel(m.why), at: m.at };
      return c;
    });
  const best = out.find((s) => !s.cam && !s.dubbed && !s.badHere);
  if (best) best.recommended = true;
  return out;
};

module.exports = { REASONS, reasonLabel, validReason, forTitle, match, record, unrecord, apply, _internals: { store, relKey } };

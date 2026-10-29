// WHAT A DEVICE CAN PLAY — its own report, read and kept (TV round
// 2026-10-19, "direct play").
//
// The TV app (MediaCodecList, Display.HdrCapabilities, AudioCapabilities —
// tv-native/src/avCaps.ts) and the website (MediaSource.isTypeSupported,
// canPlayType, mediaCapabilities.decodingInfo — public/js/avcaps.js) each send
// one report per launch: POST /api/caps. The report is read here into a
// closed vocabulary (anything else is dropped, every number clamped), named by
// a hash of what it says (the same device, the same answer, the same id — on
// every launch and across restarts), and kept, a few hundred at most. The id
// rides on the requests that ask how a title should play (/api/item?caps=,
// /api/torrents/sources?caps=) and media/playpath.js decides from it.
//
// A cache, not state: a server that has forgotten a report (a cleared cache)
// answers without a decision, the client plays by its own rules as before
// and sends its report again at the next launch.
"use strict";
const crypto = require("crypto");
const path = require("path");

const VIDEO_CODECS = ["h264", "hevc", "av1", "vp9", "vp8", "mpeg2", "mpeg4", "vc1"];
const VIDEO_PROFILES = {
  h264: ["baseline", "main", "high", "high10", "high422", "high444"],
  hevc: ["main", "main10", "main12"],
  av1: ["main", "high", "professional"],
  vp9: ["0", "1", "2", "3"],
  vp8: [],
  mpeg2: [],
  mpeg4: [],
  vc1: [],
};
const AUDIO_CODECS = ["aac", "ac3", "eac3", "eac3-joc", "dts", "dtshd", "truehd", "opus", "flac", "mp3", "vorbis", "pcm", "alac", "mp2"];
const HDR_TYPES = ["hdr10", "hdr10plus", "hlg", "dv"];
const CONTAINERS = ["mp4", "mkv", "webm", "mov", "avi", "ts"];
const CLIENTS = ["tv", "phone", "web"]; // phone: the Android phone app — ExoPlayer, judged like the TV

const MAX_KEPT = 300;

const int = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : 0;
};
const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 1000) / 1000 : 0;
};
const str = (v, max) => (typeof v === "string" ? v.replace(/[^\w .,+()\-/]/g, "").trim().slice(0, max) : "");
// a list out of a closed set: lower-cased, known words only, each once, sorted
const pick = (list, allowed) =>
  Array.isArray(list)
    ? [...new Set(list.map((x) => String(x).toLowerCase().trim()).filter((x) => allowed.includes(x)))].sort()
    : [];

/** A report as sent → the closed shape kept, or null when it is no report at all. */
const normalize = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const client = CLIENTS.includes(raw.client) ? raw.client : null;
  if (!client) return null;
  const video = {};
  const rv = raw.video && typeof raw.video === "object" ? raw.video : {};
  for (const codec of VIDEO_CODECS) {
    const c = rv[codec];
    if (!c) continue;
    const o = c === true ? {} : typeof c === "object" ? c : null;
    if (!o) continue;
    const e = { profiles: pick((o.profiles || []).map(String), VIDEO_PROFILES[codec]) };
    const maxW = int(o.maxW, 64, 16384);
    const maxH = int(o.maxH, 64, 16384);
    const maxFps = num(o.maxFps, 1, 1000);
    const maxLevel = int(o.maxLevel, 1, 300);
    if (maxW) e.maxW = maxW;
    if (maxH) e.maxH = maxH;
    if (maxFps) e.maxFps = maxFps;
    if (maxLevel) e.maxLevel = maxLevel;
    video[codec] = e;
  }
  const ra = raw.audio && typeof raw.audio === "object" ? raw.audio : {};
  const audio = {
    decode: pick(ra.decode, AUDIO_CODECS),
    passthrough: pick(ra.passthrough, AUDIO_CODECS),
  };
  const maxCh = int(ra.maxChannels, 1, 32);
  if (maxCh) audio.maxChannels = maxCh;
  const containers = {};
  const rc = raw.containers && typeof raw.containers === "object" ? raw.containers : {};
  for (const k of CONTAINERS) {
    const v = rc[k];
    if (v === true || v === "*") containers[k] = Object.keys(video).sort();
    else if (Array.isArray(v)) containers[k] = pick(v, VIDEO_CODECS);
  }
  const out = {
    v: 1,
    client,
    model: str(raw.model, 40),
    sdk: int(raw.sdk, 1, 99),
    video,
    hdr: pick(raw.hdr, HDR_TYPES),
    dv: Array.isArray(raw.dv) ? [...new Set(raw.dv.map((x) => int(x, 1, 20)).filter(Boolean))].sort((a, b) => a - b) : [],
    audio,
    containers,
  };
  const rd = raw.display && typeof raw.display === "object" ? raw.display : null;
  if (rd) {
    const modes = Array.isArray(rd.modes)
      ? rd.modes.slice(0, 64).map((m) => (Array.isArray(m) ? [int(m[0], 1, 16384), int(m[1], 1, 16384), num(m[2], 1, 1000)] : null)).filter((m) => m && m[0] && m[1] && m[2])
      : [];
    out.display = { w: int(rd.w, 1, 16384), h: int(rd.h, 1, 16384), hz: num(rd.hz, 1, 1000), modes };
  }
  return out;
};

// The same report always gets the same name (keys in a fixed order: normalize builds them so).
const idOf = (caps) => crypto.createHash("sha256").update(JSON.stringify(caps)).digest("hex").slice(0, 16);
const ID_RE = /^[0-9a-f]{16}$/;

// ------------------------------------------------------------- kept
let store = null;
const theStore = () => {
  if (store) return store;
  const { JsonStore } = require("../lib/jsonstore");
  store = new JsonStore(path.join(require("../config").CACHE_DIR, "device-caps.json"), {});
  return store;
};

/** Keep a report; returns { id, caps } (null for no report). */
const remember = (raw, now = Date.now()) => {
  const caps = normalize(raw);
  if (!caps) return null;
  const id = idOf(caps);
  const s = theStore();
  const had = s.data[id];
  // (a launch a day refreshes the date at most once an hour: no write per launch)
  if (!had || now - (had.at || 0) > 3600 * 1000) {
    s.data[id] = { caps, at: now };
    const ids = Object.keys(s.data);
    if (ids.length > MAX_KEPT) {
      ids.sort((a, b) => (s.data[a].at || 0) - (s.data[b].at || 0));
      for (const old of ids.slice(0, ids.length - MAX_KEPT)) delete s.data[old];
    }
    s.save();
  }
  return { id, caps };
};

/** The report an id names, or null (unknown, forgotten, or not an id). */
const lookup = (id) => {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  const hit = theStore().data[id];
  return hit && hit.caps ? hit.caps : null;
};

/** (tests) swap the store for an in-memory one. */
const _setStore = (s) => {
  store = s;
};

module.exports = { normalize, idOf, remember, lookup, VIDEO_CODECS, VIDEO_PROFILES, AUDIO_CODECS, HDR_TYPES, CONTAINERS, MAX_KEPT, _setStore };

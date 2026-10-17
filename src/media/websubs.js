// External subtitle tracks — HEBREW, ENGLISH AND RUSSIAN ONLY, from two providers.
//
//   OpenSubtitles (via the Stremio v3 addon) — broad, all three languages.
//   Wizdom (wizdom.xyz)                     — the Israeli catalogue, Hebrew only
//                                             and far better at it, especially
//                                             for older and local content.
//
// No other language is ever returned. That is a deliberate product decision, not
// a filter that happens to be applied at the end: everything below keys off
// LANGS, so adding a language is a one-line change and nothing leaks in by
// accident.
//
// Encoding matters here more than anywhere else in the app. Hebrew subtitle
// files are routinely Windows-1255, and reading those as UTF-8 gives a screen of
// question marks — decode() sniffs and converts, so callers always get text.
const zlib = require("zlib");

const OPENSUBS_BASE = "https://opensubtitles-v3.strem.io";
const WIZDOM_SEARCH = "https://wizdom.xyz/api/search";
// The download endpoint. NOT zip.wizdom.xyz — that subdomain is dead (it fails
// to resolve), which is worth writing down because it's the URL most guides and
// old addons still use.
const WIZDOM_FILE = "https://wizdom.xyz/api/files/sub";

// The only languages this server offers.
const LANGS = [
  { key: "heb", name: "Hebrew", codes: ["heb", "he", "iw", "hebrew", "he-il"] },
  { key: "eng", name: "English", codes: ["eng", "en", "english", "en-us", "en-gb"] },
  { key: "rus", name: "Russian", codes: ["rus", "ru", "russian", "ru-ru"] },
];
// How many to offer per language. Five is the floor worth having (a mistimed
// track needs a spare); more variety is better, so we go a little past it.
const PER_LANG = 8;

const langOf = (code) => {
  const c = String(code || "").toLowerCase().trim();
  return LANGS.find((l) => l.codes.includes(c)) || null;
};

const fetchJson = async (url, ms = 12000) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "Aurora/1.0" },
    signal: AbortSignal.timeout(ms),
  });
  try { require("../lib/signals").provider(url, res.status); } catch {}
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
};

// ---------- providers ----------

// The Stremio OpenSubtitles addon: one call gives every language, which we then
// throw all but two of away.
const fromOpenSubtitles = async (ttType, imdbId, season, episode) => {
  const id = ttType === "series" && season && episode
    ? `${imdbId}:${season}:${episode}`
    : imdbId;
  let data;
  try {
    data = await fetchJson(`${OPENSUBS_BASE}/subtitles/${ttType}/${id}.json`);
  } catch {
    return [];
  }
  const out = [];
  for (const s of data.subtitles || []) {
    const lang = langOf(s.lang);
    if (!lang || !s.url) continue;
    // The addon says which release each file was timed for, and at what
    // frame rate — everything the ranking below needs, and all of it ignored
    // until 2026-10-17 (the addon's own order put a Telesync first).
    const release = String(s.movieReleaseName || s.subtitleFileName || "").replace(/\.(srt|sub|ass|ssa|vtt)$/i, "");
    const fps = Number(s.fpsMilli) > 0 ? Number(s.fpsMilli) / 1000 : null;
    out.push({
      provider: "os",
      ref: s.url,
      lang: lang.key,
      langName: lang.name,
      note: release ? release.slice(0, 60) : s.id ? `#${s.id}` : "",
      ...(release ? { release } : {}),
      ...(fps ? { fps } : {}),
    });
  }
  return out;
};

// Wizdom, the Hebrew source. Its search is by IMDb id (season/episode 0 for a
// film) and every result is Hebrew, so there is nothing to filter — but the file
// arrives zipped, which is why tracks carry a provider instead of a plain URL.
const fromWizdom = async (ttType, imdbId, season, episode) => {
  const qs = new URLSearchParams({
    action: "by_id",
    imdb: imdbId,
    season: String(ttType === "series" ? season || 0 : 0),
    episode: String(ttType === "series" ? episode || 0 : 0),
  });
  let data;
  try {
    data = await fetchJson(`${WIZDOM_SEARCH}?${qs}`);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.subs) ? data.subs : [];
  return list
    .filter((s) => s && (s.id || s.id === 0))
    .map((s) => ({
      provider: "wz",
      ref: String(s.id),
      lang: "heb",
      langName: "Hebrew",
      // The release name is genuinely useful for Hebrew: it's how you tell a
      // WEB-DL-timed track from a BluRay-timed one.
      note: String(s.versioname || s.version || "").slice(0, 60),
      release: String(s.versioname || s.version || ""),
      score: Number(s.score) || 0,
    }));
};

// ---------- which release a file was timed for ----------
//
// A subtitle is in time for the release it was made on and, usually, for the
// releases cut from the same master: the same group, the same source (a
// BluRay and every BDRip of it; one streaming service's WEB-DL and the WEBRips
// of it), the same edition. Wizdom lists every Hebrew file it has under the
// release name it was made for, in no useful order (every "score" is 0), and
// OpenSubtitles' own order put CAM/Telesync files first (Inception: both of
// its Hebrew files are Telesyncs at 25 fps) — taking the first two of each is
// what made "subs are almost always out of sync, especially in Hebrew". So the
// candidates are RANKED against the release being watched.

const tokens = (name) =>
  String(name || "").toLowerCase().replace(/\.(mkv|mp4|avi|m4v|srt)$/i, "").split(/[\s._\-[\]()+,]+/).filter(Boolean);
const SOURCES = [
  ["cam", /^(?:cam|camrip|hdcam|ts|hdts|telesync|tc|telecine|scr|screener|dvdscr|r5|pdvd|hqcam)$/],
  ["bluray", /^(?:bluray|blu|bdrip|brrip|bdremux|remux|bd|bdr|bd25|bd50|uhd)$/],
  ["web", /^(?:web|webdl|webrip|webhd|amzn|nf|dsnp|hmax|max|atvp|hulu|pcok|pmtp|itunes|cr|stan)$/],
  ["hdtv", /^(?:hdtv|pdtv|dsr|tvrip|dvb|hdtvrip|satrip)$/],
  ["dvd", /^(?:dvd|dvdrip|dvd5|dvd9|ntsc|pal)$/],
];
const SERVICES = new Set(["amzn", "nf", "dsnp", "hmax", "max", "atvp", "hulu", "pcok", "pmtp", "itunes", "cr", "stan"]);
const EDITIONS = /^(?:extended|uncut|unrated|directors|dc|imax|theatrical|remastered|criterion|special)$/;

const parseRelease = (name) => {
  const t = tokens(name);
  const raw = String(name || "").replace(/\.(mkv|mp4|avi|m4v|srt)$/i, "").trim();
  const g = /-([A-Za-z0-9]{2,20})(?:\[[^\]]*\])?$/.exec(raw);
  let source = null;
  for (const [k, re] of SOURCES) if (t.some((x) => re.test(x))) { source = k; break; }
  return {
    group: g ? g[1].toLowerCase() : null,
    source,
    res: t.find((x) => /^(?:2160|1080|720|576|480)p$/.test(x)) || null,
    service: t.find((x) => SERVICES.has(x)) || null,
    editions: t.filter((x) => EDITIONS.test(x)).sort().join(","),
    tokens: new Set(t),
  };
};

// How well a subtitle made for release `cand` should fit `target` (higher is better).
const releaseScore = (target, cand, { targetFps = null, candFps = null } = {}) => {
  const a = parseRelease(target);
  const b = parseRelease(cand);
  let score = 0;
  if (b.source === "cam" && a.source !== "cam") score -= 8;
  if (a.group && b.group && a.group === b.group) score += 6;
  if (a.source && b.source) score += a.source === b.source ? 4 : -1;
  if (a.service && b.service) score += a.service === b.service ? 3 : -1;
  if (a.res && b.res && a.res === b.res) score += 1;
  if (a.editions !== b.editions) score -= 4;
  else if (a.editions) score += 2;
  if (targetFps && candFps && Math.abs(targetFps / candFps - 1) > 0.01) score -= 3;
  // a little for every other word in common ("repack", "hdr", "atmos")
  let common = 0;
  for (const x of b.tokens) if (x.length > 2 && a.tokens.has(x) && !/^\d+$/.test(x)) common++;
  return score + Math.min(3, common * 0.25);
};

// ---------- the merged list ----------

// Hebrew, English and Russian tracks for a title, best-first, capped per language.
// `opts.release`: the name of the release being watched (the file name the
// torrent had); `opts.fps`: its frame rate. With a release, each language's
// candidates are ranked by how well their own release fits it; without one,
// CAM/Telesync files still go to the back. Ties keep the providers'
// interleaved order (Wizdom first for Hebrew — the better catalogue).
const list = async (type, imdbId, season, episode, opts = {}) => {
  if (!/^tt\d+$/i.test(imdbId || "")) return [];
  const ttType = type === "series" || type === "show" ? "series" : "movie";

  const [os, wz] = await Promise.all([
    fromOpenSubtitles(ttType, imdbId, season, episode),
    fromWizdom(ttType, imdbId, season, episode).catch(() => []),
  ]);
  return rank(os, wz, opts);
};

const rank = (os, wz, { release = null, fps = null } = {}) => {
  const out = [];
  for (const lang of LANGS) {
    const wzL = wz.filter((t) => t.lang === lang.key).sort((a, b) => b.score - a.score);
    const osL = os.filter((t) => t.lang === lang.key);
    const merged = [];
    for (let i = 0; i < Math.max(wzL.length, osL.length); i++) {
      if (wzL[i]) merged.push(wzL[i]);
      if (osL[i]) merged.push(osL[i]);
    }
    const scored = merged.map((t, i) => {
      const name = t.release || t.note;
      const fit = release
        ? releaseScore(release, name, { targetFps: fps, candFps: t.fps })
        : parseRelease(name).source === "cam" ? -8 : 0;
      return { t, i, fit };
    });
    scored.sort((x, y) => y.fit - x.fit || x.i - y.i);

    const seen = new Set();
    let n = 0;
    for (const { t, fit } of scored) {
      const key = `${t.provider}:${t.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
      out.push({ ...t, fit: Math.round(fit * 100) / 100, label: lang.name + (n > 1 ? ` ${n}` : "") });
      if (n >= PER_LANG) break;
    }
  }
  return out;
};

// ---------- fetching one track ----------

// Text out of bytes. Hebrew subtitles are as likely to be Windows-1255 as
// UTF-8, Russian ones as likely to be Windows-1251, and the only reliable tell
// is whether the bytes decode as valid UTF-8 at all. When they don't, both
// legacy code pages are tried and the one that yields real letters of its
// own script wins — the same byte range is Hebrew in 1255 and Cyrillic in
// 1251, so a wrong guess is a screen of the other alphabet.
const decode = (buf) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    const heb = new TextDecoder("windows-1255").decode(buf);
    const rus = new TextDecoder("windows-1251").decode(buf);
    const hebLetters = (heb.match(/[\u05d0-\u05ea]/g) || []).length;
    const rusLetters = (rus.match(/[\u0410-\u044f\u0451\u0401]/g) || []).length;
    return rusLetters > hebLetters ? rus : heb;
  }
};

// Pull the first subtitle out of a ZIP, using the central directory (the only
// part of the format that reliably knows each entry's size and location).
// Wizdom ships one .srt per archive; this copes with more.
const SUB_IN_ZIP = /\.(srt|sub|ass|ssa|vtt)$/i;
const firstSubtitleInZip = (buf) => {
  // End of central directory: signature, scanning back over the comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // start of the central directory

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (SUB_IN_ZIP.test(name)) {
      // Re-read the sizes from the local header: its name/extra lengths are the
      // ones that place the data.
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("bad zip entry");
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = compSize > 0 ? buf.subarray(start, start + compSize) : buf.subarray(start);
      if (method === 0) return data;                 // stored
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`unsupported zip compression (${method})`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("no subtitle inside the archive");
};

// The SRT text of one track, whatever hoops its provider needs.
const fetchSrt = async (track) => {
  if (!track || !track.provider) throw new Error("bad track");

  if (track.provider === "wz") {
    const res = await fetch(`${WIZDOM_FILE}/${encodeURIComponent(track.ref)}`, {
      headers: { "User-Agent": "Aurora/1.0" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`wizdom ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    return decode(firstSubtitleInZip(zip));
  }

  // OpenSubtitles hands back the file directly (sometimes gzipped by the CDN,
  // which fetch() already transparently undoes).
  const res = await fetch(track.ref, {
    headers: { "User-Agent": "Aurora/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`opensubtitles ${res.status}`);
  return decode(Buffer.from(await res.arrayBuffer()));
};

// ---------- making sure it's actually a usable subtitle ----------
//
// Providers hand back three things that look fine until someone tries to watch
// them, all found in a single pass over a real library:
//
//   * a different FORMAT with an .srt name — MicroDVD ("{45}{75}text") and
//     SubStation ("[Script Info]"). Real subtitles, but no player of ours parses
//     them, so they must be converted rather than stored as-is.
//   * a different LANGUAGE than the one advertised. One track tagged Hebrew was
//     Turkish. This server offers two languages and that promise has to survive
//     a provider being wrong.
//   * near-empty files — a two-cue "signs only" track offered as a full one.
const MIN_CUES = 5;

const isSrt = (t) => /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(t);
const isMicroDvd = (t) => /^\s*\{\d+\}\{\d+\}/.test(t);
const isSubStation = (t) => /^\s*(\[Script Info\]|﻿\[Script Info\])/i.test(t);

const srtTime = (totalMs) => {
  const ms = Math.max(0, Math.round(totalMs));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
};

// MicroDVD is frame-based, so it needs a frame rate. The format's own
// convention is to declare it in the first cue; 23.976 is the near-universal
// fallback for the releases these were timed against.
const microDvdToSrt = (text) => {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let fps = 23.976;
  const declared = lines[0] && lines[0].match(/^\{\d+\}\{\d+\}([\d.]+)\s*$/);
  if (declared) {
    const n = parseFloat(declared[1]);
    if (n > 10 && n < 200) fps = n;
    lines.shift();
  }
  const out = [];
  let n = 0;
  for (const line of lines) {
    const m = line.match(/^\{(\d+)\}\{(\d+)\}(.*)$/);
    if (!m) continue;
    const body = m[3].replace(/\|/g, "\n").replace(/\{[^}]*\}/g, "").trim();
    if (!body) continue;
    out.push(`${++n}\n${srtTime((+m[1] / fps) * 1000)} --> ${srtTime((+m[2] / fps) * 1000)}\n${body}\n`);
  }
  return out.join("\n");
};

// SubStation carries real timestamps, so this conversion is exact.
const subStationToSrt = (text) => {
  const lines = text.split(/\r?\n/);
  const fmtLine = lines.find((l) => /^Format:/i.test(l) && /Start/i.test(l) && /Text/i.test(l));
  const fields = fmtLine
    ? fmtLine.replace(/^Format:\s*/i, "").split(",").map((f) => f.trim().toLowerCase())
    : ["marked", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  const iStart = fields.indexOf("start");
  const iEnd = fields.indexOf("end");
  const iText = fields.indexOf("text");
  if (iStart < 0 || iEnd < 0 || iText < 0) return "";

  const toMs = (t) => {
    const m = String(t).trim().match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/);
    if (!m) return null;
    return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, "0");
  };

  const out = [];
  let n = 0;
  for (const line of lines) {
    if (!/^Dialogue:/i.test(line)) continue;
    // Everything after the last format field is the text, commas and all.
    const parts = line.replace(/^Dialogue:\s*/i, "").split(",");
    const start = toMs(parts[iStart]);
    const end = toMs(parts[iEnd]);
    if (start == null || end == null) continue;
    const body = parts.slice(iText).join(",")
      .replace(/\{[^}]*\}/g, "")        // style overrides
      .replace(/\\N|\\n/gi, "\n")
      .trim();
    if (!body) continue;
    out.push(`${++n}\n${srtTime(start)} --> ${srtTime(end)}\n${body}\n`);
  }
  return out.join("\n");
};

// Whatever the provider sent, as SRT — or "" when it isn't a subtitle at all.
const toSrt = (text) => {
  if (!text) return "";
  if (isSrt(text)) return text;
  if (isSubStation(text)) return subStationToSrt(text);
  if (isMicroDvd(text)) return microDvdToSrt(text);
  return "";
};

// Is this SRT worth putting in the library, in the language it claims?
// Returns null when fine, or a short reason.
const rejectReason = (srt, langKey) => {
  if (!srt || srt.length < 64) return "empty";
  const cues = (srt.match(/-->/g) || []).length;
  if (cues < MIN_CUES) return `only ${cues} cue(s)`;
  const hebrew = (srt.match(/[֐-׿]/g) || []).length;
  const cyrillic = (srt.match(/[\u0400-\u04ff]/g) || []).length;
  const latin = (srt.match(/[A-Za-z]/g) || []).length;
  if (langKey === "heb" && hebrew < 50) return "labelled Hebrew but has no Hebrew";
  if (langKey === "rus" && cyrillic < 50) return "labelled Russian but has no Russian";
  // An English slot holding another script is a mislabel too.
  if (langKey === "eng" && (hebrew > latin || cyrillic > latin)) {
    return "labelled English but is not";
  }
  return null;
};

// ---------- writing sidecars ----------

// Fetch every track and write the DISTINCT ones next to a video, named so the
// scanner labels them ("<video>.Hebrew.srt", "<video>.Hebrew 2.srt", …).
//
// Deduplicating by content is the whole point of doing it here rather than in
// list(): a title's Hebrew entries are often the same file re-listed under
// several release names (measured on Inception — four ids, one file), and
// writing it four times fills the subtitle menu with identical choices. Distinct
// files only, numbered in the order they arrive.
const writeSidecars = async (tracks, videoPath, opts = {}) => {
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const safe = (s) => String(s || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().slice(0, 40);

  // `opts.fetch` exists so tests can drive this without the network.
  const get = opts.fetch || fetchSrt;
  // Fetch in parallel — one at a time would take a minute for sixteen tracks.
  const fetched = await Promise.all((tracks || []).map(async (t) => {
    try {
      const raw = await get(t);
      if (!raw || raw.length > 5 * 1024 * 1024) return null;
      // Convert MicroDVD/SubStation to SRT, then refuse anything that isn't a
      // usable subtitle in the language it claims (see rejectReason).
      let text = toSrt(raw);
      if (rejectReason(text, t.lang)) return null;
      // The timing repairs that can be made from evidence (media/subsync.js):
      // a frame rate the provider declared, a track that runs past the film's
      // end, and the punctuation of Hebrew/Arabic files authored for renderers
      // without bidi. (Lining a track up against one the video itself carries
      // happens later, in the background — media/sublang.js — because that
      // track has to be extracted first.)  opts.facts: { fps, duration }.
      const facts = opts.facts || {};
      const fixed = require("./subsync").repair(text, { fps: facts.fps, duration: facts.duration, subFps: t.fps });
      if (fixed.how.length) console.log(`[subs] ${t.langName} (${t.release || t.ref}): ${fixed.how.join("; ")}`);
      text = fixed.srt;
      return { track: t, text, sha: crypto.createHash("sha1").update(text).digest("hex") };
    } catch {
      return null;
    }
  }));

  const seen = new Set();
  const counts = {};
  const written = [];
  let duplicates = 0;
  for (const item of fetched) {
    if (!item) continue;
    if (seen.has(item.sha)) { duplicates++; continue; }
    seen.add(item.sha);
    const langName = item.track.langName || "Subtitles";
    counts[langName] = (counts[langName] || 0) + 1;
    const label = safe(langName + (counts[langName] > 1 ? ` ${counts[langName]}` : ""));
    const file = path.join(dir, `${base}.${label}.srt`);
    // A sidecar with this label may already exist under another subtitle
    // extension — the scanner reads .srt AND .vtt, so writing our .srt beside an
    // existing .vtt puts the same label in the menu twice.
    const already = [".srt", ".vtt"].some((ext) =>
      fs.existsSync(path.join(dir, `${base}.${label}${ext}`))
    );
    if (!opts.force && already) continue;
    try {
      fs.writeFileSync(file, item.text, "utf8");
      written.push(path.basename(file));
    } catch {}
  }
  return { written, duplicates, considered: (tracks || []).length };
};

// SRT (or anything close to it) as WebVTT, for the browser player.
const toVtt = (text) => {
  if (text.startsWith("WEBVTT")) return text;
  return (
    "WEBVTT\n\n" +
    text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
  );
};

module.exports = {
  list, rank, fetchSrt, toVtt, writeSidecars, LANGS, PER_LANG, parseRelease, releaseScore,
  // Test-only: the parts worth pinning — a wrong language filter or a broken
  // zip reader is invisible until someone opens a subtitle menu.
  _internals: { langOf, decode, firstSubtitleInZip, toSrt, rejectReason, microDvdToSrt, subStationToSrt },
};

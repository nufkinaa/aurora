// "Your files": videos (and their subtitles) from this computer or phone, as a
// small library on the "On this device" screen, played in Aurora's own player
// — the controls, the subtitle menu and its timing buttons, fullscreen, the
// keys, the phone gestures, Up next between the episodes of a show — from
// object URLs. NOTHING is uploaded: the bytes never leave the browser, and no
// server is needed (it works in offline mode too).
//
//   addFiles(batch)          files from a pick, a drop or a folder → titles;
//                            each subtitle finds its video (js/localnames.js)
//   libraryView() / onLibrary(fn)   what the screen draws (js/localview.js)
//   localItem(id)            what the player plays for that id (null when the
//                            file is not open here)
//   localNext(item)          the next episode of the same show, when open here
//   localPosition / saveLocalPosition   where a file was left, by name + size
//
// What is KEPT across reloads (IndexedDB, this browser only): each title's
// name, size, cleaned title, a thumbnail drawn from the video, its length,
// whether it plays here, and its subtitles (as WebVTT text). The video itself
// is not copied anywhere: in Chrome and Edge the file's handle is kept too
// (from a drop or the file picker) and the file reopens — by itself when the
// browser still allows it, else on a press of "Reconnect" (the browser asks);
// elsewhere the card asks for the file to be picked again, and it is matched
// by its name and size.
import { decodeSubtitle, toVtt, cueCount, textLang, SUB_EXT, sniffCodecs, failureSentence } from "./localsubs.js";
import { parseName, subInfo, subLabel, matchSubs, normKey, episodeCode } from "./localnames.js";

export const VIDEO_EXT = /\.(mp4|m4v|mkv|mk3d|webm|mov|ogv|ogg|avi|ts|m2ts|mts|3gp|wmv|flv|mpg|mpeg)$/i;
export const isVideoFile = (f) => !!f && (VIDEO_EXT.test(f.name || "") || /^video\//.test(f.type || ""));
export const isSubFile = (f) => !!f && SUB_EXT.test(f.name || "");
export const isLocalId = (id) => /^local-/.test(String(id || ""));

const fileKey = (f) => `${f.name}|${f.size}`;
const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
};
const idOf = (key) => `local-${hash(key)}`;
// "The.Film.2020.1080p.mkv" → "The Film 2020 1080p" (the file's name, readable)
export const titleOf = (name) => String(name || "Video").replace(/\.[^.]+$/, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim() || "Video";

// ---------- the list ----------
const MAX_TITLES = 400;
const entries = new Map(); // key -> the title (what is kept)
const files = new Map(); // key -> File (this tab only)
let loose = []; // subtitles no video claimed: [{ key, name, size, lang, label, forced, sdh, n, vtt, cues, dir }]
const listeners = new Set();
let emitTimer = 0;
const emit = () => {
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => { for (const fn of [...listeners]) { try { fn(); } catch {} } }, 0);
};
export const onLibrary = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const byId = (id) => { for (const e of entries.values()) if (e.id === id) return e; return null; };

// ---------- kept in this browser (IndexedDB) ----------
const DB = "aurora-local-files";
let dbP = null;
const db = () => dbP || (dbP = new Promise((resolve, reject) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "key" });
    if (!d.objectStoreNames.contains("loose")) d.createObjectStore("loose", { keyPath: "key" });
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
}).catch((e) => { dbP = null; throw e; }));
const store = async (name, mode, fn) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(name, mode);
    const out = fn(t.objectStore(name));
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};
const RUNTIME = new Set(["thumbUrl", "thumbTried"]);
const record = (e, withHandle = true) => {
  const r = {};
  for (const [k, v] of Object.entries(e)) if (!RUNTIME.has(k) && (withHandle || k !== "handle")) r[k] = v;
  return r;
};
// (a handle that cannot be stored — a browser without them — is left out)
const keep = (e) =>
  store("files", "readwrite", (s) => s.put(record(e))).catch(() =>
    store("files", "readwrite", (s) => s.put(record(e, false))).catch(() => {}));
const forget = (key) => store("files", "readwrite", (s) => s.delete(key)).catch(() => {});
const keepLoose = () =>
  store("loose", "readwrite", (s) => { s.clear(); for (const l of loose) s.put(l); }).catch(() => {});

let loaded = null;
export const loadLibrary = () => loaded || (loaded = (async () => {
  try {
    const rows = await store("files", "readonly", (s) => s.getAll());
    for (const r of rows || []) if (!entries.has(r.key)) entries.set(r.key, { ...r, status: r.status === "checking" ? null : r.status });
    const l = await store("loose", "readonly", (s) => s.getAll());
    for (const s of l || []) if (!loose.some((x) => x.key === s.key)) loose.push(s);
  } catch {}
  // files whose handle the browser still lets this page read reopen by themselves
  await Promise.all([...entries.values()].filter((e) => e.handle && !files.has(e.key)).map((e) => reopen(e, false)));
  emit();
  probeSoon();
})());

// A kept handle → the file again. `ask`: show the browser's question (only
// ever from a press — the browser refuses it otherwise).
const reopen = async (e, ask) => {
  const h = e.handle;
  if (!h || typeof h.getFile !== "function") return false;
  try {
    const opts = { mode: "read" };
    let p = typeof h.queryPermission === "function" ? await h.queryPermission(opts) : "granted";
    if (p !== "granted" && ask && typeof h.requestPermission === "function") p = await h.requestPermission(opts);
    if (p !== "granted") return false;
    const f = await h.getFile();
    if (fileKey(f) !== e.key) return false; // not the same file any more (changed on disk)
    files.set(e.key, f);
    return true;
  } catch {
    return false;
  }
};
// "Reconnect": the browser asks once for each kept file it would not reopen
export const reconnect = async (keys = null) => {
  const want = [...entries.values()].filter((e) => e.handle && !files.has(e.key) && (!keys || keys.includes(e.key)));
  let n = 0;
  for (const e of want) {
    if (await reopen(e, true)) n++;
    else if (!keys) break; // refused (or the press has run out): the rest wait for the next one
  }
  emit();
  probeSoon();
  return n;
};

// ---------- what each title is, for the screen ----------
// avail: "ready" (the file is open here) · "locked" (kept, Reconnect reopens
// it) · "missing" (pick it again)
const thumbUrls = new Map(); // key -> object URL of the kept thumbnail
const thumbUrlOf = (e) => {
  if (!e.thumb) return null;
  let u = thumbUrls.get(e.key);
  if (!u || u.blob !== e.thumb) {
    if (u) { try { URL.revokeObjectURL(u.url); } catch {} }
    u = { blob: e.thumb, url: URL.createObjectURL(e.thumb) };
    thumbUrls.set(e.key, u);
  }
  return u.url;
};
const availOf = (e) => (files.has(e.key) ? "ready" : e.handle ? "locked" : "missing");
const epOrder = (a, b) =>
  (a.parsed.season ?? 0) - (b.parsed.season ?? 0) || (a.parsed.episode ?? 0) - (b.parsed.episode ?? 0) || a.name.localeCompare(b.name);
export const libraryView = () => {
  const list = [...entries.values()].map((e) => ({
    key: e.key, id: e.id, name: e.name, size: e.size, parsed: e.parsed, duration: e.duration, status: e.status, reason: e.reason,
    info: e.info, subs: e.subs.map((s) => ({ key: s.key, name: s.name, lang: s.lang, label: s.label, forced: s.forced, sdh: s.sdh, how: s.how })),
    avail: availOf(e), thumbUrl: thumbUrlOf(e), position: localPosition(e.key), addedAt: e.addedAt, code: episodeCode(e.parsed),
  }));
  const films = list.filter((e) => e.parsed.kind !== "episode")
    .sort((a, b) => a.parsed.title.localeCompare(b.parsed.title) || (a.parsed.year || 0) - (b.parsed.year || 0));
  const shows = new Map();
  for (const e of list.filter((x) => x.parsed.kind === "episode")) {
    const k = normKey(e.parsed.show);
    if (!shows.has(k)) shows.set(k, { key: k, name: e.parsed.show, episodes: [] });
    shows.get(k).episodes.push(e);
  }
  const showList = [...shows.values()].sort((a, b) => a.name.localeCompare(b.name)).map((s) => {
    s.episodes.sort(epOrder);
    const seasons = new Map();
    for (const e of s.episodes) {
      const n = e.parsed.season ?? null;
      if (!seasons.has(n)) seasons.set(n, []);
      seasons.get(n).push(e);
    }
    return { key: s.key, name: s.name, seasons: [...seasons].map(([season, episodes]) => ({ season, episodes })) };
  });
  return {
    films, shows: showList, count: list.length,
    loose: loose.map((l) => ({ key: l.key, name: l.name, lang: l.lang, label: l.label })),
    locked: list.filter((e) => e.avail === "locked").length,
    missing: list.filter((e) => e.avail === "missing").length,
    // what a subtitle can be attached to, in the order the screen shows them
    targets: [...films, ...showList.flatMap((s) => s.seasons.flatMap((x) => x.episodes))].map((e) => ({
      key: e.key, label: e.parsed.kind === "episode" ? `${e.parsed.show} · ${e.code}` : `${e.parsed.title}${e.parsed.year ? ` (${e.parsed.year})` : ""}`,
    })),
  };
};

// ---------- adding files ----------
// One subtitle file → its WebVTT and what its name and words say (null when
// it holds no cues).
const readSub = async (file) => {
  const text = decodeSubtitle(await file.arrayBuffer(), file.name);
  const vtt = toVtt(text, file.name);
  const cues = cueCount(vtt);
  if (!cues) return null;
  const info = subInfo(file.name);
  const lang = info.lang || textLang(text) || null;
  return { key: fileKey(file), name: file.name, size: file.size, lang, label: subLabel(info, lang), forced: info.forced, sdh: info.sdh, n: info.n, vtt, cues };
};
// a full track before SDH before forced; otherwise in the order they came
const subRank = (s) => (s.forced ? 2 : s.sdh ? 1 : 0);
const attach = (e, s, how) => {
  if (!e || e.subs.some((x) => x.key === s.key)) return false;
  const { dir, ...t } = s;
  e.subs.push({ ...t, how });
  e.subs = e.subs.map((x, i) => [x, i]).sort((a, b) => subRank(a[0]) - subRank(b[0]) || a[1] - b[1]).map(([x]) => x);
  return true;
};
let batchN = 0;
export const newBatchDir = (kind = "pick") => `${kind}:${Date.now().toString(36)}${(++batchN).toString(36)}`;

// batch: [{ file, handle?, dir? }] — files from one pick, drop or folder
//   to: a title's key — the subtitles in the batch go to that one
// -> { added, again, already, subsPaired, subsLoose, unreadable: [names], ignored: [names], full }
export const addFiles = async (batch, { to = null } = {}) => {
  await loadLibrary();
  const out = { added: 0, again: 0, already: 0, subsPaired: 0, subsLoose: 0, unreadable: [], ignored: [], full: 0, keys: [] };
  const fallbackDir = newBatchDir();
  const videos = [];
  const subFiles = [];
  for (const it of batch || []) {
    if (!it || !it.file) continue;
    if (isSubFile(it.file)) subFiles.push(it);
    else if (isVideoFile(it.file)) videos.push(it);
    else out.ignored.push(it.file.name);
  }
  let t = Date.now();
  for (const v of videos) {
    const key = fileKey(v.file);
    out.keys.push(key);
    const had = entries.get(key);
    if (had) {
      // the same file again (name and size): it is open again, nothing doubles
      if (files.has(key)) out.already++;
      else out.again++;
      files.set(key, v.file);
      if (v.handle && had.handle !== v.handle) { had.handle = v.handle; keep(had); }
      continue;
    }
    if (entries.size >= MAX_TITLES) { out.full++; continue; }
    const dir = v.dir || fallbackDir;
    const e = {
      key, id: idOf(key), name: v.file.name, size: v.file.size, lastModified: v.file.lastModified || 0, dir, addedAt: t++,
      parsed: parseName(v.file.name, dir), duration: null, thumb: null, status: null, reason: "", info: null, subs: [], handle: v.handle || null,
    };
    entries.set(key, e);
    files.set(key, v.file);
    out.added++;
    keep(e);
  }
  // the subtitles: read, then each finds its video
  const fresh = [];
  for (const s of subFiles) {
    const key = fileKey(s.file);
    const target = to && entries.get(to);
    if ((target ? target.subs : []).some((x) => x.key === key) || (!target && ([...entries.values()].some((e) => e.subs.some((x) => x.key === key)) || loose.some((l) => l.key === key)))) {
      out.already++;
      continue;
    }
    try {
      const sub = await readSub(s.file);
      if (sub) fresh.push({ ...sub, dir: s.dir || fallbackDir });
      else out.unreadable.push(s.file.name);
    } catch {
      out.unreadable.push(s.file.name);
    }
  }
  const touched = new Set();
  if (to && entries.get(to)) {
    const e = entries.get(to);
    for (const s of fresh) if (attach(e, s, "hand")) { out.subsPaired++; touched.add(e); }
    // (one attached by hand that was waiting unpaired is not waiting any more)
    loose = loose.filter((l) => !fresh.some((s) => s.key === l.key));
  } else {
    // the new subtitles AND the ones still waiting, against every video
    const pool = [...fresh, ...loose];
    const vids = [...entries.values()].map((e) => ({ key: e.key, name: e.name, dir: e.dir, parsed: e.parsed }));
    const pairs = matchSubs(vids, pool);
    const left = [];
    for (const s of pool) {
      const hit = pairs.get(s.key);
      const e = hit && entries.get(hit.video);
      if (e && attach(e, s, hit.how)) {
        touched.add(e);
        if (fresh.includes(s)) out.subsPaired++;
      } else left.push(s);
    }
    loose = left;
    out.subsLoose = left.filter((s) => fresh.includes(s)).length;
  }
  for (const e of touched) keep(e);
  if (fresh.length || to) keepLoose();
  emit();
  probeSoon();
  return out;
};

// -> what Undo needs to put it back (restoreTitle)
export const removeTitle = (key) => {
  const e = entries.get(key);
  if (!e) return null;
  const file = files.get(key) || null;
  entries.delete(key);
  files.delete(key);
  const u = thumbUrls.get(key);
  if (u) { try { URL.revokeObjectURL(u.url); } catch {} thumbUrls.delete(key); }
  releaseOpen(e.id);
  forget(key);
  emit();
  return { e, file };
};
export const restoreTitle = (snap) => {
  if (!snap || !snap.e || entries.has(snap.e.key)) return;
  entries.set(snap.e.key, snap.e);
  if (snap.file) files.set(snap.e.key, snap.file);
  keep(snap.e);
  emit();
};
// a subtitle off its video: it waits in "Subtitles without a video"
export const detachSub = (videoKey, subKey) => {
  const e = entries.get(videoKey);
  if (!e) return;
  const s = e.subs.find((x) => x.key === subKey);
  if (!s) return;
  e.subs = e.subs.filter((x) => x !== s);
  const { how, ...rest } = s;
  if (!loose.some((l) => l.key === subKey)) loose.push({ ...rest, dir: "" });
  keep(e);
  keepLoose();
  emit();
};
// one waiting subtitle onto a video, by hand
export const attachLoose = (subKey, videoKey) => {
  const s = loose.find((l) => l.key === subKey);
  const e = entries.get(videoKey);
  if (!s || !e) return false;
  attach(e, s, "hand");
  loose = loose.filter((l) => l !== s);
  keep(e);
  keepLoose();
  emit();
  return true;
};
export const removeLoose = (subKey) => {
  loose = loose.filter((l) => l.key !== subKey);
  keepLoose();
  emit();
};

// ---------- what each file is, before Play ----------
// One at a time, in the background: its length, a picture from about a tenth
// of the way in (drawn into a poster-shaped thumbnail), and whether this
// browser plays it — the codecs sniffed from its bytes (as the player's
// refusal sentence does), the browser's own answer when it opens the file,
// and its sound codec against canPlayType.
const sniffFile = async (f) => {
  try {
    const MB = 1024 * 1024;
    const head = new Uint8Array(await f.slice(0, MB).arrayBuffer());
    const tail = f.size > 2 * MB ? new Uint8Array(await f.slice(f.size - MB).arrayBuffer()) : new Uint8Array(0);
    const all = new Uint8Array(head.length + tail.length);
    all.set(head, 0);
    all.set(tail, head.length);
    return sniffCodecs(all, f.name);
  } catch {
    return {};
  }
};
export const sniffLocal = async (id) => {
  const e = byId(id);
  const f = e && files.get(e.key);
  return f ? sniffFile(f) : {};
};
const AUDIO_TYPE = { "AC-3": 'audio/mp4; codecs="ac-3"', "E-AC-3": 'audio/mp4; codecs="ec-3"', DTS: 'audio/mp4; codecs="dtsc"', TrueHD: 'audio/mp4; codecs="mlpa"' };
const once = (target, names, ms) => new Promise((resolve) => {
  const done = (what) => { clearTimeout(timer); for (const n of names) target.removeEventListener(n, on[n]); resolve(what); };
  const on = {};
  for (const n of names) { on[n] = () => done(n); target.addEventListener(n, on[n]); }
  const timer = setTimeout(() => done("timeout"), ms);
});
const POSTER_W = 240;
const POSTER_H = 360;
// The frame as a poster: the picture blurred to fill the 2:3 card (drawn tiny
// and stretched — a blur every browser can do), the frame itself across the
// upper part. A portrait video fills the card outright.
const drawPoster = async (v) => {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh) return null;
  const c = document.createElement("canvas");
  c.width = POSTER_W;
  c.height = POSTER_H;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const cover = (w, h) => {
    const s = Math.max(w / vw, h / vh);
    return [(w - vw * s) / 2, (h - vh * s) / 2, vw * s, vh * s];
  };
  if (vw / vh < 0.9) {
    ctx.drawImage(v, ...cover(POSTER_W, POSTER_H));
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if ("filter" in ctx) {
      // a real blur where the canvas has one (Chrome, Edge, Firefox), drawn a
      // little larger than the card so its edges do not fade to nothing
      ctx.filter = "blur(14px) saturate(1.2)";
      const [x, y, w, h] = cover(POSTER_W + 60, POSTER_H + 60);
      ctx.drawImage(v, x - 30, y - 30, w, h);
      ctx.filter = "none";
    } else {
      // elsewhere: drawn tiny, twice, and stretched back
      const tiny = document.createElement("canvas");
      tiny.width = 6;
      tiny.height = 9;
      tiny.getContext("2d").drawImage(v, ...cover(6, 9));
      const mid = document.createElement("canvas");
      mid.width = 24;
      mid.height = 36;
      const m = mid.getContext("2d");
      m.imageSmoothingEnabled = true;
      m.drawImage(tiny, 0, 0, 24, 36);
      ctx.drawImage(mid, 0, 0, POSTER_W, POSTER_H);
    }
    ctx.fillStyle = "rgba(6, 7, 14, 0.42)";
    ctx.fillRect(0, 0, POSTER_W, POSTER_H);
    const fh = Math.round((POSTER_W * vh) / vw);
    const y = Math.round(POSTER_H * 0.4 - fh / 2);
    ctx.drawImage(v, 0, Math.max(0, y), POSTER_W, fh);
  }
  return new Promise((resolve) => {
    try { c.toBlob((b) => resolve(b), "image/jpeg", 0.82); } catch { resolve(null); }
  });
};
const probe = async (e) => {
  const file = files.get(e.key);
  if (!file) return;
  e.status = "checking";
  emit();
  const info = await sniffFile(file);
  e.info = info;
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  v.preload = "auto";
  const url = URL.createObjectURL(file);
  try {
    v.src = url;
    const got = await once(v, ["loadedmetadata", "error"], 20000);
    if (got !== "loadedmetadata") {
      // refused outright (or so slow to open it may as well be): say why
      e.status = got === "error" ? "refused" : "unknown";
      e.reason = got === "error" ? failureSentence("file", info) : "";
    } else {
      e.duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      if (!v.videoWidth && !v.videoHeight) {
        // the sound opens, the picture does not (an audio-only file names no video codec)
        e.status = info.video ? "novideo" : "ok";
        e.reason = info.video ? failureSentence("video", info) : "";
      } else {
        e.status = "ok";
        e.reason = "";
        const at = e.duration ? Math.min(e.duration * 0.1, Math.max(0, e.duration - 0.5)) : 1;
        try { v.currentTime = at; } catch {}
        await once(v, ["seeked", "error"], 8000);
        if (v.readyState < 2) await once(v, ["loadeddata", "canplay"], 3000);
        if (typeof v.requestVideoFrameCallback === "function") {
          await new Promise((r) => { const t = setTimeout(r, 400); v.requestVideoFrameCallback(() => { clearTimeout(t); r(); }); });
        }
        if (v.readyState >= 2) e.thumb = (await drawPoster(v).catch(() => null)) || e.thumb;
        // its sound: a codec this browser says it cannot decode
        const type = AUDIO_TYPE[info.audio];
        if (type && !v.canPlayType(type)) {
          e.status = "noaudio";
          e.reason = failureSentence("audio", info);
        }
      }
    }
  } catch {
    e.status = "unknown";
  } finally {
    try { v.removeAttribute("src"); v.load(); } catch {}
    URL.revokeObjectURL(url);
  }
  if (entries.get(e.key) === e) keep(e);
  emit();
};
let probing = false;
const probeSoon = () => {
  if (probing) return;
  probing = true;
  setTimeout(async () => {
    try {
      for (;;) {
        const next = [...entries.values()].find((e) => files.has(e.key) && (e.status == null || (e.status === "ok" && !e.thumb && !e.thumbTried)));
        if (!next) break;
        if (next.status === "ok") next.thumbTried = true;
        await probe(next);
      }
    } finally {
      probing = false;
    }
  }, 0);
};
// (for the tests and the screen: every file open here has been looked at)
export const probesDone = () => !probing && ![...entries.values()].some((e) => files.has(e.key) && (e.status == null || e.status === "checking"));

// ---------- the player's side ----------
const open = new Map(); // id -> { url, subUrls }
const KEEP_OPEN = 3; // older ones are let go (their object URLs revoked)
const releaseOpen = (id) => {
  const o = open.get(id);
  if (!o) return;
  try { URL.revokeObjectURL(o.url); } catch {}
  for (const u of o.subUrls) { try { URL.revokeObjectURL(u); } catch {} }
  open.delete(id);
};
// What the player plays for `id`, or null when the file is not open here.
export const localItem = async (id) => {
  await loadLibrary();
  const e = byId(id);
  if (!e) return null;
  if (!files.has(e.key) && e.handle) await reopen(e, false);
  const file = files.get(e.key);
  if (!file) return null;
  releaseOpen(id);
  const subtitles = e.subs.map((t, n) => ({
    // the language first (the player's language rules read it), the file name
    // after it: two Hebrew files are told apart
    label: `${t.label} · ${t.name}`,
    lang: t.lang || "",
    url: URL.createObjectURL(new Blob([t.vtt], { type: "text/vtt" })),
    local: true,
    n,
    ...(t.forced ? { forced: true } : {}),
    ...(t.sdh ? { sdh: true } : {}),
  }));
  const url = URL.createObjectURL(file);
  open.set(id, { url, subUrls: subtitles.map((t) => t.url) });
  while (open.size > KEEP_OPEN) releaseOpen(open.keys().next().value);
  const p = e.parsed;
  const ep = p.kind === "episode";
  return {
    id,
    title: ep ? p.epTitle || `Episode ${p.episode}` : p.title,
    year: ep ? null : p.year,
    ...(ep ? { showTitle: p.show, season: p.season, episode: p.episode, epCode: episodeCode(p) } : {}),
    fileName: e.name,
    sizeBytes: e.size,
    videoUrl: url,
    downloadUrl: null,
    hlsUrl: null,
    transcodeBase: null,
    video: null,
    audio: null,
    subtitles,
    localKey: e.key,
    _local: true,
    _localEpisode: ep,
    _offline: true, // every "no server for this one" rule of a saved copy applies
  };
};
// The episode after this one, of the same show, among the files open here.
export const localNext = async (item) => {
  await loadLibrary();
  const e = item && byId(item.id);
  if (!e || e.parsed.kind !== "episode") return null;
  const show = normKey(e.parsed.show);
  const eps = [...entries.values()].filter((x) => x.parsed.kind === "episode" && normKey(x.parsed.show) === show).sort(epOrder);
  const n = eps[eps.indexOf(e) + 1];
  if (!n) return null;
  if (!files.has(n.key) && n.handle) await reopen(n, false);
  if (!files.has(n.key)) return null;
  const p = n.parsed;
  return { id: n.id, season: p.season, episode: p.episode, title: p.epTitle || `Episode ${p.episode}`, epCode: episodeCode(p), _localFile: true };
};

// ---------- where each file was left (this device only) ----------
const POS_KEY = "aurora-local-positions";
const POS_MAX = 200;
const readPositions = () => {
  try { return JSON.parse(localStorage.getItem(POS_KEY) || "{}") || {}; } catch { return {}; }
};
export const localPosition = (key) => {
  const p = readPositions()[key];
  return p && p.position > 0 ? p : null;
};
export const saveLocalPosition = (key, position, duration) => {
  if (!key || !(duration > 0)) return;
  try {
    const all = readPositions();
    all[key] = { position: Math.floor(position), duration: Math.floor(duration), finished: position / duration > 0.95, at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
    for (const k of keys.slice(POS_MAX)) delete all[k];
    localStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch {}
  // the title's length, when the probe could not tell (an MKV without one)
  const e = entries.get(key);
  if (e && !e.duration && duration > 0) { e.duration = duration; keep(e); }
};

// ---------- files out of a drop, a folder, a pick ----------
// A dropped or picked folder is walked for videos and subtitles, its
// subfolders too — with a sane cap (a whole drive dropped by mistake must not
// hang the page). "Sample" clips and hidden files are left out.
export const WALK_CAP = { files: 400, visits: 4000, depth: 6 };
const skipName = (name) => /^\./.test(name) || /^(?:__macosx|\$recycle\.bin|system volume information|sample|samples|extras?|featurettes?)$/i.test(name);
const sampleClip = (f) => /(?:^|[.\-_ ])sample(?:[.\-_ ]|$)/i.test(f.name) && f.size < 200 * 1024 * 1024;
const keepFile = (f) => (isVideoFile(f) && !sampleClip(f)) || isSubFile(f);
const walkHandle = async (h, dir, out, st, depth = 0) => {
  if (out.length >= WALK_CAP.files || ++st.visits > WALK_CAP.visits) { st.capped = true; return; }
  if (h.kind === "file") {
    try {
      const f = await h.getFile();
      if (keepFile(f)) out.push({ file: f, handle: h, dir });
    } catch {}
    return;
  }
  if (skipName(h.name) && depth > 0) return;
  if (depth >= WALK_CAP.depth) { st.capped = true; return; }
  const inner = `${dir}/${h.name}`;
  try {
    for await (const c of h.values()) {
      await walkHandle(c, inner, out, st, depth + 1);
      if (st.capped && out.length >= WALK_CAP.files) return;
    }
  } catch {}
};
const walkEntry = async (en, dir, out, st, depth = 0) => {
  if (out.length >= WALK_CAP.files || ++st.visits > WALK_CAP.visits) { st.capped = true; return; }
  if (en.isFile) {
    try {
      const f = await new Promise((res, rej) => en.file(res, rej));
      if (keepFile(f)) out.push({ file: f, dir });
    } catch {}
    return;
  }
  if (skipName(en.name) && depth > 0) return;
  if (depth >= WALK_CAP.depth) { st.capped = true; return; }
  const inner = `${dir}/${en.name}`;
  const reader = en.createReader();
  for (;;) {
    let batch = [];
    try { batch = await new Promise((res, rej) => reader.readEntries(res, rej)); } catch { break; }
    if (!batch.length) break;
    for (const c of batch) await walkEntry(c, inner, out, st, depth + 1);
  }
};
// What a drop carries, taken WHILE the drop event runs (the browser empties
// the DataTransfer after it): a handle per item where the browser gives one
// (Chrome, Edge — they can be kept), else its entry (a folder can be walked),
// else the plain file.
export const grabDrop = (dt) => {
  if (!dt) return [];
  const items = [...(dt.items || [])].filter((i) => i.kind === "file");
  if (!items.length) return [...(dt.files || [])].map((file) => ({ file }));
  return items.map((i) => {
    let handleP = null;
    let entry = null;
    let file = null;
    try { handleP = typeof i.getAsFileSystemHandle === "function" ? Promise.resolve(i.getAsFileSystemHandle()).catch(() => null) : null; } catch {}
    try { entry = typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null; } catch {}
    try { file = i.getAsFile(); } catch {}
    return { handleP, entry, file };
  });
};
// -> { batch: [{ file, handle?, dir }], capped }
export const resolveDrop = async (grabbed) => {
  const out = [];
  const st = { visits: 0, capped: false };
  const dir = newBatchDir("drop");
  for (const g of grabbed) {
    const h = g.handleP ? await g.handleP : null;
    if (h && h.kind === "directory") await walkHandle(h, dir, out, st);
    else if (h && h.kind === "file") await walkHandle(h, dir, out, st);
    else if (g.entry && g.entry.isDirectory) await walkEntry(g.entry, dir, out, st);
    else if (g.file && keepFile(g.file)) out.push({ file: g.file, dir });
    else if (g.file) out.push({ file: g.file, dir }); // (named as ignored by addFiles)
    if (out.length >= WALK_CAP.files) { st.capped = st.capped || grabbed.length > 1; break; }
  }
  return { batch: out, capped: st.capped };
};
// handles from the browser's own pickers (showOpenFilePicker / showDirectoryPicker)
export const fromHandles = async (handles) => {
  const out = [];
  const st = { visits: 0, capped: false };
  const dir = newBatchDir("pick");
  for (const h of handles || []) await walkHandle(h, dir, out, st);
  return { batch: out, capped: st.capped };
};
// a FileList from an <input> (webkitRelativePath says the folder, when one was picked)
export const fromInput = (list) => {
  const dir = newBatchDir("pick");
  const out = [];
  let capped = false;
  for (const f of [...(list || [])]) {
    const rel = f.webkitRelativePath || "";
    if (rel && rel.split("/").slice(0, -1).some(skipName)) continue;
    if (rel && !keepFile(f)) continue; // a folder's other files: not worth a word
    if (out.length >= WALK_CAP.files) { capped = true; break; }
    out.push({ file: f, dir: rel ? `${dir}/${rel.split("/").slice(0, -1).join("/")}` : dir });
  }
  return { batch: out, capped };
};

// (tests: the whole list forgotten, as a fresh browser would have it)
export const _forgetAll = async () => {
  entries.clear();
  files.clear();
  loose = [];
  for (const id of [...open.keys()]) releaseOpen(id);
  try { await store("files", "readwrite", (s) => s.clear()); await store("loose", "readwrite", (s) => s.clear()); } catch {}
  emit();
};

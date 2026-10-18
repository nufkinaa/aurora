// "Play a file from this device": a video (and its subtitles) picked from
// this computer or phone plays in Aurora's own player — the controls, the
// subtitle menu and its timing buttons, fullscreen, the keys and the phone
// gestures — from an object URL. NOTHING is uploaded: the bytes never leave
// the browser, and no server is needed (it works in offline mode too).
//
//   localPlayCard()          the picker (Saved screen): buttons + drag-and-drop
//   playLocal(video, subs)   open a file and go to #/play/<id>?local=1
//   localItem(id)            what the player plays for that id (null once gone)
//   localPosition / saveLocalPosition   where a file was left, by name + size
//
// Subtitles are read here, turned into WebVTT and handed to the player as
// object URLs too (js/localsubs.js does the text work). Files live for this
// tab only: after a reload the player sends you back to pick it again.
import { el, icons, toast, fmtBytes } from "./ui.js";
import { navigate } from "./router.js";
import { decodeSubtitle, toVtt, cueCount, nameLang, textLang, LANG_NAME, SUB_EXT, sniffCodecs } from "./localsubs.js";

export const VIDEO_EXT = /\.(mp4|m4v|mkv|mk3d|webm|mov|ogv|ogg|avi|ts|m2ts|mts|3gp)$/i;
const VIDEO_ACCEPT = "video/*,.mkv,.mk3d,.webm,.mp4,.m4v,.mov,.avi,.ts,.m2ts,.ogv";
const SUB_ACCEPT = ".srt,.vtt,.ass,.ssa";
export const isVideoFile = (f) => !!f && (VIDEO_EXT.test(f.name || "") || /^video\//.test(f.type || ""));
export const isSubFile = (f) => !!f && SUB_EXT.test(f.name || "");

// ---------- the files open in this tab ----------
const open = new Map(); // id -> { file, url, subtitles: [{ label, lang, url }], key }
const KEEP_OPEN = 3; // older ones are let go (their object URLs revoked)
const fileKey = (f) => `${f.name}|${f.size}`;
const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
};
export const isLocalId = (id) => /^local-/.test(String(id || ""));
const release = (entry) => {
  try { URL.revokeObjectURL(entry.url); } catch {}
  for (const t of entry.subtitles) { try { URL.revokeObjectURL(t.url); } catch {} }
};

// "The.Film.2020.1080p.mkv" → "The Film 2020 1080p"
export const titleOf = (name) => String(name || "Video").replace(/\.[^.]+$/, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim() || "Video";

// One subtitle file → a track for the player, or null when it holds no cues.
const readSub = async (file, n) => {
  const text = decodeSubtitle(await file.arrayBuffer(), file.name);
  const vtt = toVtt(text, file.name);
  if (!cueCount(vtt)) return null;
  const lang = nameLang(file.name) || textLang(text);
  const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
  // the language first (the player's language rules read it), the file name
  // after it: two Hebrew files are told apart
  const label = `${LANG_NAME[lang] || "Subtitles"} · ${file.name}`;
  return { label, lang: lang || "", url, local: true, n };
};

// -> { id, skipped: [names of subtitle files that held nothing usable] }
export const openLocal = async (video, subFiles = []) => {
  const key = fileKey(video);
  const id = `local-${hash(key)}`;
  if (open.has(id)) { release(open.get(id)); open.delete(id); }
  const subtitles = [];
  const skipped = [];
  for (const f of subFiles) {
    try {
      const t = await readSub(f, subtitles.length);
      if (t) subtitles.push(t);
      else skipped.push(f.name);
    } catch {
      skipped.push(f.name);
    }
  }
  open.set(id, { file: video, url: URL.createObjectURL(video), subtitles, key });
  while (open.size > KEEP_OPEN) {
    const [oldest] = open.keys();
    release(open.get(oldest));
    open.delete(oldest);
  }
  return { id, skipped };
};

export const localItem = (id) => {
  const e = open.get(id);
  if (!e) return null;
  return {
    id,
    title: titleOf(e.file.name),
    fileName: e.file.name,
    sizeBytes: e.file.size,
    videoUrl: e.url,
    downloadUrl: null,
    hlsUrl: null,
    transcodeBase: null,
    video: null,
    audio: null,
    subtitles: e.subtitles.map((t) => ({ ...t })),
    localKey: e.key,
    _local: true,
    _offline: true, // every "no server for this one" rule of a saved copy applies
  };
};

// What the file names as its codecs (its first and last megabyte), for the
// sentence a refused file gets.
export const sniffLocal = async (id) => {
  const e = open.get(id);
  if (!e) return {};
  try {
    const f = e.file;
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

// ---------- where each file was left (this device only) ----------
const POS_KEY = "aurora-local-positions";
const POS_MAX = 60;
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
};

// ---------- open and play ----------
export const playLocal = async (video, subFiles = []) => {
  const { id, skipped } = await openLocal(video, subFiles);
  if (skipped.length) toast(`Couldn't read ${skipped.length === 1 ? `“${skipped[0]}”` : `${skipped.length} subtitle files`} as subtitles — playing without ${skipped.length === 1 ? "it" : "them"}`, "💬");
  navigate(`#/play/${id}?local=1`);
};

// ---------- the picker ----------
// A card with "Choose a video" and "Add subtitles" (one file input each; the
// first takes subtitles too, so a video and its .srt can be picked together),
// what has been chosen, and Play. On a desktop the whole card takes a drop.
export const localPlayCard = () => {
  let video = null;
  let subs = [];
  const take = (files) => {
    const list = [...(files || [])];
    const ignored = [];
    for (const f of list) {
      if (isSubFile(f)) { if (!subs.some((s) => fileKey(s) === fileKey(f))) subs.push(f); }
      else if (isVideoFile(f)) video = f;
      else ignored.push(f.name);
    }
    if (ignored.length) toast(`${ignored.length === 1 ? `“${ignored[0]}” isn't` : `${ignored.length} files aren't`} a video or a subtitle file (.srt, .vtt, .ass)`, "📂");
    paint();
  };
  const videoInput = el("input", { type: "file", class: "local-video-input", accept: `${VIDEO_ACCEPT},${SUB_ACCEPT}`, multiple: true, hidden: true, onchange: (e) => { take(e.target.files); e.target.value = ""; } });
  const subInput = el("input", { type: "file", class: "local-sub-input", accept: SUB_ACCEPT, multiple: true, hidden: true, onchange: (e) => { take(e.target.files); e.target.value = ""; } });
  const chosen = el("div", { class: "local-play-chosen" });
  const goBtn = el("button", { class: "btn btn-primary focusable local-play-go", html: icons.play + "<span>Play</span>", onclick: () => go() });
  const go = async () => {
    if (!video) return;
    goBtn.disabled = true;
    try { await playLocal(video, subs); } finally { goBtn.disabled = false; }
  };
  const chip = (text, sub, onRemove, cls) =>
    el("span", { class: `local-chip ${cls}` },
      el("span", { class: "local-chip-name" }, text),
      sub && el("span", { class: "local-chip-sub" }, sub),
      el("button", { class: "local-chip-x focusable", "aria-label": `Remove ${text}`, onclick: onRemove }, "×"));
  const paint = () => {
    chosen.innerHTML = "";
    if (video) chosen.append(chip(video.name, fmtBytes(video.size), () => { video = null; paint(); }, "video"));
    for (const s of subs) {
      const lang = nameLang(s.name);
      chosen.append(chip(s.name, lang ? LANG_NAME[lang] : "subtitles", () => { subs = subs.filter((x) => x !== s); paint(); }, "sub"));
    }
    chosen.classList.toggle("hidden", !video && !subs.length);
    goBtn.classList.toggle("hidden", !video);
    pickBtn.querySelector("span").textContent = video ? "Another video" : "Choose a video";
    pickBtn.classList.toggle("btn-primary", !video);
  };
  const pickBtn = el("button", { class: "btn btn-primary focusable local-play-pick", html: "<span>Choose a video</span>", onclick: () => videoInput.click() });
  const subBtn = el("button", { class: "btn focusable local-play-subs", html: "<span>Add subtitles</span>", onclick: () => subInput.click() });
  const card = el("section", { class: "local-play", "aria-label": "Play a file from this device" },
    el("div", { class: "local-play-head" },
      el("div", { class: "local-play-glyph", "aria-hidden": "true" }, "📂"),
      el("div", {},
        el("h2", {}, "Play a file from this device"),
        el("p", { class: "local-play-text" }, "A video from this computer or phone, with subtitles if you have them (.srt, .vtt, .ass), in Aurora's player. The file stays on this device — nothing is uploaded."))),
    el("div", { class: "local-play-actions" }, pickBtn, subBtn, goBtn),
    chosen,
    el("p", { class: "local-play-drop" }, "…or drop a video and its subtitles here"),
    videoInput, subInput);
  // drag and drop (desktop)
  let depth = 0;
  card.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; card.classList.add("drag"); });
  card.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
  card.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; card.classList.remove("drag"); } });
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    card.classList.remove("drag");
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) take(e.dataTransfer.files);
  });
  paint();
  // The player's code, fetched now: a connection that drops between here and
  // Play (the point of offline mode) must not leave the player unloadable.
  // (With the service worker it comes from its cache anyway.)
  setTimeout(() => { import("./screens/player.js").catch(() => {}); }, 0);
  return card;
};

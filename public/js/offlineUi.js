// What "on this device" LOOKS like, in one place (offline-look, 2026-11-10).
//
//   one icon   deviceIcon — "this device" wherever it is named (a button, a
//              heading, the nav, a sheet). The same picture the phone's More
//              menu uses for the place.
//   one mark   mark() / setMark() — the state of ONE title on this device: a
//              small ring with an arrow landing on a line. Saved is a solid
//              mint disc; saving is a ring that fills; waiting, paused and
//              "didn't save" each have their own ring. Cards, episode rows,
//              buttons, toasts and the nav all draw this same mark.
//   one name   words() — what each state is called, everywhere.
//
// The machinery is js/offline.js (not this file): this module only reads it.
// docs/offline-look.md lists the values so the phone app can match.
//
// Cost on screens that have nothing to do with offline: none. Cards are only
// asked about (state.cardMark) while this device holds a copy, a save or a
// wish; the answer is three Map lookups; a card that has nothing gets no node.
import { el, icons, toast, fmtBytes } from "./ui.js";
import { state } from "./state.js";
import * as offline from "./offline.js";

// ---------- the icon ----------
export const deviceIcon = icons.downloadDevice;
// The file itself (a download into the computer's own folder — NOT a copy
// inside Aurora): a page with an arrow, so the two cannot be mistaken.
export const fileIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.500 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.500z"/><path d="M13.500 3v5.500H19"/><path d="M12 11.300v5.900m-2.600-2.500 2.600 2.600 2.600-2.600"/></svg>';

// ---------- the words ----------
export const PLACE = "On this device";
export const SAVE = "Save to this device";
export const REMOVE = "Remove from this device";
export const pctOf = (p) => Math.max(0, Math.min(100, Math.round((Number(p) || 0) * 100)));
// st: a state of offline.stateOf() (or null: not here). pct 0..1.
// waiting: the server is still making the smaller copy (a job's own flag).
export const SAVED = "Saved on this device";
export const words = (st, pct = 0, waiting = false) => {
  switch (st) {
    case "saved": return SAVED;
    case "saving": return `Saving ${pctOf(pct)}%`;
    case "preparing": return waiting ? "Waiting for the server" : "Getting ready";
    case "queued": return "Waiting for its turn";
    case "retrying": return "Waiting for the connection";
    case "paused": return "Paused";
    case "failed": return "Didn't save";
    case "waiting": return "Waiting for the server's copy";
    default: return SAVE;
  }
};
export const ACTIVE = (st) => st === "queued" || st === "preparing" || st === "saving" || st === "retrying";

// ---------- the mark ----------
const GLYPH = {
  // an arrow landing on a line (the device icon's own arrow, and its stand)
  arrow: "M10.900 5.700h2.200v5.200h2.800L12 15.700l-3.900-4.800h2.800zM7.600 17h8.800v1.700H7.600z",
  pause: "M8.700 7.700h2.300v8.600H8.700zM13 7.700h2.300v8.600H13z",
  bang: "M10.900 6.300h2.200v7.300h-2.200zM10.900 15.500h2.200v2.200h-2.200z",
};
const glyphOf = (st) => (st === "paused" ? "pause" : st === "failed" ? "bang" : "arrow");
const MARK_SVG =
  '<svg viewBox="0 0 24 24" focusable="false"><circle class="dm-disc" cx="12" cy="12" r="11"/><circle class="dm-track" cx="12" cy="12" r="9.600"/>' +
  '<g class="dm-spin"><circle class="dm-arc" cx="12" cy="12" r="9.600" pathLength="100" transform="rotate(-90 12 12)"/></g><path class="dm-glyph"/></svg>';
// How much of the ring is drawn, 0..100
const arcOf = (st, pct) =>
  st === "saving" || st === "retrying" || st === "paused" ? Math.max(4, pctOf(pct)) : st === "preparing" ? 26 : 0;
export const setMark = (node, st, pct = 0) => {
  const s = st || "none";
  if (node.dataset.state !== s) {
    node.dataset.state = s;
    const g = glyphOf(s);
    if (node._g !== g) { node._g = g; node.querySelector(".dm-glyph").setAttribute("d", GLYPH[g]); }
  }
  const a = arcOf(s, pct);
  if (node._a !== a) { node._a = a; node.querySelector(".dm-arc").style.strokeDasharray = `${a} 100`; }
  return node;
};
// A mark node: <i class="dev-mark" data-state="saving">. Decoration only —
// whatever carries it says the state in words (aria-label / text).
export const mark = (st = "none", pct = 0, cls = "") => {
  const node = document.createElement("i");
  node.className = "dev-mark" + (cls ? " " + cls : "");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = MARK_SVG;
  return setMark(node, st, pct);
};
// the mark pops once (a save landing) — nothing under reduced motion (CSS)
export const pop = (node) => {
  if (!node) return;
  node.classList.remove("landed");
  void node.offsetWidth;
  node.classList.add("landed");
  setTimeout(() => node.classList.remove("landed"), 1200);
};

// ---------- who is looking (the kids rule: a kids profile sees its own copies only) ----------
const who = () => (state.profile ? { id: state.profile.id, kids: !!state.profile.kids } : offline.lastWho());
let index = null; // offline.js's live Map id -> copy summary (refreshIndex hands it out)
const mine = (copy) => { const w = who(); return !w || !w.kids || (copy && copy.profileId === w.id); };
// The index, asked for once and shared (offline.js keeps it fresh after that).
let indexed = null;
export const whenIndexed = () =>
  indexed || (indexed = offline.refreshIndex().then((map) => (index = map)).catch(() => { indexed = null; return index; }));
// The copy of one title this person may see here (the slim row), or null.
export const copyHere = (id) => { const c = index && index.get(id); return c && mine(c) ? c : null; };
// What a title is called in a line: "Show S1 E2" or the film's name.
export const nameOf = (item) => (item && item.showTitle && item.season != null ? `${item.showTitle} S${item.season} E${item.episode}` : (item && item.title) || "It");

// ---------- what a card says ----------
// shows: showId -> { n: copies here, st, pct } (a show's poster speaks for its episodes)
let shows = new Map();
let wished = new Map(); // imdbId -> "waiting" | "failed" (titles the server does not have yet)
const rebuild = () => {
  shows = new Map();
  const at = (id) => { let s = shows.get(id); if (!s) shows.set(id, (s = { n: 0, st: null, pct: 0 })); return s; };
  if (index) for (const c of index.values()) if (c.showId && mine(c)) at(c.showId).n++;
  const RANK = { saving: 6, retrying: 5, preparing: 4, queued: 3, paused: 2, failed: 1 };
  for (const j of offline.listJobs()) {
    const sid = j.item && j.item.showId;
    if (!sid) continue;
    const s = at(sid);
    if (!s.st || (RANK[j.state] || 0) > (RANK[s.st] || 0)) { s.st = j.state; s.pct = j.pct || 0; }
  }
};
const noteWishes = (list) => {
  wished = new Map();
  for (const w of list || []) if (w.imdbId && w.state !== "ready") wished.set(w.imdbId, w.state === "failed" ? "failed" : "waiting");
};
// → { st, pct, n } or null
const lookOf = (item) => {
  if (!item) return null;
  if (item.type === "show") {
    const s = item.id && shows.get(item.id);
    if (s && (s.st || s.n)) return s.st ? { st: s.st, pct: s.pct, n: s.n } : { st: "saved", pct: 1, n: s.n };
  } else if (item.id) {
    const st = offline.stateOf(item.id);
    if (st === "saved") { if (mine(index && index.get(item.id))) return { st, pct: 1, n: 0 }; }
    else if (st) { const j = ACTIVE(st) || st === "paused" ? offline.jobFor(item.id) : null; return { st, pct: j ? j.pct || 0 : 0, n: 0 }; }
  }
  const w = item.imdbId && wished.get(item.imdbId);
  return w ? { st: w, pct: 0, n: 0 } : null;
};
const sayOf = (look) =>
  look.st === "saved" ? (look.n > 1 ? `${look.n} episodes saved on this device` : look.n === 1 ? "1 episode saved on this device" : "saved on this device")
    : words(look.st, look.pct).replace(/^./, (c) => c.toLowerCase());

const live = new Set(); // cards whose mark is moving (a save under way)
const applyCard = (node, item) => {
  const look = lookOf(item);
  let m = node._dev;
  if (!look) {
    if (m) {
      m.remove();
      node._dev = null;
      node.classList.remove("has-dev");
      live.delete(node);
      if (node._label0 != null) node.setAttribute("aria-label", node._label0);
    }
    return;
  }
  if (!m) {
    m = node._dev = mark(look.st, look.pct, "card-dev");
    m.prepend(document.createElement("b"));
    if (node._label0 == null) node._label0 = node.getAttribute("aria-label") || "";
    node.classList.add("has-dev");
    node.append(m);
  } else setMark(m, look.st, look.pct);
  const text = look.st === "saving" || look.st === "retrying" || look.st === "paused" ? `${pctOf(look.pct)}%` : look.st === "saved" && look.n > 1 ? String(look.n) : "";
  if (m.firstChild.textContent !== text) m.firstChild.textContent = text;
  const say = `${node._label0}, ${sayOf(look)}`;
  if (node.getAttribute("aria-label") !== say) node.setAttribute("aria-label", say);
  if (ACTIVE(look.st)) live.add(node); else live.delete(node);
};
const sweep = () => { for (const node of document.querySelectorAll("#app .card")) if (node._item) applyCard(node, node._item); };
const tick = () => { for (const node of live) { if (!node.isConnected) live.delete(node); else applyCard(node, node._item); } };

// ---------- the nav: a quiet ring on the way to "On this device" ----------
// { n: saves under way, pct 0..1 across them, need: saves that stopped and wait for the person, copies, bytes }
export const summary = () => {
  let n = 0, sum = 0, need = 0;
  for (const j of offline.listJobs()) {
    if (ACTIVE(j.state)) { n++; sum += j.pct || 0; }
    else if (j.state === "failed" || (j.state === "paused" && j.why !== "user")) need++;
  }
  let copies = 0, bytes = 0;
  if (index) for (const c of index.values()) if (mine(c)) { copies++; bytes += c.sizeBytes || 0; }
  return { n, pct: n ? sum / n : 0, need, copies, bytes };
};
// the line under "Saved on this device" in the phone's More menu
const deviceLine = () => {
  const s = summary();
  if (s.n) return { text: s.n === 1 ? `Saving · ${pctOf(s.pct)}%` : `Saving ${s.n} · ${pctOf(s.pct)}%`, live: true };
  if (s.need) return { text: s.need === 1 ? "One save needs you" : `${s.need} saves need you`, live: false };
  if (s.copies) return { text: `${s.copies} ${s.copies === 1 ? "title" : "titles"}${s.bytes ? ` · ${fmtBytes(s.bytes)}` : ""}`, live: false };
  return null;
};
let navMark = null;
let moreMark = null;
const paintNav = () => {
  const s = summary();
  const st = s.n ? "saving" : s.need ? "failed" : "none";
  const say = s.n ? `${PLACE} — saving ${s.n === 1 ? "one title" : `${s.n} titles`}, ${pctOf(s.pct)}%` : s.need ? `${PLACE} — ${s.need === 1 ? "one save needs you" : `${s.need} saves need you`}` : PLACE;
  const a = document.getElementById("nav-saved");
  if (a) {
    if (!navMark && st !== "none") {
      navMark = mark(st, s.pct, "nav-dev");
      a.prepend(navMark);
    }
    if (navMark) setMark(navMark, st, s.pct);
    a.classList.toggle("busy", st !== "none");
    if (a.getAttribute("aria-label") !== say) a.setAttribute("aria-label", say);
  }
  // phones: Saved lives in More, so More wears the ring
  const more = document.getElementById("nav-more");
  if (more) {
    if (!moreMark && st !== "none") {
      moreMark = mark(st, s.pct, "nav-dev-ring");
      more.append(moreMark);
    }
    if (moreMark) setMark(moreMark, st, s.pct);
    more.classList.toggle("dev-busy", st !== "none");
    const label = st === "none" ? "More" : `More — ${say}`;
    if (more.getAttribute("aria-label") !== label) more.setAttribute("aria-label", label);
  }
  // the open More menu's own line
  const text = document.querySelector('.nav-more-item[data-more="saved"] .nav-more-text');
  if (text) {
    const line = deviceLine();
    let sub = text.querySelector(".nav-more-sub");
    if (!line) { if (sub) sub.remove(); }
    else {
      if (!sub) text.append((sub = el("span", { class: "nav-more-sub" })));
      if (sub.textContent !== line.text) sub.textContent = line.text;
    }
    text.parentElement.classList.toggle("live", !!(line && line.live));
  }
};

// ---------- a save landing ----------
// "It is here now": the marks pop once and one line says so, with the press
// that plays it. (offline-web's own lines — a wish arriving, a Retry — say
// it themselves; this one keeps quiet then.)
const before = new Map(); // id -> { state, title } of the saves seen last time
// ids that land as part of a batch ("Save the season"): the batch says it once
export const hush = new Set();
const landed = (id, title) => {
  for (const node of document.querySelectorAll("#app .card")) if (node._item && (node._item.id === id) && node._dev) pop(node._dev);
  pop(navMark);
  pop(moreMark);
  document.dispatchEvent(new CustomEvent("aurora-device-landed", { detail: { id, title } }));
  if (hush.has(id)) return;
  setTimeout(() => {
    const said = [...document.querySelectorAll("#toasts .toast")].some((t) => title && t.textContent.includes(title) && /on this device/.test(t.textContent));
    if (said) return;
    if ((location.hash || "").startsWith(`#/play/${id}`)) return;
    toast(`“${title || "It"}” is on this device`, mark("saved"), { label: "Play", onClick: () => { location.hash = `#/play/${id}?offline=1`; } });
  }, 80);
};
const watchLandings = () => {
  const now = new Map();
  for (const j of offline.listJobs()) now.set(j.id, { state: j.state, title: (j.item && j.item.showTitle ? nameOf(j.item) : j.title) || (j.item && j.item.title) || "" });
  for (const [id, was] of before) {
    if (!now.has(id) && ACTIVE(was.state) && offline.savedNow(id)) landed(id, was.title);
  }
  before.clear();
  for (const [id, v] of now) before.set(id, v);
};

// ---------- back on the line ----------
// Minutes watched with no line are kept on the device and handed to the
// server when it is back (offline.flushProgress): said once, quietly.
let lastDelivered = 0;
export const delivered = (n) => {
  if (!(n > 0) || Date.now() - lastDelivered < 60000) return;
  lastDelivered = Date.now();
  toast(n === 1 ? "Back on the line — where you stopped is saved" : `Back on the line — where you stopped in ${n} titles is saved`, mark("saved"), null, { quiet: true });
};

// ---------- the one loop ----------
let armed = false;
let dirty = true;
let timer = null;
let jobSig = "";
const flush = () => {
  timer = null;
  watchLandings();
  const jobs = offline.listJobs();
  const sig = jobs.map((j) => `${j.id}:${j.state}`).join("|");
  if (sig !== jobSig) { jobSig = sig; dirty = true; }
  const any = jobs.length > 0 || (index && index.size > 0) || wished.size > 0;
  if (any !== armed) {
    armed = any;
    state.cardMark = armed ? applyCard : null;
    dirty = true;
  }
  if (dirty) {
    dirty = false;
    rebuild();
    if (armed || document.querySelector("#app .card.has-dev")) sweep();
  } else tick();
  paintNav();
};
const soon = (ms = 120) => { if (!timer) timer = setTimeout(flush, ms); };

let started = false;
export const start = () => {
  if (started || !offline.available()) return;
  started = true;
  state.deviceLine = deviceLine;
  offline.onJobs(() => soon());
  offline.onIndex(() => { dirty = true; soon(); });
  whenIndexed().then(() => { dirty = true; soon(0); });
  import("./offlineWish.js").then((w) => {
    noteWishes(w.listWishes());
    w.onWishes((list) => { noteWishes(list); dirty = true; soon(); });
    dirty = true;
    soon();
  }).catch(() => {});
  // another profile on the same device: the kids rule may change what shows
  window.addEventListener("hashchange", () => { if (armed) { const w = who(); const k = w ? `${w.id}|${w.kids}` : ""; if (k !== start._who) { start._who = k; dirty = true; soon(); } } });
  // "Keep the next episode ready" says what it did, once
  offline.smartNext.on((e) => {
    const n = e && e.next;
    if (!n) return;
    const name = [n.showTitle, n.season != null && n.episode != null ? `S${n.season} E${n.episode}` : n.title].filter(Boolean).join(" · ") || n.title || "The next episode";
    if (e.type === "saving") toast(`Keeping the next one ready: ${name}`, mark("saving", 0.04), null, { quiet: true });
    else if (e.type === "wished") toast(`${name} isn't on the server yet — it will be saved here when it arrives`, mark("waiting"));
    else if (e.type === "failed") toast(`Couldn't keep ${name} ready${e.error ? `: ${e.error}` : ""}`, mark("failed"), { label: "Open", onClick: () => { location.hash = "#/saved"; } });
  });
  // a size sheet somebody else opened (a Retry, a wish): the same dress
  try {
    new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) {
        const s = n.nodeType === 1 && n.classList.contains("look-notice-wrap") ? n.querySelector(".offline-sheet:not(.dressed)") : null;
        if (s) dress(s, null, {});
      }
    }).observe(document.body, { childList: true });
  } catch {}
  // a line about this device said by somebody else (a wish, a Retry): the
  // phone picture gives way to the mark, in the state the line speaks of
  try {
    const root = document.getElementById("toasts");
    if (root) new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) {
        const pic = n.nodeType === 1 && n.firstElementChild;
        if (!pic || !/^(\u{1F4F1}|\u{1F4F2})$/u.test(pic.textContent)) continue;
        const t = n.textContent;
        if (!/this device|Carrying on with|^.{0,3}Saving /.test(t)) continue;
        const st = /won't be saved/.test(t) ? "none" : /will be saved/.test(t) ? "waiting" : /is saved|arrived/.test(t) ? "saved" : /Carrying on|Saving /.test(t) ? "preparing" : "none";
        pic.textContent = "";
        pic.append(mark(st, 0, "toast-dev"));
      }
    }).observe(root, { childList: true });
  } catch {}
  soon(0);
};

// ---------- the size sheet, dressed ----------
// offline-web's sheet (js/offlinePicker.js) asks the question; this adds
// what the person wants to know before answering: how much room is left —
// and, for several episodes at once, what they come to together.
// (A thin wrapper — their sheet, their choices, their Sound row.)
//   opts.title   the name in the sentence
//   opts.lead    a sentence of the caller's own (kept as it is)
//   opts.count   how many episodes this one answer is for (1 = a single title)
//   opts.times   how many times the first one's size they come to (by running time)
//   opts.originalBytes  what their files weigh together, when known
export const pickSize = (options, opts = {}) => {
  const seen = new Set(document.querySelectorAll(".offline-sheet"));
  return import("./offlinePicker.js").then((m) => {
    const p = m.pickOfflineQuality(options, opts);
    const sheet = [...document.querySelectorAll(".offline-sheet")].find((s) => !seen.has(s));
    if (sheet) dress(sheet, options, opts);
    return p;
  });
};
const dress = (sheet, options, { title = "", lead = "", count = 1, times = 0, originalBytes = 0 } = {}) => {
  sheet.classList.add("dressed");
  sheet.setAttribute("aria-label", SAVE);
  const icon = sheet.querySelector(".sheet-icon");
  if (icon) { icon.textContent = ""; icon.append(mark("none", 0, "sheet-dev")); }
  const head = sheet.querySelector(".look-notice-title");
  if (head) head.textContent = "Save to this device — which size?";
  const text = sheet.querySelector(".look-notice-text");
  const many = count > 1;
  if (text && !lead && options) {
    text.textContent = many
      ? `${title ? `${title}. ` : ""}They are saved one after another and play with no connection. The sizes are for all ${count} together.`
      : `${title ? `“${title}”` : "It"} will play from this device — no connection needed.`;
  }
  const opts = sheet.querySelector(".offline-opts");
  if (!opts) return;
  const rows = [...opts.querySelectorAll(".offline-opt")];
  // several episodes: what each size comes to for all of them
  const total = (o) => {
    if (!o.sizeBytes) return 0;
    if (!many) return o.sizeBytes;
    if (o.quality === "original" && originalBytes) return originalBytes;
    return Math.round(o.sizeBytes * (times > 0 ? times : count));
  };
  if (many) (options || []).forEach((o, i) => {
    const cell = rows[i] && rows[i].querySelector(".offline-opt-size");
    if (cell && o.sizeBytes) cell.textContent = `≈ ${fmtBytes(total(o))}`;
  });
  const room = el("p", { class: "offline-room", "aria-live": "polite" });
  opts.before(room);
  offline.storageSummary().then((s) => {
    if (!s || !s.quota || !sheet.isConnected) return;
    room.append(el("span", { class: "offline-room-ic", html: deviceIcon }), `Room on this device: ≈ ${fmtBytes(s.free)}`);
    // an honest hint on a size that will not fit (the browser's number is a guess: said, not enforced)
    (options || []).forEach((o, i) => {
      if (rows[i] && total(o) > s.free) {
        rows[i].classList.add("tight");
        const d = rows[i].querySelector(".offline-opt-detail");
        if (d) d.textContent = [d.textContent, "more than the room left"].filter(Boolean).join(" — ");
      }
    });
  }).catch(() => {});
};

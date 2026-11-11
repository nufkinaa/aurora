// What is worth putting on this device, and "Pack for a trip" (offline-look,
// 2026-11-10).
//
//   suggestions()    what this person would most likely want with them, in
//                    order: the film they stopped in, the next episodes of
//                    the shows they are in the middle of (one of each first,
//                    then the seconds…), then My List, then films that are
//                    new on the server (offered, never ticked by themselves).
//                    Only titles the server holds — a press saves them right
//                    now — and nothing that is here already or on its way.
//   plan(rows, min)  as many of them, from the top, as fill that much time
//   openTrip()       "Going somewhere?" — pick how long, see what Aurora
//                    would pack and what it weighs against the room here,
//                    untick what you don't want, one press packs it.
//
// Nothing here runs unless the person opens "On this device" (the empty
// state's offers) or presses "Pack for a trip": no request on Home, no work
// per card. The saving is js/offline.js, through offlineButtons.saveSeveral.
//
// The library list carries no episodes (the server sends a show's tree only
// with the show itself), so a show the person is in the middle of is asked
// for by id — a handful of small requests, and only here.
import { el, toast, fmtBytes } from "./ui.js";
import { api } from "./api.js";
import { state, loadLibrary, progressFor } from "./state.js";
import { pushScope, popScope } from "./focus.js";
import * as offline from "./offline.js";
import { mark, bagIcon, deviceIcon, whenIndexed, copyHere } from "./offlineUi.js";
import { saveSeveral, sayBatch } from "./offlineButtons.js";

const FILM_SECS = 110 * 60; // a film / an episode whose length nobody told us
const EP_SECS = 45 * 60;
const STARTED = 10; // seconds in: the same line Home's "Continue Watching" draws
const SHOWS = 6; // shows asked for at most, per look
const unfinished = (id) => { const p = progressFor(id); return !(p && p.finished); };
const taken = (id) => !!(copyHere(id) || offline.jobFor(id));

// one row: what to save, what to call it, why it is offered, what it costs
const filmRow = (m, why) => {
  const p = progressFor(m.id);
  const secs = m.duration || FILM_SECS;
  const at = p && !p.finished && p.position > STARTED ? p.position : 0;
  return { id: m.id, item: m, name: m.title, sub: "", why, cover: m.cover || null, secs: Math.max(60, secs - at), bytes: m.sizeBytes || 0 };
};
const epRow = (show, s, e, why) => {
  const season = e.season ?? s.number;
  const p = progressFor(e.id);
  const secs = e.duration || EP_SECS;
  const at = p && !p.finished && p.position > STARTED ? p.position : 0;
  const cover = e.cover || show.cover || null;
  return {
    id: e.id,
    item: { ...e, showTitle: show.title, showId: show.id, season, episode: e.episode, title: e.title || show.title, cover },
    name: show.title, sub: `S${season} E${e.episode}`, why, cover, secs: Math.max(60, secs - at), bytes: e.sizeBytes || 0,
  };
};
// a show's episodes still to watch, from where the person is
const aheadOf = (show) => {
  const flat = [];
  for (const s of show.seasons || []) for (const e of s.episodes || []) if (e && e.id) flat.push({ s, e });
  flat.sort((a, b) => (a.e.season ?? a.s.number) - (b.e.season ?? b.s.number) || a.e.episode - b.e.episode);
  // the episode touched last: carry on from it (itself when it is not finished)
  let last = -1, lastAt = 0;
  flat.forEach(({ e }, i) => { const p = progressFor(e.id); if (p && (p.updatedAt || 1) >= lastAt) { lastAt = p.updatedAt || 1; last = i; } });
  const from = last < 0 ? 0 : last;
  const ahead = flat.slice(from).filter(({ e }) => unfinished(e.id));
  return { rows: ahead.length ? ahead : flat.filter(({ e }) => unfinished(e.id)), at: lastAt };
};

// → [{ id, item, name, sub, why, cover, secs, bytes, extra }]
//   perShow  how many episodes of one show at most
//   extra    offered, not what the person is in the middle of or asked for
export const suggestions = async ({ perShow = 3, limit = 40 } = {}) => {
  if (!offline.available() || !state.profile || state.noServer || navigator.onLine === false) return [];
  let lib = null;
  try { lib = await loadLibrary(); } catch { return []; }
  if (!lib) return [];
  await whenIndexed();
  const movies = lib.movies || [];
  const shows = lib.shows || [];
  const filmById = new Map(movies.map((m) => [m.id, m]));
  const showById = new Map(shows.map((x) => [x.id, x]));
  const out = [];
  const seen = new Set();
  const push = (row) => { if (!row || seen.has(row.id) || taken(row.id)) return false; seen.add(row.id); out.push(row); return true; };
  // a show with its episodes (asked once per look)
  const trees = new Map();
  const treeOf = (id) => {
    if (!trees.has(id)) trees.set(id, api.item(id).then((t) => (t && t.seasons ? t : null)).catch(() => null));
    return trees.get(id);
  };

  // 1. what they are in the middle of — newest first, one of each, then round again
  const lanes = [];
  const recent = Object.entries(state.progress || {})
    .filter(([id, p]) => p && /^[0-9a-f]{6,}$/i.test(id)) // (the server's own titles: not a stream's history, not a file from this device)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, 24);
  const mineShows = new Map(); // showId -> when it was last touched
  const asked = [];
  for (const [id, p] of recent) {
    const film = filmById.get(id);
    if (film) {
      if (!p.finished && p.position > STARTED) lanes.push({ at: p.updatedAt || 0, rows: [filmRow(film, "Carry on")] });
      continue;
    }
    if (showById.has(id) || asked.length >= 12) continue;
    // an episode, most likely: which show is it of?
    asked.push(api.item(id).then((it) => {
      if (it && it.showId && showById.has(it.showId) && !mineShows.has(it.showId)) mineShows.set(it.showId, p.updatedAt || 0);
    }).catch(() => {}));
  }
  await Promise.all(asked);
  const going = [...mineShows].sort((a, b) => b[1] - a[1]).slice(0, SHOWS);
  const grown = await Promise.all(going.map(([id]) => treeOf(id)));
  going.forEach(([, at], i) => {
    const show = grown[i];
    if (!show) return;
    const { rows } = aheadOf(show);
    if (rows.length) lanes.push({ at, rows: rows.slice(0, perShow + 4).map(({ s, e }, k) => epRow(show, s, e, k === 0 ? "Next up" : "After that")) });
  });
  lanes.sort((a, b) => b.at - a.at);
  const taking = lanes.map(() => 0); // how many of each lane are in (ones already here don't count)
  for (let round = 0; round < perShow + 4; round++) {
    for (const [k, lane] of lanes.entries()) {
      if (taking[k] >= perShow) continue;
      if (push(lane.rows[round])) taking[k]++;
    }
  }

  // 2. My List — what the server holds of it
  let list = [];
  try { list = ((await api.watchlist(state.profile.id)) || {}).items || []; } catch {}
  const byImdb = new Map();
  for (const m of movies) if (m.imdbId) byImdb.set(m.imdbId, m);
  for (const x of shows) if (x.imdbId) byImdb.set(x.imdbId, x);
  let listShows = 0;
  for (const w of list) {
    if (out.length >= limit) break;
    const t = (w.id && (filmById.get(w.id) || showById.get(w.id))) || (w.imdbId && byImdb.get(w.imdbId));
    if (!t) continue;
    if (t.type === "show") {
      if (trees.has(t.id) || listShows >= SHOWS) continue; // (in the middle of it: offered above)
      listShows++;
      const show = await treeOf(t.id);
      if (!show) continue;
      let n = 0;
      for (const { s, e } of aheadOf(show).rows) { if (n >= Math.min(2, perShow)) break; if (push(epRow(show, s, e, "My List"))) n++; }
    } else if (unfinished(t.id)) push(filmRow(t, "My List"));
  }

  // 3. films that are new on the server and not started — offered, the
  //    person ticks them (a trip is never filled with what nobody asked for)
  const fresh = movies
    .filter((m) => !progressFor(m.id))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .slice(0, 6);
  for (const m of fresh) {
    if (out.length >= limit) break;
    const row = filmRow(m, "New on Aurora");
    row.extra = true;
    push(row);
  }
  return out.slice(0, limit);
};

// As many, from the top, as fill `minutes` (the last one may run a little over).
export const plan = (rows, minutes) => {
  const out = [];
  let left = minutes * 60;
  for (const r of rows) {
    if (left <= 0) break;
    if (r.extra) continue;
    out.push(r);
    left -= r.secs;
  }
  return out;
};

// ---------- "Going somewhere?" ----------
const LENGTHS = [
  { key: "hour", label: "A commute", hint: "1 h", minutes: 60 },
  { key: "flight", label: "A flight", hint: "3 h", minutes: 180 },
  { key: "long", label: "A long flight", hint: "8 h", minutes: 480 },
  { key: "weekend", label: "A weekend", hint: "12 h", minutes: 720 },
];
const LEN_KEY = "aurora-offline-trip";
// "45 min", "1 h 52 min" — as "On this device" says it
const hours = (secs) => {
  const m = Math.max(1, Math.round(secs / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
};
let tripOpen = false;

export const openTrip = async () => {
  if (tripOpen) return;
  tripOpen = true;
  let done = false;
  let rows = null; // the candidates, when they are in
  const picked = new Set();
  let length = LENGTHS[1];
  try { length = LENGTHS.find((l) => l.key === localStorage.getItem(LEN_KEY)) || length; } catch {}

  const finish = () => {
    if (done) return;
    done = true;
    tripOpen = false;
    document.removeEventListener("ui-back", onBack);
    popScope(wrap);
    wrap.classList.add("leaving");
    setTimeout(() => wrap.remove(), 240);
  };
  const onBack = (e) => { e.preventDefault(); finish(); };

  const list = el("div", { class: "trip-list", role: "group", "aria-label": "What to pack" },
    el("p", { class: "trip-wait" }, "Looking at what you're watching…"));
  const total = el("p", { class: "trip-total", "aria-live": "polite" });
  const room = el("p", { class: "trip-room" });
  const go = el("button", { "data-ui": "saved.pack.go", class: "btn btn-primary focusable trip-go", disabled: true }, "Pack it");
  const close = el("button", { class: "btn focusable", onclick: () => finish() }, "Not now");
  const chips = LENGTHS.map((l) => el("button", {
    "data-ui": "saved.pack.length",
    class: "chip focusable trip-len" + (l === length ? " on" : ""),
    "aria-pressed": l === length ? "true" : "false",
    onclick: () => {
      length = l;
      try { localStorage.setItem(LEN_KEY, l.key); } catch {}
      chips.forEach((c, i) => { const on = LENGTHS[i] === l; c.classList.toggle("on", on); c.setAttribute("aria-pressed", on ? "true" : "false"); });
      fill();
    },
  }, el("span", {}, l.label), el("small", {}, l.hint)));

  let free = null;
  const sum = () => {
    const mine = (rows || []).filter((r) => picked.has(r.id));
    const secs = mine.reduce((n, r) => n + r.secs, 0);
    const known = mine.every((r) => r.bytes > 0);
    const bytes = mine.reduce((n, r) => n + r.bytes, 0);
    if (rows && !rows.length) { total.textContent = ""; room.textContent = ""; return; }
    total.textContent = !rows ? "" : !mine.length ? "Nothing ticked — tick what you want with you"
      : `${mine.length} ${mine.length === 1 ? "title" : "titles"} · ${hours(secs)} to watch${bytes ? ` · ${known ? "up to" : "more than"} ${fmtBytes(bytes)}` : ""}`;
    room.textContent = "";
    if (free != null) {
      room.append(el("span", { class: "offline-room-ic", html: deviceIcon }),
        bytes && bytes > free ? `Room on this device: ≈ ${fmtBytes(free)} — pick a smaller size on the next step` : `Room on this device: ≈ ${fmtBytes(free)} — you pick the size on the next step`);
      room.classList.toggle("tight", !!bytes && bytes > free);
    }
    go.disabled = !mine.length;
    go.textContent = !mine.length ? "Pack it" : mine.length === 1 ? "Pack 1 title" : `Pack ${mine.length} titles`;
  };
  // the proposal for the chosen length: ticked from the top until the time is filled
  const fill = () => {
    if (!rows) return;
    picked.clear();
    for (const r of plan(rows, length.minutes)) picked.add(r.id);
    for (const b of list.querySelectorAll(".trip-row")) { const on = picked.has(b.dataset.id); b.classList.toggle("on", on); b.setAttribute("aria-checked", on ? "true" : "false"); }
    sum();
  };
  const paintRows = () => {
    list.textContent = "";
    if (!rows.length) {
      list.append(el("p", { class: "trip-wait" }, state.noServer || navigator.onLine === false
        ? "Packing needs the server — it is out of reach right now."
        : "Nothing to pack right now — what you're watching is already here. Put films and shows on My List and they are offered here."));
      // nothing to choose: the sheet only says so
      card.classList.add("trip-none");
      go.remove();
      close.textContent = "Close";
      close.classList.add("btn-primary");
      return;
    }
    for (const r of rows) {
      const b = el("button", {
        class: "trip-row focusable", role: "checkbox", "aria-checked": "false", "data-id": r.id, "data-ui": "saved.pack.pick",
        "aria-label": `${r.name}${r.sub ? ` ${r.sub}` : ""}, ${r.why}, ${hours(r.secs)}`,
        onclick: () => {
          const on = !picked.has(r.id);
          if (on) picked.add(r.id); else picked.delete(r.id);
          b.classList.toggle("on", on);
          b.setAttribute("aria-checked", on ? "true" : "false");
          sum();
        },
      },
      el("span", { class: "trip-tick", "aria-hidden": "true" }),
      el("span", { class: "trip-poster" }, r.cover ? el("img", { src: r.cover, alt: "", loading: "lazy" }) : null),
      el("span", { class: "trip-words" },
        el("span", { class: "trip-name", dir: "auto" }, r.name, r.sub ? el("small", {}, r.sub) : null),
        el("span", { class: "trip-why" }, `${r.why} · ${hours(r.secs)}${r.bytes ? ` · ${fmtBytes(r.bytes)}` : ""}`)));
      list.append(b);
    }
  };

  go.onclick = () => {
    const mine = (rows || []).filter((r) => picked.has(r.id));
    if (!mine.length) return;
    finish();
    const n = mine.length;
    toast(n === 1 ? "Packing 1 title — one moment for the size" : `Packing ${n} titles — one moment for the size`, mark("preparing"), null, { quiet: true });
    saveSeveral(mine.map((r) => r.item), { sheetTitle: n === 1 ? "1 title for the trip" : `${n} titles for the trip`, patient: true })
      .then((k) => sayBatch(k, null, { noun: "title" }))
      .catch((e) => sayBatch((e && e.done) || 0, e, { noun: "title" }));
    if (!(location.hash || "").startsWith("#/saved")) location.hash = "#/saved";
  };

  const card = el("div", { class: "look-notice sheet trip-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Pack for a trip" },
    el("div", { class: "sheet-icon trip-icon", html: bagIcon }),
    el("div", { class: "look-notice-title" }, "Going somewhere?"),
    el("p", { class: "look-notice-text trip-lead" }, "Say how long, and Aurora packs this device from what you're watching and My List."),
    el("div", { class: "trip-lens", role: "group", "aria-label": "How long" }, chips),
    list,
    total,
    room,
    el("div", { class: "look-notice-actions trip-actions" },
      close,
      go));
  const wrap = el("div", { class: "look-notice-wrap ui-overlay trip-wrap", onclick: (e) => e.target === wrap && finish() }, card);
  document.addEventListener("ui-back", onBack);
  (document.fullscreenElement || document.body).append(wrap);
  pushScope(wrap);
  // (the keyboard starts on the length that is chosen, not on the first one)
  try { chips[LENGTHS.indexOf(length)].focus({ preventScroll: true }); } catch {}
  sum();

  offline.storageSummary().then((s) => { if (s && s.quota) { free = s.free; sum(); } }).catch(() => {});
  try { rows = await suggestions({ perShow: 12, limit: 36 }); } catch { rows = []; }
  if (done) return;
  paintRows();
  fill();
};

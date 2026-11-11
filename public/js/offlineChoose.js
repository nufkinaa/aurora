// "Choose episodes" — which episodes of a show go onto this device (elia, 2026-11-11: "save
// next 3 is confusing, why not just give the user the ability to choose which episodes to
// download?"). It replaces "Save the next 3" and "Save the season (N)".
//
//   chooseButton(getShow, opts)   the one button on a show's page (and under a show on
//                                 On this device): "Choose episodes"
//   openChooser(show, opts)       the sheet:
//     · the season switch (one chip a season), the season the next episode is in first
//     · one row an episode: a tick box, "E3", its name, its length, the size it will take
//         saved here          the mint mark, "Saved" — not tickable
//         being saved         the mark with its percent — not tickable
//         on the server       tickable
//         not on the server   tickable: "Saves here when it arrives" (a wish — offlineWish.js)
//         already wished      "Will be saved when it arrives" — not tickable
//     · the next unwatched episodes come ticked (the next 3); Select all / Clear
//     · the size, asked once for all of them (Original / 1080p / 720p / 480p)
//     · the running total ("4 episodes · ≈ 3.2 GB") and the room on this device
//     · one button: "Save 4 episodes" (Not now beside it)
//   Then the ones on the server are saved one after another at that size (saveSeveral) and the
//   others become wishes at that size. Nothing is ever removed by it.
//
// The phone app draws the same sheet natively (tv-native/src/phone/offline/ChooseSheet.tsx),
// same words. Values: docs/offline-look.md §6.
import { el, toast, fmtBytes, fmtDuration } from "./ui.js";
import { pushScope, popScope } from "./focus.js";
import { progressFor } from "./state.js";
import * as offline from "./offline.js";
import * as wishes from "./offlineWish.js";
import { mark, copyHere, whenIndexed, pctOf } from "./offlineUi.js";
import { saveSeveral, sayBatch } from "./offlineButtons.js";

// the server's own rates for a re-encoded copy (src/media/offline.js KBPS), video + sound
const KBPS = { 1080: 4328, 720: 2228, 480: 1078 };
export const SIZES = [
  { quality: "original", label: "Original" },
  { quality: "1080", label: "1080p" },
  { quality: "720", label: "720p" },
  { quality: "480", label: "480p" },
];
const PRETICK = 3;
const LAST_KEY = "aurora-offline-last";

// ---------- the rules (pure; test/ui/offline-choose.test.js reads them) ----------
// What one episode would take at a size: Original is the file itself (unknown before the
// server has it — then 1080p's rate stands in, estimated); the others by the running time.
export const sizeAt = (row, quality, fallbackSecs = 0) => {
  const secs = row.duration > 0 ? row.duration : fallbackSecs;
  if (quality === "original") {
    if (row.sizeBytes > 0) return { bytes: row.sizeBytes, estimated: false };
    return { bytes: secs ? Math.round((KBPS[1080] * 1000 / 8) * secs) : 0, estimated: true };
  }
  return { bytes: secs ? Math.round(((KBPS[quality] || KBPS[720]) * 1000 / 8) * secs) : 0, estimated: true };
};
// Where one episode stands on this device: saved | saving | wished | ready | later
//   ready: on the server, can be saved now · later: not on the server — a wish
export const standing = ({ here, job, wish, onServer }) =>
  here ? "saved" : job ? "saving" : wish ? "wished" : onServer ? "ready" : "later";
export const tickable = (st) => st === "ready" || st === "later";
// The ones ticked to begin with: from the next episode to watch, the next `n` that can be
// ticked and are not finished (episodes before it, and finished ones, are left alone).
export const preTicked = (rows, { from = null, n = PRETICK, finished = () => false } = {}) => {
  const start = from ? Math.max(0, rows.findIndex((r) => r.season === from.season && r.episode === from.episode)) : 0;
  const out = [];
  for (const r of rows.slice(start)) {
    if (out.length >= n) break;
    if (tickable(r.st) && !finished(r)) out.push(r.key);
  }
  return out;
};
// "4 episodes · ≈ 3.2 GB" (and "· 2 when they arrive")
export const totalLine = (picked, quality, fallbackSecs = 0) => {
  if (!picked.length) return "No episodes ticked";
  let bytes = 0, est = false;
  for (const r of picked) { const s = sizeAt(r, quality, fallbackSecs); bytes += s.bytes; est = est || s.estimated; }
  const later = picked.filter((r) => r.st === "later").length;
  return [`${picked.length} episode${picked.length === 1 ? "" : "s"}`, bytes ? `${est ? "≈ " : ""}${fmtBytes(bytes)}` : null, later ? `${later} when ${later === 1 ? "it arrives" : "they arrive"}` : null].filter(Boolean).join(" · ");
};
export const saveWords = (n) => (n ? `Save ${n} episode${n === 1 ? "" : "s"}` : "Save");
// The size to start on: the standing one, else the last one picked, else 720p.
const firstSize = () => {
  const pref = offline.preferredQuality();
  if (pref && pref !== "ask") return pref;
  try { const l = localStorage.getItem(LAST_KEY); if (l && SIZES.some((s) => s.quality === l)) return l; } catch {}
  return "720";
};

// ---------- the sheet ----------
// show: { title, id (library show id, or null), imdbId, poster,
//         seasons: [{ number, episodes: [{ season, episode, title, released, local }] }] }
// opts.from: { season, episode } — the next episode to watch (its season opens, it is ticked first)
export const openChooser = async (show, { from = null } = {}) => {
  if (!offline.available()) return;
  await whenIndexed();
  const seasons = (show.seasons || []).filter((s) => Number(s.number) > 0 && (s.episodes || []).length);
  if (!seasons.length) return void toast("No episodes to choose from yet", mark("none"));
  const today = new Date().toISOString().slice(0, 10);
  const localSecs = seasons.flatMap((s) => s.episodes).map((e) => (e.local && e.local.duration) || 0).filter((x) => x > 0).sort((a, b) => a - b);
  const typical = localSecs.length ? localSecs[Math.floor(localSecs.length / 2)] : 0;
  const finished = (r) => { if (!r.local) return false; const p = progressFor(r.local.id); return !!(p && (p.finished || (p.duration > 0 && p.position / p.duration > 0.95))); };
  const rowOf = (e) => {
    const local = e.local && e.local.id ? e.local : null;
    const j = local ? offline.jobFor(local.id) : null;
    const job = j && j.state !== "failed" ? j : null; // (on its way, or paused part-way: not ticked again)
    const w = !local && show.imdbId ? wishes.wishFor({ type: "show", imdbId: show.imdbId, season: e.season, episode: e.episode }) : null;
    const r = {
      key: `${e.season}x${e.episode}`, season: e.season, episode: e.episode,
      title: e.title || (local && local.title) || `Episode ${e.episode}`,
      duration: (local && local.duration) || 0, sizeBytes: (local && local.sizeBytes) || 0,
      aired: !e.released || String(e.released).slice(0, 10) <= today,
      local, job,
    };
    r.st = standing({ here: !!(local && copyHere(local.id)), job, wish: w && w.state !== "failed", onServer: !!local });
    return r;
  };
  const allRows = () => seasons.flatMap((s) => s.episodes.map(rowOf));
  const first = allRows();
  const start = from ? first.find((r) => r.season === from.season && r.episode === from.episode) : null;
  let season = start ? start.season : (seasons.find((s) => s.episodes.some((e) => !finished(rowOf(e)) && e.local)) || seasons[0]).number;
  const ticked = new Set(preTicked(first, { from: start || first.find((r) => r.season === season) || null, finished }));
  let quality = firstSize();
  let free = 0;

  return new Promise((resolve) => {
    let done = false;
    const finish = (go) => {
      if (done) return;
      done = true;
      document.removeEventListener("ui-back", onBack);
      popScope(wrap);
      wrap.classList.add("leaving");
      setTimeout(() => wrap.remove(), 240);
      resolve(go);
    };
    const onBack = (e) => { e.preventDefault(); finish(false); };

    const seasonBar = el("div", { class: "choose-seasons", role: "tablist", "aria-label": "Season" });
    const list = el("div", { class: "choose-list", role: "group", "aria-label": "Episodes" });
    const sizes = el("div", { class: "choose-sizes", role: "radiogroup", "aria-label": "Size" });
    const total = el("p", { class: "choose-total", "aria-live": "polite" });
    const room = el("p", { class: "choose-room" });
    const saveBtn = el("button", { class: "btn btn-primary focusable choose-save", "data-ui": "offline.choose.save" });

    const paint = () => {
      const rows = allRows();
      const inSeason = rows.filter((r) => r.season === season);
      // the season switch
      seasonBar.replaceChildren(...(seasons.length > 1 ? seasons.map((s) => {
        const n = rows.filter((r) => r.season === s.number && ticked.has(r.key)).length;
        return el("button", {
          class: `chip focusable choose-season${s.number === season ? " on" : ""}`, role: "tab", "aria-selected": s.number === season ? "true" : "false",
          "data-ui": "offline.choose.season", onclick: () => { season = s.number; paint(); },
        }, `Season ${s.number}`, n ? el("span", { class: "choose-season-n" }, ` · ${n}`) : null);
      }) : [el("span", { class: "choose-season-only" }, `Season ${season}`)]));
      // the rows
      list.replaceChildren(...inSeason.map((r) => {
        const can = tickable(r.st);
        const on = can && ticked.has(r.key);
        const s = sizeAt(r, quality, typical);
        const len = r.duration ? fmtDuration(r.duration) : null;
        const what = r.st === "saved" ? "Saved on this device"
          : r.st === "saving" ? (r.job.state === "paused" ? "Paused" : `Saving ${pctOf(r.job.pct)}%`)
            : r.st === "wished" ? "Will be saved when it arrives"
              : r.st === "later" ? (r.aired ? "Not on the server yet — saves here when it arrives" : "Not out yet — saves here when it arrives")
                : null;
        const box = el("span", { class: "choose-box", "aria-hidden": "true" }, on ? "✓" : "");
        const m = r.st === "saved" ? mark("saved", 0, "choose-mark") : r.st === "saving" ? mark(r.job.state === "paused" ? "paused" : "saving", r.job.pct || 0, "choose-mark") : r.st === "wished" ? mark("waiting", 0, "choose-mark") : null;
        const node = el(can ? "button" : "div", {
          class: `choose-row${can ? " focusable" : " fixed"}${on ? " on" : ""}`, "data-st": r.st, "data-key": r.key,
          ...(can ? { role: "checkbox", "aria-checked": on ? "true" : "false", "data-ui": "offline.choose.pick", onclick: () => { if (ticked.has(r.key)) ticked.delete(r.key); else ticked.add(r.key); paint(); } } : {}),
          "aria-label": `Episode ${r.episode}, ${r.title}${what ? `, ${what}` : ""}`,
        },
          can ? box : el("span", { class: "choose-box-slot" }, m),
          el("span", { class: "choose-main" },
            el("span", { class: "choose-name" }, el("b", {}, `E${r.episode}`), " ", el("span", { dir: "auto" }, r.title)),
            el("span", { class: "choose-meta" }, [len, can && s.bytes ? `${s.estimated ? "≈ " : ""}${fmtBytes(s.bytes)}` : null].filter(Boolean).join(" · ")),
            what ? el("span", { class: `choose-what st-${r.st}` }, what) : null));
        return node;
      }));
      // the size chips
      sizes.replaceChildren(el("span", { class: "choose-sizes-label" }, "Size"), ...SIZES.map((z) => el("button", {
        class: `chip focusable choose-size${z.quality === quality ? " on" : ""}`, role: "radio", "aria-checked": z.quality === quality ? "true" : "false",
        "data-ui": "offline.choose.size", onclick: () => { quality = z.quality; paint(); },
      }, z.label)));
      // the total, the room, the button
      const picked = rows.filter((r) => ticked.has(r.key) && tickable(r.st));
      total.textContent = totalLine(picked, quality, typical);
      let bytes = 0;
      for (const r of picked) bytes += sizeAt(r, quality, typical).bytes;
      room.textContent = free ? `Room on this device: ≈ ${fmtBytes(free)}${bytes > free ? " — not enough for all of these" : ""}` : "";
      room.classList.toggle("tight", !!free && bytes > free);
      saveBtn.textContent = saveWords(picked.length);
      saveBtn.disabled = !picked.length;
    };
    const selectAll = el("button", { class: "btn small focusable", "data-ui": "offline.choose.all", onclick: () => { for (const r of allRows()) if (r.season === season && tickable(r.st)) ticked.add(r.key); paint(); } }, "Select all");
    const clear = el("button", { class: "btn small focusable", "data-ui": "offline.choose.clear", onclick: () => { for (const r of allRows()) if (r.season === season) ticked.delete(r.key); paint(); } }, "Clear");
    saveBtn.onclick = () => {
      const picked = allRows().filter((r) => ticked.has(r.key) && tickable(r.st));
      if (!picked.length) return;
      try { localStorage.setItem(LAST_KEY, quality); } catch {}
      finish(true);
      run(show, picked, quality);
    };
    const card = el("div", { class: "look-notice sheet offline-sheet choose-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Choose episodes" },
      el("div", { class: "look-notice-title" }, "Choose episodes"),
      el("p", { class: "look-notice-text choose-lead" }, `“${show.title}” — tick the ones to save on this device. They play with no connection.`),
      seasonBar,
      el("div", { class: "choose-tools" }, selectAll, clear),
      list,
      sizes,
      total,
      room,
      el("div", { class: "look-notice-actions offline-sheet-actions" },
        el("button", { class: "btn focusable", "data-ui": "offline.choose.cancel", onclick: () => finish(false) }, "Not now"),
        saveBtn));
    const wrap = el("div", { class: "look-notice-wrap ui-overlay", onclick: (e) => e.target === wrap && finish(false) }, card);
    document.addEventListener("ui-back", onBack);
    (document.fullscreenElement || document.body).append(wrap);
    pushScope(wrap);
    paint();
    offline.storageSummary().then((s) => { if (s && s.quota) { free = s.free; if (!done) paint(); } }).catch(() => {});
    setTimeout(() => (list.querySelector(".choose-row.on") || list.querySelector("button.choose-row") || saveBtn).focus({ preventScroll: false }), 60);
  });
};

// What a press on Save does: the ones on the server are saved one after another at the size
// chosen; the others become wishes at that size (saved here by themselves when they arrive).
const run = async (show, picked, quality) => {
  const now = picked.filter((r) => r.st === "ready");
  const later = picked.filter((r) => r.st === "later");
  let wished = 0;
  for (const r of later) {
    try {
      await wishes.addWish({ type: "show", imdbId: show.imdbId, season: r.season, episode: r.episode, title: r.title, showTitle: show.title, poster: show.poster || undefined }, quality);
      wished++;
    } catch {}
  }
  const of = ` of “${show.title}”`;
  if (wished) toast(`${wished} episode${wished === 1 ? "" : "s"}${of} will be saved to this device when ${wished === 1 ? "it arrives" : "they arrive"}`, mark("waiting"));
  if (!now.length) return;
  toast(`Saving ${now.length} episode${now.length === 1 ? "" : "s"}${of} to this device`, mark("saving", 0.1), { label: "Open", onClick: () => { location.hash = "#/saved"; } });
  const items = now.map((r) => ({ ...r.local, showTitle: show.title, showId: show.id || r.local.showId || null, season: r.season, episode: r.episode, title: r.title }));
  try {
    const done = await saveSeveral(items, { quality, sheetTitle: `${items.length} episodes${of}` });
    sayBatch(done, null, { of });
  } catch (e) {
    sayBatch((e && e.done) || 0, e, { of });
  }
};

// ---------- the button ----------
// getShow() → the show as openChooser takes it (asked at the press: the page may have more by
// then); opts.from() → the next episode to watch.
export const chooseButton = (getShow, { from = () => null, ui = null, small = false } = {}) => {
  if (!offline.available()) return null;
  const btn = el("button", {
    "data-ui": ui || "detail.offline.choose",
    class: `btn focusable btn-offline btn-dev btn-dev-choose${small ? " small" : ""}`,
    title: "Pick the episodes to save on this device — to watch with no connection",
    "aria-label": "Choose episodes to save on this device",
  }, el("span", { class: "dev-ic" }, mark("none", 0, "btn-dev-mark")), el("span", { class: "btn-dev-word" }, "Choose episodes"), el("span", { class: "btn-label" }, "Choose episodes"));
  btn.onclick = async () => {
    btn.disabled = true;
    try { const s = await getShow(); if (s) await openChooser(s, { from: from() }); }
    finally { btn.disabled = false; }
  };
  return btn;
};

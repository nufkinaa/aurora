// Peek sheet: hold (or right-click) any card and the title opens as a small
// sheet right there — art, what it is, how much is left, the synopsis — with
// Play, Details and My List one press away. Nothing navigates until you say
// so; Back, the backdrop or ✕ close it and you're exactly where you were.
//
// Cards wire it with `attachPeek(node, item, opts)`; the sheet itself is
// `openPeek(item, opts)` so a keyboard/remote path can open it too.
import { el, icons, toast, formatRow, posterImg, fmtDuration } from "./ui.js";
import { state, progressFor } from "./state.js";
import { api } from "./api.js";
import { navigate } from "./router.js";
import { pushScope, popScope } from "./focus.js";

const HOLD_MS = 480;
const MOVE_PX = 10;

let openNode = null;
let returnTo = null; // the card that was focused, for remotes

const closePeek = () => {
  if (!openNode) return;
  const node = openNode;
  openNode = null;
  document.removeEventListener("ui-back", node._onBack);
  popScope(node);
  node.classList.add("leaving");
  setTimeout(() => node.remove(), 220);
  if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true });
  returnTo = null;
};

// What the sheet says under the title: "2023 · Film", "S1 E3 · Show".
const subline = (item) => {
  const isEpisode = !!item.showId && item.type !== "show";
  if (isEpisode) return [item.showTitle, `S${item.season} E${item.episode}`].filter(Boolean).join(" · ");
  const kind = item.type === "show" ? "Series" : item.type === "movie" ? "Film" : null;
  return [item.year, kind, item.duration ? fmtDuration(item.duration) : null].filter(Boolean).join(" · ");
};

// The synopsis, from the item if it carries one, else fetched (library:
// the item — or its show for an episode; stream: the Discover metadata).
const synopsisFor = async (item) => {
  if (item.synopsis) return item.synopsis;
  try {
    if (item.source === "stream" && item.imdbId) {
      const m = await api.discoverMeta(item.type === "show" ? "show" : "movie", item.imdbId);
      return (m && (m.synopsis || m.overview || m.description)) || "";
    }
    const id = item.showId && item.type !== "show" ? item.showId : item.id;
    if (!id || String(id).startsWith("torrent|")) return "";
    const it = await api.item(id);
    return (it && it.synopsis) || "";
  } catch {
    return "";
  }
};

export const openPeek = (item, { open = null, onRemove = null } = {}) => {
  if (!item || openNode) return;
  const isEpisode = !!item.showId && item.type !== "show";
  // Only what the player can take by id: an episode or film on disk, or a
  // torrent play-item. A Discover title has no id — Open leads to its
  // page, where a source is picked.
  const playable = isEpisode || String(item.id || "").startsWith("torrent|") || (item.type === "movie" && item.source !== "stream" && !!item.id);
  const prog = progressFor(item.id) || (item.imdbId && state.streamProgress && state.streamProgress[item.imdbId]) || null;
  const pct = prog && prog.duration > 0 && !prog.finished ? Math.min(100, (prog.position / prog.duration) * 100) : null;
  const left = pct !== null ? `${Math.max(1, Math.round((prog.duration - prog.position) / 60))} min left` : null;

  const go = (fn) => () => { closePeek(); fn(); };
  const play = go(() => {
    if (String(item.id).startsWith("torrent|")) state.pendingItems[item.id] = item;
    navigate(`#/play/${encodeURIComponent(item.id)}`);
  });
  // Details on an episode means its show, not another way to play it.
  const details = go(() => (isEpisode && item.showId ? navigate(`#/show/${item.showId}`) : open ? open(item) : null));

  // My List: library items go by id, streamable ones by a stored ref (the
  // same shapes the detail pages send).
  const listBtn = el("button", { class: "btn focusable" });
  let inList = false;
  const paintList = () => {
    listBtn.innerHTML = (inList ? icons.check : icons.plus) + `<span>${inList ? "In My List" : "My List"}</span>`;
  };
  paintList();
  const listable = state.profile && !isEpisode && (item.imdbId || (item.id && !String(item.id).startsWith("torrent|")));
  if (listable) {
    api.watchlist(state.profile.id)
      .then(({ items }) => { inList = items.some((x) => x.id === item.id || (item.imdbId && x.imdbId === item.imdbId)); paintList(); })
      .catch(() => {});
  }
  listBtn.onclick = async () => {
    if (!listable) return;
    inList = !inList;
    paintList();
    try {
      const ref = item.source === "stream"
        ? { imdbId: item.imdbId, type: item.type === "show" ? "show" : "movie", title: item.title, poster: item.cover || null, year: item.year || null, genres: item.genres || [], rating: item.rating || null }
        : item.id;
      await api.toggleWatchlist(state.profile.id, ref, inList);
      toast(inList ? `“${item.title}” saved for later` : "Off the list. Bold.", inList ? "➕" : "➖");
    } catch {}
  };

  const synopsis = el("p", { class: "peek-synopsis skeleton-text" }, " ");
  synopsisFor(item).then((text) => {
    synopsis.classList.remove("skeleton-text");
    synopsis.textContent = text || "";
    synopsis.classList.toggle("hidden", !text);
  });

  const art = item.backdrop || item.cover;
  const sheet = el(
    "div",
    { class: "peek", role: "dialog", "aria-modal": "true", "aria-label": item.title },
    el("div", { class: "peek-art" + (item.backdrop ? "" : " poster") },
      art ? posterImg(art, item.title, "peek-img", "card-fallback") : el("div", { class: "card-fallback" }, item.title),
      el("div", { class: "peek-art-fade" }),
      el("button", { class: "btn btn-icon focusable peek-close", "aria-label": "Close", html: "✕", onclick: closePeek }),
    ),
    el("div", { class: "peek-body" },
      el("div", { class: "peek-title" }, item.title),
      el("div", { class: "peek-sub" }, subline(item), formatRow(item, { max: 4 })),
      pct !== null && el("div", { class: "peek-progress" }, el("div", { class: "peek-bar" }, el("i", { style: { width: pct + "%" } })), el("span", {}, left)),
      synopsis,
      el("div", { class: "peek-actions" },
        playable && el("button", { class: "btn btn-primary focusable", html: icons.play + `<span>${pct !== null ? "Resume" : "Play"}</span>`, onclick: play }),
        open && el("button", { class: "btn focusable", html: `<span>${playable ? "Details" : "Open"}</span>`, onclick: details }),
        listable && listBtn,
        onRemove && el("button", { class: "btn focusable peek-remove", html: "<span>Remove from Continue Watching</span>", onclick: go(() => onRemove(item)) }),
      ),
    ),
  );
  const wrap = el("div", { class: "peek-wrap ui-overlay", onclick: (e) => e.target === wrap && closePeek() }, sheet);
  wrap._onBack = (e) => { e.preventDefault(); closePeek(); };
  document.addEventListener("ui-back", wrap._onBack);
  returnTo = document.activeElement;
  (document.fullscreenElement || document.body).append(wrap);
  openNode = wrap;
  pushScope(wrap);
  // the primary action, not the ✕, is where a remote should land
  (sheet.querySelector(".peek-actions .btn-primary") || sheet.querySelector(".peek-actions .btn"))?.focus({ preventScroll: true });
  try { if (navigator.vibrate) navigator.vibrate(12); } catch {}
};

// Hold to peek (touch and mouse alike), right-click to peek. A hold that
// fires swallows the click that would follow it, so the card never opens.
export const attachPeek = (node, item, opts = {}) => {
  let timer = null;
  let sx = 0, sy = 0;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  node.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    fired = false;
    sx = e.clientX; sy = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      openPeek(item, opts);
    }, HOLD_MS);
  });
  node.addEventListener("pointermove", (e) => {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > MOVE_PX) cancel();
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) node.addEventListener(ev, cancel);
  node.addEventListener("click", (e) => {
    if (!fired) return;
    fired = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  node.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cancel();
    openPeek(item, opts);
  });
};

// Instant search: typo-tolerant suggestions as you type, then full results.
import { el, icons, debounce } from "../ui.js";
import { api } from "../api.js";
import { state, loadLibrary } from "../state.js";
import { navigate } from "../router.js";
import { card } from "../components.js";
import { attachSuggest, suggestHref } from "../suggest.js";

const recents = {
  get: () => {
    try {
      return JSON.parse(localStorage.getItem("aurora-recent-searches") || "[]");
    } catch {
      return [];
    }
  },
  add: (q) => {
    const list = recents.get().filter((x) => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    localStorage.setItem("aurora-recent-searches", JSON.stringify(list.slice(0, 8)));
  },
};

export const renderSearch = async (root) => {
  const results = el("div", { class: "grid" });
  const status = el("div", { class: "empty hidden" });
  const recentHost = el("div", { class: "filter-bar", style: { paddingTop: 0 } });
  const suggestHost = el("div", { class: "suggest-list hidden" });

  const input = el("input", {
    type: "text",
    placeholder: "Search movies and shows…",
    class: "focusable",
    "aria-label": "Search",
  });

  // ---------- instant suggestions ----------
  // Shared dropdown (suggest.js) — same one the Movies/Shows pages use.
  // Rows are plain focusable buttons in a width-filling grid; the D-pad
  // walks them geometrically. Picking one remembers the TITLE as a recent.
  attachSuggest(input, suggestHost, {
    onPick: (s) => {
      recents.add(s.title);
      const href = suggestHref(s);
      if (href) navigate(href);
    },
  });

  const paintRecents = () => {
    recentHost.innerHTML = "";
    const list = recents.get();
    if (list.length === 0 || input.value.trim()) return;
    recentHost.append(
      el("span", { style: { color: "var(--text-faint)", fontSize: "0.85rem", fontWeight: "700" } }, "Recent:"),
      ...list.map((q) =>
        el("button", { class: "chip focusable", onclick: () => { input.value = q; run(); } }, q)
      )
    );
  };

  let saveTimer = null;
  const run = debounce(async () => {
    const q = input.value.trim();
    paintRecents();
    if (!q) {
      results.innerHTML = "";
      status.classList.add("hidden");
      return;
    }
    // Library + streamable catalog in parallel (the same union the Movies/
    // Shows tabs search). Library hits render as soon as they arrive; stream
    // hits append when the slower catalog lookup lands. The catalog fetch is
    // gated to 3+ chars — a cold Cinemeta lookup costs 400-900ms and used to
    // fire on every debounced prefix.
    const discP =
      q.length >= 3 ? api.discoverSearch(q).catch(() => null) : Promise.resolve(null);
    // resolved instantly after the first load; on a cold visit this closes
    // the race between the library fetch and the first result paint
    await loadLibrary().catch(() => {});
    let local = [];
    try {
      ({ results: local } = await api.search(q));
    } catch {}
    if (input.value.trim() !== q) return; // superseded by newer keystrokes
    results.innerHTML = "";
    status.classList.add("hidden");
    results.append(...local.map((i) => card(i)));

    const data = await discP;
    if (input.value.trim() !== q) return;
    const localIds = new Set(local.map((i) => i.id));
    const localTitles = new Set(local.map((i) => (i.title || "").toLowerCase()));
    const libPool = state.library
      ? [...(state.library.movies || []), ...(state.library.shows || [])]
      : [];
    const libById = new Map(libPool.map((i) => [i.id, i]));
    const stream = [];
    let rescued = 0;
    for (const m of [...((data && data.movies) || []), ...((data && data.shows) || [])]) {
      if (!m.imdbId) continue;
      if (m.inLibrary) {
        // The catalog rescued a title the library search missed (typo, odd
        // folder name). SHOW THE OWNED COPY — the old filter dropped these
        // entirely, so a typo'd search found nothing for a movie on disk.
        if (localIds.has(m.inLibrary)) continue; // already shown
        const lib = libById.get(m.inLibrary);
        if (lib) {
          localIds.add(lib.id);
          rescued++;
          results.append(card({ ...lib, imdbId: m.imdbId }));
          continue;
        }
        // The server says owned but the CLIENT's library snapshot doesn't
        // know the id (loaded before a recent download, or still loading).
        // Fall through to the stream card — the Discover page re-detects
        // ownership server-side — rather than dropping the title entirely.
      }
      if (localTitles.has((m.title || "").toLowerCase())) continue;
      stream.push({ ...m, source: "stream", cover: m.poster || m.cover || null });
    }
    results.append(...stream.map((i) => card(i)));

    if (local.length === 0 && stream.length === 0 && rescued === 0) {
      status.innerHTML = `<div class="glyph">🔍</div>No results for “${q.replace(/</g, "&lt;")}”`;
      status.classList.remove("hidden");
    } else {
      // remember searches that found something (after a settle delay)
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (input.value.trim() === q) recents.add(q);
      }, 1600);
    }
  }, 180);

  input.addEventListener("input", () => run());

  const screen = el("div", { class: "screen" },
    el("div", { class: "search-wrap" },
      el("div", { class: "search-box", html: icons.search })
    ),
    suggestHost,
    recentHost,
    results,
    status
  );
  screen.querySelector(".search-box").append(input);
  root.append(screen);

  paintRecents();
  setTimeout(() => input.focus(), 60);
  // The owned-copy rescue reads state.library — load it now (cheap, cached
  // server-side) so a cold visit straight to Search isn't blind to the
  // library. Without this, an owned title could render as a STREAM card.
  loadLibrary().catch(() => {});
};

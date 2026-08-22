// Instant search with recent-search chips.
import { el, icons, debounce } from "../ui.js";
import { api } from "../api.js";
import { card } from "../components.js";

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

  const input = el("input", {
    type: "text",
    placeholder: "Search movies and shows…",
    class: "focusable",
    "aria-label": "Search",
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
    // hits append when the slower catalog lookup lands.
    const discP = api.discoverSearch(q).catch(() => null);
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
    const localTitles = new Set(local.map((i) => (i.title || "").toLowerCase()));
    const stream = [...((data && data.movies) || []), ...((data && data.shows) || [])]
      .filter((m) => m.imdbId && !m.inLibrary && !localTitles.has((m.title || "").toLowerCase()))
      .map((m) => ({ ...m, source: "stream", cover: m.poster || m.cover || null }));
    results.append(...stream.map((i) => card(i)));

    if (local.length === 0 && stream.length === 0) {
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

  input.addEventListener("input", run);

  const screen = el("div", { class: "screen" },
    el("div", { class: "search-wrap" },
      el("div", { class: "search-box", html: icons.search })
    ),
    recentHost,
    results,
    status
  );
  screen.querySelector(".search-box").append(input);
  root.append(screen);

  paintRecents();
  setTimeout(() => input.focus(), 60);
};

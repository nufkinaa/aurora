// Instant search: typo-tolerant suggestions as you type, then full results.
//
// Three sources, shown as each lands so the screen is never blank while it
// works: the library (fast, fuzzy), the cached streamable catalogue (fast,
// fuzzy — see /api/search's `catalog`), and the live catalogue lookup
// (slower; itself forgiving of typos). A "Searching…" line stands in while
// nothing has arrived yet, and the keyboard's Search key runs the query at
// once instead of waiting out the typing pause.
import { el, icons, debounce, restoreScrollY } from "../ui.js";
import { api } from "../api.js";
import { track } from "../usage.js";
import { state, loadLibrary } from "../state.js";
import { navigate } from "../router.js";
import { card } from "../components.js";
import { attachSuggest, suggestHref } from "../suggest.js";

// Session-lived: coming BACK to Search restores the query, its results and
// the scroll offset — it used to start blank every time.
let searchMemory = null;

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
    try {
      localStorage.setItem("aurora-recent-searches", JSON.stringify(list.slice(0, 8)));
    } catch {}
  },
};

// The live catalogue lookup is gated to this many characters while TYPING —
// a cold lookup costs 400-900ms upstream and used to fire on every prefix.
// Pressing Search runs it at any length ("Up", "It", "Us" are real titles).
const CATALOG_MIN = 3;

const touch = () => matchMedia("(hover: none)").matches;

export const renderSearch = async (root) => {
  const results = el("div", { class: "grid" });
  const status = el("div", { class: "empty hidden" });
  // "Searching…" / "Searching the catalogue…" — under whatever is already
  // on screen, so the local hits never wait for the slow lookup.
  const busy = el("div", { class: "search-busy hidden", role: "status", "aria-live": "polite" },
    el("span", { class: "mini-spinner" }),
    el("span", { class: "search-busy-text" }, "Searching…"));
  const recentHost = el("div", { class: "filter-bar", style: { paddingTop: 0 } });
  const suggestHost = el("div", { class: "suggest-list hidden" });

  const input = el("input", {
    type: "search",
    inputmode: "search",
    enterkeyhint: "search", // the phone keyboard's action key says Search
    autocomplete: "off",
    autocorrect: "off", // the search is forgiving on its own; iOS "fixing" a title is not
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "Search movies and shows…",
    class: "focusable",
    "aria-label": "Search",
  });
  const clearBtn = el("button", {
    class: "search-clear focusable hidden",
    type: "button",
    "aria-label": "Clear search",
    html: "✕",
    onclick: () => {
      input.value = "";
      run.cancel();
      search("");
      input.focus({ preventScroll: true });
    },
  });
  const paintClear = () => clearBtn.classList.toggle("hidden", !input.value);

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
        el("button", { class: "chip focusable", onclick: () => { input.value = q; paintClear(); run.cancel(); search(q, { committed: true }); } }, q)
      )
    );
  };

  // The busy line waits a beat before showing: the library answers in a few
  // ms, and a spinner that flashes for one frame reads as flicker.
  let busyTimer = null;
  const setBusy = (text) => {
    busy.querySelector(".search-busy-text").textContent = text;
    if (!busy.classList.contains("hidden")) return;
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => busy.classList.remove("hidden"), 220);
  };
  const clearBusy = () => {
    clearTimeout(busyTimer);
    busy.classList.add("hidden");
  };

  const noResults = (q, { committed, catalogFailed, retry }) => {
    status.innerHTML = "";
    if (catalogFailed) {
      status.append(
        el("div", { class: "glyph" }, "📡"),
        `Couldn't reach the catalogue for “${q}”.`,
        el("div", { style: { marginTop: "14px" } },
          el("button", { class: "btn small focusable", onclick: retry }, "Try again")));
    } else if (!committed && q.length < CATALOG_MIN) {
      status.append(
        el("div", { class: "glyph" }, "🔍"),
        `Nothing in the library for “${q}”.`,
        el("div", { class: "search-hint" }, "Keep typing, or press Search to look through the catalogue too."));
    } else {
      status.append(
        el("div", { class: "glyph" }, "🔍"),
        `No results for “${q}”`,
        el("div", { style: { marginTop: "14px" } },
          // Movies opens on its "All" shelf — what's trending, with the
          // library up front (the old Requests page is no longer in the nav)
          el("a", { class: "btn small focusable", href: "#/movies" }, "Browse what's trending")));
    }
    status.classList.remove("hidden");
  };

  let seq = 0;
  let saveTimer = null;
  // `committed`: the person pressed Search (Enter, the keyboard's action key,
  // a recent) — run everything now, whatever the length.
  const search = async (q, { committed = false } = {}) => {
    const my = ++seq;
    const live = () => my === seq && screen.isConnected;
    paintClear();
    paintRecents();
    if (!q) {
      results.innerHTML = "";
      status.classList.add("hidden");
      clearBusy();
      return;
    }
    status.classList.add("hidden");
    setBusy("Searching…");
    const wantCatalog = committed || q.length >= CATALOG_MIN;
    // Library + streamable catalogue in parallel (the same union the Movies/
    // Shows tabs search). Library hits render as soon as they arrive; the
    // slower live lookup appends when it lands.
    const discP = wantCatalog
      ? api.discoverSearch(q).catch(() => ({ failed: true }))
      : Promise.resolve(null);
    // resolved instantly after the first load; on a cold visit this closes
    // the race between the library fetch and the first result paint
    await loadLibrary().catch(() => {});
    let local = [];
    let cached = [];
    try {
      const r = await api.search(q);
      local = r.results || [];
      cached = r.catalog || [];
    } catch {}
    if (!live()) return;

    results.innerHTML = "";
    const shownIds = new Set();
    const shownImdb = new Set();
    const shownTitles = new Set();
    const libPool = state.library
      ? [...(state.library.movies || []), ...(state.library.shows || [])]
      : [];
    const libById = new Map(libPool.map((i) => [i.id, i]));
    // Twins are matched by kind AND title: a film and a series that share a
    // name ("The Gentlemen") are two different things and both get a card.
    const titleKey = (i) => `${i.type === "show" ? "show" : "movie"}|${(i.title || "").toLowerCase()}`;
    const addLocal = (i) => {
      if (shownIds.has(i.id)) return;
      shownIds.add(i.id);
      if (i.imdbId) shownImdb.add(i.imdbId);
      shownTitles.add(titleKey(i));
      results.append(card(i));
    };
    // A catalogue hit that the library owns shows the OWNED copy. The old
    // filter dropped these entirely, so a typo'd search found nothing for a
    // movie on disk.
    const addStream = (m) => {
      if (!m.imdbId || shownImdb.has(m.imdbId)) return;
      if (m.inLibrary) {
        if (shownIds.has(m.inLibrary)) return; // already shown
        const lib = libById.get(m.inLibrary);
        if (lib) return addLocal({ ...lib, imdbId: m.imdbId });
        // The server says owned but the CLIENT's library snapshot doesn't
        // know the id (loaded before a recent download, or still loading).
        // Fall through to the stream card — the title page re-detects
        // ownership server-side — rather than dropping the title entirely.
      }
      if (shownTitles.has(titleKey(m))) return;
      shownImdb.add(m.imdbId);
      shownTitles.add(titleKey(m));
      results.append(card({ ...m, source: "stream", cover: m.poster || m.cover || null }));
    };
    local.forEach(addLocal);
    cached.forEach(addStream); // typo-tolerant, from memory — no wait
    track("feat", { f: "search", hits: local.length }); // how often, never what

    const any = () => results.childElementCount > 0;
    if (wantCatalog) setBusy(any() ? "Searching the catalogue…" : "Searching…");
    else clearBusy();

    const data = await discP;
    if (!live()) return;
    clearBusy();
    const failed = !!(data && data.failed);
    if (data && !failed) {
      for (const m of [...(data.movies || []), ...(data.shows || [])]) addStream(m);
    }

    if (!any()) {
      noResults(q, {
        committed,
        catalogFailed: failed,
        retry: () => search(q, { committed: true }),
      });
    } else {
      // The catalogue didn't answer but the library did: say so quietly
      // rather than letting the shorter list pass for the whole answer.
      if (failed) {
        status.innerHTML = "";
        status.append(el("div", { class: "search-hint" }, "The catalogue didn't answer — these are from the library. ",
          el("button", { class: "btn small focusable", onclick: () => search(q, { committed: true }) }, "Try again")));
        status.classList.remove("hidden");
      }
      // remember searches that found something — at once when you pressed
      // Search, after a settle delay while you're still typing
      clearTimeout(saveTimer);
      if (committed) recents.add(q);
      else saveTimer = setTimeout(() => {
        if (input.value.trim() === q) recents.add(q);
      }, 1200);
    }
  };
  const run = debounce(() => search(input.value.trim()), 180);

  input.addEventListener("input", () => {
    paintClear();
    run();
  });
  // Enter / the keyboard's Search key: don't wait out the typing pause —
  // the query runs NOW, catalogue included. On a phone the keyboard drops
  // too, so the results have the screen (a typed-fast-then-tapped Search
  // used to land on a blank page while the debounce and the lookup caught
  // up, and the keyboard sat over what little there was).
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    run.cancel();
    search(input.value.trim(), { committed: true });
    if (touch()) input.blur();
  });
  // type=search has a native "clear" (✕) event in some browsers
  input.addEventListener("search", () => {
    if (!input.value) {
      run.cancel();
      search("");
    }
  });

  const screen = el("div", { class: "screen" },
    el("div", { class: "search-wrap" },
      el("div", { class: "search-box", html: icons.search })
    ),
    suggestHost,
    recentHost,
    results,
    busy,
    status
  );
  screen.querySelector(".search-box").append(input, clearBtn);
  root.append(screen);

  paintRecents();
  // The owned-copy rescue reads state.library — load it now (cheap, cached
  // server-side) so a cold visit straight to Search isn't blind to the
  // library. Without this, an owned title could render as a STREAM card.
  loadLibrary().catch(() => {});

  let stopRestore = () => {};
  if (searchMemory && searchMemory.q) {
    input.value = searchMemory.q;
    paintClear();
    search(searchMemory.q, { committed: true });
    stopRestore = restoreScrollY(searchMemory.scrollY);
  } else {
    setTimeout(() => input.focus(), 60);
  }
  return () => {
    searchMemory = {
      q: input.value.trim(),
      scrollY: window.scrollY || document.body.scrollTop || 0,
    };
    clearTimeout(busyTimer);
    clearTimeout(saveTimer);
    stopRestore();
  };
};

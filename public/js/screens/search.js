// Search: one ranked answer from the server (/api/search v2 — library,
// cached catalogue and live catalogue scored together, the title you named
// first), then a "More like …" tail of related titles under a row heading.
//
// Two steps so the screen is never blank while the catalogue is asked: the
// first call answers from memory at once and says whether more is coming
// (`pending`); the second waits for the catalogue and the related row. The
// card that was first stays first unless something matches better, cards
// already on screen are kept (moved, never rebuilt), and a reply for a query
// that is no longer in the box is dropped — its request is cancelled.
import { el, icons, debounce, restoreScrollY } from "../ui.js";
import { api } from "../api.js";
import { track } from "../usage.js";
import { tmStart, tmLap } from "../telemetry.js"; // [analytics]
import { state, loadLibrary } from "../state.js";
import { navigate } from "../router.js";
import { onMessage } from "../ws.js";
import { card } from "../components.js";
import { attachSuggest, suggestHref } from "../suggest.js";

// Session-lived: coming BACK to Search restores the query, its results and
// the scroll offset — it used to start blank every time.
let searchMemory = null;
// The next profile does not come back to the last one's search (2026-10-08).
// The memory is stamped with whose it is: the Search page that was open under
// the profile wall writes it again when the router leaves it — after the switch.
const whose = () =>
  state.profile ? `${state.profile.id}${state.profile.kids ? `~k${state.profile.kids.maxAge}` : ""}` : "";
window.addEventListener("aurora-profile", (e) => {
  if (e.detail && e.detail.relist) searchMemory = null;
});

// Recent searches are PER PROFILE and kept ON THE SERVER, so a person's phone,
// laptop and TV show the same list (they used to live in each browser, and
// before 2026-10-08 in one list per device that a child could read). The
// browser keeps a copy only to paint at once; a list from before the move is
// handed to the server the first time, then never read again. The old shared
// list is still offered to a grown-up's profile that has none — never to a
// kids profile.
const RECENT_KEY = "aurora-recent-searches";
const pid = () => (state.profile && state.profile.id) || "";
const recentKey = () => (pid() ? `${RECENT_KEY}:${pid()}` : RECENT_KEY);
const readLocal = () => {
  try {
    const own = localStorage.getItem(recentKey());
    if (own != null) return JSON.parse(own) || [];
    if (state.profile && state.profile.kids) return [];
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
};
const writeLocal = (list) => {
  try { localStorage.setItem(recentKey(), JSON.stringify(list.slice(0, 12))); } catch {}
};
const recents = {
  get: () => readLocal(),
  // the server's list; a browser's older one moves up once
  load: async () => {
    if (!pid()) return readLocal();
    const local = readLocal();
    let { items } = await api.recentSearches(pid());
    let moved = false;
    try { moved = localStorage.getItem(`${recentKey()}:moved`) === "1"; } catch {}
    if (!moved) {
      if (!items.length && local.length) {
        for (const q of [...local].reverse()) {
          try { ({ items } = await api.addRecentSearch(pid(), q)); } catch {}
        }
      }
      try { localStorage.setItem(`${recentKey()}:moved`, "1"); } catch {}
    }
    writeLocal(items);
    return items;
  },
  add: (q) => {
    if (!q || q.length < 2) return;
    const list = readLocal().filter((x) => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    writeLocal(list);
    if (pid()) api.addRecentSearch(pid(), q).then(({ items }) => writeLocal(items)).catch(() => {});
  },
  remove: (q) => {
    writeLocal(readLocal().filter((x) => x.toLowerCase() !== q.toLowerCase()));
    if (pid()) api.removeRecentSearch(pid(), q).catch(() => {});
  },
  clear: () => {
    writeLocal([]);
    if (pid()) api.removeRecentSearch(pid(), null).catch(() => {});
  },
};

// While TYPING the server asks the live catalogue from 3 characters (a cold
// lookup costs 400-900ms upstream); pressing Search asks at any length
// ("Up", "It", "Us" are real titles). The no-result message says which.
const CATALOG_MIN = 3;

const touch = () => matchMedia("(hover: none)").matches;

// #/search/<words> (an X-Ray cast card links there): open Search on them.
export const presetSearch = (q) => {
  if (q && q.trim()) searchMemory = { q: q.trim().slice(0, 80), scrollY: 0, owner: whose() };
};

export const renderSearch = async (root) => {
  const owner = whose(); // whoever this page was opened for
  const results = el("div", { class: "grid" });
  // the related tail: its own heading and grid, under the matches
  const relatedTitle = el("h2", { class: "row-title" });
  const relatedGrid = el("div", { class: "grid" });
  const relatedHost = el("div", { class: "search-related hidden" }, relatedTitle, relatedGrid);
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
  const clearBtn = el("button", { "data-ui": "search.clear",
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
    // a person or a genre: search for it
    onQuery: (text) => {
      input.value = text;
      paintClear();
      run.cancel();
      search(text, { committed: true });
    },
  });

  // An empty box is not an empty screen: under the recent searches sits what
  // this household has been watching lately — one tap from something to watch.
  const popularHost = el("div", { class: "search-popular hidden" });
  let popularAsked = false;
  // `want()`: is the shelf still wanted when its answer lands? (an empty box,
  // or a search that found nothing — a dead end otherwise)
  let popularWanted = () => !input.value.trim();
  const paintPopular = async (want = () => !input.value.trim()) => {
    popularWanted = want;
    if (!want()) return;
    if (popularHost.childElementCount) return popularHost.classList.remove("hidden");
    if (popularAsked) return;
    popularAsked = true;
    try {
      const { items } = await api.popular(state.profile && state.profile.id);
      if (!items || !items.length || !screen.isConnected) return;
      popularHost.append(
        el("h2", { class: "row-title", style: { padding: "0 var(--page-x)", margin: "18px 0 10px" } }, "Popular in this house"),
        el("div", { class: "grid" }, items.map((it) => card(it))),
      );
      if (popularWanted()) popularHost.classList.remove("hidden");
    } catch {}
  };

  const paintRecents = () => {
    recentHost.innerHTML = "";
    const list = recents.get();
    if (list.length === 0 || input.value.trim()) return;
    recentHost.append(
      el("span", { style: { color: "var(--text-faint)", fontSize: "0.85rem", fontWeight: "700" } }, "Recent:"),
      ...list.map((q) =>
        el("span", { class: "recent-chip" },
          el("button", { class: "chip focusable", onclick: () => { input.value = q; paintClear(); run.cancel(); search(q, { committed: true }); } }, q),
          el("button", {
            class: "recent-x focusable",
            type: "button",
            "aria-label": `Remove ${q} from recent searches`,
            html: "✕",
            onclick: () => { recents.remove(q); paintRecents(); },
          }))
      ),
      el("button", { class: "recent-clear focusable", type: "button", onclick: () => { recents.clear(); paintRecents(); } }, "Clear"),
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
          el("button", { "data-ui": "search.retry", class: "btn small focusable", onclick: retry }, "Try again")));
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
  let ctrl = null; // the request(s) of the search on screen; a newer search aborts them
  // Cards by the server's key: an answer that re-orders or adds to what is on
  // screen moves the existing nodes instead of rebuilding them (no flash, and
  // a focused card keeps its focus).
  let nodes = new Map();
  const cardFor = (it, next) => {
    const key = `${it.key}|${it.meta || ""}`;
    const node = nodes.get(key) || card(it);
    next.set(key, node);
    return node;
  };
  const paint = (r) => {
    const next = new Map();
    results.replaceChildren(...(r.results || []).map((it) => cardFor(it, next)));
    const related = r.related || [];
    relatedGrid.replaceChildren(...related.map((it) => cardFor(it, next)));
    relatedTitle.textContent = r.relatedLabel || "";
    relatedHost.classList.toggle("hidden", !related.length);
    nodes = next;
  };
  const clearGrid = () => {
    nodes = new Map();
    results.innerHTML = "";
    relatedGrid.innerHTML = "";
    relatedHost.classList.add("hidden");
  };
  // `committed`: the person pressed Search (Enter, the keyboard's action key,
  // a recent, a person or genre suggestion) — the catalogue is asked whatever
  // the length.
  const search = async (q, { committed = false } = {}) => {
    const my = ++seq;
    const live = () => my === seq && screen.isConnected;
    if (ctrl) ctrl.abort();
    ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const signal = ctrl ? ctrl.signal : undefined;
    paintClear();
    paintRecents();
    if (!q) {
      clearGrid();
      status.classList.add("hidden");
      clearBusy();
      paintPopular();
      return;
    }
    status.classList.add("hidden");
    setBusy("Searching…");
    tmStart("search"); // [analytics] query sent → results shown (the time only; never the text)
    const profileId = pid();
    let r = null;
    let failed = false;
    try {
      r = await api.searchAll(q, { commit: committed, profileId, signal });
    } catch {
      failed = true;
    }
    if (!live()) return;
    if (r) {
      popularHost.classList.add("hidden");
      paint(r);
      tmLap("search_results", "search", "library"); // [analytics]
      track("feat", { f: "search", hits: (r.results || []).filter((x) => x.source !== "stream").length }); // how often, never what
    }
    const any = () => results.childElementCount > 0 || relatedGrid.childElementCount > 0;
    if (r && r.pending) {
      setBusy(any() ? "Searching the catalogue…" : "Searching…");
      try {
        const pin = r.results && r.results[0] ? r.results[0].key : null;
        r = await api.searchAll(q, { wait: true, commit: committed, pin, profileId, signal });
        if (!live()) return;
        paint(r);
        tmLap("search_results", "search", "catalogue"); // [analytics]
      } catch {
        if (!live()) return;
        failed = true;
      }
    }
    clearBusy();
    failed = failed || !!(r && r.catalogFailed);

    if (results.childElementCount === 0) {
      if (!r) clearGrid();
      noResults(q, {
        committed,
        catalogFailed: failed,
        retry: () => search(q, { committed: true }),
      });
      // not a dead end: what the house is watching sits under the message
      // (unless a related row — a person's or a genre's titles — is there)
      if (relatedGrid.childElementCount === 0) paintPopular(() => input.value.trim() === q && results.childElementCount === 0);
    } else {
      popularHost.classList.add("hidden");
      // The catalogue didn't answer but the library did: say so quietly
      // rather than letting the shorter list pass for the whole answer.
      if (failed) {
        status.innerHTML = "";
        status.append(el("div", { class: "search-hint" }, "The catalogue didn't answer — these are from the library. ",
          el("button", { "data-ui": "search.retry", class: "btn small focusable", onclick: () => search(q, { committed: true }) }, "Try again")));
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
    relatedHost,
    busy,
    status,
    popularHost
  );
  screen.querySelector(".search-box").append(input, clearBtn);
  root.append(screen);

  paintRecents();
  // the server's list (this browser's copy painted first)
  recents.load().then(() => { if (screen.isConnected) paintRecents(); }).catch(() => {});
  // A download that lands while results are up: the card turns into the
  // library's copy without searching again by hand (2026-10-07).
  const unsubLib = onMessage("library_updated", async () => {
    if (!input.isConnected) return unsubLib();
    try { await loadLibrary(true); } catch { return; }
    nodes = new Map(); // a stream card may now be the library's copy: rebuild
    const q = input.value.trim();
    if (q && input.isConnected) search(q);
  });

  let stopRestore = () => {};
  if (searchMemory && searchMemory.owner !== whose()) searchMemory = null; // somebody else's
  if (searchMemory && searchMemory.q) {
    input.value = searchMemory.q;
    paintClear();
    search(searchMemory.q, { committed: true });
    stopRestore = restoreScrollY(searchMemory.scrollY);
  } else {
    setTimeout(() => input.focus(), 60);
    paintPopular();
  }
  return () => {
    searchMemory = {
      q: input.value.trim(),
      scrollY: window.scrollY || document.body.scrollTop || 0,
      owner,
    };
    clearTimeout(busyTimer);
    clearTimeout(saveTimer);
    if (ctrl) ctrl.abort();
    stopRestore();
  };
};

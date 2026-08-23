// Browse grids. Movies/Shows unify your downloaded library with streamable
// (Discover) titles — one grid, with categories, a genre picker, sort, and a
// search that spans both. My List is the same grid under filters of its own,
// because what you want from a saved list is not what you want from a catalogue.
import { el, icons, toast, appendProgressive, debounce } from "../ui.js";
import { loadLibrary, state, watchState, refreshProgress } from "../state.js";
import { api } from "../api.js";
import { card } from "../components.js";
import { deviceDownloadedAt } from "../downloadPicker.js";
import { pushScope, popScope } from "../focus.js";
import { attachSuggest } from "../suggest.js";

import * as narrator from "../narrator.js";
// Imported as `dice`: `surprise` is already a destructured option name in
// browseScreen below, and it would shadow the module inside it.
import * as dice from "../surprise.js";

const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "");

const chip = (label, isActive, onclick) =>
  el("button", { class: `chip focusable ${isActive ? "on" : ""}`, onclick }, label);

// ---------- My List ----------
//
// The page where how far you got with each title IS the point: a list you keep
// adding to is only useful if you can ask it "what haven't I started", "what did
// I leave half-watched", "what did I pull onto this laptop last week".
//
// No `cmp` means "leave the order alone" — the server returns the watchlist
// newest-addition-first, which is the sensible default for a list. `mark` resolves
// an item's watch state and is passed in rather than called directly because it
// is memoised per list (see myListScreen): resolving a series walks its whole
// episode tree, which is not something to redo on every comparison.
const LIST_SORTS = [
  { id: "listed", label: "Recently listed" },
  { id: "title", label: "A – Z", cmp: () => byTitle },
  { id: "watched", label: "Last watched", cmp: (mark) => (a, b) => mark(b).at - mark(a).at },
  { id: "device", label: "Saved to device", cmp: () => (a, b) => deviceDownloadedAt(b) - deviceDownloadedAt(a) },
  { id: "added", label: "Added to server", cmp: () => (a, b) => (b.addedAt || 0) - (a.addedAt || 0) },
  { id: "year", label: "Newest", cmp: () => (a, b) => (b.year || 0) - (a.year || 0) },
  { id: "rating", label: "Top rated", cmp: () => (a, b) => (b.rating || 0) - (a.rating || 0) },
  { id: "duration", label: "Longest", cmp: () => (a, b) => (b.duration || 0) - (a.duration || 0) },
];

// One chip at a time within a group; clicking the lit one clears it. Which chips
// appear is decided by the list itself — see myListScreen.
const LIST_FILTERS = [
  { group: "status", id: "unwatched", label: "Unwatched", keep: (i, m) => !m.started },
  { group: "status", id: "started", label: "In progress", keep: (i, m) => m.started && !m.finished },
  { group: "status", id: "watched", label: "Watched", keep: (i, m) => m.finished },
  { group: "kind", id: "movie", label: "Films", keep: (i) => i.type !== "show" },
  { group: "kind", id: "show", label: "Series", keep: (i) => i.type === "show" },
  { group: "where", id: "owned", label: "Downloaded", keep: (i) => i.source !== "stream" },
  { group: "where", id: "stream", label: "Streamable", keep: (i) => i.source === "stream" },
];

const NOT_WATCHED = { started: false, finished: false, at: 0 };

const myListScreen = (items) => {
  const screen = el("div", { class: "screen" });
  const marks = new Map(items.map((item) => [item, watchState(item)]));
  const mark = (item) => marks.get(item) || NOT_WATCHED;

  const genres = [...new Set(items.flatMap((i) => i.genres || []))].sort();
  // A chip that can only ever empty the grid is a trap, and a group with one
  // live chip is not a choice — so an all-streamable list offers no Downloaded
  // toggle, and a list of films says nothing about Series.
  const live = LIST_FILTERS.filter((f) => items.some((i) => f.keep(i, mark(i))));
  const chipDefs = live.filter((f) => live.filter((o) => o.group === f.group).length > 1);

  const picked = {}; // group -> chip id
  let genre = "";
  let sortId = "listed";

  const gridHost = el("div", { class: "grid" });
  const count = el("span", { class: "count" });
  let cancelAppend = null;

  const applyFilters = () => {
    let shown = items;
    if (genre) shown = shown.filter((i) => (i.genres || []).includes(genre));
    for (const f of chipDefs) {
      if (picked[f.group] === f.id) shown = shown.filter((i) => f.keep(i, mark(i)));
    }
    const sort = LIST_SORTS.find((s) => s.id === sortId);
    if (sort.cmp) shown = [...shown].sort(sort.cmp(mark));

    count.textContent =
      shown.length === items.length
        ? `${items.length} title${items.length > 1 ? "s" : ""}`
        : `${shown.length} of ${items.length}`;
    if (cancelAppend) cancelAppend();
    gridHost.innerHTML = "";
    if (shown.length === 0) {
      gridHost.append(
        el("div", { class: "empty", style: { gridColumn: "1/-1" } }, "Nothing matches. Try fewer filters?"),
      );
      return;
    }
    cancelAppend = appendProgressive(gridHost, shown.map((i) => card(i)), 24, 12);
  };

  const face = (btn, label, value, isSet) => {
    btn.innerHTML = "";
    btn.classList.toggle("set", isSet);
    btn.append(
      el("span", { class: "picker-label" }, label),
      el("span", { class: "picker-value" }, value),
      el("span", { class: "picker-caret" }, "▾"),
    );
  };

  const genreBtn = el("button", {
    class: "picker-btn focusable",
    onclick: () =>
      dropdown(
        genreBtn,
        [{ label: "All genres", value: "" }, ...genres.map((g) => ({ label: g, value: g }))],
        genre,
        (v) => { genre = v; paint(); applyFilters(); },
      ),
  });
  const sortBtn = el("button", {
    class: "picker-btn focusable",
    onclick: () =>
      dropdown(sortBtn, LIST_SORTS.map((s) => ({ label: s.label, value: s.id })), sortId,
        (v) => { sortId = v; paint(); applyFilters(); }),
  });
  const chipEls = chipDefs.map((f) =>
    chip(f.label, false, () => {
      picked[f.group] = picked[f.group] === f.id ? null : f.id;
      paint();
      applyFilters();
    }),
  );

  const paint = () => {
    face(genreBtn, "Genre", genre || "All", !!genre);
    face(sortBtn, "Sort", LIST_SORTS.find((s) => s.id === sortId).label, sortId !== "listed");
    chipEls.forEach((c, at) => c.classList.toggle("on", picked[chipDefs[at].group] === chipDefs[at].id));
  };

  screen.append(el("div", { class: "browse-head" }, el("h1", {}, "My List"), count));
  if (items.length === 0) {
    screen.append(
      el("div", { class: "empty" },
        el("div", { class: "glyph" }, "🍿"),
        "My List is empty. Hit + on anything that catches your eye."),
    );
    return screen;
  }

  const tools = el("div", { class: "filter-bar tools" });
  if (genres.length > 0) tools.append(genreBtn);
  tools.append(sortBtn);
  screen.append(tools);
  if (chipEls.length > 0) {
    // Hairline between groups: seven chips in an even row read as seven
    // unrelated toggles rather than three either/or choices.
    const chipBar = el("div", { class: "filter-bar tools" });
    chipDefs.forEach((f, at) => {
      if (at > 0 && chipDefs[at - 1].group !== f.group) chipBar.append(el("span", { class: "chip-sep" }));
      chipBar.append(chipEls[at]);
    });
    screen.append(chipBar);
  }
  paint();
  screen.append(gridHost);
  applyFilters();
  return screen;
};

// ---------- unified browse (Movies / Shows) ----------
//
// Rebuilt around /api/catalog. What was wrong before, and what replaced it:
//
//   * ONE ROW OF ~30 CHIPS (source + every genre + unwatched + four sorts) was
//     the entire filter UI, and it wrapped into a wall three lines deep. Now:
//     six category pills, a genre dropdown and one toggle.
//   * FILTERS ONLY SAW WHAT WAS LOADED. The page fetched a fixed ~200 trending
//     titles and filtered them in the browser, so picking Western left you with
//     three films. Genre is part of the request now, so every genre has a deep
//     catalog of its own.
//   * "LOAD MORE" REVEALED, IT DIDN'T FETCH — and it rebuilt the whole grid, so
//     the page jumped to the top and every poster reloaded. It fetches the next
//     page and APPENDS; nothing already on screen is touched.
//   * COMING BACK FROM A TITLE RESTARTED THE PAGE. Filters, the pages already
//     fetched and the scroll offset are remembered per route (see viewState).
const normStream = (item) => ({ ...item, source: "stream", cover: item.poster || item.cover || null });

// Categories. "Downloaded" is your own library, filtered locally; the rest are
// server catalogs that page. "All" leads with what you own and then keeps going
// into what's streamable, which is what browsing usually means — so the library
// on its own sits at the end, where you go looking for it deliberately.
const CATEGORIES = [
  { id: "all", label: "All", catalog: "trending", withLocal: true },
  { id: "trending", label: "Trending", catalog: "trending" },
  { id: "new", label: "New", catalog: "new" },
  { id: "top", label: "Top rated", catalog: "top" },
  { id: "recommended", label: "For you", catalog: "trending", taste: true },
  { id: "downloaded", label: "Downloaded", local: true },
];

// Per-route memory, so going into a title and pressing Back lands you exactly
// where you were: same category, same genre, same fetched pages, same scroll
// offset. Session-lived on purpose — a reload starts clean.
const viewState = new Map();

// The genre dropdown: ~20 options, exactly the list that used to be sprayed
// across the filter bar, behind one button.
//
// Fixed-positioned and parented to <body> rather than nested under the button,
// because the filter strip scrolls horizontally on a phone — a panel inside it
// would be clipped by that overflow. Same focus scope + Back handling as the
// app's modals, so a remote can walk it and Back closes it.
const dropdown = (anchor, options, current, onPick) => {
  const close = () => {
    document.removeEventListener("ui-back", onBack);
    window.removeEventListener("resize", close);
    popScope(panel);
    panel.remove();
    veil.remove();
    if (anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  const onBack = (e) => { e.preventDefault(); close(); };
  const panel = el("div", { class: "dropdown" },
    ...options.map((o) => el("button", {
      class: `dropdown-item focusable ${o.value === current ? "on" : ""}`,
      onclick: () => { close(); if (o.value !== current) onPick(o.value); },
    }, o.label)));
  // Catches the click (or wheel) that means "never mind".
  const veil = el("div", { class: "dropdown-veil", onclick: close, onwheel: close });
  document.body.append(veil, panel);

  const r = anchor.getBoundingClientRect();
  const width = Math.max(r.width, 200);
  panel.style.width = `${width}px`;
  panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 12))}px`;
  // Open upwards when there isn't room below — a 20-item list near the bottom
  // of a phone screen would otherwise hang off the end. Clamped either way, so
  // the panel is always on screen whatever the anchor is doing.
  const h = panel.offsetHeight;
  const below = r.bottom + 6;
  const above = r.top - 6 - h;
  const top = below + h > window.innerHeight - 8 && above >= 8 ? above : below;
  panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;

  document.addEventListener("ui-back", onBack);
  window.addEventListener("resize", close);
  pushScope(panel);
  const active = panel.querySelector(".dropdown-item.on");
  if (active) active.focus({ preventScroll: true });
  if (active) active.scrollIntoView({ block: "nearest" });
};

const browseScreen = (title, type, localItems, { surprise = false, restore = null } = {}) => {
  const screen = el("div", { class: "screen" });
  const tagged = localItems.map((i) => ({ ...i, source: "downloaded" }));
  const localTitles = new Set(tagged.map((i) => (i.title || "").toLowerCase()));
  const freshStream = (arr) =>
    (arr || [])
      .filter((m) => m.imdbId && !m.inLibrary && !localTitles.has((m.title || "").toLowerCase()))
      .map(normStream);

  // Everything a returning visitor needs to see the page they left.
  const st = {
    category: "all",
    genre: "",          // "" = every genre
    unwatched: false,
    query: "",
    fetched: [],        // stream items fetched so far, in catalog order
    page: -1,           // highest page fetched (-1 = none yet)
    hasMore: true,
    scrollY: 0,
    ...(restore || {}),
  };
  let searchResults = null;
  let loading = false;
  let genreList = [];

  const gridHost = el("div", { class: "grid" });
  const moreHost = el("div", { class: "load-more-host" });
  const rendered = new Set();   // keys already on screen, so appends never duplicate
  let pending = [];             // in-flight appendProgressive cancels
  let placeholders = false;     // grid currently holds shimmer / the empty note

  const cat = () => CATEGORIES.find((c) => c.id === st.category) || CATEGORIES[0];
  const key = (i) => i.id || i.imdbId || i.title;

  // What "For you" is built from: the genres you picked in Preferences if you
  // picked any, otherwise the ones your own library leans on. Most people never
  // open Preferences, and a shelf that quietly falls back to plain trending is
  // a dead pill — what you already chose to download says plenty.
  const tasteGenres = () => {
    const stated = state.likedGenres || [];
    if (stated.length) return stated.slice(0, 6);
    const tally = new Map();
    for (const i of tagged) for (const g of i.genres || []) tally.set(g, (tally.get(g) || 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g);
  };

  // ---------- what to show ----------
  const localPool = () => {
    let items = tagged;
    if (st.query) {
      const q = st.query.toLowerCase();
      items = items.filter((i) => (i.title || "").toLowerCase().includes(q));
    }
    if (st.genre) items = items.filter((i) => (i.genres || []).includes(st.genre));
    if (st.unwatched) items = items.filter((i) => !watchState(i).finished);
    // Alphabetical, always. A sort control here was one more thing to read for a
    // list you can already see all of.
    return [...items].sort(byTitle);
  };

  const streamPool = () => {
    if (st.query) return (searchResults && searchResults.stream) || [];
    if (cat().local) return [];
    // Catalog order IS the ranking the category promises, so it is never
    // re-sorted here — only filtered.
    return st.unwatched ? st.fetched.filter((i) => !watchState(i).finished) : st.fetched;
  };

  const visible = () => {
    const c = cat();
    const local = st.query || c.local || c.withLocal ? localPool() : [];
    return [...local, ...streamPool()];
  };

  // ---------- rendering ----------
  const skeletons = (n) =>
    Array.from({ length: n }, () => el("div", { class: "skeleton grid-skel" }));

  // Appends only what isn't on screen yet. This is the fix for "load more feels
  // wrong": the grid is never rebuilt, so posters don't reload and the page
  // stays exactly where the reader left it.
  const paint = ({ reset = false } = {}) => {
    if (reset) {
      for (const cancel of pending) cancel();
      pending = [];
      gridHost.innerHTML = "";
      rendered.clear();
      placeholders = false;
    }
    const items = visible();

    if (!items.length) {
      gridHost.innerHTML = "";
      rendered.clear();
      placeholders = true;
      // Skeletons are real grid children, so the shimmer lands in the exact
      // shape (and count) of the posters about to replace it.
      if (loading) gridHost.append(...skeletons(18));
      else gridHost.append(el("div", { class: "empty", style: { gridColumn: "1/-1" } },
        st.query ? "Nothing by that name." :
        st.genre ? `Nothing in ${st.genre} here. Try another genre?` :
        "Nothing matches. Try fewer filters?"));
    } else {
      // The shimmer (or the empty note) is the only thing ever swept away here;
      // real cards are left alone, which is what keeps the scroll position.
      if (placeholders) {
        gridHost.innerHTML = "";
        rendered.clear();
        placeholders = false;
      }
      const fresh = items.filter((i) => !rendered.has(key(i)));
      for (const i of fresh) rendered.add(key(i));
      if (fresh.length) pending.push(appendProgressive(gridHost, fresh.map((i) => card(i)), 24, 12));
    }
    paintCount(items.length);
    paintMore();
  };

  const countEl = el("span", { class: "count" });
  const paintCount = (total) => {
    const c = cat();
    if (st.query) { countEl.textContent = `${total} result${total === 1 ? "" : "s"}`; return; }
    if (c.local) { countEl.textContent = `${total} downloaded`; return; }
    const owned = c.withLocal ? localPool().length : 0;
    const streamable = total - owned;
    countEl.textContent =
      (owned ? `${owned} downloaded · ` : "") +
      `${streamable} to stream${st.hasMore ? " · more available" : ""}`;
  };

  // ONE button node for the life of the screen, relabelled in place. Replacing
  // it would throw away the focus the viewer just pressed it with, which on a
  // remote means being dumped back to the nav on every page.
  const moreBtn = el("button", { class: "btn focusable load-more", onclick: () => loadNext() });
  const paintMore = () => {
    // Local lists and search results are already complete — nothing to page.
    if (cat().local || st.query || (!st.hasMore && !loading)) {
      moreBtn.remove();
      return;
    }
    moreBtn.innerHTML = "";
    moreBtn.classList.toggle("busy", loading);
    if (loading) moreBtn.append(el("span", { class: "mini-spinner" }));
    moreBtn.append(el("span", {}, loading ? "Loading…" : "Load more"));
    if (!moreBtn.isConnected) moreHost.append(moreBtn);
  };

  // ---------- fetching ----------
  const loadNext = async () => {
    const c = cat();
    if (loading || c.local || st.query || !st.hasMore) return;
    loading = true;
    paint();
    // "For you" walks your taste one genre per page, so page 2 isn't more of
    // the same shelf.
    const taste = c.taste ? tasteGenres() : [];
    const next = st.page + 1;
    const genre = st.genre || (taste.length ? taste[next % taste.length] : null);
    try {
      const res = await api.catalog({ type, category: c.catalog, genre, page: next });
      st.page = next;
      st.hasMore = !!res.hasMore;
      const seen = new Set(st.fetched.map((i) => i.imdbId));
      st.fetched = [...st.fetched, ...freshStream(res.items).filter((i) => !seen.has(i.imdbId))];
    } catch {
      st.hasMore = false;
      toast("Couldn't reach the catalog", "⚠️");
    }
    loading = false;
    paint();
  };

  // Switching category or genre throws the fetched pages away — they answered
  // the old question — and starts again at page 0.
  const reload = () => {
    st.fetched = [];
    st.page = -1;
    st.hasMore = true;
    paint({ reset: true });
    loadNext();
  };

  // ---------- controls ----------
  //
  // Every control here is built ONCE and then only relabelled. Re-creating a
  // node that currently has focus silently blurs it, and on a remote that means
  // being thrown back to the nav every time you change a filter — so the
  // paint* helpers below mutate, they never rebuild.
  const catRow = el("div", { class: "cat-row" });
  const catPills = CATEGORIES.map((c) =>
    el("button", {
      class: "cat-pill focusable",
      onclick: () => {
        if (st.category === c.id) return;
        st.category = c.id;
        paintCats();
        paintTools();
        if (cat().local) paint({ reset: true });
        else reload();
      },
    }, c.label));
  catRow.append(...catPills);
  const paintCats = () => {
    catPills.forEach((p, i) => p.classList.toggle("on", CATEGORIES[i].id === st.category));
  };

  const tools = el("div", { class: "filter-bar tools" });
  const genreBtn = el("button", {
    class: "picker-btn focusable",
    onclick: () => dropdown(genreBtn,
      [{ label: "All genres", value: "" }, ...genreList.map((g) => ({ label: g, value: g }))],
      st.genre,
      (v) => {
        st.genre = v;
        paintTools();
        if (cat().local) paint({ reset: true });
        else reload();
      }),
  });
  const unwatchedBtn = el("button", {
    class: "chip focusable",
    onclick: () => {
      st.unwatched = !st.unwatched;
      paintTools();
      paint({ reset: true });
    },
  }, "Unwatched");
  // "For you" is the one shelf whose reasoning isn't self-evident, so it says
  // what it drew on.
  const noteEl = el("span", { class: "tool-note" });
  tools.append(genreBtn, unwatchedBtn, noteEl);

  const paintTools = () => {
    const c = cat();
    genreBtn.innerHTML = "";
    genreBtn.classList.toggle("set", !!st.genre);
    genreBtn.append(
      el("span", { class: "picker-label" }, "Genre"),
      el("span", { class: "picker-value" }, st.genre || "All"),
      el("span", { class: "picker-caret" }, "▾")
    );
    unwatchedBtn.classList.toggle("on", st.unwatched);
    const taste = c.taste && !st.genre ? tasteGenres().slice(0, 3) : [];
    noteEl.textContent = taste.length ? `from your ${taste.join(", ")}` : "";
    // Hidden rather than merely empty, or its flex gap leaves a phantom notch.
    noteEl.classList.toggle("hidden", !taste.length);
  };

  // ---------- search ----------
  const input = el("input", {
    type: "text", class: "focusable", value: st.query,
    placeholder: `Search ${title.toLowerCase()}…`, "aria-label": `Search ${title}`,
  });
  const search = async (q) => {
    st.query = q;
    if (!q) {
      searchResults = null;
      paint({ reset: true });
      if (!cat().local && !st.fetched.length) loadNext();
      return;
    }
    searchResults = { stream: [] };
    paint({ reset: true });                 // local hits land immediately
    try {
      const data = await api.discoverSearch(q);
      if (st.query !== q) return;           // superseded by a later keystroke
      searchResults.stream = freshStream(type === "show" ? data.shows : data.movies);
      paint({ reset: true });
    } catch {}
  };
  input.addEventListener("input", debounce(() => search(input.value.trim()), 300));

  // ---------- head ----------
  const head = el("div", { class: "browse-head" }, el("h1", {}, title), countEl);
  if (surprise) {
    head.append(el("button", {
      class: "btn small focusable",
      style: { marginLeft: "auto" },
      html: "🎲 <span>Surprise me</span>",
      // Downloaded AND streamable titles are all fair game. The roll itself
      // lives in surprise.js, so the page it lands on can offer another one.
      onclick: () => dice.roll([...tagged, ...st.fetched], type),
    }));
  }

  const searchWrap = el("div", { class: "search-wrap", style: { padding: "6px var(--page-x) 4px" } },
    el("div", { class: "search-box", html: icons.search }));
  searchWrap.querySelector(".search-box").append(input);

  // Same instant-suggestions dropdown as the Search screen, filtered to this
  // page's kind — typing here suggests only movies on Movies, shows on Shows.
  const suggestHost = el("div", { class: "suggest-list hidden" });
  attachSuggest(input, suggestHost, { type });

  screen.append(head, searchWrap, suggestHost, catRow, tools, gridHost, moreHost);
  paintCats();
  paintTools();

  // Genres come from the catalog's own manifest, so the picker can never offer
  // one that comes back empty.
  api.catalogGenres(type).then(({ genres }) => {
    genreList = genres || [];
    paintTools();
  }).catch(() => {});

  if (st.query) search(st.query);
  else if (st.fetched.length || cat().local) paint({ reset: true });
  else reload();

  // The router scrolls to the top before every render, and the grid fills in
  // over several frames, so a restored offset has to be re-applied until the
  // page is tall enough to hold it. Any real scroll input wins immediately, and
  // so does leaving the page — otherwise a half-finished restore would still be
  // yanking the NEXT screen around.
  const ABORT_ON = ["wheel", "touchstart", "keydown"];
  let stopRestore = () => {};
  const restoreScroll = (y) => {
    if (!y) return;
    let tries = 0;
    let stop = false;
    const give = () => {
      stop = true;
      for (const ev of ABORT_ON) window.removeEventListener(ev, give, true);
    };
    for (const ev of ABORT_ON) window.addEventListener(ev, give, true);
    stopRestore = give;
    const tick = () => {
      if (stop) return;
      window.scrollTo(0, y);
      document.body.scrollTop = y;
      const at = window.scrollY || document.body.scrollTop || 0;
      if (Math.abs(at - y) > 4 && tries++ < 40) setTimeout(tick, 50);
      else give();
    };
    setTimeout(tick, 0);
  };
  restoreScroll(st.scrollY);

  return {
    screen,
    // Called by the route's cleanup, on the way out to a detail page.
    snapshot: () => ({ ...st, scrollY: window.scrollY || document.body.scrollTop || 0 }),
    dispose: () => stopRestore(),
  };
};

// Both grids remember their view for the session: leave for a title, come back
// to the same filters, the same fetched pages and the same scroll position.
const browseRoute = (title, type, pick) => async (root) => {
  const lib = await loadLibrary();
  const view = browseScreen(title, type, pick(lib), { surprise: true, restore: viewState.get(type) });
  root.append(view.screen);
  // Snapshot before dispose: the router calls this while the page is still
  // scrolled where the viewer left it.
  return () => {
    viewState.set(type, view.snapshot());
    view.dispose();
  };
};

export const renderMovies = browseRoute("Movies", "movie", (lib) => lib.movies);
export const renderShows = browseRoute("Shows", "show", (lib) => lib.shows);

export const renderMyList = async (root) => {
  let items = [];
  if (state.profile) {
    // Progress is re-read rather than trusted: every filter and half the sorts on
    // this page turn on it, and the viewer has usually just come back from
    // watching something.
    const [, list] = await Promise.all([
      refreshProgress().catch(() => {}),
      api.watchlist(state.profile.id).catch(() => ({})),
    ]);
    items = list.items || [];
  }
  root.append(myListScreen(items));
  // A list that only ever grows deserves a word about it.
  try {
    const started = items.filter((i) => watchState(i).started).length;
    narrator.call("onListGraveyard", items.length, started);
  } catch {}
};

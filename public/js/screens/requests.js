// Discover: browse trending or search the whole catalogue, then open a title
// on its own full-page detail screen (#/discover/:type/:id) to stream it.
// Personal use, private network.
import { el, icons, debounce } from "../ui.js";
import { navigate } from "../router.js";
import { api } from "../api.js";
import { attachRowArrows } from "../rowArrows.js";

// Cache trending + searches for the session so navigating back is instant
const cache = { trending: null, searches: new Map() };

// Warm a title's metadata + sources when its card is focused, so opening the
// detail page feels instant. Deduped so we prefetch each title only once.
const prefetched = new Set();
const prefetch = (item) => {
  const type = item.type === "show" ? "series" : "movie";
  const id = item.imdbId || item.id;
  if (!id || prefetched.has(id)) return;
  prefetched.add(id);
  api.discoverMeta(type, id).catch(() => {});
  if (type === "movie") api.torrentSources({ type, title: id, year: item.year }).catch(() => {});
};

const discoverCard = (item) =>
  el("button", {
    class: "card poster focusable",
    "aria-label": item.title,
    onfocus: () => prefetch(item),
    onmouseenter: () => prefetch(item),
    onclick: () => navigate(`#/discover/${item.type === "show" ? "series" : "movie"}/${item.imdbId || item.id}`),
  },
    item.poster
      ? el("img", { class: "card-poster", src: item.poster, loading: "lazy", decoding: "async", alt: "" })
      : el("div", { class: "card-fallback" }, item.title),
    el("div", { class: "card-shade" }),
    item.inLibrary && el("span", { class: "disc-tag have" }, "IN LIBRARY"),
    el("div", { class: "card-label" },
      el("span", { class: "card-sub" }, item.year || (item.type === "show" ? "Series" : "Film")),
      item.title
    )
  );

const shelf = (title, items) => {
  if (!items || items.length === 0) return null;
  const scroller = el("div", { class: "row-scroller" }, items.map(discoverCard));
  const section = el("section", { class: "row" },
    el("h2", { class: "row-title" }, title),
    scroller
  );
  attachRowArrows(section, scroller);
  return section;
};

const posterSkeletons = (n) =>
  el("div", { class: "row-scroller" },
    Array.from({ length: n }, () =>
      el("div", { class: "skeleton", style: { width: "176px", aspectRatio: "2/3", flexShrink: 0 } }))
  );

export const renderRequests = async (root) => {
  const input = el("input", {
    type: "text", class: "focusable",
    placeholder: "Search any movie or show…",
    "aria-label": "Search catalogue",
  });

  const shelvesHost = el("div");
  const resultsHost = el("div", { class: "hidden" });
  let searchToken = 0;

  const runSearch = debounce(async () => {
    const q = input.value.trim();
    if (!q) {
      resultsHost.classList.add("hidden");
      resultsHost.innerHTML = "";
      shelvesHost.classList.remove("hidden");
      return;
    }
    shelvesHost.classList.add("hidden");
    resultsHost.classList.remove("hidden");

    if (cache.searches.has(q)) return paintResults(cache.searches.get(q), q);

    resultsHost.innerHTML = "";
    resultsHost.append(el("section", { class: "row" }, posterSkeletons(6)));
    const token = ++searchToken;
    try {
      const data = await (await fetch(`/api/discover/search?q=${encodeURIComponent(q)}`)).json();
      if (token !== searchToken) return; // a newer search superseded this
      cache.searches.set(q, data);
      paintResults(data, q);
    } catch {
      resultsHost.innerHTML = "";
      resultsHost.append(el("div", { class: "empty" }, "Search failed — is the server online?"));
    }
  }, 300);

  const paintResults = ({ movies, shows }, q) => {
    resultsHost.innerHTML = "";
    if ([...(shows || []), ...(movies || [])].length === 0) {
      resultsHost.append(el("div", { class: "empty" }, el("div", { class: "glyph" }, "🔍"), `Nothing found for “${q}”`));
    } else {
      resultsHost.append(shelf("Shows", shows) || "", shelf("Movies", movies) || "");
    }
  };

  input.addEventListener("input", runSearch);

  const screen = el("div", { class: "screen" },
    el("div", { class: "browse-head" },
      el("h1", {}, "Discover"),
      el("span", { class: "count" }, "stream anything")
    ),
    el("div", { class: "search-wrap", style: { padding: "6px var(--page-x) 10px" } },
      el("div", { class: "search-box", html: icons.search })
    ),
    resultsHost,
    shelvesHost
  );
  screen.querySelector(".search-box").append(input);
  root.append(screen);

  const paintShelves = ({ movies, shows }) => {
    shelvesHost.innerHTML = "";
    shelvesHost.append(shelf("Trending shows", shows) || "", shelf("Trending movies", movies) || "");
    if (!shelvesHost.childElementCount) {
      shelvesHost.append(el("div", { class: "empty" }, "Search up top — there's a whole lot out there."));
    }
  };

  if (cache.trending) {
    paintShelves(cache.trending);
  } else {
    shelvesHost.append(
      el("section", { class: "row" }, el("h2", { class: "row-title" }, "Trending shows"), posterSkeletons(6)),
      el("section", { class: "row" }, el("h2", { class: "row-title" }, "Trending movies"), posterSkeletons(6))
    );
    try {
      cache.trending = await (await fetch("/api/discover")).json();
      paintShelves(cache.trending);
    } catch {
      shelvesHost.innerHTML = "";
      shelvesHost.append(el("div", { class: "empty" },
        el("div", { class: "glyph" }, "📡"),
        "Couldn't load the catalogue — check the server's internet connection."));
    }
  }
};

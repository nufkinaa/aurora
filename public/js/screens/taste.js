// Taste onboarding: "pick titles you love" — a poster grid over the library
// + the trending catalog. Every tap toggles and saves (debounced); the picks
// are strong signals the recommender consumes alongside liked genres.
import { el, posterImg, debounce, toast } from "../ui.js";
import { api } from "../api.js";
import { state, loadLibrary } from "../state.js";
import { navigate } from "../router.js";

const keyOf = (t) => t.imdbId || t.id;

export const renderTaste = async (root) => {
  const screen = el("div", { class: "screen taste page-pad" });
  root.append(screen);
  if (!state.profile) {
    screen.append(el("div", { class: "empty" }, el("div", { class: "glyph" }, "👤"), "Pick a profile first."));
    return;
  }

  let liked = [];
  let pool = [];
  try {
    // Taste needs RANGE, not an inventory of what's already downloaded —
    // pull the wide catalog (top + trending, films + series) and mix a
    // modest slice of the library into it, everything shuffled together.
    const [lib, taste, ...cats] = await Promise.all([
      loadLibrary(),
      api.taste(state.profile.id),
      api.catalog({ type: "movie", category: "top" }).catch(() => null),
      api.catalog({ type: "movie", category: "trending" }).catch(() => null),
      api.catalog({ type: "show", category: "top" }).catch(() => null),
      api.catalog({ type: "show", category: "trending" }).catch(() => null),
    ]);
    liked = taste.liked || [];
    const seen = new Set();
    const add = (t, requireCover = true) => {
      const k = keyOf(t);
      if (!k || seen.has(k) || (requireCover && !t.cover)) return;
      seen.add(k);
      pool.push(t);
    };
    const shuffle = (a) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const catalog = shuffle(cats.flatMap((c) => (c && c.items) || [])).map((i) => ({
      imdbId: i.imdbId, title: i.title, cover: i.cover || i.poster, year: i.year,
    }));
    const library = shuffle([...(lib.movies || []), ...(lib.shows || [])]).slice(0, 15).map((i) => ({
      id: i.id, title: i.title, cover: i.cover, year: i.year,
    }));
    // interleave: mostly catalog, a familiar face every few tiles
    let li = 0;
    catalog.forEach((c, i) => {
      add(c);
      if (i % 5 === 4 && li < library.length) add(library[li++]);
    });
    while (li < library.length) add(library[li++]);
    // anything already liked must be visible (and toggleable) even if the
    // catalog no longer surfaces it — the titled fallback covers a missing
    // poster on old picks
    for (const t of liked) add({ ...t }, false);
    pool = pool.slice(0, 120);
  } catch {
    screen.append(el("div", { class: "empty" }, "Couldn't load titles — try again in a moment."));
    return;
  }

  const picked = new Map(liked.map((t) => [keyOf(t), t]));
  const count = el("span", { class: "count" });
  const paintCount = () => { count.textContent = picked.size ? `${picked.size} picked` : "tap everything you love"; };
  paintCount();

  const save = debounce(async () => {
    try { await api.setTaste(state.profile.id, [...picked.values()]); }
    catch { toast("Couldn't save your picks", "⚠️"); }
  }, 600);

  const grid = el("div", { class: "grid", style: { paddingLeft: 0, paddingRight: 0 } });
  for (const t of pool) {
    const k = keyOf(t);
    const tile = el("button", {
      class: "taste-tile focusable" + (picked.has(k) ? " on" : ""),
      "aria-label": t.title,
      onclick: () => {
        if (picked.has(k)) picked.delete(k);
        else picked.set(k, { id: t.id, imdbId: t.imdbId, title: t.title });
        tile.classList.toggle("on", picked.has(k));
        paintCount();
        save();
      },
    },
      posterImg(t.cover, t.title, "taste-poster", "card-fallback"),
      el("span", { class: "taste-check" }, "♥"),
    );
    grid.append(tile);
  }

  screen.append(
    el("div", { class: "browse-head", style: { paddingLeft: 0, paddingRight: 0 } },
      el("h1", {}, "What do you love?"), count),
    el("p", { class: "pref-note", style: { paddingLeft: 0 } },
      "Tap the ones you'd defend in an argument. Home learns from these — you can come back and change them anytime."),
    grid,
    // Done floats — no scrolling a 120-poster grid just to leave
    el("div", { class: "taste-done" },
      el("button", { class: "btn btn-primary focusable", html: "<span>Done</span>", onclick: () => navigate("#/preferences") })),
    el("div", { style: { height: "90px" } }), // the floating bar's landing pad
  );
};

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
    const [lib, home, taste] = await Promise.all([
      loadLibrary(),
      api.home(state.profile.id),
      api.taste(state.profile.id),
    ]);
    liked = taste.liked || [];
    const seen = new Set();
    const add = (t) => {
      const k = keyOf(t);
      if (!k || seen.has(k)) return;
      seen.add(k);
      pool.push(t);
    };
    // your own library first (things you chose to own say the most)…
    for (const i of [...(lib.movies || []), ...(lib.shows || [])]) {
      add({ id: i.id, title: i.title, cover: i.cover, year: i.year });
    }
    // …then the trending catalog for range
    const trending = (home.rows || []).find((r) => r.id === "trending-stream");
    for (const i of (trending ? trending.items : [])) {
      add({ imdbId: i.imdbId, title: i.title, cover: i.cover || i.poster, year: i.year });
    }
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
    el("div", { class: "detail-actions", style: { padding: "22px 0" } },
      el("button", { class: "btn btn-primary focusable", html: "<span>Done</span>", onclick: () => navigate("#/preferences") })),
  );
};

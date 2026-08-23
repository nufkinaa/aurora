// Shared pieces of the detail page: the hero block and the library-side
// "My List" button. The page itself lives in discover-detail.js, which serves
// library titles and streamable titles as one screen.
import { el, icons, resBadge, toast, posterImg, artUrl } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { starRating } from "../components.js";
// Exported for the unified detail page (discover-detail.js), which uses this
// variant whenever the title has a library copy — the stream variant keys the
// watchlist by IMDb id, this one by library id.
export const watchlistButton = (item) => {
  let inList = false;
  const btn = el("button", { class: "btn focusable" });

  const paint = () => {
    btn.innerHTML = (inList ? icons.check : icons.plus) + `<span>${inList ? "In My List" : "My List"}</span>`;
  };

  if (state.profile) {
    api.watchlist(state.profile.id).then(({ items }) => {
      inList = items.some((x) => x.id === item.id);
      paint();
    }).catch(() => {});
  }
  paint();

  btn.addEventListener("click", async () => {
    if (!state.profile) return;
    inList = !inList;
    paint();
    try {
      await api.toggleWatchlist(state.profile.id, item.id, inList);
      toast(inList ? `“${item.title}” saved for later` : "Off the list. Bold.", inList ? "➕" : "➖");
    } catch {}
  });
  return btn;
};

export const heroBlock = (item, actions, metaParts, { rateKey = null } = {}) => {
  const badge = resBadge(item);
  return el("div", { class: "detail-hero" },
    (item.backdrop || item.cover) &&
      el("div", {
        class: `hero-backdrop ${item.backdrop ? "sharp" : ""}`,
        style: {
          backgroundImage: item.backdrop
            ? `url("${artUrl(item.backdrop)}"), url("${artUrl(item.cover)}")`
            : `url("${artUrl(item.cover)}")`,
        },
      }),
    el("div", { class: "hero-fade" }),
    item.cover
      ? posterImg(item.cover, item.title, "detail-poster", "detail-poster card-fallback")
      : el("div", { class: "detail-poster card-fallback" }, item.title),
    el("div", { class: "detail-info" },
      el("div", { class: "hero-kicker" }, item.type === "show" ? "Series" : "Film"),
      el("h1", { class: "detail-title" }, item.title),
      el("div", { class: "detail-meta" },
        item.rating && el("span", { class: "rating-star" }, `★ ${item.rating}`),
        // A node rather than a bare text node so callers can rewrite it in place.
        // A show's line changes with the active season (its year, and when the
        // next episode lands), and there is nothing to hang that on if this is
        // pre-joined into the parent.
        el("span", { class: "detail-meta-parts" }, metaParts.filter(Boolean).join(" · ")),
        item.certificate &&
          el(
            "span",
            { class: "badge badge-age", title: "Age rating" },
            item.certificate,
          ),
        badge && el("span", { class: "badge" }, badge),
        item.subtitles && item.subtitles.length > 0 && el("span", { class: "badge" }, "CC")
      ),
      item.genres && item.genres.length > 0 &&
        el("div", { class: "genre-chips" },
          item.genres.map((g) => el("span", { class: "chip static" }, g))
        ),
      item.synopsis && el("p", { class: "detail-synopsis" }, item.synopsis),
      rateKey && state.profile &&
        el("div", { class: "detail-rate" },
          el("span", { class: "detail-rate-label" }, "Your rating"),
          starRating(rateKey)
        ),
      el("div", { class: "detail-actions" }, actions)
    )
  );
};

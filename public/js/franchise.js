// Franchise order on the website (2026-11-09) — the title page's line, and the
// pieces the franchise page (screens/franchise.js) and the player's end card
// share. The server has the list, the rules and the words
// (src/media/franchises); the TV and the phone show the same
// (tv-native/src/franchiseRules.ts).
import { el, icons } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { navigate } from "./router.js";
import { track } from "./usage.js";

// Where a franchise entry (a page entry or the end card's) goes when pressed.
export const entryHref = (e) =>
  e.onServer
    ? `#/${e.onServer.type === "show" ? "show" : "movie"}/${encodeURIComponent(e.onServer.id)}`
    : `#/discover/${e.type === "show" ? "series" : "movie"}/${encodeURIComponent(e.imdbId)}`;

// The one action an entry offers, by what the server holds:
//   on the server: a film → Play, a show → Open
//   not on it:     a film → Save & watch (its title page, which presses its
//                  own Save & watch once — the person's press, carried over;
//                  never anything by itself), a show → Choose episode
export const entryAction = (e) => {
  if (e.onServer) {
    return e.type === "show"
      ? { kind: "open", label: "Open", href: entryHref(e) }
      : { kind: "play", label: "Play", href: `#/play/${encodeURIComponent(e.onServer.id)}` };
  }
  return e.type === "show"
    ? { kind: "choose", label: "Choose episode", href: entryHref(e) }
    : { kind: "save", label: "Save & watch", href: `#/discover/movie/${encodeURIComponent(e.imdbId)}?save=1` };
};

export const franchiseHref = (id) => `#/franchise/${encodeURIComponent(id)}`;

// "Part of the Marvel Cinematic Universe · 12 of 34  [Watch in order]" — a
// placeholder placed under the hero at once (hidden), filled when the
// server answers; nothing at all for a title in no franchise.
export const franchiseLine = ({ imdbId, type = "movie", tmdbId = null }) => {
  const node = el("div", { class: "franchise-line page-pad hidden" });
  if (!imdbId) return node;
  api
    .franchiseFor(imdbId, { type: type === "show" || type === "series" ? "series" : "movie", tmdbId, profileId: state.profile ? state.profile.id : null })
    .then((r) => {
      const f = r && r.franchise;
      if (!f || !node.isConnected) return;
      node.append(
        el("a", {
          "data-ui": "detail.franchise",
          class: "franchise-line-body focusable",
          href: franchiseHref(f.id),
          onclick: (ev) => {
            ev.preventDefault();
            track("feat", { f: "franchise_open" });
            navigate(franchiseHref(f.id));
          },
        },
        el("span", { class: "franchise-line-icon", "aria-hidden": "true", html: icons.film }),
        el("span", { class: "franchise-line-text" }, f.line),
        el("span", { class: "franchise-line-go" }, f.action, el("span", { class: "franchise-line-chev", "aria-hidden": "true", html: icons.chevronRight }))),
      );
      node.classList.remove("hidden");
    })
    .catch(() => {});
  return node;
};

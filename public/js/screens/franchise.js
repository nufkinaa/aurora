// A franchise, in order (2026-11-09): every entry, what of it is on the server,
// what this person has watched, and one action each — Play what the server
// holds, Save & watch (through the film's own page) what it does not. The
// order switch shows when the franchise has two orders; the choice is the
// person's, kept on the server, so the title page's "12 of 34", the end card
// and Continue the franchise follow it on every device. The words are the
// server's and js/franchise.js's; the TV's screen is
// tv-native/src/screens/Franchise.tsx.
import { el, icons, posterImg, restoreScrollY } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { navigate } from "../router.js";
import { track } from "../usage.js";
import { entryAction, entryHref } from "../franchise.js";

const lastY = new Map(); // franchise id -> where the list was left (Back from a title)

export const renderFranchise = async (root, params = {}) => {
  const id = String(params.id || "");
  const screen = el("div", { class: "screen franchise-page" });
  root.append(screen);
  const pid = state.profile ? state.profile.id : null;

  const head = el("div", { class: "browse-head franchise-head" }, el("h1", { class: "skeleton", style: { width: "280px", height: "36px" } }));
  const sub = el("div", { class: "franchise-summary page-pad" });
  const switcher = el("div", { class: "filter-bar franchise-orders" });
  const body = el("div", { class: "franchise-list page-pad" },
    ...Array.from({ length: 6 }, () => el("div", { class: "franchise-skel skeleton" })));
  screen.append(head, sub, switcher, body);

  const failed = () =>
    body.replaceChildren(el("div", { class: "empty" }, el("div", { class: "glyph" }, "📡"), "Couldn't load this franchise right now.",
      el("div", { style: { marginTop: "14px" } }, el("button", { class: "btn small focusable", onclick: () => load() }, "Try again"))));

  const stateWord = (s) =>
    s === "watched" ? el("span", { class: "fr-state watched" }, el("span", { "aria-hidden": "true", html: icons.check }), "Watched")
    : s === "started" ? el("span", { class: "fr-state started" }, "Started")
    : null;

  const row = (e) => {
    const act = entryAction(e);
    const open = (ev) => {
      if (ev) ev.preventDefault();
      navigate(entryHref(e));
    };
    return el("li", { class: `fr-entry${e.optional ? " optional" : ""}${e.state === "watched" ? " seen" : ""}` },
      el("div", { class: "fr-pos", "aria-hidden": e.position ? "false" : "true" }, e.position ? String(e.position) : ""),
      el("a", { "data-ui": "franchise.entry", class: "fr-open focusable", href: entryHref(e), onclick: open, "aria-label": `${e.title}${e.year ? ` (${e.year})` : ""}` },
        el("div", { class: "fr-poster" }, posterImg(e.cover || e.poster, e.title, "fr-poster-img", "card-fallback", { w: 154 })),
        el("div", { class: "fr-info" },
          el("div", { class: "fr-title" }, e.title, e.year ? el("span", { class: "fr-year" }, ` ${e.year}`) : null),
          el("div", { class: "fr-tags" },
            e.optional ? el("span", { class: "fr-tag" }, "Optional") : null,
            e.type === "show" ? el("span", { class: "fr-tag" }, "Series") : null,
            stateWord(e.state),
            el("span", { class: `fr-have${e.onServer ? " on" : ""}` }, e.onServer ? "On the server" : "Not on the server")),
          e.note ? el("div", { class: "fr-note" }, e.note) : null)),
      el("a", {
        "data-ui": act.kind === "play" ? "franchise.play" : act.kind === "save" ? "franchise.save" : "franchise.entry",
        class: `btn small focusable fr-act${act.kind === "play" ? " btn-primary" : ""}`,
        href: act.href,
        onclick: (ev) => {
          ev.preventDefault();
          if (act.kind === "save") track("feat", { f: "franchise_save" });
          if (act.kind === "play") track("feat", { f: "franchise_play" });
          navigate(act.href);
        },
        html: (act.kind === "play" ? icons.play : act.kind === "save" ? icons.download : "") + `<span>${act.label.replace(/&/g, "&amp;")}</span>`,
      }));
  };

  let current = null;
  const paint = (pg) => {
    current = pg;
    document.title = `${pg.name} · Aurora`;
    head.replaceChildren(el("h1", {}, pg.name), el("span", { class: "count" }, pg.total ? String(pg.total) : ""));
    sub.textContent = pg.summary || "";
    sub.classList.toggle("hidden", !pg.summary);
    switcher.replaceChildren();
    if ((pg.orders || []).length > 1) {
      switcher.append(el("div", { class: "fr-orders-track", role: "radiogroup", "aria-label": "Order" },
        ...pg.orders.map((o) => el("button", {
          "data-ui": "franchise.order",
          type: "button",
          role: "radio",
          "aria-checked": pg.order === o.id ? "true" : "false",
          class: `chip focusable${pg.order === o.id ? " on" : ""}`,
          onclick: async () => {
            if (current && current.order === o.id) return;
            track("feat", { f: `franchise_order_${o.id}` });
            if (pid) api.setFranchiseOrder(id, pid, o.id).catch(() => {});
            await load(o.id);
          },
        }, o.label))));
    }
    const list = el("ol", { class: "fr-entries" }, ...(pg.entries || []).map(row));
    body.replaceChildren(pg.entries && pg.entries.length ? list : el("div", { class: "empty" }, "Nothing to show here."));
  };

  const load = async (order = null) => {
    let pg = null;
    try {
      pg = await api.franchise(id, { profileId: pid, order });
    } catch (e) {
      if (!screen.isConnected) return;
      if (e && e.status === 404) {
        head.replaceChildren(el("h1", {}, "Franchise"));
        body.replaceChildren(el("div", { class: "empty" }, el("div", { class: "glyph" }, "🎬"), "That franchise isn't on this server."));
      } else failed();
      return;
    }
    if (!screen.isConnected) return;
    paint(pg);
  };
  track("feat", { f: "franchise_page" });
  await load();
  const y = lastY.get(id);
  if (y) restoreScrollY(y);
  return () => { lastY.set(id, window.scrollY || document.body.scrollTop || 0); };
};

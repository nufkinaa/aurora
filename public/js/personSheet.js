// The person sheet: press an actor or a director — in X-Ray, or in a title
// page's cast line — and who they are opens right there, over whatever is
// open: a few portraits, then what they made. It used to throw you into
// Search.
//
// A PRESS ON A TITLE PUTS IT ON MY LIST (elia's words). Since 1.6.85 a list
// add may start a download, so that press is made plain and reversible:
//   · the card says what it is now (✓ on the list / in the library / watched)
//     and a line above the titles says what a press does;
//   · the toast says what happened — including "downloading the film" — and
//     carries Undo; pressing the card again is the same undo (the server lets
//     go of a download it started for a list nobody has the title on);
//   · a card is deaf while its own request is in flight (no double toggles),
//     and a hold never toggles;
//   · adding is never the only thing to do: every card has a Details button
//     (and: hold / right-click the card, or press I on it) for the title's page.
//
// It sits on top of X-Ray and changes nothing under it: the film stays as
// X-Ray left it, and closing the sheet returns focus to the person pressed.
// Back / Escape / the phone's back gesture close the top layer only — the
// enlarged photo, then this sheet, then X-Ray.
import { el, artUrl, icons, toast, listAddedLine, posterImg, backupPosterUrl, haptic } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { navigate } from "./router.js";
import { pushScope, popScope } from "./focus.js";
import { attachHold } from "./peek.js";
import { track } from "./usage.js";

let current = null; // { close } — one sheet at a time

const initials = (name) => String(name || "").split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
const yearOf = (iso) => (iso && /^\d{4}/.test(iso) ? iso.slice(0, 4) : null);
const KNOWN = { Acting: "Actor", Directing: "Director", Writing: "Writer", Production: "Producer", Sound: "Composer", Camera: "Cinematographer", Editing: "Editor", Creator: "Creator" };
const SECTION = { acting: "Appears in", directing: "Directed", creating: "Created", writing: "Wrote", producing: "Produced", music: "Scored", camera: "Shot", editing: "Edited" };

const pageOf = (c) =>
  c.inLibrary
    ? `#/${c.type === "show" ? "show" : "movie"}/${c.inLibrary}`
    : `#/discover/${c.type === "show" ? "series" : "movie"}/${c.imdbId}`;

// who: { id?, name, role?, photo?, of?: the title's IMDb id, type?: "movie"|"series" }
// opts.inPlayer: opened over a film — the title pages are one press further
// away there (they leave the film), and nothing links out of the app.
export const openPerson = (who, { inPlayer = false } = {}) => {
  if (!who || !who.name) return;
  if (current) current.close({ silent: true });
  const opener = document.activeElement;
  const fsHost = document.fullscreenElement || document.webkitFullscreenElement || null;
  const host = fsHost || document.body;
  const id = who.id || `name:${who.name}`;
  let data = null;
  let closed = false;
  let viewer = null;
  let armed = false; // our own history entry is on the stack
  let refreshTimer = null;
  let token = 0;

  // ----- the frame -----
  const face = el("div", { class: "xr-face person-face" }, initials(who.name));
  const setFace = (src) => {
    if (!src || face.querySelector("img")) return;
    const img = el("img", { src: artUrl(src, 64), alt: "", decoding: "async" });
    img.onerror = () => img.remove();
    face.append(img);
  };
  setFace(who.photo);
  const nameEl = el("h2", { class: "person-name" }, who.name);
  const subEl = el("div", { class: "person-sub" }, who.role || " ");
  const imdbEl = el("span", { class: "person-imdb-slot" });
  const closeBtn = el("button", { class: "focusable person-close", "aria-label": "Close", onclick: () => close() }, "✕");
  // (the sheet's own line for what a press did: a toast lives outside the
  // fullscreen element and would not be seen over a fullscreen film)
  const status = el("div", { class: "person-status", role: "status", "aria-live": "polite" });
  const body = el("div", { class: "person-body" });
  const sheet = el("div", { class: "person-sheet", role: "dialog", "aria-modal": "true", "aria-label": who.name },
    el("div", { class: "person-head" },
      el("div", { class: "person-grab", "aria-hidden": "true" }),
      face,
      el("div", { class: "person-id" }, nameEl, subEl),
      imdbEl,
      closeBtn),
    body,
    status);
  const wrap = el("div", { class: "person-wrap ui-overlay" + (inPlayer ? " in-player" : ""), onclick: (e) => { if (e.target === wrap) close(); } }, sheet);

  let statusTimer = null;
  const say = (text, icon, action = null) => {
    if (fsHost) {
      clearTimeout(statusTimer);
      status.replaceChildren(
        el("span", {}, `${icon} ${text}`),
        action && el("button", { class: "toast-act focusable", onclick: () => { status.classList.remove("on"); action.onClick(); } }, action.label));
      status.classList.add("on");
      statusTimer = setTimeout(() => status.classList.remove("on"), 5200);
    } else toast(text, icon, action);
  };

  // ----- one title -----
  const cardNodes = new Map(); // credit.key -> { credit, node, btn, paint }
  const describe = (c) => {
    const bits = [c.title, c.year, c.role].filter(Boolean).join(", ");
    const where = [c.inLibrary && "in the library", c.watched && "watched", c._downloading && "downloading"].filter(Boolean).join(", ");
    return `${bits}${where ? ` — ${where}` : ""}. ${c.inList ? "On My List: press to take it off." : "Press to add it to My List."}`;
  };
  const details = (c) => {
    track("feat", { f: "person_details" });
    const hash = pageOf(c);
    const had = armed;
    close({ navigating: true });
    // our history entry is still under us: the title's page takes its place,
    // so Back from there lands where the sheet was opened (the film, even)
    if (had) location.replace(hash);
    else navigate(hash);
  };
  const toggle = async (c) => {
    const hit = cardNodes.get(c.key);
    if (!state.profile) return details(c);
    if (c._busy) return;
    c._busy = true;
    const next = !c.inList;
    c.inList = next;
    if (!next) c._downloading = false;
    haptic(8);
    if (hit) hit.paint();
    try {
      const res = await api.toggleWatchlist(state.profile.id, {
        imdbId: c.imdbId, type: c.type === "show" ? "show" : "movie", title: c.title,
        poster: c.poster || null, year: c.year || null, genres: c.genres || [], rating: c.rating || null,
      }, next);
      c._downloading = !!(next && res && res.download && res.download.queued);
      track("feat", { f: next ? "person_add" : "person_remove" });
      // the page under the sheet may be this very title: its own button follows
      window.dispatchEvent(new CustomEvent("aurora-watchlist", { detail: { imdbId: c.imdbId, libraryId: c.inLibrary || null, inList: next } }));
      // the TV sheet's words (PersonSheet.tsx): the title, then the My List line every screen uses
      say(next ? `${c.title}: ${listAddedLine(res)}` : `${c.title}: removed from My List`, next ? "➕" : "➖",
        next ? { label: "Undo", onClick: () => { if (c.inList) toggle(c); } } : null);
    } catch {
      c.inList = !next;
      say("Couldn't change My List — try again", "⚠️");
    } finally {
      c._busy = false;
      if (hit) hit.paint();
    }
  };
  const titleCard = (c) => {
    const item = { imdbId: c.imdbId, type: c.type, title: c.title, year: c.year };
    const mark = el("span", { class: "pt-mark", "aria-hidden": "true" });
    const flag = el("span", { class: "pt-flag", "aria-hidden": "true" });
    const btn = el("button", { class: "card poster focusable pt-card", onclick: () => toggle(c) },
      c.poster || backupPosterUrl(item)
        ? posterImg(c.poster || backupPosterUrl(item), c.title, "card-poster", "card-fallback", { w: 150, backup: backupPosterUrl(item) })
        : el("div", { class: "card-fallback" }, c.title),
      mark,
      flag,
      c.progress && el("div", { class: "card-progress" }, el("div", { style: { width: `${Math.round(c.progress * 100)}%` } })));
    const more = el("button", { class: "focusable pt-more", "aria-label": `Details: open the page of ${c.title}`, title: inPlayer ? "Open its page (leaves the film)" : "Open its page", onclick: () => details(c) }, "Details");
    const node = el("div", { class: "pt", "data-key": c.key },
      btn,
      el("div", { class: "pt-text" },
        el("div", { class: "pt-title", title: c.title }, c.title),
        el("div", { class: "pt-sub" }, [c.year, c.role].filter(Boolean).join(" · "))),
      more);
    const paint = () => {
      node.classList.toggle("listed", !!c.inList);
      node.classList.toggle("busy", !!c._busy);
      btn.setAttribute("aria-pressed", String(!!c.inList));
      btn.setAttribute("aria-label", describe(c));
      mark.innerHTML = c.inList ? icons.check : icons.plus;
      const text = c._downloading ? "Downloading" : c.watched ? "Watched" : c.inLibrary ? "In library" : "";
      flag.textContent = text;
      flag.classList.toggle("hidden", !text);
    };
    paint();
    // a hold (or a right-click) is the title's page — never a toggle
    attachHold(btn, () => details(c));
    btn.addEventListener("keydown", (e) => {
      if ((e.key === "i" || e.key === "I") && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); details(c); }
    });
    cardNodes.set(c.key, { credit: c, node, btn, paint });
    return node;
  };

  // ----- the photos -----
  const PHOTO_SLOTS = 5;
  const photoStrip = el("div", { class: "person-photos", "aria-label": `Photos of ${who.name}` },
    Array.from({ length: PHOTO_SLOTS }, () => el("div", { class: "person-photo skeleton" })));
  const openViewer = (at) => {
    if (viewer || !data || !data.photos.length) return;
    const track2 = el("div", { class: "person-viewer-track" },
      data.photos.map((p, i) => el("div", { class: "person-viewer-slide" },
        el("img", { src: artUrl(p.url, 240), "data-full": p.full, alt: `${data.name}, photo ${i + 1} of ${data.photos.length}`, decoding: "async" }))));
    const count = el("div", { class: "person-viewer-count" });
    let at2 = at;
    const show = (i, smoothly = true) => {
      at2 = Math.max(0, Math.min(data.photos.length - 1, i));
      const slide = track2.children[at2];
      // the sharp picture is fetched when its slide is the one on screen
      for (const s of [slide, track2.children[at2 + 1]]) {
        const img = s && s.querySelector("img");
        if (img && img.dataset.full) { const full = img.dataset.full; delete img.dataset.full; const big = new Image(); big.onload = () => { img.src = full; }; big.src = full; }
      }
      track2.scrollTo({ left: slide.offsetLeft, behavior: smoothly ? "smooth" : "auto" });
      count.textContent = `${at2 + 1} / ${data.photos.length}`;
      prev.disabled = at2 === 0;
      next.disabled = at2 === data.photos.length - 1;
    };
    const prev = el("button", { class: "focusable person-viewer-nav prev", "aria-label": "Previous photo", onclick: () => show(at2 - 1) }, "‹");
    const next = el("button", { class: "focusable person-viewer-nav next", "aria-label": "Next photo", onclick: () => show(at2 + 1) }, "›");
    const shut = el("button", { class: "focusable person-close person-viewer-close", "aria-label": "Close photo", onclick: () => closeViewer() }, "✕");
    const node = el("div", { class: "person-viewer", role: "group", "aria-label": `Photos of ${data.name}`, onclick: (e) => { if (e.target === node || e.target.classList.contains("person-viewer-slide")) closeViewer(); } },
      track2, prev, next, count, shut);
    // a swipe moves the strip by itself (scroll snap): keep the counter in step
    let settle = null;
    track2.addEventListener("scroll", () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        const i = Math.round(track2.scrollLeft / Math.max(1, track2.clientWidth));
        if (i !== at2) show(i, false);
      }, 90);
    }, { passive: true });
    node.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); show(at2 - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); show(at2 + 1); }
    }, true);
    viewer = { node, from: document.activeElement };
    sheet.append(node);
    pushScope(node);
    shut.focus({ preventScroll: true });
    requestAnimationFrame(() => show(at, false));
    setTimeout(() => show(at2, false), 60);
    track("feat", { f: "person_photo" });
  };
  const closeViewer = () => {
    if (!viewer) return;
    const v = viewer;
    viewer = null;
    popScope(v.node);
    v.node.remove();
    if (v.from && v.from.isConnected) v.from.focus({ preventScroll: true });
  };
  const paintPhotos = () => {
    const photos = (data && data.photos) || [];
    if (!photos.length) {
      photoStrip.classList.add("none"); // nothing to show: the strip folds away
      photoStrip.replaceChildren();
      return;
    }
    photoStrip.classList.remove("none");
    photoStrip.replaceChildren(...photos.map((p, i) => {
      const img = el("img", { src: artUrl(p.url, 110), alt: "", loading: i < 4 ? "eager" : "lazy", decoding: "async" });
      const b = el("button", { class: "focusable person-photo", "aria-label": `Photo ${i + 1} of ${photos.length} of ${data.name} — enlarge`, onclick: () => openViewer(i) }, img);
      img.onload = () => b.classList.add("in");
      img.onerror = () => b.remove();
      return b;
    }));
  };

  // ----- the body -----
  const bioEl = el("p", { class: "person-bio hidden" });
  const how = el("div", { class: "person-how" });
  const list = el("div", { class: "person-titles" });
  const skeleton = () => el("div", { class: "person-grid" }, Array.from({ length: 8 }, () =>
    el("div", { class: "pt" }, el("div", { class: "card poster skeleton pt-card" }), el("div", { class: "pt-text" }, el("div", { class: "skeleton", style: { height: "12px", width: "80%" } })))));
  body.append(photoStrip, bioEl, how, list);
  list.append(skeleton());

  const paintTitles = () => {
    const keep = document.activeElement && document.activeElement.closest ? document.activeElement.closest(".pt") : null;
    const keepKey = keep && keep.dataset.key;
    const keepMore = keep && document.activeElement.classList.contains("pt-more");
    // a card already drawn keeps its node (and what was done to it)
    const groups = [];
    for (const c of data.credits) {
      const prior = cardNodes.get(c.key);
      const credit = prior ? Object.assign(prior.credit, { role: c.role, dept: c.dept }) : c;
      let g = groups[groups.length - 1];
      if (!g || g.dept !== credit.dept) groups.push((g = { dept: credit.dept, items: [] }));
      g.items.push(credit);
    }
    const out = groups.map((g) => el("section", { class: "person-section" },
      el("h3", {}, SECTION[g.dept] || "Titles", el("span", { class: "xr-count" }, String(g.items.length))),
      el("div", { class: "person-grid" }, g.items.map((c) => (cardNodes.get(c.key) || {}).node || titleCard(c)))));
    if (!out.length) {
      out.push(el("div", { class: "xr-empty" }, data.kids ? "Nothing of theirs fits this profile." : data.partial ? "Looking up their titles…" : "No titles are known for them yet."));
    }
    list.replaceChildren(...out);
    how.textContent = data.credits.length
      ? (state.profile ? "Press a title to put it on My List — press again to take it off. " : "") +
        (matchMedia("(hover: none)").matches ? "Hold one, or tap Details, for its page." : "Details (or I) opens its page.")
      : "";
    if (keepKey && cardNodes.get(keepKey)) {
      const hit = cardNodes.get(keepKey);
      (keepMore ? hit.node.querySelector(".pt-more") : hit.btn).focus({ preventScroll: true });
    }
  };

  const paint = () => {
    nameEl.textContent = data.name;
    sheet.setAttribute("aria-label", data.name);
    const life = data.born ? (data.died ? `${yearOf(data.born)}–${yearOf(data.died)}` : `born ${yearOf(data.born)}`) : null;
    subEl.textContent = [who.role, !who.role && KNOWN[data.knownFor], life].filter(Boolean).join(" · ") || " ";
    if (data.photos[0]) setFace(data.photos[0].url);
    // the photos are TMDB's; the person's IMDb page is one link away (never
    // over a film: a new tab would take the picture out of fullscreen)
    imdbEl.replaceChildren(data.imdbId && !inPlayer
      ? el("a", { class: "focusable person-imdb", href: `https://www.imdb.com/name/${data.imdbId}/`, target: "_blank", rel: "noopener noreferrer", title: `${data.name} on IMDb` }, "IMDb")
      : "");
    paintPhotos();
    if (data.bio) {
      bioEl.textContent = data.bio;
      bioEl.classList.remove("hidden");
      bioEl.onclick = () => bioEl.classList.toggle("open");
    }
    paintTitles();
  };

  const fail = (e) => {
    const noKey = e && e.status === 503;
    const missing = e && e.status === 404;
    photoStrip.classList.add("none");
    photoStrip.replaceChildren();
    how.textContent = "";
    list.replaceChildren(el("div", { class: "xr-empty" },
      noKey ? "This server can't look people up yet (it needs a TMDB key)." : missing ? `Nothing is known about ${who.name}.` : "Couldn't load this right now.",
      el("div", { class: "person-fail-actions" },
        !noKey && !missing && el("button", { class: "btn small focusable", onclick: () => { list.replaceChildren(skeleton()); load(); } }, "Try again"),
        // what a press on a person did before this sheet existed
        !inPlayer && el("button", { class: "btn small focusable", onclick: () => { const q = `#/search/${encodeURIComponent(who.name)}`; const had = armed; close({ navigating: true }); if (had) location.replace(q); else navigate(q); } }, `Search for ${who.name}`))));
    (list.querySelector(".btn") || closeBtn).focus({ preventScroll: true });
  };

  const load = async ({ quiet = false } = {}) => {
    const mine = ++token;
    try {
      const d = await api.person(id, { of: who.of, type: who.type, profile: state.profile && state.profile.id });
      if (closed || mine !== token) return;
      data = d;
      paint();
      // some titles were still being looked up: one more ask, a moment later
      if (d.partial && !quiet) refreshTimer = setTimeout(() => load({ quiet: true }), 2600);
    } catch (e) {
      if (closed || mine !== token) return;
      if (!quiet) fail(e);
    }
  };

  // ----- leaving -----
  const onBack = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation(); // the top layer only: X-Ray (and the player) do not hear this one
    if (viewer) closeViewer();
    else close();
  };
  const onPop = () => {
    if (!armed) return;
    if (viewer) {
      // Back took our entry for the photo: put one back for the sheet itself
      closeViewer();
      try { history.pushState({ auroraSheet: "person" }, ""); } catch { armed = false; }
      return;
    }
    armed = false;
    close({ fromPop: true });
  };
  const onHash = () => { armed = false; close({ navigating: true }); };
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    // Tab stays inside the top layer
    const scope = viewer ? viewer.node : sheet;
    const nodes = [...scope.querySelectorAll(".focusable")].filter((n) => n.offsetParent !== null && !n.disabled);
    if (!nodes.length) return;
    const at = nodes.indexOf(document.activeElement);
    e.preventDefault();
    nodes[(at + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length].focus();
  };
  function close({ fromPop = false, navigating = false, silent = false } = {}) {
    if (closed) return;
    closed = true;
    token++;
    clearTimeout(refreshTimer);
    clearTimeout(statusTimer);
    if (viewer) { popScope(viewer.node); viewer = null; }
    document.removeEventListener("ui-back", onBack, true);
    window.removeEventListener("popstate", onPop);
    window.removeEventListener("hashchange", onHash);
    wrap.removeEventListener("keydown", onKey);
    popScope(wrap);
    if (current && current.wrap === wrap) current = null;
    // give back the history entry the sheet put down (unless Back just did,
    // or we are on our way to another page)
    if (armed && !fromPop && !navigating) { armed = false; try { history.back(); } catch {} }
    wrap.classList.add("leaving");
    setTimeout(() => wrap.remove(), silent ? 0 : 220);
    if (!navigating && opener && opener.isConnected) opener.focus({ preventScroll: true });
  }

  host.append(wrap);
  current = { close, wrap };
  pushScope(wrap);
  closeBtn.focus({ preventScroll: true });
  document.addEventListener("ui-back", onBack, true);
  wrap.addEventListener("keydown", onKey);
  // The phone's back gesture / hardware Back closes this sheet, not the page
  // under it: the sheet owns one history entry while it is open.
  try { history.pushState({ auroraSheet: "person" }, ""); armed = true; } catch {}
  window.addEventListener("popstate", onPop);
  window.addEventListener("hashchange", onHash);
  track("feat", { f: inPlayer ? "person_player" : "person" });
  load();
  return { close };
};

export const personSheetOpen = () => !!current;

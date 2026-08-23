// Small DOM + formatting helpers shared by every screen.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// el("div", {class: "card", onclick: fn}, child1, child2...)
export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2), v);
    } else if (k === "class") {
      node.className = v;
    } else if (k === "html") {
      node.innerHTML = v;
    } else if (k === "style" && typeof v === "object") {
      Object.assign(node.style, v);
    } else {
      node.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
};

export const svg = (paths, attrs = "") =>
  `<svg viewBox="0 0 24 24" fill="currentColor" ${attrs}>${paths}</svg>`;

export const icons = {
  play: svg('<path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.98-6.86a1.03 1.03 0 0 0 0-1.76L9.56 4.26A1.03 1.03 0 0 0 8 5.14z"/>'),
  pause: svg('<rect x="6" y="4" width="4.4" height="16" rx="1.4"/><rect x="13.6" y="4" width="4.4" height="16" rx="1.4"/>'),
  back: svg('<path d="M15.5 4.5 8 12l7.5 7.5-1.8 1.8L4.4 12l9.3-9.3z"/>'),
  // Thinner than `back` on purpose: these sit on top of artwork in the row
  // scrollers, where the chunky arrow reads as a control you must press rather
  // than a hint that there is more to the side.
  chevronLeft: svg('<path d="M14.7 5.3 8 12l6.7 6.7 1.4-1.4L10.8 12l5.3-5.3z"/>'),
  chevronRight: svg('<path d="M9.3 5.3 7.9 6.7 13.2 12l-5.3 5.3 1.4 1.4L16 12z"/>'),
  plus: svg('<path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/>'),
  check: svg('<path d="M9.6 16.4 5.2 12l-1.7 1.7 6.1 6.1L20.5 9l-1.7-1.7z"/>'),
  cc: svg('<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6v-2zm0 4h8v2H6v-2zm10 0h2v2h-2v-2zm-6-4h8v2h-8v-2z"/>'),
  forward10: svg('<path d="M12 3V1.8L16.2 5 12 8.2V6c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6h2c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8z"/><text x="8.2" y="15.5" font-size="7.5" font-weight="800" fill="currentColor">10</text>'),
  back10: svg('<path d="M12 3V1.8L7.8 5 12 8.2V6c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/><text x="8.2" y="15.5" font-size="7.5" font-weight="800" fill="currentColor">10</text>'),
  fullscreen: svg('<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>'),
  speed: svg('<path d="M20.4 8.6a10 10 0 1 0 1.1 4.6h-2a8 8 0 1 1-.9-3.7l-3.4 3.4a2.5 2.5 0 1 0 1.4 1.4l5.6-5.6-1.8-.1z"/>'),
  download: svg('<path d="M12 3v10.6l-3.8-3.8-1.4 1.4L12 17.4l5.2-6.2-1.4-1.4-2.8 3.8V3h-2zM5 19h14v2H5z"/>'),
  // Onto YOUR machine, as opposed to onto the server — a screen with an arrow
  // landing in it, so the two downloads on a page can't be mistaken for one.
  downloadDevice: svg(
    '<path d="M21 2H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7v2H7v2h10v-2h-3v-2h7a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm0 14H3V4h18v12z"/>' +
      '<path d="M11 6h2v3.2h2.2L12 13 8.8 9.2H11V6z"/>',
  ),
  // Film vs series, for the card tags. Both have to survive at 11px on top of
  // artwork, so they are told apart by SILHOUETTE rather than by detail: a strip
  // with a notched top edge against a clean screen on a stand. Detail finer than
  // this (sprocket holes, a clapper hinge) turns to mush at that size.
  film: svg(
    '<path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z"/>',
  ),
  series: svg('<rect x="2" y="4" width="20" height="13" rx="2"/><rect x="8" y="19" width="8" height="2" rx="1"/>'),
  search: svg('<path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/>'),
  info: svg('<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>'),
  gear: svg('<path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L15 3.5h-4l-.3 2.5a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1)"/>'),
  volume: svg('<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>'),
  volumeOff: svg('<path d="M3 9v6h4l5 5V4L7 9H3zm18.5 3-2.2-2.2-1.4 1.4 2.2 2.2-2.2 2.2 1.4 1.4 2.2-2.2 2.2 2.2 1.4-1.4-2.2-2.2 2.2-2.2-1.4-1.4-2.2 2.2z" transform="scale(0.92)"/>'),
};

// Route external artwork through the server's disk cache (/img/ext): repeat
// loads become LAN-instant and browsing survives a flaky internet. Local
// /img/... URLs and unknown hosts pass through untouched — the server
// enforces the same allow-list.
const PROXY_ART_HOSTS = new Set([
  "image.tmdb.org",
  "images.metahub.space",
  "live.metahub.space",
  "static.tvmaze.com",
]);
export const artUrl = (u) => {
  if (!u || typeof u !== "string" || !u.startsWith("https://")) return u;
  try {
    if (PROXY_ART_HOSTS.has(new URL(u).host))
      return "/img/ext?u=" + encodeURIComponent(u);
  } catch {}
  return u;
};

// A poster <img> that can never strand a grey tile. Browsers never retry a
// failed image on their own, so one transient CDN hiccup used to leave a
// blank card until the next full render (elia's grey-poster report). One
// cache-busted retry covers the transient case; a second failure swaps in
// the same titled fallback tile the no-artwork path uses.
export const posterImg = (src, title, cls = "card-poster", fallbackCls = "card-fallback") => {
  src = artUrl(src);
  const img = el("img", { class: cls + " img-fade", src, loading: "lazy", decoding: "async", alt: "" });
  // Fade in on decode instead of popping. Cached images can be complete
  // before this handler attaches — reveal immediately then.
  const reveal = () => img.classList.add("img-in");
  img.onload = reveal;
  if (img.complete && img.naturalWidth > 0) reveal();
  let retried = false;
  img.onerror = () => {
    if (!retried) {
      retried = true;
      setTimeout(() => {
        if (img.isConnected)
          img.src = src + (src.includes("?") ? "&" : "?") + "r=" + Date.now();
      }, 1500);
      return;
    }
    img.replaceWith(el("div", { class: fallbackCls }, title || ""));
  };
  return img;
};

// Re-apply a saved scroll offset until the page is tall enough to hold it
// (grids and rows fill in over several frames). Any real scroll input wins
// immediately. Returns a stop() for the route's cleanup. (Same pattern the
// browse grids proved out — hoisted here so Home/Search/My List share it.)
export const restoreScrollY = (y) => {
  if (!y) return () => {};
  const ABORT_ON = ["wheel", "touchstart", "keydown"];
  let stop = false;
  let tries = 0;
  const give = () => {
    stop = true;
    for (const ev of ABORT_ON) window.removeEventListener(ev, give, true);
  };
  for (const ev of ABORT_ON) window.addEventListener(ev, give, true);
  const tick = () => {
    if (stop) return;
    window.scrollTo(0, y);
    // On TV-class engines body is the real scroll container and
    // window.scrollTo alone is a silent no-op (see focus.js) — write both.
    document.body.scrollTop = y;
    const at = window.scrollY || document.body.scrollTop || 0;
    if (Math.abs(at - y) > 4 && tries++ < 40) setTimeout(tick, 50);
    else give();
  };
  setTimeout(tick, 0);
  return give;
};

export const fmtDuration = (seconds) => {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const fmtClock = (seconds) => {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
};

export const fmtBytes = (bytes) => {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
};

// Air dates arrive as ISO strings from the catalogue, but callers that have
// already compared dates hold a timestamp. Both read the same here so neither
// side has to convert (and `Date.parse(1785200000000)` is NaN, which is a silently
// blank date rather than an error).
const airTime = (value) => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
};

// An episode's air date, short enough to sit on one line next to a runtime.
// Same-year dates drop the year, because "12 Mar" reads faster than
// "12 Mar 2026" when every other episode on the page says 2026 too.
export const fmtAirDate = (released) => {
  const t = airTime(released);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

// Which of the three states is this episode in?
//
// Cinemeta lists episodes as soon as they are ANNOUNCED, which is why this needs
// three answers rather than two. A show mid-season carries next month's episodes
// with a date attached, and a season announced but not scheduled carries episode
// titles with no date at all. Treating a missing date as "aired" (which is what
// `Date.parse(undefined) > now` being false quietly gets you) makes an episode
// nobody can watch look ready to play.
export const airStatus = (released, now = Date.now()) => {
  const t = airTime(released);
  if (!Number.isFinite(t)) return "unknown";
  return t > now ? "upcoming" : "aired";
};

// Resolve one season's episodes to "aired" | "upcoming" | "tba".
//
// A missing date is the ambiguous case and it needs the rest of the season to
// read it. Plenty of older shows have no dates on ANY episode, and calling those
// all "Date TBA" would make a finished show from 2004 unplayable. So a date-less
// episode only counts as announced-but-unscheduled when it sits past the last
// episode this season that does have a date — which is exactly the shape of a
// real announcement, and not the shape of missing data.
export const resolveAirStates = (episodes, now = Date.now()) => {
  let lastDated = null;
  for (const ep of episodes || []) {
    if (airStatus(ep.released, now) !== "unknown") {
      lastDated = Math.max(lastDated === null ? -Infinity : lastDated, Number(ep.episode) || 0);
    }
  }
  return (episodes || []).map((ep) => {
    // A file on disk aired, whatever the catalogue forgot to say about it.
    if (ep.local) return "aired";
    const status = airStatus(ep.released, now);
    if (status !== "unknown") return status;
    // No date anywhere in the season means the catalogue simply doesn't carry
    // them, which says nothing about whether these episodes exist. Only a date
    // we can compare against makes "past the schedule" a meaningful claim.
    if (lastDated === null) return "aired";
    return (Number(ep.episode) || 0) > lastDated ? "tba" : "aired";
  });
};

export const resBadge = (item) => {
  if (!item.height) return null;
  if (item.height >= 2000) return "4K";
  if (item.height >= 1000) return "HD";
  if (item.height >= 700) return "720p";
  return "SD";
};

let toastRoot;
// `action` ({label, onClick}) renders a tappable button on the toast — the
// undo pattern. Action toasts accept pointer events; plain ones stay inert.
export const toast = (message, icon = "ℹ️", action = null) => {
  if (!toastRoot) toastRoot = document.getElementById("toasts");
  const node = el(
    "div",
    { class: "toast" + (action ? " has-action" : "") },
    el("span", {}, icon),
    el("span", {}, message),
    action &&
      el("button", {
        class: "toast-act focusable",
        onclick: () => {
          node.remove();
          action.onClick();
        },
      }, action.label),
  );
  toastRoot.append(node);
  // A WebSocket burst (several downloads finishing, OCR ticks) used to stack
  // a whole column; three is plenty — drop the oldest, but never sacrifice a
  // live Undo toast for a status blurb.
  while (toastRoot.childElementCount > 3) {
    const victim =
      [...toastRoot.children].find((n) => !n.classList.contains("has-action")) ||
      toastRoot.firstElementChild;
    victim.remove();
  }
  setTimeout(() => node.classList.add("hide"), 5200);
  setTimeout(() => node.remove(), 5800);
};

// Append many nodes without a long synchronous layout hitch: the first
// `eager` land now (fills the viewport), the rest fill in over the next few
// frames. Returns a cancel() to abort pending work (e.g. on re-render).
export const appendProgressive = (parent, nodes, eager = 24, chunk = 12) => {
  for (let i = 0; i < Math.min(eager, nodes.length); i++) parent.append(nodes[i]);
  let i = eager;
  let timer = 0;
  // setTimeout(0) (not rAF) so the eager content paints first, and so it
  // still completes if the frame loop is throttled (backgrounded WebView).
  const pump = () => {
    const end = Math.min(i + chunk, nodes.length);
    const frag = document.createDocumentFragment();
    for (; i < end; i++) frag.append(nodes[i]);
    parent.append(frag);
    if (i < nodes.length) timer = setTimeout(pump, 0);
  };
  if (nodes.length > eager) timer = setTimeout(pump, 0);
  return () => timer && clearTimeout(timer);
};

export const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

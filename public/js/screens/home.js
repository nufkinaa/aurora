// Home: rotating hero billboard + shelves (Continue Watching, My List, ...)
import { el, icons, fmtDuration, resBadge, artUrl, restoreScrollY } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { shelfRow, continueRow, openItem } from "../components.js";
import { navigate } from "../router.js";
import { onMessage } from "../ws.js";

// How long each billboard title holds before the next slides in. The focus-pull
// animation in screens.css is deliberately SHORTER than this: the art reaches
// fully sharp partway through and then simply stays there, so a longer dwell buys
// more time on a clear image rather than a slower blur.
const HERO_DWELL_MS = 9000;

// Session-lived scroll memory (module scope survives route changes)
let homeScrollY = 0;

export const renderHome = async (root) => {
  const screen = el("div", { class: "screen" });
  root.append(screen);
  const cleanups = [];

  // Skeletons while loading
  screen.append(
    el("div", { class: "hero" },
      el("div", { class: "hero-fade" }),
      el("div", { class: "hero-inner" },
        el("div", { class: "hero-info" },
          el("div", { class: "skeleton", style: { width: "420px", maxWidth: "70vw", height: "56px", marginBottom: "16px" } }),
          el("div", { class: "skeleton", style: { width: "220px", height: "20px" } })
        )
      )
    )
  );

  let data;
  try {
    data = await api.home(state.profile?.id);
  } catch {
    screen.innerHTML = "";
    screen.append(el("div", { class: "empty" }, el("div", { class: "glyph" }, "⚠️"), "Couldn't load the library."));
    return;
  }

  screen.innerHTML = "";

  // ----- hero -----
  let heroTimer = null;
  if (data.hero.length > 0) {
    let idx = 0;
    // TWO backdrop layers, cross-faded by opacity. A single layer had to swap
    // its background-image outright — `transition: background-image` animates
    // nothing in any engine — so every rotation was a hard cut with the blur
    // animation restarting on top of it. Alternating layers dissolve properly.
    // `fade` opts these two into the cross-fade (start transparent, `.on` shows
    // one at a time). A plain .hero-backdrop stays visible — that's what the
    // detail pages use.
    const layers = [
      el("div", { class: "hero-backdrop fade" }),
      el("div", { class: "hero-backdrop fade" }),
    ];
    let front = 0;
    const info = el("div", { class: "hero-info" });
    const heroPoster = el("img", {
      class: "hero-poster",
      alt: "",
      decoding: "async",
      // Above the fold and the page's visual anchor — beat the lazy cards.
      fetchpriority: "high",
      // A failed poster hides rather than showing a broken-image glyph over
      // the billboard; the next rotation's src assignment un-hides it.
      onerror: function () { this.style.visibility = "hidden"; },
    });
    // Dots are real buttons now, so they're tappable on a phone (a bare 8px
    // span is not a touch target). `go` is defined below — only called on tap.
    const dots = el("div", { class: "hero-dots" },
      data.hero.map((_, i) =>
        el("button", {
          class: "hero-dot", "aria-label": `Show title ${i + 1}`,
          onclick: () => go(i),
        }, el("span", { class: i === 0 ? "on" : "" }))
      )
    );

    // `dir`: 1 = moving forward (slide in from the right), -1 = backward,
    // 0 = first paint (no slide).
    const show = (i, dir = 1) => {
      idx = i;
      const item = data.hero[i];
      // Three backdrop treatments: library video-frame stills stay sharp,
      // real landscape art (stream titles) gets a whisper of blur, and only
      // the portrait-poster fallback keeps the heavy blur.
      const isStill = !!item.backdrop && item.backdrop.startsWith("/img/still");
      const incoming = dir === 0 ? layers[front] : layers[1 - front];
      incoming.classList.toggle("sharp", isStill);
      incoming.classList.toggle("art", !!item.backdrop && !isStill);
      // Hand CSS both images and let it decide which one shows: a portrait phone
      // wants the poster, everything else the landscape art (see the
      // orientation: portrait rule in screens.css). Setting background-image
      // here instead would freeze that choice until the next rotation.
      incoming.style.setProperty("--hero-art", item.backdrop ? `url("${artUrl(item.backdrop)}")` : "none");
      incoming.style.setProperty("--hero-poster", `url("${artUrl(item.cover)}")`);
      // The focus pull lives on the ::after veil, keyed to `.on` — toggling
      // the class across rotations restarts it, no forced reflow needed.
      incoming.classList.add("on");
      if (incoming !== layers[front]) {
        layers[front].classList.remove("on");
        front = 1 - front;
      }

      heroPoster.src = artUrl(item.cover);
      heroPoster.style.visibility = "visible";
      // Slide the text + poster in from the direction of travel.
      if (dir !== 0) {
        const cls = dir > 0 ? "slide-next" : "slide-prev";
        for (const node of [info, heroPoster]) {
          node.classList.remove("slide-next", "slide-prev");
          void node.offsetWidth;
          node.classList.add(cls);
        }
      }
      [...dots.querySelectorAll("span")].forEach((d, j) => d.classList.toggle("on", j === i));

      const meta = [];
      if (item.year) meta.push(String(item.year));
      if (item.type === "show" && item.episodeCount) meta.push(`${item.episodeCount} episodes`);
      else if (item.source === "stream") meta.push(item.type === "show" ? "Series" : "Film");
      if (item.duration) meta.push(fmtDuration(item.duration));
      if (item.genres && item.genres.length) meta.push(item.genres.slice(0, 3).join(" · "));
      const badge = resBadge(item);

      info.innerHTML = "";
      info.append(
        el("div", { class: "hero-kicker" }, item.type === "show" ? "Series" : "Film"),
        el("h1", { class: "hero-title" }, item.title),
        el("div", { class: "hero-meta" },
          item.rating && el("span", { class: "rating-star" }, `★ ${item.rating}`),
          meta.join(" · "),
          badge && el("span", { class: "badge" }, badge)
        ),
        item.synopsis && el("p", { class: "hero-synopsis" }, item.synopsis),
        el("div", { class: "hero-actions" },
          el("button", {
            class: "btn btn-primary focusable",
            html: icons.play + `<span>${item.source === "stream" ? "Stream" : "Play"}</span>`,
            onclick: () => {
              if (item.source === "stream") openItem(item); // -> Discover detail
              else if (item.type === "show") navigate(`#/show/${item.id}`);
              else navigate(`#/play/${item.id}`);
            },
          }),
          el("button", {
            class: "btn focusable",
            html: icons.info + "<span>Details</span>",
            onclick: () => openItem(item),
          })
        )
      );
    };
    show(0, 0);

    // Jump to a specific title (dot tap / swipe), and hold the auto-rotation
    // off for a while so it can't yank the hero away mid-browse.
    const count = data.hero.length;
    let holdUntil = 0;
    const go = (i, dir) => {
      const next = ((i % count) + count) % count;
      holdUntil = Date.now() + 15000;
      if (next === idx) return;
      show(next, dir ?? (next > idx ? 1 : -1));
    };

    let pastHero = false; // set by the scroll handler below
    // Reduced-motion means no self-rotating billboard at all — its slide
    // keyframes are already disabled in CSS, which left a hard CUT every
    // 9s: more jarring than the motion the user asked to avoid. The dots
    // still switch it manually.
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    heroTimer = calm ? null : setInterval(() => {
      // Don't rotate while the user is interacting with hero buttons or just
      // moved it themselves — and don't burn image decodes + cross-fades when
      // nobody can see it (background tab, or scrolled down into the rows;
      // the TV app had exactly this bug and it re-rendered the world).
      if (document.hidden || pastHero) return;
      if (Date.now() < holdUntil) return;
      if (!info.contains(document.activeElement)) show((idx + 1) % count, 1);
    }, HERO_DWELL_MS);

    const heroEl = el("div", { class: "hero" },
      layers[0],
      layers[1],
      el("div", { class: "hero-fade" }),
      el("div", { class: "hero-inner" }, info, heroPoster),
      dots
    );
    screen.append(heroEl);

    // ----- swipe (touch) -----
    // Horizontal drag moves between titles; vertical is left alone so the page
    // still scrolls normally (CSS keeps touch-action: pan-y on the hero).
    if (count > 1) {
      const SWIPE_MIN = 45; // px of horizontal travel before it counts
      let sx = 0, sy = 0, tracking = false;
      heroEl.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return (tracking = false);
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
        tracking = true;
      }, { passive: true });
      heroEl.addEventListener("touchend", (e) => {
        if (!tracking) return;
        tracking = false;
        const t = e.changedTouches[0];
        if (!t) return;
        const dx = t.clientX - sx;
        const dy = t.clientY - sy;
        // Clearly horizontal, or it's a scroll/tap and none of our business.
        if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.4) return;
        const dir = dx < 0 ? 1 : -1; // drag left = next title
        go(idx + dir, dir);
      }, { passive: true });
    }

    // Scrolled past the hero but it's still peeking? Hold the depth-of-field
    // veil (see .hero.scrolled in screens.css) instead of the focus pull.
    // body is the real scroll container here, so listen to scroll wherever it
    // happens (capture — scroll events don't bubble) and read both scrollers.
    // rAF-coalesced, with the hero height cached: the old version read
    // offsetHeight (a forced layout) on EVERY scroll event.
    let heroH = 0;
    const measureHero = () => { heroH = heroEl.offsetHeight || 0; };
    let scrollQueued = false;
    const onHeroScroll = () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        const y = window.scrollY || document.body.scrollTop || 0;
        // Two different thresholds on purpose: the depth-of-field veil kicks
        // in early (rows overlapping), but rotation only pauses once the hero
        // is genuinely out of view — at 0.2 it still fills most of the screen.
        heroEl.classList.toggle("scrolled", y > heroH * 0.2);
        pastHero = y > heroH * 0.9;
      });
    };
    measureHero();
    document.addEventListener("scroll", onHeroScroll, { passive: true, capture: true });
    window.addEventListener("resize", measureHero);
    cleanups.push(() => {
      document.removeEventListener("scroll", onHeroScroll, { capture: true });
      window.removeEventListener("resize", measureHero);
    });
  } else {
    screen.append(
      el("div", { class: "empty", style: { paddingTop: "180px" } },
        el("div", { class: "glyph" }, "🎬"),
        el("h2", {}, "Nothing here yet"),
        el("p", { style: { marginTop: "8px" } }, "Point config.json at your Movies and Shows folders.")
      )
    );
  }

  // ----- rows -----
  const rowsHost = el("div");
  screen.append(rowsHost);

  // Progressive render: the first few shelves fill the space under the hero
  // and paint immediately; the rest (offscreen) are appended one-per-frame so
  // navigating to Home feels instant on a weak TV. No visible shift — the
  // deferred shelves are below the fold and land within a few frames.
  let renderToken = 0;
  const EAGER_ROWS = 3;
  // Home's shelves are the one place films and series sit side by side in the same
  // row, so this is where a card has to say which it is. The Movies and Shows
  // pages know already, and Continue Watching's labels read as episodes.
  const buildRow = (r) =>
    r.id === "continue" && state.profile
      ? continueRow(r.title, r.items, state.profile.id, api)
      : shelfRow(r.title, r.items, { showKind: true });

  const renderRows = (rows) => {
    const token = ++renderToken;
    rowsHost.innerHTML = "";
    rows.slice(0, EAGER_ROWS).forEach((r) => rowsHost.append(buildRow(r) || ""));

    let i = EAGER_ROWS;
    const pump = () => {
      if (token !== renderToken) return; // superseded by a newer render
      if (i >= rows.length) return;
      rowsHost.append(buildRow(rows[i++]) || "");
      setTimeout(pump, 0); // setTimeout, not rAF: robust if frames are throttled
    };
    if (rows.length > EAGER_ROWS) setTimeout(pump, 0);
  };
  renderRows(data.rows);

  // Refresh rows when the library changes (new files, OCR finished...)
  const unsub = onMessage("library_updated", async () => {
    try {
      const fresh = await api.home(state.profile?.id);
      renderRows(fresh.rows);
    } catch {}
  });

  // Coming back from a title lands where you left, not at the hero again.
  const stopRestore = restoreScrollY(homeScrollY);

  return () => {
    homeScrollY = window.scrollY || document.body.scrollTop || 0;
    stopRestore();
    if (heroTimer) clearInterval(heroTimer);
    for (const fn of cleanups) fn();
    unsub();
  };
};

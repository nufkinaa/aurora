// Home: rotating hero billboard + shelves (Continue Watching, My List, ...)
import { el, icons, fmtDuration, fmtClock, formatRow, artUrl, heroArtWidth, heroCover, heroShowsPoster, restoreScrollY } from "../ui.js";
import { upgradeArt } from "../artUpgrade.js";
import { blurOf } from "../blur.js";
import { api } from "../api.js";
import { state, progressFor } from "../state.js";
import { shelfRow, continueRow, openItem, ensureRowFilled, patchShelf } from "../components.js";
import { itemKey, locksFor, mergeHome, visibleMoves } from "../homeMerge.js";
import { navigate } from "../router.js";
import { onMessage } from "../ws.js";
import { createHeroTrailer } from "../heroTrailer.js";
import { fromHome as prefetchFromHome, warmHero } from "../prefetch.js";
import { homeUsable } from "../telemetry.js"; // [analytics]
import { toneNavFromImage } from "../glassTone.js";

// Home's last answer, per profile. Coming back to Home paints from it at
// once and the rows are refreshed underneath when the server answers — no
// skeleton between a title page and the rows you just left. It is also kept
// on the device (localStorage), so a cold start — a reload, a new tab, the
// phone's home-screen icon — paints the shelves in its first frame instead of
// a skeleton for as long as the request takes (elia, 2026-10-19: "a faster
// first screen … without the screen changing under the viewer" — the new
// answer is merged in by homeMerge.js's rule, below). On every line now; it
// used to be kept only on a slow one.
//   - per profile, and per AUDIENCE: a kids profile keeps its own copy, per
//     age limit, so a profile that has just been MADE a kids one (or had its
//     limit lowered) is never painted from the rows it was shown before
//     (2026-10-08); the record names its profile and audience and is checked
//     against both;
//   - at most a day old (older: the skeleton, as before);
//   - at most three profiles' copies on one browser (the oldest goes), each
//     at most 600 KB (the household's answer is ~160 KB).
const kidsTag = (pid) =>
  state.profile && state.profile.id === pid && state.profile.kids ? `~k${state.profile.kids.maxAge}` : "";
const HOME_KEY = (pid) => `aurora-home-${pid}${kidsTag(pid)}`;
const HOME_INDEX = "aurora-home-kept";
const HOME_MAX_AGE_MS = 24 * 3600 * 1000;
const HOME_MAX_CHARS = 600 * 1024;
const HOME_MAX_KEPT = 3;
const homeMemo = new Map(); // profile id + audience -> data
const lastHome = (pid) => {
  if (!pid) return null;
  if (homeMemo.has(pid + kidsTag(pid))) return homeMemo.get(pid + kidsTag(pid));
  try {
    const kept = JSON.parse(localStorage.getItem(HOME_KEY(pid)) || "null");
    const age = kept ? Date.now() - kept.at : -1;
    if (kept && age >= 0 && age < HOME_MAX_AGE_MS && kept.data && Array.isArray(kept.data.rows) &&
        // (records from before 2026-10-19 carry neither: the key alone vouched for them)
        (kept.pid === undefined || kept.pid === pid) && (kept.aud === undefined || kept.aud === kidsTag(pid))) {
      return kept.data;
    }
  } catch {}
  return null;
};
// The device's copy is written when the page is idle — a 160 KB string is a
// few milliseconds of main thread, not worth spending in the middle of a paint.
const idle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));
const keepOnDevice = (pid, data) => {
  const key = HOME_KEY(pid);
  const aud = kidsTag(pid);
  idle(() => {
    try {
      const text = JSON.stringify({ at: Date.now(), pid, aud, data });
      if (text.length > HOME_MAX_CHARS) return;
      let kept = [];
      try { kept = JSON.parse(localStorage.getItem(HOME_INDEX) || "[]"); } catch {}
      if (!Array.isArray(kept)) kept = [];
      const next = [key, ...kept.filter((k) => k !== key && typeof k === "string")];
      for (const old of next.slice(HOME_MAX_KEPT)) localStorage.removeItem(old);
      localStorage.setItem(key, text);
      localStorage.setItem(HOME_INDEX, JSON.stringify(next.slice(0, HOME_MAX_KEPT)));
    } catch {}
  });
};
const rememberHome = (pid, data, { device = true } = {}) => {
  if (!pid || !data || !Array.isArray(data.rows)) return;
  homeMemo.set(pid + kidsTag(pid), data);
  if (device) keepOnDevice(pid, data);
};

// The new answer only partly on screen and nothing touched for this long: the
// shelves on screen take it in place, slot by slot (homeMerge.js "idle").
const IDLE_APPLY_MS = 5000;
// A scroll (or a focus move) has ended: the shelves that left the screen take
// the new answer ("quiet" again, with the new view).
const VIEW_SETTLE_MS = 250;

// How long each billboard title holds before the next slides in. The focus-pull
// animation in screens.css is deliberately SHORTER than this: the art reaches
// fully sharp partway through and then simply stays there, so a longer dwell buys
// more time on a clear image rather than a slower blur.
const HERO_DWELL_MS = 9000;

// Session-lived scroll memory (module scope survives route changes)
let homeScrollY = 0;
// ...and where each shelf was scrolled sideways (row id -> scrollLeft), so
// coming back from a title finds the row you were browsing where you left
// it, instead of every shelf snapped back to its first card.
const rowScrollX = new Map();

// Put a shelf back where it was. Rows below the fold are `content-visibility:
// auto` — they have no layout yet, so a scrollLeft written now is clamped to
// 0; those wait until the row is about to come on screen.
const restoreRowScroll = (section, x) => {
  const scroller = section.querySelector(".row-scroller");
  if (!scroller || !x) return;
  const apply = () => {
    ensureRowFilled(scroller, x); // the shelf's tail may not be built yet
    scroller.scrollTo({ left: x, behavior: "instant" });
  };
  apply();
  if (scroller.scrollLeft >= x - 2 || !window.IntersectionObserver) return;
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    apply();
  }, { rootMargin: "320px 0px" });
  io.observe(section);
};

export const renderHome = async (root) => {
  const screen = el("div", { class: "screen" });
  const glass = () => document.documentElement.dataset.look === "glass";
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

  const pid = state.profile?.id;
  let data = lastHome(pid);
  const painted = !!data; // from the last answer: refreshed below, once the rows exist
  // (for the tests and the timing bench: what the shelves were first drawn from)
  screen.dataset.homeSrc = painted ? "snapshot" : "network";
  if (!data) try {
    data = await api.home(pid);
    rememberHome(pid, data);
  } catch {
    screen.innerHTML = "";
    screen.append(
      el("div", { class: "empty", style: { paddingTop: "30vh" } },
        el("div", { class: "glyph" }, "📡"),
        "Couldn't load the library — is the server awake?",
        el("div", { style: { marginTop: "14px" } },
          el("button", { "data-ui": "home.retry", class: "btn small focusable", onclick: () => navigate("#/") }, "Try again"))));
    return;
  }

  screen.innerHTML = "";

  // ----- hero -----
  let heroTimer = null;
  let heroAt = 0; // the slide on show (the merge keeps it)
  if (data.hero.length > 0) {
    let idx = 0;
    // The first billboard picture is the page's largest paint, and as a CSS
    // background it is only discovered once the slab is styled. Ask for it
    // now, at high priority — the layer below then finds it in the cache.
    // A portrait phone shows the poster (see the orientation rule in CSS).
    try {
      const first = data.hero[0];
      const portrait = matchMedia("(max-width: 900px) and (orientation: portrait)").matches;
      const src = portrait || !first.backdrop ? artUrl(first.cover, 400) : artUrl(first.backdrop, heroArtWidth());
      if (src) {
        const pre = new Image();
        pre.fetchPriority = "high";
        pre.src = src;
      }
    } catch {}
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
    let trailer = null; // the billboard's trailer player, built with the slab below
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
    // Tonight's picks (glass look): the billboard's titles as rows you can
    // step through, with a poster thumb — the dots' job, done legibly.
    const picks = el("div", { class: "hero-picks" },
      el("div", { class: "hero-picks-k" }, "Tonight's picks"),
      data.hero.map((h, j) =>
        el("button", { "data-ui": "home.hero.pick",
          class: "hero-pick focusable",
          "aria-label": h.title,
          onclick: () => go(j),
        },
          // lazy: the panel is hidden in both looks today, and a lazy image
          // with no layout box is never fetched
          h.cover ? el("img", { src: artUrl(h.cover, 80), alt: "", loading: "lazy" }) : el("span", { class: "hero-pick-thumb" }),
          el("span", { class: "hero-pick-text" },
            el("span", { class: "hero-pick-title" }, h.title),
            el("span", { class: "hero-pick-sub" }, h.source === "stream" ? "Stream" : h.type === "show" ? "In your library" : "On disk")))),
    );
    const dots = el("div", { class: "hero-dots" },
      data.hero.map((_, i) =>
        el("button", { "data-ui": "home.hero.pick",
          class: "hero-dot", "aria-label": `Show title ${i + 1}`,
          onclick: () => go(i),
        }, el("span", { class: i === 0 ? "on" : "" }))
      )
    );

    // `dir`: 1 = moving forward (slide in from the right), -1 = backward,
    // 0 = first paint (no slide).
    const count = data.hero.length;
    const show = (i, dir = 1) => {
      idx = i;
      heroAt = i;
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
      // sized for this screen — the catalogue's backdrops are 1920px JPEGs
      // of up to 1.3 MB, which a phone would have drawn 360px wide
      incoming.style.setProperty("--hero-art", item.backdrop ? `url("${artUrl(item.backdrop, heroArtWidth())}")` : "none");
      // the nav floats over this picture: tint its glass to match (glassTone.js)
      toneNavFromImage(item.backdrop ? artUrl(item.backdrop, heroArtWidth()) : null);
      incoming.style.setProperty("--hero-poster", `url("${artUrl(item.cover, 400)}")`);
      // under both: the picture's 16px placeholder, so a slide is never dark
      // while its art is on the way (blur.js)
      {
        const b = blurOf(item.backdrop) || blurOf(item.cover);
        incoming.style.setProperty("--hero-blur", b ? `url("${b}")` : "none");
      }
      // Painted small (a slow line, a narrow window)? The full-size picture
      // comes later, when the viewer is idle and the line has room
      // (artUpgrade.js) — the same picture, sharper.
      if (item.backdrop) upgradeArt(incoming, "--hero-art", item.backdrop, () => heroArtWidth({ full: true }));
      // On a portrait phone the poster IS the hero: the card-sized one painted
      // above is replaced by the large one straight away (decoded off screen,
      // then swapped: the same picture, sharper). Elsewhere it is a hidden
      // fallback layer and stays small.
      if (item.cover) {
        if (heroShowsPoster()) upgradeArt(incoming, "--hero-poster", heroCover(item.cover), () => Math.min(780, heroArtWidth({ full: true })), { now: true });
        else upgradeArt(incoming, "--hero-poster", item.cover, () => 400);
      }
      // The focus pull lives on the ::after veil, keyed to `.on` — toggling
      // the class across rotations restarts it, no forced reflow needed.
      incoming.classList.add("on");
      if (incoming !== layers[front]) {
        layers[front].classList.remove("on");
        front = 1 - front;
      }

      // The glass look hides the poster card (display:none still downloads
      // an <img>'s src) — only the classic look pays for it.
      if (!glass()) {
        heroPoster.src = artUrl(item.cover, 240);
        heroPoster.style.visibility = "visible";
      }
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
      [...picks.querySelectorAll(".hero-pick")].forEach((d, j) => d.classList.toggle("on", j === i));

      const meta = [];
      if (item.year) meta.push(String(item.year));
      if (item.type === "show" && item.episodeCount) meta.push(`${item.episodeCount} episodes`);
      else if (item.source === "stream") meta.push(item.type === "show" ? "Series" : "Film");
      if (item.duration) meta.push(fmtDuration(item.duration));
      if (item.genres && item.genres.length) meta.push(item.genres.slice(0, 3).join(" · "));
      const fmt = formatRow(item, { max: 4 });
      // Where you are in it — the glass look shows this as a small capsule under
      // the synopsis; the classic look leaves the billboard as it was.
      const prog = item.type !== "show" ? progressFor(item.id) : null;
      const mid = prog && !prog.finished && prog.position > 10 && prog.duration > 0 ? prog : null;

      info.innerHTML = "";
      // DOM append() stringifies null ("null" showed up under the synopsis
      // the first time a billboard title had no format badges) — filter first.
      info.append(...[
        el("div", { class: "hero-kicker" }, item.type === "show" ? "Series" : "Film"),
        el("h1", { class: "hero-title" }, item.title),
        el("div", { class: "hero-meta" },
          item.rating && el("span", { class: "rating-star" }, `★ ${item.rating}`),
          meta.join(" · "),
          fmt
        ),
        item.synopsis && el("p", { class: "hero-synopsis" }, item.synopsis),
        mid && el("div", { class: "hero-progress" },
          el("span", { class: "progress" }, el("i", { style: { width: `${Math.round((mid.position / mid.duration) * 100)}%` } })),
          el("span", {}, `${fmtClock(mid.position)} in · ${fmtDuration(mid.duration - mid.position)} left`)),
        el("div", { class: "hero-actions" },
          el("button", { "data-ui": "home.hero.play",
            class: "btn btn-primary focusable",
            html: icons.play + `<span>${item.source === "stream" ? "Stream" : "Play"}</span>`,
            onclick: () => {
              if (item.source === "stream") openItem(item); // -> Discover detail
              else if (item.type === "show") navigate(`#/show/${item.id}`);
              else navigate(`#/play/${item.id}`);
            },
          }),
          el("button", { "data-ui": "home.hero.details",
            class: "btn focusable",
            html: icons.info + "<span>Details</span>",
            onclick: () => openItem(item),
          })
        )
      ].filter(Boolean));
      // The picks panel shows a window of four around the active title, so a
      // long billboard never overflows the slab (glass look).
      const start = Math.max(0, Math.min(i - 1, count - 4));
      [...picks.querySelectorAll(".hero-pick")].forEach((d, j) => d.classList.toggle("hidden", j < start || j >= start + 4));
      if (trailer) trailer.arm(item, { visible: () => !pastHero });
      warmHero(item); // its page, once it has held still a moment
    };
    // (the first paint happens below, once the slab and its trailer layer exist)

    // Jump to a specific title (dot tap / swipe), and hold the auto-rotation
    // off for a while so it can't yank the hero away mid-browse.
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
      if (trailer && trailer.isActive()) return; // a trailer is on, or about to be: it ends the dwell itself
      if (!info.contains(document.activeElement)) show((idx + 1) % count, 1);
    }, HERO_DWELL_MS);

    // The trailer layer sits between the art and the scrim, so the text
    // stays legible over video exactly as over a still.
    const heroEl = el("div", { class: "hero" },
      layers[0],
      layers[1],
      el("div", { class: "hero-fade" }),
      el("div", { class: "hero-inner" }, info, heroPoster),
      dots,
      picks
    );
    trailer = createHeroTrailer(heroEl, {
      // a trailer that ran its course moves the billboard on
      onEnd: () => { if (!pastHero && !document.hidden) show((idx + 1) % count, 1); },
    });
    heroEl.insertBefore(trailer.layer, heroEl.querySelector(".hero-fade"));
    screen.append(heroEl);
    cleanups.push(() => trailer.destroy());
    show(0, 0);

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
        if (pastHero && trailer) trailer.stop(false);
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
  // The greeting (elia round 2): a proper headline — the name shines in
  // aurora gradient, and a cheeky line reads the profile's actual habits.
  if (state.profile) {
    const now = new Date();
    const h = now.getHours();
    const day = now.getDay();
    const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    const sub = el("div", { class: "greet-sub" }, " ");
    screen.append(el("div", { class: "home-greeting big" },
      el("div", { class: "greet-line" },
        (part === "Up late" ? "Up late, " : part + ", "),
        el("b", { class: "greet-name" }, state.profile.name),
        part === "Up late" ? "?" : ""),
      sub,
    ));
    // remark: stats-aware when we can, charming filler when we can't
    const daily = [
      "What's on the plate tonight — a movie, or a show?",
      "The watchlist isn't going to watch itself.",
      "Pick something good. No pressure.",
      "One episode. Sure. “One.”",
      "The couch is preheated.",
    ];
    const pickDaily = () => daily[(now.getFullYear() * 366 + now.getMonth() * 31 + now.getDate()) % daily.length];
    sub.textContent =
      day === 5 && h >= 17 ? "Friday. Movie night is legally required." :
      day === 6 && h >= 11 ? "Weekend. A double feature is fully justified." :
      pickDaily();
    api.wrapped(state.profile.id).then((w) => {
      if (!w || w.empty || !w.lastWatchedAt) return;
      const last = new Date(w.lastWatchedAt);
      const hoursSince = (now - last) / 36e5;
      if (hoursSince > 24 * 7) {
        sub.textContent = "Long time no see — the couch forgot your shape.";
      } else if (hoursSince < 36 && last.getHours() < 5 && h >= 6) {
        sub.textContent = "Someone was up late last night. No judgment. (Some judgment.)";
      }
    }).catch(() => {});
  }

  // Watching together right now: a strip above the shelves with who is
  // hosting what, one press to join. Live over party_list.
  const partyStrip = el("div", { class: "party-strip hidden" });
  screen.append(partyStrip);
  const paintParties = (parties) => {
    partyStrip.innerHTML = "";
    const list = (parties || []).filter((p) => p.code);
    partyStrip.classList.toggle("hidden", list.length === 0);
    for (const p of list) {
      partyStrip.append(
        el(
          "button",
          { class: "party-strip-item focusable", onclick: () => navigate(`#/party/${p.code}`) },
          el("span", { class: "party-strip-icon" }, "👥"),
          el(
            "span",
            { class: "party-strip-text" },
            el("strong", {}, p.host),
            ` is watching ${p.title} together`,
            el("span", { class: "party-strip-sub" }, ` · ${p.members} watching · code ${p.code}`),
          ),
          el("span", { class: "party-strip-cta" }, "Join"),
        ),
      );
    }
  };
  api.parties().then((d) => paintParties(d.parties)).catch(() => {});
  const unsubParties = onMessage("party_list", ({ parties }) => {
    if (!screen.isConnected) return unsubParties();
    paintParties(parties);
  });

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
  // `idx`: the row's position — the first few are on screen at once, so their
  // leading cards fetch their art eagerly (the rest stay lazy).
  const buildRow = (r, idx) => {
    const eagerCards = idx < EAGER_ROWS ? 3 : 0;
    const node =
      r.id === "continue" && state.profile
        ? continueRow(r.title, r.items, state.profile.id, api, { eagerCards })
        : shelfRow(r.title, r.items, { showKind: true, eagerCards, sub: r.sub || "" });
    if (node) {
      node.dataset.rowId = r.id;
      node.dataset.kind = r.id === "continue" ? "continue" : "shelf";
      node.dataset.sig = rowSig(r);
    }
    return node;
  };
  // Append, then put the shelf back where it was (a detached node can't scroll).
  const place = (node, r) => {
    if (!node) return;
    rowsHost.append(node);
    restoreRowScroll(node, rowScrollX.get(r.id));
  };
  // What a shelf shows, as one string: a refresh only rebuilds the shelves
  // whose contents actually changed (see the library_updated handler).
  const rowSig = (r) =>
    r.title + "|" + (r.items || []).map((i) => `${i.id || i.imdbId}:${i.newEpisodeCount || 0}:${(i.badge && i.badge.text) || ""}`).join(",");

  const renderRows = (rows) => {
    const token = ++renderToken;
    rowsHost.innerHTML = "";
    rows.slice(0, EAGER_ROWS).forEach((r, i) => place(buildRow(r, i), r));

    let i = EAGER_ROWS;
    const pump = () => {
      if (token !== renderToken) return; // superseded by a newer render
      if (i >= rows.length) return;
      place(buildRow(rows[i], i), rows[i]);
      i++;
      setTimeout(pump, 0); // setTimeout, not rAF: robust if frames are throttled
    };
    if (rows.length > EAGER_ROWS) setTimeout(pump, 0);
  };
  // ----- fresh data, without moving what the viewer is looking at -----
  // The server's newer answer goes in by homeMerge.js's rule: the shelves
  // from the top down to the last one on screen keep their places, the cards
  // on screen keep theirs (their data — progress, a NEW tag — updates in
  // place), the focused card never moves, the billboard keeps its slide; the
  // rest takes the new answer at once, and the held parts catch up at the
  // natural moments: a scroll that ends ("quiet" again, with the new view),
  // five seconds without a touch ("idle": on-screen shelves update slot by
  // slot, cross-faded), leaving Home ("away": what comes back is the new
  // answer, around the place you left).
  let shown = data; // what the page shows now
  let fresh = null; // the newest answer
  let pending = false;
  const rowNodes = () => {
    const m = new Map();
    for (const node of rowsHost.children) if (node.dataset.rowId) m.set(node.dataset.rowId, node);
    return m;
  };
  // What the viewer can see, in the merge's terms.
  const look = () => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const ids = shown.rows.map((r) => r.id);
    const rows = [];
    let above = 0;
    for (const node of rowsHost.children) {
      const id = node.dataset.rowId;
      if (!id) continue;
      const i = ids.indexOf(id);
      const box = node.getBoundingClientRect();
      if (box.bottom <= 0) { above = Math.max(above, i + 1); continue; }
      if (box.top >= vh || box.height === 0) continue;
      let from = -1;
      let to = 0;
      const cards = node.querySelector(".row-scroller");
      [...(cards ? cards.children : [])].forEach((c, j) => {
        const b = c.getBoundingClientRect();
        if (b.width > 0 && b.right > 0 && b.left < vw) {
          if (from < 0) from = j;
          to = j + 1;
        }
      });
      rows.push({ id, from: Math.max(0, from), to });
    }
    let focus = null;
    const a = document.activeElement;
    const c = a && a.closest ? a.closest("[data-row-id] .row-scroller > .card") : null;
    if (c && rowsHost.contains(c) && c._item) {
      const id = c.closest("[data-row-id]").dataset.rowId;
      const r = shown.rows.find((x) => x.id === id);
      const index = r ? r.items.findIndex((x) => x === c._item || itemKey(x) === itemKey(c._item)) : -1;
      if (index >= 0) focus = { rowId: id, key: itemKey(c._item), index };
    }
    // (the billboard keeps its list while Home is up: its dots and picks are built once)
    return { rows, above, focus, heroVisible: true, heroIndex: heroAt };
  };
  let lastLook = null;
  // The page now shows `next` instead of `prev`: only what differs is touched.
  const patchRows = (prev, next) => {
    ++renderToken; // a first-render pump still adding shelves stops; they are built here
    // the billboard: same list (held), each pick's data in place
    if (next.hero !== prev.hero && next.hero.length === data.hero.length) {
      for (let j = 0; j < next.hero.length; j++) data.hero[j] = next.hero[j];
    }
    const have = rowNodes();
    const prevById = new Map(prev.rows.map((r) => [r.id, r]));
    const want = new Set(next.rows.map((r) => r.id));
    const nodes = [];
    next.rows.forEach((r, i) => {
      const node = have.get(r.id);
      const before = prevById.get(r.id);
      if (!(r.items || []).length) return; // a shelf with nothing in it draws nothing
      if (node && before === r) return nodes.push(node);
      if (node &&
          patchShelf(node, r.items, before && before.title === r.title && (before.sub || "") === (r.sub || "") ? {} : { title: r.title, sub: r.sub || "" })) {
        node.dataset.sig = rowSig(r);
        return nodes.push(node);
      }
      const built = buildRow(r, i);
      if (!built) return;
      if (node) node.replaceWith(built);
      nodes.push(built);
    });
    for (const [id, node] of have) if (!want.has(id) || !nodes.includes(node)) node.remove();
    // into the new order, moving only what is out of place (a node that is
    // already where it belongs is never re-inserted: that resets a scroller)
    let cursor = rowsHost.firstElementChild;
    for (const node of nodes) {
      if (node === cursor) { cursor = node.nextElementSibling; continue; }
      const x = node.querySelector(".row-scroller");
      const keepX = x ? x.scrollLeft : 0;
      rowsHost.insertBefore(node, cursor);
      if (x && Math.abs(x.scrollLeft - keepX) > 2) x.scrollTo({ left: keepX, behavior: "instant" });
    }
  };
  let idleTimer = 0;
  let viewTimer = 0;
  const applyFresh = (mode) => {
    if (!fresh || !shown || !screen.isConnected) return;
    const v = look();
    lastLook = v;
    const locks = locksFor(mode, v, shown.rows);
    const r = mergeHome(shown, fresh, locks);
    pending = r.pending;
    if (r.home !== shown) {
      const moved = visibleMoves(shown, r.home, v);
      patchRows(shown, r.home);
      shown = r.home;
      screen.dataset.homeMoved = String((Number(screen.dataset.homeMoved) || 0) + (mode === "quiet" ? moved : 0));
    }
    screen.dataset.homeFresh = pending ? "pending" : "merged";
    // "idle" counts from the viewer's last touch, not from the server's last
    // answer: a new answer does not put it off (onActivity does)
    if (!pending) {
      clearTimeout(idleTimer);
      idleTimer = 0;
    } else if (!idleTimer) idleTimer = setTimeout(onIdle, IDLE_APPLY_MS);
  };
  const onIdle = () => {
    idleTimer = 0;
    applyFresh("idle");
  };
  const takeFresh = (next) => {
    rememberHome(pid, next);
    fresh = next;
    if (screen.isConnected) applyFresh("quiet");
  };
  // anything the viewer does puts "idle" off; a scroll or a focus move that
  // has ended is the moment for shelves that left the screen to catch up
  const onActivity = (e) => {
    if (!pending) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, IDLE_APPLY_MS);
    if (e.type === "scroll" || e.type === "focusin") {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => applyFresh("quiet"), VIEW_SETTLE_MS);
    }
    if (e.type === "pointerdown" || e.type === "keydown") lastLook = look();
  };
  // A card taken off a shelf by hand (Continue Watching's ✕) — or put back
  // (Undo, a failed removal): what the page shows is read back from the shelf,
  // and a removed title leaves the newest answer too, so no merge returns it.
  rowsHost.addEventListener("aurora-shelf-changed", (e) => {
    const section = e.target && e.target.closest ? e.target.closest("[data-row-id]") : null;
    const scroller = section && section.querySelector(".row-scroller");
    if (!scroller || !shown) return;
    const id = section.dataset.rowId;
    const built = [...scroller.children].map((c) => c._item).filter(Boolean);
    const all = scroller._rowItems || [];
    const last = Math.max(-1, ...built.map((x) => all.indexOf(x)));
    const items = scroller._fillRow ? [...built, ...all.slice(last + 1).filter((x) => !built.includes(x))] : built;
    const before = (shown.rows.find((r) => r.id === id) || { items: [] }).items;
    const gone = new Set(before.filter((x) => !items.includes(x)).map(itemKey));
    scroller._rowItems = items;
    shown = { ...shown, rows: shown.rows.map((r) => (r.id === id ? { ...r, items } : r)) };
    if (fresh && gone.size) fresh = { ...fresh, rows: fresh.rows.map((r) => (r.id === id ? { ...r, items: r.items.filter((x) => !gone.has(itemKey(x))) } : r)) };
  });
  const ACTIVITY = ["scroll", "pointerdown", "keydown", "wheel", "touchstart", "focusin"];
  for (const t of ACTIVITY) document.addEventListener(t, onActivity, { passive: true, capture: true });
  cleanups.push(() => {
    for (const t of ACTIVITY) document.removeEventListener(t, onActivity, { capture: true });
    clearTimeout(idleTimer);
    clearTimeout(viewTimer);
    // leaving Home ("away"): what comes back is the new answer, around the
    // place the viewer left (the shelves above it and the one they were in)
    if (fresh && pending && shown) {
      const v = screen.isConnected ? look() : lastLook || { rows: [], above: 0, focus: null, heroVisible: false, heroIndex: heroAt };
      const r = mergeHome(shown, fresh, locksFor("away", v, shown.rows));
      rememberHome(pid, r.home, { device: false });
    } else if (shown) rememberHome(pid, shown, { device: false });
  });

  renderRows(data.rows);
  requestAnimationFrame(homeUsable); // [analytics] "Home is usable": the first row's cards are on the screen
  try { performance.mark("aurora-home-rows", { detail: { from: screen.dataset.homeSrc } }); } catch {}
  prefetchFromHome(data); // Continue Watching's next titles, quietly, at idle
  if (painted) {
    api.home(pid).then((next) => {
      takeFresh(next);
      try { performance.mark("aurora-home-fresh"); } catch {}
    }).catch(() => {});
  } else {
    fresh = data;
    screen.dataset.homeFresh = "merged";
  }

  // Refresh rows when the library changes (new files, OCR finished...)
  const unsub = onMessage("library_updated", async () => {
    try {
      const next = await api.home(state.profile?.id);
      if (!screen.isConnected) return rememberHome(state.profile?.id, next);
      takeFresh(next);
    } catch {}
  });

  // Coming back from a title lands where you left, not at the hero again.
  const stopRestore = restoreScrollY(homeScrollY);

  return () => {
    homeScrollY = window.scrollY || document.body.scrollTop || 0;
    for (const node of rowsHost.querySelectorAll("[data-row-id]")) {
      const scroller = node.querySelector(".row-scroller");
      if (scroller) rowScrollX.set(node.dataset.rowId, scroller.scrollLeft);
    }
    stopRestore();
    if (heroTimer) clearInterval(heroTimer);
    for (const fn of cleanups) fn();
    unsub();
    unsubParties();
  };
};

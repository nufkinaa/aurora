// Shared pieces of the detail page: the hero block and the library-side
// "My List" button. The page itself lives in discover-detail.js, which serves
// library titles and streamable titles as one screen.
import { el, icons, resBadge, toast, listAddedLine, LIST_REMOVED, listFailedLine, posterImg, artUrl, formatRow, heroArtWidth, smooth, haptic } from "../ui.js";
import { upgradeArt } from "../artUpgrade.js";
import { blurOf } from "../blur.js";
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
    haptic(8);
    paint();
    try {
      const res = await api.toggleWatchlist(state.profile.id, item.id, inList);
      toast(inList ? listAddedLine(res) : LIST_REMOVED, inList ? "➕" : "➖");
    } catch {
      // it did not happen: the button goes back, and says so
      const adding = inList;
      inList = !inList;
      paint();
      toast(listFailedLine(adding), "⚠️");
    }
  });
  return btn;
};

export const heroBlock = (item, actions, metaParts, { rateKey = null, serverInfo = null } = {}) => {
  const hero = heroNode(item, actions, metaParts, { rateKey, serverInfo });
  // the two pictures ride on the hero itself (custom properties inherit), so
  // the backdrop layer AND the phone's cover block can both draw from them
  hero.style.setProperty("--hero-art", item.backdrop ? `url("${artUrl(item.backdrop, heroArtWidth())}")` : "none");
  const toneHash = location.hash;
  import("../glassTone.js").then((g) => {
    // the nav floats over the backdrop (the poster, on a phone): tint its glass to match
    if (location.hash !== toneHash) return; // already on another screen
    const phone = window.innerWidth <= 720;
    g.toneNavFromImage(phone && item.cover ? artUrl(item.cover, Math.min(600, heroArtWidth())) : item.backdrop ? artUrl(item.backdrop, heroArtWidth()) : null);
  }).catch(() => {});
  hero.style.setProperty("--hero-poster", item.cover ? `url("${artUrl(item.cover, Math.min(600, heroArtWidth()))}")` : "none");
  {
    const b = blurOf(item.backdrop) || blurOf(item.cover);
    hero.style.setProperty("--hero-blur", b ? `url("${b}")` : "none");
  }
  // painted small on a slow line? the full picture follows when idle (artUpgrade.js)
  if (item.backdrop) upgradeArt(hero, "--hero-art", item.backdrop, () => heroArtWidth({ full: true }));
  if (item.cover) upgradeArt(hero, "--hero-poster", item.cover, () => Math.min(600, heroArtWidth({ full: true })));
  coverDrift(hero);
  return hero;
};

// The phone's cover drifts: as the page scrolls up over it the picture moves
// at under half the page's speed and its words fade, and a pull down past the
// top (the rubber band) swells it a little — the Apple TV app's gesture, in
// CSS variables the cover's styles read (glass.css: --py, --pf, --pz). One
// passive scroll listener, one frame per change, gone with the hero. Skipped
// for reduced motion.
const coverDrift = (hero) => {
  if (window.innerWidth > 720 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let raf = 0;
  const paint = () => {
    raf = 0;
    if (!hero.isConnected) return window.removeEventListener("scroll", onScroll);
    const head = hero.querySelector(".detail-head");
    if (!head) return;
    const y = window.scrollY || 0;
    const h = head.offsetHeight || 1;
    if (y > h * 1.2) return; // long gone — nothing to move
    head.style.setProperty("--py", String(Math.max(0, Math.round(y))));
    head.style.setProperty("--pf", Math.min(1, Math.max(0, (y - h * 0.18) / (h * 0.5))).toFixed(3));
    head.style.setProperty("--pz", y < 0 ? Math.min(0.25, -y / 600).toFixed(3) : "0");
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(paint); };
  window.addEventListener("scroll", onScroll, { passive: true });
};

const heroNode = (item, actions, metaParts, { rateKey = null, serverInfo = null } = {}) => {
  return el("div", { class: "detail-hero" },
    (item.backdrop || item.cover) && backdropLayer(item),
    el("div", { class: "hero-fade" }),
    item.cover
      ? posterImg(item.cover, item.title, "detail-poster", "detail-poster card-fallback", { w: 300 })
      : el("div", { class: "detail-poster card-fallback" }, item.title),
    el("div", { class: "detail-info" },
      // The head — kicker, title, the meta line. On wide screens the wrapper
      // is `display: contents` (nothing changes); on a phone it IS the cover:
      // the poster fills it and these three sit on its lower part, so
      // everything above Play is on the picture and Play comes right under
      // it (elia's report from the iPhone).
      el("div", { class: "detail-head" },
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
        // CC rides in the format row (formatBadges appends it last) — the
        // separate badge that used to follow printed it twice
        formatRow(item, { max: 6 }),
      ),
      ), // .detail-head
      item.genres && item.genres.length > 0 &&
        el("div", { class: "genre-chips" },
          item.genres.map((g) => el("span", { class: "chip static" }, g))
        ),
      item.synopsis && synopsisBlock(item.synopsis),
      rateKey && state.profile &&
        el("div", { class: "detail-rate" },
          el("span", { class: "detail-rate-label" }, "Your rating"),
          starRating(rateKey),
          // What the server holds of this title (the glass side card shows
          // it; the classic look keeps the rating alone). Lines are
          // [text, tone] pairs; tone "ok" reads green, "dim" quiet.
          serverInfo && serverInfo.length > 0 &&
            el("div", { class: "detail-server" },
              el("span", { class: "detail-server-k" }, "On this server"),
              ...serverInfo.map(([text, tone]) => el("div", { class: tone || "" }, text))),
        ),
      actionsBlock(labelled(actions))
    )
  );
};

// The one thing to do (Play, Resume, Save & watch) and everything else. On a
// wide screen the inner wrapper is `display: contents` — one row of buttons,
// as before; on a phone it is its own strip that scrolls sideways under a
// full-width Play (responsive.css).
const actionsBlock = (actions) => {
  const list = (actions || []).filter(Boolean);
  const primary = list.filter((b) => b.classList && b.classList.contains("btn-primary"));
  const rest = list.filter((b) => !primary.includes(b));
  return el("div", { class: "detail-actions" }, primary, rest.length ? el("div", { class: "detail-actions-more" }, rest) : null);
};

// Both pictures handed to CSS as variables (the same trick the home
// billboard uses): the landscape art for wide screens, the POSTER for a
// portrait phone, where a 16:9 crop is a sliver of someone's shoulder.
// Sized for the screen: a 1920px catalogue backdrop is a megabyte a phone
// never needed (the server resizes, imgvariant.js). setProperty, not the
// style object — custom properties can't be assigned as properties.
const backdropLayer = (item) => el("div", { class: `hero-backdrop ${item.backdrop ? "sharp" : ""}` });

// The phone draws the secondary actions as icon tiles with a word under
// each; an icon-only button (download to device, mark watched) carries its
// word in `title` — copy it into a span the tile can show. Hidden on wide
// screens (details.css: .btn-label).
const labelled = (actions) => {
  for (const b of actions || []) {
    if (!b || !b.querySelector || b.querySelector(".btn-label")) continue;
    // no readable word on it: an icon-only button, or an emoji alone (📱)
    const text = (b.textContent || "").replace(/[\p{Extended_Pictographic}\s\uFE0F]/gu, "");
    if (text) continue;
    // the shorter of the two names — a title is often a whole sentence
    const names = [b.getAttribute("aria-label"), b.getAttribute("title")].filter(Boolean).sort((a, c) => a.length - c.length);
    const word = names[0];
    if (word) b.append(el("span", { class: "btn-label" }, word.replace(/\s*[—–-].*$/, "").replace(/\s+(?:on|to) this device$/, "")));
  }
  return actions;
};

// The synopsis is clamped (five lines wide, three on a phone) — and used to
// be cut there with no way to read the rest. A "More" appears only when
// something was actually cut, and toggles the clamp.
const synopsisBlock = (text) => {
  const p = el("p", { class: "detail-synopsis" }, text);
  const more = el("button", { class: "syn-more focusable hidden", type: "button" }, "More");
  more.addEventListener("click", () => smooth(() => {
    const open = p.classList.toggle("open");
    more.textContent = open ? "Less" : "More";
  }));
  const check = () => {
    if (!p.isConnected || p.classList.contains("open")) return;
    more.classList.toggle("hidden", p.scrollHeight <= p.clientHeight + 2);
  };
  requestAnimationFrame(check);
  setTimeout(check, 400); // fonts / late metadata
  return el("div", { class: "detail-synopsis-wrap" }, p, more);
};

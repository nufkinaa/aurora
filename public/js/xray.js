// X-Ray: who is in this, who made it, what people thought — as one panel,
// used in two places: the title page (it takes over everything under the
// hero) and the player (a sheet over the paused film).
//
// For a series the panel is about ONE EPISODE at a time. A stepper at the
// top walks the episodes; each has its own guest cast, director, writers,
// rating and air date (the server's media/xray.js asks for them by number).
// An anthology — Black Mirror, Modern Love: no cast of its own — leads with
// the episode and has no series cast at all; a regular series shows the
// episode's guests first and the regulars under them.
import { el, artUrl } from "./ui.js";
import { api } from "./api.js";
import { lite } from "./net.js";

const person = (p, link = true) => {
  const initials = p.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const face = el("div", { class: "xr-face" }, initials);
  if (p.photo) {
    const img = el("img", { src: artUrl(p.photo, 96), alt: "", loading: "lazy", decoding: "async" });
    img.onerror = () => img.remove(); // the initials underneath stay
    face.append(img);
  }
  // over a paused film a tap must not leave the player: plain cards there
  return el(
    link ? "a" : "div",
    link
      ? { class: "xr-person focusable", href: `#/search/${encodeURIComponent(p.name)}`, title: `Search for ${p.name}` }
      : { class: "xr-person" },
    face,
    el("div", { class: "xr-person-text" },
      el("div", { class: "xr-name" }, p.name),
      p.role && el("div", { class: "xr-role" }, p.role)),
  );
};

// On a slow line (net.js) fewer faces are fetched up front — the rest wait
// behind "Show all" — and each portrait is asked for at the size it is drawn.
const people = (title, list, { max = lite() ? 6 : 12, link = true } = {}) => {
  if (!list || !list.length) return null;
  const person1 = (p) => person(p, link);
  const grid = el("div", { class: "xr-people" }, list.slice(0, max).map(person1));
  const wrap = el("section", { class: "xr-section" }, el("h3", {}, title, el("span", { class: "xr-count" }, String(list.length))), grid);
  if (list.length > max) {
    const more = el("button", {
      class: "xr-more focusable",
      onclick: () => {
        grid.append(...list.slice(max).map(person1));
        more.remove();
      },
    }, `Show all ${list.length}`);
    wrap.append(more);
  }
  return wrap;
};

const ratingTile = (label, value, sub) =>
  el("div", { class: "xr-rating" },
    el("div", { class: "xr-rating-v" }, value),
    el("div", { class: "xr-rating-k" }, label),
    sub && el("div", { class: "xr-rating-s" }, sub));

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  // a date with no time is that calendar day everywhere — not the evening
  // before, west of Greenwich
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric", ...(dayOnly ? { timeZone: "UTC" } : {}) });
};

const skeleton = () =>
  el("div", { class: "xr-loading" },
    el("div", { class: "skeleton", style: { height: "22px", width: "180px", marginBottom: "14px" } }),
    el("div", { class: "xr-people" }, [0, 1, 2, 3, 4, 5].map(() => el("div", { class: "xr-person" }, el("div", { class: "xr-face skeleton" }), el("div", { class: "xr-person-text" }, el("div", { class: "skeleton", style: { height: "12px", width: "110px" } }))))));

// { type: "movie"|"series", imdbId, season?, episode?, keys?: rating keys,
//   onClose, closeLabel } → the panel element.
// `fallback`: an answer kept from earlier (a saved-offline copy carries its
// own) — used when the server cannot be asked.
export const xrayPanel = ({ type, imdbId, season = null, episode = null, keys = [], onClose, closeLabel = "Back to the title", link = true, fallback = null }) => {
  const isShow = type === "series" || type === "show";
  let cur = isShow && season && episode ? { season: +season, episode: +episode } : null;
  let episodes = [];
  let token = 0;
  const body = el("div", { class: "xr-body" }, skeleton());
  const stepper = el("div", { class: "xr-stepper" });
  const panel = el("div", { class: "xray-panel" },
    el("div", { class: "xr-top" },
      el("div", { class: "xr-brand" }, el("span", { class: "xr-badge" }, "X-Ray"), el("span", { class: "xr-sub" }, isShow ? "this episode, and the series" : "cast, crew and ratings")),
      stepper,
      onClose && el("button", { class: "btn small focusable xr-close", onclick: onClose }, closeLabel)),
    body);

  const paintStepper = () => {
    stepper.innerHTML = "";
    if (!isShow || !cur || !episodes.length) return;
    const i = episodes.findIndex((e) => e.season === cur.season && e.episode === cur.episode);
    const go = (d) => {
      const next = episodes[i + d];
      if (next) { cur = { season: next.season, episode: next.episode }; load(); }
    };
    const select = el("select", { class: "xr-select focusable", "aria-label": "Episode", onchange: (e) => {
      const [s, n] = e.target.value.split("x").map(Number);
      cur = { season: s, episode: n };
      load();
    } }, episodes.map((e) => el("option", { value: `${e.season}x${e.episode}`, ...(e.season === cur.season && e.episode === cur.episode ? { selected: true } : {}) }, `S${e.season} · E${e.episode}${e.title ? ` — ${e.title}` : ""}`)));
    stepper.append(
      el("button", { class: "xr-step focusable", "aria-label": "Previous episode", ...(i <= 0 ? { disabled: true } : {}), onclick: () => go(-1) }, "‹"),
      select,
      el("button", { class: "xr-step focusable", "aria-label": "Next episode", ...(i < 0 || i >= episodes.length - 1 ? { disabled: true } : {}), onclick: () => go(1) }, "›"),
    );
  };

  const paint = (x) => {
    const out = [];
    // an episode the sources know nothing about (no guests, no synopsis) is
    // not worth an empty box — the series' own sections still show
    const ep = x.episode && (x.episode.guests.length || x.episode.overview || x.episode.still) ? x.episode : null;
    if (ep) {
      const meta = [fmtDate(ep.aired), ep.runtime, ep.rating && `★ ${ep.rating.value} on ${ep.rating.source}`].filter(Boolean).join(" · ");
      out.push(el("section", { class: "xr-section xr-episode" },
        ep.still && el("img", { class: "xr-still", src: artUrl(ep.still, lite() ? 260 : 420), alt: "", loading: "lazy", onerror: (e) => e.target.remove() }),
        el("div", { class: "xr-episode-text" },
          el("div", { class: "xr-kicker" }, `Season ${ep.season} · Episode ${ep.episode}`),
          el("h2", {}, ep.title),
          meta && el("div", { class: "xr-meta" }, meta),
          ep.overview && el("p", { class: "xr-overview" }, ep.overview),
          (ep.directors.length || ep.writers.length) && el("div", { class: "xr-credits" },
            ep.directors.length ? el("span", {}, el("b", {}, "Directed by "), ep.directors.join(", ")) : null,
            ep.writers.length ? el("span", {}, el("b", {}, "Written by "), ep.writers.join(", ")) : null))));
      out.push(people(x.anthology ? "In this episode" : "Guest stars in this episode", ep.guests, { link }));
    }
    out.push(people(isShow ? "Series cast" : "Cast", x.cast, { link }));

    const tiles = (x.ratings || []).map((r) => ratingTile(r.source, `${r.value}`, r.votes ? `${r.votes.toLocaleString()} votes` : `out of ${r.scale}`));
    if (x.household) tiles.push(ratingTile("This household", `★ ${x.household.stars}`, `${x.household.count} rating${x.household.count === 1 ? "" : "s"} · out of 5`));
    if (tiles.length) out.push(el("section", { class: "xr-section" }, el("h3", {}, "Ratings"), el("div", { class: "xr-ratings" }, tiles)));

    const crew = x.crew || [];
    const facts = x.facts || [];
    if (crew.length || facts.length) {
      const byJob = new Map();
      for (const c of crew) byJob.set(c.job, [...(byJob.get(c.job) || []), c.name]);
      out.push(el("section", { class: "xr-section" }, el("h3", {}, isShow ? "About the series" : "About the film"),
        el("dl", { class: "xr-facts" },
          [...byJob.entries()].flatMap(([job, names]) => [el("dt", {}, job), el("dd", {}, names.join(", "))]),
          // a bare ISO date ("2010-07-16") reads as a date, like the episode's
          facts.flatMap((f) => [el("dt", {}, f.label), el("dd", {}, (/^\d{4}-\d{2}-\d{2}$/.test(f.value) && fmtDate(f.value)) || f.value)]))));
    }
    const shown = out.filter(Boolean);
    body.replaceChildren(...(shown.length ? shown : [el("div", { class: "xr-empty" }, "Nothing is known about this one yet.")]));
  };

  const load = async () => {
    const mine = ++token;
    paintStepper();
    body.classList.add("xr-busy");
    try {
      let x;
      try {
        x = await api.xray({ type: isShow ? "series" : "movie", imdbId, season: cur && cur.season, episode: cur && cur.episode, keys });
        if (x.error) throw new Error(x.error);
      } catch (e) {
        if (!fallback) throw e;
        // the kept answer is about ONE episode — it must not be shown under
        // another one's name (the list can outlive the server in a cache)
        const fe = fallback.episode;
        if (fe && cur && (fe.season !== cur.season || fe.episode !== cur.episode)) throw e;
        x = { ...fallback, episodes: [] };
      }
      if (mine !== token) return;
      episodes = x.episodes || [];
      // a series opened with no episode in mind starts at its first
      if (isShow && !cur && episodes.length) {
        cur = { season: episodes[0].season, episode: episodes[0].episode };
        return load();
      }
      paintStepper();
      paint(x);
    } catch (e) {
      if (mine !== token) return;
      body.replaceChildren(el("div", { class: "xr-empty" }, "X-Ray couldn't load right now.",
        el("div", { style: { marginTop: "12px" } }, el("button", { class: "btn small focusable", onclick: load }, "Try again"))));
    } finally {
      if (mine === token) body.classList.remove("xr-busy");
    }
  };
  load();
  panel.setEpisode = (s, n) => {
    if (!isShow || !s || !n || (cur && cur.season === +s && cur.episode === +n)) return;
    cur = { season: +s, episode: +n };
    load();
  };
  return panel;
};

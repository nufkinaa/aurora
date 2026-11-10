// A fuller household calendar than calendar-seed.js: a dozen made-up titles
// with posters, their releases spread over this month and the next — what the
// month grid looks like in real use (test/ui/calendar-grid.test.js takes the
// QA pictures from it; the TV/phone QA server uses it too). Dates are relative
// to TODAY in this machine's time zone, as in calendar-seed.js.
//
// Posters: drawn here as small SVGs (a gradient, a shape, the title), as
// data: URLs — nothing leaves the machine. `posterUrl` can swap them for
// served files (the device QA server renders them to PNG: React Native draws
// no SVG).
"use strict";

const base = require("./calendar-seed");

const { day } = base;

// [imdbId, title, type, why, palette [from, to, ink], shape]
const TITLES = [
  ["tt8300001", "The Salt Road", "show", "list", ["#1d4e89", "#0b1a33", "#f4d58d"], "sun"],
  ["tt8300002", "Northern Static", "show", "list", ["#3a0f4d", "#0d0717", "#7ef0ff"], "wave"],
  ["tt8300003", "Kingdom of Ash", "show", "follow", ["#5c1a0b", "#140504", "#ffb36b"], "crown"],
  ["tt8300004", "Low Orbit", "show", "list", ["#0b3b3a", "#03100f", "#b6ffe0"], "ring"],
  ["tt8300005", "The Ninth Hour", "show", "list", ["#2b2b2b", "#080808", "#e9e2d0"], "moon"],
  ["tt8300006", "Velvet District", "show", "follow", ["#6b0f3a", "#16030c", "#ffc2dd"], "bars"],
  ["tt8300007", "Small Hours", "show", "list", ["#24304f", "#0a0e19", "#ffd479"], "moon"],
  ["tt8300008", "הבית ברחוב הירקון", "show", "list", ["#5a4a12", "#141004", "#fff1b8"], "sun"],
  ["tt8300009", "Ember & Frost", "movie", "list", ["#7a2b0c", "#0e1a2b", "#ffe2c4"], "wave"],
  ["tt8300010", "Signal Lost", "movie", "list", ["#10312a", "#050b09", "#9dffb0"], "ring"],
  ["tt8300011", "Arcadia Bay", "movie", "list", ["#1b5e6b", "#06171b", "#fff4d6"], "sun"],
  ["tt8300012", "Paper Lanterns", "movie", "list", ["#6b1d1d", "#170606", "#ffd9a8"], "crown"],
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SHAPES = {
  sun: (c) => `<circle cx="100" cy="118" r="54" fill="${c}" opacity="0.9"/><rect x="0" y="150" width="200" height="150" fill="#000" opacity="0.35"/>`,
  moon: (c) => `<circle cx="112" cy="104" r="46" fill="${c}"/><circle cx="132" cy="92" r="42" fill="#000" opacity="0.55"/>`,
  wave: (c) => `<path d="M0 150 Q50 110 100 150 T200 150 V300 H0z" fill="${c}" opacity="0.5"/><path d="M0 178 Q50 140 100 178 T200 178 V300 H0z" fill="${c}" opacity="0.35"/>`,
  ring: (c) => `<circle cx="100" cy="112" r="58" fill="none" stroke="${c}" stroke-width="7"/><circle cx="100" cy="112" r="20" fill="${c}"/>`,
  crown: (c) => `<path d="M40 150 L56 86 L82 124 L100 70 L118 124 L144 86 L160 150z" fill="${c}"/>`,
  bars: (c) => [0, 1, 2, 3, 4].map((i) => `<rect x="${28 + i * 30}" y="${60 + (i % 2) * 24}" width="14" height="${110 - (i % 2) * 24}" rx="7" fill="${c}" opacity="${0.5 + i * 0.1}"/>`).join(""),
};
// A poster as SVG text.
const posterSvg = (title, [from, to, ink], shape) => {
  const words = String(title).split(" ");
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + " " + w).length <= 12) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  const text = lines.slice(0, 3).map((l, i) => `<text x="100" y="${232 + i * 24 - (lines.length - 1) * 12}" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="700" fill="${ink}" letter-spacing="1">${esc(l)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="200" height="300" fill="url(#g)"/>${SHAPES[shape](ink)}${text}<rect x="0.5" y="0.5" width="199" height="299" fill="none" stroke="#fff" stroke-opacity="0.12"/></svg>`;
};
const dataUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const posters = () => Object.fromEntries(TITLES.map(([id, title, , , pal, shape]) => [id, posterSvg(title, pal, shape)]));

// Episodes [season, episode, daysFromToday, name?] and films' dates.
const SCHEDULE = {
  tt8300001: [[2, 1, -9, "The Long Coast"], [2, 2, -2], [2, 3, 5], [2, 4, 12], [2, 5, 19]],
  tt8300002: [[1, 4, -6], [1, 5, 1, "Interference"], [1, 6, 8], [1, 7, 15], [1, 8, 22]],
  tt8300003: [[3, 1, 3, "Cinders"], [3, 2, 3], [3, 3, 10], [3, 4, 17]],
  tt8300004: Array.from({ length: 8 }, (_, i) => [1, i + 1, 6]),
  tt8300005: [[4, 7, 0, "Before Dawn"], [4, 8, 7, "The Ninth Hour"]],
  tt8300006: [[1, 8, -200], [2, 1, 26, "Rouge"]],
  tt8300007: [[1, 3, -4], [1, 4, 3], [1, 5, 10]],
  tt8300008: [[1, 2, 1], [1, 3, 8]],
};
const FILMS = {
  tt8300009: { theatrical: -12, home: 24 },
  tt8300010: { theatrical: 14, home: 70 },
  tt8300011: { theatrical: -80, home: -3 },
  tt8300012: { theatrical: 31, home: null },
};

const series = (imdbId, title, poster, eps) => ({
  at: Date.now(),
  v: 4,
  data: {
    id: imdbId, type: "show", imdbId, title, year: 2025, poster, backdrop: null, logo: null,
    synopsis: "", genres: [], rating: null, runtime: null, cast: [], director: null,
    seasons: Object.values(eps.reduce((acc, [s, e, n, name]) => {
      (acc[s] = acc[s] || { number: s, episodes: [] }).episodes.push({ season: s, episode: e, title: name || `Episode ${e}`, overview: "", thumbnail: null, released: day(n) });
      return acc;
    }, {})),
    episodeCount: eps.length, tmdbId: null, trailers: [], certificate: null, kidsAge: null, originalLanguage: null,
  },
});
const film = (imdbId, title, poster) => ({
  at: Date.now(), v: 4,
  data: { id: imdbId, type: "movie", imdbId, title, year: new Date().getFullYear(), poster, backdrop: null, logo: null, synopsis: "", genres: [], rating: null, runtime: null, cast: [], director: null, seasons: null, episodeCount: null, tmdbId: null, trailers: [], certificate: null, kidsAge: null, originalLanguage: null },
});

// The caches: calendar-seed.js's five titles plus these, with posters.
// posterUrl(imdbId, svg) → the address a poster is shown from (default: a data: URL).
const seed = ({ posterUrl = (id, svg) => dataUrl(svg) } = {}) => {
  const b = base.seed();
  const svgs = posters();
  const poster = (id) => posterUrl(id, svgs[id]);
  const meta = { ...b["cache/meta.json"] };
  const avail = { ...b["cache/availability.json"], titles: { ...b["cache/availability.json"].titles } };
  for (const [id, title, type] of TITLES) {
    if (type === "show") meta[`series|${id}`] = series(id, title, poster(id), SCHEDULE[id]);
    else {
      meta[`movie|${id}`] = film(id, title, poster(id));
      const f = FILMS[id];
      avail.titles[id] = {
        home: f.home != null && f.home <= 0,
        homeAt: f.home == null ? null : Date.parse(day(f.home)),
        theatricalAt: f.theatrical == null ? null : Date.parse(day(f.theatrical)),
        streamed: null,
        at: Date.now(),
      };
    }
  }
  return { ...b, "cache/meta.json": meta, "cache/availability.json": avail };
};

// Put calendar-seed.js's titles and these in a profile's list (and follow the followed ones).
const fill = async (api, profile, showLibId, { posterUrl = (id, svg) => dataUrl(svg) } = {}) => {
  await base.fill(api, profile, showLibId);
  const h = await api.as(profile);
  const svgs = posters();
  for (const [id, title, type, why] of TITLES) {
    if (why === "follow") await api.ok("POST", `/api/profiles/${profile.id}/follow`, { imdbId: id, on: true, title }, h);
    else await api.ok("POST", `/api/profiles/${profile.id}/watchlist`, { stream: { imdbId: id, type, title, year: 2025, poster: posterUrl(id, svgs[id]) } }, h);
  }
};

module.exports = { seed, fill, posters, TITLES, SCHEDULE, FILMS, dataUrl };

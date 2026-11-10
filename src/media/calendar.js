// The Calendar (elia, 2026-11-09: "Let's have a calendar tab with all
// releases for series and movies a user has in its list.")
//
// One person's upcoming and recent releases, for everything they care about:
//
//   My List      films and shows they added (library ids and stream refs);
//   Following    the shows they follow (profiles.followsOf — the follow
//                feature's own list; what IT downloads is media/follows.js,
//                nothing here starts anything);
//   Watching     the shows they have played an episode of in the last
//                WATCHING_DAYS (the profile's shared title history).
//
// …deduped by IMDb id (one title, one set of dates, every reason it is here).
//
// WHAT IS A RELEASE
//   a show     every episode whose air date (Cinemeta's `released`) falls in
//              the window. Episodes of one show on one day (a whole season
//              dropped at once) are ONE entry: "8 new episodes", "S2 E1–E8".
//              An episode 1 makes it a premiere: "Season 2 premiere"
//              ("Series premiere" for season 1).
//   a film     its first cinema date and its first date at home (digital,
//              physical or TV) — TMDB's, through media/availability.js. Two
//              entries when both fall in the window. Without a TMDB key films
//              have no dates (the calendar then lists shows only).
//
// THE WINDOW  "Coming up" is today and the next AHEAD_DAYS days; "Recently out"
// the RECENT_DAYS days before today. Grouped by day, in the HOUSEHOLD's time
// zone (the server's clock — the admin's dates use the same, adminsummary
// clock()): today is the house's today, whatever device asks — unless the
// device names its own zone (?tz=, an IANA name; the month grid's apps do),
// then it is that device's today and its days.
//
// THE MONTH GRID (`grid`, 2026-11-10: elia, "make it look really like a
// calendar"). The apps draw whole months, six weeks each, so besides the two
// lists above the answer carries every day of the months a person can page
// through: the month before this one, this one, and on to the month that
// holds today + AHEAD_DAYS (four months as a rule, three or five at some turns) — plus the six days
// either side of them that a six-week grid shows greyed. One flat map, day →
// { label, date, items }, every day present (an empty day has items: []), so
// a picked day always has its heading. Same entries, same words as the lists;
// built in the same one pass over the same caches (a wider date filter costs
// nothing: every episode is looked at either way). Older apps (TV 5.9.1,
// phone 1.1.1) read only `upcoming`/`recent`/`counts`/`empty`, which keep
// their 60/14-day window and shape exactly.
//
// TIME ZONES. Both sources write most dates as midnight UTC
// ("2026-11-14T00:00:00.000Z"): that is a calendar DATE, not an instant, and
// read as an instant it would land on the 13th anywhere west of Greenwich. So
// a timestamp at exactly 00:00:00.000Z is the date it names, in every time
// zone; any other timestamp is a real moment (an air time) and lands on the
// household's day it falls in.
//
// THE WORDS are made here, so the website, the TV and the phone print the same
// ones (`what`, `detail`, `why`, `badge`, the day labels). Day labels follow
// the asking device's locale (?locale=, a BCP-47 tag) for weekday and month
// names; "Today", "Tomorrow" and "Yesterday" are the app's own English.
//
// ON THE SERVER, OR NOT. Each entry says whether the server has it (`state`
// have / partial / saving / waiting / none, and the badge for it). For what
// it has not, a released episode or a film out at home offers Save & watch
// (`canSave`): POST /api/profiles/:id/calendar/save → save() below, which is
// the title page's own Save & watch — the same pick (smartdl.pickSource: the
// ★ best clean copy, never a cinema recording, a dub or a release reported
// bad here) and the same download request, for this person. Only ever on a
// press: the calendar itself never downloads anything.
//
// CACHE-ONLY. The route reads cached metadata (discover.metaCached, which
// starts a background refresh of an old entry) and cached release dates
// (availability.cached). The daily round (refresh(), lib/daily.js
// "calendar") asks again for every title anyone's calendar holds, and a
// calendar with titles it knows nothing about yet warms a few in the
// background (warmFew) — so a new title's dates arrive within minutes.
"use strict";

const DAY_MS = 24 * 3600 * 1000;
const AHEAD_DAYS = 60;
const RECENT_DAYS = 14;
const WATCHING_DAYS = 120;
const MAX_TITLES = 200; // per person; a list longer than this keeps its newest
const MAX_WARM = 8; // titles a calendar visit may look up in the background
const IMDB = /^tt\d{4,12}$/;

// ---------- days ----------

// "2026-11-14" for a key, ms at its UTC midnight for arithmetic.
const keyMs = (key) => Date.parse(`${key}T00:00:00.000Z`);
const msKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (key, n) => msKey(keyMs(key) + n * DAY_MS);
const daysBetween = (a, b) => Math.round((keyMs(b) - keyMs(a)) / DAY_MS);
// months as "2026-11"
const monthOf = (key) => key.slice(0, 7);
const addMonths = (mk, n) => {
  const [y, m] = mk.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const lastOfMonth = (mk) => addDays(`${addMonths(mk, 1)}-01`, -1);
const GRID_EDGE = 6; // the other months' days a week row shows before the 1st
const GRID_TAIL = 14; // …and after the last (six rows: up to two weeks of the next month)

// A zone by its standard name ("eUrOpE/pArIs" → "Europe/Paris", "US/Pacific"
// → "America/Los_Angeles"), or null when it is not one. Intl takes a zone in
// any mix of capitals and by every old alias: asked for by name from outside
// (?tz=), only the standard name may key a cache — a few hundred of them,
// not every spelling a client can think of.
const canonTz = (tz) => {
  if (!tz || typeof tz !== "string" || tz.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};
const validTz = (tz) => !!canonTz(tz);

// (emptied when it grows past what a household's devices could ever name:
// offsets like "+05:30" are zones too, and there are thousands of those)
const DAY_FMTS_MAX = 100;
const dayFmts = new Map();
const dayFmt = (tz) => {
  let f = dayFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    if (dayFmts.size >= DAY_FMTS_MAX) dayFmts.clear();
    dayFmts.set(tz, f);
  }
  return f;
};
// The household's day an instant falls on.
const dayIn = (ms, tz) => {
  const parts = dayFmt(tz).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};

// A source's date → { day, at, dateOnly } in the household's zone, or null.
// `at` is when it counts as out: the instant itself, or — for a plain date —
// the start of that day (UTC midnight; what matters for a date is the day).
const MIDNIGHT_UTC = /T00:00(?::00(?:\.0+)?)?(?:Z|\+00:00)$/;
const readDate = (value, tz) => {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const dateOnly = value % DAY_MS === 0;
    return { day: dateOnly ? msKey(value) : dayIn(value, tz), at: value, dateOnly };
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { day: s, at: keyMs(s), dateOnly: true };
  const at = Date.parse(s);
  if (!Number.isFinite(at)) return null;
  if (MIDNIGHT_UTC.test(s)) return { day: s.slice(0, 10), at, dateOnly: true };
  return { day: dayIn(at, tz), at, dateOnly: false };
};

// Out yet? A real moment: once it has passed. A plain date: from that day on.
const isOut = (d, now, today) => (d.dateOnly ? d.day <= today : d.at <= now);

// ---------- day labels (the asking device's locale) ----------

const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const pickLocale = (asked, fallback = "en-GB") => {
  for (const l of [asked, fallback, "en-GB"]) {
    if (!l || !LOCALE_RE.test(String(l))) continue;
    try {
      if (Intl.DateTimeFormat.supportedLocalesOf([l]).length) return l;
    } catch {}
  }
  return "en-GB";
};
const fmtCache = new Map();
const fmt = (locale, opts) => {
  const k = `${locale}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" });
    if (fmtCache.size > 200) fmtCache.clear();
    fmtCache.set(k, f);
  }
  return f;
};
// { label, date } for a day as seen from `today`:
//   Today / Tomorrow / Yesterday            + "14 Nov"
//   within a week either side: "Friday"     + "14 Nov"
//   further: "Fri 28 Nov" (the locale's own order), no second line
const dayLabel = (day, today, locale) => {
  const ms = keyMs(day);
  const d = new Date(ms);
  const n = daysBetween(today, day);
  const date = fmt(locale, { day: "numeric", month: "short" }).format(d);
  if (n === 0) return { label: "Today", date };
  if (n === 1) return { label: "Tomorrow", date };
  if (n === -1) return { label: "Yesterday", date };
  if (Math.abs(n) <= 6) return { label: fmt(locale, { weekday: "long" }).format(d), date };
  return { label: fmt(locale, { weekday: "short", day: "numeric", month: "short" }).format(d), date: null };
};

// The first day of the week where the asking device lives: 0 Sunday … 6
// Saturday (Israel and the US start on Sunday, most of Europe on Monday).
// Intl's week data when the runtime has it, else a small table by region.
const SUNDAY_REGIONS = new Set(["US", "CA", "IL", "JP", "BR", "MX", "PH", "KR", "TW", "HK", "IN", "ZA", "AU", "SA", "PE", "CO", "VE", "AR", "GT", "PA", "DO", "PR", "SG", "TH", "ID", "MO", "KE", "PK", "BD", "NP", "ZW", "BZ", "BS", "JM", "TT", "HN", "NI", "SV", "PY", "BT", "KH", "LA", "MM", "MT", "WS", "UM", "VI", "GU", "AS", "MH", "ET", "MZ", "BW", "YE"]);
const SATURDAY_REGIONS = new Set(["AE", "AF", "BH", "DJ", "DZ", "EG", "IQ", "IR", "JO", "KW", "LY", "OM", "QA", "SD", "SY"]);
const weekStarts = new Map();
const weekStartOf = (locale) => {
  if (weekStarts.has(locale)) return weekStarts.get(locale);
  let start = 1;
  try {
    const loc = new Intl.Locale(locale);
    const info = typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : loc.weekInfo;
    if (info && Number(info.firstDay) >= 1 && Number(info.firstDay) <= 7) start = Number(info.firstDay) % 7;
    else {
      const region = loc.region || loc.maximize().region;
      start = SUNDAY_REGIONS.has(region) ? 0 : SATURDAY_REGIONS.has(region) ? 6 : 1;
    }
  } catch {}
  // (a locale tag takes any variant after its region: not one entry each, for ever)
  if (weekStarts.size >= 200) weekStarts.clear();
  weekStarts.set(locale, start);
  return start;
};
// A Sunday to name the weekdays from (4 Jan 2026 was one).
const SUNDAY_KEY = "2026-01-04";
// The weekday names in the device's order: [{ short: "Sun", narrow: "S" }, …]
const weekdayNames = (locale, start) =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date(keyMs(addDays(SUNDAY_KEY, (start + i) % 7)));
    return { short: fmt(locale, { weekday: "short" }).format(d), narrow: fmt(locale, { weekday: "narrow" }).format(d) };
  });
// A month's names: { month: "November", year: "2026", label: "November 2026" }
const monthNames = (mk, locale) => {
  const d = new Date(keyMs(`${mk}-15`));
  return {
    month: fmt(locale, { month: "long" }).format(d),
    year: fmt(locale, { year: "numeric" }).format(d),
    label: fmt(locale, { month: "long", year: "numeric" }).format(d),
  };
};

// ---------- words ----------

const WHY_WORDS = { list: "In My List", following: "Following", watching: "Watching" };
const WHY_ORDER = ["list", "following", "watching"];
const whyLine = (why) => WHY_ORDER.filter((w) => why.includes(w)).map((w) => WHY_WORDS[w]).join(" · ");

const plainEpTitle = (t, n) => {
  const s = String(t || "").trim();
  if (!s || new RegExp(`^(episode|ep\\.?)\\s*${n}$`, "i").test(s) || /^(episode|tba|tbd)\s*\d*$/i.test(s)) return null;
  return s;
};

// The words for a group of one show's episodes on one day.
const showWords = (eps) => {
  const first = eps[0];
  const last = eps[eps.length - 1];
  const premiere = eps.find((e) => Number(e.episode) === 1);
  let what;
  if (premiere) what = Number(premiere.season) === 1 ? "Series premiere" : `Season ${premiere.season} premiere`;
  else what = eps.length > 1 ? `${eps.length} new episodes` : "New episode";
  let detail;
  if (eps.length === 1) {
    const t = plainEpTitle(first.title, first.episode);
    detail = `S${first.season} E${first.episode}${t ? ` · ${t}` : ""}`;
  } else if (Number(first.season) === Number(last.season)) {
    detail = `S${first.season} E${first.episode}–E${last.episode}`;
    if (premiere) detail += ` · ${eps.length} episodes`;
  } else {
    detail = `S${first.season} E${first.episode} – S${last.season} E${last.episode}`;
  }
  return { what, detail, premiere: !!premiere };
};

const FILM_WORDS = { cinema: "In cinemas", home: "Out to stream or buy" };

// A month at a glance: "9 releases · 2 premieres · 1 film" (null: nothing).
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const monthLine = (items) => {
  if (!items.length) return null;
  const premieres = items.filter((e) => e.kind === "premiere").length;
  const films = new Set(items.filter((e) => e.type === "movie").map((e) => e.imdbId)).size;
  return [
    plural(items.length, "release", "releases"),
    premieres ? plural(premieres, "premiere", "premieres") : null,
    films ? plural(films, "film", "films") : null,
  ].filter(Boolean).join(" · ");
};
// How far off a day is, said the way the next-up line says it.
const whenWords = (n) => (n <= 0 ? "Today" : n === 1 ? "Tomorrow" : `In ${n} days`);

const BADGES = { have: "On the server", saving: "Saving", waiting: "Waiting for approval" };
const badgeFor = (state, owned, total) =>
  state === "partial" ? `${owned} of ${total} on the server` : BADGES[state] || null;

// ---------- the titles one person cares about ----------

// deps: { watchlist, follows, episodeRows, findById, imdbIdFor, now }
//   watchlist    profiles.getWatchlist — library id strings / stream refs
//   follows      profiles.followsOf — [{ imdbId, title, at }]
//   episodeRows  profiles.streamEpisodeProgress — { "tt1:2:3": { position, finished, updatedAt } }
// → [{ imdbId, type, title, year, poster, libId, why: [..] }] (no duplicates)
const collect = ({ watchlist = [], follows = [], episodeRows = {}, findById = () => null, imdbIdFor = () => null, now = Date.now() } = {}) => {
  const byId = new Map();
  const add = (imdbId, fields, why) => {
    if (!IMDB.test(String(imdbId || ""))) return;
    let t = byId.get(imdbId);
    if (!t) {
      t = { imdbId, type: fields.type === "movie" ? "movie" : "show", title: "", year: null, poster: null, libId: null, why: [], order: byId.size };
      byId.set(imdbId, t);
    }
    // the first source to know a field fills it; a library id is the strongest link
    if (!t.title && fields.title) t.title = String(fields.title);
    if (!t.year && fields.year) t.year = Number(fields.year) || null;
    if (!t.poster && fields.poster) t.poster = fields.poster;
    if (!t.libId && fields.libId) t.libId = fields.libId;
    if (fields.type && fields.type !== t.type && fields.strongType) t.type = fields.type === "movie" ? "movie" : "show";
    if (!t.why.includes(why)) t.why.push(why);
  };
  // My List, newest first (a list longer than MAX_TITLES keeps its newest)
  for (const entry of [...(watchlist || [])].reverse()) {
    if (typeof entry === "string") {
      const item = findById(entry);
      if (!item || (item.type !== "movie" && item.type !== "show")) continue;
      const imdbId = item.imdbId || imdbIdFor(item);
      add(imdbId, { type: item.type, title: item.title, year: item.year, poster: item.cover || null, libId: item.id, strongType: true }, "list");
    } else if (entry && typeof entry === "object") {
      const type = entry.type === "show" || entry.type === "series" ? "show" : "movie";
      add(entry.imdbId, { type, title: entry.title, year: entry.year, poster: entry.poster || null, strongType: true }, "list");
    }
  }
  for (const f of follows || []) {
    if (f && f.imdbId) add(f.imdbId, { type: "show", title: f.title }, "following");
  }
  const since = now - WATCHING_DAYS * DAY_MS;
  const watched = new Map(); // imdbId -> latest
  for (const [key, row] of Object.entries(episodeRows || {})) {
    const imdbId = key.split(":")[0];
    if (!row || !(row.position > 0 || row.finished)) continue;
    if (!((row.updatedAt || 0) >= since)) continue;
    watched.set(imdbId, Math.max(watched.get(imdbId) || 0, row.updatedAt || 0));
  }
  for (const [imdbId] of [...watched].sort((a, b) => b[1] - a[1])) add(imdbId, { type: "show" }, "watching");
  return [...byId.values()].slice(0, MAX_TITLES).map(({ order, ...t }) => t);
};

// ---------- the calendar ----------

// titles   collect()'s list
// deps     metaOf(imdbId) → the series meta ({ title, year, poster, seasons }) or null (shows)
//          filmOf(imdbId) → { title, year, poster } or null (films; may be null — the title from the list stands)
//          availOf(imdbId) → { homeAt, theatricalAt } or null (films)
//          ownedOf({ imdbId, type, title, year, season?, episode? }) → the library item or null
//          libraryOf({ imdbId, type, title, year }) → the library film/show or null (to open it)
//          jobOf({ imdbId, type, season?, episode? }) → a live download job or null
// opts     now, tz, locale, torrentsOn, aheadDays, recentDays,
//          grid: false → the two lists only, no `grid` / `next` (an app that
//          does not draw the month: forProfile)
const build = (titles, deps = {}, opts = {}) => {
  const now = opts.now || Date.now();
  const tz = canonTz(opts.tz) || "UTC";
  const locale = pickLocale(opts.locale);
  const ahead = opts.aheadDays || AHEAD_DAYS;
  const back = opts.recentDays || RECENT_DAYS;
  const today = dayIn(now, tz);
  const first = addDays(today, -back);
  const last = addDays(today, ahead);
  // the month grid's days (see THE MONTH GRID above): the month before this
  // one to the month holding the window's last day, and the greyed edges
  const months = [];
  for (let mk = addMonths(monthOf(today), -1); mk <= monthOf(last); mk = addMonths(mk, 1)) months.push(mk);
  const gridFrom = addDays(`${months[0]}-01`, -GRID_EDGE);
  const gridTo = addDays(lastOfMonth(months[months.length - 1]), GRID_TAIL);
  const from = first < gridFrom ? first : gridFrom;
  const to = last > gridTo ? last : gridTo;
  const torrentsOn = opts.torrentsOn !== false;
  const metaOf = deps.metaOf || (() => null);
  const filmOf = deps.filmOf || (() => null);
  const availOf = deps.availOf || (() => null);
  const ownedOf = deps.ownedOf || (() => null);
  const libraryOf = deps.libraryOf || (() => null);
  const jobOf = deps.jobOf || (() => null);

  const entries = [];
  let pending = 0; // titles whose dates are not known yet (metadata not fetched so far)
  const inWindow = (d) => d && d.day >= from && d.day <= to;

  // What to open: the library copy when there is one, else the catalogue page.
  const openCard = (t, meta) => {
    const lib = (t.libId && deps.findById ? deps.findById(t.libId) : null) || libraryOf({ imdbId: t.imdbId, type: t.type, title: t.title, year: t.year });
    const base = { imdbId: t.imdbId, type: t.type, title: (meta && meta.title) || t.title, year: (meta && meta.year) || t.year || null };
    if (lib && lib.id) return { ...base, id: lib.id, cover: lib.cover || t.poster || (meta && meta.poster) || null };
    return { ...base, id: `disc:${t.imdbId}`, cover: t.poster || (meta && meta.poster) || null, source: "stream" };
  };
  const jobState = (job) => (!job ? null : job.status === "pending" ? "waiting" : "saving");

  for (const t of titles) {
    if (t.type === "show") {
      const meta = metaOf(t.imdbId);
      if (!meta || !Array.isArray(meta.seasons)) {
        pending++;
        continue;
      }
      const title = meta.title || t.title || "";
      const byDay = new Map();
      for (const s of meta.seasons) {
        if (!(Number(s.number) > 0)) continue; // specials are not on the calendar
        for (const e of s.episodes || []) {
          const d = readDate(e.released, tz);
          if (!inWindow(d)) continue;
          const ep = { season: Number(s.number), episode: Number(e.episode), title: e.title || null, d };
          if (!Number.isFinite(ep.episode)) continue;
          if (!byDay.has(d.day)) byDay.set(d.day, []);
          byDay.get(d.day).push(ep);
        }
      }
      if (!byDay.size) continue;
      const card = openCard(t, meta);
      for (const [day, list] of byDay) {
        // one episode once (a source listing an episode twice); airing order
        const seen = new Set();
        const eps = list
          .sort((a, b) => a.season - b.season || a.episode - b.episode)
          .filter((e) => {
            const k = `${e.season}:${e.episode}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        const words = showWords(eps);
        const out = eps.every((e) => isOut(e.d, now, today));
        const ownedList = eps.map((e) => ownedOf({ imdbId: t.imdbId, type: "show", title, year: meta.year || t.year, season: e.season, episode: e.episode }));
        const owned = ownedList.filter(Boolean).length;
        // the first episode the server does not have: what Save & watch saves
        const missing = eps.find((e, i) => !ownedList[i]);
        const job = missing ? jobOf({ imdbId: t.imdbId, type: "show", season: missing.season, episode: missing.episode }) : null;
        const state = owned === eps.length ? "have" : jobState(job) || (owned ? "partial" : "none");
        const firstOwned = ownedList.find(Boolean);
        entries.push({
          key: `${t.imdbId}:${eps[0].season}:${eps[0].episode}`,
          kind: words.premiere ? "premiere" : "episode",
          type: "show",
          imdbId: t.imdbId,
          title,
          year: meta.year || t.year || null,
          poster: card.cover || meta.poster || null,
          backdrop: meta.backdrop || null,
          day,
          at: Math.min(...eps.map((e) => e.d.at)),
          what: words.what,
          detail: words.detail,
          season: eps[0].season,
          episode: eps[0].episode,
          episodes: eps.map((e) => ({ season: e.season, episode: e.episode, title: e.title })),
          why: whyLine(t.why),
          reasons: [...t.why],
          out,
          state,
          badge: badgeFor(state, owned, eps.length),
          canSave: torrentsOn && out && (state === "none" || state === "partial") && !!missing,
          save: missing ? { imdbId: t.imdbId, type: "show", season: missing.season, episode: missing.episode } : null,
          // the episode to play when the server has it (the first of the day's)
          play: firstOwned && firstOwned.id ? { id: firstOwned.id, showId: firstOwned.showId || null, season: Number(firstOwned.season) || null, episode: Number(firstOwned.episode) || null } : null,
          item: card,
        });
      }
    } else {
      const avail = availOf(t.imdbId);
      if (!avail) {
        if (deps.filmPending && deps.filmPending(t)) pending++;
        continue;
      }
      const film = filmOf(t.imdbId) || {};
      const title = film.title || t.title || "";
      const card = openCard(t, film);
      const lib = ownedOf({ imdbId: t.imdbId, type: "movie", title, year: film.year || t.year });
      const job = lib ? null : jobOf({ imdbId: t.imdbId, type: "movie" });
      const state = lib ? "have" : jobState(job) || "none";
      for (const kind of ["cinema", "home"]) {
        const d = readDate(kind === "cinema" ? avail.theatricalAt : avail.homeAt, tz);
        if (!inWindow(d)) continue;
        const out = isOut(d, now, today);
        entries.push({
          key: `${t.imdbId}:${kind}`,
          kind,
          type: "movie",
          imdbId: t.imdbId,
          title,
          year: film.year || t.year || null,
          poster: card.cover || film.poster || null,
          backdrop: film.backdrop || null,
          day: d.day,
          at: d.at,
          what: FILM_WORDS[kind],
          detail: null,
          why: whyLine(t.why),
          reasons: [...t.why],
          out,
          state,
          badge: badgeFor(state),
          // a film in cinemas has no copy worth saving; out at home, it may
          canSave: torrentsOn && out && kind === "home" && state === "none",
          save: kind === "home" ? { imdbId: t.imdbId, type: "movie" } : null,
          play: lib && lib.id ? { id: lib.id, showId: null, season: null, episode: null } : null,
          item: card,
        });
      }
    }
  }

  // premieres lead the day, then the earliest, then by name
  const dayOrder = (a, b) =>
    (b.kind === "premiere") - (a.kind === "premiere") || a.at - b.at || String(a.title).localeCompare(String(b.title));
  // Coming up: today onwards, soonest first. Recently out: before today, newest first.
  const group = (list, newestFirst) => {
    const days = new Map();
    for (const e of list) {
      if (!days.has(e.day)) days.set(e.day, []);
      days.get(e.day).push(e);
    }
    return [...days.keys()]
      .sort((a, b) => (newestFirst ? (a < b ? 1 : -1) : a < b ? -1 : 1))
      .map((day) => ({ day, ...dayLabel(day, today, locale), items: days.get(day).sort(dayOrder) }));
  };
  // (the two lists keep their own 60/14-day window: what older apps were built on)
  const upcoming = group(entries.filter((e) => e.day >= today && e.day <= last), false);
  const recent = group(entries.filter((e) => e.day < today && e.day >= first), true);
  const count = (g) => g.reduce((n, d) => n + d.items.length, 0);

  const lists = {
    tz,
    locale,
    today,
    aheadDays: ahead,
    recentDays: back,
    upcoming,
    recent,
    counts: { upcoming: count(upcoming), recent: count(recent), titles: titles.length },
    pending,
  };
  if (opts.grid === false) return lists;

  // The month grid: every day from gridFrom to gridTo, each with its heading.
  const byDay = {};
  for (let d = gridFrom; d <= gridTo; d = addDays(d, 1)) byDay[d] = { ...dayLabel(d, today, locale), items: [] };
  for (const e of entries) if (byDay[e.day]) byDay[e.day].items.push(e);
  for (const d of Object.values(byDay)) if (d.items.length > 1) d.items.sort(dayOrder);
  const weekStart = weekStartOf(locale);
  const grid = finishGrid({
    v: 1,
    from: gridFrom,
    to: gridTo,
    weekStart,
    weekdays: weekdayNames(locale, weekStart),
    months: months.map((key) => ({ key, ...monthNames(key, locale), first: `${key}-01`, last: lastOfMonth(key), count: 0, line: null })),
    byDay,
  });
  return { ...lists, grid, next: nextOf(grid, today) };
};

// A month's count and line, from the days it holds (again after a kids
// profile's gate has taken titles out: restrict() below).
const finishGrid = (grid) => ({
  ...grid,
  months: grid.months.map((m) => {
    const items = [];
    for (let d = m.first; d <= m.last; d = addDays(d, 1)) if (grid.byDay[d]) items.push(...grid.byDay[d].items);
    return { ...m, count: items.length, line: monthLine(items) };
  }),
});

// What comes next: the first release from today on that is not out yet —
// { key, day, title, what, kind, when: "Today" | "Tomorrow" | "In 3 days" }.
// Only as far as the last month's last day: the greyed days after it are on
// the grid, but nobody can page to them, and a line that leads nowhere is
// worse than none.
const nextOf = (grid, today) => {
  if (!grid || !grid.byDay) return null;
  const months = Array.isArray(grid.months) ? grid.months : [];
  const end = months.length ? months[months.length - 1].last : null;
  for (const day of Object.keys(grid.byDay).sort()) {
    if (day < today) continue;
    if (end && day > end) break;
    const e = grid.byDay[day].items.filter((x) => !x.out).sort((a, b) => a.at - b.at)[0];
    if (e) return { key: e.key, day, title: e.title, what: e.what, kind: e.kind, when: whenWords(daysBetween(today, day)) };
  }
  return null;
};

// The calendar with only the entries `keep(items) → items` lets through (a
// kids profile's gate, lib/kids.js): both lists, their counts, the grid's
// days, the months' lines and the next-up line, all made again.
const restrict = (body, keep) => {
  if (!body || typeof body !== "object") return body;
  const pick = (items) => (Array.isArray(items) ? keep(items) || [] : []);
  const days = (list) => (Array.isArray(list) ? list.map((d) => ({ ...d, items: pick(d.items) })).filter((d) => d.items.length > 0) : list);
  const upcoming = days(body.upcoming);
  const recent = days(body.recent);
  const n = (g) => (Array.isArray(g) ? g.reduce((t, d) => t + d.items.length, 0) : 0);
  const out = { ...body, upcoming, recent, counts: { ...(body.counts || {}), upcoming: n(upcoming), recent: n(recent) } };
  if (body.grid && body.grid.byDay && Array.isArray(body.grid.months)) {
    const byDay = {};
    for (const [d, v] of Object.entries(body.grid.byDay)) byDay[d] = { ...v, items: pick(v.items) };
    out.grid = finishGrid({ ...body.grid, byDay });
    out.next = nextOf(out.grid, body.today);
  }
  return out;
};

// The words a calendar with nothing in it says (both tabs, every app).
const EMPTY = {
  noTitles: "Add films and shows to My List, or follow a show, and their new episodes and release dates show up here.",
  upcoming: "Nothing coming up in the next 60 days for the titles in your list.",
  recent: "Nothing came out in the last 14 days for the titles in your list.",
  // the month grid's: a month with nothing on it, a picked day with nothing
  month: "Nothing out this month for the titles in your list.",
  day: "Nothing out on this day.",
  pending: (n) => `Still looking up the dates of ${n} ${n === 1 ? "title" : "titles"} — they show up here soon.`,
};

// ---------- wiring (the live modules; the pure parts above take them injected) ----------

const live = () => {
  const profiles = require("../profiles");
  const scanner = require("./scanner");
  const identity = require("./identity");
  const discover = require("./discover");
  const availability = require("./availability");
  const downloads = require("./downloads");
  return { profiles, scanner, identity, discover, availability, downloads };
};

const LIVE_JOB = new Set(["pending", "approved", "downloading"]);
const jobFinder = (jobs) => ({ imdbId, type, season, episode }) =>
  jobs.find(
    (j) =>
      LIVE_JOB.has(j.status) &&
      j.imdbId === imdbId &&
      (type === "show"
        ? j.type === "show" && Number(j.season) === Number(season) && Number(j.episode) === Number(episode)
        : j.type !== "show"),
  ) || null;

const titlesOf = (profileId, mods = live()) => {
  const { profiles, scanner, identity } = mods;
  try { identity.ensureStamped(); } catch {}
  return collect({
    watchlist: profiles.getWatchlist(profileId),
    follows: profiles.followsOf(profileId),
    episodeRows: profiles.streamEpisodeProgress(profileId),
    findById: (id) => scanner.findById(id),
    imdbIdFor: (item) => identity.imdbIdFor(item),
  });
};

const serverTz = () => {
  let tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch {}
  return validTz(tz) ? tz : "UTC";
};
const serverLocale = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().locale || "en-GB"; } catch { return "en-GB"; }
};

// One person's calendar, from the caches. Sync.
// grid: false — the two lists alone (what TV 5.9.1 and phone 1.1.1 ask for and
// read: the month's days would triple what they download for nothing).
const forProfile = (profileId, { locale = null, tz = null, grid = true, now = Date.now() } = {}, mods = live()) => {
  const { scanner, identity, discover, availability, downloads } = mods;
  const titles = titlesOf(profileId, mods);
  const maps = (() => { try { return identity._internals.libraryMaps(); } catch { return null; } })();
  const jobs = (() => { try { return downloads.list(); } catch { return []; } })();
  const torrentsOn = (() => { try { return require("../lib/torrentgate").enabled(); } catch { return true; } })();
  const result = build(
    titles,
    {
      metaOf: (id) => discover.metaCached("series", id),
      filmOf: (id) => discover.metaCached("movie", id),
      availOf: (id) => availability.cached(id),
      // a film whose dates are still to come in: one from this year or last
      // (older ones are out by now and have no dates worth asking for)
      filmPending: (t) => availability.isAmbiguous({ ...t, type: "movie" }, now) && !!require("../config").TMDB_KEY,
      ownedOf: (want) => identity.findLibraryPlayable(want, maps),
      libraryOf: (want) => identity.findLibraryFor(want, maps),
      findById: (id) => scanner.findById(id),
      jobOf: jobFinder(jobs),
    },
    // the asking device's zone when it names a real one, else the household's
    { now, tz: canonTz(tz) || serverTz(), locale: locale || serverLocale(), torrentsOn, grid },
  );
  // what is still unknown is looked up now, a few at a time, in the background
  warmFew(titles, mods).catch(() => {});
  return result;
};

// ---------- keeping the dates fresh ----------

let warming = false;
const warmFew = async (titles, mods = live(), max = MAX_WARM) => {
  if (warming) return 0;
  warming = true;
  const { discover, availability } = mods;
  let spent = 0;
  try {
    const films = [];
    for (const t of titles) {
      if (t.type === "movie") { films.push({ imdbId: t.imdbId, type: "movie", year: t.year }); continue; }
      if (spent >= max) continue;
      if (discover.metaCached("series", t.imdbId) || discover.metaRecentlyFailed("series", t.imdbId)) continue;
      spent++;
      await discover.meta("series", t.imdbId).catch(() => null);
    }
    // (availability.warm skips what it already knows, and old films)
    if (films.length) await availability.warm(films.filter((f) => !availability.cached(f.imdbId)).slice(0, max)).catch(() => {});
  } finally {
    warming = false;
  }
  return spent;
};

// The daily round ("calendar", lib/daily.js): every title on anyone's
// calendar is asked again — a show's episode list when its answer is a day
// old (a show that has not aired for half a year: once a week), a recent
// film's release dates when they are not settled. Two at a time.
const REFRESH_AGE_MS = 20 * 3600 * 1000;
const QUIET_REFRESH_MS = 7 * DAY_MS;
const QUIET_AFTER_MS = 180 * DAY_MS;
const MAX_REFRESH = 400;
const lastAired = (meta) => {
  let best = 0;
  for (const s of (meta && meta.seasons) || []) for (const e of s.episodes || []) {
    const t = Date.parse(e.released);
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
};
const dueForRefresh = (meta, age, now = Date.now()) => {
  if (!meta || age == null) return true;
  const quiet = now - lastAired(meta) > QUIET_AFTER_MS;
  return age >= (quiet ? QUIET_REFRESH_MS : REFRESH_AGE_MS);
};
const refresh = async (mods = live(), now = Date.now()) => {
  const { profiles, discover, availability } = mods;
  const shows = new Map();
  const films = new Map();
  for (const p of profiles.list()) {
    for (const t of titlesOf(p.id, mods)) (t.type === "show" ? shows : films).set(t.imdbId, t);
  }
  const todo = [];
  for (const id of shows.keys()) {
    const meta = discover.metaCached("series", id, now);
    if (dueForRefresh(meta, discover.metaAge("series", id, now), now)) todo.push(id);
    if (todo.length >= MAX_REFRESH) break;
  }
  let asked = 0;
  let failed = 0;
  const fetchOnce = discover._internals && discover._internals.fetchMetaOnce;
  for (let i = 0; i < todo.length; i += 2) {
    await Promise.all(
      todo.slice(i, i + 2).map((id) =>
        (fetchOnce ? fetchOnce("series", id) : discover.meta("series", id)).then(
          () => { asked++; },
          () => { failed++; },
        ),
      ),
    );
  }
  await availability.warm([...films.values()].map((t) => ({ imdbId: t.imdbId, type: "movie", year: t.year }))).catch(() => {});
  return `${shows.size} shows (${asked} asked again${failed ? `, ${failed} failed` : ""}), ${films.size} films`;
};

// ---------- Save & watch ----------

// The title page's Save & watch, for one calendar entry: the best source
// (smartdl.pickSource, the rule the TV's playBest and the website use) asked
// for as this person's download. Never called by anything but a press.
// → { ok: true, state, line, job? } | { ok: false, why, line }
const save = async (profileId, { imdbId, type, season = null, episode = null } = {}, mods = live()) => {
  const { profiles, discover, identity, downloads } = mods;
  const gate = require("../lib/torrentgate");
  if (!gate.enabled()) return { ok: false, why: "off", line: "Saving isn't switched on for this server." };
  if (!IMDB.test(String(imdbId || ""))) return { ok: false, why: "bad", line: "That title couldn't be found." };
  const isShow = type === "show" || type === "series";
  const s = isShow ? parseInt(season, 10) : null;
  const e = isShow ? parseInt(episode, 10) : null;
  if (isShow && !(s > 0 && e > 0)) return { ok: false, why: "bad", line: "That episode couldn't be found." };
  const meta = await discover.meta(isShow ? "series" : "movie", imdbId).catch(() => null);
  const title = (meta && meta.title) || "";
  const year = (meta && meta.year) || null;
  if (identity.findLibraryPlayable({ imdbId, type: isShow ? "show" : "movie", title, year, season: s, episode: e })) {
    return { ok: true, state: "have", line: "Already on the server" };
  }
  const torrent = require("./torrent");
  let streams = [];
  try {
    ({ streams } = await torrent.getSources(isShow ? "series" : "movie", imdbId, year, s, e));
  } catch {
    return { ok: false, why: "sources", line: "The source provider didn't answer — try again in a moment." };
  }
  // only copies someone is sharing (the title page drops dead ones the same way)
  const sharing = (streams || []).some((x) => x.seeders > 0) ? streams.filter((x) => x.seeders > 0) : streams || [];
  const pick = require("./smartdl")._internals.pickSource(sharing, null);
  if (!pick) {
    if (!isShow) {
      try {
        const st = require("./releasestatus").statusOf({ type: "movie", streams: sharing, avail: require("./availability").cached(imdbId) });
        if (st && st.line) return { ok: false, why: "none", line: st.line };
      } catch {}
    }
    return { ok: false, why: "none", line: isShow ? "No good copy of this episode yet — open the show to pick one." : "No good copy yet — open the film to pick one." };
  }
  const profile = profiles.list().find((p) => p.id === profileId) || null;
  const label = isShow ? `${title} · S${s} E${e}` : title;
  const r = downloads.create({
    infoHash: pick.infoHash,
    fileIdx: pick.fileIdx || 0,
    type: isShow ? "show" : "movie",
    imdbId,
    title,
    label,
    year,
    poster: (meta && meta.poster) || null,
    quality: pick.quality,
    sizeBytes: pick.sizeBytes || 0,
    season: s,
    episode: e,
    provider: pick.provider || null,
    release: pick.release || pick.filename || null,
    seeders: pick.seeders || 0,
    profile: profileId,
    profileName: profile ? profile.name : null,
  });
  if (r.error) return { ok: false, why: "refused", line: r.error };
  if (r.alreadyAvailable) return { ok: true, state: "have", line: "Already on the server" };
  if (r.duplicate) {
    const st = r.job && r.job.status === "pending" ? "waiting" : r.job && r.job.status === "done" ? "have" : "saving";
    return { ok: true, state: st, job: r.job || null, line: st === "have" ? "Already on the server" : "Already on its way — My downloads shows how far it has got" };
  }
  console.log(`[calendar] Save & watch: ${label} for ${profile ? profile.name : profileId}`);
  return r.needsApproval
    ? { ok: true, state: "waiting", job: r.job || null, line: "Asked — it starts once the admin approves it" }
    : { ok: true, state: "saving", job: r.job || null, line: "Saving — My downloads shows how far it has got" };
};

// What a card says once Save & watch answered (every app the same).
const afterSave = (entry, r) => {
  if (!r || !r.ok) return entry;
  const state = r.state === "have" ? "have" : r.state === "waiting" ? "waiting" : "saving";
  return { ...entry, state, badge: BADGES[state], canSave: false };
};

module.exports = {
  afterSave,
  forProfile,
  restrict,
  refresh,
  save,
  build,
  collect,
  EMPTY,
  _internals: {
    readDate, dayIn, dayLabel, pickLocale, showWords, whyLine, isOut, addDays, daysBetween, dueForRefresh, jobFinder, warmFew,
    addMonths, lastOfMonth, weekStartOf, weekdayNames, monthNames, monthLine, whenWords, nextOf, validTz, canonTz, dayFmts, weekStarts,
    AHEAD_DAYS, RECENT_DAYS, WATCHING_DAYS, MAX_TITLES,
  },
};

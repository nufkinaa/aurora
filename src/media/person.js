// A PERSON: who they are, a few portraits of them, and what they made — the
// sheet that opens when someone presses an actor or a director in X-Ray or on
// a title page (it used to throw them into Search).
//
// SOURCE: TMDB, and only TMDB (needs the server's tmdbApiKey).
//   /person/{id}?append_to_response=combined_credits,images,external_ids
// is ONE request that carries the biography, the IMDb id (nm…), every profile
// photo (TMDB's "profiles" are portraits OF the person — film stills live in
// a different list, tagged_images, which is never asked for) and the whole
// filmography, cast and crew, films and series, with vote counts to rank by.
// IMDb itself has no free API and its pages may not be scraped; the nm id is
// carried in the answer so a client can point at the person's IMDb page.
//
// A filmography entry is a TMDB title. My List (and the kids gate) speak IMDb
// ids and age ratings, so each title shown costs one more request the first
// time anyone sees it:
//   /movie/{id}?append_to_response=external_ids,release_dates
//   /tv/{id}?append_to_response=external_ids,content_ratings
// — the IMDb id and every country's certification at once. Those are kept on
// disk for months (an id never changes), six at a time, inside a time budget:
// what has not answered when the budget runs out is left out of THIS answer
// (`partial: true`) and is there on the next one.
//
// An id is what X-Ray hands out for a person:
//   "tmdb:525" / "525"      TMDB's own (films' cast and crew carry it)
//   "nm0634240"             an IMDb name id
//   "name:Bryan Cranston"   a bare name (TVMaze and Cinemeta give nothing
//                           else) — resolved through the credits of the title
//                           it was pressed on (`of` = that title's IMDb id),
//                           and only then by a name search
//
// Everything network-facing is injectable (`create`) so test/person.test.js
// runs without a key, a disk or a connection.
const path = require("path");

const UA = { "User-Agent": "Aurora/1.6 (personal media server; person sheet)" };
const V = 1;
const PERSON_TTL = 14 * 24 * 3600 * 1000;
const PARTIAL_TTL = 3600 * 1000; // an answer missing a part is asked again soon
const RESOLVE_TTL = 90 * 24 * 3600 * 1000;
const MISS_TTL = 24 * 3600 * 1000;
const TITLE_TTL = 120 * 24 * 3600 * 1000;
const TITLE_UNRATED_TTL = 7 * 24 * 3600 * 1000; // no certificate yet: boards catch up
const MAX_PEOPLE = 250; // ~15 kB each
const MAX_TITLES = 8000; // ~90 bytes each
const KEEP_CREDITS = 90; // per person, on disk
const MAX_CREDITS = 40; // per answer
const MAX_PHOTOS = 8;
const LEAD_QUOTA = 30;
const SIDE_QUOTA = 6;
const BUDGET_MS = 4500;
const PARALLEL = 6;
const IMG = "https://image.tmdb.org/t/p";

const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const quiet = (p) => p.catch(() => null);
const yearOf = (d) => { const y = parseInt(String(d || "").slice(0, 4), 10); return y > 1870 && y < 2200 ? y : null; };

// ---------- ids ----------
const parseId = (raw) => {
  const s = String(raw == null ? "" : raw).trim();
  if (!s || s.length > 120) return null;
  let m;
  if ((m = /^(?:tmdb:)?(\d{1,9})$/.exec(s))) return { kind: "tmdb", id: Number(m[1]) };
  if (/^nm\d{5,10}$/.test(s)) return { kind: "imdb", id: s };
  const name = s.replace(/^name:/i, "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80 || /[<>{}\\]/.test(name) || !norm(name)) return null;
  return { kind: "name", name };
};

// ---------- the filmography ----------
// TMDB's crew jobs → the handful of things a household says about a person.
const JOBS = [
  [/^(co-)?director$/i, "directing", "Director"],
  [/^(creator|series creator)$/i, "creating", "Creator"],
  [/^(writer|co-writer|screenplay|story|teleplay|screenstory|author|novel)$/i, "writing", "Writer"],
  [/^(executive producer|producer|co-producer)$/i, "producing", "Producer"],
  [/^(original music composer|music|composer)$/i, "music", "Composer"],
  [/^director of photography$/i, "camera", "Cinematographer"],
  [/^editor$/i, "editing", "Editor"],
];
const DEPT_LABEL = { acting: "Acting", directing: "Directing", creating: "Created", writing: "Writing", producing: "Producing", music: "Music", camera: "Cinematography", editing: "Editing" };
// Which of those leads the sheet, by what TMDB says the person is known for:
// a director's sheet opens on what they directed, not on their cameos.
const ORDER = {
  Directing: ["directing", "creating", "writing", "acting", "producing", "music", "camera", "editing"],
  Writing: ["writing", "creating", "directing", "acting", "producing", "music", "camera", "editing"],
  Creator: ["creating", "writing", "directing", "acting", "producing", "music", "camera", "editing"],
  Production: ["producing", "creating", "directing", "writing", "acting", "music", "camera", "editing"],
  Sound: ["music", "acting", "directing", "creating", "writing", "producing", "camera", "editing"],
  Camera: ["camera", "directing", "acting", "creating", "writing", "producing", "music", "editing"],
  Editing: ["editing", "directing", "acting", "creating", "writing", "producing", "music", "camera"],
  Acting: ["acting", "directing", "creating", "writing", "producing", "music", "camera", "editing"],
};
const orderFor = (knownFor) => ORDER[knownFor] || ORDER.Acting;

// Appearing as oneself is not a role: chat shows, award nights, making-ofs.
const SELF = /\b(self|himself|herself|themselves|themself)\b|\b(archive footage|archival footage)\b/i;
const TALK = new Set([10767, 10763]); // TV genres: Talk, News
const REALITY = 10764;
const DOCUMENTARY = 99;

// TMDB's person answer → what is kept on disk: the facts, the portraits (file
// paths), and the filmography folded to one entry per title.
//   credit: { k: "m"|"t", id, t: title, y: year, p: poster path, v: votes,
//             r: rating, roles: { acting: "Dom Cobb", directing: "Director" },
//             minor: true (only ever as themselves), s: score }
const slim = (p) => {
  const cc = p.combined_credits || {};
  const by = new Map();
  const entry = (c) => {
    const k = c.media_type === "tv" ? "t" : c.media_type === "movie" ? "m" : null;
    const title = c.title || c.name;
    if (!k || !c.id || !title || c.adult) return null;
    const key = `${k}:${c.id}`;
    let e = by.get(key);
    if (!e) {
      e = { k, id: c.id, t: String(title).slice(0, 140), y: yearOf(c.release_date || c.first_air_date), p: c.poster_path || null, v: c.vote_count || 0, r: c.vote_average ? Math.round(c.vote_average * 10) / 10 : null, roles: {} };
      by.set(key, e);
    }
    return e;
  };
  for (const c of cc.cast || []) {
    const genres = c.genre_ids || [];
    if (c.media_type === "tv" && genres.some((g) => TALK.has(g))) continue; // a guest on a sofa
    const character = String(c.character || "").trim();
    const self = SELF.test(character) || (!character && (genres.includes(DOCUMENTARY) || genres.includes(REALITY)));
    const e = entry(c);
    if (!e) continue;
    if (self) {
      if (!e.roles.acting) e.self = true;
      continue;
    }
    e.self = false;
    // weight: a lead in a film is the whole film; one episode of a long
    // series is a guest spot, however famous the series
    let w = 1;
    if (c.media_type === "tv" && c.episode_count > 0 && c.episode_count <= 2) w = 0.2;
    if (/\buncredited\b/i.test(character)) w *= 0.3;
    if (!character) w *= 0.6;
    const role = character.replace(/\s*\((voice|uncredited)\)\s*/gi, (m0, what) => (what.toLowerCase() === "voice" ? " (voice)" : "")).trim().slice(0, 80);
    if (!e.roles.acting) e.roles.acting = role || "Actor";
    else if (role && !norm(e.roles.acting).includes(norm(role)) && e.roles.acting.length < 60) e.roles.acting += ` / ${role}`;
    e.wa = Math.max(e.wa || 0, w);
  }
  for (const c of cc.crew || []) {
    const job = JOBS.find(([re]) => re.test(String(c.job || "")));
    if (!job) continue;
    const e = entry(c);
    if (!e) continue;
    if (!e.roles[job[1]]) e.roles[job[1]] = job[2];
  }
  const credits = [];
  for (const e of by.values()) {
    const depts = Object.keys(e.roles);
    if (!depts.length) {
      if (!e.self) continue;
      e.minor = true; // only ever as themselves: kept for someone with nothing else
      e.roles = { acting: "Self" };
    }
    // notability: how many people rated the title (TMDB's vote count), scaled
    // down for a guest spot when acting is all there is
    const onlyActing = depts.length === 1 && depts[0] === "acting";
    e.s = Math.round((e.v + 1) * (onlyActing ? e.wa || 1 : 1) * (e.minor ? 0.02 : 1) * 100) / 100;
    delete e.wa; delete e.self;
    credits.push(e);
  }
  credits.sort((a, b) => b.s - a.s);
  const profiles = ((p.images && p.images.profiles) || [])
    .filter((i) => i && i.file_path && (!i.aspect_ratio || (i.aspect_ratio > 0.55 && i.aspect_ratio < 0.85)))
    .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0) || (b.vote_average || 0) - (a.vote_average || 0))
    .map((i) => i.file_path);
  const photos = [...new Set([p.profile_path, ...profiles].filter(Boolean))].slice(0, MAX_PHOTOS);
  return {
    tmdbId: p.id,
    imdbId: (p.external_ids && p.external_ids.imdb_id) || p.imdb_id || null,
    name: p.name || "",
    knownFor: p.known_for_department || null,
    born: p.birthday || null,
    died: p.deathday || null,
    place: p.place_of_birth || null,
    bio: shortBio(p.biography),
    adult: !!p.adult,
    photos,
    credits: credits.slice(0, KEEP_CREDITS),
  };
};

// The first sentences of the biography, to about 420 characters.
const shortBio = (text) => {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= 420) return s || null;
  const cut = s.slice(0, 420);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (stop > 160 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "") + "…");
};

// Which entries an answer shows, in which order. Pure.
//   `owned(credit)`: is this one in the household's library (it leads its
//   group — what can be played tonight comes first).
// One department LEADS with up to LEAD_QUOTA titles; each other department
// follows with its SIDE_QUOTA best, and what room is left goes to the best of
// the rest; MAX_CREDITS in all. The lead is what TMDB says the person is
// known for — unless their directing / creating / writing clearly outweighs
// it (Greta Gerwig is filed under Acting; her sheet should open on Barbie).
// Someone who has only ever appeared as themselves still gets those.
const LEAD_TAKEOVER = ["directing", "creating", "writing"];
const choose = (person, { owned = () => false, max = MAX_CREDITS } = {}) => {
  let order = orderFor(person.knownFor);
  const real = person.credits.filter((c) => !c.minor);
  let pool = real.length >= 4 ? real : person.credits;
  // a "credit" from before they were born is somebody else's, misfiled
  const born = yearOf(person.born);
  if (born) pool = pool.filter((c) => !c.y || c.y >= born);
  // obscure entries (nobody rated them) only when there is little else
  const known = pool.filter((c) => c.v >= 3);
  if (known.length >= 8) pool = known;
  const weight = (dept) => pool.filter((c) => c.roles[dept]).sort((a, b) => b.s - a.s).slice(0, 5).reduce((sum, c) => sum + c.s, 0);
  let lead = order.find((d) => pool.some((c) => c.roles[d])) || order[0];
  if (!LEAD_TAKEOVER.includes(lead)) {
    const rivals = LEAD_TAKEOVER.map((d) => ({ d, w: weight(d) }));
    const top = Math.max(...rivals.map((r) => r.w));
    // (directing before writing when they are close: "Director · Writer")
    const rival = rivals.find((r) => r.w >= top * 0.6);
    if (rival && top > weight(lead) * 1.5) lead = rival.d;
  }
  order = [lead, ...order.filter((d) => d !== lead)];
  const groups = new Map(order.map((d) => [d, []]));
  for (const c of pool) {
    const dept = order.find((d) => c.roles[d]);
    if (dept) groups.get(dept).push({ credit: c, dept, owned: !!owned(c) });
  }
  for (const list of groups.values()) list.sort((a, b) => b.owned - a.owned || b.credit.s - a.credit.s);
  const take = new Map(order.map((d) => [d, Math.min(groups.get(d).length, d === lead ? LEAD_QUOTA : SIDE_QUOTA)]));
  const total = () => [...take.values()].reduce((a, b) => a + b, 0);
  while (total() > max) {
    // (only with a smaller `max` than the quotas add up to: trim from the back)
    const d = [...order].reverse().find((x) => take.get(x) > 0);
    take.set(d, take.get(d) - 1);
  }
  // room left: the best of what the quotas held back, wherever it sits
  while (total() < max) {
    let best = null;
    for (const d of order) {
      const next = groups.get(d)[take.get(d)];
      if (next && (!best || next.credit.s > best.next.credit.s)) best = { d, next };
    }
    if (!best) break;
    take.set(best.d, take.get(best.d) + 1);
  }
  return order.flatMap((d) => groups.get(d).slice(0, take.get(d)));
};

// What the credit says under its title: the character for an acting credit,
// the job(s) otherwise — the group's own role first.
const roleLine = (credit, dept) => {
  const order = [dept, ...ORDER.Acting.filter((d) => d !== dept && credit.roles[d])];
  return order.map((d) => credit.roles[d]).filter(Boolean).slice(0, 3).join(" · ");
};

// ---------- the module, with its seams ----------
const create = (deps = {}) => {
  const now = deps.now || (() => Date.now());
  const key = () => (deps.key !== undefined ? deps.key : require("../config").TMDB_KEY);
  const stores = {};
  const store = (name, file) => {
    if (deps[name]) return deps[name];
    if (!stores[name]) {
      const { JsonStore } = require("../lib/jsonstore");
      stores[name] = new JsonStore(path.join(require("../config").CACHE_DIR, file), {});
    }
    return stores[name];
  };
  const people = () => store("store", "person.json");
  const titles = () => store("titleStore", "person-titles.json");
  const getJson = deps.getJson || (async (p) => {
    const res = await fetch(`https://api.themoviedb.org/3${p}${p.includes("?") ? "&" : "?"}api_key=${key()}`, { headers: UA, signal: AbortSignal.timeout(7000) });
    if (!res.ok) {
      const e = new Error(`tmdb ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  });
  const certs = deps.certs || (() => require("./certification"));

  const fresh = (hit, ttl) => !!hit && hit.v === V && now() - hit.at < ttl;
  const put = (st, k, value, cap) => {
    const keys = Object.keys(st.data);
    if (keys.length > cap) {
      keys.sort((a, b) => (st.data[a].at || 0) - (st.data[b].at || 0)).slice(0, Math.ceil(cap / 5)).forEach((x) => delete st.data[x]);
    }
    st.data[k] = { at: now(), v: V, ...value };
    st.save();
  };
  const inflight = new Map();
  const once = (k, fn) => {
    if (inflight.has(k)) return inflight.get(k);
    const p = Promise.resolve().then(fn).finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  };

  // ----- which TMDB person is this? -----
  const fromTitle = async (name, of, type) => {
    const f = await getJson(`/find/${of}?external_source=imdb_id`);
    const tv = f && f.tv_results && f.tv_results[0];
    const mv = f && f.movie_results && f.movie_results[0];
    const want = norm(name);
    const tries = type === "series" || type === "show" ? [["tv", tv], ["movie", mv]] : [["movie", mv], ["tv", tv]];
    for (const [kind, hit] of tries) {
      if (!hit || !hit.id) continue;
      const c = await quiet(getJson(kind === "tv" ? `/tv/${hit.id}/aggregate_credits` : `/movie/${hit.id}/credits`));
      const all = [...((c && c.cast) || []), ...((c && c.crew) || [])];
      const match = all.find((x) => norm(x.name) === want) || all.find((x) => norm(x.original_name) === want);
      if (match && match.id) return match.id;
    }
    return null;
  };
  const fromSearch = async (name) => {
    const s = await getJson(`/search/person?query=${encodeURIComponent(name)}&include_adult=false`);
    const list = ((s && s.results) || []).filter((x) => x && x.id && !x.adult);
    const want = norm(name);
    const exact = list.filter((x) => norm(x.name) === want).sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    return (exact[0] || list[0] || {}).id || null;
  };
  const resolve = async (parsed, { of = null, type = null } = {}) => {
    if (parsed.kind === "tmdb") return parsed.id;
    const tt = /^tt\d{5,10}$/.test(String(of || "")) ? of : null;
    const rKey = parsed.kind === "imdb" ? `r|${parsed.id}` : `r|n|${norm(parsed.name)}|${tt || ""}`;
    const hit = people().data[rKey];
    if (fresh(hit, hit && hit.id ? RESOLVE_TTL : MISS_TTL)) return hit.id || null;
    return once(rKey, async () => {
      let id = null;
      if (parsed.kind === "imdb") {
        const f = await getJson(`/find/${parsed.id}?external_source=imdb_id`);
        id = (f && f.person_results && f.person_results[0] && f.person_results[0].id) || null;
      } else {
        if (tt) id = await quiet(fromTitle(parsed.name, tt, type));
        if (!id) id = await fromSearch(parsed.name);
      }
      put(people(), rKey, { id }, MAX_PEOPLE * 4);
      return id;
    });
  };

  // ----- the person -----
  const fetchPerson = async (id) => {
    let partial = false;
    let p = await quiet(getJson(`/person/${id}?append_to_response=combined_credits,images,external_ids`));
    if (!p) {
      // the one-request form failed: ask for the parts, and answer with the
      // ones that come back (a filmography with no photos is still a sheet)
      const [base, cc, im] = await Promise.all([
        getJson(`/person/${id}`).catch((e) => { if (e && e.status === 404) throw e; return null; }),
        quiet(getJson(`/person/${id}/combined_credits`)),
        quiet(getJson(`/person/${id}/images`)),
      ]);
      if (!base && !cc) throw new Error("tmdb unreachable");
      p = { ...(base || { id }), combined_credits: cc || {}, images: im || {} };
      partial = !base || !cc || !im;
    }
    return { data: slim(p), partial };
  };
  const person = async (id) => {
    const k = `p|${id}`;
    const hit = people().data[k];
    if (fresh(hit, hit && hit.partial ? PARTIAL_TTL : PERSON_TTL)) return hit.data;
    try {
      return await once(k, async () => {
        const { data, partial } = await fetchPerson(id);
        put(people(), k, { data, ...(partial ? { partial: true } : {}) }, MAX_PEOPLE);
        return data;
      });
    } catch (e) {
      if (hit && hit.v === V && hit.data) return hit.data; // TMDB is down: last known beats nothing
      throw e;
    }
  };

  // ----- one title's IMDb id and age rating -----
  const titleKey = (c) => `${c.k}|${c.id}`;
  const titleCached = (c) => {
    const hit = titles().data[titleKey(c)];
    return fresh(hit, hit && hit.a == null && !hit.c ? TITLE_UNRATED_TTL : TITLE_TTL) ? hit : null;
  };
  const titleFetch = (c) => once(`t|${titleKey(c)}`, async () => {
    const show = c.k === "t";
    const d = await getJson(show
      ? `/tv/${c.id}?append_to_response=external_ids,content_ratings`
      : `/movie/${c.id}?append_to_response=external_ids,release_dates`);
    const results = show ? d.content_ratings && d.content_ratings.results : d.release_dates && d.release_dates.results;
    const kind = show ? "show" : "movie";
    const imdbId = (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || null;
    const value = {
      i: /^tt\d{5,10}$/.test(String(imdbId || "")) ? imdbId : null,
      c: certs().pickCertificate(results, kind),
      a: certs().strictestAge(results, kind),
      ...(d.adult ? { x: 1 } : {}),
    };
    put(titles(), titleKey(c), value, MAX_TITLES);
    return titles().data[titleKey(c)];
  });

  // The answer. `owned(credit)` → truthy when the household has the title
  // ({ title, year, type }); `budgetMs` is how long the title lookups may hold
  // the answer up.
  //   { error, status } | { id, imdbId, name, knownFor, born, died, place,
  //     bio, photos: [{ url, thumb, full }], credits: [...], partial }
  const get = async (rawId, { of = null, type = null, owned = null, budgetMs = BUDGET_MS } = {}) => {
    const parsed = parseId(rawId);
    if (!parsed) return { error: "That isn't a person this server can look up.", status: 400 };
    // (the cache is consulted before the key: a server that lost its key
    // still answers for everyone it already knows)
    const noKey = { error: "People need a TMDB key on this server (tmdbApiKey in config.json).", status: 503, noKey: true };
    let id;
    let data;
    try {
      id = parsed.kind === "tmdb" ? parsed.id : null;
      if (!id) {
        const tt = /^tt\d{5,10}$/.test(String(of || "")) ? of : null;
        const rKey = parsed.kind === "imdb" ? `r|${parsed.id}` : `r|n|${norm(parsed.name)}|${tt || ""}`;
        const hit = people().data[rKey];
        if (!fresh(hit, hit && hit.id ? RESOLVE_TTL : MISS_TTL) && !key()) return noKey;
        id = await resolve(parsed, { of, type });
      }
      if (!id) return { error: "Nobody by that name was found.", status: 404 };
      const hit = people().data[`p|${id}`];
      if (!(hit && hit.v === V && hit.data) && !key()) return noKey;
      data = key() || !hit ? await person(id) : hit.data;
    } catch (e) {
      if (e && e.status === 404) return { error: "Nobody by that name was found.", status: 404 };
      return { error: "Couldn't reach the people catalogue right now.", status: 502 };
    }
    if (!data || !data.name || data.adult) return { error: "Nobody by that name was found.", status: 404 };

    const ownedOf = (c) => {
      try { return owned ? !!owned({ title: c.t, year: c.y, type: c.k === "t" ? "show" : "movie" }) : false; } catch { return false; }
    };
    const picked = choose(data, { owned: ownedOf });
    // Titles not seen before: look them up, PARALLEL at a time, until the
    // budget is spent. The lookups carry on after it — the next answer has them.
    const missing = picked.map((x) => x.credit).filter((c) => !titleCached(c));
    let partial = false;
    if (missing.length) {
      if (!key()) partial = true;
      else {
        const queue = [...missing];
        const worker = async () => {
          while (queue.length) await quiet(titleFetch(queue.shift()));
        };
        const all = Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
        let timer;
        const timeout = new Promise((r) => { timer = setTimeout(() => r("late"), Math.max(0, budgetMs)); });
        if ((await Promise.race([all, timeout])) === "late") partial = true;
        clearTimeout(timer);
      }
    }
    const credits = [];
    for (const { credit: c, dept, owned: own } of picked) {
      const t = titles().data[titleKey(c)];
      if (!t || t.v !== V) { partial = true; continue; } // not known yet (or the lookup failed)
      if (!t.i || t.x) continue; // no IMDb id: nothing My List could hold on to
      credits.push({
        key: `${c.k}:${c.id}`,
        imdbId: t.i,
        type: c.k === "t" ? "show" : "movie",
        title: c.t,
        year: c.y,
        role: roleLine(c, dept),
        dept,
        deptLabel: DEPT_LABEL[dept],
        poster: c.p ? `${IMG}/w342${c.p}` : null,
        rating: c.r,
        votes: c.v,
        certificate: t.c || null,
        kidsAge: typeof t.a === "number" ? t.a : null,
        ownedHint: own,
      });
    }
    // `url` is TMDB's own address (on the image proxy's allow-list — clients
    // size it through /img/ext like every other picture); `thumb` and `full`
    // are that proxy's addresses ready-made, for a client with no helper.
    const photo = (p) => {
      const via = (u, w) => `/img/ext?u=${encodeURIComponent(u)}&w=${w}`;
      return { url: `${IMG}/h632${p}`, thumb: via(`${IMG}/h632${p}`, 360), full: via(`${IMG}/original${p}`, 960) };
    };
    return {
      id: `tmdb:${data.tmdbId}`,
      imdbId: data.imdbId,
      name: data.name,
      knownFor: data.knownFor,
      born: data.born,
      died: data.died,
      place: data.place,
      bio: data.bio,
      photos: data.photos.map(photo),
      credits,
      partial,
      source: "tmdb",
    };
  };

  return { get, resolve, person, _stores: { people, titles } };
};

const live = create();
module.exports = { get: live.get, create, _internals: { parseId, slim, choose, roleLine, shortBio, orderFor, norm, V } };

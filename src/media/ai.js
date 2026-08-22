// AI recommender: "tell me the vibe, get titles back".
//
// The model proposes titles from its OWN knowledge of film and TV — it is never
// shown the library. That is deliberate: the moment you hand it a catalog it
// starts ranking what you happen to own, and a downloaded film gets picked over
// a better match purely because it was in the list. So selection is pure vibe,
// and the server afterwards resolves each proposed title to something Aurora can
// actually play. Anything that won't resolve is dropped, which is also what
// stops a hallucinated title ever reaching a card.
//
// Cost shape: one small request per search (~400 tokens in, ~500 out), so this
// runs at fractions of a cent. Identical vibes are cached for a day.
const config = require("../config");
const discover = require("./discover");
const scanner = require("./scanner");

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 45000;
const WANT = 16;          // how many we aim to show

// Generation time is dominated by output length, so a single 28-item request
// would take roughly twice as long as a 14-item one. Instead we fire TWO
// requests in parallel: same tokens, half the wall clock, and because each gets
// a different steer (crowd-pleasers vs. less obvious picks) the merged list has
// real spread instead of the same ten famous films every time.
//
// How many to ask for depends on how much we expect to throw away. Titles now
// almost all resolve, so the only real loss is the taste chips: measured, "2010
// or later AND under 100 minutes" rejected 12 of 22 proposals. With no chips set
// there is nothing to reject, so we ask for less and answer faster.
// Even with nothing to reject there is overlap to absorb: on a broad request the
// two flavours agree on more than you'd think, and 12 each came back as only 15
// unique titles — uncomfortably close to the floor.
const ASK_LOOSE = 14;
const ASK_TIGHT = 20;
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_VIBE = 300;

const enabled = () => !!config.OPENROUTER_KEY;

// vibe|mix|era|length -> {at, items}
const cache = new Map();
const cacheKey = (vibe, mix, era, len) =>
  `${mix}|${era}|${len}|${vibe.trim().toLowerCase()}`;

// ------------------------------------------------------------------ taste
// Era. Each window is enforced twice: as an instruction, and afterwards as a
// filter on the resolved release year — asking nicely is not the same as being
// obeyed. The newest band is "last five years" rather than "this year" on
// purpose: the model can only name what it was trained on, so a tighter window
// returns titles that don't exist and get dropped at resolution, leaving the
// viewer with a short list for no reason.
const NOW_YEAR = new Date().getFullYear();
const ERAS = {
  any: { ask: "" },
  fresh: {
    min: NOW_YEAR - 5,
    ask: `Only titles first released in ${NOW_YEAR - 5} or later. Nothing older.`,
  },
  modern: {
    min: NOW_YEAR - 16,
    ask: `Only titles first released in ${NOW_YEAR - 16} or later. Nothing older.`,
  },
  classic: {
    max: NOW_YEAR - 26,
    ask:
      `Only established classics released in ${NOW_YEAR - 26} or earlier — ` +
      "films and series that are still talked about. Nothing recent.",
  },
};

// Length. The search results we resolve against carry a year but no runtime or
// season count, so there is nothing authoritative to filter on without a second
// metadata lookup per title — several more seconds of waiting. Instead the model
// is made to STATE the runtime and season count for every title it names, and we
// filter on what it said.
//
// That works because the two failures are separable: asked for films under 100
// minutes it will still offer Manchester by the Sea, but it labels it 137
// minutes rather than lying about it. Declared numbers were accurate on every
// title spot-checked, so filtering on them drops exactly the titles that break
// the rule — and it happens before resolution, so the dropped ones cost nothing.
const LENGTHS = {
  movie: {
    any: {},
    short: { ask: "Every film must run under 100 minutes.", maxMins: 100 },
    standard: { ask: "Every film must run under two hours.", maxMins: 120 },
    epic: {
      ask: "Every film must run over two and a half hours — pick the long ones.",
      minMins: 150,
    },
  },
  show: {
    any: {},
    limited: {
      ask: "Only limited series, miniseries, or shows that ran one or two seasons.",
      maxSeasons: 2,
    },
    meaty: {
      ask: "Only shows with at least four seasons, so there's plenty to get through.",
      minSeasons: 4,
    },
  },
};

// Sources disagree on runtime by a few minutes (credits, cuts), so the movie
// bounds get a little slack. Season counts are exact — no slack there.
const MINS_GRACE = 5;

const eraOf = (id) => ERAS[id] || ERAS.any;
const lengthOf = (kind, id) =>
  (LENGTHS[kind] && LENGTHS[kind][id]) || LENGTHS[kind].any;

// Does a resolved title sit inside the requested era? Unknown years pass —
// dropping a good match over missing metadata is the worse failure. One year of
// grace at each edge because sources disagree on festival vs. wide release.
const inEra = (year, era) => {
  if (!year) return true;
  if (era.min && year < era.min - 1) return false;
  if (era.max && year > era.max + 1) return false;
  return true;
};

// Same rule for length: a number it didn't give us can't disqualify anything.
const inLength = (s, len) => {
  if (len.maxMins || len.minMins) {
    const mins = Number(s.mins) || 0;
    if (!mins) return true;
    if (len.maxMins && mins > len.maxMins + MINS_GRACE) return false;
    if (len.minMins && mins < len.minMins - MINS_GRACE) return false;
  }
  if (len.maxSeasons || len.minSeasons) {
    const seasons = Number(s.seasons) || 0;
    if (!seasons) return true;
    if (len.maxSeasons && seasons > len.maxSeasons) return false;
    if (len.minSeasons && seasons < len.minSeasons) return false;
  }
  return true;
};

// ---------------------------------------------------------------- the ask
// The two steers the parallel calls get. Neither reaches for obscurity for its
// own sake — an earlier version told the model to "range across decades and
// mix well-known with lesser-known", and it dutifully returned lists that felt
// dusty and random. Both halves now have to clear a quality bar; they differ
// only in how famous the answer is allowed to be.
const FLAVOURS = [
  "Pick the strongest, most widely loved answers to this request — the ones " +
    "someone would be glad to be reminded of.",
  "Avoid the most obvious picks. Choose well-regarded titles that a good " +
    "recommendation would surface but a top-ten list would miss. Still genuinely " +
    "good — not obscure for the sake of it.",
];

// `mix` is 0..100: 0 = only films, 100 = only series. It shapes the prompt AND
// is enforced again on the way out, because a model told "mostly films" will
// still slip a series in.
const buildPrompt = (vibe, mix, eraId, lenId, flavour, askFor) => {
  const wantShows = Math.round((mix / 100) * askFor);
  const wantMovies = askFor - wantShows;
  const split =
    mix <= 5
      ? `All ${askFor} must be MOVIES. No series.`
      : mix >= 95
        ? `All ${askFor} must be TV SERIES. No films.`
        : `Give roughly ${wantMovies} movies and ${wantShows} TV series.`;

  // Hard constraints go last and get their own lines — buried mid-paragraph
  // they get ignored.
  const rules = [eraOf(eraId).ask, lengthOf(mix >= 95 ? "show" : "movie", lenId).ask]
    .filter(Boolean)
    .map((r) => `- ${r}`)
    .join("\n");

  return [
    {
      role: "system",
      content:
        "You recommend films and TV series. You will be given a mood or request in " +
        "the user's own words. Reply with ONLY a JSON array, no prose, no markdown " +
        "fence. Each element: " +
        '{"title": string, "year": number, "type": "movie" | "show", ' +
        '"mins": number, "seasons": number, "why": string}. ' +
        "`title` must be the work's common English title, spelled exactly, so it can " +
        "be looked up. `mins` is a film's total runtime in minutes (0 for a series); " +
        "`seasons` is how many seasons a series ran (0 for a film). State both " +
        "accurately — they are checked, and a title whose real length breaks a stated " +
        // 8-12, not 8-14: the reason sits under a poster in a grid cell, and
        // anything longer than about twelve words overran the three lines the
        // card has room for.
        "requirement will be thrown away. `why` is 8 to 12 words on why THIS request is served by THIS " +
        "title — name something concrete (its tone, its length, a specific thing it " +
        "does). Two-word answers like \"witty humor\" or \"great acting\" are " +
        "useless: they describe nothing and fit anything. Never repeat the same " +
        "reason twice. Never invent a title that does not exist.",
    },
    {
      role: "user",
      content:
        `Mood / request: ${vibe}\n\n${flavour}\n\n${split}` +
        (rules ? `\n\nHard requirements — a title that breaks one is wrong:\n${rules}` : "") +
        `\n\nReturn exactly ${askFor} items as JSON.`,
    },
  ];
};

const callModel = async (messages, tag = "") => {
  const t0 = Date.now();
  // AbortSignal.timeout isn't available everywhere this runs; do it by hand.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        // OpenRouter asks for these; they also make the usage page readable.
        "HTTP-Referer": "http://localhost:4000",
        "X-Title": "Aurora",
      },
      body: JSON.stringify({
        model: config.AI_MODEL,
        messages,
        temperature: 0.8, // some spread, so the same vibe isn't the same ten films
        // 20 items at ~65 tokens each, plus headroom. Too low and the last
        // object arrives half-written; the parser salvages it, but a truncated
        // reply is a wasted title.
        max_tokens: 2000,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status} after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    console.log(`[ai] ${config.AI_MODEL}${tag} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return data?.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
};

// Models wrap JSON in prose or a ```json fence however often you ask them not
// to. Pull out the first array and parse that.
const parseSuggestions = (text) => {
  if (!text) return [];
  let raw = String(text).trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("[");
  if (start === -1) return [];
  const end = raw.lastIndexOf("]");
  let arr = null;
  if (end > start) {
    try { arr = JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  if (!arr) {
    // Truncated (or trailing-comma'd) output: take the objects that ARE whole
    // and drop the half-written one at the end. Ten good titles beat an error.
    const objects = raw.slice(start).match(/{[^{}]*}/g) || [];
    arr = objects
      .map((o) => { try { return JSON.parse(o); } catch { return null; } })
      .filter(Boolean);
    if (arr.length) console.warn(`[ai] reply was truncated — salvaged ${arr.length} items`);
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x.title === "string" && x.title.trim())
    .map((x) => ({
      title: x.title.trim().slice(0, 160),
      year: Number(x.year) || null,
      type: x.type === "show" || x.type === "series" || x.type === "tv" ? "show" : "movie",
      // The model's own claim about its length, used to enforce the length chip
      // before we spend a lookup on it. Never shown to anyone.
      mins: Number(x.mins) || 0,
      seasons: Number(x.seasons) || 0,
      // Collapse whitespace runs (models emit double spaces and stray newlines
      // mid-sentence). \s, not s — an earlier version of this line ate the
      // letter itself and turned "Police sitcom" into "Police itcom".
      why: String(x.why || "")
        .replace(/\s+/g, " ")
        // Now that it's told lengths are checked, it sometimes shows its working
        // at the end of the reason — "(Note: 102 minutes)". That's bookkeeping
        // aimed at us, not something the viewer needs on their card.
        .replace(/\s*\((?:note|runtime|approx)\b[^)]*\)\s*$/i, "")
        .replace(/\s*\(\s*\d+\s*(?:mins?|minutes?|h)\b[^)]*\)\s*$/i, "")
        .trim()
        .slice(0, 115),
    }));
};

// ---------------------------------------------------------------- resolution
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Best candidate for a proposed title: same type, title match, year close by.
const bestMatch = (suggestion, results) => {
  const want = norm(suggestion.title);
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    if (!r || !r.imdbId) continue;
    const rt = norm(r.title);
    let score = 0;
    if (rt === want) score += 10;
    else if (rt.startsWith(want) || want.startsWith(rt)) score += 6;
    else if (rt.includes(want) || want.includes(rt)) score += 3;
    else continue; // unrelated title — never accept it
    if (suggestion.year && r.year) {
      const gap = Math.abs(Number(r.year) - suggestion.year);
      if (gap === 0) score += 4;
      else if (gap <= 1) score += 3;
      else if (gap <= 3) score += 1;
      else score -= 2; // same name, wrong decade: usually a remake, not the ask
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 3 ? best : null;
};

// Turn one suggestion into a playable card, or null.
const resolveOne = async (s) => {
  let found;
  try {
    found = await discover.search(s.title);
  } catch {
    return null;
  }
  const pool = s.type === "show" ? found.shows : found.movies;
  const hit = bestMatch(s, pool || []);
  if (!hit) return null;
  // A local copy means instant playback, so prefer it as the SOURCE — but note
  // this happens after selection, so owning a film never made it more likely to
  // be chosen in the first place.
  const local = hit.inLibrary ? scanner.findById(hit.inLibrary) : null;
  return {
    ...(local
      ? { ...local, source: "downloaded" }
      : { ...hit, source: "stream", cover: hit.poster || null }),
    why: s.why,
    aiTitle: s.title,
  };
};

// Resolve with a bounded amount of concurrency: sequential lookups would take
// far too long, all at once hammers the metadata provider. Six measured ~3s for
// 12 titles; there are now up to 28, so this went to ten to hold the same wait.
const RESOLVE_WORKERS = 10;
const resolveAll = async (suggestions) => {
  const out = [];
  const queue = [...suggestions];
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      const card = await resolveOne(s);
      if (card) out.push(card);
    }
  };
  await Promise.all(Array.from({ length: RESOLVE_WORKERS }, worker));
  return out;
};

// ---------------------------------------------------------------- public
const recommend = async (vibeRaw, mixRaw, eraRaw, lenRaw) => {
  if (!enabled()) return { error: "The recommender isn't configured on this server." };
  // Must actually be a string: an array arrives as "a,b" once stringified, which
  // clears the length check and spends a real API call on nonsense.
  if (typeof vibeRaw !== "string") return { error: "Tell me a bit more about what you're after." };
  const vibe = vibeRaw.trim().slice(0, MAX_VIBE);
  if (vibe.length < 3) return { error: "Tell me a bit more about what you're after." };
  const mix = Math.max(0, Math.min(100, Math.round(Number(mixRaw) || 0)));
  // Unknown ids fall back to "no constraint" rather than erroring: a stale
  // client sending a chip we've renamed should still get recommendations.
  const eraId = ERAS[eraRaw] ? eraRaw : "any";
  const kind = mix >= 95 ? "show" : "movie";
  // A length that belongs to the other kind ("meaty" while asking for films)
  // falls back to no constraint rather than being applied nonsensically.
  const lenId = LENGTHS[kind][lenRaw] ? lenRaw : "any";

  const key = cacheKey(vibe, mix, eraId, lenId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { items: hit.items, cached: true };

  const started = Date.now();
  const askFor = eraId === "any" && lenId === "any" ? ASK_LOOSE : ASK_TIGHT;
  // Both halves at once. allSettled, not all: one failed call should cost us
  // half the list, not the whole answer.
  const replies = await Promise.allSettled(
    FLAVOURS.map((flavour, i) =>
      callModel(buildPrompt(vibe, mix, eraId, lenId, flavour, askFor), ` #${i + 1}`)
    )
  );
  const failed = replies.filter((r) => r.status === "rejected");
  for (const f of failed) {
    console.warn(`[ai] one call failed after ${((Date.now() - started) / 1000).toFixed(1)}s:`, f.reason && f.reason.message);
  }
  if (failed.length === replies.length) {
    return { error: "The recommender didn't answer. Try again in a moment." };
  }

  let suggestions = replies
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => parseSuggestions(r.value));

  if (!suggestions.length) {
    console.warn("[ai] model returned nothing usable");
    return { error: "The recommender got confused. Try rephrasing that." };
  }

  // Enforce the toggle again — a model told "all films" will still sneak a
  // series in, and the viewer asked for one or the other.
  if (mix <= 5) suggestions = suggestions.filter((s) => s.type === "movie");
  else if (mix >= 95) suggestions = suggestions.filter((s) => s.type === "show");

  // The two calls overlap on the safest answers. Drop repeats by title BEFORE
  // resolving, so we don't spend a metadata lookup learning what we know.
  const proposed = new Set();
  suggestions = suggestions.filter((s) => {
    const k = `${s.type}|${norm(s.title)}`;
    if (proposed.has(k)) return false;
    proposed.add(k);
    return true;
  });

  // Enforce the taste chips on what the model told us about each title, while
  // it's still free to do so. The era pass runs again after resolution against
  // the metadata provider's year, which is the authoritative one; this first
  // pass just avoids paying for lookups we're going to throw away.
  const era = eraOf(eraId);
  const len = lengthOf(kind, lenId);
  const beforeChips = suggestions.length;
  suggestions = suggestions.filter(
    (s) => inEra(s.year, era) && inLength(s, len)
  );
  if (beforeChips !== suggestions.length) {
    console.log(
      `[ai] chips (era ${eraId}, len ${lenId}) rejected ${beforeChips - suggestions.length} of ${beforeChips} proposals`
    );
  }
  if (!suggestions.length) {
    return { error: "Nothing it offered fits those filters. Try loosening one." };
  }

  let items = await resolveAll(suggestions);

  // Dedupe again on the resolved id: two different proposed titles can land on
  // the same work.
  const seen = new Set();
  items = items.filter((i) => {
    const k = i.imdbId || i.id;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Era again, now against the provider's year rather than the model's claim.
  if (era.min || era.max) {
    const before = items.length;
    items = items.filter((i) => inEra(Number(i.year) || null, era));
    if (before !== items.length) {
      console.log(`[ai] era "${eraId}" dropped ${before - items.length} out-of-window title(s)`);
    }
  }

  // Keep the model's ordering, which puts the first call's crowd-pleasers ahead
  // of the second's deeper cuts.
  const order = new Map(suggestions.map((s, i) => [norm(s.title), i]));
  items.sort((a, b) => (order.get(norm(a.aiTitle)) ?? 999) - (order.get(norm(b.aiTitle)) ?? 999));
  items = items.slice(0, WANT);

  if (!items.length) {
    return { error: "Nothing it suggested could be found. Try a different angle." };
  }
  cache.set(key, { at: Date.now(), items });
  console.log(
    `[ai] "${vibe.slice(0, 50)}" (${kind}, era ${eraId}, len ${lenId}) -> ` +
      `${items.length} of ${suggestions.length} proposed, ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  return { items };
};

module.exports = { enabled, recommend };

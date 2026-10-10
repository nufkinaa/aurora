// Ranking: a person's model (person.js) against candidate titles
// (features.js), then the rows a home screen is made of.
//
//   score      how well a title fits the person —
//                taste     their signed taste vector · the title, block by block
//                nearest   how close the title sits to the liked titles nearest
//                          to it (top 3, weighted by how much each is liked)
//                − dislike closeness to something they gave up on or rated down
//              then × a quality prior (a 7.8 beats a 5.9 at equal fit), plus a
//              little for being new, a little for being liked in the household,
//              and a per-(profile, day) jitter so a row is the same all day
//              and a bit different tomorrow.
//   re-rank    greedy, one pick at a time, trading the score against
//                diversity    not another title just like one already picked (MMR)
//                calibration  the row's genre mix should look like the person's
//                             own mix — 60% drama / 30% sci-fi in, about that
//                             out (Steck, "Calibrated Recommendations", 2018)
//              and never two from one franchise.
//   rows       Recommended for You · Because you finished X · More <theme> ·
//              From the director of X · Something different. No title appears
//              in two of them, none has been watched, and each card says why.
//
// Pure. Deterministic for a given (model, candidates, seed).
const features = require("./features");
const tax = require("./taxonomy");

// taste-vector block weights (people and franchise matter more to a person
// than to "these two titles are alike": you follow a director; a sequel to
// something you finished is the easiest good recommendation there is)
//
// Tuned on tools/recs-eval (personas + the household replay), and on purpose
// not to the last decimal: ten personas cannot tell 0.30 from 0.35. What the
// runs did show, and these numbers respect: genre must stay the largest single
// voice in TASTE (without it the row drifts to obscure titles that share a
// keyword), the taste vector out-predicts nearest-liked alone, and the quality
// prior is worth more than any single feature block.
const W_TASTE = { genre: 0.3, theme: 0.22, kw: 0.17, people: 0.1, link: 0.06, plot: 0.04, meta: 0.07, col: 0.04 };
const MIX = { taste: 0.6, nearest: 0.4, dislike: 0.6, quality: 0.3, fresh: 0.02, household: 0.05, jitter: 0.02 };
// "Nearest liked title" and "closest dislike" cost a similarity per anchor per
// candidate; the taste vector costs one pass. So everything is scored on
// taste first and only the best NEAR_POOL go on to the per-anchor pass — a
// title far down on taste would need a near-perfect neighbour to matter, and
// then its taste would not be far down.
const NEAR_POOL = 500;
const COLD_MASS = 1.5; // below this much evidence there is no taste to speak of

// mulberry32 over a string seed -> deterministic 0..1 per (seed, id)
const hash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const rand01 = (seed, id) => {
  let t = (hash(`${seed}|${id}`) + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const tasteScore = (model, v, weights = W_TASTE) => {
  let s = 0;
  for (const b of features.BLOCKS) {
    const w = weights[b];
    const m = model.taste[b];
    if (w && m && v[b]) s += w * features.dotMap(m, v[b]);
  }
  return s;
};

// Score every candidate. cands: [{ id, v (blocks), rec (index record) }]
// Returns [{ id, c, score, fit, nearest: [{a, sim}], … }] sorted best first.
const scoreAll = (model, cands, { seed = "", household = null, mix = MIX, simWeights = undefined, tasteWeights = W_TASTE } = {}) => {
  const out = [];
  const pos = model.pos;
  const neg = model.neg;
  // the three most-liked anchors' weight: what a perfect "nearest" would be
  const top3 = pos.slice(0, 3).reduce((n, a) => n + a.eff, 0) || 1;
  const tastes = cands.map((c) => tasteScore(model, c.v, tasteWeights));
  let cut = -Infinity;
  if (cands.length > NEAR_POOL && mix.taste > 0) {
    cut = [...tastes].sort((a, b) => b - a)[NEAR_POOL - 1];
  }
  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci];
    const v = c.v;
    const taste = tastes[ci];
    if (taste < cut) {
      // taste alone: same formula, no neighbours looked up
      const fit0 = mix.taste * taste;
      const quality0 = features.qualityOf(c.rec);
      let score0 = fit0 * (1 - mix.quality + mix.quality * 2 * quality0);
      if (seed) score0 += mix.jitter * (rand01(seed, c.id) - 0.5);
      out.push({ id: c.id, c, score: score0, fit: fit0, taste, near: 0, dislike: 0, quality: quality0, nearest: [] });
      continue;
    }
    // nearest liked titles
    let n1 = null;
    let n2 = null;
    let n3 = null; // best three by eff*sim
    for (let i = 0; i < pos.length; i++) {
      const a = pos[i];
      const sim = features.similarity(v, a.v, simWeights);
      if (sim <= 0.05) continue;
      const val = a.eff * sim;
      const e = { a, sim, val };
      if (!n1 || val > n1.val) { n3 = n2; n2 = n1; n1 = e; }
      else if (!n2 || val > n2.val) { n3 = n2; n2 = e; }
      else if (!n3 || val > n3.val) n3 = e;
    }
    const nearest = [n1, n2, n3].filter(Boolean);
    // 1, 1/2, 1/3: the closest liked title speaks loudest
    const near = nearest.reduce((n, e, i) => n + e.val / (i + 1), 0) / (top3 * (1 + 1 / 2 + 1 / 3) / 3 || 1);
    let dislike = 0;
    for (let i = 0; i < neg.length; i++) {
      const d = -neg[i].eff * features.similarity(v, neg[i].v, simWeights);
      if (d > dislike) dislike = d;
    }
    const fit = mix.taste * taste + mix.nearest * Math.min(1.5, near) - mix.dislike * Math.min(1, dislike);
    const quality = features.qualityOf(c.rec);
    let score = fit * (1 - mix.quality + mix.quality * 2 * quality);
    score += mix.fresh * features.freshnessOf(c.rec, model.now) * Math.max(0, Math.min(1, fit * 4));
    if (household) score += mix.household * Math.min(1, (household.get(c.id) || 0) / 2);
    if (seed) score += mix.jitter * (rand01(seed, c.id) - 0.5);
    out.push({ id: c.id, c, score, fit, taste, near, dislike, quality, nearest });
  }
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return out;
};

// Genre distribution of a picked list (each title's unit spread over its genres).
const genreMix = (picked) => {
  const q = {};
  let total = 0;
  for (const s of picked) {
    const gs = s.c.v.genres || [];
    for (const g of gs) { q[g] = (q[g] || 0) + 1 / gs.length; total += 1 / gs.length; }
  }
  if (total) for (const g in q) q[g] /= total;
  return q;
};
// KL(p ‖ q̃), q̃ = 0.99·q + 0.01·p — Steck's smoothing, so a genre missing from
// the list costs a lot but not infinity.
const klDivergence = (p, q) => {
  let kl = 0;
  for (const g in p) {
    if (p[g] <= 0) continue;
    const qt = 0.99 * (q[g] || 0) + 0.01 * p[g];
    kl += p[g] * Math.log(p[g] / qt);
  }
  return kl;
};

// Greedy re-rank of the best `pool` scored candidates into a row of `size`.
const rerank = (scored, { size = 16, pool = 120, lambdaDiv = 0.25, lambdaCal = 0.8, target = null, perFranchise = 1, exclude = null, simWeights = undefined } = {}) => {
  const cands = [];
  for (const s of scored) {
    if (exclude && exclude.has(s.id)) continue;
    if (s.score <= 0) break;
    cands.push(s);
    if (cands.length >= pool) break;
  }
  if (!cands.length) return [];
  const top = cands[0].score || 1;
  const picked = [];
  const franchises = new Map();
  const maxSim = new Float32Array(cands.length); // each candidate's closeness to the picks so far
  const taken = new Uint8Array(cands.length);
  const hasTarget = target && Object.keys(target).length > 0;
  let counts = {};
  let countTotal = 0;
  while (picked.length < size) {
    let best = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      if (taken[i]) continue;
      const s = cands[i];
      const col = s.c.rec.col ? s.c.rec.col[0] : null;
      if (col && (franchises.get(col) || 0) >= perFranchise) continue;
      let val = (1 - lambdaDiv) * (s.score / top) - lambdaDiv * maxSim[i];
      if (hasTarget && lambdaCal) {
        // KL after adding this one, computed incrementally on genre counts
        const gs = s.c.v.genres || [];
        const tot = countTotal + (gs.length ? 1 : 0);
        let kl = 0;
        for (const g in target) {
          const p = target[g];
          if (p <= 0) continue;
          const add = gs.includes(g) ? 1 / gs.length : 0;
          const q = tot ? ((counts[g] || 0) + add) / tot : 0;
          kl += p * Math.log(p / (0.99 * q + 0.01 * p));
        }
        // λ 0.8: an under-served genre scores lower by construction (less of
        // the taste vector is behind it), so calibration has to be able to
        // out-vote a 4:1 score gap or the smaller interest never surfaces.
        // Measured on the personas: recall is flat from λ 0 to 1.2.
        val -= lambdaCal * kl;
      }
      if (val > bestVal) { bestVal = val; best = i; }
    }
    if (best < 0) break;
    const s = cands[best];
    taken[best] = 1;
    picked.push(s);
    const col = s.c.rec.col ? s.c.rec.col[0] : null;
    if (col) franchises.set(col, (franchises.get(col) || 0) + 1);
    const gs = s.c.v.genres || [];
    if (gs.length) {
      for (const g of gs) counts[g] = (counts[g] || 0) + 1 / gs.length;
      countTotal += 1;
    }
    for (let i = 0; i < cands.length; i++) {
      if (taken[i]) continue;
      const sim = features.similarity(cands[i].c.v, s.c.v, simWeights);
      if (sim > maxSim[i]) maxSim[i] = sim;
    }
  }
  return picked;
};

// ---------- reasons ----------
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const joinTitles = (list) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0] || "");

// Why this title, in the person's own history: the liked titles it sits
// closest to (when it is genuinely close), else the theme or genre it shares
// with their taste.
const whyFor = (s, model) => {
  const close = s.nearest.filter((e) => e.sim >= 0.2);
  if (close.length) {
    const first = close[0];
    const second = close[1] && close[1].sim >= first.sim * 0.8 ? close[1] : null;
    if (!second) return `Because ${first.a.why}`;
    return `Because ${first.a.why} and ${second.a.title}`;
  }
  const themes = model.taste.theme;
  if (themes && s.c.v.theme) {
    let bestSlug = null;
    let bestVal = 0;
    for (let i = 0; i < s.c.v.theme.k.length; i++) {
      const val = (themes.get(s.c.v.theme.k[i]) || 0) * s.c.v.theme.w[i];
      if (val > bestVal) { bestVal = val; bestSlug = features.nameOf(s.c.v.theme.k[i]).slice(6); }
    }
    if (bestSlug && bestVal > 0.02) return `More ${tax.themeLabel(bestSlug)}, which you keep coming back to`;
  }
  const g = (s.c.v.genres || []).find((x) => (model.genreShare[x] || 0) > 0.1);
  if (g) return `Because you watch a lot of ${g}`;
  return null;
};

// ---------- rows ----------
const SIZES = { recommended: 16, because: 12, theme: 14, person: 12, stretch: 12 };

// The strongest evidence to build "Because you…" rows on: clearly liked,
// described by a full record, and not two anchors that are near-twins.
const becauseAnchors = (model, max = 2) => {
  const strong = model.pos.filter((a) => a.eff >= 0.8 && !a.v.lite && [...a.kinds].some((k) => /^(rated[45]|loved|finished|rewatch|devoted|regular|binge|follow|mostly)$/.test(k)));
  // most recent strong one first ("what you just finished"), then the most liked
  const byRecent = [...strong].sort((a, b) => (b.at || 0) - (a.at || 0));
  const order = [];
  if (byRecent[0] && byRecent[0].short > 0.2) order.push(byRecent[0]);
  for (const a of strong) if (!order.includes(a)) order.push(a);
  const out = [];
  for (const a of order) {
    if (out.some((o) => features.similarity(o.v, a.v) > 0.45)) continue;
    out.push(a);
    if (out.length >= max * 3) break; // spares, in case one yields too few neighbours
  }
  return out;
};

const becausePhrase = (a) => {
  const k = a.kinds;
  if (k.has("rated5") || k.has("loved")) return `Because you loved ${a.title}`;
  if (k.has("rewatch")) return `Because you rewatched ${a.title}`;
  if (k.has("finished")) return `Because you finished ${a.title}`;
  if (k.has("devoted") || k.has("regular") || k.has("binge") || k.has("follow")) return `Because you watched ${a.title}`;
  return `Because you liked ${a.title}`;
};

// Build every personalised row.
//   opts: { seed, household: Map, used: Set (ids already on the page: hero,
//           continue watching, My List), isSeen(id), sizes, people: Map(personKey -> name) }
// Returns { rows: [{ id, title, reason, items: [scored…] }], cold: bool }
const buildRows = (model, cands, opts = {}) => {
  const { seed = "", household = null, sizes = SIZES, personName = () => null } = opts;
  const used = new Set(opts.used || []);
  const fresh = cands.filter((c) => !model.seen.has(c.id) && !used.has(c.id));
  const rows = [];
  const take = (items) => { for (const s of items) used.add(s.id); };

  if (model.mass < COLD_MASS) {
    // Cold start: no history to speak of. Settings genre picks + what the
    // household is watching + quality — still per-profile, still explained.
    const liked = new Set(model.likedGenres || []);
    if (!liked.size && !(household && household.size)) return { rows, cold: true };
    const scored = [];
    for (const c of fresh) {
      const gs = c.v.genres || [];
      const g = gs.length ? gs.filter((x) => liked.has(x)).length / Math.min(gs.length, 3) : 0;
      const h = household ? Math.min(1, (household.get(c.id) || 0) / 2) : 0;
      const q = features.qualityOf(c.rec);
      if (!g && !h) continue;
      const score = 0.5 * Math.min(1, g) + 0.3 * h + 0.2 * q + 0.03 * features.freshnessOf(c.rec, model.now) + 0.02 * rand01(seed, c.id);
      const why = h >= g && h > 0 ? "Popular in this household" : `You like ${gs.find((x) => liked.has(x))}`;
      scored.push({ id: c.id, c, score, fit: score, quality: q, nearest: [], why });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const target = {};
    for (const g of liked) target[g] = 1 / liked.size;
    const items = rerank(scored, { size: sizes.recommended, target, lambdaCal: 0.4 });
    if (items.length >= 4) {
      rows.push({
        id: "recommended", title: "Recommended for You", items,
        reason: "From the genres you picked and what this household watches",
        sub: liked.size ? "From the genres you picked" : "Popular in this household",
      });
    }
    return { rows, cold: true };
  }

  const scored = scoreAll(model, fresh, { seed, household, mix: opts.mix, simWeights: opts.simWeights, tasteWeights: opts.tasteWeights });
  const byId = new Map(scored.map((s) => [s.id, s]));

  // 1. Recommended for You — the calibrated, diversified best
  const forYou = rerank(scored, {
    size: sizes.recommended, target: model.genreShare, exclude: used,
    lambdaDiv: opts.lambdaDiv ?? 0.25, lambdaCal: opts.lambdaCal ?? 0.8, simWeights: opts.simWeights,
  });
  for (const s of forYou) s.why = whyFor(s, model);
  if (forYou.length >= 4) {
    rows.push({
      id: "recommended", title: "Recommended for You", items: forYou,
      reason: "Picked from what you watch, finish and rate", sub: "From what you watch, finish and rate",
    });
    take(forYou);
  }

  // 2. Because you finished X — the neighbourhood of one liked title
  let because = 0;
  for (const a of becauseAnchors(model)) {
    if (because >= 2) break;
    const near = [];
    // a neighbour worth showing is also somewhere in the person's top third
    for (let si = 0; si < scored.length && si < 800; si++) {
      const s = scored[si];
      if (used.has(s.id) || s.score <= 0) continue;
      const sim = features.similarity(s.c.v, a.v, opts.simWeights);
      if (sim < 0.2) continue;
      near.push({ ...s, score: 0.75 * sim + 0.25 * Math.max(0, s.score), anchorSim: sim });
    }
    near.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
    const items = rerank(near, { size: sizes.because, pool: 60, lambdaDiv: 0.15, lambdaCal: 0, perFranchise: 2 });
    if (items.length < 5) continue;
    const phrase = becausePhrase(a);
    for (const s of items) s.why = phrase;
    rows.push({ id: `because-${a.id}`, title: phrase, reason: phrase, anchor: { imdbId: a.id, title: a.title }, items });
    take(items);
    because++;
  }

  // 3. More <theme> — the themes their liked titles keep sharing
  const themeSupport = new Map(); // slug -> { eff, titles: [] }
  for (const a of model.pos) {
    for (const [slug, w] of Object.entries(a.v.themes || {})) {
      if (w < 1) continue; // solid evidence only (two keywords, or keyword + synopsis)
      let t = themeSupport.get(slug);
      if (!t) themeSupport.set(slug, (t = { eff: 0, titles: [] }));
      t.eff += a.eff * w;
      t.titles.push(a.title);
    }
  }
  const themes = [...themeSupport.entries()]
    .filter(([, t]) => t.titles.length >= 2) // one title is an accident, two is a taste
    .sort((x, y) => y[1].eff - x[1].eff || (x[0] < y[0] ? -1 : 1));
  let themeRows = 0;
  const themeGroups = new Set();
  for (const [slug, t] of themes) {
    if (themeRows >= 2) break;
    const info = tax.themeInfo(slug);
    // some themes are true of a title without being a reason to pick one
    // ("suspenseful", "epic scale"): they shape the taste vector, never a row
    if (!info || info.row === false) continue;
    // two rows from different groups read better than "heists" + "cons"
    if (themeGroups.has(info.group) && themes.length > 3) continue;
    // solidly on theme, in the person's own order (and the more a title is
    // built on the theme, the higher)
    const pool = scored
      .filter((s) => !used.has(s.id) && s.score > 0 && (s.c.v.themes[slug] || 0) >= 1)
      .map((s) => ({ ...s, score: s.score * (0.7 + 0.2 * Math.min(1.5, s.c.v.themes[slug])) }))
      .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
    const items = rerank(pool, { size: sizes.theme, pool: 60, lambdaDiv: 0.2, lambdaCal: 0 });
    if (items.length < 6) continue;
    const why = `More ${tax.themeLabel(slug)} — like ${joinTitles(t.titles.slice(0, 2))}`;
    for (const s of items) s.why = why;
    rows.push({ id: `theme-${slug}`, title: `More ${tax.themeTitle(slug)}`, reason: why, sub: `Like ${joinTitles(t.titles.slice(0, 2))}`, items });
    take(items);
    themeGroups.add(info.group);
    themeRows++;
  }

  // 4. From the director of X — a maker they clearly rate
  const makers = new Map(); // people feature id -> { eff, from: anchor }
  for (const a of model.pos) {
    if (a.eff < 1 || !a.v.people) continue;
    for (let i = 0; i < a.v.people.k.length; i++) {
      const name = features.nameOf(a.v.people.k[i]);
      if (!name.startsWith("people|d")) continue; // directors and creators only
      const m = makers.get(a.v.people.k[i]) || { eff: 0, n: 0, from: a, key: name.slice(8) };
      m.eff += a.eff;
      m.n++;
      if (a.eff > m.from.eff) m.from = a;
      makers.set(a.v.people.k[i], m);
    }
  }
  const makerList = [...makers.entries()].sort((x, y) => y[1].eff - x[1].eff || x[0] - y[0]);
  for (const [fid, m] of makerList.slice(0, 6)) {
    // a maker they keep returning to, or one behind something they loved —
    // not whoever happened to direct one film out of fifteen
    if (m.n < 2 && m.from.w < 2.4) continue;
    const pool = [];
    for (const s of scored) {
      if (used.has(s.id) || !s.c.v.people) continue;
      const k = s.c.v.people.k;
      let has = false;
      for (let i = 0; i < k.length; i++) if (k[i] === fid) { has = true; break; }
      if (has && s.quality >= 0.25) pool.push({ ...s, score: 0.5 + s.quality + Math.max(0, s.score) });
    }
    if (pool.length < 4) continue;
    pool.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
    const items = pool.slice(0, sizes.person);
    const isShow = m.from.v.meta && features.unpack(m.from.v.meta)["kind:tv"];
    const name = personName(m.key);
    const title = `From the ${isShow ? "creator" : "director"} of ${m.from.title}`;
    const why = name ? `${title} — ${name}` : title;
    for (const s of items) s.why = why;
    rows.push({ id: `person-${m.key}`, title, reason: why, ...(name ? { sub: name } : {}), items });
    take(items);
    break; // one such row
  }

  // 5. Something different — the controlled share of exploration: well-made
  // titles from corners of the catalogue this person has not been to (not
  // the corners they have walked out of).
  const stretch = [];
  for (const s of scored) {
    if (used.has(s.id)) continue;
    if (s.quality < 0.55 || (s.c.rec.vc || 0) < 400) continue;
    if (s.dislike > 0.15) continue;
    const gs = s.c.v.genres || [];
    if (!gs.length) continue;
    const share = Math.max(...gs.slice(0, 2).map((g) => model.genreShare[g] || 0));
    const nearSim = s.nearest.length ? s.nearest[0].sim : 0;
    if (share > 0.12 || nearSim > 0.22) continue; // that would be more of the same
    // quality gets it in; the day's draw decides which — so the row is not
    // the same ten classics for everybody
    stretch.push({ ...s, score: 0.5 * s.quality + 0.5 * rand01(`${seed}|stretch`, s.id) });
  }
  stretch.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
  const stretchItems = rerank(stretch, { size: sizes.stretch, pool: 80, lambdaDiv: 0.45, lambdaCal: 0 });
  if (stretchItems.length >= 5) {
    for (const s of stretchItems) {
      const g = (s.c.v.genres || [])[0];
      s.why = `Something different: highly rated${g ? ` ${g}` : ""} you haven't tried`;
    }
    rows.push({
      id: "stretch", title: "Something Different", items: stretchItems,
      reason: "Well-made titles outside what you usually watch", sub: "Well made, and outside your usual",
    });
    take(stretchItems);
  }

  return { rows, cold: false, scored, byId };
};

module.exports = {
  scoreAll, rerank, buildRows, tasteScore, whyFor, becauseAnchors, genreMix, klDivergence, rand01,
  W_TASTE, MIX, COLD_MASS, SIZES,
};

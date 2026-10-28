#!/usr/bin/env node
// Skip intro, measured: the detector before (introdetect's analysis 2 — the
// 16-frequency fingerprint, +-3 min of shift, the season's first three
// episodes, seasons of two or more) and now (analysis 3 — introprint.js:
// band energies, offsets by voting, the show's known intros, its other
// seasons) on a labelled set of synthetic shows (synth.js), in the ways an
// episode meets the detector:
//   season   the whole season is on disk; each episode is compared with its
//            siblings, in the order the background pass reads them
//   alone    the newest episode is the only one left in its season (the rest
//            watched and cleaned away) — as it is when it lands
//   urgent   the same, read the moment somebody presses Play: a known intro
//            on the first five minutes first
//   season2  the first episode of a new season, alone in it
// Precision / recall (a hit: an intro found that starts within 3 s of the
// label), and for the hits the start and end error (signed: + = late).
//
//   node tools/intro-eval/run.js [--quick] [--json out.json]
"use strict";
const introdetect = require("../../src/media/introdetect");
const introprint = require("../../src/media/introprint");
const synth = require("./synth");

const I = introdetect._internals;
const HIT_S = 3;

// ---------- before: the analysis-2 intro, as it was ----------
const legacyIntro = (me, siblings, duration) => {
  const runs = [];
  const fr = (s) => Math.round((s * I.SR) / I.HOP);
  for (const o of siblings.slice(0, 3)) {
    const r = I.longestRun(me.old, o.old, fr(180));
    if (!r) continue;
    const start = (r.start * I.HOP) / I.SR;
    const end = ((r.end + 1) * I.HOP) / I.SR;
    const limit = Math.min(duration * 0.25, 600);
    if (end - start >= 15 && end - start <= 150 && start <= limit) runs.push({ start, end });
  }
  return I.consensus(runs);
};

// ---------- now: introdetect's own decision, without the disk ----------
// (analyzeIntro reads files; this is the same comparison and the same rules
// on fingerprints already in hand: known intros first when urgent, then the
// siblings in orderSiblings' order, and learning what was found)
const knownFor = (list, ep) => list
  .filter((t) => t.from !== ep.key)
  .map(I.comparisonOf)
  .filter(Boolean);
const nowIntro = async (ep, siblings, known, { urgent = false } = {}) => {
  const limitS = I.headLimit(ep.duration);
  if (urgent && known.length) {
    if (limitS > I.HEAD_FIRST_S + 30) {
      const early = introprint.fingerprint(ep.pcm.subarray(0, I.HEAD_FIRST_S * synth.SR));
      const r = await I.introFrom(early, known, I.HEAD_FIRST_S);
      if (r && r.trusted && r.end < I.HEAD_FIRST_S - 5) return { intro: r, via: "known" };
    }
    const r = await I.introFrom(ep.fp2, known, limitS);
    if (r && r.trusted) return { intro: r, via: "known" };
  }
  // (copies of this very episode passed over, as analyzeIntro does)
  const distinct = siblings.filter((s) => !introprint.sameRecording(ep.fp2, s.fp2));
  const comparisons = [...known, ...distinct.slice(0, urgent ? 2 : 3).map((s) => ({ fp: s.fp2, trusted: false }))];
  const r = comparisons.length ? await I.introFrom(ep.fp2, comparisons, limitS) : null;
  return { intro: r, via: r ? (r.others > 0 ? "siblings" : "known") : null };
};
const learnInto = (show, ep, found) => {
  if (!found.intro || found.via !== "siblings") return;
  const slice = I.sliceFor(ep.fp2, found.intro);
  if (!slice) return;
  const len = Math.round((found.intro.end - found.intro.start) * 10) / 10;
  show.prints = I.mergePrints(show.prints, slice, { from: ep.key, trust: found.intro.support >= 2 ? "confirmed" : "pair", len }).list;
};

// the library shape orderSiblings expects
const libraryOf = (show) => {
  const seasons = [];
  for (const ep of show.episodes) {
    let s = seasons.find((x) => x.number === ep.season);
    if (!s) seasons.push((s = { number: ep.season, episodes: [] }));
    s.episodes.push(ep);
  }
  return { id: show.name, seasons };
};

// ---------- before: the analysis-2 credits ----------
const legacyCredits = (me, siblings) => {
  const fr = (x) => Math.round((x * I.SR) / I.HOP);
  const runs = [];
  for (const o of siblings.slice(0, 3)) {
    const r = I.tightenStart(me.oldTail, o.oldTail, I.longestRun(me.oldTail, o.oldTail, fr(120)), fr(I.CREDITS_MIN_S));
    if (!r) continue;
    const start = me.tailStart + (r.start * I.HOP) / I.SR;
    const end = me.tailStart + ((r.end + 1) * I.HOP) / I.SR;
    if (end - start >= I.CREDITS_MIN_S) runs.push({ start, end });
  }
  return I.consensus(runs);
};
// When the players put Up next on (playerRules.ts upNextState / player.js)
const upNextWindow = (d) => Math.max(30, Math.min(90, d * 0.05));
const popupAt = (credits, d) => (credits && credits.start > 0 && credits.start < d - 5 ? credits.start : d - upNextWindow(d));

// Credits / Up next: [{ ep, label: {start, scene}, found, popup }]
const scoreCredits = (rows) => {
  const abs = (xs) => xs.map(Math.abs).sort((a, b) => a - b);
  const q = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)] : null);
  const hits = rows.filter((r) => r.found && Math.abs(r.found.start - r.label.start) <= HIT_S);
  const ce = abs(hits.map((r) => r.found.start - r.label.start));
  const pe = rows.map((r) => r.popup - r.label.start);
  const pa = abs(pe);
  const scenes = rows.filter((r) => r.label.scene);
  return {
    episodes: rows.length,
    found: rows.filter((r) => r.found).length,
    recall: rows.length ? hits.length / rows.length : 1,
    precision: rows.filter((r) => r.found).length ? hits.length / rows.filter((r) => r.found).length : 1,
    credits: { median: q(ce, 0.5), p90: q(ce, 0.9), max: ce.length ? ce[ce.length - 1] : null },
    upNext: { median: q(pa, 0.5), p90: q(pa, 0.9), max: pa.length ? pa[pa.length - 1] : null, early: pe.filter((x) => x < -1).length, late: pe.filter((x) => x > 3).length, onTime: pe.filter((x) => x >= -1 && x <= 3).length },
    // a countdown over a scene after the credits (before: always)
    countdownOverScene: scenes.filter((r) => !(r.found && r.found.scene)).length,
    scenes: scenes.length,
    sceneFalse: rows.filter((r) => !r.label.scene && r.found && r.found.scene).length,
  };
};
// Recaps: [{ ep, truth: bool, shown: bool }]
const scoreRecaps = (rows) => {
  const shown = rows.filter((r) => r.shown);
  const right = shown.filter((r) => r.truth);
  const real = rows.filter((r) => r.truth);
  return { claims: rows.length, real: real.length, shown: shown.length, wrongShown: shown.length - right.length, precision: shown.length ? right.length / shown.length : 1, recall: real.length ? right.length / real.length : 1 };
};

const score = (rows) => {
  const labelled = rows.filter((r) => r.label);
  const hits = rows.filter((r) => r.label && r.found && Math.abs(r.found.start - r.label.start) <= HIT_S && r.found.end > r.label.start);
  const fps = rows.filter((r) => r.found && !(r.label && Math.abs(r.found.start - r.label.start) <= HIT_S && r.found.end > r.label.start));
  const abs = (xs) => xs.map(Math.abs).sort((a, b) => a - b);
  const q = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)] : null);
  const se = abs(hits.map((r) => r.found.start - r.label.start));
  const ee = abs(hits.map((r) => r.found.end - r.label.end));
  return {
    episodes: rows.length,
    labelled: labelled.length,
    found: rows.filter((r) => r.found).length,
    hits: hits.length,
    falsePositives: fps.length,
    precision: hits.length + fps.length ? hits.length / (hits.length + fps.length) : 1,
    recall: labelled.length ? hits.length / labelled.length : 1,
    start: { median: q(se, 0.5), p90: q(se, 0.9), max: se.length ? se[se.length - 1] : null, late1: hits.filter((r) => r.found.start - r.label.start > 1).length },
    end: { median: q(ee, 0.5), p90: q(ee, 0.9), max: ee.length ? ee[ee.length - 1] : null },
  };
};

const evaluate = async ({ quick = false, log = () => {} } = {}) => {
  const shows = synth.labelledSet({ quick });
  const rows = { before: [], now: [] };
  const creditRows = { before: [], now: [] };
  const recapRows = { before: [], now: [] };
  const dbRows = { before: [], now: [] };
  let fpMs = { old: 0, now: 0, frames: 0 };
  for (const show of shows) {
    for (const ep of show.episodes) {
      ep.key = ep.id = `${show.name} S${ep.season}E${ep.episode}`;
      const head = ep.pcm.subarray(0, Math.round(Math.min(I.headLimit(ep.duration), ep.pcm.length / synth.SR) * synth.SR));
      let t = Date.now();
      ep.old = I.fingerprint(head);
      fpMs.old += Date.now() - t;
      t = Date.now();
      ep.fp2 = introprint.fingerprint(head);
      fpMs.now += Date.now() - t;
      fpMs.frames += head.length / synth.SR;
      if (ep.tail) { ep.oldTail = I.fingerprint(ep.tail); ep.tail2 = introprint.fingerprint(ep.tail); }
    }
    const lib = libraryOf(show);
    show.prints = [];
    const add = (scenario, ep, before, now) => {
      rows.before.push({ show: show.name, scenario, ep: ep.key, label: ep.label, found: before });
      rows.now.push({ show: show.name, scenario, ep: ep.key, label: ep.label, found: now });
    };
    const bySeason = (n) => show.episodes.filter((e) => e.season === n);
    const s1 = bySeason(1);
    const newest = s1[s1.length - 1];

    // season: every episode but the newest, as the pass reads them
    // (the newest is the one that lands later — "alone" below)
    for (const season of lib.seasons) {
      for (const ep of season.episodes) {
        if (ep === newest) continue;
        const present = season.number === 1 ? season.episodes.filter((e) => e !== newest) : season.episodes;
        const before = present.length >= 2 ? legacyIntro(ep, present.filter((e) => e !== ep), ep.duration) : null;
        const sibs = I.orderSiblings(lib, season, ep).filter((e) => e !== newest);
        const found = await nowIntro(ep, sibs, knownFor(show.prints, ep));
        learnInto(show, ep, found);
        add("season", ep, before, found.intro);
      }
    }
    // alone: the newest S1 episode lands after the rest were cleaned away
    // (before: a season of one was never read)
    {
      const other = show.episodes.filter((e) => e.season !== 1);
      const sibs = I.orderSiblings({ id: show.name, seasons: [{ number: 1, episodes: [newest] }, ...lib.seasons.filter((s) => s.number !== 1)] }, { number: 1, episodes: [newest] }, newest);
      const found = await nowIntro(newest, sibs.filter((e) => other.includes(e)), knownFor(show.prints, newest));
      add("alone", newest, null, found.intro);
      const urgent = await nowIntro(newest, sibs.filter((e) => other.includes(e)), knownFor(show.prints, newest), { urgent: true });
      add("urgent", newest, null, urgent.intro);
    }
    // season2: a new season's first episode, alone in it
    const s2 = bySeason(2);
    if (s2.length) {
      const first = s2[0];
      const libNow = { id: show.name, seasons: [{ number: 1, episodes: s1 }, { number: 2, episodes: [first] }] };
      const found = await nowIntro(first, I.orderSiblings(libNow, libNow.seasons[1], first), knownFor(show.prints, first));
      add("season2", first, null, found.intro);
    }
    // credits and Up next: every episode, its season's others on disk
    for (const season of lib.seasons) {
      for (const ep of season.episodes) {
        if (!ep.tail) continue;
        const before = legacyCredits(ep, season.episodes.filter((e) => e !== ep));
        const now = await I.creditsFrom(ep.tail2, I.orderSiblings(lib, season, ep).slice(0, 3).map((e) => e.tail2), ep.tailStart, ep.duration);
        creditRows.before.push({ show: show.name, ep: ep.key, label: ep.credits, found: before, popup: popupAt(before, ep.duration) });
        creditRows.now.push({ show: show.name, ep: ep.key, label: ep.credits, found: now, popup: popupAt(now, ep.duration) });
      }
    }
    // recaps: what a crowd database might claim — the real recap where there
    // is one, and on the other episodes the mistakes seen in the wild: the
    // cold open called a recap, the intro called a recap. Before: every
    // claim was a button. Now: heard as the episode before (its sound), or
    // not shown (one database alone is never enough).
    {
      const all = [...show.episodes].sort((a, b) => a.season - b.season || a.episode - b.episode);
      all.forEach((ep, i) => {
        const claims = [];
        if (ep.recap) claims.push({ range: ep.recap, truth: true });
        else {
          claims.push({ range: { start: 0, end: Math.max(10, Math.min(25, (ep.label ? ep.label.start : 30) - 1)) }, truth: false });
          if (ep.label) claims.push({ range: { start: ep.label.start, end: ep.label.end }, truth: false });
        }
        for (const c of claims) {
          const intro = ep.label;
          recapRows.before.push({ show: show.name, ep: ep.key, truth: c.truth, shown: true });
          const who = { season: ep.season, episode: ep.episode, intro };
          let shown = false;
          if (require("../../src/media/recaprules").plausibleRecap(c.range, who)) {
            const control = all.filter((e, j) => j > i || j < i - 2).slice(0, 1).map((e) => e.fp2);
            const v = I.recapVerdict(ep.fp2, all.slice(Math.max(0, i - 2), i).reverse().map((e) => e.fp2), c.range, control);
            shown = v.verdict === "heard" || (v.verdict === "unverifiable" && require("../../src/media/recaprules").trustRecap(c.range, { ...who, agreed: false }));
          }
          recapRows.now.push({ show: show.name, ep: ep.key, truth: c.truth, shown });
        }
      });
    }
    // the databases' intro, when our own comparison has nothing to say: right,
    // a little off, from a cut 12 s longer, 7 s shorter, or plain wrong.
    // Before: used as it came. Now: checked against the siblings' sound.
    for (const season of lib.seasons) {
      season.episodes.forEach((ep, i) => {
        if (!ep.label) return;
        const kinds = [["right", 0], ["0.8 s off", 0.8], ["another cut, +12 s", 12], ["another cut, -7 s", -7], ["wrong", 200]];
        const [kind, d] = kinds[(i + ep.season) % kinds.length];
        const db = { start: ep.label.start + d, end: ep.label.end + d };
        const comps = I.orderSiblings(lib, season, ep).slice(0, 3).map((e) => ({ fp: e.fp2, trusted: false }));
        const dbCheck = I.checkDbIntro(ep.fp2, comps, db);
        const now = I.chooseIntro({ v: I.ANALYSIS_V, intro: null, db: { intro: db }, dbCheck });
        dbRows.before.push({ show: show.name, scenario: kind, ep: ep.key, label: ep.label, found: db });
        dbRows.now.push({ show: show.name, scenario: kind, ep: ep.key, label: ep.label, found: now });
      });
    }
    log(`  ${show.name}: ${show.episodes.length} episodes, ${show.prints.length} known intro(s)`);
  }
  const by = (list, f) => {
    const out = {};
    for (const r of list) (out[f(r)] = out[f(r)] || []).push(r);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, score(v)]));
  };
  const byCredits = (list) => {
    const out = {};
    for (const r of list) (out[r.show] = out[r.show] || []).push(r);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, scoreCredits(v)]));
  };
  return {
    before: { all: score(rows.before), byScenario: by(rows.before, (r) => r.scenario), byShow: by(rows.before, (r) => r.show) },
    now: { all: score(rows.now), byScenario: by(rows.now, (r) => r.scenario), byShow: by(rows.now, (r) => r.show) },
    credits: { before: { all: scoreCredits(creditRows.before), byShow: byCredits(creditRows.before) }, now: { all: scoreCredits(creditRows.now), byShow: byCredits(creditRows.now) } },
    recaps: { before: scoreRecaps(recapRows.before), now: scoreRecaps(recapRows.now) },
    database: { before: { all: score(dbRows.before), byKind: by(dbRows.before, (r) => r.scenario) }, now: { all: score(dbRows.now), byKind: by(dbRows.now, (r) => r.scenario) } },
    rows,
    creditRows,
    fingerprintSecondsPerHourOfAudio: { before: (fpMs.old / 1000) / (fpMs.frames / 3600), now: (fpMs.now / 1000) / (fpMs.frames / 3600) },
  };
};

const fmt = (x, d = 2) => (x == null ? "–" : typeof x === "number" ? x.toFixed(d) : String(x));
const table = (title, s) => {
  console.log(`\n${title}`);
  console.log("                         episodes  recall  precision  start med/p90/max   end med/p90/max   late>1s");
  for (const [k, v] of Object.entries(s)) {
    console.log(`  ${k.padEnd(24)}${String(v.episodes).padStart(6)}  ${fmt(v.recall).padStart(6)}  ${fmt(v.precision).padStart(9)}   ${`${fmt(v.start.median)}/${fmt(v.start.p90)}/${fmt(v.start.max)}`.padEnd(18)}${`${fmt(v.end.median)}/${fmt(v.end.p90)}/${fmt(v.end.max)}`.padEnd(18)}${String(v.start.late1).padStart(4)}`);
  }
};

if (require.main === module) {
  (async () => {
    const quick = process.argv.includes("--quick");
    const started = Date.now();
    const r = await evaluate({ quick, log: (l) => console.log(l) });
    table("BEFORE (analysis 2) — by scenario", { ...r.before.byScenario, ALL: r.before.all });
    table("NOW (analysis 3) — by scenario", { ...r.now.byScenario, ALL: r.now.all });
    table("BEFORE — by show", r.before.byShow);
    table("NOW — by show", r.now.byShow);
    const ct = (title, s) => {
      console.log(`\n${title}`);
      console.log("                         episodes  found  recall  credits start med/p90/max   Up next |err| med/p90/max  early/on time/late  countdown over a scene");
      for (const [k, v] of Object.entries(s)) {
        console.log(`  ${k.padEnd(24)}${String(v.episodes).padStart(6)}  ${String(v.found).padStart(5)}  ${fmt(v.recall).padStart(6)}  ${`${fmt(v.credits.median)}/${fmt(v.credits.p90)}/${fmt(v.credits.max)}`.padEnd(28)}${`${fmt(v.upNext.median, 1)}/${fmt(v.upNext.p90, 1)}/${fmt(v.upNext.max, 1)}`.padEnd(26)}${`${v.upNext.early}/${v.upNext.onTime}/${v.upNext.late}`.padEnd(20)}${v.countdownOverScene}/${v.scenes}`);
      }
    };
    ct("CREDITS + UP NEXT — before", { ...r.credits.before.byShow, ALL: r.credits.before.all });
    ct("CREDITS + UP NEXT — now", { ...r.credits.now.byShow, ALL: r.credits.now.all });
    console.log(`\nRECAPS (crowd claims: ${r.recaps.before.claims}, real recaps: ${r.recaps.before.real})`);
    for (const [k, v] of Object.entries(r.recaps)) console.log(`  ${k.padEnd(8)} shown ${v.shown}, wrong ${v.wrongShown}, precision ${fmt(v.precision)}, recall ${fmt(v.recall)}`);
    table("DATABASE INTRO (our own comparison silent) — before: as it came", { ...r.database.before.byKind, ALL: r.database.before.all });
    table("DATABASE INTRO — now: checked against the sound", { ...r.database.now.byKind, ALL: r.database.now.all });
    console.log(`\nfingerprint CPU per hour of audio: before ${fmt(r.fingerprintSecondsPerHourOfAudio.before, 1)} s, now ${fmt(r.fingerprintSecondsPerHourOfAudio.now, 1)} s`);
    console.log(`(${Math.round((Date.now() - started) / 1000)} s)`);
    const j = process.argv.indexOf("--json");
    if (j > 0) require("fs").writeFileSync(process.argv[j + 1], JSON.stringify({ before: r.before, now: r.now, rows: r.rows.now.map(({ show, scenario, ep, label, found }) => ({ show, scenario, ep, label, found })) }, null, 1));
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { evaluate, score, scoreCredits, scoreRecaps, legacyIntro, legacyCredits, popupAt, nowIntro, learnInto, knownFor, libraryOf, table };

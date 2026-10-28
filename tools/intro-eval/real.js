#!/usr/bin/env node
// Skip intro on REAL files, before and now (see run.js for the synthetic set).
// Read-only on the media: each episode's head is decoded once (8 kHz mono, at
// the lowest priority) into --cache and read from there afterwards.
//
//   node tools/intro-eval/real.js --labels labels.json [--cache <dir>] [--time]
//
// labels.json (kept OUT of the repo: it names a household's library):
//   { "<path relative to --root, or absolute>": { "label": { "start": 201.0, "end": 310.6 } | null }, … }
//   --root   the library's shows folder the keys are relative to
// A label is where the episode's sound is the shared intro — measured however
// you trust (by ear, or by where two episodes' WAVEFORMS correlate, which is
// independent of either fingerprint). Shows are the first folder of the key,
// seasons the "Season NN" folder, episodes ordered by name.
//   --time   also time the urgent path on the real file: the first five
//            minutes decoded and matched against the show's known intros
// More, per episode, when the label has it:
//   "credits": { "start": 1385.2, "scene": false }   the credits' first frame
//   "recap": { "start": 0, "end": 31 } | null         where a "Previously on" is
//            (null: there is none — a recap button there is wrong)
//   "imdb", "season", "episode"                        for --ask: the three crowd
//            databases (SkipDB, TheIntroDB, IntroDB) are asked once each (cached
//            in --cache), and each one's intro / credits / recap is scored on its
//            own, then what the player gets before (as it came) and now (checked
//            against the file's sound).
// The tail (the last four minutes) is decoded into --cache as well.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const config = require("../../src/config");
const introprint = require("../../src/media/introprint");
const I = require("../../src/media/introdetect")._internals;
const { legacyIntro, legacyCredits, popupAt, nowIntro, learnInto, knownFor, score, scoreCredits, table } = require("./run");
const skipsegments = require("../../src/media/skipsegments");
const recaprules = require("../../src/media/recaprules");

const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const labelsFile = arg("labels");
if (!labelsFile) { console.error("usage: real.js --labels labels.json --root <shows folder> [--cache dir] [--time]"); process.exit(2); }
const root = arg("root", "");
const cacheDir = arg("cache", path.join(os.tmpdir(), "aurora-intro-eval"));
fs.mkdirSync(cacheDir, { recursive: true });
const labels = JSON.parse(fs.readFileSync(labelsFile, "utf-8"));
const SR = 8000;
const HEAD_S = 720;

const run = (file, args) => new Promise((resolve) => {
  const c = execFile(file, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  try { os.setPriority(c.pid, os.constants.priority.PRIORITY_LOW); } catch {}
});
const decodeHead = async (file, seconds) => {
  const out = await run(config.FFMPEG, ["-v", "error", "-nostdin", "-i", file, "-t", String(seconds), "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"]);
  return out ? new Int16Array(out.buffer, out.byteOffset, Math.floor(out.length / 2)) : null;
};
const durationOf = async (file) => {
  const out = await run(config.FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return out ? parseFloat(out.toString()) || 0 : 0;
};
const headOf = async (rel, file) => {
  const key = rel.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const pcmFile = path.join(cacheDir, `${key}.pcm`);
  const metaFile = path.join(cacheDir, `${key}.json`);
  if (fs.existsSync(pcmFile) && fs.existsSync(metaFile)) {
    const b = fs.readFileSync(pcmFile);
    return { pcm: new Int16Array(b.buffer, b.byteOffset, b.length >> 1), duration: JSON.parse(fs.readFileSync(metaFile, "utf-8")).duration };
  }
  const pcm = await decodeHead(file, HEAD_S);
  const duration = await durationOf(file);
  if (!pcm) return null;
  fs.writeFileSync(pcmFile, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  fs.writeFileSync(metaFile, JSON.stringify({ duration }));
  return { pcm, duration };
};

const tailOf = async (rel, file, duration) => {
  const key = rel.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const pcmFile = path.join(cacheDir, `${key}.tail.pcm`);
  if (!fs.existsSync(pcmFile)) {
    const from = Math.max(0, duration - 240);
    const out = await run(config.FFMPEG, ["-v", "error", "-nostdin", "-ss", String(from), "-i", file, "-t", "240", "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"]);
    if (!out) return null;
    fs.writeFileSync(pcmFile, out);
  }
  const b = fs.readFileSync(pcmFile);
  return { pcm: new Int16Array(b.buffer, b.byteOffset, b.length >> 1), tailStart: Math.max(0, duration - 240) };
};
// the credits picture (creditscv.js), as the server's picture pass reads it, cached
const pictureOf = async (rel, file, duration) => {
  const key = rel.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const f = path.join(cacheDir, `${key}.cv.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf-8"));
  const res = await require("../../src/media/creditscv").detect(file, duration, { ffmpeg: config.FFMPEG, threads: 2, onChild: (c) => { try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} } });
  const cv = res && !res.incomplete && Number.isFinite(res.start) ? { start: res.start, confidence: res.confidence, length: res.length } : { start: null, confidence: 0 };
  fs.writeFileSync(f, JSON.stringify(cv));
  return cv;
};
const wholeOf = async (rel, file, duration) => {
  const key = rel.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const pcmFile = path.join(cacheDir, `${key}.whole.pcm`);
  if (!fs.existsSync(pcmFile)) {
    const out = await run(config.FFMPEG, ["-v", "error", "-nostdin", "-i", file, "-t", String(Math.ceil(duration) + 2), "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"]);
    if (!out) return null;
    fs.writeFileSync(pcmFile, out);
  }
  const b = fs.readFileSync(pcmFile);
  return introprint.fingerprint(new Int16Array(b.buffer, b.byteOffset, b.length >> 1));
};
// The three databases, raw, cached in --cache (one ask per episode, ever).
const UA = { headers: { "User-Agent": "Aurora intro-eval (personal media server)", Accept: "application/json" } };
const getJson = async (url) => { try { const r = await fetch(url, UA); return r.status === 404 ? null : r.ok ? await r.json() : null; } catch { return null; } };
const askAll = async (imdb, season, episode, duration) => {
  const f = path.join(cacheDir, `db-${imdb}-${season}-${episode}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf-8"));
  const qs = (extra) => { const p = new URLSearchParams({ imdb_id: imdb, season: String(season), episode: String(episode), ...extra }); return p.toString(); };
  const sdb = await getJson(`https://api.skipdb.tv/api/segments?${qs({ duration: String(Math.round(duration)) })}`);
  await new Promise((r) => setTimeout(r, 800));
  const tidb = await getJson(`https://api.theintrodb.org/v3/media?${qs({ duration_ms: String(Math.round(duration * 1000)) })}`);
  await new Promise((r) => setTimeout(r, 800));
  const idb = await getJson(`https://api.introdb.app/segments?${qs({})}`);
  const out = { skipdb: sdb, theintrodb: tidb, introdb: idb };
  fs.writeFileSync(f, JSON.stringify(out));
  return out;
};

(async () => {
  // the library, from the keys
  const shows = new Map();
  for (const [rel, v] of Object.entries(labels)) {
    const parts = rel.split(/[\\/]/);
    const showName = parts[0];
    const m = /season\s*(\d+)/i.exec(parts[1] || "");
    const season = m ? Number(m[1]) : 1;
    if (!shows.has(showName)) shows.set(showName, []);
    shows.get(showName).push({ rel, season, label: v.label || null, credits: v.credits || null, recap: v.recap === undefined ? undefined : v.recap, imdb: v.imdb || null, se: v.season || null, epn: v.episode || null, file: path.isAbsolute(rel) ? rel : path.join(root, rel) });
  }
  const rows = { before: [], now: [] };
  const creditRows = { before: [], now: [] };
  const dbRows = []; // per database, per segment
  const fused = { before: [], now: [] };
  const recapRows = { before: [], now: [] };
  const fusedCredits = { before: [], now: [] };
  I.prints.save = () => {}; // (the trust is learned here in memory; never written)
  const ask = process.argv.includes("--ask");
  const timings = [];
  for (const [name, eps] of shows) {
    eps.sort((a, b) => a.season - b.season || a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    eps.forEach((e, i) => { e.episode = i + 1; e.id = e.key = e.rel; });
    for (const e of eps) {
      const h = await headOf(e.rel, e.file);
      if (!h) { e.skip = true; continue; }
      e.pcm = h.pcm;
      e.duration = h.duration;
      const head = e.pcm.subarray(0, Math.round(Math.min(I.headLimit(e.duration), e.pcm.length / SR) * SR));
      e.old = I.fingerprint(head);
      e.fp2 = introprint.fingerprint(head);
    }
    const present = eps.filter((e) => !e.skip);
    const seasons = [];
    for (const e of present) {
      let s = seasons.find((x) => x.number === e.season);
      if (!s) seasons.push((s = { number: e.season, episodes: [] }));
      s.episodes.push(e);
    }
    const lib = { id: name, seasons };
    const show = { prints: [] };
    const add = (scenario, e, before, now) => {
      rows.before.push({ show: name, scenario, ep: e.rel, label: e.label, found: before });
      rows.now.push({ show: name, scenario, ep: e.rel, label: e.label, found: now });
    };
    // season: the background pass over everything on disk
    for (const season of seasons) {
      for (const e of season.episodes) {
        const sib = season.episodes.filter((x) => x !== e);
        const before = sib.length ? legacyIntro(e, sib, e.duration) : null;
        const found = await nowIntro(e, I.orderSiblings(lib, season, e), knownFor(show.prints, e));
        learnInto(show, e, found);
        add("season", e, before, found.intro);
      }
    }
    // alone: each episode as the only one on disk, with what the show's
    // other episodes taught (its own known intro left out); before: nothing
    for (const e of present) {
      const known = knownFor(show.prints, e);
      const found = await nowIntro(e, [], known, { urgent: true });
      add("alone", e, null, found.intro);
      if (process.argv.includes("--time") && known.length && timings.length < 6) {
        const t0 = Date.now();
        const pcm = await decodeHead(e.file, I.HEAD_FIRST_S);
        const t1 = Date.now();
        const fp = await introprint.fingerprintAsync(pcm);
        const t2 = Date.now();
        const r = await I.introFrom(fp, known, I.HEAD_FIRST_S);
        timings.push({ ep: e.rel, decodeMs: t1 - t0, fingerprintMs: t2 - t1, matchMs: Date.now() - t2, found: !!r });
      }
    }
    // credits and Up next (the file's own audio; the picture pass is measured by tools/credits-eval)
    for (const e of present) {
      const t = await tailOf(e.rel, e.file, e.duration);
      if (!t) continue;
      e.tailStart = t.tailStart;
      e.oldTail = I.fingerprint(t.pcm);
      e.tail2 = introprint.fingerprint(t.pcm);
    }
    for (const season of seasons) {
      for (const e of season.episodes) {
        if (!e.credits || !e.tail2) continue;
        const sib = season.episodes.filter((x) => x !== e && x.tail2);
        const before = legacyCredits(e, sib);
        let now = await I.creditsFrom(e.tail2, I.orderSiblings(lib, season, e).filter((x) => x.tail2).slice(0, 3).map((x) => x.tail2), e.tailStart, e.duration);
        // the picture's word, as analyzeCredits has it: a card before the end theme (--picture)
        if (now && process.argv.includes("--picture")) {
          const card = await I.refineCreditsByCard(e.file, now.start);
          if (card != null && card < now.start - 0.3 && card >= now.start - 8) now = { ...now, start: Math.round(card * 100) / 100, card: true };
        }
        creditRows.before.push({ show: name, ep: e.rel, label: e.credits, found: before, popup: popupAt(before, e.duration) });
        creditRows.now.push({ show: name, ep: e.rel, label: e.credits, found: now, popup: popupAt(now, e.duration) });
      }
    }
    // the databases: each on its own, and what the player gets
    if (ask) {
      const ordered = [...present].sort((a, b) => a.season - b.season || a.episode - b.episode);
      // every episode's databases first: which one to trust is learned from
      // the OTHER episodes of the show (introdetect.scoreSources), as on the server
      for (const e of ordered) {
        if (!e.imdb) continue;
        const raw = await askAll(e.imdb, e.se || e.season, e.epn || e.episode, e.duration);
        e.parsed = { skipdb: skipsegments._internals.fromSkipDb(raw.skipdb), theintrodb: skipsegments._internals.fromTidb(raw.theintrodb), introdb: skipsegments._internals.fromIntroDb(raw.introdb) };
        e.merged3 = skipsegments._internals.merge(e.parsed.skipdb, e.parsed.theintrodb, e.duration, e.parsed.introdb);
        const ownRow = rows.now.find((r) => r.ep === e.rel && r.scenario === "season");
        const cr = creditRows.now.find((r) => r.ep === e.rel);
        e.ownRec = { v: I.ANALYSIS_V, intro: ownRow ? ownRow.found : null, introSource: ownRow && ownRow.found ? "audio" : null, support: ownRow && ownRow.found ? ownRow.found.support : null, introTrusted: !!(ownRow && ownRow.found && ownRow.found.trusted), credits: cr ? cr.found : null, creditsSource: cr && cr.found ? "audio" : null, db: e.merged3 };
      }
      const trustFor = (e) => {
        const id = `eval|${name}|${e.rel}`;
        delete I.prints.data[id];
        for (const x of ordered) if (x !== e && x.ownRec) I.scoreSources({ show: { id }, ep: { id: x.rel } }, x.ownRec);
        const t = I.trustOf(id);
        delete I.prints.data[id];
        return t;
      };
      for (const [i, e] of ordered.entries()) {
        if (!e.imdb) continue;
        const parsed = e.parsed;
        const trust = trustFor(e);
        for (const [src, v] of Object.entries(parsed)) {
          for (const t of ["intro", "credits", "recap"]) {
            const truth = t === "intro" ? e.label : t === "credits" ? e.credits : e.recap;
            dbRows.push({ show: name, ep: e.rel, src, type: t, said: v[t] || null, truth: truth === undefined ? undefined : truth });
          }
        }
        const merged2 = skipsegments._internals.merge(parsed.skipdb, parsed.theintrodb, e.duration); // what 1.13.7 asked
        const merged3 = skipsegments._internals.merge(parsed.skipdb, parsed.theintrodb, e.duration, parsed.introdb);
        // our own (the season pass, above) and the check of theirs
        const ownRow = rows.now.find((r) => r.ep === e.rel && r.scenario === "season");
        const own = ownRow ? ownRow.found : null;
        const beforeOwn = (rows.before.find((r) => r.ep === e.rel && r.scenario === "season") || {}).found || null;
        const season = seasons.find((x) => x.number === e.season);
        const comps = [...knownFor(show.prints, e), ...I.orderSiblings(lib, season, e).slice(0, 3).map((x) => ({ fp: x.fp2, trusted: false }))];
        const dbCheck = !own && merged3.intro ? I.checkDbIntro(e.fp2, comps, merged3.intro) : null;
        const rec = { v: I.ANALYSIS_V, intro: own, introSource: own ? "audio" : null, support: own ? own.support : null, introTrusted: own ? own.trusted : false, db: merged3, dbCheck };
        const nowIntroPick = I.chooseIntro(rec, trust);
        // credits / Up next as the player gets them: before — the old audio, else the two databases as they came;
        // now — the new audio, else a database that has been right here
        const oldCr = creditRows.before.find((r) => r.ep === e.rel);
        const newCr = creditRows.now.find((r) => r.ep === e.rel);
        if (e.credits) {
          // (the picture pass is the same before and now: creditscv.js, 1.7.0)
          const cv = process.argv.includes("--picture") ? await pictureOf(e.rel, e.file, e.duration) : null;
          const b = I.chooseCredits({ credits: oldCr && oldCr.found, source: "audio", db: merged2, ...(cv ? { cv } : {}) });
          const n = I.chooseCredits({ credits: newCr && newCr.found, creditsSource: newCr && newCr.found ? "audio" : null, db: merged3, ...(cv ? { cv } : {}) }, trust);
          fusedCredits.before.push({ show: name, ep: e.rel, label: e.credits, found: b, popup: popupAt(b, e.duration) });
          fusedCredits.now.push({ show: name, ep: e.rel, label: e.credits, found: n, popup: popupAt(n, e.duration), source: n && n.source });
        }
        fused.before.push({ show: name, scenario: "player", ep: e.rel, label: e.label, found: beforeOwn || merged2.intro || null });
        fused.now.push({ show: name, scenario: "player", ep: e.rel, label: e.label, found: nowIntroPick, source: nowIntroPick && nowIntroPick.source });
        // recap: before — whatever the databases said was a button; now — heard
        // as the episodes before, or both-agreed under the strict rules
        if (e.recap !== undefined) {
          const claim = merged3.recap;
          const truth = !!e.recap;
          recapRows.before.push({ ep: e.rel, claim: merged2.recap, truth, shown: !!merged2.recap });
          let shown = false;
          if (claim) {
            const who = { season: e.se || e.season, episode: e.epn || e.episode, intro: nowIntroPick };
            if (recaprules.plausibleRecap(claim, who)) {
              const before2 = ordered.slice(Math.max(0, i - 3), i).reverse();
              const wholes = [];
              for (const b of before2) { const w = await wholeOf(b.rel, b.file, b.duration); if (w) wholes.push(w); }
              const control = ordered.filter((x, j) => j > i || j < i - 3).slice(0, 1).map((x) => x.fp2);
              const v = I.recapVerdict(e.fp2, wholes, claim, control);
              shown = v.verdict === "heard" || (v.verdict === "unverifiable" && recaprules.trustRecap(claim, { ...who, agreed: !!(merged3.agreed && merged3.agreed.recap) }));
              recapRows.now.push({ ep: e.rel, claim, truth, shown, verdict: v.verdict, covered: v.covered });
            } else recapRows.now.push({ ep: e.rel, claim, truth, shown: false, verdict: "implausible" });
          } else recapRows.now.push({ ep: e.rel, claim: null, truth, shown: false });
        }
      }
    }
    console.log(`  ${name}: ${present.length} episodes, ${show.prints.length} known intro(s)`);
  }
  const by = (list) => {
    const out = {};
    for (const r of list) (out[r.scenario] = out[r.scenario] || []).push(r);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, score(v)]));
  };
  const byShow = (list) => {
    const out = {};
    for (const r of list) (out[r.show] = out[r.show] || []).push(r);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, score(v)]));
  };
  table("BEFORE (analysis 2)", { ...by(rows.before), ALL: score(rows.before) });
  table("NOW (analysis 3)", { ...by(rows.now), ALL: score(rows.now) });
  table("BEFORE — season, by show", byShow(rows.before.filter((r) => r.scenario === "season")));
  table("NOW — season, by show", byShow(rows.now.filter((r) => r.scenario === "season")));
  if (process.argv.includes("--rows")) {
    for (let i = 0; i < rows.now.length; i++) {
      const b = rows.before[i], n = rows.now[i];
      const f = (x) => (x ? `${x.start.toFixed(2)}–${x.end.toFixed(2)}` : "none");
      console.log(`${n.scenario.padEnd(7)} ${n.ep.slice(-44).padEnd(44)} label ${f(n.label).padEnd(16)} before ${f(b.found).padEnd(16)} now ${f(n.found)}`);
    }
  }
  if (creditRows.now.length) {
    const ct = (title, rs) => {
      const v = scoreCredits(rs);
      const f = (x, d = 2) => (x == null ? "–" : x.toFixed(d));
      console.log(`\n${title}: ${v.episodes} episodes, found ${v.found}, recall ${f(v.recall)}, credits start |err| med/p90/max ${f(v.credits.median)}/${f(v.credits.p90)}/${f(v.credits.max)}; Up next |err| med/p90/max ${f(v.upNext.median, 1)}/${f(v.upNext.p90, 1)}/${f(v.upNext.max, 1)} (early ${v.upNext.early}, on time ${v.upNext.onTime}, late ${v.upNext.late}); countdown over a scene ${v.countdownOverScene}/${v.scenes}`);
    };
    ct("CREDITS + UP NEXT before", creditRows.before);
    ct("CREDITS + UP NEXT now", creditRows.now);
    if (process.argv.includes("--rows")) {
      for (let i = 0; i < creditRows.now.length; i++) {
        const b = creditRows.before[i], n = creditRows.now[i];
        const f = (x) => (x ? x.start.toFixed(2) + (x.scene ? " +scene" : "") : "none");
        console.log(`credits ${n.ep.slice(-44).padEnd(44)} label ${f(n.label).padEnd(14)} before ${f(b.found).padEnd(10)} (Up next ${b.popup.toFixed(1)})  now ${f(n.found).padEnd(10)} (Up next ${n.popup.toFixed(1)})`);
      }
    }
  }
  if (dbRows.length) {
    console.log("\nEACH DATABASE (where a label exists): said / within 3 s of the truth / start |err| median");
    for (const src of ["skipdb", "theintrodb", "introdb"]) {
      for (const t of ["intro", "credits", "recap"]) {
        const rs = dbRows.filter((r) => r.src === src && r.type === t && r.truth !== undefined);
        if (!rs.length) continue;
        const said = rs.filter((r) => r.said);
        const ok = said.filter((r) => r.truth && Math.abs(r.said.start - r.truth.start) <= 3);
        const wrong = said.filter((r) => !r.truth || Math.abs(r.said.start - r.truth.start) > 3);
        const errs = ok.map((r) => Math.abs(r.said.start - r.truth.start)).sort((a, b) => a - b);
        console.log(`  ${src.padEnd(11)} ${t.padEnd(8)} said ${said.length}/${rs.length}, right ${ok.length}, wrong ${wrong.length}${errs.length ? `, |err| median ${errs[errs.length >> 1].toFixed(1)} s` : ""}`);
      }
    }
    if (fusedCredits.now.length) {
      const f = (x, d = 1) => (x == null ? "–" : x.toFixed(d));
      for (const [k, rs] of Object.entries(fusedCredits)) {
        const v = scoreCredits(rs);
        console.log(`UP NEXT AS THE PLAYER GETS IT ${k}: |err| med/p90/max ${f(v.upNext.median)}/${f(v.upNext.p90)}/${f(v.upNext.max)} (early ${v.upNext.early}, on time ${v.upNext.onTime}, late ${v.upNext.late})`);
      }
      if (process.argv.includes("--rows")) for (let i = 0; i < fusedCredits.now.length; i++) { const b = fusedCredits.before[i], n = fusedCredits.now[i]; console.log(`upnext ${n.ep.slice(-44).padEnd(44)} credits ${n.label.start.toFixed(1)}  before ${b.popup.toFixed(1)} (${b.found ? b.found.source : "guess"})  now ${n.popup.toFixed(1)} (${n.found ? n.source : "guess"})`); }
    }
    table("WHAT THE PLAYER GETS (intro) — before: own audio (2) || databases as they came", { player: score(fused.before) });
    table("WHAT THE PLAYER GETS (intro) — now: own audio (3), the databases checked against the sound", { player: score(fused.now) });
    const rr = (title, rs) => {
      const shown = rs.filter((r) => r.shown), right = shown.filter((r) => r.truth), real = rs.filter((r) => r.truth);
      console.log(`${title}: shown ${shown.length}, wrong ${shown.length - right.length}, real recaps ${real.length}, found ${right.length}`);
    };
    if (recapRows.now.length) {
      console.log("");
      rr("RECAP before", recapRows.before);
      rr("RECAP now", recapRows.now);
      if (process.argv.includes("--rows")) for (const r of recapRows.now) console.log(`recap ${r.ep.slice(-44).padEnd(44)} truth ${r.truth ? "yes" : "no "} claim ${r.claim ? `${r.claim.start}–${r.claim.end}` : "none"} -> ${r.shown ? "SHOWN" : "hidden"} ${r.verdict || ""} ${r.covered != null ? r.covered : ""}`);
    }
    if (process.argv.includes("--rows")) for (const r of fused.now) console.log(`player ${r.ep.slice(-44).padEnd(44)} label ${r.label ? `${r.label.start.toFixed(2)}–${r.label.end.toFixed(2)}` : "none"} -> ${r.found ? `${r.found.start.toFixed(2)}–${r.found.end.toFixed(2)} (${r.source})` : "none"}`);
  }
  if (timings.length) {
    console.log("\nurgent path on the real file (first five minutes against the known intro):");
    for (const t of timings) console.log(`  ${t.ep.slice(-50).padEnd(50)} decode ${t.decodeMs} ms, fingerprint ${t.fingerprintMs} ms, match ${t.matchMs} ms, found ${t.found}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });

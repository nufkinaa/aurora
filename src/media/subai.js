// Hebrew subtitles for anything: a title with no Hebrew track — none inside
// the file, none from the subtitle providers (OpenSubtitles, Wizdom) — gets
// one translated by the AI provider the recommender already uses (the same
// OpenRouter key and model, media/ai.js), from the best other track it has.
//
// Who asks for it (never anyone else, never for a stream):
//   landed()  a download landed for somebody whose subtitles are Hebrew
//   played()  somebody whose subtitles are Hebrew started watching it
//   asked()   a player asked the providers for Hebrew and they had none
//             (POST /api/subtitles/fetch — the player's own auto-fetch)
// "Whose subtitles are Hebrew": Settings → Subtitles → Hebrew (prefs.subLang),
// or Hebrew as the last pick by hand in a player (prefs.subPick) — the same
// two things the players switch a track on by (public/js/lang.js).
//
// What it makes: "<video>.Hebrew (AI).srt" beside the video, which the library
// lists as "עברית (AI)" on every device (media/scanner.js); every cue keeps the
// source's exact timing AS IT IS SERVED (a Resync's or the background's
// correction included); lines, tags and right-to-left text are made readable
// (media/subtrans.js). One title at a time, in the background; one batch call
// in flight (the recommender keeps the provider's other slot); budgets per
// title (cues, an estimated and a spent cost) and per day (titles, cost). A
// title that could not be done is not tried again for a week; a title over
// the day's budget waits for the next day.
//
// No key, or "subtitleAi": { "enabled": false }: nothing here runs and the
// players never hear of it.
//
// AURORA_AI_MOCK=1 (a TEST aid, never set in production — the recommender's
// own switch): no key needed, the "model" answers with made-up Hebrew words
// in place of each word, keeping tags, dashes and line breaks.
"use strict";
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");
const T = require("./subtrans");

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MOCK = process.env.AURORA_AI_MOCK === "1";
const DEFAULTS = {
  model: null,        // null: the recommender's (config.AI_MODEL)
  maxCues: 3000,      // a three-hour film has ~2000
  maxUsd: 0.5,        // per title, estimated before and counted while
  dailyTitles: 60,
  dailyUsd: 3,
  priceIn: 0.3,       // USD per million tokens (gemini-2.5-flash on OpenRouter)
  priceOut: 2.5,
  batch: 40,          // cues per call
  batchChars: 2400,
  retryDays: 7,
};
const opts = () => ({ ...DEFAULTS, ...(config.SUB_AI || {}) });
const enabled = () => opts().enabled !== false && (MOCK || !!config.OPENROUTER_KEY);
const modelOf = () => opts().model || config.AI_MODEL;

const store = new JsonStore(path.join(config.DATA_DIR, "sub-ai.json"), { files: {}, tried: {}, day: null });
const events = new EventEmitter();

const deps = {
  scanner: () => require("./scanner"),
  subtitles: () => require("./subtitles"),
  subsync: () => require("./subsync"),
  // the providers, for Hebrew (and for English when there is nothing to
  // translate from): routes/subtitles.js, the route the players use
  providerFetch: (id, lang) => require("../routes/subtitles").fetchFor(id, lang),
  profiles: () => require("../profiles").list(),
  now: () => Date.now(),
  model: null, // tests: async (messages) => ({ text, usage })
  wait: (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }),
};

// ---------- who wants Hebrew ----------
const wantsHebrew = (who) => {
  if (!who) return false;
  let p = null;
  try { p = deps.profiles().find((x) => x && (x.id === who || x.name === who)); } catch {}
  const prefs = (p && p.prefs) || {};
  if (prefs.subPick === "he") return true;
  if (prefs.subPick === "en" || prefs.subPick === "ru") return false;
  return prefs.subLang === "he";
};

// ---------- what a title has ----------
const isFull = (t) => !t.forced && !t.commentary && !/forced|(?:^|[^a-z])signs?(?:[^a-z]|$)|songs|commentary/i.test(String(t.label || ""));
const hasHebrew = (subs) => (subs || []).some((t) => t && t.lang === "he" && isFull(t));

// The track to translate from: English first, then any other language; a
// full track before SDH; the ★ (matches this release) first, then one inside
// the file, then a sidecar found in time, never one that matched nothing.
const pickSource = (subs) => {
  const score = (t) => {
    let s = 0;
    if (t.lang !== "en") s += 100;
    if (t.sdh || /(?:^|[^a-z])(?:sdh|cc)(?:[^a-z]|$)/i.test(String(t.label || ""))) s += 10;
    if (t.star) s -= 5;
    else if (t.embedded) s -= 3;
    const v = t.timing && t.timing.verdict;
    if (v === "unmatched") s += 50;
    else if (v === "in-time" || v === "moved" || v === "parts") s -= 2;
    return s;
  };
  const ok = (subs || []).filter((t) => t && t.url && !t.ai && t.lang && t.lang !== "he" && isFull(t));
  ok.sort((a, b) => score(a) - score(b));
  return ok[0] || null;
};

// ---------- the store ----------
const today = () => new Date(deps.now()).toISOString().slice(0, 10);
const dayUse = () => {
  const d = store.data.day;
  return d && d.day === today() ? d : { day: today(), titles: 0, usd: 0 };
};
// A title that could not be done waits until `until` (asked on every progress
// save, so nothing here touches the disk: a network drive that hangs must not
// hold the server). A replaced copy is a new file — a new path — anyway.
const triedRecently = (video) => {
  const t = store.data.tried[video];
  return !!(t && t.until && deps.now() < t.until);
};
const remember = (video, why, { days = opts().retryDays, until = null } = {}) => {
  store.data.tried[video] = { at: new Date(deps.now()).toISOString(), why, until: until || deps.now() + days * 864e5 };
  store.save();
};

// ---------- the queue ----------
const queue = []; // { id, video, why, skipProviders }
const queued = new Set(); // video paths
let running = null; // { video, id, done, total }

const stateOf = (video) => (running && running.video === video ? "translating" : queued.has(video) ? "queued" : null);
const progressOf = (video) => (running && running.video === video && running.total ? Math.round((running.done / running.total) * 100) / 100 : 0);

// Should this library title get one? -> { ok, why, video, item }
const check = (id) => {
  if (!enabled()) return { ok: false, why: "off" };
  if (!id || String(id).startsWith("torrent|")) return { ok: false, why: "not a library title" };
  const scanner = deps.scanner();
  const item = scanner.findById(id);
  const entry = scanner.resolve(id);
  if (!item || !entry || !entry.path || !item.videoUrl) return { ok: false, why: "not a playable library title" };
  if (hasHebrew(item.subtitles)) return { ok: false, why: "has Hebrew", video: entry.path };
  if (stateOf(entry.path)) return { ok: true, why: stateOf(entry.path), video: entry.path, item, already: true };
  if (triedRecently(entry.path)) return { ok: false, why: store.data.tried[entry.path].why, video: entry.path };
  return { ok: true, video: entry.path, item };
};

// -> "queued" | "translating" | null (nothing will happen)
const ensure = (id, { why = "asked", front = false, skipProviders = false } = {}) => {
  const c = check(id);
  if (!c.ok) return null;
  if (c.already) return stateOf(c.video);
  queued.add(c.video);
  const job = { id, video: c.video, why, skipProviders };
  if (front) queue.unshift(job);
  else queue.push(job);
  console.log(`[subai] ${path.basename(c.video)}: queued (${why})`);
  pump();
  return stateOf(c.video);
};

const pump = () => {
  if (running || !queue.length) return;
  const job = queue.shift();
  queued.delete(job.video);
  running = { video: job.video, id: job.id, done: 0, total: 0 };
  const t0 = deps.now();
  run(job)
    .then((r) => console.log(`[subai] ${path.basename(job.video)}: ${r.ok ? `written (${r.cues} cues, ${r.calls} calls, $${r.usd.toFixed(4)}, ${((deps.now() - t0) / 1000).toFixed(1)} s)` : r.why}`))
    .catch((e) => {
      console.warn(`[subai] ${path.basename(job.video)} failed: ${e.message}`);
      remember(job.video, `failed: ${String(e.message).slice(0, 120)}`);
    })
    .finally(() => {
      running = null;
      setImmediate(pump);
    });
};

// ---------- the model ----------
// The mock: every word becomes a Hebrew word; tags, dashes, numbers, line
// breaks and punctuation stay where they were.
const MOCK_WORDS = ["שלום", "אני", "כאן", "בוא", "נלך", "מה", "קרה", "טוב", "לא", "כן", "אתה", "הוא", "היא", "עכשיו"];
const mockModel = async (messages) => {
  const body = JSON.parse(messages[messages.length - 1].content);
  const out = {};
  let k = 0;
  for (const [id, text] of Object.entries(body.lines || {})) {
    out[id] = String(text).replace(/(<[^>]*>)|([A-Za-zÀ-ɏЀ-ӿ']+)/g, (m, tag) => (tag ? tag : MOCK_WORDS[k++ % MOCK_WORDS.length]));
  }
  await deps.wait(30);
  const text = JSON.stringify(out);
  return { text, usage: { in: Math.round(messages.reduce((n, m) => n + m.content.length, 0) / 3.6), out: Math.round(text.length / 2), usd: 0 } };
};

const callModel = async (messages, outChars) => {
  if (deps.model) return deps.model(messages);
  if (MOCK) return mockModel(messages);
  const o = opts();
  const res = await require("../lib/upstream").fetch(ENDPOINT, {
    method: "POST",
    timeoutMs: 90000,
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:4000",
      "X-Title": "Aurora",
    },
    body: JSON.stringify({
      model: modelOf(),
      messages,
      temperature: 0.2,
      // Hebrew runs to ~1.2 tokens a character of the English it came from;
      // room for that twice over (a model that thinks first spends some)
      max_tokens: Math.min(16000, Math.max(2000, Math.round(outChars * 2.5) + 800)),
      response_format: { type: "json_object" },
      usage: { include: true },
      ...(o.reasoning && typeof o.reasoning === "object" ? { reasoning: o.reasoning } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`OpenRouter ${res.status}: ${body.slice(0, 160)}`), { status: res.status });
  }
  const data = await res.json();
  const u = data.usage || {};
  return {
    text: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "",
    usage: { in: Number(u.prompt_tokens) || 0, out: Number(u.completion_tokens) || 0, usd: Number.isFinite(Number(u.cost)) ? Number(u.cost) : null },
  };
};

const costOf = (usage) => {
  if (!usage) return 0;
  if (usage.usd != null) return usage.usd;
  const o = opts();
  return ((usage.in || 0) * o.priceIn + (usage.out || 0) * o.priceOut) / 1e6;
};

// One batch -> { answers: {id: text}, usd, calls }. A failed call is tried
// again twice, a little later (the provider busy, a timeout); then it throws.
const askBatch = async (batch, from) => {
  const messages = T.messagesFor(batch, from);
  const outChars = batch.items.reduce((n, x) => n + x.send.length, 0);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await callModel(messages, outChars);
      return { answers: T.parseReply(r.text), usd: costOf(r.usage), tokens: r.usage || {} };
    } catch (e) {
      lastErr = e;
      if (e && (e.status === 401 || e.status === 402 || e.status === 403)) break; // the key: no point asking again
      await deps.wait(3000 * (attempt + 1));
    }
  }
  throw lastErr || new Error("no answer");
};

// ---------- one title ----------
const AI_NAME = T.AI_FILE_LABEL;

const cuesOfTrack = async (track, video) => {
  const subtitles = deps.subtitles();
  const emb = /^\/stream\/embedded\/[^/]+\/(\d+)$/.exec(track.url);
  let text = null;
  if (emb) text = await subtitles.vttText({ videoPath: video, trackIndex: Number(emb[1]) });
  else {
    const sub = /^\/stream\/subtitle\/([^/]+)$/.exec(track.url);
    const file = sub && deps.scanner().resolve(sub[1]);
    if (file && file.path) text = await subtitles.vttText({ subPath: file.path });
  }
  return text ? deps.subsync().parse(text) : [];
};

// Translate `cues` -> { cues (translated), kept, usd, calls, tokens }.
// onProgress(done, total) after each batch. Throws when over budget.
const translateCues = async (cues, from, { onProgress = () => {}, maxUsd = opts().maxUsd, meter = { usd: 0 } } = {}) => {
  const o = opts();
  const preps = cues.map((c) => T.prepare(c.text));
  const items = preps.map((p, i) => ({ id: i + 1, send: p.send })).filter((x) => x.send);
  const list = T.batches(items, { size: o.batch, chars: o.batchChars });
  const answers = {};
  let usd = 0;
  let calls = 0;
  const tokens = { in: 0, out: 0 };
  const take = (r, wanted) => {
    usd += r.usd;
    meter.usd = usd;
    calls++;
    tokens.in += r.tokens.in || 0;
    tokens.out += r.tokens.out || 0;
    for (const it of wanted) {
      const a = r.answers[String(it.id)];
      if (T.acceptable(a, it.send)) answers[it.id] = a;
    }
    if (usd > maxUsd * 1.5) throw Object.assign(new Error(`over the title's budget ($${usd.toFixed(3)} spent)`), { budget: true });
  };
  let done = 0;
  for (const b of list) {
    take(await askBatch(b, from), b.items);
    done += b.items.length;
    onProgress(done, items.length);
  }
  // what came back missing or untranslated: asked again in small batches, alone
  const missing = items.filter((it) => !answers[it.id]);
  if (missing.length) {
    for (const b of T.batches(missing, { size: 10, chars: 800, context: 0 })) {
      const prev = items.findIndex((x) => x.id === b.items[0].id);
      b.context = items.slice(Math.max(0, prev - 3), prev).map((x) => x.send);
      try { take(await askBatch(b, from), b.items); } catch (e) { if (e.budget) throw e; }
    }
  }
  let kept = 0;
  const out = cues.map((c, i) => {
    const p = preps[i];
    const a = answers[i + 1];
    let text;
    if (p.skip) text = T.finish(p.source, { ...p, dialogue: false });
    else if (a) text = T.finish(a, p);
    else { kept++; text = T.finish(p.send, p); }
    return { start: c.start, end: c.end, text: text || " " };
  });
  return { cues: out, kept, usd, calls, tokens, sent: items.length };
};

const run = async (job) => {
  const scanner = deps.scanner();
  const fresh = () => scanner.findById(job.id);
  let item = fresh();
  if (!item) return { ok: false, why: "gone from the library" };
  if (hasHebrew(item.subtitles)) return { ok: false, why: "has Hebrew now" };
  // the providers first: a person's translation beats a model's
  if (!job.skipProviders) {
    const r = await deps.providerFetch(job.id, "he").catch(() => null);
    item = fresh();
    if ((r && r.tracks && r.tracks.length) || (item && hasHebrew(item.subtitles))) return { ok: false, why: "the providers had Hebrew" };
  }
  let src = pickSource(item.subtitles);
  if (!src) {
    await deps.providerFetch(job.id, "en").catch(() => null);
    item = fresh();
    src = item ? pickSource(item.subtitles) : null;
  }
  if (!src) {
    remember(job.video, "no subtitle to translate from");
    return { ok: false, why: "no subtitle to translate from" };
  }
  const o = opts();
  const cues = await cuesOfTrack(src, job.video);
  if (cues.length < 5) { remember(job.video, `the ${src.label} track has no lines`); return { ok: false, why: "nothing to translate" }; }
  if (cues.length > o.maxCues) { remember(job.video, `too long (${cues.length} lines)`); return { ok: false, why: `too long (${cues.length} lines)` }; }
  const preps = cues.map((c) => T.prepare(c.text)).filter((p) => p.send);
  const est = T.estimate(preps.map((p) => ({ send: p.send })), { batchCount: Math.ceil(preps.length / o.batch), priceIn: o.priceIn, priceOut: o.priceOut });
  if (est.usd > o.maxUsd) { remember(job.video, `over the title's budget (about $${est.usd.toFixed(3)})`); return { ok: false, why: "over budget" }; }
  const day = dayUse();
  if (day.titles >= o.dailyTitles || day.usd + est.usd > o.dailyUsd) {
    // tomorrow, then (a person who opens it again then gets it)
    const until = Date.parse(`${today()}T00:00:00Z`) + 864e5;
    remember(job.video, "the day's budget is used up", { until });
    return { ok: false, why: "the day's budget is used up" };
  }
  running.total = preps.length;
  const t0 = deps.now();
  const meter = { usd: 0 };
  let r;
  try {
    r = await translateCues(cues, src.lang, { meter, onProgress: (d, n) => { running.done = d; running.total = n; } });
  } finally {
    // what was spent counts, done or not
    const d = dayUse();
    store.data.day = { day: d.day, titles: d.titles + 1, usd: Math.round((d.usd + meter.usd) * 10000) / 10000 };
    store.save();
  }
  if (r.kept > Math.max(3, r.sent * 0.03)) {
    remember(job.video, `${r.kept} of ${r.sent} lines did not come back translated`);
    return { ok: false, why: `${r.kept} of ${r.sent} lines did not come back` };
  }
  // the folder may have got a Hebrew file meanwhile (a provider, the admin)
  item = fresh();
  if (item && hasHebrew(item.subtitles)) return { ok: false, why: "has Hebrew now" };
  const srt = deps.subsync().toSrt(r.cues);
  const base = path.basename(job.video, path.extname(job.video));
  const file = path.join(path.dirname(job.video), `${base}.${AI_NAME}.srt`);
  const tmp = `${file}.part`;
  await fs.promises.writeFile(tmp, srt, "utf8");
  await fs.promises.rename(tmp, file);
  store.data.files[file] = {
    video: job.video,
    from: { label: src.label, lang: src.lang, url: src.url },
    model: deps.model || MOCK ? "mock" : modelOf(),
    cues: cues.length,
    kept: r.kept,
    calls: r.calls,
    tokens: r.tokens,
    usd: Math.round(r.usd * 10000) / 10000,
    estUsd: est.usd,
    ms: deps.now() - t0,
    why: job.why,
    at: new Date(deps.now()).toISOString(),
  };
  delete store.data.tried[job.video];
  store.save();
  events.emit("ready", { video: job.video, id: job.id, file });
  return { ok: true, cues: cues.length, calls: r.calls, usd: r.usd, file };
};

// ---------- the ways in ----------
// (all fire-and-forget: none of them ever waits on the model)
const landed = (destPath, askers = []) => {
  try {
    if (!enabled() || !askers.some(wantsHebrew)) return null;
    const id = deps.scanner().idForPath(destPath);
    return id ? ensure(id, { why: "landed" }) : null;
  } catch { return null; }
};
const played = (profileId, itemId) => {
  try {
    if (!enabled() || !wantsHebrew(profileId)) return null;
    return ensure(itemId, { why: "opened" });
  } catch { return null; }
};
// the providers were just asked for Hebrew and had none
const asked = (id) => {
  try { return ensure(id, { why: "asked", front: true, skipProviders: true }); } catch { return null; }
};

const statusOf = (id) => {
  try {
    const entry = deps.scanner().resolve(id);
    return entry && entry.path ? { state: stateOf(entry.path), progress: progressOf(entry.path) } : null;
  } catch { return null; }
};

const isAiFile = (p) => T.isAiFile(path.basename(p));
const idle = () => !running && !queue.length;

module.exports = {
  enabled, wantsHebrew, hasHebrew, pickSource, ensure, landed, played, asked, statusOf, isAiFile, idle, events, translateCues,
  _internals: { deps, store, queue, check, mockModel, opts, DEFAULTS, dayUse },
};

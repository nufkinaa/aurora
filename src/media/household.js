// Recommendations between the people of the household (elia, 2026-10-27):
// "people in the household can recommend stuff to one another, and it should
// be easy to add to the list of the one who got the recommendation".
//
// One person (the sender) picks a film or a show and one or more people of
// the same server, with an optional short note. The recipient finds it on
// Home in "Recommended by your household" (right under Recommended for You),
// ranked by how many different people recommended the title, then by the
// newest; one press adds it to their My List; "Not for me" takes it away.
// The full list (and what you sent yourself) is the "Show all recommended"
// page. docs/qa/household-recs/DESIGN.md has every decision and its why.
//
// THE RULES
//   Who        any profile on this server but yourself. Not a profile the
//              admin locked; not one that asked to be left out (Settings:
//              "Recommendations from the household" off) — the sender sees
//              it greyed, with why. A request still waiting for approval is
//              not a profile yet.
//   Kids       a kids profile only gets what it may see: the same age gate as
//              everywhere (lib/kids.js; a title with no known rating is out).
//              Refused at the send, and filtered again on the way out (the
//              kids limit can be lowered later).
//   Limits     at most PAIR_PER_HOUR new recommendations from one person to
//              the same person in any rolling hour, and SENDER_PER_HOUR in all
//              (a send to three people is three). Recommending a title again
//              to someone who already has it from you is not a new one: it
//              changes the note and counts nothing. The answer says how long
//              to wait ("You can recommend more to Dana in 23 min").
//   Mute       a recipient can mute one sender (or turn the whole thing off).
//              A muted sender is not told: the send "goes", nothing arrives.
//   Not for me hides the title from that person's row — from every sender,
//              now and later (it said "not for me", not "not from you"). The
//              sender is never told; they see "Seen" at most.
//   Gone       a title the person has watched, is watching, has rated or has
//              on My List leaves the row (it lives in Continue Watching / My
//              List now). Kept for the sender's "Sent" list, which says what
//              became of it: Sent → Seen → In their list → Watching → Watched.
//   Prune      older than KEEP_DAYS (90) goes; so does anything from or to a
//              profile that no longer exists. Daily, and on every write.
//
// The core below is pure: the store, the clock and every fact about the
// household come in through `deps` (realDeps() at the foot wires the
// server's own; the tests hand in fakes).
"use strict";

const PAIR_PER_HOUR = 4;
const SENDER_PER_HOUR = 12;
const HOUR_MS = 60 * 60 * 1000;
const KEEP_DAYS = 90;
const DAY_MS = 24 * HOUR_MS;
const NOTE_MAX = 140;
const ROW_MAX = 15;
const PER_RECIPIENT_MAX = 300;
const TOTAL_MAX = 5000;
const NEW_MS = 7 * DAY_MS; // a recommendation not yet looked at counts as "new" this long

const IMDB_RE = /^tt\d{4,12}$/;
const LIB_RE = /^[\w.-]{1,80}$/;

const blank = () => ({ v: 1, recs: [], sends: {}, settings: {} });

// ---------- words (the TV says the same: tv-native/src/householdRecs.ts) ----------
const names = (list) => {
  const n = list.filter(Boolean);
  if (n.length === 0) return "";
  if (n.length === 1) return n[0];
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  return `${n[0]} and ${n.length - 1} others`;
};
const fromLine = (list) => (list.length ? `From ${names(list)}` : "");
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60000));
const waitWords = (ms) => `${Math.min(60, minutes(ms))} min`;

// The text a person typed, made safe to keep and to show: one line, no
// control characters, at most NOTE_MAX characters (by code point).
const cleanNote = (v) => {
  if (typeof v !== "string") return "";
  const one = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(one).slice(0, NOTE_MAX).join("");
};

// A title, as the store keeps it (the route has already looked a library id
// up; here only the shape is enforced). The key is the IMDb id when there is
// one — the same film from the library and from the catalogue is one title —
// else the library id.
const keyOf = (t) => (t && IMDB_RE.test(String(t.imdbId || "")) ? t.imdbId : t && t.id ? `lib:${t.id}` : null);
const cleanTitle = (t) => {
  if (!t || typeof t !== "object") return null;
  const imdbId = IMDB_RE.test(String(t.imdbId || "")) ? String(t.imdbId) : null;
  const id = typeof t.id === "string" && LIB_RE.test(t.id) && !t.id.startsWith("torrent|") ? t.id : null;
  if (!imdbId && !id) return null;
  const title = String(t.title || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200).trim();
  if (!title) return null;
  const year = Number.isInteger(Number(t.year)) && Number(t.year) > 1800 && Number(t.year) < 3000 ? Number(t.year) : null;
  const pic = (v) => (typeof v === "string" && v.length <= 500 && /^(\/|https:\/\/)/.test(v) ? v : null);
  const out = {
    ...(id ? { id } : {}),
    ...(imdbId ? { imdbId } : {}),
    type: t.type === "show" || t.type === "series" ? "show" : "movie",
    title,
    year,
    poster: pic(t.poster || t.cover),
    genres: Array.isArray(t.genres) ? t.genres.filter((g) => typeof g === "string" && g).slice(0, 8).map((g) => g.slice(0, 40)) : [],
    rating: Number.isFinite(Number(t.rating)) && Number(t.rating) > 0 && Number(t.rating) <= 10 ? Number(t.rating) : null,
  };
  out.key = keyOf(out);
  return out;
};

const make = (deps) => {
  const { store } = deps;
  const now = () => deps.now();
  const data = () => {
    const d = store.data;
    if (!d || typeof d !== "object") store.data = blank();
    const s = store.data;
    if (!Array.isArray(s.recs)) s.recs = [];
    if (!s.sends || typeof s.sends !== "object") s.sends = {};
    if (!s.settings || typeof s.settings !== "object") s.settings = {};
    return s;
  };
  // per recipient: moves on every change that can change what they see
  // (/api/home's memo reads it — routes/api.js homeStamp)
  const revs = new Map();
  let allRev = 0;
  const bump = (...ids) => {
    allRev++;
    for (const id of ids) revs.set(id, (revs.get(id) || 0) + 1);
  };
  const stamp = (profileId) => `${revs.get(profileId) || 0}.${Math.floor(now() / DAY_MS)}`;

  const people = () => deps.people().filter((p) => p && p.id);
  const personOf = (id) => people().find((p) => p.id === id) || null;
  const settingsOf = (id) => {
    const s = data().settings[id];
    return {
      off: !!(s && s.off),
      muted: s && Array.isArray(s.muted) ? s.muted.filter((m) => typeof m === "string") : [],
    };
  };

  // ---------- the rolling hour ----------
  const sendsOf = (from) => {
    const t = now();
    const list = (data().sends[from] || []).filter((s) => s && t - s.at < HOUR_MS);
    return list;
  };
  // How long until `from` may send one more to `to` (0 = now), and why not.
  const wait = (from, to) => {
    const list = sendsOf(from);
    const t = now();
    const pair = list.filter((s) => s.to === to);
    const waits = [];
    if (pair.length >= PAIR_PER_HOUR) {
      const oldest = pair.slice(-PAIR_PER_HOUR)[0];
      waits.push({ ms: oldest.at + HOUR_MS - t, why: "pair" });
    }
    if (list.length >= SENDER_PER_HOUR) {
      const oldest = list.slice(-SENDER_PER_HOUR)[0];
      waits.push({ ms: oldest.at + HOUR_MS - t, why: "all" });
    }
    if (!waits.length) return null;
    return waits.sort((a, b) => b.ms - a.ms)[0];
  };
  const limitLine = (w, name) =>
    w.why === "pair"
      ? `You can recommend more to ${name} in ${waitWords(w.ms)}`
      : `You've sent a lot this hour — you can recommend more in ${waitWords(w.ms)}`;

  // ---------- what a person has done with a title ----------
  // deps.titleState(profileId, title) -> { inList, watching, watched }
  const stateOf = (pid, title) => {
    try { return deps.titleState(pid, title) || {}; } catch { return {}; }
  };
  // deps.ageCheck(profileId, title) -> "ok" | "too-old" | "unrated"
  const ageOf = (pid, title) => {
    try { return deps.ageCheck(pid, title) || "ok"; } catch { return "unrated"; }
  };

  const existing = (from, to, key) => data().recs.find((r) => r.from === from && r.to === to && r.key === key) || null;

  // ---------- the person picker ----------
  // Everyone the sender could pick, each with whether they can get it now:
  //   ok        can get it
  //   sent      has it from you already (sending again updates the note)
  //   seen      has watched it already
  //   kids      a kids profile, and the title is above its age (or unrated)
  //   off       is not taking recommendations
  //   limit     you've sent them (or everyone) enough this hour: `waitMin`
  // A mute is never shown: a muted sender sees "ok".
  const peopleFor = (from, rawTitle) => {
    const title = cleanTitle(rawTitle);
    const out = [];
    for (const p of people()) {
      if (p.id === from || p.locked) continue;
      const base = { id: p.id, name: p.name, avatar: p.avatar || null, avatarImage: p.avatarImage || null, color: p.color || null, kids: !!p.kids };
      let st = "ok";
      let line = "";
      let waitMin = 0;
      const mine = title ? existing(from, p.id, title.key) : null;
      if (settingsOf(p.id).off) { st = "off"; line = "Not taking recommendations"; }
      else if (title && p.kids && ageOf(p.id, title) !== "ok") {
        st = "kids";
        line = ageOf(p.id, title) === "too-old" ? `Not for ${p.name}'s age` : "No age rating yet";
      } else if (mine) { st = "sent"; line = "Already has it from you"; }
      else if (title && stateOf(p.id, title).watched) { st = "seen"; line = "Has watched it"; }
      else {
        const w = wait(from, p.id);
        if (w) { st = "limit"; waitMin = minutes(w.ms); line = `More in ${waitWords(w.ms)}`; }
      }
      out.push({ ...base, state: st, line, waitMin, ...(mine && mine.note ? { note: mine.note } : {}) });
    }
    return out;
  };

  // ---------- sending ----------
  // -> { sent: [{ to, name, updated }], refused: [{ to, name, reason, line, waitMin }], error? }
  const send = (from, toIds, rawTitle, rawNote) => {
    const sender = personOf(from);
    if (!sender) return { error: "not found", status: 404 };
    const title = cleanTitle(rawTitle);
    if (!title) return { error: "That title can't be recommended.", status: 400 };
    const note = cleanNote(rawNote);
    const ids = [...new Set((Array.isArray(toIds) ? toIds : [toIds]).filter((x) => typeof x === "string" && x))].slice(0, 30);
    if (!ids.length) return { error: "Pick who to recommend it to.", status: 400 };
    const sent = [];
    const refused = [];
    const t = now();
    const touched = new Set();
    for (const to of ids) {
      const p = personOf(to);
      if (!p || to === from || p.locked) {
        refused.push({ to, name: p ? p.name : "", reason: "unknown", line: "Can't recommend to that profile" });
        continue;
      }
      if (settingsOf(to).off) {
        refused.push({ to, name: p.name, reason: "off", line: `${p.name} isn't taking recommendations` });
        continue;
      }
      if (p.kids) {
        const age = ageOf(to, title);
        if (age !== "ok") {
          refused.push({ to, name: p.name, reason: "kids", line: age === "too-old" ? `Not for ${p.name}'s age` : `${title.title} has no age rating yet, so ${p.name}'s kids profile can't get it` });
          continue;
        }
      }
      const mine = existing(from, to, title.key);
      if (mine) {
        // the same title again: the note is updated, nothing is counted
        if (note) mine.note = note;
        mine.updatedAt = t;
        mine.title = { ...mine.title, ...title };
        sent.push({ to, name: p.name, updated: true });
        touched.add(to);
        continue;
      }
      if (stateOf(to, title).watched) {
        refused.push({ to, name: p.name, reason: "seen", line: `${p.name} has watched it already` });
        continue;
      }
      const w = wait(from, to);
      if (w) {
        refused.push({ to, name: p.name, reason: "limit", line: limitLine(w, p.name), waitMin: minutes(w.ms) });
        continue;
      }
      const muted = settingsOf(to).muted.includes(from);
      data().recs.push({
        id: `${t.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        from, to, key: title.key, title, note, at: t,
        ...(muted ? { muted: true } : {}),
      });
      const log = (data().sends[from] = sendsOf(from));
      log.push({ to, at: t });
      sent.push({ to, name: p.name, updated: false });
      if (!muted) touched.add(to);
    }
    if (sent.length) {
      prune();
      store.save();
      bump(...touched);
      for (const to of touched) { try { deps.notify(to, { from: sender.name }); } catch {} }
    }
    return { sent, refused };
  };

  // ---------- receiving ----------
  // The recipient's recommendations, one entry per TITLE:
  //   { key, title, from: [{ id, name, note, at }], count, at, unseen }
  // ranked by how many people recommended it, then the newest. Hidden: what
  // was dismissed, muted senders, senders that are gone, what the person has
  // watched / is watching / has on their list, what a kids profile may not see.
  const visible = (to) => {
    const me = personOf(to);
    if (!me || settingsOf(to).off) return [];
    const muted = new Set(settingsOf(to).muted);
    const alive = new Map(people().map((p) => [p.id, p]));
    const groups = new Map();
    const dismissed = new Set(data().recs.filter((r) => r.to === to && r.dismissedAt).map((r) => r.key));
    for (const r of data().recs) {
      if (r.to !== to || r.muted || dismissed.has(r.key) || muted.has(r.from) || !alive.has(r.from)) continue;
      let g = groups.get(r.key);
      if (!g) groups.set(r.key, (g = { key: r.key, title: r.title, recs: [] }));
      g.recs.push(r);
    }
    const out = [];
    for (const g of groups.values()) {
      // the newest copy of the title's details (a later send may carry a better poster)
      const title = g.recs.reduce((a, r) => ((r.updatedAt || r.at) >= (a.updatedAt || a.at) ? r : a)).title;
      const st = stateOf(to, title);
      if (st.inList || st.watched || st.watching) continue;
      if (me.kids && ageOf(to, title) !== "ok") continue;
      const recs = g.recs.sort((a, b) => b.at - a.at);
      out.push({
        key: g.key,
        title,
        from: recs.map((r) => ({ id: r.from, name: alive.get(r.from).name, note: r.note || "", at: r.at })),
        count: recs.length,
        at: recs[0].at,
        unseen: recs.some((r) => !r.seenAt && now() - r.at < NEW_MS),
      });
    }
    return out.sort((a, b) => b.count - a.count || b.at - a.at);
  };

  // Home's row: the first ROW_MAX, and how many there are in all.
  const forRecipient = (to, { from = null } = {}) => {
    const all = visible(to);
    const list = from ? all.filter((g) => g.from.some((f) => f.id === from)) : all;
    const senders = new Map();
    for (const g of all) for (const f of g.from) if (!senders.has(f.id)) senders.set(f.id, { id: f.id, name: f.name, n: 0 });
    for (const g of all) for (const f of g.from) senders.get(f.id).n++;
    return { items: list, total: all.length, people: [...senders.values()] };
  };

  // The recommendations of ONE title for its recipient (the title page and the
  // peek sheet say who and the notes). `seen`: the person has now looked at it.
  const forTitle = (to, key, { seen = false } = {}) => {
    const alive = new Map(people().map((p) => [p.id, p]));
    const muted = new Set(settingsOf(to).muted);
    const recs = data().recs.filter((r) => r.to === to && r.key === key && !r.muted && !muted.has(r.from) && alive.has(r.from));
    if (!recs.length || settingsOf(to).off) return { from: [], dismissed: false };
    const dismissed = recs.some((r) => r.dismissedAt);
    if (seen && recs.some((r) => !r.seenAt)) {
      const t = now();
      for (const r of recs) if (!r.seenAt) r.seenAt = t;
      store.save();
      bump(to);
    }
    return {
      from: recs.sort((a, b) => b.at - a.at).map((r) => ({ id: r.from, name: alive.get(r.from).name, note: r.note || "", at: r.at })),
      dismissed,
    };
  };

  const dismiss = (to, key, undo = false) => {
    const recs = data().recs.filter((r) => r.to === to && r.key === key);
    if (!recs.length) return { ok: false };
    const t = now();
    for (const r of recs) {
      if (undo) delete r.dismissedAt;
      else { r.dismissedAt = t; if (!r.seenAt) r.seenAt = t; }
    }
    store.save();
    bump(to);
    return { ok: true };
  };

  // Everything this person has been shown counts as looked at (the Show all page).
  const markSeen = (to) => {
    const t = now();
    let n = 0;
    for (const r of data().recs) if (r.to === to && !r.seenAt) { r.seenAt = t; n++; }
    if (n) { store.save(); bump(to); }
    return { ok: true, n };
  };

  // ---------- the sender's side ----------
  // What you sent, newest first, and what became of it:
  //   sent · seen · added (on their list) · watching · watched
  // A dismissal reads as "seen"; a mute as "sent".
  const sentBy = (from) => {
    const alive = new Map(people().map((p) => [p.id, p]));
    const groups = new Map();
    for (const r of data().recs) {
      if (r.from !== from || !alive.has(r.to)) continue;
      let g = groups.get(r.key);
      if (!g) groups.set(r.key, (g = { key: r.key, title: r.title, to: [], at: 0 }));
      const st = r.muted ? {} : stateOf(r.to, r.title);
      const status = st.watched ? "watched" : st.watching ? "watching" : st.inList ? "added" : r.seenAt || r.dismissedAt ? "seen" : "sent";
      g.to.push({ id: r.to, name: alive.get(r.to).name, status, at: r.at, note: r.note || "" });
      g.at = Math.max(g.at, r.updatedAt || r.at);
      g.title = r.title;
    }
    return [...groups.values()].sort((a, b) => b.at - a.at);
  };

  // ---------- settings ----------
  const setSettings = (pid, { off, muted } = {}) => {
    const cur = settingsOf(pid);
    const next = { ...cur };
    if (typeof off === "boolean") next.off = off;
    if (Array.isArray(muted)) {
      const ids = new Set(people().map((p) => p.id));
      next.muted = [...new Set(muted.filter((m) => typeof m === "string" && m !== pid && ids.has(m)))].slice(0, 50);
    }
    if (!next.off && !next.muted.length) delete data().settings[pid];
    else data().settings[pid] = { ...(next.off ? { off: true } : {}), ...(next.muted.length ? { muted: next.muted } : {}) };
    store.save();
    bump(pid);
    return settingsFor(pid);
  };
  // What the Settings screen draws: the switch, and the people one could mute
  // (everyone else in the household), each with whether they are muted.
  const settingsFor = (pid) => {
    const s = settingsOf(pid);
    return {
      on: !s.off,
      people: people()
        .filter((p) => p.id !== pid)
        .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar || null, avatarImage: p.avatarImage || null, color: p.color || null, muted: s.muted.includes(p.id) })),
    };
  };

  // ---------- tidying ----------
  const prune = () => {
    const d = data();
    const t = now();
    const ids = new Set(people().map((p) => p.id));
    const before = d.recs.length;
    let recs = d.recs.filter((r) => r && typeof r === "object" && ids.has(r.from) && ids.has(r.to) && t - (r.updatedAt || r.at || 0) < KEEP_DAYS * DAY_MS);
    // bounded: per recipient, then in all — the oldest go first
    const per = new Map();
    recs.sort((a, b) => b.at - a.at);
    recs = recs.filter((r) => {
      const n = (per.get(r.to) || 0) + 1;
      per.set(r.to, n);
      return n <= PER_RECIPIENT_MAX;
    }).slice(0, TOTAL_MAX);
    recs.sort((a, b) => a.at - b.at);
    const changed = recs.length !== before;
    d.recs = recs;
    for (const [from, list] of Object.entries(d.sends)) {
      const kept = Array.isArray(list) ? list.filter((s) => s && t - s.at < HOUR_MS) : [];
      if (!ids.has(from) || !kept.length) delete d.sends[from];
      else d.sends[from] = kept;
    }
    for (const [pid, s] of Object.entries(d.settings)) {
      if (!ids.has(pid)) { delete d.settings[pid]; continue; }
      if (s && Array.isArray(s.muted)) {
        s.muted = s.muted.filter((m) => ids.has(m));
        if (!s.muted.length) delete s.muted;
      }
      if (!s || (!s.off && !s.muted)) delete d.settings[pid];
    }
    if (changed) bump(...ids);
    return { removed: before - recs.length };
  };
  const daily = () => {
    const r = prune();
    store.save();
    return r;
  };

  return {
    peopleFor, send, forRecipient, forTitle, dismiss, markSeen, sentBy,
    settingsFor, setSettings, prune, daily, stamp,
    _internals: { data, wait, visible, rev: () => allRev },
  };
};

// ---------- the server's own wiring ----------
const realDeps = () => {
  const path = require("path");
  const config = require("../config");
  const { JsonStore } = require("../lib/jsonstore");
  const profiles = require("../profiles");
  const scanner = require("./scanner");
  const identity = require("./identity");
  const kids = require("../lib/kids");
  const realtime = require("../realtime");
  const certOf = (item) => require("../routes/api")._internals.kidsCertOf(item);

  // Everything a person has a relationship with, by title key, worked out
  // once per profile per change (their own writes move signalsStamp; the
  // library moving moves scanner.index.version).
  const memo = new Map(); // profileId -> { stamp, inList:Set, watching:Set, watched:Set }
  const factsOf = (pid) => {
    const st = `${profiles.signalsStamp(pid)}|${scanner.index.version}`;
    const hit = memo.get(pid);
    if (hit && hit.stamp === st) return hit;
    const libKeyOf = (id) => {
      const item = scanner.findById(id);
      if (!item) return [`lib:${id}`];
      const show = item.showId ? scanner.findById(item.showId) : null;
      const t = show || item;
      const imdb = t.imdbId || identity.imdbIdFor(t);
      return [`lib:${t.id}`, ...(imdb ? [imdb] : [])];
    };
    const inList = new Set();
    for (const e of profiles.getWatchlist(pid) || []) {
      if (typeof e === "string") for (const k of libKeyOf(e)) inList.add(k);
      else if (e && e.imdbId) inList.add(e.imdbId);
    }
    const watching = new Set();
    const watched = new Set();
    const view = profiles.getProgressView(pid) || {};
    for (const [id, row] of Object.entries(view)) {
      if (!row) continue;
      const item = scanner.findById(id);
      const isEpisode = !!(item && item.showId);
      const keys = id.startsWith("torrent|") || id.startsWith("stream|") ? [] : libKeyOf(id);
      for (const k of keys) {
        if (row.finished && !isEpisode) watched.add(k);
        else if (row.position > 0 || row.finished) watching.add(k);
      }
    }
    const stateRaw = profiles.stateOf(pid) || {};
    for (const [k, row] of Object.entries(stateRaw.titles || {})) {
      if (!row) continue;
      const [imdb, s] = String(k).split(":");
      if (s === undefined && row.finished) watched.add(imdb);
      else if (row.position > 0 || row.finished) watching.add(imdb);
    }
    // a rated title has been seen by definition (Home reads it the same way)
    for (const k of Object.keys(stateRaw.ratings || {})) {
      if (IMDB_RE.test(k)) watched.add(k);
      else for (const x of libKeyOf(k)) watched.add(x);
    }
    const rec = { stamp: st, inList, watching, watched };
    memo.set(pid, rec);
    if (memo.size > 200) memo.delete(memo.keys().next().value);
    return rec;
  };
  const keysOf = (title) => [title.key, title.imdbId, title.id ? `lib:${title.id}` : null].filter(Boolean);

  return {
    store: new JsonStore(path.join(config.DATA_DIR, "household-recs.json"), blank),
    now: () => Date.now(),
    people: () => profiles.list().map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, avatarImage: p.avatarImage || null, color: p.color,
      locked: !!p.locked, kids: profiles.kidsOf(p.id),
    })),
    titleState: (pid, title) => {
      const f = factsOf(pid);
      const ks = keysOf(title);
      // the library copy of a catalogue title is the same title
      if (title.imdbId) {
        try {
          const lib = identity.findLibraryFor({ imdbId: title.imdbId, type: title.type });
          if (lib) ks.push(`lib:${lib.id}`);
        } catch {}
      }
      return {
        inList: ks.some((k) => f.inList.has(k)),
        watching: ks.some((k) => f.watching.has(k)),
        watched: ks.some((k) => f.watched.has(k)),
      };
    },
    ageCheck: (pid, title) => {
      const k = profiles.kidsOf(pid);
      if (!k) return "ok";
      const item = { imdbId: title.imdbId || undefined, type: title.type, ...(title.id ? { id: title.id } : {}) };
      const age = kids.ageOf(certOf(item));
      if (age == null) return "unrated";
      return age <= k.maxAge ? "ok" : "too-old";
    },
    // A ping to the recipient's open apps: "something new arrived". It says
    // nothing about what — the app asks for that on its own (gated) route.
    notify: (to) => {
      const p = profiles.list().find((x) => x.id === to);
      for (const c of realtime.clientsOfProfile(p)) {
        try { realtime.sendTo(c.id, { type: "household_recs", profile: to }); } catch {}
      }
    },
  };
};

let live = null;
const instance = () => live || (live = make(realDeps()));

module.exports = {
  make,
  cleanTitle,
  cleanNote,
  keyOf,
  names,
  fromLine,
  PAIR_PER_HOUR,
  SENDER_PER_HOUR,
  NOTE_MAX,
  ROW_MAX,
  KEEP_DAYS,
  instance,
};

// "Nobody touched it for 45 days" — the rule behind the admin's delete
// suggestions (admin → Downloads → Free up space). elia, 2026-11-09:
//
//   "content that is older then 45 days should be deleted, this means that if
//    I have started a movie and then haven't touched it for 45 days then it
//    should delete it, unless it's the last thing the user has watched and
//    for all that time he wasn't connected to aurora at all"
//
// and then: "No let's not show leaves aurora for users … we can just push it
// to be there when I press suggestion for delete, and not delete
// automatically. Also if someone has not connected I want to save his last
// content, so when he comes back the last thing he saw will be there."
//
// So NOTHING HERE DELETES ANYTHING. This module only answers which titles to
// SUGGEST, with why; the admin ticks and confirms, and the existing deletes in
// routes/admin.js do the rest (each one checked again at the press).
//
// THE RULE, per film and per episode (a show is judged episode by episode):
//
//   touched    any of: someone PLAYED it (the position really moved forward —
//              opening it, or a resume that never played, does not count);
//              it LANDED (a download finished, an upload was placed, or the
//              file's date in the library); someone ASKED for it (a person's
//              download or "Get another version" — not an automatic one).
//              Never played = counts from the day it landed.
//   suggested  nobody touched it for `untouchedDays` (45) days: in the group
//              "Nobody watched for N days" when it was ever played, else
//              "Never played".
//   never      - being played right now (listed, greyed, never counted);
//   offered    - a download for it on its way, a file being moved or worked on
//                (lib/busyfiles.js), its drive not answering ("held");
//              - pinned "Keep" by the admin ("Kept by you");
//              - an admin upload ("Add your own file"), unless the setting
//                says otherwise (off by default);
//              - on someone's My List, only when "Keep titles on someone's
//                My List" is on (off by default: elia's rule is literal);
//              - THE LAST THING SOMEONE WATCHED while that person has not
//                been connected to Aurora at all since then (for an episode:
//                that one and the next one on disk) — "Kept for <name>, away
//                since <day>". The admin can still remove one deliberately,
//                with a stronger question.
//   back       the first time that person connects again (any screen, any
//              device: presence heartbeats, a signed-in request, a progress
//              save — RETURN_GAP_MS after their last play) the protection ends
//              and those titles count as touched THAT DAY: the normal 45 days
//              run from the return.
//
// What it remembers (data/untouched.json): when each title was last really
// played and by whom, each person's last play and last connection, the
// returns, the admin's Keep pins, the uploads, and what the admin removed
// ("Removed recently"). On its first load it fills the plays in once from the
// watch history already there (a minute in, or finished) and the last
// connections from the sign-in sessions and the profile device log.
//
// make(deps) takes everything outside as `deps`, so the tests run every rule
// on a fake clock with nothing real behind it.
"use strict";

const DAY = 86400e3;
const RETURN_GAP_MS = 2 * 3600e3;   // connected this long after the last play = came back
const PLAY_MIN_S = 3;               // the position moved forward at least this much = it played
const BACKFILL_MIN_S = 60;          // the history already there: a minute in, or finished
const SAVE_EVERY_MS = 10 * 60e3;    // plays and connections are written at most this often per row
const REMOVED_MAX = 300;
const REMOVED_KEEP_MS = 180 * DAY;
const BOOST_KEEP_MS = 400 * DAY;
const LIVE_JOB = new Set(["pending", "approved", "downloading"]);

// ---------- settings (data/settings.json, lib/settings.js) ----------
const DEFAULTS = Object.freeze({
  untouchedDays: 45,           // nobody touched it this long → suggested
  untouchedUploads: false,     // true: the admin's own uploads can be suggested too
  untouchedKeepMyList: false,  // true: a title on someone's My List is never suggested
});
const LIMITS = Object.freeze({ untouchedDays: [1, 3650] });
const BOOLS = ["untouchedUploads", "untouchedKeepMyList"];

const wholeIn = (v, [lo, hi]) => {
  if (typeof v === "boolean" || v === null || v === "") return null;
  const n = typeof v === "number" ? v : /^\s*\d{1,4}\s*$/.test(String(v)) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const readSettings = (data) => {
  const d = data && typeof data === "object" ? data : {};
  const out = {};
  for (const k of BOOLS) out[k] = typeof d[k] === "boolean" ? d[k] : DEFAULTS[k];
  out.untouchedDays = wholeIn(d.untouchedDays, LIMITS.untouchedDays) ?? DEFAULTS.untouchedDays;
  return out;
};
// Only the keys sent change; everything is checked first. → { value } | { error }
const parseSettings = (body, current) => {
  const next = { ...readSettings(current) };
  const b = body && typeof body === "object" ? body : {};
  for (const k of BOOLS) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") return { error: `${k} must be true or false.` };
    next[k] = b[k];
  }
  if (b.untouchedDays !== undefined) {
    const n = wholeIn(b.untouchedDays, LIMITS.untouchedDays);
    if (n == null) return { error: `Days must be a whole number from ${LIMITS.untouchedDays[0]} to ${LIMITS.untouchedDays[1]}.` };
    next.untouchedDays = n;
  }
  return { value: next };
};

// ---------- pure helpers ----------
// A progress save that PLAYED: the position moved forward since the last
// save (a resume point reached again, opening and closing, a backwards seek
// do not). `prev` is the row before this save.
const realPlay = (prev, position) => {
  const pos = Number(position);
  if (!Number.isFinite(pos)) return false;
  const was = prev && typeof prev.position === "number" ? prev.position : 0;
  return pos - was >= PLAY_MIN_S;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "Sep 18" (this year) / "Sep 18, 2025"
const dayText = (ms, now) => {
  if (!ms) return "";
  const d = new Date(ms);
  const same = new Date(now).getFullYear() === d.getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${same ? "" : `, ${d.getFullYear()}`}`;
};
const daysSince = (t, now) => Math.max(0, Math.floor((now - t) / DAY));
const daysWord = (n) => (n === 1 ? "1 day" : `${n} days`);
const pad = (n) => String(n || 0).padStart(2, "0");
const newer = (a, b) => (!a ? b || null : !b ? a : (b.at || 0) > (a.at || 0) ? b : a);

// The title key a download job is for ("tt1" / "tt1:2:5"); a season pack
// (episode empty) is "tt1:2:" — a prefix.
const jobKey = (j) => {
  if (!j || !j.imdbId) return null;
  if (j.type === "show" || j.season != null) {
    if (j.season == null || j.season === "") return `${j.imdbId}:`;
    if (j.episode == null || j.episode === "") return `${j.imdbId}:${Number(j.season)}:`;
    return `${j.imdbId}:${Number(j.season)}:${Number(j.episode)}`;
  }
  return String(j.imdbId);
};
const jobMatches = (j, item, norm) => {
  if (j.destPath && item.path) {
    const a = norm(item.path);
    const b = norm(j.destPath);
    if (a === b || a.startsWith(b.endsWith("/") || b.endsWith("\\") ? b : b + (b.includes("\\") ? "\\" : "/"))) return true;
  }
  const k = jobKey(j);
  if (!k || !item.key) return false;
  return k.endsWith(":") ? item.key.startsWith(k) && item.kind === "episode" : k === item.key;
};
// A person pressed Download / Get another version — not something queued by itself.
const askedByPerson = (j) => !j.smart && !j.auto;

// ---------- the rule, pure ----------
//   items    every film and episode on disk: { id, kind: "movie"|"episode",
//            name, title, path, sizeBytes, addedAt, key, cover, show, season,
//            episode, inUse, drive, down, busy }
//   plays    { id|key: { at, by } } — the last real play, and who
//   boosts   { id|key: { at, by } } — a person came back to it (their last title)
//   jobs     downloads: { status, smart, auto, destPath, imdbId, type, season,
//            episode, at (ms), doneAt (ms), by (a name) }
//   uploads  Map(normalized path → placed at)
//   people   [{ id, name, lastPlay: { itemId, key, at } | null, lastSeen,
//            returned: { watchAt, at } | null, list: Set<library id> }]
//   pins     { id: { at, name, kind } } — a film, a show or an episode
// → { days, idle, never, away, pinned, held, exempt, keepIds, suggestIds }
const judge = ({ now, settings, items = [], plays = {}, boosts = {}, jobs = [], uploads = new Map(), people = [], pins = {}, norm = (p) => String(p || "") }) => {
  const s = readSettings(settings);
  const days = s.untouchedDays;
  const limit = days * DAY;
  const byId = new Map(items.map((it) => [it.id, it]));
  const nameOf = (pid) => { const p = people.find((x) => x.id === pid); return p ? p.name : null; };

  // the episodes of each show in order: "the next one on disk"
  const next = new Map();
  const prev = new Map();
  const byShow = new Map();
  for (const it of items) {
    if (it.kind !== "episode" || !it.show) continue;
    if (!byShow.has(it.show.id)) byShow.set(it.show.id, []);
    byShow.get(it.show.id).push(it);
  }
  for (const eps of byShow.values()) {
    eps.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
    for (let i = 0; i + 1 < eps.length; i++) { next.set(eps[i].id, eps[i + 1]); prev.set(eps[i + 1].id, eps[i]); }
  }

  // who is away, and what is kept for them
  const kept = new Map(); // id -> [{ person, awaySince, lastAt, next }]
  const awayPeople = [];
  for (const p of people) {
    const lp = p.lastPlay;
    if (!lp || !lp.at) continue;
    const back = (p.returned && p.returned.watchAt === lp.at) || (p.lastSeen || 0) > lp.at + RETURN_GAP_MS;
    if (back) continue;
    const targets = items.filter((it) => it.id === lp.itemId || (lp.key && it.key === lp.key));
    const awaySince = Math.max(p.lastSeen || 0, lp.at);
    awayPeople.push({ id: p.id, name: p.name, awaySince, lastAt: lp.at, items: targets.map((t) => t.id) });
    const add = (it, isNext) => {
      if (!kept.has(it.id)) kept.set(it.id, []);
      if (!kept.get(it.id).some((k) => k.person === p.name)) kept.get(it.id).push({ person: p.name, personId: p.id, awaySince, lastAt: lp.at, next: isNext });
    };
    for (const t of targets) {
      add(t, false);
      const n = t.kind === "episode" ? next.get(t.id) : null;
      if (n) add(n, true);
    }
    // their last episode was streamed, not on disk: the next one on disk is still theirs
    const ep = !targets.length && lp.key ? /^(.+):(\d+):(\d+)$/.exec(lp.key) : null;
    if (ep) {
      const [, imdb, s, e] = ep;
      const after = items
        .map((it) => ({ it, m: it.kind === "episode" && it.key ? /^(.+):(\d+):(\d+)$/.exec(it.key) : null }))
        .filter(({ m }) => m && m[1] === imdb && (+m[2] > +s || (+m[2] === +s && +m[3] > +e)))
        .sort((a, b) => (+a.m[2] - +b.m[2]) || (+a.m[3] - +b.m[3]))[0];
      if (after) add(after.it, true);
    }
  }

  const pinOf = (it) => pins[it.id] || (it.show && pins[it.show.id]) || null;
  const touchOf = (it) => {
    const played = newer(plays[it.id], it.key ? plays[it.key] : null);
    let back = newer(boosts[it.id], it.key ? boosts[it.key] : null);
    // the episode after a person's last one came back with it
    const before = it.kind === "episode" ? prev.get(it.id) : null;
    if (before) back = newer(back, newer(boosts[before.id], before.key ? boosts[before.key] : null));
    let landed = it.addedAt || 0;
    let asked = null;
    let writing = null;
    for (const j of jobs) {
      if (!jobMatches(j, it, norm)) continue;
      if (j.status === "done" && j.doneAt && j.destPath && norm(j.destPath) === norm(it.path)) landed = Math.max(landed, j.doneAt);
      if (askedByPerson(j) && j.at) asked = newer(asked, { at: j.at, by: j.by || null });
      if (LIVE_JOB.has(j.status)) writing = j;
    }
    const up = uploads.get(norm(it.path));
    if (up) landed = Math.max(landed, up);
    const all = [
      played && { kind: "played", at: played.at, by: nameOf(played.by) || played.by || null },
      landed && { kind: "arrived", at: landed },
      asked && { kind: "asked", at: asked.at, by: asked.by },
      back && { kind: "back", at: back.at, by: nameOf(back.by) || back.by || null },
    ].filter(Boolean);
    const last = all.reduce((a, b) => (!a || b.at > a.at ? b : a), null);
    return { played, landed, asked, back, last, writing, upload: !!up };
  };

  const whyOf = (it, t) => {
    let later = t.last && t.played && t.last.at > t.played.at ? t.last : !t.played && t.last && t.last.kind !== "arrived" ? t.last : null;
    // coming back the same evening or the next day is not news
    if (later && later.kind === "back" && later.at - (t.played ? t.played.at : t.landed || 0) < 2 * DAY) later = null;
    const tail = later
      ? ` · ${later.kind === "asked" ? `asked for${later.by ? ` by ${later.by}` : ""}` : later.kind === "back" ? `${later.by || "someone"} came back` : "arrived again"} on ${dayText(later.at, now)}`
      : "";
    if (t.played) {
      const by = t.played.by ? nameOf(t.played.by) || t.played.by : null;
      return `Nobody watched for ${daysWord(daysSince(t.played.at, now))} · last played${by ? ` by ${by}` : ""} on ${dayText(t.played.at, now)}${tail}`;
    }
    return `Never played · arrived ${dayText(t.landed, now)}${tail}`;
  };

  const rowOf = (it, t, group) => ({
    key: `${group === "away" ? "a" : "x"}:${it.id}`, id: it.id, group, kind: it.kind, name: it.name, title: it.title || null,
    show: it.show || null, season: it.season ?? null, episode: it.episode ?? null, cover: it.cover || (it.show && it.show.cover) || null,
    sizeBytes: it.inUse ? 0 : it.sizeBytes || 0, fileBytes: it.sizeBytes || 0, drive: it.drive || null,
    askedBy: t.asked ? t.asked.by : null, askedAt: t.asked ? t.asked.at : null, upload: t.upload,
    lastPlayed: t.played ? { at: t.played.at, by: nameOf(t.played.by) || t.played.by || null } : null,
    landedAt: t.landed || null, lastTouch: t.last ? t.last.at : null, idleDays: t.last ? daysSince(t.last.at, now) : null,
    inUse: !!it.inUse, why: whyOf(it, t),
  });

  const idle = [];
  const never = [];
  const away = [];
  const held = [];
  const exempt = { uploads: 0, mylist: 0 };
  const keepIds = new Set();
  for (const it of items) {
    if (!(it.sizeBytes > 0)) continue;
    const t = touchOf(it);
    const pin = pinOf(it);
    if (pin) { keepIds.add(it.id); continue; }
    const forAway = kept.get(it.id);
    if (forAway) {
      keepIds.add(it.id);
      // listed only where the rule would have offered it (a title watched
      // last night is simply not suggested, without a line about it)
      if (!t.last || now - t.last.at < limit) continue;
      const k = forAway[0];
      const r = rowOf(it, t, "away");
      const who = forAway.map((x) => x.person);
      r.people = who;
      r.awaySince = k.awaySince;
      r.reason = r.why;
      r.why = `Kept for ${who.join(" and ")} — away since ${dayText(k.awaySince, now)}${k.next ? " · the episode after their last one" : forAway.length > 1 ? "" : " · the last thing they watched"}`;
      away.push(r);
      continue;
    }
    if (t.upload && !s.untouchedUploads) { keepIds.add(it.id); exempt.uploads++; continue; }
    if (s.untouchedKeepMyList && people.some((p) => p.list && (p.list.has(it.id) || (it.show && p.list.has(it.show.id))))) { keepIds.add(it.id); exempt.mylist++; continue; }
    if (!t.last || now - t.last.at < limit) continue;
    const hold = t.writing ? "a download for it is on its way" : it.busy ? String(it.busy) : it.down ? "its drive is not answering" : null;
    if (hold) { keepIds.add(it.id); held.push({ id: it.id, name: it.name, why: hold }); continue; }
    (t.played ? idle : never).push(rowOf(it, t, t.played ? "idle" : "never"));
  }
  const order = (a, b) => (a.lastTouch || 0) - (b.lastTouch || 0) || b.fileBytes - a.fileBytes || a.name.localeCompare(b.name);
  idle.sort(order);
  never.sort(order);
  away.sort((a, b) => (a.awaySince || 0) - (b.awaySince || 0) || a.name.localeCompare(b.name));

  // the admin's Keep pins, whatever they are
  const pinned = [];
  for (const [id, pin] of Object.entries(pins)) {
    const it = byId.get(id);
    const eps = it ? [it] : items.filter((x) => x.show && x.show.id === id);
    const sizeBytes = eps.reduce((n, x) => n + (x.sizeBytes || 0), 0);
    const first = eps[0];
    pinned.push({
      key: `k:${id}`, id, kind: it ? it.kind : eps.length ? "show" : pin.kind || "title",
      name: it ? it.name : first && first.show ? first.show.title : pin.name || id,
      cover: it ? it.cover || null : first && first.show ? first.show.cover || null : null,
      sizeBytes, episodes: it ? null : eps.length, onDisk: eps.length > 0, at: pin.at || null,
      why: `Kept by you${pin.at ? ` on ${dayText(pin.at, now)}` : ""} — never suggested`,
    });
  }
  pinned.sort((a, b) => (b.at || 0) - (a.at || 0));

  const suggestIds = new Set([...idle, ...never].map((r) => r.id));
  return { days, settings: s, idle, never, away, pinned, held, exempt, awayPeople, keepIds, suggestIds };
};

// The totals the page shows: what can be chosen (not being played).
const totalsOf = (rows) => ({
  count: rows.filter((r) => !r.inUse).length,
  bytes: rows.reduce((n, r) => n + (r.inUse ? 0 : r.sizeBytes || 0), 0),
});

// ---------- over injected dependencies ----------
const make = (deps) => {
  const d = deps;
  const data = () => {
    if (!d.store.data || typeof d.store.data !== "object" || Array.isArray(d.store.data)) d.store.data = {};
    const x = d.store.data;
    for (const k of ["plays", "boosts", "lastPlay", "lastSeen", "returns", "pins", "uploads"]) if (!x[k] || typeof x[k] !== "object" || Array.isArray(x[k])) x[k] = {};
    if (!Array.isArray(x.removed)) x.removed = [];
    return x;
  };
  const save = () => d.store.save();
  const log = (m) => d.log(`[cleanup] ${m}`);
  const settings = () => readSettings(d.settingsData());
  const personName = (pid) => { const p = d.people().find((x) => x.id === pid); return p ? p.name : pid; };

  // ----- the history already there, once -----
  const backfill = () => {
    const x = data();
    if (x.since) return false;
    const now = d.now();
    x.since = now;
    let plays = 0;
    for (const p of d.people()) {
      let last = null;
      const played = (row) => row && row.updatedAt > 0 && !row.marked && (row.finished || (row.position || 0) >= BACKFILL_MIN_S);
      const note = (id, row) => {
        const cur = x.plays[id];
        if (!cur || cur.at < row.updatedAt) { x.plays[id] = { at: row.updatedAt, by: p.id }; plays++; }
      };
      const lastIs = (itemId, key, row) => { if (!last || row.updatedAt > last.at) last = { itemId, key, at: row.updatedAt }; };
      const view = d.progressView(p.id) || {};
      const streams = d.streamItems(p.id) || {};
      for (const [itemId, row] of Object.entries(view)) {
        if (!played(row)) continue;
        let key = null;
        try { key = d.titleKeyFor(itemId, streams[itemId]) || null; } catch {}
        note(itemId, row);
        if (key) note(key, row);
        lastIs(itemId, key, row);
      }
      for (const [key, row] of Object.entries(d.titles(p.id) || {})) {
        if (!played(row)) continue;
        note(key, row);
        lastIs(row.itemId || key, key, row);
      }
      if (last) x.lastPlay[p.id] = last;
      const seen = Math.max(d.accessLast(p.id) || 0, d.sessionsLast(p.id) || 0);
      if (seen) x.lastSeen[p.id] = Math.max(x.lastSeen[p.id] || 0, seen);
    }
    save();
    log(`first look: ${plays} plays read from the watch history already there`);
    settleReturns(now);
    return true;
  };

  // A person who came back (seen RETURN_GAP_MS after their last play): their
  // last title (and the next episode) count as touched that day.
  const recordReturn = (pid, at) => {
    const x = data();
    const lp = x.lastPlay[pid];
    if (!lp) return false;
    x.returns[pid] = { watchAt: lp.at, at };
    const b = { at, by: pid };
    if (lp.itemId) x.boosts[lp.itemId] = b;
    if (lp.key) x.boosts[lp.key] = b;
    save();
    log(`${personName(pid)} is back (last watched ${new Date(lp.at).toISOString().slice(0, 10)}): their last title counts from today`);
    return true;
  };
  const isBack = (pid) => {
    const x = data();
    const lp = x.lastPlay[pid];
    return !lp || (x.returns[pid] && x.returns[pid].watchAt === lp.at);
  };
  const settleReturns = (now = d.now()) => {
    const x = data();
    for (const p of d.people()) {
      const lp = x.lastPlay[p.id];
      if (!lp || isBack(p.id)) continue;
      const seen = Math.max(x.lastSeen[p.id] || 0, d.accessLast(p.id) || 0, d.sessionsLast(p.id) || 0);
      if (seen > lp.at + RETURN_GAP_MS && seen <= now) recordReturn(p.id, seen);
    }
  };

  // ----- live notes -----
  // Somebody is connected: a heartbeat, a hello, a signed-in request, a save.
  const seen = (pid, t = d.now()) => {
    if (!pid || typeof pid !== "string") return;
    backfill();
    const x = data();
    const was = x.lastSeen[pid] || 0;
    if (t > was) x.lastSeen[pid] = t;
    const lp = x.lastPlay[pid];
    if (lp && t - lp.at > RETURN_GAP_MS && !isBack(pid)) return void recordReturn(pid, t);
    if (t - was > SAVE_EVERY_MS) save();
  };
  // A progress save: did it play? (`prev` is the row before this save)
  const notePlay = (pid, itemId, prev, position, meta, t = d.now()) => {
    if (!pid || !itemId) return false;
    backfill();
    if (!realPlay(prev, position)) { seen(pid, t); return false; }
    const x = data();
    let key = null;
    try { key = d.titleKeyFor(itemId, meta) || null; } catch {}
    const before = x.plays[itemId];
    const lp = x.lastPlay[pid];
    x.plays[itemId] = { at: t, by: pid };
    if (key) x.plays[key] = { at: t, by: pid };
    x.lastPlay[pid] = { itemId, key, at: t };
    x.lastSeen[pid] = Math.max(x.lastSeen[pid] || 0, t);
    if (!before || t - before.at > SAVE_EVERY_MS || !lp || lp.itemId !== itemId) save();
    return true;
  };
  const noteUpload = (absPath, t = d.now()) => {
    if (!absPath) return;
    data().uploads[d.norm(absPath)] = t;
    save();
  };
  const noteRemoved = (rows) => {
    const x = data();
    const now = d.now();
    for (const r of rows) {
      x.removed.unshift({ at: now, name: r.name, kind: r.kind || null, sizeBytes: r.sizeBytes || 0, why: r.why || null, group: r.group || null, drive: r.drive || null });
      log(`removed ${r.name} (${Math.round((r.sizeBytes || 0) / 1e6)} MB) — ${r.why || "chosen by the admin"}`);
    }
    x.removed = x.removed.filter((r) => now - r.at < REMOVED_KEEP_MS).slice(0, REMOVED_MAX);
    save();
  };

  // ----- pins -----
  const pin = (id, on, about = {}) => {
    const x = data();
    if (!id || typeof id !== "string" || id.length > 200) return { error: "Which title?" };
    if (on) {
      if (!about.name) return { error: "That title is not in the library." };
      x.pins[id] = { at: d.now(), name: String(about.name).slice(0, 200), kind: about.kind || null };
      log(`the admin pinned "${about.name}" to keep`);
    } else {
      if (!x.pins[id]) return { error: "That title is not pinned." };
      log(`the admin took the keep pin off "${x.pins[id].name}"`);
      delete x.pins[id];
    }
    save();
    return { ok: true };
  };

  const setSettings = (body) => {
    const r = parseSettings(body, d.settingsData());
    if (r.error) return r;
    const before = settings();
    Object.assign(d.settingsData(), r.value);
    d.saveSettings();
    const changed = Object.keys(r.value).filter((k) => r.value[k] !== before[k]);
    if (changed.length) log(`settings changed: ${changed.map((k) => `${k}=${r.value[k]}`).join(", ")}`);
    return { ok: true, settings: r.value };
  };

  // ----- the answer -----
  const gather = (now = d.now()) => {
    backfill();
    settleReturns(now);
    const x = data();
    // forget what is long past
    for (const [k, b] of Object.entries(x.boosts)) if (now - b.at > BOOST_KEEP_MS) delete x.boosts[k];
    for (const u of d.uploadsDone()) if (u.path && !x.uploads[d.norm(u.path)]) { x.uploads[d.norm(u.path)] = u.at || now; save(); }
    const people = d.people().map((p) => ({
      id: p.id, name: p.name, lastPlay: x.lastPlay[p.id] || null, returned: x.returns[p.id] || null,
      lastSeen: Math.max(x.lastSeen[p.id] || 0, d.accessLast(p.id) || 0, d.sessionsLast(p.id) || 0),
      list: settings().untouchedKeepMyList ? d.watchlist(p.id) : new Set(),
    }));
    const out = judge({
      now, settings: d.settingsData(), items: d.items(), plays: x.plays, boosts: x.boosts, jobs: d.jobs(),
      uploads: new Map(Object.entries(x.uploads)), people, pins: x.pins, norm: d.norm,
    });
    return { ...out, removed: x.removed.slice(0, 100), since: x.since };
  };

  return { gather, seen, notePlay, noteUpload, noteRemoved, pin, setSettings, settings, backfill, settleReturns, _data: data };
};

// ---------- the server's own wiring ----------
const realDeps = () => {
  const path = require("path");
  const config = require("../config");
  const { JsonStore } = require("../lib/jsonstore");
  const settingsStore = require("../lib/settings");
  const profiles = require("../profiles");
  const norm = (p) => {
    const r = path.resolve(String(p || ""));
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const driveName = (abs) => {
    try {
      const o = require("../lib/drives").onPath(abs);
      if (o && o.drive) {
        const dr = o.drive;
        return dr.label || (dr.mount === "/" ? "System disk" : path.basename(String(dr.mount).replace(/[\\/]+$/, "")) || dr.mount);
      }
    } catch {}
    const root = path.parse(path.resolve(abs)).root;
    return process.platform === "win32" ? root.replace(/[\\/]+$/, "") : root === "/" ? "System disk" : root;
  };
  const isDown = (abs) => {
    try { if (require("../lib/drives").isDown(abs)) return true; } catch {}
    try { return require("../lib/libroots").under(abs); } catch { return false; }
  };
  return {
    store: new JsonStore(path.join(config.DATA_DIR, "untouched.json"), () => ({})),
    settingsData: () => settingsStore.data,
    saveSettings: () => settingsStore.save(),
    now: () => Date.now(),
    log: (m) => console.log(m),
    norm,
    people: () => profiles.list().map((p) => ({ id: p.id, name: p.name })),
    progressView: (pid) => { try { return profiles.getProgressView(pid); } catch { return {}; } },
    titles: (pid) => { try { return (profiles.stateOf(pid) || {}).titles || {}; } catch { return {}; } },
    streamItems: (pid) => { try { return profiles.getStreamItems(pid) || {}; } catch { return {}; } },
    titleKeyFor: (itemId, meta) => require("./identity").titleKeyFor(itemId, meta),
    accessLast: (pid) => { try { return profiles.lastSeenBefore(pid) || 0; } catch { return 0; } },
    sessionsLast: (pid) => {
      try { return (require("../lib/sessions").listFor(pid) || []).reduce((m, s) => Math.max(m, s.lastSeenAt || 0), 0); } catch { return 0; }
    },
    watchlist: (pid) => { try { return new Set((profiles.watchlistItems(pid) || []).map((c) => c && c.id).filter(Boolean)); } catch { return new Set(); } },
    jobs: () => {
      let list = [];
      try { list = require("./downloads").rawJobs(); } catch {}
      const ms = (v) => (typeof v === "number" ? v : Date.parse(v) || 0);
      const who = (j) => {
        if (j.profileName) return j.profileName;
        const p = j.profile ? profiles.list().find((x) => x.id === j.profile) : null;
        return p ? p.name : /^[0-9a-f]{12}$/i.test(String(j.profile || "")) ? null : j.profile || null;
      };
      return list.map((j) => ({
        status: j.status, smart: !!j.smart, auto: j.auto || null, destPath: j.destPath || null, imdbId: j.imdbId || null,
        type: j.type, season: j.season ?? null, episode: j.episode ?? null, at: ms(j.at), doneAt: ms(j.doneAt), by: who(j),
      }));
    },
    uploadsDone: () => {
      try {
        const up = require("./uploads");
        return up._internals.jobs().filter((j) => j.status === "done" && j.dest).map((j) => {
          const roots = (j.type === "show" ? config.LIBRARIES.shows : config.LIBRARIES.movies) || [];
          const root = roots[j.rootIdx];
          return root ? { path: path.join(root, j.dest), at: j.finishedAt || 0 } : null;
        }).filter(Boolean);
      } catch { return []; }
    },
    items: () => {
      const scanner = require("./scanner");
      const inuse = require("../lib/inuse");
      const busy = require("../lib/busyfiles");
      let keys = new Map();
      try { keys = require("./identity").ensureStamped(); } catch {}
      const out = [];
      const add = (base, id) => {
        const entry = scanner.resolve(id);
        if (!entry || entry.kind !== "video" || !entry.path) return;
        out.push({
          ...base, id, path: entry.path, key: keys.get(id) || null,
          inUse: inuse.streamingNow(id), drive: driveName(entry.path), down: isDown(entry.path), busy: busy.busyWhy(entry.path),
        });
      };
      for (const m of scanner.index.movies) {
        add({ kind: "movie", name: m.title + (m.year ? ` (${m.year})` : ""), title: m.title, sizeBytes: m.sizeBytes || 0, addedAt: m.addedAt || 0, cover: m.cover || null, show: null }, m.id);
      }
      for (const s of scanner.index.shows) {
        const show = { id: s.id, title: s.title, cover: s.cover || null };
        for (const se of s.seasons || []) for (const e of se.episodes || []) {
          add({ kind: "episode", name: `${s.title} S${pad(e.season)}E${pad(e.episode)}`, title: e.title || null, sizeBytes: e.sizeBytes || 0, addedAt: e.addedAt || 0, cover: s.cover || null, show, season: e.season, episode: e.episode }, e.id);
        }
      }
      return out;
    },
  };
};

let live = null;
let liveDeps = null;
const instance = () => live || (live = make((liveDeps = realDeps())));

// The hooks never throw into their callers (a progress save, a heartbeat).
const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { console.warn("[cleanup] note failed:", (e && e.message) || e); return undefined; } };

module.exports = {
  gather: () => instance().gather(),
  seen: safe((pid, t) => instance().seen(pid, t)),
  notePlay: safe((pid, itemId, prev, position, meta) => instance().notePlay(pid, itemId, prev, position, meta)),
  noteUpload: safe((p) => instance().noteUpload(p)),
  noteRemoved: safe((rows) => instance().noteRemoved(rows)),
  pin: (id, on, about) => instance().pin(id, on, about),
  setSettings: (body) => instance().setSettings(body),
  settings: () => instance().settings(),
  totalsOf,
  make,
  _internals: {
    use: (over) => { instance(); Object.assign(liveDeps, over); return liveDeps; },
    data: () => instance()._data(),
    DEFAULTS, LIMITS, readSettings, parseSettings, judge, realPlay, dayText, jobKey, jobMatches, RETURN_GAP_MS, PLAY_MIN_S, DAY,
  },
};

// "What do we watch tonight?" — the sessions (2026-11-09).
//
// A few people in a room decide together. One of them starts a session — on
// the TV (the usual way: a big code and a QR code on the screen), the website
// or the phone app — and the others join on their own phones or browsers by
// scanning the code or typing it. Everyone swipes yes / maybe / no through
// the same deck at the same time; Aurora finds the overlap and shows it on
// the big screen with a short why ("3 of 3 said yes"). One press plays it; a
// second choice is there if they want something else.
//
// Close to the watch party (lib/party.js) on purpose: a four-letter code, a
// member is a person on a device, a dropped connection is "away" and not
// gone, the host's leaving hands the session on, and nothing is kept on disk
// — a session is an evening, not a record. Unlike a party it is reached over
// HTTP (routes/group.js, behind the profile gate: household only), and the
// live socket only says "something changed" (realtime.js `group_update`),
// so what a member may see is decided in one place.
//
// THE PHASES
//   lobby     the code is up; people join; the starter can change the mood,
//             the length and films / series; anyone can add titles.
//   swiping   the deck is dealt (built from the voters' tastes when the host
//             presses Start, media/groupdeck.js); everyone answers on their
//             own device; a SOFT time limit counts down (the host can add a
//             minute, or show the result early). The result comes as soon as
//             every voter who is here has answered every card, or when the
//             time is up — whichever is first.
//   result    the best pick (groupdeck.results), with the next ones behind
//             "Something else"; "Swipe another round" deals a fresh deck.
//   chosen    someone pressed Play: everyone sees "Enjoy"; the session is
//             gone a little later.
//   ended     the host ended it, or it expired.
//
// WHO VOTES
//   A member is a person on a device. A member is a "voter" or a "screen":
//   the TV that started it is a screen (it shows the code and the result)
//   unless it is told "Swipe on the TV too". The ballot is the PERSON's: the
//   same profile on two phones is one voice (its latest answer counts).
//
// TIMEOUTS (opts, all changeable for tests)
//   lobbyMs     a code nobody started swiping with expires (20 min)
//   idleMs      a session nobody has looked at for this long ends (30 min)
//   maxMs       no session outlives an evening (4 h)
//   awayMs      a member with no live socket and no request for this long is
//               "away": they do not hold up "everyone is done" (75 s)
//   keepMs      an ended / chosen session still answers "ended" this long (3 min)
//   limitSec    the swipe time limit the starter gets by default (3 min)
//
// Pure over a clock, a notify function and timers, like lib/party.js, so it
// is pinned by tests without a server (test/grouppick.test.js).
"use strict";

const deck = require("../media/groupdeck");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 look-alikes
const CODE_LEN = 4;
const LIMITS = [120, 180, 300]; // the swipe limits a starter can choose (seconds)
const opts = {
  lobbyMs: 20 * 60 * 1000,
  idleMs: 30 * 60 * 1000,
  maxMs: 4 * 3600 * 1000,
  awayMs: 75 * 1000,
  keepMs: 3 * 60 * 1000,
  limitSec: 180,
  extendSec: 60,
  maxLimitSec: 10 * 60,
  maxMembers: 12,
  maxAddsEach: 5,
  deckMax: 40,
  wrongCodes: 12, // wrong codes one person may type …
  wrongWindowMs: 5 * 60 * 1000, // … in this long
};

let clock = () => Date.now();
let notify = () => {};
const sessions = new Map(); // code -> session
const wrong = new Map(); // profileId -> [times]

const now = () => clock();
const err = (status, error) => ({ status, error });

const newCode = () => {
  for (let tries = 0; tries < 80; tries++) {
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!sessions.has(code)) return code;
  }
  return null;
};
const tidyCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);
const tidyDevice = (d) => String(d || "").replace(/[^\w-]/g, "").slice(0, 40) || "default";
const memberKey = (profileId, device) => `${profileId}|${tidyDevice(device)}`;
const roleOf = (r) => (r === "screen" ? "screen" : "voter");
const appOf = (a) => (a === "tv" || a === "phone" ? a : "web");
const limitOf = (v) => {
  const n = Number(v);
  return LIMITS.includes(n) ? n : opts.limitSec;
};

// ---------- reading a session ----------
const voters = (s) => {
  const out = [];
  for (const m of s.members.values()) if (m.role === "voter" && !out.includes(m.profileId)) out.push(m.profileId);
  return out;
};
const isAway = (m, t = now()) => m.live <= 0 && t - m.seenAt > opts.awayMs;
const answeredBy = (s, pid) => {
  const b = s.ballots.get(pid);
  if (!b) return 0;
  let n = 0;
  for (const c of s.deck) if (b.has(c.key)) n++;
  return n;
};
// every voter who is here has answered every card
const everyoneDone = (s, t = now()) => {
  if (!s.deck.length) return false;
  const here = new Set();
  for (const m of s.members.values()) if (m.role === "voter" && !isAway(m, t)) here.add(m.profileId);
  if (!here.size) return false;
  for (const pid of here) if (answeredBy(s, pid) < s.deck.length) return false;
  return true;
};
const nameOf = (s, pid) => {
  for (const m of s.members.values()) if (m.profileId === pid) return m.name;
  return null;
};

const publicCard = (s, c) => {
  const { seenBy, addedBy, ...rest } = c;
  const seen = (seenBy || []).map((pid) => nameOf(s, pid)).filter(Boolean);
  return {
    ...rest,
    ...(seen.length ? { seenBy: seen } : {}),
    ...(addedBy ? { addedBy: addedBy.name } : {}),
  };
};

// What one member sees. Ballots are private: a member sees their own
// answers and how far everyone else has got, never what anyone else said —
// until the result, which is counted, never named.
const view = (s, key) => {
  const t = now();
  const me = s.members.get(key) || null;
  const ballot = me ? s.ballots.get(me.profileId) : null;
  const members = [...s.members.values()].map((m) => ({
    id: m.key,
    profileId: m.profileId,
    name: m.name,
    avatar: m.avatar,
    avatarImage: m.avatarImage,
    role: m.role,
    app: m.app,
    host: m.key === s.hostKey,
    away: isAway(m, t),
    answered: m.role === "voter" ? answeredBy(s, m.profileId) : 0,
    done: m.role === "voter" && s.deck.length > 0 && answeredBy(s, m.profileId) >= s.deck.length,
  }));
  const host = s.members.get(s.hostKey);
  const out = {
    code: s.code,
    rev: s.rev,
    phase: s.phase,
    round: s.round,
    now: t,
    createdAt: s.createdAt,
    expiresAt: expiresAt(s),
    settings: { ...s.settings },
    host: host ? { id: host.key, name: host.name, profileId: host.profileId } : null,
    you: me ? { id: me.key, profileId: me.profileId, role: me.role, host: me.key === s.hostKey } : null,
    members,
    voters: voters(s).length,
    added: s.adds.map((a) => ({ key: a.card.key, title: a.card.title, by: a.by.name, poster: a.card.poster || null })),
    deck: s.phase === "lobby" ? [] : s.deck.map((c) => publicCard(s, c)),
    mine: ballot ? Object.fromEntries([...ballot.entries()].filter(([k]) => s.deck.some((c) => c.key === k))) : {},
    deadline: s.phase === "swiping" ? s.deadline : null,
    limitSec: s.settings.limitSec,
  };
  if (s.result) {
    out.result = {
      method: s.result.method,
      index: s.result.index,
      at: s.result.at,
      why: s.result.reason,
      picks: s.result.picks.map((p) => ({
        key: p.key, why: p.why, yes: p.yes, maybe: p.maybe, no: p.no, missing: p.missing, of: p.of, everyone: p.everyone,
        card: publicCard(s, p.card),
      })),
    };
  }
  if (s.phase === "chosen") out.chosen = s.chosen ? { key: s.chosen.key, by: s.chosen.by, card: publicCard(s, s.chosen.card) } : null;
  if (s.phase === "ended") out.ended = { reason: s.endReason || "The session ended" };
  return out;
};

const expiresAt = (s) => {
  if (s.phase === "lobby") return Math.min(s.createdAt + opts.lobbyMs, s.touchedAt + opts.idleMs, s.createdAt + opts.maxMs);
  if (s.phase === "ended" || s.phase === "chosen") return (s.endedAt || now()) + opts.keepMs;
  return Math.min(s.touchedAt + opts.idleMs, s.createdAt + opts.maxMs);
};

// ---------- changing a session ----------
const bump = (s) => {
  s.rev++;
  try { notify(s.code, s.rev); } catch {}
};
const schedule = (s) => {
  clearTimeout(s.timer);
  s.timer = null;
  if (s.phase === "swiping" && s.deadline) {
    const wait = Math.max(0, s.deadline - now()) + 20;
    s.timer = setTimeout(() => sweep(), Math.min(wait, 2147483000));
    if (s.timer.unref) s.timer.unref();
  }
};

const toResult = (s, reason) => {
  const r = deck.results({ deck: s.deck, voters: voters(s), ballots: s.ballots });
  s.result = { ...r, index: 0, at: now(), reason };
  s.phase = "result";
  s.deadline = null;
  schedule(s);
  bump(s);
};

const endSession = (s, reason) => {
  if (s.phase === "ended") return;
  s.phase = "ended";
  s.endReason = reason;
  s.endedAt = now();
  s.deadline = null;
  clearTimeout(s.timer);
  bump(s);
};

// The clock moved on: deadlines, expiry. Called by the timers, and by every
// request (so a stopped timer never leaves a session stuck).
const sweep = () => {
  const t = now();
  for (const s of [...sessions.values()]) {
    if (s.phase === "ended" || s.phase === "chosen") {
      if (t - (s.endedAt || t) >= opts.keepMs) { clearTimeout(s.timer); sessions.delete(s.code); }
      continue;
    }
    if (t >= expiresAt(s)) {
      endSession(s, s.phase === "lobby" ? "The code expired" : "The session ended — nobody was using it");
      continue;
    }
    if (s.phase === "swiping") {
      if (s.deadline && t >= s.deadline) toResult(s, "time");
      else if (everyoneDone(s, t)) toResult(s, "done");
    }
  }
};

const find = (code) => {
  sweep();
  return sessions.get(tidyCode(code)) || null;
};
// The member asking, or an error. Every request is a sign of life.
const memberAt = (code, actor, device) => {
  const s = find(code);
  if (!s) return { e: err(404, "That code has expired or is not right") };
  const m = s.members.get(memberKey(actor.profileId, device));
  if (!m) return { e: err(403, "You are not in this session") };
  m.seenAt = now();
  s.touchedAt = now();
  if (actor.name) m.name = actor.name;
  return { s, m };
};
const hostAt = (code, actor, device) => {
  const r = memberAt(code, actor, device);
  if (r.e) return r;
  if (r.m.key !== r.s.hostKey) return { e: err(403, "Only the person who started it can do that") };
  return r;
};

const memberOf = (actor, device, role, app) => ({
  key: memberKey(actor.profileId, device),
  profileId: actor.profileId,
  name: actor.name || "Someone",
  avatar: actor.avatar || null,
  avatarImage: actor.avatarImage || null,
  device: tidyDevice(device),
  role: roleOf(role),
  app: appOf(app),
  joinedAt: now(),
  seenAt: now(),
  live: 0,
});

// actor: { profileId, name, avatar?, avatarImage? }
const create = (actor, settings = {}, { device, role, app } = {}) => {
  sweep();
  if (!actor || !actor.profileId) return err(400, "who is starting it?");
  // one session at a time per person and device: starting again ends the old one
  for (const s of sessions.values()) {
    if (s.hostKey === memberKey(actor.profileId, device) && s.phase !== "ended" && s.phase !== "chosen") endSession(s, "A new session was started");
  }
  const code = newCode();
  if (!code) return err(503, "No free codes right now — try again in a minute");
  const m = memberOf(actor, device, role, app);
  const t = now();
  const s = {
    code,
    rev: 1,
    phase: "lobby",
    round: 1,
    createdAt: t,
    touchedAt: t,
    hostKey: m.key,
    settings: { ...deck.cleanSettings(settings), limitSec: limitOf(settings.limitSec) },
    members: new Map([[m.key, m]]),
    deck: [],
    adds: [],
    ballots: new Map(),
    shown: new Set(),
    result: null,
    deadline: null,
    timer: null,
  };
  sessions.set(code, s);
  return { session: view(s, m.key) };
};

const join = (actor, code, { device, role, app } = {}) => {
  if (!actor || !actor.profileId) return err(400, "who is joining?");
  const clean = tidyCode(code);
  const s = clean.length === CODE_LEN ? find(clean) : null;
  if (!s || s.phase === "ended") {
    const t = now();
    const list = (wrong.get(actor.profileId) || []).filter((at) => t - at < opts.wrongWindowMs);
    if (list.length >= opts.wrongCodes) return err(429, "Too many wrong codes — wait a few minutes, then try again");
    list.push(t);
    wrong.set(actor.profileId, list);
    return err(404, s ? "That session has ended" : "No session with that code — check it against the screen");
  }
  if (s.phase === "chosen") return err(409, "They have already picked — enjoy the film");
  const key = memberKey(actor.profileId, device);
  const known = s.members.get(key);
  if (known) {
    // the same person on the same device: back from a reload or a lost connection
    known.seenAt = now();
    if (actor.name) known.name = actor.name;
    if (actor.avatar) known.avatar = actor.avatar;
    if (actor.avatarImage) known.avatarImage = actor.avatarImage;
    s.touchedAt = now();
    bump(s);
    return { session: view(s, key), rejoined: true };
  }
  if (s.members.size >= opts.maxMembers) return err(409, "This session is full");
  const m = memberOf(actor, device, role, app);
  s.members.set(key, m);
  s.touchedAt = now();
  bump(s);
  return { session: view(s, key) };
};

const get = (code, actor, device) => {
  const r = memberAt(code, actor, device);
  if (r.e) return r.e;
  return { session: view(r.s, r.m.key) };
};

// Someone leaves on purpose. The host leaving hands it on to the next voter
// who is here (else anyone); with nobody left, it ends.
const leave = (code, actor, device) => {
  const r = memberAt(code, actor, device);
  if (r.e) return r.e;
  const { s, m } = r;
  s.members.delete(m.key);
  // their ballot goes with them when no other device of theirs is left
  if (![...s.members.values()].some((o) => o.profileId === m.profileId && o.role === "voter")) s.ballots.delete(m.profileId);
  if (!s.members.size) {
    endSession(s, `${m.name} left`);
    return { ok: true };
  }
  if (m.key === s.hostKey) {
    const t = now();
    const rest = [...s.members.values()];
    const next = rest.find((o) => o.role === "voter" && !isAway(o, t)) || rest.find((o) => !isAway(o, t)) || rest[0];
    s.hostKey = next.key;
  }
  if (s.phase === "swiping" && everyoneDone(s)) toResult(s, "done");
  else bump(s);
  return { ok: true };
};

const end = (code, actor, device) => {
  const r = hostAt(code, actor, device);
  if (r.e) return r.e;
  endSession(r.s, `${r.m.name} ended it`);
  return { ok: true };
};

const setSettings = (code, actor, device, raw = {}) => {
  const r = hostAt(code, actor, device);
  if (r.e) return r.e;
  const { s } = r;
  if (s.phase !== "lobby") return err(409, "The deck is already dealt");
  s.settings = { ...deck.cleanSettings({ ...s.settings, ...raw }), limitSec: limitOf(raw.limitSec != null ? raw.limitSec : s.settings.limitSec) };
  bump(s);
  return { session: view(s, r.m.key) };
};

// A member's own role: the TV's "Swipe on the TV too" (and back).
const setRole = (code, actor, device, role) => {
  const r = memberAt(code, actor, device);
  if (r.e) return r.e;
  r.m.role = roleOf(role);
  if (r.s.phase === "swiping" && everyoneDone(r.s)) toResult(r.s, "done");
  else bump(r.s);
  return { session: view(r.s, r.m.key) };
};

// Who the deck is for (the route builds the deck for these people).
const votersOf = (code) => {
  const s = sessions.get(tidyCode(code));
  return s ? voters(s) : [];
};
const settingsOf = (code) => {
  const s = sessions.get(tidyCode(code));
  return s ? { ...s.settings } : null;
};
const shownOf = (code) => {
  const s = sessions.get(tidyCode(code));
  return s ? new Set([...s.shown, ...s.deck.map((c) => c.key)]) : new Set();
};

// The titles people added go in early (every other card from the second),
// so they are not left to the end of a deck nobody finishes.
const mergeAdds = (adds, cards, max) => {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    if (!c || seen.has(c.key) || (c.imdbId && seen.has(c.imdbId)) || out.length >= max) return;
    seen.add(c.key);
    if (c.imdbId) seen.add(c.imdbId);
    out.push(c);
  };
  const a = [...adds];
  const b = [...cards];
  while (a.length || b.length) {
    if (b.length && (out.length % 2 === 0 || !a.length)) push(b.shift());
    else push(a.shift());
  }
  return out;
};

// The host deals the deck. `cards`: groupdeck.buildDeck for votersOf(code).
const start = (code, actor, device, cards = []) => {
  const r = hostAt(code, actor, device);
  if (r.e) return r.e;
  const { s } = r;
  if (s.phase !== "lobby") return err(409, "The deck is already dealt");
  if (!voters(s).length) return err(409, "Nobody is swiping yet — join on a phone first");
  const added = s.adds.map((a) => ({ ...a.card, addedBy: a.by }));
  s.deck = mergeAdds(added, cards, opts.deckMax);
  if (!s.deck.length) return err(409, "Nothing fits those choices — try another mood or length");
  // adding a title is a yes from the person who added it
  for (const a of s.adds) ballotOf(s, a.by.profileId).set(a.card.key, "yes");
  s.adds = [];
  s.phase = "swiping";
  s.startedAt = now();
  s.deadline = now() + s.settings.limitSec * 1000;
  schedule(s);
  bump(s);
  return { session: view(s, r.m.key) };
};

// From the result (or a "nothing matched"): a fresh deck for another round.
const again = (code, actor, device, cards = []) => {
  const r = hostAt(code, actor, device);
  if (r.e) return r.e;
  const { s } = r;
  if (s.phase !== "result") return err(409, "Not now");
  if (!cards.length) return err(409, "Nothing new fits those choices — try another mood or length");
  for (const c of s.deck) s.shown.add(c.key);
  s.deck = cards.slice(0, opts.deckMax);
  s.ballots = new Map();
  s.result = null;
  s.round++;
  s.phase = "swiping";
  s.deadline = now() + s.settings.limitSec * 1000;
  schedule(s);
  bump(s);
  return { session: view(s, r.m.key) };
};

const ballotOf = (s, pid) => {
  let b = s.ballots.get(pid);
  if (!b) s.ballots.set(pid, (b = new Map()));
  return b;
};

// verdict: "yes" | "maybe" | "no" | null (take it back)
const vote = (code, actor, device, key, verdict) => {
  const r = memberAt(code, actor, device);
  if (r.e) return r.e;
  const { s, m } = r;
  if (s.phase !== "swiping") return err(409, s.phase === "result" ? "The result is in" : "The deck is not dealt yet");
  if (m.role !== "voter") return err(409, "This screen is not swiping");
  if (!s.deck.some((c) => c.key === key)) return err(400, "That card is not in the deck");
  if (verdict != null && !deck.VERDICTS.includes(verdict)) return err(400, "yes, maybe or no");
  const b = ballotOf(s, m.profileId);
  if (verdict == null) b.delete(key);
  else b.set(key, verdict);
  if (everyoneDone(s)) toResult(s, "done");
  else bump(s);
  return { ok: true, answered: answeredBy(s, m.profileId), of: s.deck.length };
};

// A title someone added (search inside the session). `card` is made by the
// route (routes/group.js titleCard) — never what the client sent as is.
const add = (code, actor, device, card) => {
  const r = memberAt(code, actor, device);
  if (r.e) return r.e;
  const { s, m } = r;
  if (s.phase !== "lobby" && s.phase !== "swiping") return err(409, "Adding is over for this round");
  if (!card || !card.key || !card.title) return err(400, "Which title?");
  const inDeck = s.deck.find((c) => c.key === card.key || (card.imdbId && c.imdbId === card.imdbId));
  const inAdds = s.adds.find((a) => a.card.key === card.key || (card.imdbId && a.card.imdbId === card.imdbId));
  if (inDeck || inAdds) {
    // already there: it is still this person's yes
    if (s.phase === "swiping" && m.role === "voter" && inDeck) {
      ballotOf(s, m.profileId).set(inDeck.key, "yes");
      bump(s);
    }
    return { ok: true, already: true, key: (inDeck || inAdds.card).key };
  }
  const mine = s.adds.filter((a) => a.by.profileId === m.profileId).length +
    s.deck.filter((c) => c.addedBy && c.addedBy.profileId === m.profileId).length;
  if (mine >= opts.maxAddsEach) return err(409, `You can add ${opts.maxAddsEach} titles a round`);
  const by = { profileId: m.profileId, name: m.name };
  if (s.phase === "lobby") {
    s.adds.push({ card: { ...card, seenBy: card.seenBy || [] }, by });
  } else {
    if (s.deck.length >= opts.deckMax) return err(409, "The deck is full");
    s.deck.push({ ...card, seenBy: card.seenBy || [], addedBy: by });
    if (m.role === "voter") ballotOf(s, m.profileId).set(card.key, "yes");
  }
  bump(s);
  return { ok: true, key: card.key };
};

// The host: "Show the result now" — or "One more minute".
const finish = (code, actor, device) => {
  const r = hostAt(code, actor, device);
  if (r.e) return r.e;
  if (r.s.phase !== "swiping") return err(409, "Not now");
  toResult(r.s, "host");
  return { session: view(r.s, r.m.key) };
};
const extend = (code, actor, device) => {
  const r = hostAt(code, actor, device);
  if (r.e) return r.e;
  const { s } = r;
  if (s.phase !== "swiping") return err(409, "Not now");
  const cap = s.startedAt + opts.maxLimitSec * 1000 * Math.max(1, s.round);
  s.deadline = Math.min(Math.max(s.deadline, now()) + opts.extendSec * 1000, Math.max(cap, s.deadline));
  schedule(s);
  bump(s);
  return { session: view(s, r.m.key) };
};

// Anyone in the room: "Something else" (the next pick) / back to the first.
const pickAt = (code, actor, device, index) => {
  const r = memberAt(code, actor, device);
  if (r.e) return r.e;
  const { s } = r;
  if (s.phase !== "result" || !s.result) return err(409, "Not now");
  const n = s.result.picks.length;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= n) return err(409, n ? "That was the last one that anybody said yes to" : "Nothing got a yes");
  s.result.index = i;
  bump(s);
  return { session: view(s, r.m.key) };
};

// Someone pressed Play: the evening is decided.
const choose = (code, actor, device, key) => {
  const r = memberAt(code, actor, device);
  if (r.e) return r.e;
  const { s, m } = r;
  if (s.phase === "chosen") return { session: view(s, m.key) };
  if (s.phase !== "result" || !s.result) return err(409, "Not now");
  const pick = s.result.picks.find((p) => p.key === key) || (s.result.picks[s.result.index] && !key ? s.result.picks[s.result.index] : null);
  if (!pick) return err(400, "That is not one of the picks");
  s.chosen = { key: pick.key, card: pick.card, by: m.name };
  s.phase = "chosen";
  s.endedAt = now();
  clearTimeout(s.timer);
  bump(s);
  return { session: view(s, m.key) };
};

// The live socket of a member: watching (+1) or gone (-1). Presence only.
const watch = (code, profileId, device, delta) => {
  const s = sessions.get(tidyCode(code));
  if (!s) return false;
  const m = s.members.get(memberKey(profileId, device));
  if (!m) return false;
  const wasAway = isAway(m);
  m.live = Math.max(0, m.live + (delta > 0 ? 1 : -1));
  if (delta > 0) m.seenAt = now();
  // someone dropping off can be the last thing "everyone is done" waited for —
  // but only once they count as away (a blip is not a goodbye): the sweep does that
  if (wasAway !== isAway(m)) bump(s);
  return true;
};
const isMember = (code, profileId, device) => {
  const s = sessions.get(tidyCode(code));
  return !!(s && s.members.has(memberKey(profileId, device)));
};

// Awayness is a matter of time: a member nobody has heard from for awayMs
// becomes away without any event. A slow tick notices it (and the deadlines,
// should a timer have been lost) and tells the room.
let ticker = null;
const awayState = new Map(); // code -> signature of who is away
const tick = () => {
  sweep();
  for (const s of sessions.values()) {
    if (s.phase === "ended" || s.phase === "chosen") continue;
    const t = now();
    const sig = [...s.members.values()].map((m) => (isAway(m, t) ? "1" : "0")).join("");
    if (awayState.get(s.code) !== sig) {
      const first = !awayState.has(s.code);
      awayState.set(s.code, sig);
      if (!first) {
        if (s.phase === "swiping" && everyoneDone(s, t)) toResult(s, "done");
        else bump(s);
      }
    }
  }
  for (const code of awayState.keys()) if (!sessions.has(code)) awayState.delete(code);
};
const startTicker = (ms = 5000) => {
  if (ticker) return;
  ticker = setInterval(tick, ms);
  if (ticker.unref) ticker.unref();
};

const configure = (o = {}) => {
  for (const k of Object.keys(opts)) if (Number.isFinite(o[k])) opts[k] = o[k];
  if (typeof o.now === "function") clock = o.now;
  if (typeof o.notify === "function") notify = o.notify;
};
const count = () => [...sessions.values()].filter((s) => s.phase !== "ended" && s.phase !== "chosen").length;
const reset = () => {
  for (const s of sessions.values()) clearTimeout(s.timer);
  sessions.clear();
  wrong.clear();
  awayState.clear();
};

module.exports = {
  create, join, get, leave, end, setSettings, setRole, start, again, vote, add, finish, extend, pickAt, choose,
  watch, isMember, votersOf, settingsOf, shownOf, sweep, tick, startTicker, configure, count,
  LIMITS, CODE_LEN,
  _internals: { sessions, opts, reset, memberKey, tidyCode, mergeAdds, everyoneDone, isAway, view },
};

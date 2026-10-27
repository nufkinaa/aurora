// Watch parties: a few devices playing the same title in step.
//
// One party per host, joined by a four-letter code. The server holds the
// item being played (a library id, or the torrent play-item the host handed
// its own player), who is in, and the last known transport state (playing?,
// position, at — `at` in SERVER time) so every member can work out where the
// film is right now. Any member's play / pause / seek goes to everyone else —
// a shared remote, not a lecture.
//
// A member is a person on a device (profile id + a device id the client
// keeps), not a socket. A socket that drops — a reload, a phone locked for a
// minute, the route's own reconnect after a sign-in, a Wi-Fi blip — leaves
// the member "away" for GRACE_MS; the same person on the same device coming
// back (party_join with the code and its device) takes their place again.
// Only a member still away when the grace runs out is dropped; a host who
// does not come back hands the party to the next member instead of ending it.
// Leaving on purpose (party_leave) is immediate, and the host's "End party"
// ends it for everyone.
//
// Everyone waits for whoever buffers: a member whose film stalls while the
// party plays says so (party_buffer); the party holds at that member's spot
// ("Waiting for Dana…") and, once every waiting member has enough to play,
// starts again — for everyone at the same server instant, START_LEAD_MS
// ahead, so all of them are already sitting at the frame when it moves.
// A play or a jump is a start together in the same way. A member who
// cannot catch up within WAIT_GIVEUP_MS is not waited for any longer.
//
// In memory only: a party is a moment, not a record. Pure over a send
// function (plus timers) so it can be pinned by tests without sockets.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 look-alikes
const CODE_LEN = 4;
const MAX_MEMBERS = 12;
const ITEM_MAX_JSON = 24 * 1024; // a torrent play-item is a few KB; this is generous
const opts = { graceMs: 2 * 60 * 1000, startLeadMs: 400, waitGiveUpMs: 20 * 1000 };
const REACTIONS = ["😂", "😮", "😍", "👏", "😱", "😢", "🔥", "👍"];
const REACT_EVERY_MS = 400;

const parties = new Map(); // code -> party
const byClient = new Map(); // clientId -> code
const keyOfClient = new Map(); // clientId -> member key

const newCode = () => {
  for (let tries = 0; tries < 50; tries++) {
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!parties.has(code)) return code;
  }
  return null;
};

const tidyDevice = (d) => String(d || "").replace(/[^\w-]/g, "").slice(0, 40);
// Same person, same device: the same member. Without a device id (an older
// client) the socket is the member, as it always was.
const memberKey = (client, device) => {
  const dev = tidyDevice(device);
  return client.profileId && dev ? `${client.profileId}|${dev}` : `c:${client.id}`;
};

const memberOf = (client, key) => ({
  key,
  clientId: client.id,
  name: client.profile || "Someone",
  avatar: client.avatar || null,
  avatarImage: client.avatarImage || null,
  profileId: client.profileId || null,
  away: null, // { since, timer } while the socket is gone
});
const publicMember = (m) => ({
  id: m.key,
  name: m.name,
  avatar: m.avatar,
  avatarImage: m.avatarImage,
  profileId: m.profileId,
  away: !!m.away,
});

// What clients see. `now` is the server's clock as the message left, so a
// member can turn (position, at) into "position as of this instant".
const publicParty = (p, you = null) => ({
  code: p.code,
  host: p.members.get(p.hostKey) ? publicMember(p.members.get(p.hostKey)) : null,
  item: p.item,
  members: [...p.members.values()].map(publicMember),
  state: { ...p.state },
  waiting: waitingNames(p),
  now: Date.now(),
  createdAt: p.createdAt,
  ...(you ? { you } : {}),
});
const waitingNames = (p) => (p.buffering ? [...p.buffering.keys()].map((k) => (p.members.get(k) || {}).name).filter(Boolean) : []);

// The lighter shape the Home strip shows to everyone on the server.
const publicSummary = (p) => ({
  code: p.code,
  host: p.members.get(p.hostKey) ? p.members.get(p.hostKey).name : "Someone",
  title: p.item && (p.item.showTitle ? `${p.item.showTitle} · ${p.item.title || ""}`.trim() : p.item.title) || "something",
  cover: (p.item && (p.item.cover || p.item.poster)) || null,
  members: p.members.size,
  createdAt: p.createdAt,
});

const sanitizeItem = (item) => {
  if (!item || typeof item !== "object" || typeof item.id !== "string") return null;
  const copy = {};
  for (const [k, v] of Object.entries(item)) {
    if (k.startsWith("_") && k !== "_isTorrent") continue; // client-only handles
    if (typeof v === "function") continue;
    copy[k] = v;
  }
  try {
    if (JSON.stringify(copy).length > ITEM_MAX_JSON) return null;
  } catch {
    return null;
  }
  return copy;
};

// To every member whose socket is here (an away member hears nothing; it
// gets the whole party again when it comes back). `data` may be a function
// of the member, for messages that say "you".
const sendMembers = (p, data, send, exceptKey = null) => {
  for (const m of p.members.values()) {
    if (m.key === exceptKey || !m.clientId) continue;
    send(m.clientId, typeof data === "function" ? data(m) : data);
  }
};

const unbindClient = (clientId) => {
  byClient.delete(clientId);
  keyOfClient.delete(clientId);
};
const clearAway = (m) => {
  if (m && m.away) {
    clearTimeout(m.away.timer);
    m.away = null;
  }
};

const end = (p, send, reason) => {
  parties.delete(p.code);
  clearTimeout(p.giveUp);
  for (const m of p.members.values()) {
    clearAway(m);
    if (m.clientId) unbindClient(m.clientId);
  }
  sendMembers(p, { type: "party_ended", code: p.code, reason }, send);
};

// The host is gone for good: the next member who is here takes over; with
// nobody here, the party ends.
const handOver = (p, send) => {
  const next = [...p.members.values()].find((m) => m.key !== p.hostKey && !m.away) ||
    [...p.members.values()].find((m) => m.key !== p.hostKey);
  if (!next) return false;
  p.hostKey = next.key;
  sendMembers(p, (m) => ({ type: "party_update", party: publicParty(p, m.key), host: next.name }), send);
  return true;
};

// Remove one member (left on purpose, or away past the grace).
const removeMember = (p, key, send, { ending = false } = {}) => {
  const who = p.members.get(key);
  if (!who) return;
  clearAway(who);
  if (who.clientId) unbindClient(who.clientId);
  p.members.delete(key);
  const name = who.name || "Someone";
  if (p.members.size) stopWaitingFor(p, key, send);
  if (p.members.size === 0) return end(p, send, `${name} ended the party`);
  if (key === p.hostKey) {
    if (ending) {
      // the members still in the map hear it, then the party is gone
      return end(p, send, `${name} ended the party`);
    }
    handOver(p, send);
  }
  sendMembers(p, (m) => ({ type: "party_update", party: publicParty(p, m.key), left: name }), send);
};

const create = (client, item, send, { device } = {}) => {
  leave(client, send); // one party per socket
  const clean = sanitizeItem(item);
  if (!clean) return { error: "nothing to watch together" };
  const code = newCode();
  if (!code) return { error: "no free party codes right now" };
  const key = memberKey(client, device);
  const p = {
    code,
    hostKey: key,
    item: clean,
    members: new Map([[key, memberOf(client, key)]]),
    state: { playing: false, position: 0, at: Date.now() },
    buffering: new Map(), // key -> since: the members the party is waiting for
    hold: null, // { position, wasPlaying } while it waits
    giveUp: null,
    createdAt: Date.now(),
  };
  parties.set(code, p);
  byClient.set(client.id, code);
  keyOfClient.set(client.id, key);
  return { party: publicParty(p, key) };
};

const join = (client, code, send, { device } = {}) => {
  const p = parties.get(String(code || "").toUpperCase().trim());
  if (!p) return { error: "no party with that code" };
  const key = memberKey(client, device);
  const known = p.members.get(key);
  if (known) {
    // the same person on the same device: back from a reload or a dropped
    // socket — they take their place again (host included)
    if (known.clientId && known.clientId !== client.id) unbindClient(known.clientId);
    if (byClient.get(client.id) && byClient.get(client.id) !== p.code) leave(client, send);
    const wasAway = !!known.away;
    clearAway(known);
    known.clientId = client.id;
    if (client.profile) known.name = client.profile;
    if (client.avatar) known.avatar = client.avatar;
    if (client.avatarImage) known.avatarImage = client.avatarImage;
    byClient.set(client.id, p.code);
    keyOfClient.set(client.id, key);
    if (wasAway) sendMembers(p, (m) => ({ type: "party_update", party: publicParty(p, m.key), back: known.name }), send, key);
    return { party: publicParty(p, key), rejoined: true };
  }
  if (p.members.size >= MAX_MEMBERS) return { error: "that party is full" };
  leave(client, send);
  const m = memberOf(client, key);
  p.members.set(key, m);
  byClient.set(client.id, p.code);
  keyOfClient.set(client.id, key);
  sendMembers(p, (o) => ({ type: "party_update", party: publicParty(p, o.key), joined: m.name }), send, key);
  return { party: publicParty(p, key) };
};

const partyOf = (client) => {
  const code = byClient.get(client.id);
  const p = code && parties.get(code);
  const key = keyOfClient.get(client.id);
  return p && key && p.members.has(key) ? { p, key } : null;
};

// Leaving on purpose: a guest just goes; the host ends the party — or,
// with `handover`, leaves it running with the next member as the host.
const leave = (client, send, { handover = false } = {}) => {
  const at = partyOf(client);
  if (!at) {
    unbindClient(client.id);
    return false;
  }
  removeMember(at.p, at.key, send, { ending: at.key === at.p.hostKey && !handover });
  return true;
};

// The socket went away without saying goodbye: the member is away, not gone.
const drop = (client, send) => {
  const at = partyOf(client);
  unbindClient(client.id);
  if (!at) return false;
  const { p, key } = at;
  const m = p.members.get(key);
  if (m.clientId !== client.id) return false; // already back on a newer socket
  m.clientId = null;
  clearAway(m);
  const timer = setTimeout(() => {
    if (!parties.has(p.code) || p.members.get(key) !== m || !m.away) return;
    removeMember(p, key, send);
  }, opts.graceMs);
  if (timer.unref) timer.unref();
  m.away = { since: Date.now(), timer };
  stopWaitingFor(p, key, send);
  sendMembers(p, (o) => ({ type: "party_update", party: publicParty(p, o.key), away: m.name }), send);
  return true;
};

// The host moved the party to another title (Up next): keep it, reset the
// transport, tell the guests — they navigate and re-join the same code.
const setItem = (client, item, send) => {
  const at = partyOf(client);
  if (!at) return { error: "not in a party" };
  const { p, key } = at;
  if (key !== p.hostKey) return { error: "only the host can change what's playing" };
  const clean = sanitizeItem(item);
  if (!clean) return { error: "nothing to watch together" };
  p.item = clean;
  p.state = { playing: false, position: 0, at: Date.now() };
  clearWait(p);
  sendMembers(p, (m) => ({ type: "party_item", code: p.code, item: clean, party: publicParty(p, m.key) }), send, key);
  return { party: publicParty(p, key) };
};

// Transport state from any member: keep it, tell the others. `kind` is
// what happened (play / pause / seek / sync) so members can say who did it
// — and stay quiet for the periodic sync ticks. `at` may come from the
// sender, already in server time (its clock offset applied), which takes
// the trip to the server out of the position; anything far from now is
// not believed.
//
// A play goes to the others at once (they sit on the frame the pause left
// them on; the presser's own film is already moving). A JUMP while playing
// is a START TOGETHER: the state's `at` is START_LEAD_MS ahead and it goes
// to everyone, the jumper too — every member lands, and moves when the
// server's clock gets there (one still loading by then holds the party,
// below).
const setState = (client, data, send) => {
  const at = partyOf(client);
  if (!at) return { error: "not in a party" };
  const { p, key } = at;
  const now = Date.now();
  const playing = !!data.playing;
  const position = Math.max(0, Number(data.position) || 0);
  const kind = ["play", "pause", "seek", "sync"].includes(data.kind) ? data.kind : "sync";
  const who = p.members.get(key);
  const by = who ? who.name : "Someone";
  if (kind === "sync") {
    // a tick from the host: not while the party holds for someone, nor
    // before a start together has started
    if (p.hold || (p.state.playing && p.state.at > now)) return { ok: true };
    const sentAt = Number(data.at);
    const stamp = Number.isFinite(sentAt) && Math.abs(sentAt - now) < 3000 ? Math.min(sentAt, now) : now;
    p.state = { playing, position, at: stamp };
    sendMembers(p, { type: "party_state", code: p.code, playing, position, at: stamp, now, kind, by }, send, key);
    return { ok: true };
  }
  // a person's own press: whatever the party was waiting for is over
  clearWait(p);
  if (playing && kind === "play") {
    const sentAt = Number(data.at);
    const stamp = Number.isFinite(sentAt) && Math.abs(sentAt - now) < 3000 ? Math.min(sentAt, now) : now;
    p.state = { playing: true, position, at: stamp };
    sendMembers(p, { type: "party_state", code: p.code, playing: true, position, at: stamp, now, kind, by }, send, key);
  } else if (playing) {
    const start = now + opts.startLeadMs;
    p.state = { playing: true, position, at: start };
    sendMembers(p, (m) => ({ type: "party_state", code: p.code, playing: true, position, at: start, now, kind, by, ...(m.key === key ? { self: true } : {}) }), send);
  } else {
    p.state = { playing: false, position, at: now };
    sendMembers(p, { type: "party_state", code: p.code, playing: false, position, at: now, now, kind, by }, send, key);
  }
  return { ok: true };
};

// ---------- everyone waits for whoever buffers ----------
const clearWait = (p) => {
  clearTimeout(p.giveUp);
  p.giveUp = null;
  p.hold = null;
  if (p.buffering) p.buffering.clear();
};
const resumeTogether = (p, send, extra = {}) => {
  const hold = p.hold;
  clearWait(p);
  if (!hold || !hold.wasPlaying) return;
  const now = Date.now();
  const start = now + opts.startLeadMs;
  p.state = { playing: true, position: hold.position, at: start };
  sendMembers(p, { type: "party_state", code: p.code, playing: true, position: hold.position, at: start, now, kind: "resume", by: null, ...extra }, send);
};
const stopWaitingFor = (p, key, send) => {
  if (!p.buffering || !p.buffering.delete(key)) return;
  if (!p.buffering.size) resumeTogether(p, send);
  else sendWait(p, send);
};
const sendWait = (p, send) => {
  const now = Date.now();
  sendMembers(p, { type: "party_state", code: p.code, playing: false, position: p.hold.position, at: now, now, kind: "wait", waiting: waitingNames(p), by: null }, send);
};
// A member's film stalled (buffering: true) or has enough to play again.
const setBuffering = (client, data, send) => {
  const at = partyOf(client);
  if (!at) return { error: "not in a party" };
  const { p, key } = at;
  const now = Date.now();
  if (data.buffering) {
    if (p.buffering.has(key)) return { ok: true };
    if (!p.hold) {
      // only a party that is playing waits (a paused one has nothing to wait for)
      if (!p.state.playing) return { ok: true };
      const there = p.state.position + Math.max(0, now - p.state.at) / 1000;
      const mine = Number(data.position);
      // hold where the slow member is (a little behind the others), never far back
      const position = Number.isFinite(mine) ? Math.max(there - 10, Math.min(there, Math.max(0, mine))) : there;
      p.hold = { position, wasPlaying: true };
      p.state = { playing: false, position, at: now };
      clearTimeout(p.giveUp);
      p.giveUp = setTimeout(() => {
        if (!parties.has(p.code) || !p.hold) return;
        resumeTogether(p, send, { gaveUp: waitingNames(p) });
      }, opts.waitGiveUpMs);
      if (p.giveUp.unref) p.giveUp.unref();
    }
    p.buffering.set(key, now);
    sendWait(p, send);
    return { ok: true };
  }
  stopWaitingFor(p, key, send);
  return { ok: true };
};

// A reaction: a face over everyone's picture, from one of a few.
const react = (client, data, send) => {
  const at = partyOf(client);
  if (!at) return { error: "not in a party" };
  const { p, key } = at;
  const emoji = String(data.emoji || "");
  if (!REACTIONS.includes(emoji)) return { error: "not a reaction" };
  const m = p.members.get(key);
  const now = Date.now();
  if (m.reactedAt && now - m.reactedAt < REACT_EVERY_MS) return { ok: true }; // a held key is one face
  m.reactedAt = now;
  sendMembers(p, { type: "party_react", code: p.code, emoji, by: m.name, byId: key }, send);
  return { ok: true };
};

const get = (code) => {
  const p = parties.get(String(code || "").toUpperCase().trim());
  return p ? publicParty(p) : null;
};
const list = () => [...parties.values()].map(publicSummary);
const codeFor = (clientId) => byClient.get(clientId) || null;
const configure = (o = {}) => {
  for (const k of ["graceMs", "startLeadMs", "waitGiveUpMs"]) if (Number.isFinite(o[k])) opts[k] = o[k];
};

module.exports = {
  create, join, leave, drop, setItem, setState, setBuffering, react, get, list, codeFor, configure, REACTIONS,
  _internals: { parties, byClient, keyOfClient, sanitizeItem, publicParty, memberKey, opts },
};

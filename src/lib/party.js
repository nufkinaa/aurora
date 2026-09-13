// Watch parties: a few devices on the LAN playing the same title in step.
//
// One party per host socket, joined by a four-letter code. The server holds
// the item being played (a library id, or the torrent play-item the host
// handed its own player), who is in, and the last known transport state
// (playing?, position, when) so a late joiner lands in the right spot. Any
// member's play / pause / seek goes to everyone else — a shared remote, not
// a lecture. The host leaving ends the party; a guest leaving just leaves.
//
// In memory only: a party is a moment, not a record. Pure over a clients
// map + a send function so it can be pinned by tests without sockets.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 look-alikes
const CODE_LEN = 4;
const MAX_MEMBERS = 12;
const ITEM_MAX_JSON = 24 * 1024; // a torrent play-item is a few KB; this is generous

const parties = new Map(); // code -> party
const byClient = new Map(); // clientId -> code

const newCode = () => {
  for (let tries = 0; tries < 50; tries++) {
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!parties.has(code)) return code;
  }
  return null;
};

const memberOf = (client) => ({
  id: client.id,
  name: client.profile || "Someone",
  avatar: client.avatar || null,
  avatarImage: client.avatarImage || null,
  profileId: client.profileId || null,
});

// What clients see. `now` lets a joiner turn (position, at) into "position
// as of this instant" without trusting its own clock against the server's.
const publicParty = (p) => ({
  code: p.code,
  host: p.members.get(p.hostId) || null,
  item: p.item,
  members: [...p.members.values()],
  state: { ...p.state },
  now: Date.now(),
  createdAt: p.createdAt,
});

// The lighter shape the Home strip shows to everyone on the server.
const publicSummary = (p) => ({
  code: p.code,
  host: p.members.get(p.hostId) ? p.members.get(p.hostId).name : "Someone",
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

const sendMembers = (p, data, send, except = null) => {
  for (const id of p.members.keys()) {
    if (id === except) continue;
    send(id, data);
  }
};

const create = (client, item, send) => {
  leave(client, send); // one party per socket
  const clean = sanitizeItem(item);
  if (!clean) return { error: "nothing to watch together" };
  const code = newCode();
  if (!code) return { error: "no free party codes right now" };
  const p = {
    code,
    hostId: client.id,
    item: clean,
    members: new Map([[client.id, memberOf(client)]]),
    state: { playing: false, position: 0, at: Date.now() },
    createdAt: Date.now(),
  };
  parties.set(code, p);
  byClient.set(client.id, code);
  return { party: publicParty(p) };
};

const join = (client, code, send) => {
  const p = parties.get(String(code || "").toUpperCase().trim());
  if (!p) return { error: "no party with that code" };
  if (p.members.has(client.id)) return { party: publicParty(p) };
  if (p.members.size >= MAX_MEMBERS) return { error: "that party is full" };
  leave(client, send);
  p.members.set(client.id, memberOf(client));
  byClient.set(client.id, p.code);
  sendMembers(p, { type: "party_update", party: publicParty(p), joined: memberOf(client).name }, send, client.id);
  return { party: publicParty(p) };
};

const leave = (client, send) => {
  const code = byClient.get(client.id);
  if (!code) return false;
  byClient.delete(client.id);
  const p = parties.get(code);
  if (!p) return false;
  const who = p.members.get(client.id);
  p.members.delete(client.id);
  if (client.id === p.hostId || p.members.size === 0) {
    parties.delete(code);
    sendMembers(p, { type: "party_ended", code, reason: `${who ? who.name : "The host"} ended the party` }, send);
    for (const id of p.members.keys()) byClient.delete(id);
  } else {
    sendMembers(p, { type: "party_update", party: publicParty(p), left: who ? who.name : "Someone" }, send);
  }
  return true;
};

// The host moved the party to another title (Up next): keep it, reset the
// transport, tell the guests — they navigate and re-join the same code.
const setItem = (client, item, send) => {
  const code = byClient.get(client.id);
  const p = code && parties.get(code);
  if (!p) return { error: "not in a party" };
  if (client.id !== p.hostId) return { error: "only the host can change what's playing" };
  const clean = sanitizeItem(item);
  if (!clean) return { error: "nothing to watch together" };
  p.item = clean;
  p.state = { playing: false, position: 0, at: Date.now() };
  sendMembers(p, { type: "party_item", code, item: clean, party: publicParty(p) }, send, client.id);
  return { party: publicParty(p) };
};

// Transport state from any member: keep it, tell the others. `kind` is
// what happened (play / pause / seek / sync) so guests can say who did it
// — and stay quiet for the periodic sync ticks.
const setState = (client, data, send) => {
  const code = byClient.get(client.id);
  const p = code && parties.get(code);
  if (!p) return { error: "not in a party" };
  const playing = !!data.playing;
  const position = Math.max(0, Number(data.position) || 0);
  const kind = ["play", "pause", "seek", "sync"].includes(data.kind) ? data.kind : "sync";
  p.state = { playing, position, at: Date.now() };
  const who = p.members.get(client.id);
  sendMembers(
    p,
    { type: "party_state", code, playing, position, at: p.state.at, now: Date.now(), kind, by: who ? who.name : "Someone" },
    send,
    client.id,
  );
  return { ok: true };
};

const get = (code) => {
  const p = parties.get(String(code || "").toUpperCase().trim());
  return p ? publicParty(p) : null;
};
const list = () => [...parties.values()].map(publicSummary);
const codeFor = (clientId) => byClient.get(clientId) || null;

module.exports = { create, join, leave, setItem, setState, get, list, codeFor, _internals: { parties, byClient, sanitizeItem, publicParty } };

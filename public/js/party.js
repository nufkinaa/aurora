// Watch party client: one party at a time, over the app's WebSocket.
// The player drives this (create / join / leave / sendState) and listens
// for what the others did; Home and the profile menu only read `current`.
import { state } from "./state.js";
import { send, onMessage } from "./ws.js";
import { toast } from "./ui.js";
import { bestClock, clockFrom } from "./partySync.js";

export const party = {
  current: null, // the public party object, or null
  role: null, // "host" | "guest"
  me: null, // this member's id in the party (person + device)
};

// This device's id for parties: the server knows a member by person +
// device, so a reload or a dropped socket takes the same place again.
const deviceId = (() => {
  let id = null;
  try { id = localStorage.getItem("aurora-party-device"); } catch {}
  if (!id) {
    id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
    try { localStorage.setItem("aurora-party-device", id); } catch {}
  }
  return id;
})();

// ---------- the server's clock ----------
// Every position in a party is (position, at) with `at` in SERVER time, so
// each member can work out where the film is right now without trusting
// its own clock. A few pings; the one with the shortest round trip wins.
let clockOffset = null; // server clock - ours, in ms
let samples = []; // { rtt, offset, at }
export const serverNow = () => Date.now() + (clockOffset || 0);
export const clockKnown = () => clockOffset != null;
const syncClock = () => {
  for (let i = 0; i < 5; i++) setTimeout(() => send({ type: "party_ping", t0: Date.now() }), i * 250);
};
onMessage("party_pong", ({ t0, now }) => {
  const t1 = Date.now();
  if (!now || !(t1 - t0 >= 0)) return;
  // the last minute's samples; the shortest round trip is the most honest
  samples = samples.filter((x) => t1 - x.at < 60000).concat({ ...clockFrom(t0, t1, now), at: t1 });
  const best = bestClock(samples);
  if (best) clockOffset = best.offset;
});
setInterval(() => { if (party.current) syncClock(); }, 30000);

const listeners = { state: new Set(), update: new Set(), ended: new Set(), item: new Set(), react: new Set() };
export const onPartyState = (fn) => (listeners.state.add(fn), () => listeners.state.delete(fn));
export const onPartyUpdate = (fn) => (listeners.update.add(fn), () => listeners.update.delete(fn));
export const onPartyEnded = (fn) => (listeners.ended.add(fn), () => listeners.ended.delete(fn));
export const onPartyItem = (fn) => (listeners.item.add(fn), () => listeners.item.delete(fn));
export const onPartyReact = (fn) => (listeners.react.add(fn), () => listeners.react.delete(fn));
const emit = (kind, data) => {
  for (const fn of listeners[kind]) {
    try { fn(data); } catch {}
  }
};

// The server's chips want the face, not just the name.
const tellAvatar = () => {
  if (!state.profile) return;
  send({ type: "party_avatar", avatar: state.profile.avatar || null, avatarImage: state.profile.avatarImage || null });
};

let pending = null; // {resolve, reject, timer} for the create/join in flight
const settle = (ok, value) => {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  ok ? p.resolve(value) : p.reject(new Error(value));
};
const ask = (msg) =>
  new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return reject(new Error("not connected to the server"));
    settle(false, "replaced by a newer request"); // one create/join at a time
    pending = { resolve, reject, timer: setTimeout(() => settle(false, "the server didn't answer"), 6000) };
    tellAvatar();
    send(msg);
  });

const roleOf = (p) => (p && p.host && p.you && p.host.id === p.you ? "host" : "guest");

export const createParty = async (item) => {
  const p = await ask({ type: "party_create", item, device: deviceId });
  party.current = p;
  party.role = "host";
  party.me = p.you || null;
  syncClock();
  return p;
};

export const joinParty = async (code) => {
  const p = await ask({ type: "party_join", code: String(code || "").toUpperCase().trim(), device: deviceId });
  party.current = p;
  party.role = roleOf(p); // back on the same device, a host is still the host
  party.me = p.you || null;
  syncClock();
  return p;
};

// `handover`: a host leaves the party running — the next member hosts.
export const leaveParty = ({ handover = false } = {}) => {
  if (!party.current) return;
  send({ type: "party_leave", ...(handover ? { handover: true } : {}) });
  party.current = null;
  party.role = null;
  party.me = null;
};

// The socket came back (a blip, a phone unlocked, the reconnect after a
// sign-in): take our place in the party again and land where it is now.
let rejoining = false;
const rejoin = () => {
  if (!party.current || rejoining) return;
  rejoining = true;
  tellAvatar();
  send({ type: "party_join", code: party.current.code, device: deviceId, rejoin: true });
  setTimeout(() => { rejoining = false; }, 4000);
  syncClock();
};
const endLocally = (reason) => {
  if (!party.current) return;
  const code = party.current.code;
  party.current = null;
  party.role = null;
  party.me = null;
  toast(reason || "The party ended", "👥");
  emit("ended", { code, reason });
};
onMessage("welcome", () => { if (party.current) setTimeout(rejoin, 50); });

// Host only: the party moves to another title (Up next). The server tells
// the guests, who follow.
export const setPartyItem = (item) => {
  if (!party.current || party.role !== "host") return;
  party.current.item = item;
  send({ type: "party_item", item });
};

// This member's film stalled while the party plays / has enough again: the
// party waits for it (lib/party.js).
export const sendPartyBuffering = (buffering, position) => {
  if (!party.current) return;
  send({ type: "party_buffer", buffering: !!buffering, position: Math.max(0, position || 0) });
};
export const REACTIONS = ["😂", "😮", "😍", "👏", "😱", "😢", "🔥", "👍"];
export const sendPartyReaction = (emoji) => {
  if (!party.current || !REACTIONS.includes(emoji)) return;
  send({ type: "party_react", emoji });
};
export const partyInviteUrl = (code) => `${location.origin}${location.pathname}#/party/${code}`;

export const sendPartyState = (playing, position, kind = "sync") => {
  if (!party.current) return;
  const msg = { type: "party_state", playing: !!playing, position: Math.max(0, position || 0), kind };
  if (clockKnown()) msg.at = Math.round(serverNow());
  party.current.state = { playing: !!playing, position: msg.position, at: msg.at || serverNow() };
  send(msg);
};

onMessage("party_created", ({ party: p }) => settle(true, p));
onMessage("party_joined", (data) => {
  if (!data.rejoin) return settle(true, data.party);
  rejoining = false;
  const p = data.party;
  if (!party.current || !p || p.code !== party.current.code) return;
  party.current = p;
  party.role = roleOf(p);
  party.me = p.you || party.me;
  emit("update", p);
  // where the party is now (the player lands there)
  party.current.waiting = p.waiting || [];
  emit("state", { ...p.state, now: p.now, kind: p.waiting && p.waiting.length ? "wait" : "sync", waiting: p.waiting || [], rejoined: true });
});
onMessage("party_error", (data) => {
  if (data.rejoin) {
    rejoining = false;
    if (party.current && data.code === party.current.code) endLocally("The party ended while you were away");
    return;
  }
  // a play / pause the server could not place: we are not in the party any
  // more on this socket — take our place again
  if (data.lost) return rejoin();
  settle(false, data.message || "party error");
});
onMessage("party_update", (data) => {
  if (!party.current || !data.party || data.party.code !== party.current.code) return;
  const wasHost = party.role === "host";
  party.current = data.party;
  if (data.party.you) party.me = data.party.you;
  party.role = roleOf(data.party);
  if (data.joined) toast(`${data.joined} joined the party`, "👥");
  if (data.left) toast(`${data.left} left the party`, "👋");
  if (data.host && party.role === "host" && !wasHost) toast("You're the host now", "👥");
  else if (data.host) toast(`${data.host} is the host now`, "👥");
  emit("update", data.party);
});
onMessage("party_state", (data) => {
  if (!party.current || data.code !== party.current.code) return;
  party.current.state = { playing: data.playing, position: data.position, at: data.at };
  // who the party is waiting for (a "wait"), or nobody any more
  party.current.waiting = data.kind === "wait" ? data.waiting || [] : [];
  emit("state", data);
});
onMessage("party_react", (data) => {
  if (!party.current || data.code !== party.current.code) return;
  emit("react", data);
});
onMessage("party_item", (data) => {
  if (!party.current || !data.party || data.party.code !== party.current.code) return;
  party.current = data.party;
  emit("item", { item: data.item, party: data.party });
});
onMessage("party_ended", (data) => {
  if (!party.current || data.code !== party.current.code) return;
  party.current = null;
  party.role = null;
  party.me = null;
  toast(data.reason || "The party ended", "👥");
  emit("ended", data);
});

// Watch party client: one party at a time, over the app's WebSocket.
// The player drives this (create / join / leave / sendState) and listens
// for what the others did; Home and the profile menu only read `current`.
import { state } from "./state.js";
import { send, onMessage } from "./ws.js";
import { toast } from "./ui.js";

export const party = {
  current: null, // the public party object, or null
  role: null, // "host" | "guest"
};

const listeners = { state: new Set(), update: new Set(), ended: new Set(), item: new Set() };
export const onPartyState = (fn) => (listeners.state.add(fn), () => listeners.state.delete(fn));
export const onPartyUpdate = (fn) => (listeners.update.add(fn), () => listeners.update.delete(fn));
export const onPartyEnded = (fn) => (listeners.ended.add(fn), () => listeners.ended.delete(fn));
export const onPartyItem = (fn) => (listeners.item.add(fn), () => listeners.item.delete(fn));
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

export const createParty = async (item) => {
  const p = await ask({ type: "party_create", item });
  party.current = p;
  party.role = "host";
  return p;
};

export const joinParty = async (code) => {
  const p = await ask({ type: "party_join", code: String(code || "").toUpperCase().trim() });
  party.current = p;
  party.role = "guest";
  return p;
};

export const leaveParty = () => {
  if (!party.current) return;
  send({ type: "party_leave" });
  party.current = null;
  party.role = null;
};

// Host only: the party moves to another title (Up next). The server tells
// the guests, who follow.
export const setPartyItem = (item) => {
  if (!party.current || party.role !== "host") return;
  party.current.item = item;
  send({ type: "party_item", item });
};

export const sendPartyState = (playing, position, kind = "sync") => {
  if (!party.current) return;
  send({ type: "party_state", playing: !!playing, position: Math.max(0, position || 0), kind });
};

onMessage("party_created", ({ party: p }) => settle(true, p));
onMessage("party_joined", ({ party: p }) => settle(true, p));
onMessage("party_error", ({ message }) => settle(false, message || "party error"));
onMessage("party_update", (data) => {
  if (!party.current || !data.party || data.party.code !== party.current.code) return;
  party.current = data.party;
  if (data.joined) toast(`${data.joined} joined the party`, "👥");
  if (data.left) toast(`${data.left} left the party`, "👋");
  emit("update", data.party);
});
onMessage("party_state", (data) => {
  if (!party.current || data.code !== party.current.code) return;
  party.current.state = { playing: data.playing, position: data.position, at: data.at };
  emit("state", data);
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
  toast(data.reason || "The party ended", "👥");
  emit("ended", data);
});

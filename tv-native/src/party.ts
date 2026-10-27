// Watch party client — the TV's copy of public/js/party.js. One party at a
// time, over the app's socket; the player drives create / join / leave /
// sendState and listens for what the others did.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {api, Party, PartyItem, TorrentPlayItem} from './api';
import {isOpen, onMessage, onSocketOpen, send} from './realtime';
import {showToast} from './toast';
import {registerProfileCache} from './profileScope';
import {bestClock, ClockSample, clockFrom} from './partySync';

export const party: {current: Party | null; role: 'host' | 'guest' | null; me: string | null} = {
  current: null,
  role: null,
  me: null, // this member's id in the party (person + device)
};

// This TV's id for parties: the server knows a member by person + device,
// so a dropped socket (or the app coming back) takes the same place again.
// Made once, kept while the app is installed (the site's aurora-party-device).
const DEVICE_KEY = 'aurora.party.device';
let deviceId = `tv${Math.random().toString(36).slice(2, 12)}`;
AsyncStorage.getItem(DEVICE_KEY)
  .then(v => {
    if (v && /^[\w-]{6,40}$/.test(v)) deviceId = v;
    else AsyncStorage.setItem(DEVICE_KEY, deviceId).catch(() => {});
  })
  .catch(() => {});

// ---------- the server's clock (the site's party.js: same pings, same pick) ----------
let clockOffset: number | null = null;
let samples: (ClockSample & {at: number})[] = [];
export const serverNow = () => Date.now() + (clockOffset || 0);
export const clockKnown = () => clockOffset != null;
const syncClock = () => {
  for (let i = 0; i < 5; i++) setTimeout(() => send({type: 'party_ping', t0: Date.now()}), i * 250);
};
onMessage('party_pong', d => {
  const t1 = Date.now();
  const t0 = Number(d.t0);
  const now = Number(d.now);
  if (!now || !(t1 - t0 >= 0)) return;
  samples = samples.filter(x => t1 - x.at < 60000).concat({...clockFrom(t0, t1, now), at: t1});
  const best = bestClock(samples);
  if (best) clockOffset = best.offset;
});
setInterval(() => {
  if (party.current) syncClock();
}, 30000);

type Listeners = {
  state: Set<(d: PartyStateMsg) => void>;
  update: Set<(p: Party) => void>;
  ended: Set<(d: {reason?: string}) => void>;
  item: Set<(d: {item: PartyItem; party: Party}) => void>;
  react: Set<(d: {emoji: string; by?: string}) => void>;
};
export type PartyStateMsg = {
  playing: boolean;
  position: number;
  at: number;
  now: number;
  kind: 'play' | 'pause' | 'seek' | 'sync' | 'wait' | 'resume';
  by?: string | null;
  self?: boolean; // our own jump, coming back as a start together
  waiting?: string[]; // a "wait": who the party is waiting for
  gaveUp?: string[]; // a "resume" that stopped waiting for these
  rejoined?: boolean; // landing after a join / a reconnect
};
const listeners: Listeners = {state: new Set(), update: new Set(), ended: new Set(), item: new Set(), react: new Set()};
export const onPartyState = (fn: (d: PartyStateMsg) => void) => (listeners.state.add(fn), () => listeners.state.delete(fn));
export const onPartyUpdate = (fn: (p: Party) => void) => (listeners.update.add(fn), () => listeners.update.delete(fn));
export const onPartyEnded = (fn: (d: {reason?: string}) => void) => (listeners.ended.add(fn), () => listeners.ended.delete(fn));
export const onPartyItem = (fn: (d: {item: PartyItem; party: Party}) => void) => (listeners.item.add(fn), () => listeners.item.delete(fn));
export const onPartyReact = (fn: (d: {emoji: string; by?: string}) => void) => (listeners.react.add(fn), () => listeners.react.delete(fn));

let pending: {resolve: (p: Party) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>} | null = null;
const settle = (ok: boolean, value: unknown) => {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  if (ok) p.resolve(value as Party);
  else p.reject(new Error(String(value)));
};
const ask = (msg: Record<string, unknown>) =>
  new Promise<Party>((resolve, reject) => {
    if (!isOpen()) return reject(new Error('not connected to the server'));
    settle(false, 'replaced by a newer request');
    pending = {resolve, reject, timer: setTimeout(() => settle(false, "the server didn't answer"), 6000)};
    send(msg);
  });

const roleOf = (p: Party | null) => (p && p.host && p.you && p.host.id === p.you ? 'host' : 'guest');

export const createParty = async (item: PartyItem) => {
  const p = await ask({type: 'party_create', item, device: deviceId});
  party.current = p;
  party.role = 'host';
  party.me = p.you || null;
  syncClock();
  return p;
};
export const joinParty = async (code: string) => {
  const p = await ask({type: 'party_join', code: String(code || '').toUpperCase().trim(), device: deviceId});
  party.current = p;
  party.role = roleOf(p); // back on the same TV, a host is still the host
  party.me = p.you || null;
  syncClock();
  return p;
};
// `handover`: a host leaves the party running — the next member hosts.
export const leaveParty = ({handover = false}: {handover?: boolean} = {}) => {
  if (!party.current) return;
  send({type: 'party_leave', ...(handover ? {handover: true} : {})});
  party.current = null;
  party.role = null;
  party.me = null;
};
// The socket came back (Wi-Fi, the server restarting): take our place in the
// party again and land where it is now.
let rejoining = false;
const rejoin = () => {
  if (!party.current || rejoining) return;
  rejoining = true;
  send({type: 'party_join', code: party.current.code, device: deviceId, rejoin: true});
  setTimeout(() => {
    rejoining = false;
  }, 4000);
  syncClock();
};
onSocketOpen(() => {
  if (party.current) setTimeout(rejoin, 50);
});
const endLocally = (reason: string) => {
  if (!party.current) return;
  party.current = null;
  party.role = null;
  party.me = null;
  showToast(reason, '👥');
  for (const fn of listeners.ended) fn({reason});
};
// This TV's film stalled while the party plays / has enough again.
export const sendPartyBuffering = (buffering: boolean, position: number) => {
  if (!party.current) return;
  send({type: 'party_buffer', buffering: !!buffering, position: Math.max(0, position || 0)});
};
export const REACTIONS = ['😂', '😮', '😍', '👏', '😱', '😢', '🔥', '👍'];
export const sendPartyReaction = (emoji: string) => {
  if (!party.current || !REACTIONS.includes(emoji)) return;
  send({type: 'party_react', emoji});
};
// A profile is left: so is its party, and a question still waiting for the
// server's answer is dropped (profileScope.ts).
registerProfileCache('party', () => {
  settle(false, 'left the profile');
  leaveParty();
});
// Host only: the party moves to another title (Up next); guests follow.
export const setPartyItem = (item: PartyItem) => {
  if (!party.current || party.role !== 'host') return;
  party.current.item = item;
  send({type: 'party_item', item});
};
export const sendPartyState = (playing: boolean, position: number, kind: PartyStateMsg['kind'] = 'sync') => {
  if (!party.current) return;
  const pos = Math.max(0, position || 0);
  const at = clockKnown() ? Math.round(serverNow()) : undefined;
  party.current.state = {playing: !!playing, position: pos, at: at || serverNow()};
  send({type: 'party_state', playing: !!playing, position: pos, kind, ...(at ? {at} : {})});
};

onMessage('party_created', d => settle(true, d.party));
onMessage('party_joined', d => {
  if (!d.rejoin) return settle(true, d.party);
  rejoining = false;
  const p = d.party as Party | undefined;
  if (!party.current || !p || p.code !== party.current.code) return;
  party.current = p;
  party.role = roleOf(p);
  party.me = p.you || party.me;
  for (const fn of listeners.update) fn(p);
  const waiting = p.waiting || [];
  const land = {...p.state, now: p.now, kind: waiting.length ? 'wait' : 'sync', waiting, rejoined: true} as PartyStateMsg;
  for (const fn of listeners.state) fn(land);
});
onMessage('party_error', d => {
  if (d.rejoin) {
    rejoining = false;
    if (party.current && d.code === party.current.code) endLocally('The party ended while you were away');
    return;
  }
  // a play / pause the server could not place: we are not in the party on
  // this socket any more — take our place again
  if (d.lost) return rejoin();
  settle(false, d.message || 'party error');
});
onMessage('party_update', d => {
  const p = d.party as Party | undefined;
  if (!party.current || !p || p.code !== party.current.code) return;
  const wasHost = party.role === 'host';
  party.current = p;
  if (p.you) party.me = p.you;
  party.role = roleOf(p);
  if (d.joined) showToast(`${d.joined} joined the party`, '👥');
  if (d.left) showToast(`${d.left} left the party`, '👋');
  if (d.host && party.role === 'host' && !wasHost) showToast("You're the host now", '👥');
  else if (d.host) showToast(`${d.host} is the host now`, '👥');
  for (const fn of listeners.update) fn(p);
});
onMessage('party_state', d => {
  if (!party.current || d.code !== party.current.code) return;
  const st = d as unknown as PartyStateMsg;
  party.current.state = {playing: st.playing, position: st.position, at: st.at};
  party.current.waiting = st.kind === 'wait' ? st.waiting || [] : [];
  for (const fn of listeners.state) fn(st);
});
onMessage('party_react', d => {
  if (!party.current || d.code !== party.current.code) return;
  for (const fn of listeners.react) fn({emoji: String(d.emoji || ''), by: d.by ? String(d.by) : undefined});
});
onMessage('party_item', d => {
  const p = d.party as Party | undefined;
  if (!party.current || !p || p.code !== party.current.code) return;
  party.current = p;
  for (const fn of listeners.item) fn({item: d.item as PartyItem, party: p});
});
onMessage('party_ended', d => {
  if (!party.current || d.code !== party.current.code) return;
  party.current = null;
  party.role = null;
  party.me = null;
  showToast(String(d.reason || 'The party ended'), '👥');
  for (const fn of listeners.ended) fn({reason: d.reason as string | undefined});
});

// What the player needs to open a party's title: a torrent play-item travels
// with the party, a library id is enough on its own. Null when the party is
// gone. Mirrors the site's #/party/:code route.
export const resolvePartyRoute = async (
  code: string,
): Promise<{id: string; title: string; stream?: TorrentPlayItem} | null> => {
  let p: Party | null = null;
  try {
    p = await api.party(code);
  } catch {
    return null;
  }
  if (!p || !p.item || !p.item.id) return null;
  const it = p.item;
  const title = it.showTitle && it.season != null && it.episode != null
    ? `${it.showTitle} · S${it.season} E${it.episode}`
    : String(it.title || 'Watch party');
  if (String(it.id).startsWith('torrent|')) {
    return {id: it.id, title, stream: it as unknown as TorrentPlayItem};
  }
  return {id: it.id, title};
};

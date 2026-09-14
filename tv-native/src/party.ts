// Watch party client — the TV's copy of public/js/party.js. One party at a
// time, over the app's socket; the player drives create / join / leave /
// sendState and listens for what the others did.
import {api, Party, PartyItem, TorrentPlayItem} from './api';
import {isOpen, onMessage, send} from './realtime';
import {showToast} from './toast';

export const party: {current: Party | null; role: 'host' | 'guest' | null} = {
  current: null,
  role: null,
};

type Listeners = {
  state: Set<(d: PartyStateMsg) => void>;
  update: Set<(p: Party) => void>;
  ended: Set<(d: {reason?: string}) => void>;
  item: Set<(d: {item: PartyItem; party: Party}) => void>;
};
export type PartyStateMsg = {
  playing: boolean;
  position: number;
  at: number;
  now: number;
  kind: 'play' | 'pause' | 'seek' | 'sync';
  by?: string;
};
const listeners: Listeners = {state: new Set(), update: new Set(), ended: new Set(), item: new Set()};
export const onPartyState = (fn: (d: PartyStateMsg) => void) => (listeners.state.add(fn), () => listeners.state.delete(fn));
export const onPartyUpdate = (fn: (p: Party) => void) => (listeners.update.add(fn), () => listeners.update.delete(fn));
export const onPartyEnded = (fn: (d: {reason?: string}) => void) => (listeners.ended.add(fn), () => listeners.ended.delete(fn));
export const onPartyItem = (fn: (d: {item: PartyItem; party: Party}) => void) => (listeners.item.add(fn), () => listeners.item.delete(fn));

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

export const createParty = async (item: PartyItem) => {
  const p = await ask({type: 'party_create', item});
  party.current = p;
  party.role = 'host';
  return p;
};
export const joinParty = async (code: string) => {
  const p = await ask({type: 'party_join', code: String(code || '').toUpperCase().trim()});
  party.current = p;
  party.role = 'guest';
  return p;
};
export const leaveParty = () => {
  if (!party.current) return;
  send({type: 'party_leave'});
  party.current = null;
  party.role = null;
};
// Host only: the party moves to another title (Up next); guests follow.
export const setPartyItem = (item: PartyItem) => {
  if (!party.current || party.role !== 'host') return;
  party.current.item = item;
  send({type: 'party_item', item});
};
export const sendPartyState = (playing: boolean, position: number, kind: PartyStateMsg['kind'] = 'sync') => {
  if (!party.current) return;
  send({type: 'party_state', playing: !!playing, position: Math.max(0, position || 0), kind});
};

onMessage('party_created', d => settle(true, d.party));
onMessage('party_joined', d => settle(true, d.party));
onMessage('party_error', d => settle(false, d.message || 'party error'));
onMessage('party_update', d => {
  const p = d.party as Party | undefined;
  if (!party.current || !p || p.code !== party.current.code) return;
  party.current = p;
  if (d.joined) showToast(`${d.joined} joined the party`, '👥');
  if (d.left) showToast(`${d.left} left the party`, '👋');
  for (const fn of listeners.update) fn(p);
});
onMessage('party_state', d => {
  if (!party.current || d.code !== party.current.code) return;
  const st = d as unknown as PartyStateMsg;
  party.current.state = {playing: st.playing, position: st.position, at: st.at};
  for (const fn of listeners.state) fn(st);
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

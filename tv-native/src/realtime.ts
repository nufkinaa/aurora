// The app's WebSocket to the Aurora server — presence, live notifications and
// the watch-party channel (src/realtime.js on the server). One socket per run,
// opened once a profile is active and closed when it is left; reconnects with
// backoff. Messages are dispatched by `type` to whoever subscribed.
import {getBaseUrl, getSession, forgetMemo} from './api';

type Handler = (data: Record<string, unknown> & {type: string}) => void;
const listeners = new Map<string, Set<Handler>>();
let ws: WebSocket | null = null;
let wanted = false; // connect() was called and disconnect() has not
let delay = 1000;
let timer: ReturnType<typeof setTimeout> | null = null;
let identity: {id: string; name: string; avatar?: string | null; avatarImage?: string | null} | null = null;

export const onMessage = (type: string, fn: Handler) => {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(fn);
  return () => {
    listeners.get(type)?.delete(fn);
  };
};

export const isOpen = () => !!ws && ws.readyState === WebSocket.OPEN;

export const send = (data: Record<string, unknown>) => {
  if (!isOpen()) return false;
  try {
    ws!.send(JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
};

// Who this socket is. Sent on every (re)open as the server's `hello`, plus the
// avatar the party member chips want.
const hello = () => {
  if (!identity) return;
  send({type: 'hello', profile: identity.name, profileId: identity.id});
  send({type: 'party_avatar', avatar: identity.avatar || null, avatarImage: identity.avatarImage || null});
};
export const setIdentity = (id: typeof identity) => {
  identity = id;
  hello();
};

const open = () => {
  if (!wanted || ws) return;
  const base = getBaseUrl();
  if (!base) return;
  const url = base.replace(/^http/, 'ws');
  const session = getSession();
  try {
    // react-native's WebSocket takes headers as the third argument; the
    // session is what lets a closed-mode server accept the upgrade.
    const sock = new WebSocket(url, undefined, session ? {headers: {'X-Session': session}} : undefined);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      // Only a socket that STAYS open earns a backoff reset (bans close at once).
      setTimeout(() => {
        if (ws === sock && sock.readyState === WebSocket.OPEN) delay = 1000;
      }, 5000);
      hello();
    };
    sock.onmessage = e => {
      let data: (Record<string, unknown> & {type: string}) | null = null;
      try {
        data = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'library_updated') forgetMemo();
      const subs = listeners.get(data.type);
      if (subs) for (const fn of subs) fn(data);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (!wanted) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30000);
    };
    sock.onerror = () => {};
  } catch {
    ws = null;
    if (wanted) {
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
};

export const connect = () => {
  wanted = true;
  open();
};

export const disconnect = () => {
  wanted = false;
  if (timer) clearTimeout(timer);
  timer = null;
  const sock = ws;
  ws = null;
  try {
    sock?.close();
  } catch {}
};

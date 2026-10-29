// The app's WebSocket to the Aurora server — presence, live notifications and
// the watch-party channel (src/realtime.js on the server). One socket per run,
// opened once a profile is active and closed when it is left; reconnects with
// backoff. Messages are dispatched by `type` to whoever subscribed.
import {AppState, Platform} from 'react-native';
import {getBaseUrl, getSession, forgetLibraryReads} from './api';
import {APP_VERSION, PHONE_APP_VERSION} from './update';
import {appId, isPhone} from './formFactor';
import {registerProfileCache} from './profileScope';
import {wsDown, wsUp} from './telemetry'; // [analytics]
import {
  createRefresher,
  nextReconnectStep,
  reconnectWait,
  restartWait,
  RECONNECT_FIRST_MS,
  RESTART_QUIET_TRIES,
} from './serverManners';

// A MUST-RESET PROFILE'S SOCKET (server 1.6.91): the server greets it with
// {type: "password_reset_required", profileId} and ignores whatever it sends.
// App.tsx listens and raises the new-password screen; that unmounts the
// session (SessionWiring disconnects), and the socket is opened again with
// the fresh credentials once the password is saved. The admin's force-reset
// itself arrives as `kicked` with `reset: true` — handled as any kick: this
// socket stops, and the boot that follows lands on the wall / sign-in.
type Handler = (data: Record<string, unknown> & {type: string}) => void;
const listeners = new Map<string, Set<Handler>>();
let ws: WebSocket | null = null;
let wanted = false; // connect() was called and disconnect() has not
// THE SERVER ENDED THIS SOCKET ON PURPOSE — an admin's kick, a ban. It says so
// (`kicked` / `banned`) and then closes. The close used to be read as an
// outage: the app connected again a second later and carried on, so a kicked
// TV was back before the admin had let go of the button, and a banned one
// knocked on the door every 30 s for ever (audit A17, A18). After either
// message nothing reconnects until connect() is called again — which only a
// fresh sign-in / profile entry does (App.tsx decides what follows).
let halted = false;
let delay = RECONNECT_FIRST_MS;
// THE SERVER SAID IT IS RESTARTING (`server_restarting`, then it closes the
// socket with code 1012 — server 1.6.93). That is not an outage: the first
// try waits what the server asked (`retryInMs`) plus a random 0–3 s, so every
// TV in the house does not knock in the same instant, and the next few failed
// tries are the restart itself — nothing is counted as "the socket was lost"
// and nobody is told anything. `restartTries` counts down those quiet tries;
// 0 = no restart was announced.
let restartWaitMs = 0;
let restartTries = 0;
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

// ---------- [phone-remote] who wants to hear that the socket (re)opened ----------
// The phone remote's target (remote/target.ts) announces this TV again on
// every open, right after the hello. Returns the unsubscribe.
const openFns = new Set<() => void>();
export const onSocketOpen = (fn: () => void) => {
  openFns.add(fn);
  return () => {
    openFns.delete(fn);
  };
};
// ---------- [/phone-remote] ----------

// THE LIBRARY CHANGED (`library_updated`). The reads it decides are forgotten
// at once (that asks for nothing); the SCREENS are told later, once, after a
// random wait — a blink when Home is the screen being looked at, half a
// second to five otherwise — and not at all while a film plays or the app is
// not in front: then they are told when that is over (serverManners.ts
// createRefresher has the rules; docs/operations.md the reasons). Home says
// when it is on screen, the player when it is mounted.
let homeOnScreen = false;
const holds = new Set<string>();
let lastLibraryMsg: (Record<string, unknown> & {type: string}) | null = null;
const refresher = createRefresher({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: t => clearTimeout(t),
  rnd: () => Math.random(),
  homeOnScreen: () => homeOnScreen,
  held: () => holds.size > 0,
  deliver: () => {
    const data = lastLibraryMsg || {type: 'library_updated'};
    lastLibraryMsg = null;
    const subs = listeners.get('library_updated');
    if (subs) for (const fn of [...subs]) fn(data);
  },
});
// The library changed, told AT ONCE even while the refresh is held — for the
// one small read a mounted player keeps up to date itself (which episode is
// next: an episode that lands while the one before it plays). Whoever listens
// owes the server the manners: a random wait before asking. Returns the unsubscribe.
const newsNow = new Set<Handler>();
export const onLibraryNews = (fn: Handler) => {
  newsNow.add(fn);
  return () => {
    newsNow.delete(fn);
  };
};
export const setHomeOnScreen = (on: boolean) => {
  homeOnScreen = on;
};
/** `why` holds library refreshes back while `on` ("player", "background"). */
export const holdLibraryRefresh = (why: string, on: boolean) => {
  if (on) holds.add(why);
  else if (holds.delete(why)) refresher.release();
};
if (AppState.currentState && AppState.currentState !== 'active') holds.add('background');
AppState.addEventListener('change', s => holdLibraryRefresh('background', s !== 'active'));

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
// What this device is, in the app's own words: the socket has no browser
// user-agent, so the admin page listed every TV as "Desktop - Other".
const deviceInfo = () => {
  const c = (Platform.constants || {}) as {Brand?: string; Manufacturer?: string; Model?: string};
  const maker = c.Brand || c.Manufacturer || '';
  const phone = isPhone();
  return {app: appId(), build: phone ? `Aurora phone ${PHONE_APP_VERSION}` : `Aurora TV ${APP_VERSION}`, model: [maker, c.Model].filter(Boolean).join(' ') || (phone ? 'Android phone' : 'Android TV')};
};

// What this TV is doing, as the site reports it (ws.js reportActivity): the
// server builds History, sessions and the live "who is watching" from these
// messages - without them a TV was invisible there (elia, 2026-10-08).
// Remembered, so a socket that reconnects mid-film says it again.
let lastActivity: Record<string, unknown> | null = null;
export const reportActivity = (
  action: 'Watching' | 'Browsing',
  details: string | null = null,
  extra: Record<string, unknown> = {},
) => {
  lastActivity = {type: 'activity', action, details, ...extra};
  send(lastActivity);
};

const hello = () => {
  if (!identity) return;
  send({type: 'hello', profile: identity.name, profileId: identity.id, ...deviceInfo()});
  send({type: 'party_avatar', avatar: identity.avatar || null, avatarImage: identity.avatarImage || null});
  if (lastActivity) send(lastActivity);
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
      wsUp(); // [analytics] lost → back, as a timing
      restartTries = 0; // the server is back
      // Only a socket that STAYS open earns a backoff reset (bans close at once).
      setTimeout(() => {
        if (ws === sock && sock.readyState === WebSocket.OPEN) delay = RECONNECT_FIRST_MS;
      }, 5000);
      hello();
      // [phone-remote] the TV says what it is to the phone remote again
      for (const fn of [...openFns]) {
        try {
          fn();
        } catch {}
      }
      // [/phone-remote]
    };
    sock.onmessage = e => {
      let data: (Record<string, unknown> & {type: string}) | null = null;
      try {
        data = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'library_updated') {
        forgetLibraryReads();
        lastLibraryMsg = data;
        refresher.changed(); // the screens hear it later, once
        for (const fn of [...newsNow]) fn(data); // (onLibraryNews: at once, held or not)
        return;
      }
      if (data.type === 'kicked' || data.type === 'banned') halted = true;
      if (data.type === 'server_restarting') {
        restartWaitMs = restartWait(data.retryInMs);
        restartTries = RESTART_QUIET_TRIES;
        console.log(`[live] the server is restarting: back in ${restartWaitMs} ms`);
      }
      const subs = listeners.get(data.type);
      if (subs) for (const fn of subs) fn(data);
    };
    sock.onclose = (e?: {code?: number}) => {
      if (ws === sock) ws = null;
      if (!wanted || halted) return;
      // (1012 = "service restart": a server that closed that way without its
      // message having arrived is treated the same)
      if (e?.code === 1012 && !restartTries) {
        restartWaitMs = restartWait(undefined);
        restartTries = RESTART_QUIET_TRIES;
      }
      again();
    };
    sock.onerror = () => {};
  } catch {
    ws = null;
    if (wanted) again();
  }
};
// The next try. After an announced restart: the wait the server asked for,
// once, then short jittered steps — quietly. Otherwise a doubling wait
// (1 s → 30 s) of which a random part is waited, between half and all.
const again = () => {
  if (timer) clearTimeout(timer);
  if (restartTries > 0) {
    restartTries -= 1;
    const first = restartWaitMs > 0;
    const wait = first ? restartWaitMs : reconnectWait(delay);
    restartWaitMs = 0;
    if (!first) delay = nextReconnectStep(delay);
    timer = setTimeout(open, wait);
    return;
  }
  wsDown(); // [analytics] an outage (never the planned restart's first tries)
  timer = setTimeout(open, reconnectWait(delay));
  delay = nextReconnectStep(delay);
};
/** Is the server in a restart it announced (and the first tries not yet spent)? */
export const serverRestarting = () => restartTries > 0;

export const connect = () => {
  wanted = true;
  halted = false;
  delay = RECONNECT_FIRST_MS;
  restartTries = 0;
  restartWaitMs = 0;
  open();
};
/** Did the server end the socket on purpose (and nothing reconnects)? */
export const isHalted = () => halted;

// A profile is left: the next one does not say hello as it, nor repeat what
// it was watching.
registerProfileCache('realtime', () => {
  identity = null;
  lastActivity = null;
  lastLibraryMsg = null;
});

export const disconnect = () => {
  wanted = false;
  if (timer) clearTimeout(timer);
  timer = null;
  refresher.cancel();
  lastLibraryMsg = null;
  const sock = ws;
  ws = null;
  try {
    sock?.close();
  } catch {}
};

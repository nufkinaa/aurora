// "What do we watch tonight?" on the TV and the phone app — the talking half:
// the routes (src/routes/group.js, every one acting as the active profile and
// guarded like its own data) and the live part: the socket says
// `group_update { code, rev }` when the session changed and this asks again;
// a slow poll stands in when the socket is down. The words and rules are
// groupPick.ts; the screens draw.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState} from 'react-native';
import {apiPost, apiRequest, getActiveProfile, getToken} from './api';
import {appId} from './formFactor';
import {isOpen, onMessage, onSocketOpen, send} from './realtime';
import {GroupCard, GroupOptions, GroupRole, GroupSearchHit, GroupSession, GroupSettings, GroupVerdict, newer} from './groupPick';

// This device's id in a session: the server knows a member by person +
// device, so the app coming back (or the socket dropping) takes the same place.
const DEVICE_KEY = 'aurora.group.device';
let deviceId = `${appId()}${Math.random().toString(36).slice(2, 12)}`;
AsyncStorage.getItem(DEVICE_KEY)
  .then(v => {
    if (v && /^[\w-]{6,40}$/.test(v)) deviceId = v;
    else AsyncStorage.setItem(DEVICE_KEY, deviceId).catch(() => {});
  })
  .catch(() => {});
export const groupDevice = () => deviceId;

const me = (): string => {
  const id = getActiveProfile();
  if (!id) throw new Error('No profile');
  return id;
};
const base = (code?: string) => `/api/profiles/${encodeURIComponent(me())}/group${code ? `/${encodeURIComponent(code)}` : ''}`;
type S = {session: GroupSession};

export const groupApi = {
  options: () => apiRequest<GroupOptions>(`${base()}/options`),
  tutorialSeen: (seen = true) => apiPost<{tutorialSeen: boolean}>(`${base()}/tutorial`, {seen}),
  create: (settings: Partial<GroupSettings>, role: GroupRole) =>
    apiPost<S>(base(), {settings, role, device: deviceId, app: appId()}),
  join: (code: string, role: GroupRole = 'voter') => apiPost<S>(`${base()}/join`, {code, role, device: deviceId, app: appId()}),
  get: (code: string) => apiRequest<S>(`${base(code)}?device=${encodeURIComponent(deviceId)}`),
  settings: (code: string, settings: Partial<GroupSettings>) => apiPost<S>(`${base(code)}/settings`, {device: deviceId, settings}),
  role: (code: string, role: GroupRole) => apiPost<S>(`${base(code)}/role`, {device: deviceId, role}),
  start: (code: string) => apiPost<S>(`${base(code)}/start`, {device: deviceId}),
  vote: (code: string, key: string, verdict: GroupVerdict | null) =>
    apiPost<{ok: boolean; answered: number; of: number}>(`${base(code)}/vote`, {device: deviceId, key, verdict}),
  search: (code: string, q: string) =>
    apiRequest<{results: GroupSearchHit[]}>(`${base(code)}/search?q=${encodeURIComponent(q)}&device=${encodeURIComponent(deviceId)}`),
  add: (code: string, title: Pick<GroupSearchHit, 'id' | 'imdbId' | 'type' | 'title' | 'year' | 'poster'>) =>
    apiPost<{ok: boolean; key: string; already?: boolean}>(`${base(code)}/add`, {device: deviceId, title}),
  finish: (code: string) => apiPost<S>(`${base(code)}/finish`, {device: deviceId}),
  extend: (code: string) => apiPost<S>(`${base(code)}/extend`, {device: deviceId}),
  pick: (code: string, index: number) => apiPost<S>(`${base(code)}/pick`, {device: deviceId, index}),
  again: (code: string) => apiPost<S>(`${base(code)}/again`, {device: deviceId}),
  choose: (code: string, key: string) => apiPost<S>(`${base(code)}/choose`, {device: deviceId, key}),
  leave: (code: string) => apiPost<{ok: boolean}>(`${base(code)}/leave`, {device: deviceId}),
  end: (code: string) => apiPost<{ok: boolean}>(`${base(code)}/end`, {device: deviceId}),
};

// ---------- following a session live ----------
// onSession gets every newer copy (never an older one); onLost when the
// server no longer knows the session (404) or this device is not in it (403).
export type GroupFollow = {
  stop: () => void;
  refresh: () => void; // ask now (after an action of our own)
  take: (s: GroupSession) => void; // an answer an action already brought back
  receivedAt: () => number; // Date.now() when the copy on screen arrived (for the countdown)
};
const POLL_MS = 4000; // with the socket down: often enough for a room
const POLL_LIVE_MS = 15000; // with it up: only a safety net

export const followGroup = (
  code: string,
  onSession: (s: GroupSession) => void,
  onLost: (why: {status: number; message: string}) => void,
): GroupFollow => {
  let stopped = false;
  let had: GroupSession | null = null;
  let at = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let again = false;
  const take = (s: GroupSession) => {
    if (stopped || !newer(had, s)) return;
    had = s;
    at = Date.now();
    onSession(s);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    const done = had && (had.phase === 'ended' || had.phase === 'chosen');
    timer = setTimeout(ask, done ? 30000 : isOpen() ? POLL_LIVE_MS : POLL_MS);
  };
  const ask = () => {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    groupApi
      .get(code)
      .then(r => take(r.session))
      .catch((e: {status?: number; message?: string}) => {
        if (!stopped && (e?.status === 404 || e?.status === 403)) onLost({status: e.status, message: e.message || ''});
      })
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          ask();
        } else schedule();
      });
  };
  const watch = () => {
    try {
      send({type: 'group_watch', code, device: deviceId, profileId: getActiveProfile(), token: getToken() || undefined});
    } catch {}
  };
  const offUpdate = onMessage('group_update', d => {
    if (String(d.code || '') !== code) return;
    if (had && Number(d.rev) <= had.rev) return;
    ask();
  });
  const offOpen = onSocketOpen(() => {
    watch();
    ask();
  });
  const appSub = AppState.addEventListener('change', st => {
    if (st === 'active') ask();
  });
  if (isOpen()) watch();
  ask();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      offUpdate();
      offOpen();
      try {
        appSub.remove();
      } catch {}
      try {
        send({type: 'group_unwatch'});
      } catch {}
    },
    refresh: ask,
    take,
    receivedAt: () => at,
  };
};

/** How a pick plays: a library title plays now; a catalogue one opens its page. */
export const playTarget = (c: GroupCard): {kind: 'library'; id: string; type: 'movie' | 'show'} | {kind: 'discover'; imdbId: string; type: 'movie' | 'show'} | null =>
  c.id ? {kind: 'library', id: c.id, type: c.type} : c.imdbId ? {kind: 'discover', imdbId: c.imdbId, type: c.type} : null;

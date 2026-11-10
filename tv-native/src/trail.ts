// The trail a problem report carries (docs/report-trail.md): what the viewer
// did in the minutes before pressing Report, step by step — the TV app and
// the phone app alike, with the site's rules and words (trailCore.ts). In
// memory only (the last 60 steps; the last ten minutes of them are sent), and
// sent ONLY inside a report the viewer chooses to send (clientContext.ts).
//
// Hooked at the few central places, one line each:
//   screens     the navigators' onStateChange (navigation.tsx, phone/navigation.tsx)  nav
//   presses     telemetry.ts uiHit (Focusable, Tap) and Btn's label                  tap
//   keys        telemetry.ts' one TVEventHandler listener                            key
//   requests    api.ts send()                                                         req · search, last 10 timings
//   sheets      overlay.ts                                                            sheet
//   toasts      toast.ts                                                              toast
//   errors      telemetry.ts note()                                                   err
//   the player  Player.tsx: its marks, play/pause, seek, next, audio, subtitles      play
//   the app     AppState (here), the live socket (realtime.ts)                        app · net
//
// Another profile: the trail starts over (registerProfileCache below).
import {AppState} from 'react-native';
import {Trail, TRAIL, Fields, Kind, Req, searchOf, trailPath, tvKeyName} from './trailCore';
import {registerProfileCache} from './profileScope';

const ring = new Trail();
const reqs: Req[] = [];
const bootAt = Date.now();

export const trail = (k: Kind, fields?: Fields) => {
  try {
    ring.add(k, fields || {});
  } catch {}
};
/** The steps as they leave the device (`names`: other profiles' names, taken out). */
export const trailTake = (o: {sentAt?: number; names?: string[]} = {}) => ring.take(o);
export const recentRequests = (sentAt = Date.now()): Req[] => reqs.map(r => ({...r, t: Math.max(0, sentAt - r.t)}));
export const sessionMs = () => Date.now() - bootAt;

// ---------- the central places ----------
/** A screen was opened (the navigators' onStateChange): its name, and the title id when it has one. */
export const trailScreen = (prefix: string, r: {name: string; params?: object} | undefined) => {
  if (!r) return;
  const p = (r.params || {}) as Record<string, unknown>;
  const id = [p.id, p.itemId, p.imdbId, p.libraryId].find(v => typeof v === 'string' || typeof v === 'number');
  const kind = typeof p.kind === 'string' ? `/${p.kind}` : '';
  trail('nav', {s: `${prefix}:${r.name.toLowerCase()}${kind}`, id: id != null ? String(id).slice(0, 48) : undefined});
};
/** A key on the remote (telemetry.ts' one global listener). Key-ups and focus moves are not steps. */
export const trailKey = (evt: {eventType?: string; eventKeyAction?: number | string} | null | undefined) => {
  if (!evt || Number(evt.eventKeyAction) === 1) return;
  const name = tvKeyName(evt.eventType);
  if (name) trail('key', {key: name});
};
/** A request answered (api.ts send): every one is timed; the trail gets a write, a failure, a slow answer. */
const NOISE = /^\/api\/(usage|play-mark|reports|caps|presence|torrents\/perf-mark)(\/|$)|\/(progress|status|poll|heartbeat)$/;
export const trailRequest = (method: string | undefined, fullPath: string, status: number, ms: number) => {
  try {
    const m = String(method || 'GET').toUpperCase();
    const p = trailPath(fullPath);
    const q = searchOf(fullPath);
    if (q) trail('search', {q});
    const noise = NOISE.test(p);
    if (!noise && p.startsWith('/api/')) {
      reqs.push({t: Date.now(), m, p, s: status, ms: Math.round(ms)});
      if (reqs.length > TRAIL.REQS) reqs.shift();
    }
    if (status === 0 || status >= 400 || ms >= TRAIL.SLOW_MS || (!noise && m !== 'GET')) trail('req', {m, p, s: status, ms: Math.round(ms)});
  } catch {}
};

// The app to the background and back.
try {
  AppState.addEventListener('change', s => {
    if (s === 'active') trail('app', {e: 'foreground'});
    else if (s === 'background') trail('app', {e: 'background'});
  });
} catch {}

registerProfileCache('trail', () => {
  ring.clear();
  reqs.length = 0;
  trail('app', {e: 'profile'});
});

trail('app', {e: 'start'});

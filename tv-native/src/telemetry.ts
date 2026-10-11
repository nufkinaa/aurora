// What the TV app reports besides its usage events (docs/analytics.md) — all
// behind the same switch as those (Settings → Privacy, and the profile's own
// choice on the server), all to THIS server only, in the same batch:
//
//   errors    what went wrong, by KIND and count: an uncaught JS error, an
//             unhandled promise rejection, console.warn / console.error, a
//             request the server refused ("GET /img/:id?w=256 → 401"),
//             pictures that would not load, a player error with its
//             ExoPlayer code, a JS thread that stood still, a memory
//             warning, a last run that ended while on screen.
//   timings   how long the moments people feel took — the same names and
//             definitions as the site.
//   controls  how many times each tagged control (`uiId="detail.play"` on a
//             Focusable / Btn / Chip) was pressed, per screen — counts only.
//
// Never: a title, an id, an address, search text, a name.
//
// COST ON A WEAK BOX. A key press is one assignment (`lastInput = Date.now()`
// in the one global key listener). A press on a tagged control is two
// property reads and an increment (ControlCounter.hit) — nothing is
// allocated, nothing is stored, nothing is sent. Sending waits for the
// remote to have been still for three seconds and is never done while a
// play is starting (usage.ts asks `quiet()`); storage is touched when the app
// comes to the front or leaves it, and when a batch with errors goes out —
// never per event.
//
// This file imports nothing of the app's own but the profile registry (which
// imports nothing): usage.ts hands it what it needs, so anything may import it
// without a cycle.
import {AppState, TVEventHandler} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ControlCounter,
  ErrorBook,
  Kind,
  Level,
  Report,
  Timers,
  idleNow,
  playPath,
  urlPattern,
  ControlRow,
  TimingRow,
} from './telemetryCore';
import {registerProfileCache} from './profileScope';

const K_IID = 'aurora.iid';
const K_DAY = 'aurora.telDay';
const K_RUN = 'aurora.telRun';

const book = new ErrorBook();
const controls = new ControlCounter();
const timers = new Timers(() => Date.now());

let iid = '';
let ready = false; // the install id and the day's count have been read
let screen = 'tv:start'; // "tv:home", "tv:browse/movie" — from the navigator's own route event
let lastInput = 0;
let firstBatch = true;
let poke: () => void = () => {};
let version = '';
// Usage stats are KNOWN to be off (this box's switch, or the profile's own
// choice): nothing is even counted. usage.ts says so; while a profile's
// choice is still being read, what happens is held (bounded), not sent.
let off = false;
export const setOff = (v: boolean) => {
  off = v;
  if (v) clear();
};
{
  const value = timers.value.bind(timers);
  timers.value = (name: string, ms: number, dim?: string) => (off ? null : value(name, ms, dim));
}

/** usage.ts: "call me when there is something to carry", and this build's version. */
export const wire = (o: {poke: () => void; version: string}) => {
  poke = o.poke;
  version = o.version;
  boot();
};

const today = () => new Date().toISOString().slice(0, 10);

// ---------- the idle gate ----------
// One global listener, one assignment. (Focus moves arrive here too: a held
// direction keeps the gate shut for as long as it is held.)
try {
  TVEventHandler.addListener(() => {
    lastInput = Date.now();
  });
} catch {}
let playAt = 0; // a play is starting: from the player's route to its first frame
const playStarting = () => playAt > 0 && Date.now() - playAt < 60000;
/** May a batch go out now? Never while someone is moving about or a play is starting. */
export const quiet = () =>
  idleNow({
    sinceInputMs: Date.now() - lastInput,
    playStarting: playStarting(),
  });

// ---------- controls ----------
/** A tagged control was pressed (Focusable's onPress). Counter increment only. */
export const uiHit = (id: string) => {
  if (!off) controls.hit(screen || '?', id, 'remote');
};

// ---------- errors ----------
const note = (kind: Kind, level: Level, message: unknown, o: {ctx?: Record<string, number> | null; raw?: boolean} = {}) => {
  if (off) return;
  try {
    if (book.add(kind, level, message, {screen, ctx: o.ctx || null, raw: !!o.raw})) poke();
  } catch {}
};
/** reportError('media', 'player error', {ctx: {code: 4003}}) */
export const reportError = (kind: Kind, message: unknown, o: {level?: Level; ctx?: Record<string, number> | null} = {}) =>
  note(kind, o.level || 'error', message, {ctx: o.ctx});

/** An uncaught JS error (errors.ts' global handler, through usage.trackError). */
export const jsError = (message: unknown, fatal?: boolean) => note('js', 'error', message, {ctx: fatal ? {fatal: 1} : null});

/** A request the server refused, or that never arrived (api.ts): by its shape. */
export const httpFailed = (method: string | undefined, path: string, status: number) => {
  const shape = urlPattern(path);
  if (shape === '/api/usage') return;
  note('http', status >= 500 || status === 0 ? 'error' : 'warn', `${String(method || 'GET').toUpperCase()} ${shape}`, {
    ctx: {status},
    raw: true,
  });
};

/** A picture that would not load (Card.tsx says "image <shape>: <why>"): one
 *  line per shape and status, however many posters it was. */
export const imageFailed = (shape: string, why: string) => {
  const m = /code=(\d{3})/.exec(why) || /\b([45]\d\d)\b/.exec(why);
  note('img', 'error', urlPattern(shape.replace(/<id>/g, ':id').replace(/…/g, '')), {
    ctx: m ? {status: Number(m[1])} : null,
    raw: true,
  });
};

/** The player gave up on something. ExoPlayer names its errors
 *  ("ERROR_CODE_IO_BAD_HTTP_STATUS") and numbers them; both are kept, the
 *  rest of the text (it can carry an address) is not. */
export const playerError = (detail: string, errorCode?: string | number) => {
  const name = /ERROR_CODE_[A-Z0-9_]+/.exec(detail);
  const code = /^\d{4,5}$/.test(String(errorCode ?? '')) ? [0, String(errorCode)] : /\b([1-7]\d{3})\b/.exec(detail);
  const http = /Response code: (\d{3})/.exec(detail);
  note('media', 'error', `player error ${name ? name[0].toLowerCase() : 'unknown'}`, {
    ctx: {
      ...(code ? {code: Number(code[1])} : {}),
      ...(http ? {status: Number(http[1])} : {}),
    },
    raw: true,
  });
};

/** The picture stood still mid-play (Player.tsx's own stall mark, through usage.track). */
export const playbackStalled = () => note('stall', 'warn', 'playback stalled', {raw: true});

/** The system asked for memory back while the app was on screen (perfTier.ts). */
export const memoryTrim = (level: number) =>
  note('mem', 'warn', 'memory warning while on screen', {
    ctx: {level},
    raw: true,
  });

// Unhandled promise rejections. React Native only tracks them in a
// development build; a release build needs to ask Hermes itself.
declare const __DEV__: boolean;
try {
  const hermes = (
    globalThis as unknown as {
      HermesInternal?: {enablePromiseRejectionTracker?: (o: unknown) => void};
    }
  ).HermesInternal;
  if (!__DEV__ && hermes && typeof hermes.enablePromiseRejectionTracker === 'function') {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (_id: number, r: unknown) => {
        const e = r as {
          name?: string;
          message?: string;
          status?: number;
        } | null;
        // a refused request is already counted, by its shape (httpFailed)
        if (e && (typeof e.status === 'number' || e.name === 'AbortError')) return;
        note(
          'promise',
          'error',
          e && e.message ? `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}` : 'rejection (no message)',
        );
      },
      onHandled: () => {},
    });
  }
} catch {}

// console.warn and console.error. Only what cannot be a person's data: the
// FIRST argument when it is a string (the message as written in the code) and
// the name and message of any Error after it; every other argument — a
// title, an object, an address — is reduced to its type.
{
  let busy = false;
  const describe = (args: unknown[]) => {
    const parts: string[] = [];
    for (let i = 0; i < args.length && i < 4; i++) {
      const a = args[i];
      if (a instanceof Error) parts.push(`${a.name}: ${a.message}`);
      else if (i === 0 && typeof a === 'string') parts.push(a);
      else parts.push(a === null ? '<null>' : `<${typeof a}>`);
    }
    return parts.join(' ');
  };
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level];
    console[level] = (...args: unknown[]) => {
      if (!busy) {
        busy = true;
        try {
          note('console', level, describe(args));
        } catch {}
        busy = false;
      }
      orig.apply(console, args as []);
    };
  }
}

// ---------- a JS thread that stood still ----------
// A one-second heartbeat; a beat that arrives more than three seconds late,
// while the app is on screen, is a freeze somebody sat through. (This is the
// closest thing to an ANR report that needs no crash SDK.)
let beatAt = Date.now();
let active = AppState.currentState === 'active';
let activeSince = Date.now();
setInterval(() => {
  const now = Date.now();
  const gap = now - beatAt - 1000;
  beatAt = now;
  if (!active || now - activeSince < 5000 || gap < 3000) return;
  const band = gap >= 10000 ? 'over 10 s' : gap >= 5000 ? '5 to 10 s' : '3 to 5 s';
  note('stall', 'warn', `the app stood still ${band}`, {
    ctx: {ms: gap},
    raw: true,
  });
}, 1000);

// ---------- a last run that ended while on screen ----------
// No crash SDK: a small marker. "fg" is written when the app comes to the
// front, "bg" when it leaves — so a marker still saying "fg" (or "play") at
// the next start means the last run did not leave by itself: a native crash,
// the system killing a frozen app, or the power going. (Power cuts make this
// a warning, not an error; it is the COUNT across boxes that says "crash".)
let runState = '';
const markRun = (state: string) => {
  if (state === runState) return;
  runState = state;
  AsyncStorage.setItem(K_RUN, JSON.stringify({s: state, v: version})).catch(() => {});
};
/** The app is about to be replaced or closed on purpose (update.ts): not a crash. */
export const cleanExit = () => markRun('bg');

AppState.addEventListener('change', s => {
  active = s === 'active';
  if (active) {
    activeSince = Date.now();
    beatAt = Date.now();
    markRun(playAt ? 'play' : 'fg');
  } else markRun('bg');
});

const boot = async () => {
  try {
    const [a, d, r] = await Promise.all([AsyncStorage.getItem(K_IID), AsyncStorage.getItem(K_DAY), AsyncStorage.getItem(K_RUN)]);
    iid = a && /^[a-z0-9]{16}$/.test(a) ? a : '';
    if (!iid) {
      // random, made here, tied to nothing: it only lets the server count
      // "three different boxes", and is hashed again before it is stored there
      for (let i = 0; i < 16; i++) iid += Math.floor(Math.random() * 16).toString(16);
      AsyncStorage.setItem(K_IID, iid).catch(() => {});
    }
    try {
      const day = d ? JSON.parse(d) : null;
      if (day && day.day === today()) book.sentToday = Number(day.n) || 0;
    } catch {}
    try {
      const run = r ? JSON.parse(r) : null;
      if (run && (run.s === 'fg' || run.s === 'play') && run.v === version) {
        note('crash', 'warn', run.s === 'play' ? 'the last run ended while playing' : 'the last run ended while on screen', {raw: true});
      }
    } catch {}
  } catch {
    if (!iid) for (let i = 0; i < 16; i++) iid += Math.floor(Math.random() * 16).toString(16);
  }
  ready = true;
  if (AppState.currentState === 'active') markRun('fg');
  checkUpdateLanded();
};

// ---------- timings ----------
let navAt = Date.now(); // when this screen was asked for
let navOnce: Record<string, 1> = {};
let lastPath = 'direct';
const startedAt = Date.now(); // the bundle began to run

/** The navigator says a screen was opened (routeTiming.ts routeStarted hands it on). */
export const setScreen = (pattern: string) => {
  screen = pattern;
  navAt = Date.now();
  navOnce = {};
  if (pattern === 'tv:player') {
    playAt = Date.now();
    if (active) markRun('play');
  } else if (playAt) {
    playAt = 0;
    seekAt = 0;
    if (active) markRun('fg');
  }
};
const sinceNav = (name: string, dim?: string) => {
  if (navOnce[name]) return;
  navOnce[name] = 1;
  if (timers.value(name, Date.now() - navAt, dim)) poke();
};
/** `nav_paint`: navigation start → first content painted. ONE CLOCK on the TV
 *  — routeTiming.ts (the press that asked for the screen → the screen says its
 *  content is on, useRouteShown) — which also sends the same number as the
 *  `route` usage event's `ms`, exactly as the site's router feeds both from
 *  its one measurement. Nothing in this file times it a second way. */
export const navPaint = (ms: number, pattern: string) => {
  if (timers.value('nav_paint', ms, pattern || '?')) poke();
};

// App start → Home usable, and profile picked → Home usable. "Usable" is the
// same moment as on the site: the first row's cards are laid out and a frame
// has been drawn.
let gateAt = 0;
let homeSeen = false;
export const profilePicked = () => {
  gateAt = Date.now();
};
export const homeUsable = () => {
  if (homeSeen && !gateAt) return;
  const at = Date.now();
  requestAnimationFrame(() => {
    if (gateAt) timers.value('gate_home', at - gateAt);
    else if (!homeSeen) timers.value('app_start_home', at - startedAt);
    gateAt = 0;
    homeSeen = true;
  });
};

/** A title page: its content is laid out / its backdrop has arrived. */
let titleDim = 'library';
export const titleShown = (catalogue: boolean) => {
  if (navOnce.title_content) return;
  titleDim = catalogue ? 'catalogue' : 'library';
  requestAnimationFrame(() => {
    sinceNav('title_content', titleDim);
  });
};
export const backdropShown = () => sinceNav('title_backdrop', titleDim);
/** The first poster of a grid has loaded. */
export const firstPoster = () => sinceNav('grid_first_poster', screen || '?');

export const tmStart = (name: string) => timers.start(name);
export const tmEnd = (name: string, dim?: string) => timers.end(name, dim);
/** "since the keystroke": the time from a running timer, which keeps running */
export const tmLap = (name: string, from: string, dim?: string) => {
  const t0 = timers.open.get(from);
  if (t0 != null) timers.value(name, Date.now() - t0, dim);
};
export const tmValue = (name: string, ms: number, dim?: string) => timers.value(name, ms, dim);

/** The player's first frame (usage.track('play') hands it on). */
export const playFirstFrame = (ms: number, what: {torrent?: boolean; transcode?: boolean}) => {
  playAt = 0;
  lastPath = playPath(what);
  timers.value('play_first_frame', ms, lastPath);
};
// Seek → playing again (Player.tsx: seekStarted when the seek is committed,
// seekResumed from the progress reports after it).
let seekAt = 0;
let seekTo = 0;
export const seekStarted = (target: number) => {
  if (playStarting()) return;
  if (!seekAt) seekAt = Date.now(); // a chain of presses is one seek, timed from its first commit
  seekTo = target;
};
/** A progress report while a seek is being timed: the picture is moving again
 *  when the position is at the target (a report still showing the old place
 *  is not it). */
export const seekResumed = (position: number) => {
  if (!seekAt || position < seekTo - 1 || position > seekTo + 8) return;
  timers.value('seek_resume', Date.now() - seekAt, lastPath);
  seekAt = 0;
};
/** Is a seek being timed? (so the player's progress handler pays one boolean) */
export const seeking = () => seekAt > 0;

/** The live socket: lost → back (realtime.ts). */
export const wsDown = () => {
  if (!timers.running('ws_reconnect')) timers.start('ws_reconnect');
};
export const wsUp = () => {
  timers.end('ws_reconnect');
};

// The self-update: offered → running the new build, across the restart.
const K_UPD = 'aurora.telUpdate';
export const updateOffered = (to: string) => {
  AsyncStorage.getItem(K_UPD)
    .then(v => {
      const cur = v ? JSON.parse(v) : null;
      if (!cur || cur.to !== to) return AsyncStorage.setItem(K_UPD, JSON.stringify({to, at: Date.now()}));
    })
    .catch(() => {});
};
const checkUpdateLanded = () => {
  AsyncStorage.getItem(K_UPD)
    .then(v => {
      const cur = v ? JSON.parse(v) : null;
      if (!cur || cur.to !== version) return;
      timers.value('update_installed', Date.now() - Number(cur.at));
      return AsyncStorage.removeItem(K_UPD);
    })
    .catch(() => {});
};

// ---------- what goes into a batch (usage.ts calls these when it sends) ----------
export type Tel = {s?: 1; e?: Report[]; t?: TimingRow[]; u?: ControlRow[]};
export const telReady = () => ready;
export const installId = () => iid;
export const pending = () => book.size > 0 || timers.done.length > 0 || controls.any;
export const take = (): Tel | null => {
  const e = book.drain();
  const t = timers.drain();
  const u = controls.drain();
  if (!e.length && !t.length && !u.length) return null;
  const out: Tel = {};
  if (e.length) out.e = e;
  if (t.length) out.t = t;
  if (u.length) out.u = u;
  if (firstBatch) {
    out.s = 1;
    firstBatch = false;
  }
  if (e.length) AsyncStorage.setItem(K_DAY, JSON.stringify({day: today(), n: book.sentToday + book.seen.size})).catch(() => {});
  return out;
};
/** A batch that did not get through: its error reports wait for the next one. */
export const giveBack = (tel: Tel | null) => {
  if (tel && tel.e) book.restore(tel.e);
};
/** Opted out (here or on the server): everything held is forgotten. */
export const clear = () => {
  book.items.clear();
  timers.done.length = 0;
  controls.clear();
};

// A profile is left: what was counted under it and not sent yet — error
// reports, timings, control counts — is dropped, by design (it is never
// carried over to the next person), and the switch is "not known" again until
// usage.ts says what the next profile chose (profileScope.ts).
registerProfileCache('telemetry', () => {
  clear();
  off = false;
});

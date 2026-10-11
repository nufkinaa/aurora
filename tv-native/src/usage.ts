// Usage stats — the TV's copy of public/js/usage.js. Which screens, features
// and play paths get used and how long they took, batched every 20s (or when
// the app goes to the background) to THIS server's /api/usage, where the
// admin's Analytics tab reads them. Never anything typed, never an id.
//
// The richer half — error reports, timings, control counts (telemetry.ts) —
// rides in the same batch, under the same switch.
//
// THE SWITCH — ONE SOURCE. Usage stats are a setting of the PERSON, kept on
// the profile (prefs.usageStats) and the same on the website and on every TV:
// personSync.ts reads it (this box's remembered copy at once, then the
// profile itself, and again whenever it changes on another device) and
// SessionWiring hands each answer to setUsageEnabled; Settings → Privacy
// writes it through the same door. This file reads the profile from nowhere
// else. Until the first answer for the profile just entered, events are held
// (bounded), not sent. And the server enforces it whatever this app believes:
// a batch for a profile that said no is dropped there and answered
// `X-Usage: off`, on which this app stops sending for that profile.
//
// WHEN. Never while the remote is in use or a play is starting: a batch waits
// for three seconds without a key (telemetry.quiet()). Nothing here writes to
// storage.
import {AppState} from 'react-native';
import {getAuthMode, getBaseUrl, getSession} from './api';
import {registerProfileCache} from './profileScope';
import * as tel from './telemetry';
import {normMessage} from './telemetryCore';
import {APP_VERSION} from './update';

type Ev = {n: string; t: number; p: Record<string, string | number | boolean>};
const queue: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let profile: string | null = null;
// The person's own choice (see THE SWITCH): null = not known yet for the
// profile just entered (hold), true / false once personSync has said.
let profileAllows: boolean | null = null;
let errors = 0;
// What a build says about itself in its frame reports — which components are
// native (`impl`), which experiment is on (`exp`) — rides with its error
// reports too, so a fault can be told apart by them.
let buildFlags: string[] = [];
const sid = Math.random().toString(16).slice(2, 10);
const FLUSH_MS = 20000;
const MAX_BATCH = 25;
const MAX_QUEUE = 100; // held while the remote is busy; the oldest go first
const QUIET_RETRY_MS = 1500;

const forget = () => {
  queue.length = 0;
  tel.clear();
};

// telemetry.ts counts nothing while the answer is a known "no"
const sayOff = () => tel.setOff(profileAllows === false);

export const setUsageProfile = (id: string | null) => {
  if (profile && profile !== id) {
    flush(true);
    // what could not be sent under the profile it happened under is not
    // carried over to the next person
    forget();
  }
  profile = id;
  profileAllows = null;
  sayOff();
};
/** The active person's switch, as personSync knows it (SessionWiring, Settings). */
export const setUsageEnabled = (on: boolean) => {
  profileAllows = on;
  sayOff();
  if (!on) forget();
  else if (queue.length || tel.pending()) arm(); // what was held may go
};
/** Is the active profile sending usage stats? (null: not known yet) */
export const usageAllowed = (): boolean | null => profileAllows;

// What this box is, for the error reports: the model and Android level it
// already knows (perfTier.ts — required lazily, it imports this file).
type Facts = {model: string; os: string; flags: string[]};
let facts: Facts | null = null;
const deviceFacts = (): Facts => {
  if (facts) return facts;
  const f: Facts = {model: '', os: 'android', flags: []};
  try {
    const perf = require('./perfTier') as typeof import('./perfTier');
    const d = perf.deviceInfo();
    if (d) {
      f.model = `${d.manufacturer || ''} ${d.model || ''}`.trim().slice(0, 32);
      f.os = `android ${d.sdkInt}`;
    }
    if (perf.isLite()) f.flags.push('lite');
    if (perf.isLowRam()) f.flags.push('lowram');
    if (d) facts = f; // (lite and low-RAM are decided in the first seconds; good enough once the box is known)
  } catch {}
  return f;
};

// `force`: the app is leaving the screen (or the profile is changing) — send
// now rather than wait for a quiet remote.
const flush = (force = false) => {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!profile) return;
  if (profileAllows === false) return forget();
  if (!queue.length && !tel.pending()) return;
  // the profile's choice or the install id not read yet, the remote in use,
  // a play starting: later
  if (profileAllows === null || !tel.telReady() || (!force && !tel.quiet())) {
    if (!force) timer = setTimeout(flush, QUIET_RETRY_MS);
    return;
  }
  const base = getBaseUrl();
  if (!base) return;
  const events = queue.splice(0, queue.length);
  const extra = tel.take();
  if (!events.length && !extra) return;
  const who = deviceFacts();
  const forProfile = profile;
  const session = getSession();
  // a plain fetch (not api.usage): the answer's header is the point
  fetch(base + '/api/usage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session ? {'X-Session': session} : {}),
    },
    body: JSON.stringify({
      profile,
      sid,
      device: 'tv',
      look: 'tv',
      iid: tel.installId(),
      app: 'tv',
      v: APP_VERSION,
      model: who.model,
      os: who.os,
      auth: getAuthMode(),
      flags: [...who.flags, ...buildFlags].slice(0, 6),
      events,
      ...(extra ? {tel: extra} : {}),
    }),
  })
    .then(res => {
      // the server read the profile's switch and it says no
      if (res.headers.get('X-Usage') === 'off' && profile === forProfile) {
        profileAllows = false;
        sayOff();
        forget();
      }
    })
    .catch(() => tel.giveBack(extra));
};
function arm() {
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}
tel.wire({poke: arm, version: APP_VERSION});

// track('feat', {f: 'party_start'}) — props are short strings, numbers, booleans.
export const track = (name: string, props: Record<string, string | number | boolean> = {}) => {
  // What the richer half learns from events the app already sends — so these
  // need no call site of their own: a play's first
  // frame, a memory warning, a stall mid-play.
  // (which screen is on show: routeTiming.ts tells telemetry itself, when the
  // navigation starts — the `route` event is only sent once its content is on)
  if (name === 'play' && typeof props.ms === 'number') {
    tel.playFirstFrame(props.ms, {
      torrent: props.kind === 'stream',
      transcode: props.path !== 'direct',
    });
  } else if (name === 'perf' && props.screen === 'trim') tel.memoryTrim(Number(props.level) || 0);
  else if (name === 'perf' && (typeof props.impl === 'string' || typeof props.exp === 'string')) {
    buildFlags = [];
    if (typeof props.impl === 'string' && props.impl !== '-') buildFlags.push(`impl:${props.impl.toLowerCase()}`);
    if (typeof props.exp === 'string' && props.exp) buildFlags.push(`exp:${props.exp.toLowerCase()}`);
  }
  else if (name === 'feat' && props.f === 'stall_tv') tel.playbackStalled();
  if (!profile || profileAllows === false) return;
  queue.push({n: name, t: Date.now(), p: props});
  if (queue.length > MAX_QUEUE) queue.shift();
  if (queue.length >= MAX_BATCH) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 0); // still asks whether the remote is quiet
  } else arm();
};

// An error, said to the server. The old "error" event (the message only,
// five per run) stays for the Analytics tab; the report with its count goes
// through telemetry.ts — where forty pictures failing the same way are one
// line that says 40.
export const trackError = (message: string, fatal?: boolean) => {
  const msg = String(message || '');
  const img = /^image (\S+): ([\s\S]*)$/.exec(msg);
  if (img) tel.imageFailed(img[1], img[2]);
  else tel.jsError(msg, fatal);
  if (errors++ >= 5) return;
  track('error', {m: normMessage(msg).slice(0, 120)}); // reduced before it leaves: no address, id or quoted phrase
};

AppState.addEventListener('change', s => {
  if (s !== 'active') flush(true);
});

// A profile is left: what it did is sent as it (setUsageProfile flushes), what
// could not be sent is dropped — unsent reports included, by design — and
// nothing more is counted under its name (profileScope.ts).
registerProfileCache('usage', () => {
  setUsageProfile(null);
  queue.length = 0;
  errors = 0;
  tel.clear();
});

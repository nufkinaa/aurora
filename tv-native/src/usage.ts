// Usage stats — the TV's copy of public/js/usage.js. Which screens, features
// and play paths get used and how long they took, batched every 20s (or when
// the app goes to the background) to THIS server's /api/usage, where the
// admin's Analytics tab reads them. Never anything typed, never an id.
//
// The richer half — error reports, timings, control counts (telemetry.ts) —
// rides in the same batch, under the same switch.
//
// THE SWITCH. Two things must both say yes before anything is sent:
//   • this box's own setting (Settings → Privacy; setUsageEnabled), and
//   • the PROFILE's choice, read from the server (its prefs.usageStats) each
//     time a profile is entered — a person who switched usage stats off on
//     their phone has switched them off on every TV they use.
// Until the profile's choice has been read, events are held (bounded), not
// sent. And the server enforces it whatever this app believes: a batch for a
// profile that said no is dropped there and answered `X-Usage: off`, on
// which this app stops sending for that profile.
//
// WHEN. Never while the remote is in use or a play is starting: a batch waits
// for three seconds without a key (telemetry.quiet()). Nothing here writes to
// storage.
import { AppState } from 'react-native';
import { api, getAuthMode, getBaseUrl, getSession } from './api';
import * as tel from './telemetry';
import { normMessage } from './telemetryCore';
import { APP_VERSION } from './update';

type Ev = {
  n: string;
  t: number;
  p: Record<string, string | number | boolean>;
};
const queue: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let profile: string | null = null;
let enabledFlag = true;
// The profile's own choice on the server: null = not read yet (hold), true /
// false once known. Read again for every profile entered.
let profileAllows: boolean | null = null;
let errors = 0;
const sid = Math.random().toString(16).slice(2, 10);
const FLUSH_MS = 20000;
const MAX_BATCH = 25;
const MAX_QUEUE = 100; // held while the remote is busy; the oldest go first
const QUIET_RETRY_MS = 1500;

const forget = () => {
  queue.length = 0;
  tel.clear();
};

export const setUsageProfile = (id: string | null) => {
  if (profile && profile !== id) flush(true);
  profile = id;
  profileAllows = null;
  if (!id) return;
  // the person's own switch (the site writes it; this TV only reads it)
  api
    .profiles()
    .then(list => {
      if (profile !== id) return;
      const p = list.find(x => x.id === id);
      profileAllows = !(p && p.prefs && p.prefs.usageStats === false);
      if (!profileAllows) forget();
    })
    .catch(() => {
      // not known: nothing is sent on a guess; the next profile entry asks again
    });
};
export const setUsageEnabled = (on: boolean) => {
  enabledFlag = on;
  if (!on) forget();
};
/** Is this profile, on this box, sending usage stats? (null: not known yet) */
export const usageAllowed = (): boolean | null =>
  !enabledFlag ? false : profileAllows;

// What this box is, for the error reports: the model and Android level it
// already knows (perfTier.ts — required lazily, it imports this file).
type Facts = { model: string; os: string; flags: string[] };
let facts: Facts | null = null;
const deviceFacts = (): Facts => {
  if (facts) return facts;
  const f: Facts = { model: '', os: 'android', flags: [] };
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
  if (!enabledFlag || profileAllows === false) return forget();
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
      ...(session ? { 'X-Session': session } : {}),
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
      flags: who.flags,
      events,
      ...(extra ? { tel: extra } : {}),
    }),
  })
    .then(res => {
      // the server read the profile's switch and it says no
      if (res.headers.get('X-Usage') === 'off' && profile === forProfile) {
        profileAllows = false;
        forget();
      }
    })
    .catch(() => tel.giveBack(extra));
};
const arm = () => {
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
};
tel.wire({ poke: arm, version: APP_VERSION });

// track('feat', {f: 'party_start'}) — props are short strings, numbers, booleans.
export const track = (
  name: string,
  props: Record<string, string | number | boolean> = {},
) => {
  // What the richer half learns from events the app already sends — so these
  // need no call site of their own: which screen is on show, a play's first
  // frame, a memory warning.
  if (name === 'route' && typeof props.r === 'string') tel.setScreen(props.r);
  else if (name === 'play' && typeof props.ms === 'number') {
    tel.playFirstFrame(props.ms, {
      torrent: props.kind === 'stream',
      transcode: props.path !== 'direct',
    });
  } else if (name === 'perf' && props.screen === 'trim')
    tel.memoryTrim(Number(props.level) || 0);
  if (!enabledFlag || !profile || profileAllows === false) return;
  queue.push({ n: name, t: Date.now(), p: props });
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
  track('error', { m: normMessage(msg).slice(0, 120) }); // reduced before it leaves: no address, id or quoted phrase
};

AppState.addEventListener('change', s => {
  if (s !== 'active') flush(true);
});

// How much this box can take.
//
// Android TV hardware runs from a current Google TV Streamer down to boxes
// with a 2016 chip and 1.5 GB of memory. The app is the same on all of them;
// what differs is decided here, in two separate tiers:
//
// LITE — the visible luxuries stand down. One thing in the app is a luxury
// that a weak box pays for in smoothness everywhere else: trailers on Home's
// billboard (a second video decoder running under the UI). On a lite box there are none —
// the still backdrop is the same picture, just not moving — and everything a
// viewer actually does (browse, focus, play) keeps its full quality. (The nav
// rail's moving aurora used to be the second; it is a still hue now.) Lite is
// decided as it always was:
//   1. up front, by age: Android 9 (API 28) and older are the generation of
//      boxes this was measured slow on;
//   2. by measurement, once Home has settled: 150 frames are timed, and if
//      the slowest tenth of them took longer than 40 ms (under 25 fps) the
//      box is struggling as it is, and the luxuries go for this session.
//
// LOW-RAM — economies NOBODY CAN SEE: the same pictures, drawn the same, with
// less held in memory while doing it (ExoPlayer buffers by memory rather
// than by time and keeps a shorter back buffer; the decoded-picture caches
// are emptied on the way into the player). A box is low-RAM when
//   - Android says so (ActivityManager.isLowRamDevice), or
//   - it has under 2.5 GB in all, or
//   - an app may use 192 MB of Java heap or less (memoryClass), or
//   - Home, once settled, draws its frames with a p90 over 33 ms — measured
//     by the frame monitor (JankStats, DeviceModule.kt), which times the WHOLE
//     frame, GPU included on Android 12+, where the old requestAnimationFrame
//     timing saw only the JS thread and missed binder and GPU stalls;
//   - or the system has told the app memory is running critically low.
//
// The frame monitor also reports, a few times a session, each screen's
// p50 / p90 / jank% to the server's usage stats (`perf` events), so how the
// boxes in the field are coping can be read off the admin page's log.
//
// Nothing is stored: a box is judged fresh every launch, so an update that
// makes it faster is noticed.
import {AppState, NativeEventEmitter, NativeModules, Platform} from 'react-native';
import {track} from './usage';

export type DeviceInfo = {
  isLowRamDevice: boolean;
  totalMem: number; // bytes
  memoryClass: number; // MB
  largeMemoryClass: number;
  sdkInt: number;
  model: string;
  manufacturer: string;
};
export type FrameStats = {frames: number; p50: number; p90: number; jank: number};
type DeviceNative = Partial<DeviceInfo> & {
  getConstants?: () => DeviceInfo;
  glRenderer: () => Promise<string>;
  clearMemoryCaches: () => void;
  dropWindowBackground: () => void;
  restoreWindowBackground: () => void;
  setFrameScreen: (name: string) => void;
  takeFrameStats: () => Promise<Record<string, FrameStats>>;
};
const native = NativeModules.AuroraDevice as DeviceNative | undefined;

const readDevice = (): DeviceInfo | null => {
  if (!native) return null;
  try {
    const c = (native.getConstants ? native.getConstants() : native) as DeviceInfo;
    return typeof c?.totalMem === 'number' ? c : null;
  } catch {
    return null;
  }
};
const device = readDevice();
export const deviceInfo = () => device;

const GB = 1024 * 1024 * 1024;
// The thresholds, named for the report.
export const LOW_RAM_TOTAL_BYTES = 2.5 * GB;
export const LOW_RAM_MEMORY_CLASS_MB = 192;
export const LOW_RAM_FRAME_P90_MS = 33;

let lite = typeof Platform.Version === 'number' && Platform.Version <= 28;
let measuring = false;
let lowRamWhy: string | null = device
  ? device.isLowRamDevice
    ? 'android'
    : device.totalMem > 0 && device.totalMem < LOW_RAM_TOTAL_BYTES
    ? 'mem'
    : device.memoryClass > 0 && device.memoryClass <= LOW_RAM_MEMORY_CLASS_MB
    ? 'heap'
    : null
  : null;

export const isLite = () => lite;
/** Invisible memory economies (see the header). */
export const isLowRam = () => lowRamWhy !== null;
export const lowRamReason = () => lowRamWhy;
const markLowRam = (why: string) => {
  if (!lowRamWhy) lowRamWhy = why;
};

/** Time ~150 frames once (a few seconds); mark the session lite if they are slow. */
export function measureOnce() {
  // (lite, as before; and Home's frames through the frame monitor for low-RAM)
  measureHome();
  if (measuring || lite) return;
  measuring = true;
  const deltas: number[] = [];
  let last = 0;
  const tick = (t: number) => {
    if (last) deltas.push(t - last);
    last = t;
    if (deltas.length < 150) {
      requestAnimationFrame(tick);
      return;
    }
    const sorted = deltas.slice().sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
    if (p90 > 40) lite = true;
  };
  requestAnimationFrame(tick);
}

// ---- the decoded-picture caches ---------------------------------------------

/** Empty Fresco's memory caches (pictures a view is drawing are kept). */
export const clearImageMemory = () => {
  try {
    native?.clearMemoryCaches();
  } catch {}
};

// The window's own background (android:windowBackground): a full-screen fill
// under the app's opaque ambient canvas, once that canvas is on screen.
export const dropWindowBackground = () => {
  try {
    native?.dropWindowBackground();
  } catch {}
};
export const restoreWindowBackground = () => {
  try {
    native?.restoreWindowBackground();
  } catch {}
};

// ---- the frame monitor --------------------------------------------------------

const PERF_EVERY_MS = 120000; // one look at the counts every two minutes
const PERF_EVENTS_MAX = 6; // and a few events a session, no more
const MIN_FRAMES = 30; // a screen that drew fewer says nothing useful
let perfSent = 0;
let perfTimer: ReturnType<typeof setInterval> | null = null;
let homeWatch: ReturnType<typeof setTimeout> | null = null;
let homeJudged = false;
// Counts gathered by checks (Home's judgement) and not yet reported.
const pending: Record<string, FrameStats> = {};

const merge = (into: Record<string, FrameStats>, add: Record<string, FrameStats>) => {
  for (const [k, s] of Object.entries(add || {})) {
    const o = into[k];
    // (p50/p90 of the merged window: the larger sample's, a fair approximation
    // for a report that is read as a trend)
    into[k] = !o ? {...s} : s.frames > o.frames ? {...s, frames: s.frames + o.frames} : {...o, frames: s.frames + o.frames};
  }
};

const take = async (): Promise<Record<string, FrameStats>> => {
  if (!native) return {};
  try {
    const s = await native.takeFrameStats();
    merge(pending, s);
  } catch {}
  return pending;
};

const report = async () => {
  if (perfSent >= PERF_EVENTS_MAX) return;
  const all = await take();
  for (const [screen, s] of Object.entries(all)) {
    delete all[screen];
    if (s.frames < MIN_FRAMES || perfSent >= PERF_EVENTS_MAX) continue;
    perfSent++;
    track('perf', {screen, p50: s.p50, p90: s.p90, jank: s.jank, frames: s.frames, low: isLowRam(), lite});
  }
};

let started = false;
/** Tag the frames drawn from now on with the screen on show (navigation.tsx). */
export function frameScreen(name: string) {
  if (!native) return;
  try {
    native.setFrameScreen(name);
  } catch {}
  if (started) return;
  started = true;
  // once a session: what the box is (the low-RAM inputs and the GPU's name)
  const sendDevice = (gpu: string) => {
    if (!device) return;
    track('perf', {
      screen: 'device',
      mem_mb: Math.round(device.totalMem / 1048576),
      heap_mb: device.memoryClass,
      lowram: device.isLowRamDevice,
      sdk: device.sdkInt,
      model: String(device.model || '').slice(0, 40),
      gpu: String(gpu || '').slice(0, 60),
      low: lowRamWhy || 'no',
    });
  };
  native.glRenderer().then(sendDevice, () => sendDevice(''));
  perfTimer = setInterval(report, PERF_EVERY_MS);
  AppState.addEventListener('change', s => {
    if (s !== 'active') report();
  });
}

// Home has settled: watch its frames for a while (a hero rotation, the first
// moves), then judge. Up to ~25 s, stopping as soon as there is enough.
function measureHome() {
  if (!native || homeJudged || homeWatch) return;
  // what was drawn while Home was still building is not "settled"
  take().then(all => {
    delete all.home;
  });
  let waited = 0;
  const look = async () => {
    homeWatch = null;
    waited += 5000;
    const all = await take();
    const h = all.home;
    if (h && h.frames >= 90) {
      homeJudged = true;
      if (h.p90 > LOW_RAM_FRAME_P90_MS) markLowRam('frames');
      return;
    }
    if (waited >= 25000) {
      homeJudged = true;
      if (h && h.frames >= MIN_FRAMES && h.p90 > LOW_RAM_FRAME_P90_MS) markLowRam('frames');
      return;
    }
    homeWatch = setTimeout(look, 5000);
  };
  homeWatch = setTimeout(look, 5000);
}

// The system's own word on memory (ComponentCallbacks2 levels).
const TRIM_RUNNING_CRITICAL = 15;
const TRIM_UI_HIDDEN = 20;
if (native) {
  try {
    new NativeEventEmitter(NativeModules.AuroraDevice).addListener('AuroraTrimMemory', (e: {level?: number}) => {
      const level = Number(e?.level) || 0;
      // running critically low while ON screen: switch to the economies for the
      // rest of the session (the UI_HIDDEN and background levels are handled
      // natively: Fresco's caches are emptied, MainApplication.kt)
      if (level >= TRIM_RUNNING_CRITICAL && level < TRIM_UI_HIDDEN && !lowRamWhy) {
        markLowRam('trim');
        track('perf', {screen: 'trim', level});
      }
    });
  } catch {}
}

export const _perfInternals = {
  stop: () => {
    if (perfTimer) clearInterval(perfTimer);
    if (homeWatch) clearTimeout(homeWatch);
  },
};

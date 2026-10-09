// QA hooks (tools/tv-pixel-diff/PROTOCOL.md). Inert unless the com.auroratv.QA
// broadcast turned something on: every check here is a boolean read, and the
// native module is only called while tracing/focus-logging is on.
//
//   freeze   hero rotation skipped, trailers never start, the Skeleton /
//            MiniSpinner / RailHues loops hold at phase 0.37
//   trace    [anim] lines for the JS Focusable's two Animated.Values (a JS
//            round-trip per frame — never on during perf runs)
//   focuslog [focus] / [ring] lines on every focus change and ring claim
//   nav      the harness steers the app to a known route (navigation.tsx)
import {Animated, DeviceEventEmitter, NativeModules} from 'react-native';

type QaConstants = {frozen?: boolean; trailer?: boolean; trace?: boolean; focuslog?: boolean};
type QaNative = {
  getConstants?: () => QaConstants;
  trace: (id: string, value: number) => void;
  focus: (gain: boolean, reactTag: number, impl: string, edgeLeft: boolean, edgeRight: boolean) => void;
  ring: (what: string, reactTag: number) => void;
  navDone: (rid: string, route: string) => void;
} & Partial<QaConstants>;

const native = NativeModules.AuroraQA as QaNative | undefined;

const state = {frozen: false, trailer: false, trace: false, focuslog: false};
try {
  const c = native ? (native.getConstants ? native.getConstants() : (native as QaConstants)) : null;
  if (c) {
    state.frozen = c.frozen === true;
    state.trailer = c.trailer === true;
    state.trace = c.trace === true;
    state.focuslog = c.focuslog === true;
  }
} catch {}

const listeners = new Set<() => void>();
const changed = () => listeners.forEach(fn => fn());
try {
  DeviceEventEmitter.addListener('AuroraQa', (e: {frozen?: boolean; trailer?: boolean}) => {
    state.frozen = !!e?.frozen;
    state.trailer = !!e?.trailer;
    changed();
  });
  DeviceEventEmitter.addListener('AuroraQaTrace', (e: {trace?: boolean; focuslog?: boolean}) => {
    state.trace = !!e?.trace;
    state.focuslog = !!e?.focuslog;
    changed();
  });
} catch {}

/** `freeze on`: timers that change the picture stand still. */
export const isFrozen = () => state.frozen;
/** `freeze on,trailer`: frozen, but a trailer may still start. */
export const trailerAllowed = () => !state.frozen || state.trailer;
export const isTracing = () => state.trace;
export const isFocusLogging = () => state.focuslog;
/** Subscribe to any QA flag change; returns the unsubscribe. */
export const onQaChange = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The phase a frozen loop holds at (02-verification.md §2: mid-way, so a
 *  gradient is visible but still). */
export const FROZEN_PHASE = 0.37;

/** Start an Animated.loop, or hold its value at FROZEN_PHASE while frozen.
 *  Returns the stop function either way. */
export function runLoop(value: Animated.Value, loop: Animated.CompositeAnimation): () => void {
  if (state.frozen) {
    value.setValue(FROZEN_PHASE);
    return () => {};
  }
  loop.start();
  return () => loop.stop();
}

// ---- trace / focus log (JS implementation side) ------------------------------

/** `[anim] <t> <id> <value>` for a native-driven Animated.Value, while tracing. */
export function traceValue(id: string | (() => string), v: Animated.Value): () => void {
  if (!state.trace || !native) return () => {};
  const sub = v.addListener(({value}) => {
    try {
      native.trace(typeof id === 'function' ? id() : id, value);
    } catch {}
  });
  return () => v.removeListener(sub);
}

export function logFocus(gain: boolean, reactTag: number | null, edgeLeft: boolean, edgeRight: boolean) {
  if (!state.focuslog || !native) return;
  try {
    native.focus(gain, reactTag ?? 0, 'js', edgeLeft, edgeRight);
  } catch {}
}

export function logRing(what: 'claim' | 'release', reactTag: number | null) {
  if (!state.focuslog || !native) return;
  try {
    native.ring(what, reactTag ?? 0);
  } catch {}
}

/** navigation.tsx answers a `nav` command with this. */
export function navDone(rid: string, route: string) {
  try {
    native?.navDone(rid, route);
  } catch {}
}

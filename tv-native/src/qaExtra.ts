// QA trace helpers beside qa.ts (tools/tv-pixel-diff/PROTOCOL.md §4), for values
// qa.ts's `traceValue` cannot name: something DERIVED from a native-driven
// Animated.Value (an interpolation has no listener of its own to attach to).
// Inert unless tracing is on, like everything in qa.ts.
import {useEffect} from 'react';
import {Animated, NativeModules} from 'react-native';
import {isTracing, onQaChange} from './qa';

type QaNative = {trace: (id: string, value: number) => void};
const native = NativeModules.AuroraQA as QaNative | undefined;

/** `[anim] <t> <id> <fn(value)>` on every step of `v`, while tracing. Returns the detach. */
export function traceDerived(id: string, v: Animated.Value, fn: (value: number) => number): () => void {
  if (!isTracing() || !native) return () => {};
  const sub = v.addListener(({value}) => {
    try {
      native.trace(id, fn(value));
    } catch {}
  });
  return () => v.removeListener(sub);
}

/** Attach trace listeners while the receiver has tracing on, re-attaching when the QA
 *  flags change. `attach` returns the detach functions; it is only called while tracing. */
export function useTraces(attach: () => Array<() => void>, deps: ReadonlyArray<unknown>) {
  useEffect(() => {
    let offs: Array<() => void> = [];
    const sync = () => {
      offs.forEach(off => off());
      offs = isTracing() ? attach() : [];
    };
    sync();
    const un = onQaChange(sync);
    return () => {
      un();
      offs.forEach(off => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

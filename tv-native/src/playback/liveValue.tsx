// A value that changes many times a second (the scrub marker while a hold
// glides) without re-rendering the whole player: only the few small parts
// that draw it subscribe (<Live>), and the 6000-line Player renders as before.
import React, {ReactNode, useSyncExternalStore} from 'react';

export type LiveValue<T> = {
  get: () => T;
  set: (v: T) => void;
  subscribe: (fn: () => void) => () => void;
};

export function liveValue<T>(init: T): LiveValue<T> {
  let v = init;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set: next => {
      if (Object.is(next, v)) return;
      v = next;
      for (const fn of subs) fn();
    },
    subscribe: fn => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export function useLive<T>(lv: LiveValue<T>): T {
  return useSyncExternalStore(lv.subscribe, lv.get, lv.get);
}

/** Renders `children(value)` again whenever the value changes — and only that. */
export function Live<T>({value, children}: {value: LiveValue<T>; children: (v: T) => ReactNode}) {
  const v = useLive(value);
  return <>{children(v)}</>;
}

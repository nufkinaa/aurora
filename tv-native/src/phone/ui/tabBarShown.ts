// Whether the floating tab bar is out (ui/TabBar.tsx): it slides away while a page
// is scrolled DOWN and comes back the moment it is scrolled up, near the top, or a
// new page opens — so it never sits on what is being read (2026-10-29 screen pass:
// in landscape it covered a title page's actions). The rule is pure and tested.
import {useSyncExternalStore} from 'react';

/** Scrolled down past this, a downward scroll hides the bar. */
export const HIDE_AFTER = 120;
/** A scroll step smaller than this (dp) changes nothing (a finger resting). */
export const STEP = 8;

/** The next state from the previous offset and the new one. */
export const nextShown = (shown: boolean, prevY: number, y: number): boolean => {
  if (y <= HIDE_AFTER / 2) return true;
  const dy = y - prevY;
  if (dy > STEP && y > HIDE_AFTER) return false;
  if (dy < -STEP) return true;
  return shown;
};

let shown = true;
const subs = new Set<() => void>();
export const setTabBarShown = (v: boolean) => {
  if (v === shown) return;
  shown = v;
  subs.forEach(f => f());
};
export const useTabBarShown = () =>
  useSyncExternalStore(
    f => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => shown,
  );

/** A page's scroll, reported (useSolidBar, Detail): remembers the last offset per caller. */
export const scrollReporter = () => {
  let prev = 0;
  return (y: number) => {
    setTabBarShown(nextShown(shown, prev, y));
    prev = y;
  };
};

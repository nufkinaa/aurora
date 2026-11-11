// Aurora Play — how the kit moves. One place for the three rules:
//
//   1. Only transform and opacity, on the native driver, never an interaction
//      (so a moving star never holds up a list's rendering or a key press).
//   2. Calm: with the system's "remove animations" on, or on a box the app
//      has marked as weak (perfTier's lite tier), nothing moves — every piece
//      of the kit then shows its finished state at once.
//   3. Nothing outlives its screen: timers are cleared on unmount, loops are
//      stopped when the screen is not the one in front.
import {useEffect, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, Easing} from 'react-native';
import {isLite} from '../perfTier';

// The site's --ease (motion.ts has the same one for the screens).
export const EASE = Easing.bezier(0.2, 0.7, 0.2, 1);
// --play-spring: arrives a little past its place and settles (a pop).
export const SPRING = Easing.bezier(0.34, 1.56, 0.64, 1);
// For something that leaves: slow to start, then gone.
export const EASE_IN = Easing.bezier(0.5, 0, 0.9, 0.4);
export const LINEAR = Easing.linear;

export const tween = (
  value: Animated.Value,
  toValue: number,
  duration: number,
  {easing = EASE, delay = 0}: {easing?: (t: number) => number; delay?: number} = {},
) => Animated.timing(value, {toValue, duration, delay, easing, useNativeDriver: true, isInteraction: false});

// True when nothing should move. Read once per screen and handed down: the
// answer can arrive a moment after the first paint (the system is asked), and
// a screen that started moving simply stops starting new moves.
export const useCalm = (): boolean => {
  const [calm, setCalm] = useState(() => isLite());
  useEffect(() => {
    let live = true;
    try {
      AccessibilityInfo.isReduceMotionEnabled()
        .then(on => {
          if (live && on) setCalm(true);
        })
        .catch(() => {});
    } catch {}
    return () => {
      live = false;
    };
  }, []);
  return calm;
};

// Timers that die with the component. `after` returns a cancel.
export const useTimers = () => {
  const ids = useRef(new Set<ReturnType<typeof setTimeout>>());
  const api = useRef({
    after: (ms: number, fn: () => void) => {
      const id = setTimeout(() => {
        ids.current.delete(id);
        fn();
      }, ms);
      ids.current.add(id);
      return () => {
        clearTimeout(id);
        ids.current.delete(id);
      };
    },
    clear: () => {
      for (const id of ids.current) clearTimeout(id);
      ids.current.clear();
    },
  });
  useEffect(() => {
    const t = api.current;
    return () => t.clear();
  }, []);
  return api.current;
};

// Whether this screen is the one in front (false while another screen covers
// it). A stack screen stays mounted under the next one, and a native-driven
// loop would keep running there, unseen.
type Nav = {isFocused?: () => boolean; addListener?: (e: 'focus' | 'blur', fn: () => void) => () => void};
export const useInFront = (navigation: Nav | null | undefined): boolean => {
  const [front, setFront] = useState(() => (navigation?.isFocused ? navigation.isFocused() !== false : true));
  useEffect(() => {
    if (!navigation?.addListener) return;
    const a = navigation.addListener('focus', () => setFront(true));
    const b = navigation.addListener('blur', () => setFront(false));
    return () => {
      a?.();
      b?.();
    };
  }, [navigation]);
  return front;
};

// A value that is created once and lives as long as the component.
export const useValue = (initial: number) => {
  const ref = useRef<Animated.Value | null>(null);
  if (!ref.current) ref.current = new Animated.Value(initial);
  return ref.current;
};

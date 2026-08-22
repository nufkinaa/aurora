// Movement that keeps its own pace however fast the remote is pressed.
//
// THE INPUT SETS THE TARGET. THE ANIMATION OWNS THE PACE.
//
// This is the Apple TV behaviour: hammer the D-pad and the picture never jumps,
// never stutters and never plays back a backlog — it simply travels faster and
// glides to rest wherever you stopped. A press does not start an animation; it
// moves the target of the one already running.
//
// Three properties. All three have to hold or the illusion breaks:
//
//   1. NATIVE. The value is driven on the UI thread, so JS work — a render, a
//      fetch, a list mounting cells — can never stall movement already on
//      screen.
//
//   2. RETARGET, NEVER RESTART. `Animated.spring` on a value that is already
//      springing reads the running animation's position AND velocity
//      (SpringAnimation.js: `previousAnimation.getInternalState()`), so firing
//      one 20x a second keeps bending a single journey toward a moving target.
//      `Animated.timing` resets velocity on every call, which is why holding a
//      direction with timing reads as a stutter — and Android's animated
//      *scroll* is worse still: it reuses one ValueAnimator and restarts it from
//      the PREVIOUS target, so rapid presses teleport (see Row.tsx's header).
//
//   3. NOTHING THAT CHANGES WHAT IS MOUNTED SITS ON THE INPUT PATH. Mount churn
//      is React work, and React work done in front of the next keypress is the
//      latency you feel as "heavy". Put it in `defer` so the next press
//      interrupts it instead of queueing behind it.
import {useCallback, useEffect, useMemo, useRef, startTransition} from 'react';
import {Animated, Easing} from 'react-native';

// Critically damped, and deliberately NOT theme.focus.spring: that one is tuned
// for a 6dp scale on a poster, where a little overshoot reads as life. The same
// overshoot on a 250dp translation is a shelf that visibly bounces past its
// resting place on every press. Speed 12 settles inside a held-key repeat.
export const SLIDE_SPRING = {speed: 12, bounciness: 0};

/** A retargetable translation. `to()` may be called at input rate — every call
 *  moves the target of the running spring rather than starting a new one. */
export function useSlide() {
  const value = useRef(new Animated.Value(0)).current;
  const to = useCallback(
    (offset: number) => {
      Animated.spring(value, {
        toValue: offset,
        ...SLIDE_SPRING,
        useNativeDriver: true,
        // Every Animated animation otherwise opens an InteractionManager handle
        // on start and clears it on finish, batched through the JS event loop.
        // At ~20 presses/second that bookkeeping queues in front of the next
        // keypress, and nothing here waits on interactions being idle.
        isInteraction: false,
      }).start();
    },
    [value],
  );
  // ONE stable object. A fresh {value, to} literal per render gave every caller
  // a new identity, which cascaded: Home's toRow → renderRow → every Row's
  // onItemFocus → Row's focusCard → every Card's onFocus — so React.memo(Card)
  // bailed on all ~90 cards each time Home re-rendered (hero rotation ticks
  // every 9s), which is exactly the re-render storm Card/Row were built to
  // avoid.
  return useMemo(() => ({value, to}), [value, to]);
}

/** State that changes what is MOUNTED, moved off the input path. React may
 *  interrupt it for the next keypress instead of finishing it first. */
export const defer = (fn: () => void) => startTransition(fn);

// The site's --ease, cubic-bezier(0.2,0.7,0.2,1).
export const EASE = Easing.bezier(0.2, 0.7, 0.2, 1);

/** `.screen`'s entry (base.css:103-109): opacity 0→1 and translateY 10→0 over
 *  --t-med. The 10px is a motion offset, so RULE B ports it at x1.0 — six spec
 *  sections say 5 and the policy says 10.
 *
 *  Apply to the PAGE, not the screen root: the nav rail is outside `.screen` on
 *  the site and must not slide with it. */
export function useScreenIn() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, {
      toValue: 1,
      duration: 280,
      easing: EASE,
      useNativeDriver: true,
      isInteraction: false,
    }).start();
  }, [v]);
  return {
    opacity: v,
    transform: [{translateY: v.interpolate({inputRange: [0, 1], outputRange: [10, 0]})}],
  };
}

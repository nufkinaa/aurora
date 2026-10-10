// Who holds focus, and who hears the remote. Both are process-wide facts on this
// platform, so they are answered in one place and no screen re-solves them.
//
// Three problems, each of which cost a debugging round before this file existed:
//
//   1. A LIST THAT REMOUNTS DROPS FOCUS AND NOTHING RECLAIMS IT. Change Browse's
//      filter and every cell unmounts, including the focused one. Android hands
//      that focus nowhere, so the screen ends up with nothing lit and the remote
//      is dead until you happen to press a direction that finds something.
//      `noteFocusLost` + `useFocusFallback` close it.
//
//   2. `useTVEventHandler` IS GLOBAL. Every mounted handler hears every key —
//      including handlers on screens buried in the navigation stack, and
//      handlers under a modal that is supposed to have focus trapped. `useTVKeys`
//      gates both, so a component cannot forget.
//
//   3. THE LEFT EDGE. Which element holds focus decides whether LEFT belongs to
//      the page or to the nav rail. Every Focusable writes that on focus, true or
//      false, so the flag cannot go stale — the per-screen `atTop` refs this
//      replaces were written by only SOME elements, which is exactly how UP
//      started opening the nav from halfway down a page.
import React, {useCallback, useContext, useEffect, useRef, useState} from 'react';
import {useTVEventHandler} from 'react-native';
import {NavigationContext} from '@react-navigation/native';

// react-native-tvos attaches requestTVFocus to the host instance itself
// (View.js:38-57), so this is the shape of a Focusable's native node.
type FocusNode = {requestTVFocus?: () => void} | null;
type NodeRef = React.RefObject<FocusNode>;

// ---------------------------------------------------------------- who has focus

let held: FocusNode = null;
// Starts TRUE so a screen whose focus has not landed anywhere yet still yields
// LEFT to the rail — §6.4's contract is that the rail is reachable even from a
// screen with nothing focusable.
let heldEdgeLeft = true;
// The mirror image for the right edge: Browse's filter panel opens on RIGHT
// from the rightmost column, the way the rail opens on LEFT. Starts FALSE —
// a screen with no right-hand panel must never answer RIGHT with anything.
let heldEdgeRight = false;
// When focus last MOVED between elements. The rail's LEFT handler reads this to
// tell "a press made from the edge" apart from "the press that arrived at the
// edge" — see focusJustMoved.
let lastFocusMoveAt = 0;

export const noteFocus = (node: FocusNode, edgeLeft: boolean, edgeRight = false) => {
  if (node !== held) lastFocusMoveAt = Date.now();
  held = node;
  heldEdgeLeft = edgeLeft;
  heldEdgeRight = edgeRight;
};

/** Focus is on the leftmost element of its band, so LEFT has nowhere to go on
 *  the page and belongs to the nav rail. */
export const atLeftEdge = () => heldEdgeLeft;
/** Focus is on the rightmost element of its band (see heldEdgeRight). */
export const atRightEdge = () => heldEdgeRight;

/** True while a focus move is younger than `withinMs`.
 *
 *  THE RACE THIS EXISTS FOR: a D-pad press does two independent things — the
 *  native focus engine moves focus, and the same press is delivered to every
 *  useTVEventHandler in JS. Their order is not guaranteed. Press LEFT one card
 *  away from the edge and, when the focus event wins the race, the JS handler
 *  runs AFTER focus has already landed on the edge element: `atLeftEdge()` is
 *  true for the very press that put it there, and the rail opens on a press
 *  that was only meant to move one card. From the sofa that is "one press acted
 *  twice and threw me into the side panel".
 *
 *  A press that STARTS at the edge moves no focus, so nothing here is younger
 *  than the threshold and the rail opens normally. Holding LEFT walks focus to
 *  the edge and keeps repeating; the repeats stop moving focus once it is at
 *  the edge, the timestamp ages out, and the rail opens — which is what holding
 *  LEFT should do. */
export const focusJustMoved = (withinMs: number) =>
  Date.now() - lastFocusMoveAt < withinMs;

/** Snapshot who holds focus now and get back a function that returns it. The
 *  rail takes focus when it opens and has to hand it back on close; letting the
 *  platform decide instead sent focus to the topmost focusable on the page. */
export const captureFocus = () => {
  const node = held;
  return () => node?.requestTVFocus?.();
};

// ------------------------------------------------------- focus is never lost

const fallbacks: NodeRef[] = [];
let checking = false;

/** Called by a Focusable that is unmounting while it holds focus. */
export const noteFocusLost = (node: FocusNode) => {
  if (node !== held) return;
  held = null;
  if (checking) return;
  checking = true;
  // 120ms, not the next frame: the common case is that Android or a fresh cell's
  // `hasTVPreferredFocus` claims focus within a commit or two, and claiming
  // earlier would fight it. Nothing is focused during the wait, so the delay is
  // invisible — there is no highlight to lag.
  setTimeout(() => {
    checking = false;
    if (held) return; // someone took it; the guard was not needed
    for (let i = fallbacks.length - 1; i >= 0; i--) {
      const node2 = fallbacks[i].current;
      if (node2?.requestTVFocus) {
        node2.requestTVFocus();
        return;
      }
    }
  }, 120);
};

/** Register an element as this screen's last resort for focus. Innermost wins,
 *  so a modal's own fallback beats the page's. Point it at whatever the state's
 *  own action is — a Retry button, a Switch profile button, the first cell. */
export function useFocusFallback(ref: NodeRef) {
  useEffect(() => {
    fallbacks.push(ref);
    return () => {
      const i = fallbacks.indexOf(ref);
      if (i >= 0) fallbacks.splice(i, 1);
    };
  }, [ref]);
}

/** Claim focus for a list's first cell ONCE, on the first fill.
 *
 *  `ready` is what stops the claim being spent on an empty list while it loads —
 *  without it the claim is gone before there is a cell to give it to.
 *
 *  It deliberately does NOT re-claim when a filter changes. The shipped Browse
 *  did, keyed on its cache key, and both halves of that were wrong: the site
 *  leaves focus on the pill you just pressed, and on a REUSED cell the re-claim
 *  cannot work anyway — `hasTVPreferredFocus` is a mount-time prop and Focusable
 *  disarms it after first focus (react-native-tvos#670). What a closing filter
 *  UI owes you is its opener back, which is `useKeyTrap`'s job. Pass a constant
 *  key unless the list genuinely becomes a different list. */
export function useListClaim(key: string, ready: boolean) {
  const spent = useRef<string | null>(null);
  const claim = ready && spent.current !== key;
  useEffect(() => {
    if (ready) spent.current = key;
  }, [key, ready]);
  // Stable while the answer is: this is called from a list's renderItem, and
  // a new function per render made renderItem new per render — so every
  // state change on the screen (a page starting to load) re-rendered every
  // mounted cell of the list.
  return useCallback((index: number) => claim && index === 0, [claim]);
}

// --------------------------------------------------------- who hears the remote

// Whether the nav rail's panel is open. The rail is NOT a useKeyTrap — a JS
// trap would deafen the rail's own handler and double up its focus restore —
// but the per-screen key handlers (the grid up-escapes) still must not steal
// keys while it is up: its focus containment is native-only (TVFocusGuideView
// traps), which JS handlers cannot see.
let railOpenCount = 0;
// Who wants to hear the rail open and close. Home's hero trailer is the first
// listener: it used to check `railOpen()` only before STARTING, so a trailer
// already running kept playing behind the open rail (Mi TV, 2026-10-09).
const railOpenFns = new Set<() => void>();
const railCloseFns = new Set<() => void>();
export const noteRail = (open: boolean) => {
  const was = railOpenCount > 0;
  railOpenCount += open ? 1 : -1;
  if (railOpenCount < 0) railOpenCount = 0;
  const now = railOpenCount > 0;
  if (now !== was) (now ? railOpenFns : railCloseFns).forEach(fn => fn());
};
export const railOpen = () => railOpenCount > 0;
/** Called whenever the nav rail's panel opens. Returns the unsubscribe. */
export const onRailOpen = (fn: () => void) => {
  railOpenFns.add(fn);
  return () => {
    railOpenFns.delete(fn);
  };
};
/** Called whenever the nav rail's panel closes (after it has handed focus
 *  back). Returns the unsubscribe. */
export const onRailClose = (fn: () => void) => {
  railCloseFns.add(fn);
  return () => {
    railCloseFns.delete(fn);
  };
};

// The live rail registers how to open itself, so a screen can summon it from a
// key the rail does not own — Home's hero takes LEFT for "previous slide"
// (2026-10-06), so UP from the hero's buttons opens the rail instead.
let railOpener: (() => void) | null = null;
export const setRailOpener = (fn: () => void) => {
  railOpener = fn;
};
// Clears only its OWN registration: two screens change places in one frame
// (the leaving one's cleanup, the arriving one's effect), and an unconditional
// null from the leaver could erase what the arriver had just registered.
export const clearRailOpener = (fn: () => void) => {
  if (railOpener === fn) railOpener = null;
};
export const requestRailOpen = () => {
  if (railOpenCount > 0 || !railOpener) return false;
  railOpener();
  return true;
};

let traps = 0;

/** A focus trap, both halves of it — §5.8(a), which is the site's own
 *  `pushScope`/`popScope` (`public/js/focus.js:15-19`).
 *
 *  While it is up, every key handler OUTSIDE it goes deaf: a modal's scope owns
 *  everything and the nav rail is unreachable by design. When it closes, focus
 *  returns to the control that OPENED it. That second half is not a nicety —
 *  measured on the Streamer, closing Browse's genre picker without it left
 *  Android to pick, and Android picked "Surprise me" in the opposite corner of
 *  the screen. */
export function useKeyTrap(active: boolean) {
  useEffect(() => {
    if (!active) return;
    traps++;
    // Captured on the way in, while the opener still holds focus: the trap's own
    // content claims focus from a native event, which lands after this effect.
    const restore = captureFocus();
    return () => {
      traps--;
      restore();
    };
  }, [active]);
}

// One press, one event. react-native-tvos reports a D-pad press TWICE on
// Android — once when the key goes down (eventKeyAction 0) and once when it
// comes up (1) — and a handler that acts on both moves two steps for one
// press. Seen on a touchpad remote ("sometimes two clicks", elia,
// 2026-10-08): a swipe's down and up arrive far enough apart to read as two
// presses. The key-down is acted on (it is the one the native focus engine
// moves on, so the app and the system agree); the key-up is ignored when its
// key-down was seen a moment ago, and honoured only when it was not (an
// input path that reports only key-ups keeps working).
const lastDown = new Map<string, number>();
export function acceptTvEvent(evt: {eventType: string; eventKeyAction?: number | string}): boolean {
  const action = Number(evt.eventKeyAction);
  const now = Date.now();
  if (action === 0) {
    lastDown.set(evt.eventType, now);
    return true;
  }
  if (action === 1) {
    const down = lastDown.get(evt.eventType) || 0;
    return now - down > 1500;
  }
  return true;
}

/** A global key handler with the two gates every one of them needs: this screen
 *  must be the live one, and no trap may be up. `deaf` is for a component that
 *  knows its own reason to stop listening. */
export function useTVKeys(
  handler: (evt: {eventType: string}) => void,
  opts?: {deaf?: boolean},
) {
  const live = useIsLive();
  const deaf = !!opts?.deaf;
  const onTV = useCallback(
    (evt: {eventType: string; eventKeyAction?: number | string}) => {
      if (!live || deaf || traps > 0) return;
      if (!acceptTvEvent(evt)) return;
      handler(evt);
    },
    [live, deaf, handler],
  );
  useTVEventHandler(onTV);
  return live;
}

/** `useIsFocused` without the throw: screens outside the navigator (the profile
 *  gate, server setup) are always live. */
export function useIsLive() {
  const nav = useContext(NavigationContext);
  const [live, setLive] = useState(() => (nav ? nav.isFocused() : true));
  useEffect(() => {
    if (!nav) return;
    setLive(nav.isFocused());
    const on = nav.addListener('focus', () => setLive(true));
    const off = nav.addListener('blur', () => setLive(false));
    return () => {
      on();
      off();
    };
  }, [nav]);
  return live;
}

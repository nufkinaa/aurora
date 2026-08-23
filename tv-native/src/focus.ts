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
  return (index: number) => claim && index === 0;
}

// --------------------------------------------------------- who hears the remote

// Whether the nav rail's panel is open. The rail is NOT a useKeyTrap — a JS
// trap would deafen the rail's own handler and double up its focus restore —
// but the per-screen key handlers (the grid up-escapes) still must not steal
// keys while it is up: its focus containment is native-only (TVFocusGuideView
// traps), which JS handlers cannot see.
let railOpenCount = 0;
export const noteRail = (open: boolean) => {
  railOpenCount += open ? 1 : -1;
  if (railOpenCount < 0) railOpenCount = 0;
};
export const railOpen = () => railOpenCount > 0;

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
    (evt: {eventType: string}) => {
      if (!live || deaf || traps > 0) return;
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

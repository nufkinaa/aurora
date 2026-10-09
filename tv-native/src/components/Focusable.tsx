// The one focusable primitive every screen uses. On a 10-foot UI the focused
// element MUST be obvious, so focus adds a bright ring + slight scale (matching
// the web app's cue). Wraps Pressable so onPress works from the remote's OK.
//
// TWO IMPLEMENTATIONS, ONE SWITCH (docs/native-rewrite/00-plan.md P1). The
// default export reads `impl.focusable` once at startup and renders either
// today's JS body (`JsFocusable`, the reference — unchanged apart from the QA
// trace hooks) or the native Fabric component (`NativeFocusable` →
// AuroraFocusableView.kt), which answers the key in the same frame Android
// moved focus, with no JS on the path. Card / Btn / Chip / NavItem pass the
// same props to both and do not know which they got.
//
// Performance: focus/blur do NOT setState. The ring + scale live on an
// Animated.Value driven natively, so a D-pad move costs zero React renders —
// re-rendering two component subtrees per keypress (the old approach) is what
// made navigation feel laggy on TV hardware.
//
// Correctness: Android TV (Fabric + list recycling) occasionally drops blur
// events, which used to leave "ghost" rings behind — several highlighted
// elements at once. Every Focusable registers a clear() in a global registry and
// whoever GAINS focus clears the one that was lit, so at most one ring can exist
// no matter which blur events got lost (works across screens too).
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Animated,
  DeviceEventEmitter,
  Easing,
  NativeModules,
  Pressable,
  StyleSheet,
  ViewStyle,
  StyleProp,
  View,
  findNodeHandle,
} from 'react-native';
import {noteFocus, noteFocusLost} from '../focus';
import {impl} from '../impl';
import {isFocusLogging, isTracing, logFocus, logRing, onQaChange, traceValue} from '../qa';
import AuroraFocusable, {Commands, FocusChangeEvent} from '../specs/AuroraFocusableNativeComponent';
import theme from '../theme';

const {colors, radius, focus} = theme;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// The site's --ease, so a focus move here has the same character as one there.
const EASE = Easing.bezier(...(focus.ease as unknown as [number, number, number, number]));

// The site's focus system, read off its live stylesheets rather than guessed at:
//
//   --focus-ring       0 0 0 3px rgba(255,255,255,.95), 0 10px 24px rgba(0,0,0,.5)
//   --focus-ring-light 0 0 0 3px var(--bg), 0 0 0 7px var(--accent), 0 10px 24px …
//
// The DEFAULT ring is white. Violet is used by exactly one rule in the whole
// stylesheet — `.btn-primary:focus`, i.e. Play and Stream. This app had it
// backwards and painted everything violet.
//
// Both rings carry the same dark drop shadow, and that shadow is the "halo":
// it separates a focused element from whatever it sits on, which is what makes
// a white ring work on a white fill.
const LIGHT_GAP = 3;
const LIGHT_RING = focus.borderWidth + 1;
// The second half of --focus-ring: `0 10px 24px rgba(0,0,0,.5)`.
const TOKEN_SHADOW = '0 10px 24px rgba(0,0,0,0.5)';

// Ring colour, per the two tokens above.
export type FocusRing = 'white' | 'violet' | 'none';
const RING_COLOR: Record<FocusRing, string> = {
  white: colors.focusRing,
  violet: colors.accent,
  none: 'transparent',
};

let nextId = 1;
const ringRegistry = new Map<number, () => void>();
// Which ring is currently lit. Only ONE can be, because lighting a ring always
// clears this one first — so clearing just it is enough to keep the "never two
// rings at once" guarantee even when Android drops a blur event.
//
// This used to walk the whole registry and setValue(0) on every entry. Home
// holds ~90 Focusables (rows x cards + nav + hero), so a single D-pad press
// fired ~90 native calls before anything could be drawn. Measured on the
// Streamer: 112 of 267 frames flagged "high input latency" while jank was only
// 6% — the app wasn't dropping frames, it was answering the remote late, which
// is exactly what "feels heavy" means.
let litRing = 0;
// The native registry's half of the "one ring" rule in a mixed tree (01 §5.2):
// once a NATIVE ring has ever lit in this process, every JS claim tells native
// so its ring fades; and a native claim asks us (AuroraRingClear) to fade ours.
// With the switch flipped for the whole app neither side ever hears the other,
// so the JS reference run pays nothing for this.
let nativeEverLit = false;
try {
  DeviceEventEmitter.addListener('AuroraRingLit', () => {
    nativeEverLit = true;
  });
  DeviceEventEmitter.addListener('AuroraRingClear', () => {
    if (litRing) ringRegistry.get(litRing)?.();
    litRing = 0;
  });
} catch {}
const claimRing = (owner: number) => {
  if (litRing && litRing !== owner) ringRegistry.get(litRing)?.();
  litRing = owner;
  if (nativeEverLit) {
    try {
      NativeModules.AuroraImpl?.jsRingClaimed();
    } catch {}
  }
};
const releaseRing = (owner: number) => {
  if (litRing === owner) litRing = 0;
};

type Props = {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  // Background wash shown while focused (list rows, tiles). Replaces the old
  // focusedStyle prop — a color can be animated without re-rendering.
  highlightColor?: string;
  hasTVPreferredFocus?: boolean;
  round?: boolean; // pill vs rounded-rect focus ring
  // Which ring token this element uses. 'white' is --focus-ring and the default,
  // matching the site; 'violet' is --focus-ring-light and belongs ONLY to the
  // .btn-primary equivalents (Play / Stream / Play next); 'none' is for elements
  // that signal focus another way, like .pbtn (white fill) and .menu-item (a
  // background change).
  ring?: FocusRing;
  // Hold the ring off the element's edge with a background-coloured gap, exactly
  // like --focus-ring-light's first stop. Needed on any LIGHT fill, because a
  // white ring drawn straight onto white is invisible from the sofa.
  light?: boolean;
  // Opt out of the focus scale. Set this on anything that spans the width of the
  // screen — a source row, an episode row, a settings row.
  //
  // The scale is a ratio, so the growth is proportional to the element: a 150dp
  // poster gains 6dp, which lifts it nicely, but a 1500dp-wide row gains 60dp and
  // half of that lands on each side, dropping the row on top of whatever sits
  // beside it and running past its container. Those rows already read as focused
  // from the ring plus the background wash, so they lose nothing by staying put.
  noScale?: boolean;
  // Per-element focus scale, because the site's is not one number: .card is
  // 1.055, .profile-tile 1.07, .source-dl 1.03, and a full-width .episode or
  // .source-row only 1.01 — a big row barely moves, it doesn't stay still.
  scaleTo?: number;
  // Rise toward the viewer, in dp. The site's card focus is
  // `scale(1.055) translateY(-3px)`: the scale alone reads as "bigger", the lift
  // is what reads as "picked up". Rides the same spring as the scale.
  lift?: number;
  // Mirrors the site's aria-label on icon-only buttons, which otherwise announce
  // nothing at all to a screen reader.
  // Override the ring's drop shadow. The site does not use one value: a card
  // gets `0 14px 30px rgba(0,0,0,.55)` where a button gets the token's
  // `0 10px 24px rgba(0,0,0,.5)`. A focused poster lifting off the row is most of
  // the tvOS feel.
  shadow?: string;
  accessibilityLabel?: string;
  // Content that fades in with focus, drawn OVER the children. The site's
  // `.card:focus .card-shade` is the case this exists for.
  //
  // It is a prop rather than something the caller does with onFocusChange
  // because that would setState per keypress, in the one component there are
  // ninety of on screen — the exact re-render this file was rewritten to avoid.
  // Here the opacity rides the same natively-driven value as the ring.
  focusOverlay?: React.ReactNode;
  // Ring geometry, for the one element whose ring is not the --focus-ring token:
  // a `.card` takes 2dp at rgba(255,255,255,0.9) (tokens.css:65), not 3dp at 0.95.
  // The reserved border stays 3dp either way, so a 2dp ring simply sits inside it
  // and nothing reflows.
  ringWidth?: number;
  ringColor?: string;
  // Take this element out of the d-pad's reach without unmounting it. Exists
  // for the rail's slide-OUT: the panel keeps drawing for ~200ms after close,
  // and Android's focus search must not be able to wander back into a row
  // that is about to unmount (the stranded-focus bug that once made the rail
  // close instantly instead of animating).
  focusDisabled?: boolean;
  // Long-press OK. The Continue Watching ✕ is drawn but never focusable (P12), so
  // the removal gesture has nowhere else to live — P20, and the one change to
  // src/ the spec asks for. The ring registry is deliberately untouched: a long
  // press must not change what is lit.
  onLongPress?: () => void;
  // This element is the leftmost focusable of its band, so a LEFT press from it
  // has nowhere to go on the page and opens the nav rail instead. Written to
  // focus.ts on every focus, by every Focusable, so the flag cannot go stale.
  edgeLeft?: boolean;
  // LEFT from this element must not MOVE focus anywhere: nextFocusLeft points
  // at the element itself, so Android's focus search keeps focus where it is
  // and the nav rail's LEFT handler — which opens only on a press that moved
  // nothing (focusJustMoved) — gets the press. For an edge element whose page
  // geometry hands LEFT to something down-left of it: Detail's icon row sits a
  // few dp left of its Play button, so LEFT from Play dropped onto My List
  // instead of opening the rail (Mi Box report, 2026-10-09). Pair with edgeLeft.
  holdLeft?: boolean;
  // The mirror: rightmost focusable of its band, so RIGHT from it can open a
  // right-hand panel (Browse's filters). Same write-on-focus contract.
  edgeRight?: boolean;
  onFocusChange?: (focused: boolean) => void;
  // Exposed so callers can imperatively move focus here
  // (instance.requestTVFocus() — react-native-tvos attaches it to View refs).
  ref?: React.Ref<View>;
};

/** The switch (01-architecture.md §1.4). Read once at startup; never flips while mounted. */
export default function Focusable(props: Props) {
  return impl.focusable ? <NativeFocusable {...props} /> : <JsFocusable {...props} />;
}

// =============================================================================
// The JS reference implementation — today's body, untouched except for the QA
// trace / focus-log hooks (each a boolean read on the hot path).
// =============================================================================

function JsFocusable({
  children,
  onPress,
  style,
  highlightColor,
  hasTVPreferredFocus,
  round,
  light,
  noScale,
  scaleTo,
  lift,
  ring = 'white',
  shadow,
  accessibilityLabel,
  focusOverlay,
  ringWidth,
  ringColor,
  focusDisabled,
  onLongPress,
  edgeLeft,
  holdLeft,
  edgeRight,
  onFocusChange,
  ref,
}: Props) {
  const anim = useRef(new Animated.Value(0)).current;
  // The SCALE runs on its own spring while the ring's opacity stays on a timing
  // curve. A spring is what makes focus feel physical rather than mechanical —
  // it overshoots a hair and settles, which is the tvOS behaviour elia is asking
  // for; opacity springing with it would just look like a flicker.
  const springAnim = useRef(new Animated.Value(0)).current;
  const idRef = useRef(0);
  if (!idRef.current) idRef.current = nextId++;

  // Held as well as forwarded: focus.ts needs this element's native node to
  // give focus back to it later (requestTVFocus lives on the host instance).
  const node = useRef<{requestTVFocus?: () => void} | null>(null);
  // The LAST REAL node, never nulled. React detaches host refs in the mutation
  // phase — setRef(null) — and only THEN runs a deleted subtree's effect
  // cleanups, so by the time the cleanup below fires, node.current is already
  // null and `noteFocusLost(null)` bailed at its `node !== held` check. That
  // one ordering fact had the entire focus-recovery net (useFocusFallback, the
  // 120ms rescue) dead app-wide: a focused cell unmounting left the remote dead
  // exactly as described in focus.ts's own header.
  const lastNode = useRef<{requestTVFocus?: () => void} | null>(null);
  // This element's own native tag, for holdLeft's nextFocusLeft. Only an
  // element that asks for it pays the one extra render.
  const [selfTag, setSelfTag] = useState<number | null>(null);
  const setRef = useCallback(
    (n: never) => {
      node.current = n;
      if (n) lastNode.current = n;
      if (n && holdLeft) {
        const tag = findNodeHandle(n);
        if (tag != null) setSelfTag(prev => (prev === tag ? prev : tag));
      }
      if (typeof ref === 'function') ref(n);
      else if (ref) (ref as React.MutableRefObject<unknown>).current = n;
    },
    [ref, holdLeft],
  );

  useEffect(() => {
    const id = idRef.current;
    // ANIMATE out, don't jump. This runs on every focus move (whoever gains
    // focus clears whoever had it), and it used to setValue(0) — so the element
    // you just left lost its ring in a single frame while the new one faded in
    // over 160ms. That mismatch is the "snap": the highlight appeared to leap
    // rather than travel. A fade-out costs the same as the fade-in and is
    // idempotent, so it still cleans up a dropped blur event, just gracefully.
    ringRegistry.set(id, () => {
      Animated.timing(anim, {
        toValue: 0,
        duration: focus.duration,
        easing: EASE,
        useNativeDriver: true,
        isInteraction: false,
      }).start();
      Animated.spring(springAnim, {
        toValue: 0,
        ...focus.spring,
        useNativeDriver: true,
        isInteraction: false,
      }).start();
    });
    return () => {
      ringRegistry.delete(id);
      releaseRing(id); // list recycling can unmount the focused cell
      // ...and if it was the cell holding FOCUS, say so: Android hands that
      // focus nowhere and the screen is left with a dead remote. lastNode, not
      // node — React has already nulled node.current by now (see setRef).
      noteFocusLost(lastNode.current);
    };
  }, [anim, springAnim]);

  // QA trace (tools/tv-pixel-diff/PROTOCOL.md §4): `[anim]` lines for the two
  // values while the receiver has tracing on — a JS round-trip per frame, so
  // never on during a perf run. Nothing is attached otherwise.
  useEffect(() => {
    let off: (() => void)[] = [];
    const attach = () => {
      off.forEach(f => f());
      off = isTracing() ? [traceValue('focus.ring', anim), traceValue('focus.spring', springAnim)] : [];
    };
    attach();
    const un = onQaChange(attach);
    return () => {
      un();
      off.forEach(f => f());
    };
  }, [anim, springAnim]);

  // Fabric re-applies `hasTVPreferredFocus` to the native view at unpredictable
  // times (react-native-tvos#670), yanking focus back to this element long
  // after mount. So the prop is only forwarded briefly: once this element has
  // been focused (or a short grace window passes), it's dropped to `false`,
  // which the native setter ignores — the yank can never happen again.
  const [disarmed, setDisarmed] = useState(false);
  const wantsFocus = !!hasTVPreferredFocus && !disarmed;
  useEffect(() => {
    if (!wantsFocus) return;
    const t = setTimeout(() => setDisarmed(true), 600);
    return () => clearTimeout(t);
  }, [wantsFocus]);

  // The overlays must follow the element's actual corner rounding.
  const flat = StyleSheet.flatten([
    styles.base,
    round && {borderRadius: radius.pill},
    style,
  ]) as ViewStyle;
  const ringRadius = (flat.borderRadius as number) ?? radius.m;

  const scale = springAnim.interpolate({
    // Past 1 so the spring's overshoot has somewhere to go instead of clipping.
    inputRange: [0, 1, 2],
    outputRange: [1, scaleTo ?? focus.scale, (scaleTo ?? focus.scale) * 2 - 1],
  });
  // Same spring, same overshoot allowance, so the rise and the growth are one
  // movement rather than two.
  const translateY = lift
    ? springAnim.interpolate({inputRange: [0, 1, 2], outputRange: [0, -lift, -lift * 2]})
    : null;

  return (
    <AnimatedPressable
      ref={setRef as never}
      {...(focusDisabled ? ({focusable: false, isTVSelectable: false} as object) : null)}
      {...(holdLeft && selfTag != null ? ({nextFocusLeft: selfTag} as object) : null)}
      hasTVPreferredFocus={wantsFocus}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      onFocus={() => {
        claimRing(idRef.current);
        if (isFocusLogging()) {
          logRing('claim', findNodeHandle(node.current as never));
          logFocus(true, findNodeHandle(node.current as never), !!edgeLeft, !!edgeRight);
        }
        noteFocus(node.current, !!edgeLeft, !!edgeRight);
        // focus.duration (110ms) with a decelerating curve, up from a linear
        // 60ms. 60ms is below the threshold where the eye reads a transition at
        // all, so moving between rows looked like the highlight teleporting;
        // easing out over ~110ms reads as the highlight travelling. It is still
        // short enough not to strobe when a direction is held down.
        //
        // isInteraction:false matters more than it looks. By default every
        // Animated animation opens an InteractionManager handle on start and
        // clears it on finish, and InteractionManager batches that bookkeeping
        // through the JS event loop. Hold a direction on the remote and Android
        // repeats the key ~20x/second — two animations per move, so ~80 handle
        // operations a second, all queued in front of the next keypress. The
        // handles buy us nothing here: nothing in the app waits on interactions
        // being idle.
        Animated.timing(anim, {
          toValue: 1,
          duration: focus.duration,
          easing: EASE,
          useNativeDriver: true,
          isInteraction: false,
        }).start();
        Animated.spring(springAnim, {
          toValue: 1,
          ...focus.spring,
          useNativeDriver: true,
          isInteraction: false,
        }).start();
        // Only elements that actually carry hasTVPreferredFocus need the
        // disarm state flip — for everything else this would be a pointless
        // React re-render on the first focus of every element.
        if (hasTVPreferredFocus) setDisarmed(true);
        onFocusChange?.(true);
      }}
      onBlur={() => {
        releaseRing(idRef.current);
        if (isFocusLogging()) {
          logRing('release', findNodeHandle(node.current as never));
          logFocus(false, findNodeHandle(node.current as never), !!edgeLeft, !!edgeRight);
        }
        Animated.timing(anim, {
          toValue: 0,
          duration: focus.duration,
          easing: EASE,
          useNativeDriver: true,
          isInteraction: false,
        }).start();
        Animated.spring(springAnim, {
          toValue: 0,
          ...focus.spring,
          useNativeDriver: true,
          isInteraction: false,
        }).start();
        onFocusChange?.(false);
      }}
      // The scale is what makes focus feel like movement rather than a jump. It
      // was computed but never actually applied to a transform, so nothing on
      // any screen had grown on focus since the animation was introduced —
      // every element just swapped its ring on and off.
      //
      // `false` (rather than an identity scale) when opting out, so a wide row
      // gets no transform node at all instead of an animated one that does
      // nothing. See the noScale prop.
      style={[
        styles.base,
        round && {borderRadius: radius.pill},
        style,
        !noScale && {
          transform: translateY ? [{scale}, {translateY}] : [{scale}],
        },
      ]}>
      {highlightColor ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: highlightColor,
              borderRadius: ringRadius,
              opacity: anim,
            },
          ]}
        />
      ) : null}
      {children}
      {focusOverlay ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, {opacity: anim}]}>
          {focusOverlay}
        </Animated.View>
      ) : null}
      {light ? (
        <>
          {/* The gap. Sits between the light fill and the violet, so the two
              never touch. Radii grow with each layer to stay concentric. */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.lightGap,
              {borderRadius: ringRadius + LIGHT_GAP, opacity: anim},
            ]}
          />
          {/* The ring itself: the site's flat --focus-ring-light violet, and the
              thing that actually reads as focus.

              The site also drifts a bright head around this band
              (.btn-primary:focus::after, a conic-gradient masked to the ring).
              That is NOT ported. Three shapes were tried on the device — a baked
              conic disc clipped by nested Views, a stroked SVG rect, and an
              SVG dash animated along the path — and each one landed misaligned
              or on top of the button in a different way, because the ring lives
              outside the element's own box and RN has no mask to compose the two
              with. It is decoration on a cue that already works: the CSS itself
              says "the plain violet underneath is still the focus cue and
              nothing below has to change". This is that. */}
          <Animated.View
            pointerEvents="none"
              style={[
              styles.lightRing,
              {
                borderRadius: ringRadius + LIGHT_GAP + LIGHT_RING,
                opacity: anim,
                borderColor: RING_COLOR[ring === 'none' ? 'white' : ring],
              },
            ]}
          />
        </>
      ) : ring === 'none' ? null : (
        // renderToHardwareTextureAndroid: this view carries the focus ring's
        // BLURRED drop shadow, and animating opacity on a shadowed view makes
        // Android re-rasterise that blur on every frame of the fade. Promoting it
        // to a hardware layer rasterises it once and then composites the texture
        // with alpha, which is what the layer exists for. Measured on the
        // Streamer: median frame during D-pad navigation 20ms -> see below.
        <Animated.View
          pointerEvents="none"
          style={[
            styles.ring,
            {borderRadius: ringRadius, opacity: anim, borderColor: RING_COLOR[ring]},
            ringWidth != null ? {borderWidth: ringWidth} : null,
            ringColor ? {borderColor: ringColor} : null,
            shadow ? {boxShadow: shadow} : null,
          ]}
        />
      )}
    </AnimatedPressable>
  );
}

// =============================================================================
// The native implementation: the same props, mapped one to one onto
// AuroraFocusable (src/specs/AuroraFocusableNativeComponent.ts). Everything the
// JS body animates or decides on focus is done in AuroraFocusableView.kt; this
// wrapper only (a) flattens the style for the ring radius, as the JS does,
// (b) parses the shadow with the same grammar, (c) keeps focus.ts's facts fed
// from the one `onFocusChange` event, and (d) gives callers a ref with
// `requestTVFocus`, which is all focus.ts and the screens ever use.
// =============================================================================

type FocusNode = {requestTVFocus: () => void};

// `<offsetX> <offsetY> <blur> <color>` — the two shapes the app writes
// ('0 10px 24px rgba(0,0,0,0.5)', '0 18px 36px rgba(0,0,0,0.6)'), read the way
// RN's processBoxShadow reads them: lengths in dp (a trailing `px` allowed),
// the colour left to processColor via the ColorValue prop.
const parseShadow = (s: string) => {
  const parts = s.trim().split(/\s+/);
  const nums: number[] = [];
  const colorParts: string[] = [];
  for (const p of parts) {
    const n = /^-?\d*\.?\d+(px)?$/.test(p) ? parseFloat(p) : NaN;
    if (!Number.isNaN(n) && colorParts.length === 0) nums.push(n);
    else colorParts.push(p);
  }
  return {
    offsetX: nums[0] ?? 0,
    offsetY: nums[1] ?? 0,
    blur: nums[2] ?? 0,
    spread: nums[3] ?? 0,
    color: colorParts.join(' ') || 'black',
  };
};

function NativeFocusable({
  children,
  onPress,
  style,
  highlightColor,
  hasTVPreferredFocus,
  round,
  light,
  noScale,
  scaleTo,
  lift,
  ring = 'white',
  shadow,
  accessibilityLabel,
  focusOverlay,
  ringWidth,
  ringColor,
  focusDisabled,
  onLongPress,
  edgeLeft,
  holdLeft,
  edgeRight,
  onFocusChange,
  ref,
}: Props) {
  const host = useRef<React.ElementRef<typeof AuroraFocusable> | null>(null);
  // One stable object per instance, so focus.ts's identity checks
  // (`node !== held`) behave as they do with a host instance.
  const facade = useRef<FocusNode | null>(null);
  if (!facade.current) {
    facade.current = {
      requestTVFocus: () => {
        if (host.current) Commands.requestTVFocus(host.current);
      },
    };
  }
  const setRef = useCallback(
    (n: React.ElementRef<typeof AuroraFocusable> | null) => {
      host.current = n;
      const out = n ? (facade.current as unknown as View) : null;
      if (typeof ref === 'function') ref(out);
      else if (ref) (ref as React.MutableRefObject<View | null>).current = out;
    },
    [ref],
  );
  // The unmounting cell may hold focus: say so, as the JS body does.
  useEffect(() => {
    const node = facade.current;
    return () => noteFocusLost(node);
  }, []);

  const flat = StyleSheet.flatten([styles.base, round && {borderRadius: radius.pill}, style]) as ViewStyle;
  const ringRadius = (flat.borderRadius as number) ?? radius.m;
  const sh = parseShadow(shadow ?? TOKEN_SHADOW);

  const handleFocusChange = useCallback(
    (e: {nativeEvent: FocusChangeEvent}) => {
      const {focused, edgeLeft: l, edgeRight: r} = e.nativeEvent;
      if (focused) noteFocus(facade.current, l, r);
      onFocusChange?.(focused);
    },
    [onFocusChange],
  );
  const handlePress = useCallback(() => onPress?.(), [onPress]);
  const handleLongPress = useCallback(() => onLongPress?.(), [onLongPress]);

  return (
    <AuroraFocusable
      ref={setRef}
      style={[styles.base, round && {borderRadius: radius.pill}, style]}
      accessibilityLabel={accessibilityLabel}
      ringKind={ring}
      ringWidth={ringWidth ?? focus.borderWidth}
      ringColor={ringColor ?? RING_COLOR[ring]}
      ringRadius={ringRadius}
      shadowOffsetX={sh.offsetX}
      shadowOffsetY={sh.offsetY}
      shadowBlur={sh.blur}
      shadowSpread={sh.spread}
      shadowColor={sh.color}
      light={!!light}
      lightRingColor={RING_COLOR[ring === 'none' ? 'white' : ring]}
      lightGapColor={colors.bg}
      highlightColor={highlightColor}
      scaleTo={scaleTo ?? focus.scale}
      noScale={!!noScale}
      lift={lift ?? 0}
      edgeLeft={!!edgeLeft}
      edgeRight={!!edgeRight}
      holdLeft={!!holdLeft}
      focusDisabled={!!focusDisabled}
      preferredFocus={!!hasTVPreferredFocus}
      hasPress={!!onPress}
      hasLongPress={!!onLongPress}
      onFocusChange={handleFocusChange}
      onPress={handlePress}
      onLongPress={handleLongPress}>
      {children}
      {focusOverlay ? (
        // The native view finds this child by its nativeID and drives its alpha
        // with the ring value — the JS body's Animated.View, minus the JS.
        <View nativeID="aurora:overlay" pointerEvents="none" style={StyleSheet.absoluteFill}>
          {focusOverlay}
        </View>
      ) : null}
    </AuroraFocusable>
  );
}

// A non-Pressable focus ring container is occasionally handy; export the style.
export const focusRing: ViewStyle = {
  borderWidth: focus.borderWidth,
  borderColor: colors.focusRing,
};

const styles = StyleSheet.create({
  // The transparent border reserves the ring's thickness in layout, so gaining
  // focus never shifts neighbouring elements.
  base: {
    borderWidth: focus.borderWidth,
    borderColor: 'transparent',
    borderRadius: radius.m,
  },
  // Drawn over the reserved (transparent) border area of the element itself.
  //
  // Inset 0, NOT -focus.borderWidth. With negative insets on all four sides this
  // view renders only its horizontal strokes once the element gets wide: a
  // focused source row (~1600dp) drew a violet line above and below itself and
  // nothing down the sides, while every small element (buttons, chips, cards)
  // looked correct — which is why it went unnoticed. At inset 0 the ring sits on
  // the inner edge of the reserved border instead of over it; the difference is
  // 3dp and invisible, and the geometry is no longer a special case.
  ring: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: focus.borderWidth,
    borderColor: colors.focusRing,
    // The second half of --focus-ring, and the part that makes the white outline
    // read as a halo rather than a hairline: `0 10px 24px rgba(0,0,0,.5)`.
    // React Native 0.76+ takes the CSS shorthand directly, so this is the token's
    // own value rather than an elevation approximation of it.
    boxShadow: TOKEN_SHADOW,
  },
  // Light-fill variant: gap first, then the ring outside it. Both are drawn
  // beyond the element's own box; every parent that holds a light button is a
  // plain row View, so there's nothing to clip them.
  // The light variant genuinely needs to draw OUTSIDE the element (that's the
  // whole point of the offset gap), so these keep their negative insets. They are
  // only ever used on the compact primary buttons — Play, Stream, Play next, a
  // chip — where the geometry is well within what renders correctly. Anything
  // wide should use the plain ring.
  lightGap: {
    position: 'absolute',
    top: -LIGHT_GAP,
    left: -LIGHT_GAP,
    right: -LIGHT_GAP,
    bottom: -LIGHT_GAP,
    borderWidth: LIGHT_GAP,
    borderColor: colors.bg,
  },
  lightRing: {
    position: 'absolute',
    top: -(LIGHT_GAP + LIGHT_RING),
    left: -(LIGHT_GAP + LIGHT_RING),
    right: -(LIGHT_GAP + LIGHT_RING),
    bottom: -(LIGHT_GAP + LIGHT_RING),
    borderWidth: LIGHT_RING,
    borderColor: colors.focusRing,
    boxShadow: TOKEN_SHADOW,
  },
  // Centred on the ring and square, so rotating it does not wobble. Size comes
  // from the measured button; `position:absolute` keeps it out of layout so it
  // can be larger than its parent without stretching anything.
  // The box the disc spins inside. Exactly coincident with lightRing's outer
  // edge, so the light reaches the ring band and no further; overflow:'hidden'
  // plus the pill radius is what makes a DISC read as a ring that follows the
  // button's outline, which a pre-baked circular ring could not do on a pill.
  // The middle, removed. Inset by the ring's own thickness so it stops exactly
  // at the inner edge of the band, and filled with the page colour because that
  // is what the site's gap stop is (--focus-ring-light opens `0 0 0 3px
  // var(--bg)`) — so this IS the gap, not merely a cover over it.
});

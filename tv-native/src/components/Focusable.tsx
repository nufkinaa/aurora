// The one focusable primitive every screen uses. On a 10-foot UI the focused
// element MUST be obvious, so focus adds a bright ring + slight scale (matching
// the web app's cue). Wraps Pressable so onPress works from the remote's OK.
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
  Easing,
  Pressable,
  StyleSheet,
  ViewStyle,
  StyleProp,
  View,
} from 'react-native';
import {noteFocus, noteFocusLost} from '../focus';
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
const claimRing = (owner: number) => {
  if (litRing && litRing !== owner) ringRegistry.get(litRing)?.();
  litRing = owner;
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
  // The mirror: rightmost focusable of its band, so RIGHT from it can open a
  // right-hand panel (Browse's filters). Same write-on-focus contract.
  edgeRight?: boolean;
  onFocusChange?: (focused: boolean) => void;
  // Exposed so callers can imperatively move focus here
  // (instance.requestTVFocus() — react-native-tvos attaches it to View refs).
  ref?: React.Ref<View>;
};

export default function Focusable({
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
  const setRef = useCallback(
    (n: never) => {
      node.current = n;
      if (n) lastNode.current = n;
      if (typeof ref === 'function') ref(n);
      else if (ref) (ref as React.MutableRefObject<unknown>).current = n;
    },
    [ref],
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
      hasTVPreferredFocus={wantsFocus}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      onFocus={() => {
        claimRing(idRef.current);
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
    boxShadow: '0 10px 24px rgba(0,0,0,0.5)',
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
    boxShadow: '0 10px 24px rgba(0,0,0,0.5)',
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
